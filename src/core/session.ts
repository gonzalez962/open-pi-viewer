import {
  extractImagesFromMessage,
  extractTextFromContent,
  extractToolOutput,
  parseMessageBlocks,
} from './protocol';
import type { AuthoritativeMessage } from './types/events';
import type { ChatMessage, ToolCallBlock } from './types/messages';
import type { ViewerSessionRecord } from './types/sessions';

/** Key in localStorage for Pi Viewer owned session records */
export const PI_VIEWER_SESSIONS_STORAGE_KEY = 'pi_viewer_sessions';

/**
 * Identify whether a normalized path is a Windows-style path (drive letter or UNC).
 * Windows filesystem paths are case-insensitive, whereas POSIX paths are case-sensitive.
 */
export function isWindowsPath(pathStr: string): boolean {
  if (!pathStr) return false;
  return /^[a-zA-Z]:(\/|$)/.test(pathStr) || /^(\/\/|\\\\)/.test(pathStr);
}

/**
 * Lexical normalization of working directory paths cross-platform:
 * - Trims whitespace
 * - Replaces backslashes with forward slashes
 * - Removes redundant trailing slashes (preserves root like "/" or "C:/")
 * - Normalizes Windows drive letter to uppercase (e.g. c:/ -> C:/)
 *
 * Note: This is client-side lexical normalization. Authoritative canonicalization
 * (symlink resolution, verbatim prefix stripping, actual filesystem casing)
 * is performed on the backend via dunce::canonicalize.
 */
export function normalizeWorkingDirectory(dir: string): string {
  if (!dir) return '';
  let normalized = dir.trim().replace(/\\/g, '/');

  // Strip trailing slashes while preserving root slashes (e.g. "/" or "C:/")
  while (
    normalized.length > 1 &&
    normalized.endsWith('/') &&
    !/^[a-zA-Z]:\/$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }

  // Normalize Windows drive letter casing (e.g. c:/ -> C:/)
  if (/^[a-zA-Z]:(\/|$)/.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }

  return normalized;
}

/**
 * Find matching session record key in storage:
 * - Exact match first (POSIX and Windows)
 * - If not found and the path is a Windows path, performs case-insensitive key lookup
 *   without affecting or lowercasing POSIX paths.
 */
export function findRecordKey(
  records: Record<string, ViewerSessionRecord>,
  normalizedCwd: string
): string | undefined {
  if (normalizedCwd in records) {
    return normalizedCwd;
  }

  if (isWindowsPath(normalizedCwd)) {
    const lower = normalizedCwd.toLowerCase();
    for (const key of Object.keys(records)) {
      if (isWindowsPath(key) && key.toLowerCase() === lower) {
        return key;
      }
    }
  }

  return undefined;
}

/**
 * Validate that an object is a well-formed nonsecret ViewerSessionRecord.
 */
export function isValidSessionRecord(obj: unknown): obj is ViewerSessionRecord {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const r = obj as Record<string, unknown>;
  return (
    typeof r.sessionId === 'string' &&
    r.sessionId.trim().length > 0 &&
    typeof r.sessionFile === 'string' &&
    r.sessionFile.trim().length > 0 &&
    typeof r.cwd === 'string' &&
    r.cwd.trim().length > 0 &&
    typeof r.hasMessages === 'boolean' &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string'
  );
}

/**
 * Result of loading all session records from storage.
 */
export interface SessionStorageLoadResult {
  records: Record<string, ViewerSessionRecord>;
  warning?: string;
}

/**
 * Safe accessor for Web Storage.
 */
function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Load all viewer session records from local storage.
 * Handles storage throws, corrupted JSON, and missing storage honestly without crashing.
 */
export function loadAllSessionRecords(
  storage?: Storage | null
): SessionStorageLoadResult {
  const store = getStorage(storage);
  if (!store) {
    return {
      records: {},
      warning: 'Storage unavailable; session continuity is in-memory only',
    };
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(PI_VIEWER_SESSIONS_STORAGE_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      records: {},
      warning: `Storage access failed (${msg}); session continuity disabled`,
    };
  }

  if (!raw) {
    return { records: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        records: {},
        warning: 'Corrupted session registry in storage; starting with empty registry',
      };
    }

    const records: Record<string, ViewerSessionRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isValidSessionRecord(value)) {
        records[key] = value;
      }
    }
    return { records };
  } catch {
    return {
      records: {},
      warning: 'Failed to parse session registry JSON; starting with empty registry',
    };
  }
}

/**
 * Load the active viewer session record for a specific working directory.
 */
export function loadSessionRecord(
  cwd: string,
  storage?: Storage | null
): { record: ViewerSessionRecord | null; warning?: string } {
  const norm = normalizeWorkingDirectory(cwd);
  if (!norm) {
    return { record: null };
  }

  const { records, warning } = loadAllSessionRecords(storage);
  const matchedKey = findRecordKey(records, norm);
  const found = matchedKey ? records[matchedKey] : null;
  return { record: found ?? null, warning };
}

/**
 * Persist or update a viewer session record for its working directory.
 * Stores only nonsecret metadata.
 */
export function saveSessionRecord(
  record: ViewerSessionRecord,
  storage?: Storage | null
): { success: boolean; error?: string } {
  if (!isValidSessionRecord(record)) {
    return { success: false, error: 'Invalid session record structure' };
  }

  const store = getStorage(storage);
  if (!store) {
    return { success: false, error: 'Storage unavailable' };
  }

  const norm = normalizeWorkingDirectory(record.cwd);
  const { records } = loadAllSessionRecords(storage);

  // If a matching key exists (including case-insensitive Windows match), reuse it
  // to avoid duplicating records for different casing of the same Windows directory.
  const targetKey = findRecordKey(records, norm) ?? norm;

  const cleanRecord: ViewerSessionRecord = {
    sessionId: record.sessionId.trim(),
    sessionFile: record.sessionFile.trim(),
    cwd: targetKey,
    hasMessages: Boolean(record.hasMessages),
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
  };

  records[targetKey] = cleanRecord;

  try {
    store.setItem(PI_VIEWER_SESSIONS_STORAGE_KEY, JSON.stringify(records));
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to persist session record: ${msg}` };
  }
}

/**
 * Update active viewer session record when switching sessions.
 */
export function recordSessionSwitched(
  cwd: string,
  sessionId: string,
  sessionFile: string,
  hasMessages: boolean,
  storage?: Storage | null
): { success: boolean; error?: string } {
  return saveSessionRecord(
    {
      sessionId,
      sessionFile,
      cwd,
      hasMessages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    storage
  );
}

/**
 * Update the hasMessages flag for an existing session record.
 */
export function updateSessionHasMessages(
  cwd: string,
  hasMessages: boolean,
  storage?: Storage | null
): { success: boolean; error?: string } {
  const norm = normalizeWorkingDirectory(cwd);
  const { records } = loadAllSessionRecords(storage);
  const matchedKey = findRecordKey(records, norm);
  const existing = matchedKey ? records[matchedKey] : undefined;
  if (!existing) {
    return { success: false, error: 'No existing session record found to update' };
  }

  existing.hasMessages = hasMessages;
  existing.updatedAt = new Date().toISOString();

  const store = getStorage(storage);
  if (!store) {
    return { success: false, error: 'Storage unavailable' };
  }

  try {
    store.setItem(PI_VIEWER_SESSIONS_STORAGE_KEY, JSON.stringify(records));
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to update session record: ${msg}` };
  }
}

/**
 * Plan describing how to resume or initialize a session for a working directory.
 */
export type SessionResumePlan =
  | { type: 'first_opening' }
  | { type: 'resume_empty'; record: ViewerSessionRecord }
  | { type: 'resume_existing'; record: ViewerSessionRecord };

/**
 * Decide session resumption strategy for a working directory based on recorded identity:
 * 1. No record exists -> 'first_opening' (creates new viewer-owned session, never uses CLI sessions).
 * 2. Record exists with hasMessages = false -> 'resume_empty' (lazy persistence: disk file not expected yet).
 * 3. Record exists with hasMessages = true -> 'resume_existing' (disk file MUST exist on disk).
 */
export function resolveSessionResumePlan(
  cwd: string,
  storage?: Storage | null
): SessionResumePlan {
  const { record } = loadSessionRecord(cwd, storage);
  if (!record) {
    return { type: 'first_opening' };
  }

  if (!record.hasMessages) {
    return { type: 'resume_empty', record };
  }

  return { type: 'resume_existing', record };
}

/**
 * Convert an authoritative Pi RPC message into a ChatMessage representation.
 * Extracts plain text from string or content blocks (filtering out thinking and tool calls for fallback text),
 * and parses structured MessageBlock items for rich assistant activity rendering.
 */
export function convertRpcMessageToChatMessage(
  msg: AuthoritativeMessage | Record<string, unknown>,
  index: number
): ChatMessage | null {
  if (!msg || typeof msg !== 'object') {
    return null;
  }

  const role = msg.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    return null;
  }

  const text = extractTextFromContent(msg.content);
  const timestamp =
    typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toLocaleTimeString()
      : new Date().toLocaleTimeString();

  const id =
    typeof msg.id === 'string' && msg.id.length > 0
      ? msg.id
      : `hydrated-${role}-${index}-${msg.timestamp ?? Date.now()}`;

  const blocks = role === 'assistant' ? parseMessageBlocks(msg.content) : undefined;
  const images = role === 'user' ? extractImagesFromMessage(msg) : undefined;

  return {
    id,
    role,
    content: text,
    timestamp,
    isStreaming: false,
    blocks: blocks && blocks.length > 0 ? blocks : undefined,
    images: images && images.length > 0 ? images : undefined,
  };
}

/**
 * Hydrate an array of raw RPC messages into user-visible ChatMessage items.
 * Matches historical toolResult messages to preceding assistant toolCall blocks.
 */
export function hydrateChatMessages(rawMessages: unknown[]): ChatMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const hydrated: ChatMessage[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw && typeof raw === 'object') {
      const rawObj = raw as Record<string, unknown>;

      // Match historical toolResult to preceding assistant toolCall block
      if (rawObj.role === 'toolResult') {
        const toolCallId =
          typeof rawObj.toolCallId === 'string' ? rawObj.toolCallId : undefined;
        if (toolCallId) {
          for (let j = hydrated.length - 1; j >= 0; j--) {
            const prevMsg = hydrated[j];
            if (prevMsg.blocks) {
              const toolBlock = prevMsg.blocks.find(
                (b): b is ToolCallBlock => b.type === 'tool_call' && b.id === toolCallId
              );
              if (toolBlock) {
                toolBlock.status = rawObj.isError ? 'error' : 'completed';
                toolBlock.isError = Boolean(rawObj.isError);
                toolBlock.output = extractToolOutput(rawObj.content ?? rawObj.result);
                break;
              }
            }
          }
        }
        continue;
      }

      const converted = convertRpcMessageToChatMessage(rawObj, i);
      if (
        converted &&
        (converted.content.length > 0 ||
          (converted.blocks && converted.blocks.length > 0) ||
          (converted.images && converted.images.length > 0) ||
          converted.role === 'assistant')
      ) {
        hydrated.push(converted);
      }
    }
  }

  return hydrated;
}
