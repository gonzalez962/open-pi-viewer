import { normalizeWorkingDirectory, isWindowsPath } from '@core/session';
import type { ProfileScope, ReasoningEffort } from '@core/types/profiles';

/** Key in localStorage for Pi Viewer session profile snapshots */
export const PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY = 'pi_viewer_session_profile_snapshots';

export type SnapshotSource = 'profile_default' | 'manual_override';

export interface SessionProfileSnapshot {
  cwd: string;
  sessionId: string;
  profileName: string | null;
  profileScope?: ProfileScope | null;
  modelId: string | null;
  provider: string | null;
  reasoningEffort?: ReasoningEffort | null;
  source: SnapshotSource;
  updatedAt: string;
}

/**
 * Creates a normalized unique context key for session profile snapshots.
 */
export function createSessionProfileSnapshotKey(cwd: string, sessionId: string): string {
  const normCwd = normalizeWorkingDirectory(cwd);
  return `${normCwd}::${sessionId.trim()}`;
}

export function isValidSessionProfileSnapshot(obj: unknown): obj is SessionProfileSnapshot {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const r = obj as Record<string, unknown>;
  return (
    typeof r.cwd === 'string' &&
    r.cwd.trim().length > 0 &&
    typeof r.sessionId === 'string' &&
    r.sessionId.trim().length > 0 &&
    (r.profileName === null || typeof r.profileName === 'string') &&
    (r.modelId === null || typeof r.modelId === 'string') &&
    (r.provider === null || typeof r.provider === 'string') &&
    (r.source === 'profile_default' || r.source === 'manual_override') &&
    typeof r.updatedAt === 'string'
  );
}

let memoryFallbackStorage: Storage | null = null;

export function clearMemoryFallbackStorage(): void {
  if (memoryFallbackStorage) {
    memoryFallbackStorage.clear();
  }
}

function getMemoryFallbackStorage(): Storage {
  if (!memoryFallbackStorage) {
    const map = new Map<string, string>();
    memoryFallbackStorage = {
      get length() {
        return map.size;
      },
      clear() {
        map.clear();
      },
      getItem(key: string) {
        return map.get(key) ?? null;
      },
      key(index: number) {
        return Array.from(map.keys())[index] ?? null;
      },
      removeItem(key: string) {
        map.delete(key);
      },
      setItem(key: string, value: string) {
        map.set(key, value);
      },
    };
  }
  return memoryFallbackStorage;
}

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined && storage !== null) {
    return storage;
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage;
    }
  } catch {
    // Web storage throws when blocked or unavailable
  }
  return getMemoryFallbackStorage();
}

export interface SessionProfileSnapshotLoadResult {
  snapshots: Record<string, SessionProfileSnapshot>;
  warning?: string;
}

export function loadAllSessionProfileSnapshots(
  storage?: Storage | null
): SessionProfileSnapshotLoadResult {
  const store = getStorage(storage);
  if (!store) {
    return {
      snapshots: {},
      warning: 'Storage unavailable; session profile snapshots are in-memory only',
    };
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      snapshots: {},
      warning: `Storage access failed (${msg}); session profile snapshots disabled`,
    };
  }

  if (!raw) {
    return { snapshots: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        snapshots: {},
        warning: 'Corrupted session profile snapshot registry in storage',
      };
    }

    const snapshots: Record<string, SessionProfileSnapshot> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isValidSessionProfileSnapshot(value)) {
        snapshots[key] = value;
      }
    }
    return { snapshots };
  } catch {
    return {
      snapshots: {},
      warning: 'Failed to parse session profile snapshot registry JSON',
    };
  }
}

export function findSnapshotKey(
  snapshots: Record<string, SessionProfileSnapshot>,
  normalizedCwd: string,
  sessionId: string
): string | undefined {
  const exactKey = `${normalizedCwd}::${sessionId.trim()}`;
  if (exactKey in snapshots) {
    return exactKey;
  }

  if (isWindowsPath(normalizedCwd)) {
    const lower = exactKey.toLowerCase();
    for (const key of Object.keys(snapshots)) {
      if (key.toLowerCase() === lower) {
        return key;
      }
    }
  }

  return undefined;
}

export function loadSessionProfileSnapshot(
  cwd: string,
  sessionId: string,
  storage?: Storage | null
): { snapshot: SessionProfileSnapshot | null; warning?: string } {
  if (!cwd || !sessionId) {
    return { snapshot: null };
  }
  const normCwd = normalizeWorkingDirectory(cwd);
  const { snapshots, warning } = loadAllSessionProfileSnapshots(storage);
  const key = findSnapshotKey(snapshots, normCwd, sessionId);
  const found = key ? snapshots[key] : null;
  return { snapshot: found ?? null, warning };
}

export function saveSessionProfileSnapshot(
  snapshot: SessionProfileSnapshot,
  storage?: Storage | null
): { success: boolean; error?: string } {
  if (!isValidSessionProfileSnapshot(snapshot)) {
    return { success: false, error: 'Invalid session profile snapshot structure' };
  }

  const store = getStorage(storage);
  if (!store) {
    return { success: false, error: 'Storage unavailable' };
  }

  const normCwd = normalizeWorkingDirectory(snapshot.cwd);
  const { snapshots } = loadAllSessionProfileSnapshots(storage);

  const matchedKey = findSnapshotKey(snapshots, normCwd, snapshot.sessionId);
  const targetKey = matchedKey ?? createSessionProfileSnapshotKey(normCwd, snapshot.sessionId);

  const cleanSnapshot: SessionProfileSnapshot = {
    cwd: normCwd,
    sessionId: snapshot.sessionId.trim(),
    profileName: snapshot.profileName ? snapshot.profileName.trim() : null,
    profileScope: snapshot.profileScope ?? null,
    modelId: snapshot.modelId ? snapshot.modelId.trim() : null,
    provider: snapshot.provider ? snapshot.provider.trim() : null,
    reasoningEffort: snapshot.reasoningEffort ?? null,
    source: snapshot.source,
    updatedAt: new Date().toISOString(),
  };

  snapshots[targetKey] = cleanSnapshot;

  try {
    store.setItem(
      PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY,
      JSON.stringify(snapshots)
    );
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to persist session profile snapshot: ${msg}` };
  }
}

export function updateSessionProfileSnapshotExplicitProfile(
  cwd: string,
  sessionId: string,
  update: {
    profileName: string | null;
    profileScope?: ProfileScope | null;
    modelId: string | null;
    provider: string | null;
    reasoningEffort?: ReasoningEffort | null;
  },
  storage?: Storage | null
): { success: boolean; error?: string } {
  const normCwd = normalizeWorkingDirectory(cwd);
  let provider = update.provider;
  let modelId = update.modelId;
  if (!provider && modelId && modelId.includes('/')) {
    const slashIdx = modelId.indexOf('/');
    provider = modelId.slice(0, slashIdx);
    modelId = modelId.slice(slashIdx + 1);
  }
  const snapshot: SessionProfileSnapshot = {
    cwd: normCwd,
    sessionId: sessionId.trim(),
    profileName: update.profileName,
    profileScope: update.profileScope ?? null,
    modelId,
    provider,
    reasoningEffort: update.reasoningEffort ?? null,
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  };

  return saveSessionProfileSnapshot(snapshot, storage);
}

export function updateSessionProfileSnapshotManualSelection(
  cwd: string,
  sessionId: string,
  update: {
    modelId?: string;
    provider?: string;
    reasoningEffort?: ReasoningEffort | null;
  },
  storage?: Storage | null
): { success: boolean; error?: string } {
  const existing = loadSessionProfileSnapshot(cwd, sessionId, storage).snapshot;
  const normCwd = normalizeWorkingDirectory(cwd);
  let provider = update.provider !== undefined ? update.provider : (existing?.provider ?? null);
  let modelId = update.modelId !== undefined ? update.modelId : (existing?.modelId ?? null);
  if (!provider && modelId && modelId.includes('/')) {
    const slashIdx = modelId.indexOf('/');
    provider = modelId.slice(0, slashIdx);
    modelId = modelId.slice(slashIdx + 1);
  }

  const snapshot: SessionProfileSnapshot = {
    cwd: normCwd,
    sessionId: sessionId.trim(),
    profileName: existing?.profileName ?? null,
    profileScope: existing?.profileScope ?? null,
    modelId,
    provider,
    reasoningEffort:
      update.reasoningEffort !== undefined
        ? update.reasoningEffort
        : (existing?.reasoningEffort ?? null),
    source: 'manual_override',
    updatedAt: new Date().toISOString(),
  };

  return saveSessionProfileSnapshot(snapshot, storage);
}
