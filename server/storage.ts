import fs from 'node:fs';
import path from 'node:path';
import { broadcastSse } from './bridge/sse';

export interface OpenPiViewerStorageData {
  version: number;
  connectConfig?: Record<string, unknown> | null;
  uiPreferences?: Record<string, unknown> | null;
  projects?: Record<string, unknown> | null;
  sessions?: Record<string, unknown> | null;
  profileSnapshots?: Record<string, unknown> | null;
  githubPat?: string | null;
  voiceCredentials?: Array<{ provider: string; endpoint: string; apiKey: string }> | null;
  [key: string]: unknown;
}

const DEFAULT_STORAGE_DATA: OpenPiViewerStorageData = {
  version: 1,
  connectConfig: null,
  uiPreferences: null,
  projects: null,
  sessions: null,
  profileSnapshots: null,
  githubPat: null,
};

let customStorageFilePath: string | null = null;

export function setStorageFilePathForTest(filePath: string | null): void {
  customStorageFilePath = filePath;
}

export function resolveStorageFilePath(): string {
  if (customStorageFilePath) {
    return customStorageFilePath;
  }
  if (process.env.PI_VIEWER_CONFIG_PATH && process.env.PI_VIEWER_CONFIG_PATH.trim()) {
    return path.resolve(process.env.PI_VIEWER_CONFIG_PATH.trim());
  }
  return path.resolve(process.cwd(), 'open-pi-viewer.json');
}

function sanitizeVoiceKeys(data: OpenPiViewerStorageData): OpenPiViewerStorageData {
  const prefs = data.uiPreferences;
  if (!prefs || typeof prefs !== 'object' || !prefs.speech || typeof prefs.speech !== 'object' || Array.isArray(prefs.speech)) return data;
  const { openAiApiKey, compatibleSttApiKey, ...speech } = prefs.speech as Record<string, unknown>;
  if (openAiApiKey === undefined && compatibleSttApiKey === undefined) return data;
  return { ...data, uiPreferences: { ...prefs, speech } };
}

export function sanitizeStorageForClient(data: OpenPiViewerStorageData): OpenPiViewerStorageData {
  const sanitized = sanitizeVoiceKeys(data);
  const { voiceCredentials, ...clientData } = sanitized;
  return clientData as OpenPiViewerStorageData;
}

/**
 * Loads the storage data from open-pi-viewer.json.
 * If file does not exist, returns safe defaults.
 */
export function loadViewerStorage(): OpenPiViewerStorageData {
  const filePath = resolveStorageFilePath();
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_STORAGE_DATA };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_STORAGE_DATA };
    }
    const original = { ...DEFAULT_STORAGE_DATA, ...parsed, version: typeof parsed.version === 'number' ? parsed.version : 1 };
    const cleaned = sanitizeVoiceKeys(original);
    if (cleaned !== original) fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2), 'utf8');
    return cleaned;
  } catch (error) {
    throw new Error('Unable to load or clean viewer storage');
  }
}

/**
 * Saves viewer storage data atomically using a temporary file and rename.
 */
export function saveViewerStorage(data: Partial<OpenPiViewerStorageData>): OpenPiViewerStorageData {
  const current = loadViewerStorage();
  const updated: OpenPiViewerStorageData = sanitizeVoiceKeys({
    ...current,
    ...data,
    // Preserve existing voiceCredentials unless explicitly overridden by internal storage calls
    voiceCredentials: data.voiceCredentials !== undefined ? data.voiceCredentials : current.voiceCredentials,
    version: 1,
  });

  const filePath = resolveStorageFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);

  // Broadcast sanitized update via SSE so open clients can stay synchronized without seeing credentials
  try {
    broadcastSse('viewer://storage_updated', sanitizeStorageForClient(updated));
  } catch {
    // SSE broadcast is best-effort
  }

  return updated;
}

export function patchSpeechPreferences(patch: unknown): OpenPiViewerStorageData {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid speech preferences patch');
  const { openAiApiKey, compatibleSttApiKey, ...safePatch } = patch as Record<string, unknown>;
  const current = loadViewerStorage();
  const prefs = current.uiPreferences && typeof current.uiPreferences === 'object' ? current.uiPreferences : {};
  const speech = prefs.speech && typeof prefs.speech === 'object' && !Array.isArray(prefs.speech) ? prefs.speech : {};
  return saveViewerStorage({ uiPreferences: { ...prefs, speech: { ...speech, ...safePatch } } });
}

/**
 * Updates a specific key in the viewer storage (e.g. 'uiPreferences', 'projects').
 */
export function updateViewerStorageKey(
  key: keyof OpenPiViewerStorageData,
  value: unknown
): OpenPiViewerStorageData {
  const current = loadViewerStorage();
  return saveViewerStorage({
    ...current,
    [key]: value,
  });
}
