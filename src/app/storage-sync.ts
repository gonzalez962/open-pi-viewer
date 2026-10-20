import {
  getViewerStoragePi,
  saveViewerStoragePi,
  updateViewerStorageKeyPi,
  listenViewerStorageUpdatesPi,
  type ViewerStoragePayload,
} from '@infra/viewer-storage';
import { UI_PREFERENCES_STORAGE_KEY, loadUiPreferences } from '@infra/preferences';
import { CONFIG_STORAGE_KEY, loadConnectConfig } from '@features/settings/config';
import {
  PROJECTS_STORAGE_KEY,
  loadProjectsRegistry,
  validateProjectsRegistry,
  type ProjectsRegistry,
} from '@features/projects/projects';
import { PI_VIEWER_SESSIONS_STORAGE_KEY, loadAllSessionRecords } from '@core/session';
import {
  PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY,
  loadAllSessionProfileSnapshots,
} from '@features/profiles/lib/sessionProfileSnapshot';
import { GITHUB_PAT_STORAGE_KEY, getSavedGitHubPat } from '@features/projects/github-clone';
import type { ConnectConfig } from '@core/types/connection';

export interface StorageSyncCallbacks {
  onUiPreferencesUpdated?: (prefs: Record<string, unknown>) => void;
  onConnectConfigUpdated?: (config: Record<string, unknown>) => void;
  onProjectsUpdated?: (projects: Record<string, unknown>) => void;
}

/**
 * Initializes bidirectional synchronization between browser localStorage and the server's open-pi-viewer.json.
 * 1. Reads current storage from server.
 * 2. If server has missing sections but client has localStorage data, migrates client data to server.
 * 3. If server has data, updates local storage so existing sync readers remain up-to-date.
 */
export async function initStorageSynchronization(callbacks: StorageSyncCallbacks = {}): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    const serverStorage = await getViewerStoragePi();
    if (!serverStorage) return;

    const migrationPatch: Partial<ViewerStoragePayload> = {};

    // 1. UI Preferences
    if (serverStorage.uiPreferences) {
      window.localStorage.setItem(
        UI_PREFERENCES_STORAGE_KEY,
        JSON.stringify(serverStorage.uiPreferences)
      );
      callbacks.onUiPreferencesUpdated?.(serverStorage.uiPreferences);
    } else {
      const localPrefs = loadUiPreferences(window.localStorage).preferences;
      if (localPrefs) {
        migrationPatch.uiPreferences = localPrefs as unknown as Record<string, unknown>;
      }
    }

    // 2. Connect Config
    if (serverStorage.connectConfig) {
      window.localStorage.setItem(
        CONFIG_STORAGE_KEY,
        JSON.stringify(serverStorage.connectConfig)
      );
      callbacks.onConnectConfigUpdated?.(serverStorage.connectConfig);
    } else {
      const localConfig = loadConnectConfig(window.localStorage).config;
      if (localConfig) {
        migrationPatch.connectConfig = localConfig as unknown as Record<string, unknown>;
      }
    }

    // 3. Projects: Server is authoritative when it has an existing registry
    if (serverStorage.projects) {
      const serverValidation = validateProjectsRegistry(serverStorage.projects);
      if (serverValidation.registry.projects.length > 0) {
        const localActive = loadProjectsRegistry(window.localStorage).registry.activeProjectId;
        const effectiveActive =
          localActive && serverValidation.registry.projects.some((p) => p.id === localActive)
            ? localActive
            : serverValidation.registry.activeProjectId;

        const syncedRegistry: ProjectsRegistry = {
          ...serverValidation.registry,
          activeProjectId: effectiveActive,
        };

        window.localStorage.setItem(
          PROJECTS_STORAGE_KEY,
          JSON.stringify(syncedRegistry)
        );
        serverStorage.projects = syncedRegistry as unknown as Record<string, unknown>;
        callbacks.onProjectsUpdated?.(syncedRegistry as unknown as Record<string, unknown>);
      } else {
        const localProjects = loadProjectsRegistry(window.localStorage).registry;
        if (localProjects && localProjects.projects.length > 0) {
          migrationPatch.projects = localProjects as unknown as Record<string, unknown>;
          serverStorage.projects = localProjects as unknown as Record<string, unknown>;
        }
      }
    } else {
      const localProjects = loadProjectsRegistry(window.localStorage).registry;
      if (localProjects && localProjects.projects.length > 0) {
        migrationPatch.projects = localProjects as unknown as Record<string, unknown>;
        serverStorage.projects = localProjects as unknown as Record<string, unknown>;
      }
    }

    // 4. Sessions
    if (serverStorage.sessions) {
      window.localStorage.setItem(
        PI_VIEWER_SESSIONS_STORAGE_KEY,
        JSON.stringify(serverStorage.sessions)
      );
    } else {
      const localSessions = loadAllSessionRecords(window.localStorage).records;
      if (localSessions && Object.keys(localSessions).length > 0) {
        migrationPatch.sessions = localSessions as unknown as Record<string, unknown>;
      }
    }

    // 5. Profile Snapshots
    if (serverStorage.profileSnapshots) {
      window.localStorage.setItem(
        PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY,
        JSON.stringify(serverStorage.profileSnapshots)
      );
    } else {
      const localSnapshots = loadAllSessionProfileSnapshots(window.localStorage).snapshots;
      if (localSnapshots && Object.keys(localSnapshots).length > 0) {
        migrationPatch.profileSnapshots = localSnapshots as unknown as Record<string, unknown>;
      }
    }

    // 6. GitHub PAT
    if (serverStorage.githubPat !== undefined && serverStorage.githubPat !== null) {
      if (serverStorage.githubPat) {
        window.localStorage.setItem(GITHUB_PAT_STORAGE_KEY, serverStorage.githubPat);
      } else {
        window.localStorage.removeItem(GITHUB_PAT_STORAGE_KEY);
      }
    } else {
      const localPat = getSavedGitHubPat(window.localStorage);
      if (localPat) {
        migrationPatch.githubPat = localPat;
      }
    }

    // If client had local data to migrate to server, upload it atomically
    if (Object.keys(migrationPatch).length > 0) {
      const saved = await saveViewerStoragePi(migrationPatch);
      if (saved) {
        Object.assign(serverStorage, saved);
      }
    }

    // Broadcast synchronization completion to in-memory state hooks
    window.dispatchEvent(
      new CustomEvent('viewer:storage_synced', { detail: serverStorage })
    );

    // Listen for custom session record save events from core/session
    window.addEventListener('viewer:session_record_saved', (event) => {
      const records = (event as CustomEvent).detail;
      if (records) {
        void updateViewerStorageKeyPi('sessions', records);
      }
    });

    // In Tauri desktop, subscribe to native storage update events emitted by Rust
    void listenViewerStorageUpdatesPi((updated) => {
      handleRemoteStorageUpdate(updated, callbacks);
    });

    // In Web browser, subscribe to SSE forwarded events
    window.addEventListener('viewer://storage_updated', (event) => {
      const detail = (event as CustomEvent)?.detail;
      if (detail) {
        handleRemoteStorageUpdate(detail, callbacks);
      }
    });
  } catch (error) {
    console.warn('[StorageSync] Initialization error:', error);
  }
}

/**
 * Handle incoming real-time viewer storage updates received via SSE or broadcast.
 */
export function handleRemoteStorageUpdate(
  updated: ViewerStoragePayload,
  callbacks: StorageSyncCallbacks = {}
): void {
  if (typeof window === 'undefined' || !updated) return;

  if (updated.uiPreferences) {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify(updated.uiPreferences)
    );
    callbacks.onUiPreferencesUpdated?.(updated.uiPreferences);
  }

  if (updated.connectConfig) {
    const local = loadConnectConfig(window.localStorage).config;
    // Preserve locally active workingDirectory if configured
    const mergedConfig: ConnectConfig = {
      ...(updated.connectConfig as unknown as ConnectConfig),
      workingDirectory: local.workingDirectory || (updated.connectConfig.workingDirectory as string) || '',
    };
    window.localStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify(mergedConfig)
    );
    callbacks.onConnectConfigUpdated?.(mergedConfig as unknown as Record<string, unknown>);
  }

  if (updated.projects) {
    const remoteValidation = validateProjectsRegistry(updated.projects);
    const localActive = loadProjectsRegistry(window.localStorage).registry.activeProjectId;
    const effectiveActive =
      localActive && remoteValidation.registry.projects.some((p) => p.id === localActive)
        ? localActive
        : remoteValidation.registry.activeProjectId;

    const nextProjects: ProjectsRegistry = {
      ...remoteValidation.registry,
      activeProjectId: effectiveActive,
    };

    window.localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify(nextProjects)
    );
    updated.projects = nextProjects as unknown as Record<string, unknown>;
    callbacks.onProjectsUpdated?.(nextProjects as unknown as Record<string, unknown>);
  }

  if (updated.sessions) {
    window.localStorage.setItem(
      PI_VIEWER_SESSIONS_STORAGE_KEY,
      JSON.stringify(updated.sessions)
    );
  }

  if (updated.profileSnapshots) {
    window.localStorage.setItem(
      PI_VIEWER_SESSION_PROFILE_SNAPSHOTS_STORAGE_KEY,
      JSON.stringify(updated.profileSnapshots)
    );
  }

  if (updated.githubPat !== undefined) {
    if (updated.githubPat) {
      window.localStorage.setItem(GITHUB_PAT_STORAGE_KEY, updated.githubPat);
    } else {
      window.localStorage.removeItem(GITHUB_PAT_STORAGE_KEY);
    }
  }

  window.dispatchEvent(
    new CustomEvent('viewer:storage_synced', { detail: updated })
  );
}
