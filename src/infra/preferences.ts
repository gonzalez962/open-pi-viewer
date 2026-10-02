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

export type WorkAnimationMode = 'multicolor' | 'single' | 'dual';

export interface WorkAnimationPreferences {
  mode: WorkAnimationMode;
  color1: string;
  color2: string;
}

export const DEFAULT_WORK_ANIMATION_PREFERENCES: WorkAnimationPreferences = {
  mode: 'multicolor',
  color1: '#00ff0a',
  color2: '#00e5ff',
};

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, '').trim();
  let r = 0, g = 0, b = 0;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16) || 0;
    g = parseInt(clean[1] + clean[1], 16) || 0;
    b = parseInt(clean[2] + clean[2], 16) || 0;
  } else if (clean.length === 6) {
    r = parseInt(clean.slice(0, 2), 16) || 0;
    g = parseInt(clean.slice(2, 4), 16) || 0;
    b = parseInt(clean.slice(4, 6), 16) || 0;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function computeWorkAnimationStyles(pref?: WorkAnimationPreferences): {
  className: string;
  style?: Record<string, string>;
} {
  const mode = pref?.mode || 'multicolor';
  const c1 = pref?.color1 || DEFAULT_WORK_ANIMATION_PREFERENCES.color1;
  const c2 = pref?.color2 || DEFAULT_WORK_ANIMATION_PREFERENCES.color2;

  if (mode === 'single') {
    return {
      className: 'prompt-degraciao-loader is-mode-single',
      style: {
        '--loader-color1': c1,
        '--loader-color1-border': hexToRgba(c1, 0.4),
        '--loader-color1-glow': hexToRgba(c1, 0.45),
      },
    };
  }

  if (mode === 'dual') {
    return {
      className: 'prompt-degraciao-loader is-mode-dual',
      style: {
        '--loader-color1': c1,
        '--loader-color1-border': hexToRgba(c1, 0.4),
        '--loader-color1-glow': hexToRgba(c1, 0.45),
        '--loader-color2': c2,
        '--loader-color2-border': hexToRgba(c2, 0.4),
        '--loader-color2-glow': hexToRgba(c2, 0.45),
      },
    };
  }

  return {
    className: 'prompt-degraciao-loader is-mode-multicolor',
  };
}

export function validateWorkAnimationPreferences(input: unknown): WorkAnimationPreferences {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_WORK_ANIMATION_PREFERENCES };
  }
  const record = input as Record<string, unknown>;
  const mode: WorkAnimationMode =
    record.mode === 'single' || record.mode === 'dual' || record.mode === 'multicolor'
      ? record.mode
      : DEFAULT_WORK_ANIMATION_PREFERENCES.mode;

  const color1 = isValidHexColor(record.color1)
    ? record.color1.trim()
    : DEFAULT_WORK_ANIMATION_PREFERENCES.color1;

  const color2 = isValidHexColor(record.color2)
    ? record.color2.trim()
    : DEFAULT_WORK_ANIMATION_PREFERENCES.color2;

  return { mode, color1, color2 };
}

export interface AreaBackgroundConfig {
  color?: string; // hex color e.g. '#0d1117'
  opacity: number; // 0.00 to 1.00 (0 = 100% transparente)
}

export type BackgroundImageFit = 'cover' | 'contain' | '100% 100%' | 'repeat' | 'auto';
export type BackgroundImagePosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface BackgroundImageConfig {
  enabled: boolean;
  url: string; // URL o base64 Data URL
  fit: BackgroundImageFit;
  position: BackgroundImagePosition;
  repeat: boolean;
  opacity: number; // 0.00 to 1.00
  blur: number; // 0 to 30 px
}

export interface CustomBackgroundPreferences {
  canvas?: AreaBackgroundConfig; // Fondo general / Canvas
  sidebar?: AreaBackgroundConfig; // Barra lateral / Dock
  chat?: AreaBackgroundConfig; // Fondo Principal / Visor de Chat (Respuestas de agentes)
  prompt?: AreaBackgroundConfig; // Zona del Prompt / Entrada de Mensajes
  cards?: AreaBackgroundConfig; // Tarjetas y burbujas
  image?: BackgroundImageConfig; // Imagen de fondo
}

export const DEFAULT_BACKGROUND_IMAGE_CONFIG: BackgroundImageConfig = {
  enabled: false,
  url: '',
  fit: 'cover',
  position: 'center',
  repeat: false,
  opacity: 0.4,
  blur: 0,
};

export function validateAreaBackgroundConfig(input: unknown): AreaBackgroundConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const color =
    typeof rec.color === 'string' && isValidHexColor(rec.color) ? rec.color.trim() : undefined;
  let opacity = 1;
  if (typeof rec.opacity === 'number' && !isNaN(rec.opacity)) {
    opacity = Math.max(0, Math.min(1, rec.opacity));
  }
  return { color, opacity };
}

export function validateBackgroundImageConfig(input: unknown): BackgroundImageConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const enabled = Boolean(rec.enabled);
  const url = typeof rec.url === 'string' ? rec.url.trim() : '';
  const fit = ['cover', 'contain', '100% 100%', 'repeat', 'auto'].includes(String(rec.fit))
    ? (rec.fit as BackgroundImageFit)
    : 'cover';
  const position = ['center', 'top', 'bottom', 'left', 'right'].includes(String(rec.position))
    ? (rec.position as BackgroundImagePosition)
    : 'center';
  const repeat = Boolean(rec.repeat);
  const opacity =
    typeof rec.opacity === 'number' && !isNaN(rec.opacity)
      ? Math.max(0, Math.min(1, rec.opacity))
      : 0.4;
  const blur =
    typeof rec.blur === 'number' && !isNaN(rec.blur)
      ? Math.max(0, Math.min(30, rec.blur))
      : 0;

  return { enabled, url, fit, position, repeat, opacity, blur };
}

export function validateCustomBackgroundPreferences(
  input: unknown
): CustomBackgroundPreferences | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const canvas = validateAreaBackgroundConfig(rec.canvas);
  const sidebar = validateAreaBackgroundConfig(rec.sidebar);
  const chat = validateAreaBackgroundConfig(rec.chat);
  const prompt = validateAreaBackgroundConfig(rec.prompt);
  const cards = validateAreaBackgroundConfig(rec.cards);
  const image = validateBackgroundImageConfig(rec.image);

  if (!canvas && !sidebar && !chat && !prompt && !cards && !image) {
    return undefined;
  }
  return {
    ...(canvas ? { canvas } : {}),
    ...(sidebar ? { sidebar } : {}),
    ...(chat ? { chat } : {}),
    ...(prompt ? { prompt } : {}),
    ...(cards ? { cards } : {}),
    ...(image ? { image } : {}),
  };
}

export interface UiPreferences {
  language: SupportedLocale;
  theme: AppTheme;
  notifications?: NotificationPreferences;
  workAnimation?: WorkAnimationPreferences;
  customTextColor?: string;
  customLabelColor?: string;
  customBackground?: CustomBackgroundPreferences;
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

  const hasWorkAnimation = 'workAnimation' in record && record.workAnimation !== undefined;
  const workAnimation = hasWorkAnimation
    ? validateWorkAnimationPreferences(record.workAnimation)
    : undefined;

  let customTextColor: string | undefined = undefined;
  if ('customTextColor' in record && typeof record.customTextColor === 'string') {
    if (isValidHexColor(record.customTextColor)) {
      customTextColor = record.customTextColor.trim();
    } else {
      warnings.push(`Invalid customTextColor '${String(record.customTextColor)}'; ignored`);
    }
  }

  let customLabelColor: string | undefined = undefined;
  if ('customLabelColor' in record && typeof record.customLabelColor === 'string') {
    if (isValidHexColor(record.customLabelColor)) {
      customLabelColor = record.customLabelColor.trim();
    } else {
      warnings.push(`Invalid customLabelColor '${String(record.customLabelColor)}'; ignored`);
    }
  }

  const hasCustomBackground =
    'customBackground' in record && record.customBackground !== undefined;
  const customBackground = hasCustomBackground
    ? validateCustomBackgroundPreferences(record.customBackground)
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
      ...(workAnimation !== undefined ? { workAnimation } : {}),
      ...(customTextColor !== undefined ? { customTextColor } : {}),
      ...(customLabelColor !== undefined ? { customLabelColor } : {}),
      ...(customBackground !== undefined ? { customBackground } : {}),
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

  setWorkAnimation(workAnimation: WorkAnimationPreferences): UiPreferences {
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current, workAnimation };
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setCustomThemeColors(colors: { text?: string | null; label?: string | null }): UiPreferences {
    const current = this.options.getPreferences();
    const updated: UiPreferences = {
      ...current,
      ...(colors.text !== undefined
        ? colors.text && isValidHexColor(colors.text)
          ? { customTextColor: colors.text.trim() }
          : {}
        : {}),
      ...(colors.label !== undefined
        ? colors.label && isValidHexColor(colors.label)
          ? { customLabelColor: colors.label.trim() }
          : {}
        : {}),
    };

    if (colors.text === null || colors.text === '') {
      delete updated.customTextColor;
    }
    if (colors.label === null || colors.label === '') {
      delete updated.customLabelColor;
    }

    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setCustomBackground(bg: CustomBackgroundPreferences | null): UiPreferences {
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current };
    if (bg) {
      updated.customBackground = bg;
    } else {
      delete updated.customBackground;
    }
    const saveRes = saveUiPreferences(updated, this.options.storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
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
