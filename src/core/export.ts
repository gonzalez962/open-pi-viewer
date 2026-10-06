import type { ChatMessage, MessageBlock, TextBlock, ToolCallBlock } from './types/messages';
import type {
  ConversationJsonExport,
  ExportDisclosures,
  ExportFormat,
  ExportOptions,
  ExportedImagesMetadata,
  ExportedMessage,
  ExportedToolCall,
  GenerateFilenameOptions,
} from './types/export';

export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Authoritative disclosures for exported transcripts under the conversation_summary policy.
 */
export const EXPORT_DISCLOSURES: Readonly<ExportDisclosures> = Object.freeze({
  scope:
    'Export reflects the currently loaded transcript in the viewer only, not persistent session history or backend storage.',
  contentPolicy:
    'conversation_summary: message text, roles, timestamps, tool names and status, and image metadata (counts/MIMEs). Omitted: thinking blocks, tool arguments, tool outputs/paths, and binary/base64 image data.',
  secretRedactionNotice:
    'No automatic text secret or credential redaction is performed. Please review before sharing.',
});

/**
 * Windows reserved device names (cannot be used as filenames or base stems).
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const DETERMINISTIC_EPOCH_ISO = '1970-01-01T00:00:00.000Z';
const DETERMINISTIC_EPOCH_YMD = '1970-01-01';

/**
 * Sanitizes a single slug string adhering to character restrictions, Windows reserved device
 * name guards, length bounding (max 50 chars), and surrogate pair protection.
 * Returns empty string if the input produces no valid slug characters.
 */
function cleanSlug(raw?: string): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  let slug = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.+/g, '-')
    .replace(/[/\\?%*:|"<>`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_\s]+|[-_\s]+$/g, '')
    .toLowerCase();

  if (!slug) {
    return '';
  }

  // Guard against Windows reserved device names before length bounding to guarantee max 50
  const baseStem = slug.split('-')[0] ?? slug;
  if (WINDOWS_RESERVED_NAMES.test(slug) || WINDOWS_RESERVED_NAMES.test(baseStem)) {
    slug = `session-${slug}`;
  }

  // Bound length to 50 characters while avoiding clipping Unicode surrogate pairs
  if (slug.length > 50) {
    let truncated = slug.slice(0, 50);
    const lastCharCode = truncated.charCodeAt(truncated.length - 1);
    if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
      truncated = truncated.slice(0, -1);
    }
    slug = truncated.replace(/[-_]+$/, '');
  }

  return slug;
}

/**
 * Sanitizes a title string into a safe, portable filename slug.
 *
 * Rules:
 * - Strips control characters (U+0000 to U+001F, U+007F).
 * - Replaces directory separators (/ and \) and invalid chars (? % * : | " < >) with dashes.
 * - Removes path traversal sequences (..).
 * - Normalizes whitespace and consecutive dashes.
 * - Strips leading/trailing dots, spaces, and dashes (preventing Windows file creation issues).
 * - Prefixes Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 * - Bounding length to 50 characters is applied AFTER reserved device prefix to guarantee max 50.
 * - Avoids clipping Unicode surrogate pairs at the 50-character boundary.
 * - Sanitizes fallback itself if title is missing or stripped; falls back to 'pi-conversation'
 *   if fallback is empty, traversal-like, or invalid.
 */
export function sanitizeExportFilename(title?: string, fallback = 'pi-conversation'): string {
  const candidate = cleanSlug(title);
  if (candidate.length > 0) {
    return candidate;
  }

  const fallbackCandidate = cleanSlug(fallback);
  if (fallbackCandidate.length > 0) {
    return fallbackCandidate;
  }

  return 'pi-conversation';
}

/**
 * Parses and validates a Date object or ISO 8601 date string into a deterministic UTC Date.
 * Validates calendar components to reject impossible dates (e.g. 2026-02-31, 9999-99-99)
 * and properly evaluates timezone offsets to UTC (e.g. 2026-01-01T01:00:00+05:00 -> 2025-12-31).
 * Returns null if the input is absent, malformed, or an Invalid Date object.
 */
function parseDeterministicDate(dateInput?: Date | string | null): Date | null {
  if (!dateInput) {
    return null;
  }

  if (dateInput instanceof Date) {
    return isNaN(dateInput.getTime()) ? null : dateInput;
  }

  if (typeof dateInput !== 'string') {
    return null;
  }

  const trimmed = dateInput.trim();
  if (!trimmed) {
    return null;
  }

  // Parse ISO date and optional time/offset
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-]\d{2}(?::?\d{2})?))?)?$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // Validate calendar date components (reject impossible dates like Feb 31, leap years, etc.)
  const calCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calCheck.getUTCFullYear() !== year ||
    calCheck.getUTCMonth() !== month - 1 ||
    calCheck.getUTCDate() !== day
  ) {
    return null;
  }

  // Validate time components if present
  if (match[4] !== undefined) {
    const hour = parseInt(match[4], 10);
    const min = parseInt(match[5], 10);
    const sec = match[6] !== undefined ? parseInt(match[6], 10) : 0;
    if (hour > 23 || min > 59 || sec > 59) {
      return null;
    }
  }

  // If time is provided without timezone offset, treat as UTC for consistency
  let isoStr = trimmed;
  if (match[4] !== undefined && !match[8] && !/[zZ]$/.test(trimmed)) {
    isoStr = `${trimmed}Z`;
  }

  const parsed = new Date(isoStr);
  if (isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

/**
 * Formats a Date or date string into a deterministic YYYY-MM-DD string in UTC.
 * Uses deterministic epoch fallback ('1970-01-01') when input is absent or invalid,
 * never accessing the ambient system clock.
 */
function formatDateToUtcYmd(dateInput?: Date | string | null): string {
  const d = parseDeterministicDate(dateInput);
  if (!d) {
    return DETERMINISTIC_EPOCH_YMD;
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolves an exportedAt option into a deterministic ISO 8601 string.
 * Uses deterministic epoch fallback ('1970-01-01T00:00:00.000Z') when input is absent
 * or invalid, never accessing the ambient system clock.
 */
function resolveIsoTimestamp(exportedAt?: Date | string | null): string {
  const d = parseDeterministicDate(exportedAt);
  if (!d) {
    return DETERMINISTIC_EPOCH_ISO;
  }
  return d.toISOString();
}

/**
 * Generates an export filename based on the title, format, and deterministic date.
 */
export function generateExportFilename(options?: GenerateFilenameOptions): string {
  const title = options?.title;
  const format: ExportFormat = options?.format || 'markdown';
  const fallback = options?.fallbackTitle || 'pi-conversation';
  const slug = sanitizeExportFilename(title, fallback);

  const dateStr = formatDateToUtcYmd(options?.exportedAt);
  const ext = format === 'json' ? 'json' : 'md';

  return `${slug}-${dateStr}.${ext}`;
}

/**
 * Checks whether a transcript contains exportable messages.
 */
export function isExportableTranscript(messages?: readonly ChatMessage[] | null): boolean {
  return Array.isArray(messages) && messages.length > 0;
}

/**
 * Strips executable HTML characters and backticks from tool names to prevent formatting injection.
 */
function sanitizeToolName(name: unknown): string {
  if (typeof name !== 'string') return 'unknown';
  // eslint-disable-next-line no-control-regex
  return name.replace(/[`<>\u0000-\u001f\u007f]/g, '').trim() || 'unknown';
}

/**
 * Extracts canonical text from a message adhering to reducer precedence:
 * - If `blocks` contains text blocks, they represent decomposed authoritative segments.
 *   `content` is not duplicated.
 * - Otherwise, falls back to `content`.
 */
function extractCanonicalText(msg: ChatMessage): string {
  if (msg.blocks && msg.blocks.length > 0) {
    const textBlocks = msg.blocks.filter(
      (b): b is TextBlock => b.type === 'text' && typeof b.text === 'string'
    );
    if (textBlocks.length > 0) {
      return textBlocks.map((b) => b.text).join('');
    }
  }
  return typeof msg.content === 'string' ? msg.content : '';
}

/**
 * Extracts tool executions adhering to policy: tool name and status only.
 * Tool args and outputs are strictly omitted.
 */
function extractToolCalls(blocks?: MessageBlock[]): ExportedToolCall[] | undefined {
  if (!blocks || blocks.length === 0) return undefined;

  const toolCalls = blocks
    .filter((b): b is ToolCallBlock => b.type === 'tool_call')
    .map((tc) => ({
      name: sanitizeToolName(tc.name),
      status: tc.status === 'error' || tc.isError ? ('error' as const) : tc.status || 'completed',
    }));

  return toolCalls.length > 0 ? toolCalls : undefined;
}

/**
 * Extracts image metadata adhering to policy: count and MIME types only.
 * Binary/base64 data payloads are strictly omitted.
 */
function extractImageMetadata(msg: ChatMessage): ExportedImagesMetadata | undefined {
  if (!msg.images || msg.images.length === 0) return undefined;

  const mimeTypes = msg.images
    .map((img) => (typeof img.mimeType === 'string' ? img.mimeType.trim().toLowerCase() : ''))
    .filter(Boolean);

  return {
    count: msg.images.length,
    mimeTypes: Array.from(new Set(mimeTypes)),
  };
}

/**
 * Capitalizes a role name for human-readable headers.
 */
function formatRoleName(role: string): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Exports conversation history into clean, structured, policy-compliant Markdown.
 *
 * Implements conversation_summary policy:
 * - Includes message text, roles, timestamps, tool name and status.
 * - Includes image counts and MIME metadata.
 * - Omits thinking blocks, tool args, tool outputs, and binary image data.
 * - Discloses scope, omissions, and secret policy in the header.
 */
export function exportToMarkdown(
  messages: readonly ChatMessage[] = [],
  options?: ExportOptions
): string {
  const title = options?.title ? options.title.trim() : 'Conversation Export';
  const exportedAtIso = resolveIsoTimestamp(options?.exportedAt);
  const messageList = Array.isArray(messages) ? messages : [];

  const lines: string[] = [];

  // Document header and policy disclosures
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> **Scope**: ${EXPORT_DISCLOSURES.scope}`);
  lines.push(`> **Content Policy**: ${EXPORT_DISCLOSURES.contentPolicy}`);
  lines.push(`> **Notice**: ${EXPORT_DISCLOSURES.secretRedactionNotice}`);
  lines.push('');
  lines.push(`- **Exported**: ${exportedAtIso}`);
  lines.push(`- **Messages**: ${messageList.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (messageList.length === 0) {
    lines.push('_No messages in loaded transcript._');
    lines.push('');
    return lines.join('\n');
  }

  for (let i = 0; i < messageList.length; i++) {
    const msg = messageList[i];
    const roleLabel = formatRoleName(msg.role);
    const timeLabel = msg.timestamp ? ` (${msg.timestamp})` : '';

    lines.push(`## ${roleLabel}${timeLabel}`);
    lines.push('');

    // Image metadata disclosure (count and MIMEs only)
    const imgMeta = extractImageMetadata(msg);
    if (imgMeta) {
      lines.push(`*[Images: ${imgMeta.count} (${imgMeta.mimeTypes.join(', ')})]*`);
      lines.push('');
    }

    // Message body rendering with canonical text precedence
    const hasTextBlocks = Boolean(
      msg.blocks && msg.blocks.some((b: MessageBlock) => b.type === 'text')
    );

    if (msg.blocks && msg.blocks.length > 0 && hasTextBlocks) {
      // Preserve interleaved sequence of text blocks and tool calls
      for (const block of msg.blocks) {
        if (block.type === 'text') {
          if (block.text) {
            lines.push(block.text);
            lines.push('');
          }
        } else if (block.type === 'tool_call') {
          const safeName = sanitizeToolName(block.name);
          const status = block.status === 'error' || block.isError ? 'error' : block.status || 'completed';
          lines.push(`_Tool:_ \`${safeName}\` (status: ${status})`);
          lines.push('');
        }
        // Thinking blocks are strictly omitted
      }
    } else {
      // No decomposed text blocks; use content as canonical text
      if (msg.content) {
        lines.push(msg.content);
        lines.push('');
      }

      // If blocks contains tool calls alongside bare content
      if (msg.blocks && msg.blocks.length > 0) {
        for (const block of msg.blocks) {
          if (block.type === 'tool_call') {
            const safeName = sanitizeToolName(block.name);
            const status = block.status === 'error' || block.isError ? 'error' : block.status || 'completed';
            lines.push(`_Tool:_ \`${safeName}\` (status: ${status})`);
            lines.push('');
          }
        }
      }
    }

    if (i < messageList.length - 1) {
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Exports conversation history into structured, versioned, policy-compliant JSON.
 *
 * Implements conversation_summary policy:
 * - Includes message text, roles, timestamps, tool name and status.
 * - Includes image counts and MIME metadata.
 * - Omits thinking blocks, tool args, tool outputs, and binary image data.
 * - Discloses scope, omissions, and secret policy in metadata.
 */
export function exportToJson(
  messages: readonly ChatMessage[] = [],
  options?: ExportOptions
): string {
  const title = options?.title ? options.title.trim() : 'Conversation Export';
  const exportedAtIso = resolveIsoTimestamp(options?.exportedAt);
  const messageList = Array.isArray(messages) ? messages : [];

  const exportedMessages: ExportedMessage[] = messageList.map((msg) => {
    const exported: ExportedMessage = {
      role: msg.role,
      text: extractCanonicalText(msg),
    };

    if (msg.timestamp) {
      exported.timestamp = msg.timestamp;
    }

    const tools = extractToolCalls(msg.blocks);
    if (tools && tools.length > 0) {
      exported.tools = tools;
    }

    const images = extractImageMetadata(msg);
    if (images) {
      exported.images = images;
    }

    return exported;
  });

  const payload: ConversationJsonExport = {
    schemaVersion: 1,
    metadata: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      title,
      exportedAt: exportedAtIso,
      messageCount: exportedMessages.length,
      disclosures: {
        scope: EXPORT_DISCLOSURES.scope,
        contentPolicy: EXPORT_DISCLOSURES.contentPolicy,
        secretRedactionNotice: EXPORT_DISCLOSURES.secretRedactionNotice,
      },
    },
    messages: exportedMessages,
  };

  return JSON.stringify(payload, null, 2);
}
