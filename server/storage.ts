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
    return {
      ...DEFAULT_STORAGE_DATA,
      ...parsed,
      version: typeof parsed.version === 'number' ? parsed.version : 1,
    };
  } catch (error) {
    console.warn(`[ViewerStorage] Error reading ${filePath}:`, error);
    return { ...DEFAULT_STORAGE_DATA };
  }
}

/**
 * Saves viewer storage data atomically using a temporary file and rename.
 */
export function saveViewerStorage(data: Partial<OpenPiViewerStorageData>): OpenPiViewerStorageData {
  const current = loadViewerStorage();
  const updated: OpenPiViewerStorageData = {
    ...current,
    ...data,
    version: 1,
  };

  const filePath = resolveStorageFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);

  // Broadcast update via SSE so open clients can stay synchronized
  try {
    broadcastSse('viewer://storage_updated', updated);
  } catch {
    // SSE broadcast is best-effort
  }

  return updated;
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
