import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from '@shared/i18n';
import { DEFAULT_THEME, isAppTheme, type AppTheme } from '@shared/theme';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  validateNotificationPreferences,
  type NotificationPreferences,
} from '@core/notifications';
import {
  pruneHiddenCommandIds,
  sanitizeCustomCommands,
  sanitizeHiddenCommandIds,
  type CustomCommand,
} from '@core/commands';

export interface UiPreferences {
  language: SupportedLocale;
  theme: AppTheme;
  notifications?: NotificationPreferences;
  /**
   * Slash commands the user registered in Settings (Issue #9 T7). Stored alongside the other
   * UI preferences; invalid or conflicting stored entries are dropped on load.
   */
  customCommands?: CustomCommand[];
  /**
   * Ids of commands (built-in or custom) the user hid from the palette and "/help"
   * (Issue #9 T8). Purely visual: hidden commands still run when typed.
   */
  hiddenCommandIds?: string[];
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  language: DEFAULT_LOCALE,
  theme: DEFAULT_THEME,
  notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
};

export const UI_PREFERENCES_STORAGE_KEY = 'pi_viewer_ui_preferences';

export interface PreferencesValidationResult {
  valid: boolean;
  preferences: UiPreferences;
  error?: string;
  warning?: string;
}

export interface PreferencesLoadResult {
  preferences: UiPreferences;
  warning?: string;
}

export interface PreferencesSaveResult {
  success: boolean;
  error?: string;
}

/**
 * Validates arbitrary input against the UiPreferences schema.
 * Replaces invalid fields with honest defaults and returns descriptive warnings.
 */
export function validateUiPreferences(input: unknown): PreferencesValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      preferences: { ...DEFAULT_UI_PREFERENCES },
      error: 'Preferences payload must be a non-null object',
    };
  }

  const record = input as Record<string, unknown>;
  const warnings: string[] = [];

  let language: SupportedLocale = DEFAULT_LOCALE;
  if (isSupportedLocale(record.language)) {
    language = record.language;
  } else {
    warnings.push(
      `Invalid language '${String(record.language)}'; defaulted to '${DEFAULT_LOCALE}'`
    );
  }

  let theme: AppTheme = DEFAULT_THEME;
  if (isAppTheme(record.theme)) {
    theme = record.theme;
  } else {
    warnings.push(
      `Invalid theme '${String(record.theme)}'; defaulted to '${DEFAULT_THEME}'`
    );
  }

  const hasNotifications = 'notifications' in record;
  const notifications = hasNotifications
    ? validateNotificationPreferences(record.notifications)
    : undefined;

  const customCommands =
    'customCommands' in record ? sanitizeCustomCommands(record.customCommands) : undefined;

  const hiddenCommandIds =
    'hiddenCommandIds' in record ? sanitizeHiddenCommandIds(record.hiddenCommandIds) : undefined;

  const valid = warnings.length === 0;
  return {
    valid,
    preferences: {
      language,
      theme,
      ...(notifications !== undefined ? { notifications } : {}),
      ...(customCommands !== undefined ? { customCommands } : {}),
      ...(hiddenCommandIds !== undefined ? { hiddenCommandIds } : {}),
    },
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  };
}

/**
 * Safely accesses the browser's localStorage or returns null in non-browser environments.
 */
function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage access may throw SecurityError in restricted iframes or disabled cookies
  }
  return null;
}

/**
 * Loads UI preferences from storage with schema validation and honest error handling.
 * Never throws; returns defaults and an optional diagnostic warning on corrupt or missing data.
 */
export function loadUiPreferences(
  storage: Storage | null = getSafeStorage()
): PreferencesLoadResult {
  if (!storage) {
    return {
      preferences: { ...DEFAULT_UI_PREFERENCES },
    };
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(UI_PREFERENCES_STORAGE_KEY);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      preferences: { ...DEFAULT_UI_PREFERENCES },
      warning: `Failed to read UI preferences from storage: ${msg}`,
    };
  }

  if (raw === null) {
    return {
      preferences: { ...DEFAULT_UI_PREFERENCES },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      preferences: { ...DEFAULT_UI_PREFERENCES },
      warning: 'Stored UI preferences contained invalid JSON; defaulted to English and dark theme',
    };
  }

  const validation = validateUiPreferences(parsed);
  return {
    preferences: validation.preferences,
    ...(validation.warning ? { warning: validation.warning } : {}),
  };
}

/**
 * Validates and persists UI preferences to storage.
 * Storage errors (e.g. QuotaExceededError or security exceptions) are caught and surfaced cleanly.
 */
export function saveUiPreferences(
  preferences: UiPreferences,
  storage: Storage | null = getSafeStorage()
): PreferencesSaveResult {
  const validation = validateUiPreferences(preferences);
  if (!validation.valid && validation.error) {
    return {
      success: false,
      error: validation.error,
    };
  }

  if (!storage) {
    return {
      success: false,
      error: 'Storage is not available in current environment',
    };
  }

  try {
    storage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify(validation.preferences)
    );
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to persist UI preferences to storage: ${msg}`,
    };
  }
}

export interface PreferencesControllerOptions {
  getPreferences: () => UiPreferences;
  setPreferences: (prefs: UiPreferences) => void;
  setWarning: (warning: string | null) => void;
  storage?: Storage | null;
}

/**
 * Production controller orchestrating immediate UI preference mutations.
 * Directly encapsulates validation, storage persistence, and warning callbacks
 * without triggering bridge reconnection, prompt reset, or session side effects.
 */
export class PreferencesController {
  constructor(private readonly options: PreferencesControllerOptions) {}

  setTheme(theme: AppTheme): UiPreferences {
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current, theme };
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setLanguage(language: SupportedLocale): UiPreferences {
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current, language };
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setNotifications(partial: Partial<NotificationPreferences>): PreferencesSaveResult {
    const current = this.options.getPreferences();
    const currentNotifications =
      current.notifications ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const updatedNotifications: NotificationPreferences = {
      ...currentNotifications,
      ...partial,
    };
    const updated: UiPreferences = {
      ...current,
      notifications: updatedNotifications,
    };
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return saveRes;
  }

  /**
   * Replaces the custom commands. Hidden ids of custom commands that no longer exist are
   * pruned in the same write, so a delete never leaves a stale hidden entry behind.
   */
  setCustomCommands(customCommands: CustomCommand[]): PreferencesSaveResult {
    const current = this.options.getPreferences();
    const updated: UiPreferences = {
      ...current,
      customCommands,
      ...(current.hiddenCommandIds !== undefined
        ? { hiddenCommandIds: pruneHiddenCommandIds(current.hiddenCommandIds, customCommands) }
        : {}),
    };
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return saveRes;
  }

  /** Replaces the ids of commands hidden from the palette and "/help" (Issue #9 T8). */
  setHiddenCommandIds(hiddenCommandIds: string[]): PreferencesSaveResult {
    const current = this.options.getPreferences();
    const updated: UiPreferences = {
      ...current,
      hiddenCommandIds: sanitizeHiddenCommandIds(hiddenCommandIds),
    };
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return saveRes;
  }
}
