import type { ConnectConfig } from '@core/types/connection';

export const CONFIG_STORAGE_KEY = 'pi_viewer_connect_config';

/**
 * Fallback portable defaults for local Pi installation.
 * Unconfigured initial state awaiting discovery or user settings.
 */
export const DEFAULT_CONFIG: ConnectConfig = {
  nodePath: 'node',
  piEntrypoint: '',
  workingDirectory: '',
  fileTreeRefreshInterval: 15,
};

export interface ConfigValidationResult {
  valid: boolean;
  error?: string;
  config?: ConnectConfig;
}

/**
 * Check whether a configuration is complete and ready for establishing a Pi connection.
 * A ready configuration must pass validateConnectConfig with valid absolute paths.
 */
export function isConfigReady(config: unknown): config is ConnectConfig {
  return validateConnectConfig(config).valid;
}

/**
 * Check if a path is absolute cross-platform:
 * - Windows drive root (e.g. C:\ or C:/)
 * - Windows UNC path (e.g. \\server\share)
 * - Unix/Linux/macOS root (e.g. /home/user)
 */
export function isAbsolutePath(pathStr: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(pathStr);
}

/**
 * Validate ConnectConfig object structure and field requirements.
 */
export function validateConnectConfig(input: unknown): ConfigValidationResult {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Configuration must be a non-null object' };
  }

  const raw = input as Record<string, unknown>;

  // Check if Gentle Mesh connection type is selected
  if (raw.connectionType === 'mesh') {
    let meshCoordinatorUrl = 'http://localhost:8080';
    if (typeof raw.meshCoordinatorUrl === 'string' && raw.meshCoordinatorUrl.trim() !== '') {
      meshCoordinatorUrl = raw.meshCoordinatorUrl.trim();
    }
    if (!meshCoordinatorUrl.startsWith('http://') && !meshCoordinatorUrl.startsWith('https://')) {
      return {
        valid: false,
        error: `Gentle Mesh coordinator URL must begin with http:// or https://, got: '${meshCoordinatorUrl}'`,
      };
    }

    const workingDirectory =
      typeof raw.workingDirectory === 'string' && raw.workingDirectory.trim() !== ''
        ? raw.workingDirectory.trim()
        : '.';

    let fileTreeRefreshInterval = 15;
    if (raw.fileTreeRefreshInterval !== undefined) {
      if (
        typeof raw.fileTreeRefreshInterval === 'number' &&
        Number.isFinite(raw.fileTreeRefreshInterval) &&
        raw.fileTreeRefreshInterval >= 0
      ) {
        fileTreeRefreshInterval = Math.round(raw.fileTreeRefreshInterval);
      } else {
        return {
          valid: false,
          error: 'File tree refresh interval must be a non-negative number of seconds',
        };
      }
    }

    return {
      valid: true,
      config: {
        nodePath: typeof raw.nodePath === 'string' ? raw.nodePath : 'node',
        piEntrypoint: typeof raw.piEntrypoint === 'string' ? raw.piEntrypoint : '',
        workingDirectory,
        fileTreeRefreshInterval,
        connectionType: 'mesh',
        meshCoordinatorUrl,
        meshToken: typeof raw.meshToken === 'string' ? raw.meshToken.trim() : '',
      },
    };
  }

  // 1. Node executable validation
  if (typeof raw.nodePath !== 'string') {
    return { valid: false, error: 'Node executable path must be a string' };
  }
  const nodePath = raw.nodePath.trim();
  if (!nodePath) {
    return { valid: false, error: 'Node executable path cannot be empty' };
  }

  // 2. Pi entrypoint validation
  if (typeof raw.piEntrypoint !== 'string') {
    return { valid: false, error: 'Pi CLI entrypoint path must be a string' };
  }
  const piEntrypoint = raw.piEntrypoint.trim();
  if (!piEntrypoint) {
    return { valid: false, error: 'Pi CLI entrypoint path cannot be empty' };
  }
  if (!isAbsolutePath(piEntrypoint)) {
    return {
      valid: false,
      error: `Pi entrypoint must be an absolute path: '${piEntrypoint}'`,
    };
  }
  const extMatch = piEntrypoint.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (ext !== 'js' && ext !== 'mjs' && ext !== 'cjs') {
    return {
      valid: false,
      error: `Pi entrypoint must have a JavaScript extension (.js, .mjs, .cjs), got: '${piEntrypoint}'`,
    };
  }

  // 3. Working directory validation
  if (typeof raw.workingDirectory !== 'string') {
    return { valid: false, error: 'Working directory path must be a string' };
  }
  const workingDirectory = raw.workingDirectory.trim();
  if (!workingDirectory) {
    return { valid: false, error: 'Working directory path cannot be empty' };
  }
  if (!isAbsolutePath(workingDirectory)) {
    return {
      valid: false,
      error: `Working directory must be an absolute path: '${workingDirectory}'`,
    };
  }

  // 4. File tree auto-refresh interval validation (optional, defaults to 15 seconds, 0 = disabled)
  let fileTreeRefreshInterval = 15;
  if (raw.fileTreeRefreshInterval !== undefined) {
    if (
      typeof raw.fileTreeRefreshInterval === 'number' &&
      Number.isFinite(raw.fileTreeRefreshInterval) &&
      raw.fileTreeRefreshInterval >= 0
    ) {
      fileTreeRefreshInterval = Math.round(raw.fileTreeRefreshInterval);
    } else {
      return {
        valid: false,
        error: 'File tree refresh interval must be a non-negative number of seconds',
      };
    }
  }

  return {
    valid: true,
    config: {
      nodePath,
      piEntrypoint,
      workingDirectory,
      fileTreeRefreshInterval,
    },
  };
}

export interface ConfigLoadResult {
  config: ConnectConfig;
  warning?: string;
  source: 'stored' | 'default';
}

/**
 * Load persisted connection configuration from localStorage.
 * Honest fallbacks:
 * - Absent -> default config, no warning
 * - Corrupt/Partial/Invalid/Storage throw -> default config + honest diagnostic warning
 */
export function loadConnectConfig(storage?: Storage | null): ConfigLoadResult {
  let store: Storage | null = null;
  try {
    store =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined'
          ? window.localStorage
          : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning: `Storage access failed (${msg}); using portable defaults`,
    };
  }

  if (!store) {
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning: 'Local storage unavailable; using portable defaults',
    };
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(CONFIG_STORAGE_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning: `Failed to read configuration from storage (${msg}); using portable defaults`,
    };
  }

  if (raw === null) {
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning:
        'Corrupted configuration in storage; falling back to portable defaults',
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning:
        'Stored configuration is not a valid object; using portable defaults',
    };
  }

  const rawObj = parsed as Record<string, unknown>;
  const isMesh = rawObj.connectionType === 'mesh';
  const requiredFields = isMesh
    ? ['meshCoordinatorUrl']
    : ['nodePath', 'piEntrypoint', 'workingDirectory'];
  const missingFields = requiredFields.filter((f) => !(f in rawObj));
  if (missingFields.length > 0) {
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning: `Partial configuration in storage missing required fields (${missingFields.join(', ')}); using portable defaults`,
    };
  }

  const validation = validateConnectConfig(parsed);
  if (!validation.valid || !validation.config) {
    return {
      config: { ...DEFAULT_CONFIG },
      source: 'default',
      warning: `Stored configuration is invalid (${validation.error}); using portable defaults`,
    };
  }

  return {
    config: validation.config,
    source: 'stored',
  };
}

export interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

/**
 * Persist validated connection configuration to localStorage.
 * Validates fields before writing, catches any storage throws, and reports failure honestly.
 */
export function saveConnectConfig(
  config: unknown,
  storage?: Storage | null
): ConfigSaveResult {
  const validation = validateConnectConfig(config);
  if (!validation.valid || !validation.config) {
    return {
      success: false,
      error: validation.error || 'Invalid configuration',
    };
  }

  let store: Storage | null = null;
  try {
    store =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined'
          ? window.localStorage
          : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Storage access failed: ${msg}`,
    };
  }

  if (!store) {
    return {
      success: false,
      error: 'Local storage unavailable; cannot persist configuration',
    };
  }

  try {
    store.setItem(CONFIG_STORAGE_KEY, JSON.stringify(validation.config));
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to persist configuration to storage: ${msg}`,
    };
  }
}
