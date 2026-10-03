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

/**
 * Validates whether a value is a valid 3-digit or 6-digit hex color.
 */
export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/**
 * Converts a hex color and alpha float into an rgba() CSS string.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, '').trim();
  let r = 0;
  let g = 0;
  let b = 0;
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

/**
 * Computes CSS classes and inline CSS custom properties for work animation loaders.
 */
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

/**
 * Validates and normalizes work animation preferences.
 */
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
  opacity: number; // 0.00 to 1.00 finite number (0 = 100% transparent)
}

export type BackgroundImageFit = 'cover' | 'contain' | '100% 100%' | 'repeat' | 'auto';
export type BackgroundImagePosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface BackgroundImageConfig {
  enabled: boolean;
  url: string; // HTTP/HTTPS, bundled /wallpapers path, or bounded image data URL
  fit: BackgroundImageFit;
  position: BackgroundImagePosition;
  repeat: boolean;
  opacity: number; // 0.00 to 1.00 finite number
  blur: number; // 0 to 30 px finite number
}

export interface CustomBackgroundPreferences {
  canvas?: AreaBackgroundConfig; // Fondo general / Canvas
  sidebar?: AreaBackgroundConfig; // Barra lateral / Dock
  chat?: AreaBackgroundConfig; // Fondo Principal / Visor de Chat
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

/**
 * Maximum length in characters for an encoded wallpaper image Data URL (conservatively 1 MiB).
 * Bounds encoded character length only; does not guarantee storage quota headroom.
 */
export const MAX_WALLPAPER_DATA_URL_LENGTH = 1024 * 1024;
export const MAX_IMAGE_DATA_URL_LENGTH = MAX_WALLPAPER_DATA_URL_LENGTH;

/**
 * Legacy standalone localStorage key used in PR #28 prototype.
 */
export const LEGACY_CUSTOM_ACCENT_STORAGE_KEY = 'pi_viewer_custom_accent';

/**
 * Validates that an image URL string is safe:
 * - HTTP or HTTPS protocols
 * - Bundled /wallpapers paths without directory traversal
 * - Bounded image Data URLs (<= 1 MiB) with safe raster/svg MIME types
 * Strictly rejects javascript:, vbscript:, arbitrary data URLs, and malformed inputs.
 */
export function isSafeImageUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) {
    return false;
  }

  // Bundled wallpapers directory
  if (trimmed.startsWith('/wallpapers/')) {
    if (trimmed.includes('..') || trimmed.includes('\\')) {
      return false;
    }
    return true;
  }

  // Bounded image Data URLs
  if (lower.startsWith('data:image/')) {
    if (trimmed.length > MAX_WALLPAPER_DATA_URL_LENGTH) {
      return false;
    }
    const match = lower.match(
      /^data:image\/(png|jpeg|jpg|webp|gif|bmp|svg\+xml)(?:;charset=[a-z0-9-]+)?(?:;base64)?,/
    );
    return Boolean(match);
  }

  // Standard web URLs
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  return false;
}

export const isValidImageUrl = isSafeImageUrl;

/**
 * Validates area background config enforcing finite numeric bounds and valid colors.
 */
export function validateAreaBackgroundConfig(input: unknown): AreaBackgroundConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const color =
    typeof rec.color === 'string' && isValidHexColor(rec.color) ? rec.color.trim() : undefined;
  let opacity = 1;
  if (typeof rec.opacity === 'number' && Number.isFinite(rec.opacity)) {
    opacity = Math.max(0, Math.min(1, rec.opacity));
  }
  return { color, opacity };
}

/**
 * Validates background image config enforcing safe image URLs and finite bounds.
 */
export function validateBackgroundImageConfig(input: unknown): BackgroundImageConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const enabled = Boolean(rec.enabled);
  const rawUrl = typeof rec.url === 'string' ? rec.url.trim() : '';
  const url = isSafeImageUrl(rawUrl) ? rawUrl : '';

  const fit = ['cover', 'contain', '100% 100%', 'repeat', 'auto'].includes(String(rec.fit))
    ? (rec.fit as BackgroundImageFit)
    : 'cover';
  const position = ['center', 'top', 'bottom', 'left', 'right'].includes(String(rec.position))
    ? (rec.position as BackgroundImagePosition)
    : 'center';
  const repeat = Boolean(rec.repeat);
  const opacity =
    typeof rec.opacity === 'number' && Number.isFinite(rec.opacity)
      ? Math.max(0, Math.min(1, rec.opacity))
      : 0.4;
  const blur =
    typeof rec.blur === 'number' && Number.isFinite(rec.blur)
      ? Math.max(0, Math.min(30, rec.blur))
      : 0;

  return { enabled, url, fit, position, repeat, opacity, blur };
}

/**
 * Validates custom background preferences across all 5 areas and the image config.
 */
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

export interface AppearancePreferences {
  theme?: AppTheme;
  customAccent?: string | null;
  customTextColor?: string | null;
  customLabelColor?: string | null;
  workAnimation?: WorkAnimationPreferences;
  customBackground?: CustomBackgroundPreferences | null;
}

export type AppearanceInput = Partial<AppearancePreferences> & {
  customAccent?: string | null;
  customTextColor?: string | null;
  customLabelColor?: string | null;
  workAnimation?: WorkAnimationPreferences | null;
  customBackground?: CustomBackgroundPreferences | null;
};

export interface UiPreferences {
  language: SupportedLocale;
  theme: AppTheme;
  notifications?: NotificationPreferences;
  customAccent?: string | null;
  customTextColor?: string;
  customLabelColor?: string;
  workAnimation?: WorkAnimationPreferences;
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
 * Pure helper extracting visual appearance preferences from UiPreferences.
 */
export function extractAppearancePreferences(prefs: UiPreferences): AppearancePreferences {
  return {
    theme: prefs.theme,
    ...(prefs.customAccent !== undefined ? { customAccent: prefs.customAccent } : {}),
    ...(prefs.customTextColor !== undefined ? { customTextColor: prefs.customTextColor } : {}),
    ...(prefs.customLabelColor !== undefined ? { customLabelColor: prefs.customLabelColor } : {}),
    ...(prefs.workAnimation !== undefined ? { workAnimation: prefs.workAnimation } : {}),
    ...(prefs.customBackground !== undefined ? { customBackground: prefs.customBackground } : {}),
  };
}

/**
 * Checks whether any custom appearance override or preset theme is active.
 */
export function hasCustomAppearance(prefs: UiPreferences): boolean {
  return Boolean(
    (prefs.customAccent && isValidHexColor(prefs.customAccent)) ||
      prefs.customTextColor ||
      prefs.customLabelColor ||
      prefs.workAnimation ||
      prefs.customBackground ||
      (prefs.theme !== 'dark' && prefs.theme !== 'light' && prefs.theme !== 'system')
  );
}

/**
 * Computes the complete CSS custom properties map for the active visual appearance.
 * Reusable for live preview, unmount restoration, and persistent styling.
 */
export function computeCustomThemeVariables(prefs: AppearancePreferences): Record<string, string> {
  const vars: Record<string, string> = {};

  if (prefs.customAccent && isValidHexColor(prefs.customAccent)) {
    vars['--accent-primary'] = prefs.customAccent;
    vars['--accent-primary-hover'] = hexToRgba(prefs.customAccent, 0.85);
    vars['--border-active'] = prefs.customAccent;
  }

  if (prefs.customTextColor && isValidHexColor(prefs.customTextColor)) {
    vars['--fg-default'] = prefs.customTextColor;
    vars['--text-primary'] = prefs.customTextColor;
  }

  if (prefs.customLabelColor && isValidHexColor(prefs.customLabelColor)) {
    const lbl = prefs.customLabelColor;
    vars['--activity-badge-fg'] = lbl;
    vars['--activity-badge-border'] = hexToRgba(lbl, 0.35);
    vars['--activity-badge-bg'] = hexToRgba(lbl, 0.12);
    vars['--md-inline-code-fg'] = lbl;
    vars['--md-inline-code-border'] = hexToRgba(lbl, 0.25);
    vars['--tag-color'] = lbl;
    vars['--syntax-keyword'] = lbl;
  }

  if (prefs.workAnimation) {
    const animStyles = computeWorkAnimationStyles(prefs.workAnimation);
    if (animStyles.style) {
      Object.assign(vars, animStyles.style);
    }
  }

  const bg = prefs.customBackground;
  if (bg) {
    if (bg.canvas) {
      if (bg.canvas.opacity === 0) {
        vars['--custom-bg-canvas'] = 'transparent';
      } else if (bg.canvas.color) {
        vars['--custom-bg-canvas'] = hexToRgba(bg.canvas.color, bg.canvas.opacity);
      }
    } else if (bg.image?.enabled && bg.image?.url) {
      vars['--custom-bg-canvas'] = 'transparent';
    }

    if (bg.sidebar) {
      if (bg.sidebar.opacity === 0) {
        vars['--custom-bg-sidebar'] = 'transparent';
      } else if (bg.sidebar.color) {
        vars['--custom-bg-sidebar'] = hexToRgba(bg.sidebar.color, bg.sidebar.opacity);
      }
    }

    if (bg.chat) {
      if (bg.chat.opacity === 0) {
        vars['--custom-bg-chat'] = 'transparent';
      } else if (bg.chat.color) {
        vars['--custom-bg-chat'] = hexToRgba(bg.chat.color, bg.chat.opacity);
      }
    } else if (bg.image?.enabled && bg.image?.url) {
      vars['--custom-bg-chat'] = 'transparent';
    }

    if (bg.prompt) {
      if (bg.prompt.opacity === 0) {
        vars['--custom-bg-prompt'] = 'transparent';
      } else if (bg.prompt.color) {
        vars['--custom-bg-prompt'] = hexToRgba(bg.prompt.color, bg.prompt.opacity);
      }
    } else if (bg.image?.enabled && bg.image?.url) {
      vars['--custom-bg-prompt'] = 'rgba(10, 10, 10, 0.55)';
    }

    if (bg.cards) {
      if (bg.cards.opacity === 0) {
        vars['--custom-bg-cards'] = 'transparent';
      } else if (bg.cards.color) {
        vars['--custom-bg-cards'] = hexToRgba(bg.cards.color, bg.cards.opacity);
      }
    }
  }

  return vars;
}

/**
 * Validates arbitrary input against the UiPreferences schema.
 * Normalizes visual and system fields with honest defaults and returns descriptive warnings.
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

  let customAccent: string | null | undefined = undefined;
  if ('customAccent' in record) {
    if (record.customAccent === null) {
      customAccent = null;
    } else if (typeof record.customAccent === 'string' && isValidHexColor(record.customAccent)) {
      customAccent = record.customAccent.trim();
    } else if (record.customAccent === '') {
      customAccent = null;
    } else if (record.customAccent !== undefined) {
      warnings.push(`Invalid customAccent '${String(record.customAccent)}'; ignored`);
    }
  } else if ('accent' in record) {
    if (record.accent === null || record.accent === '') {
      customAccent = null;
    } else if (typeof record.accent === 'string' && isValidHexColor(record.accent)) {
      // Migrate legacy 'accent' key if present in record
      customAccent = record.accent.trim();
    }
  }

  let customTextColor: string | undefined = undefined;
  if ('customTextColor' in record) {
    if (typeof record.customTextColor === 'string' && isValidHexColor(record.customTextColor)) {
      customTextColor = record.customTextColor.trim();
    } else if (record.customTextColor !== undefined && record.customTextColor !== null && record.customTextColor !== '') {
      warnings.push(`Invalid customTextColor '${String(record.customTextColor)}'; ignored`);
    }
  }

  let customLabelColor: string | undefined = undefined;
  if ('customLabelColor' in record) {
    if (typeof record.customLabelColor === 'string' && isValidHexColor(record.customLabelColor)) {
      customLabelColor = record.customLabelColor.trim();
    } else if (record.customLabelColor !== undefined && record.customLabelColor !== null && record.customLabelColor !== '') {
      warnings.push(`Invalid customLabelColor '${String(record.customLabelColor)}'; ignored`);
    }
  }

  const hasWorkAnimation = 'workAnimation' in record && record.workAnimation !== undefined;
  const workAnimation = hasWorkAnimation
    ? validateWorkAnimationPreferences(record.workAnimation)
    : undefined;

  let customBackground: CustomBackgroundPreferences | undefined = undefined;
  if ('customBackground' in record && record.customBackground !== undefined) {
    if (typeof record.customBackground === 'object' && record.customBackground !== null) {
      const bgRec = record.customBackground as Record<string, unknown>;
      if (bgRec.image && typeof bgRec.image === 'object' && !Array.isArray(bgRec.image)) {
        const rawImgUrl = typeof (bgRec.image as Record<string, unknown>).url === 'string'
          ? ((bgRec.image as Record<string, unknown>).url as string).trim()
          : '';
        if (rawImgUrl.length > 0 && !isSafeImageUrl(rawImgUrl)) {
          if (rawImgUrl.toLowerCase().startsWith('data:image/') && rawImgUrl.length > MAX_WALLPAPER_DATA_URL_LENGTH) {
            warnings.push('Wallpaper image data URL exceeds 1 MiB limit; reset to empty');
          } else {
            warnings.push('Invalid or unsafe wallpaper image URL; reset to empty');
          }
        }
      }
    }
    customBackground = validateCustomBackgroundPreferences(record.customBackground);
  }

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
      ...(customAccent !== undefined ? { customAccent } : {}),
      ...(customTextColor !== undefined ? { customTextColor } : {}),
      ...(customLabelColor !== undefined ? { customLabelColor } : {}),
      ...(workAnimation !== undefined ? { workAnimation } : {}),
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
 * Loads UI preferences from storage with schema validation, legacy migration, and honest error handling.
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
    const prefs = { ...DEFAULT_UI_PREFERENCES };
    // Check for legacy custom accent in storage
    try {
      const legacyAccent = storage.getItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY);
      if (legacyAccent && isValidHexColor(legacyAccent)) {
        prefs.customAccent = legacyAccent.trim();
      }
    } catch {
      // Ignore legacy read errors
    }
    return { preferences: prefs };
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

  const hasManagedAccent =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'customAccent' in (parsed as Record<string, unknown>);

  // If customAccent was not defined in the main preferences JSON, migrate legacy key if present.
  // Note: an explicit null marker indicates customAccent was cleared/reset; do not resurrect.
  if (!hasManagedAccent && validation.preferences.customAccent === undefined) {
    try {
      const legacyAccent = storage.getItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY);
      if (legacyAccent && isValidHexColor(legacyAccent)) {
        validation.preferences.customAccent = legacyAccent.trim();
      }
    } catch {
      // Ignore legacy read errors
    }
  }

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
 * Production controller orchestrating immediate UI preference mutations and atomic appearance commits.
 * Directly encapsulates validation, storage persistence, and warning callbacks
 * without triggering bridge reconnection, prompt reset, or session side effects.
 */
export class PreferencesController {
  constructor(private readonly options: PreferencesControllerOptions) {}

  private resolveStorage(): Storage | null {
    return this.options.storage !== undefined ? this.options.storage : getSafeStorage();
  }

  setTheme(theme: AppTheme): UiPreferences {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current, theme };
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setLanguage(language: SupportedLocale): UiPreferences {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current, language };
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setNotifications(partial: Partial<NotificationPreferences>): PreferencesSaveResult {
    const storage = this.resolveStorage();
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
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return saveRes;
  }

  setWorkAnimation(workAnimation: WorkAnimationPreferences): UiPreferences {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current, workAnimation };
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setCustomAccent(accent: string | null): UiPreferences {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = {
      ...current,
      customAccent: accent && isValidHexColor(accent) ? accent.trim() : null,
    };
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      if (storage) {
        try {
          storage.removeItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY);
        } catch {}
      }
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setCustomThemeColors(colors: {
    text?: string | null;
    label?: string | null;
    accent?: string | null;
  }): UiPreferences {
    const storage = this.resolveStorage();
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
      ...(colors.accent !== undefined
        ? { customAccent: colors.accent && isValidHexColor(colors.accent) ? colors.accent.trim() : null }
        : {}),
    };

    if (colors.text === null || colors.text === '') {
      delete updated.customTextColor;
    }
    if (colors.label === null || colors.label === '') {
      delete updated.customLabelColor;
    }

    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      if (storage && colors.accent !== undefined) {
        try {
          storage.removeItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY);
        } catch {}
      }
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  setCustomBackground(bg: CustomBackgroundPreferences | null): UiPreferences {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = { ...current };
    if (bg) {
      const validated = validateCustomBackgroundPreferences(bg);
      if (validated) {
        updated.customBackground = validated;
      } else {
        delete updated.customBackground;
      }
    } else {
      delete updated.customBackground;
    }
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return updated;
  }

  /**
   * Atomic appearance commit API:
   * 1. Validates and attempts storage persistence first.
   * 2. On storage or quota failure: live preferences are NOT mutated, warning is surfaced,
   *    and failure result is returned so UI can display honest feedback.
   * 3. On success: live preferences are updated and legacy keys cleaned up.
   */
  commitAppearance(candidate: AppearanceInput): PreferencesSaveResult {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const nextPrefs: UiPreferences = { ...current };

    if (candidate.theme !== undefined) {
      if (isAppTheme(candidate.theme)) {
        nextPrefs.theme = candidate.theme;
      }
    }

    if (candidate.customAccent !== undefined) {
      if (candidate.customAccent === null || candidate.customAccent === '') {
        nextPrefs.customAccent = null;
      } else if (isValidHexColor(candidate.customAccent)) {
        nextPrefs.customAccent = candidate.customAccent.trim();
      } else {
        nextPrefs.customAccent = null;
      }
    }

    if (candidate.customTextColor !== undefined) {
      if (candidate.customTextColor === null || candidate.customTextColor === '') {
        delete nextPrefs.customTextColor;
      } else if (isValidHexColor(candidate.customTextColor)) {
        nextPrefs.customTextColor = candidate.customTextColor.trim();
      } else {
        delete nextPrefs.customTextColor;
      }
    }

    if (candidate.customLabelColor !== undefined) {
      if (candidate.customLabelColor === null || candidate.customLabelColor === '') {
        delete nextPrefs.customLabelColor;
      } else if (isValidHexColor(candidate.customLabelColor)) {
        nextPrefs.customLabelColor = candidate.customLabelColor.trim();
      } else {
        delete nextPrefs.customLabelColor;
      }
    }

    if (candidate.workAnimation !== undefined) {
      if (candidate.workAnimation === null) {
        delete nextPrefs.workAnimation;
      } else {
        nextPrefs.workAnimation = validateWorkAnimationPreferences(candidate.workAnimation);
      }
    }

    if (candidate.customBackground !== undefined) {
      if (candidate.customBackground === null || (typeof candidate.customBackground === 'object' && Object.keys(candidate.customBackground).length === 0)) {
        delete nextPrefs.customBackground;
      } else {
        const bg = validateCustomBackgroundPreferences(candidate.customBackground);
        if (bg && Object.keys(bg).length > 0) {
          nextPrefs.customBackground = bg;
        } else {
          delete nextPrefs.customBackground;
        }
      }
    }

    const validation = validateUiPreferences(nextPrefs);
    const saveRes = saveUiPreferences(validation.preferences, storage);

    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to persist appearance preferences');
      return saveRes;
    }

    // Storage write succeeded: safely clean up legacy key if storage is available
    if (storage) {
      try {
        storage.removeItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY);
      } catch {
        // Safe to ignore legacy cleanup failure
      }
    }

    this.options.setWarning(null);
    this.options.setPreferences(validation.preferences);
    return saveRes;
  }

  /**
   * Resets all visual appearance customizations atomically back to defaults,
   * while preserving language, theme, notifications, custom commands, and hidden command IDs.
   * Mutates live preferences only if persistence succeeds.
   */
  resetAppearance(): PreferencesSaveResult {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const resetCandidate: UiPreferences = {
      language: current.language,
      theme: current.theme,
      customAccent: null,
      ...(current.notifications !== undefined ? { notifications: current.notifications } : {}),
      ...(current.customCommands !== undefined ? { customCommands: current.customCommands } : {}),
      ...(current.hiddenCommandIds !== undefined ? { hiddenCommandIds: current.hiddenCommandIds } : {}),
    };

    const saveRes = saveUiPreferences(resetCandidate, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to reset appearance preferences');
      return saveRes;
    }

    if (storage) {
      try {
        storage.removeItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY);
      } catch {
        // Safe to ignore legacy cleanup failure
      }
    }

    this.options.setWarning(null);
    this.options.setPreferences(resetCandidate);
    return saveRes;
  }

  /**
   * Replaces the custom commands. Hidden ids of custom commands that no longer exist are
   * pruned in the same write, so a delete never leaves a stale hidden entry behind.
   */
  setCustomCommands(customCommands: CustomCommand[]): PreferencesSaveResult {
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = {
      ...current,
      customCommands,
      ...(current.hiddenCommandIds !== undefined
        ? { hiddenCommandIds: pruneHiddenCommandIds(current.hiddenCommandIds, customCommands) }
        : {}),
    };
    const saveRes = saveUiPreferences(updated, storage);
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
    const storage = this.resolveStorage();
    const current = this.options.getPreferences();
    const updated: UiPreferences = {
      ...current,
      hiddenCommandIds: sanitizeHiddenCommandIds(hiddenCommandIds),
    };
    const saveRes = saveUiPreferences(updated, storage);
    if (!saveRes.success) {
      this.options.setWarning(saveRes.error ?? 'Failed to save UI preferences');
    } else {
      this.options.setWarning(null);
    }
    this.options.setPreferences(updated);
    return saveRes;
  }
}
