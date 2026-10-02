import { useEffect, useRef, useState } from 'react';
import {
  loadUiPreferences,
  PreferencesController,
  hexToRgba,
  type UiPreferences,
  type WorkAnimationPreferences,
  type CustomBackgroundPreferences,
} from '@infra/preferences';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '@core/notifications';
import type { CustomCommand } from '@core/commands';
import {
  setDocumentLanguage,
  translate,
  type SupportedLocale,
  type TranslationKey,
} from '@shared/i18n';
import { applyTheme, resolveTheme, watchSystemTheme, type AppTheme } from '@shared/theme';

export interface UsePreferencesResult {
  preferences: UiPreferences;
  preferencesWarning: string | null;
  dismissPreferencesWarning: () => void;
  handleThemeChange: (newTheme: AppTheme) => void;
  handleLanguageChange: (newLanguage: SupportedLocale) => void;
  handleWorkAnimationChange: (newAnimation: WorkAnimationPreferences) => void;
  handleCustomThemeColorsChange: (colors: { text?: string | null; label?: string | null }) => void;
  handleCustomBackgroundChange: (bg: CustomBackgroundPreferences | null) => void;
  setNotifications: (partial: Partial<NotificationPreferences>) => void;
  /** Replaces and persists the user's custom slash commands (Issue #9 T7). */
  setCustomCommands: (commands: CustomCommand[]) => void;
  /** Replaces and persists the ids of commands hidden from the palette and "/help" (T8). */
  setHiddenCommandIds: (ids: string[]) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/**
 * Owns UI preferences (language & theme), separate from connection settings.
 * Mirrors App.tsx's former inline state/effects exactly, including the
 * document-language sync effect and the theme resolution/system-watch effect.
 *
 * Fix folded into this extraction: the previous code called `loadUiPreferences()`
 * twice at mount (once per lazy initializer) to derive two independent pieces of
 * state from the same single storage read. `loadUiPreferences()` is a pure read
 * with no side effect beyond `storage.getItem` (see src/infra/preferences.ts) and
 * is idempotent, so two calls always produced the same result as one - the
 * duplication was wasted work, not a correctness difference. The read is done
 * once into a ref below and feeds both `preferences` and `preferencesWarning`.
 */
export function usePreferences(): UsePreferencesResult {
  // Single mount-time storage read feeding both pieces of state. App.tsx used to call
  // loadUiPreferences() once per lazy initializer, reading storage twice for one snapshot.
  const initialLoadRef = useRef<ReturnType<typeof loadUiPreferences> | null>(null);
  if (!initialLoadRef.current) {
    initialLoadRef.current = loadUiPreferences();
  }
  const [preferences, setPreferences] = useState<UiPreferences>(() => {
    const loaded = initialLoadRef.current!.preferences;
    return {
      ...loaded,
      notifications:
        loaded.notifications ?? { ...DEFAULT_NOTIFICATION_PREFERENCES },
    };
  });
  const [preferencesWarning, setPreferencesWarning] = useState<string | null>(
    () => initialLoadRef.current!.warning ?? null
  );

  // Synchronize document language whenever language preference changes
  useEffect(() => {
    setDocumentLanguage(preferences.language);
  }, [preferences.language]);

  // Synchronize theme and subscribe to system changes when in 'system' mode
  useEffect(() => {
    const resolved = resolveTheme(preferences.theme);
    applyTheme(resolved);

    if (preferences.theme === 'system') {
      const unwatch = watchSystemTheme((systemTheme) => {
        applyTheme(systemTheme);
      });
      return unwatch;
    }
  }, [preferences.theme]);

  // Synchronize custom text and label colors with document CSS variables
  useEffect(() => {
    if (preferences.customTextColor) {
      document.documentElement.style.setProperty('--fg-default', preferences.customTextColor);
      document.documentElement.style.setProperty('--text-primary', preferences.customTextColor);
    } else {
      document.documentElement.style.removeProperty('--fg-default');
      document.documentElement.style.removeProperty('--text-primary');
    }

    if (preferences.customLabelColor) {
      const lbl = preferences.customLabelColor;
      document.documentElement.style.setProperty('--activity-badge-fg', lbl);
      document.documentElement.style.setProperty('--activity-badge-border', hexToRgba(lbl, 0.35));
      document.documentElement.style.setProperty('--activity-badge-bg', hexToRgba(lbl, 0.12));
      document.documentElement.style.setProperty('--md-inline-code-fg', lbl);
      document.documentElement.style.setProperty('--md-inline-code-border', hexToRgba(lbl, 0.25));
      document.documentElement.style.setProperty('--tag-color', lbl);
      document.documentElement.style.setProperty('--syntax-keyword', lbl);
    } else {
      document.documentElement.style.removeProperty('--activity-badge-fg');
      document.documentElement.style.removeProperty('--activity-badge-border');
      document.documentElement.style.removeProperty('--activity-badge-bg');
      document.documentElement.style.removeProperty('--md-inline-code-fg');
      document.documentElement.style.removeProperty('--md-inline-code-border');
      document.documentElement.style.removeProperty('--tag-color');
      document.documentElement.style.removeProperty('--syntax-keyword');
    }
  }, [preferences.customTextColor, preferences.customLabelColor, preferences.theme]);

  // Synchronize custom background areas (colors & opacities) with document CSS variables
  useEffect(() => {
    const bg = preferences.customBackground;
    if (!bg) {
      document.documentElement.style.removeProperty('--bg-canvas');
      document.documentElement.style.removeProperty('--bg-surface');
      document.documentElement.style.removeProperty('--bg-subtle');
      document.documentElement.style.removeProperty('--bg-chat-viewport');
      document.documentElement.style.removeProperty('--bg-prompt');
      document.documentElement.style.removeProperty('--bg-input');
      document.documentElement.style.removeProperty('--bg-elevated');
      document.documentElement.style.removeProperty('--activity-card-bg');
      document.documentElement.style.removeProperty('--bg-user-bubble');
      return;
    }

    // 1. Canvas / Global Background
    if (bg.canvas) {
      if (bg.canvas.opacity === 0) {
        document.documentElement.style.setProperty('--bg-canvas', 'transparent');
      } else if (bg.canvas.color) {
        document.documentElement.style.setProperty(
          '--bg-canvas',
          hexToRgba(bg.canvas.color, bg.canvas.opacity)
        );
      }
    } else if (bg.image?.enabled && bg.image?.url) {
      // Default to transparent when a background image is enabled so it shows through
      document.documentElement.style.setProperty('--bg-canvas', 'transparent');
    } else {
      document.documentElement.style.removeProperty('--bg-canvas');
    }

    // 2. Sidebar / Dock
    if (bg.sidebar) {
      if (bg.sidebar.opacity === 0) {
        document.documentElement.style.setProperty('--bg-surface', 'transparent');
        document.documentElement.style.setProperty('--bg-subtle', 'transparent');
      } else if (bg.sidebar.color) {
        document.documentElement.style.setProperty(
          '--bg-surface',
          hexToRgba(bg.sidebar.color, bg.sidebar.opacity)
        );
        document.documentElement.style.setProperty(
          '--bg-subtle',
          hexToRgba(bg.sidebar.color, Math.min(1, bg.sidebar.opacity + 0.08))
        );
      }
    } else {
      document.documentElement.style.removeProperty('--bg-surface');
      document.documentElement.style.removeProperty('--bg-subtle');
    }

    // 3. Chat Viewport (Fondo Principal donde se muestran las respuestas)
    if (bg.chat) {
      if (bg.chat.opacity === 0) {
        document.documentElement.style.setProperty('--bg-chat-viewport', 'transparent');
      } else if (bg.chat.color) {
        document.documentElement.style.setProperty(
          '--bg-chat-viewport',
          hexToRgba(bg.chat.color, bg.chat.opacity)
        );
      }
    } else if (bg.image?.enabled && bg.image?.url) {
      // Default to transparent when a background image is enabled so chat responses show on the wallpaper
      document.documentElement.style.setProperty('--bg-chat-viewport', 'transparent');
    } else {
      document.documentElement.style.removeProperty('--bg-chat-viewport');
    }

    // 4. Prompt Area (Zona del Prompt y Entrada)
    if (bg.prompt) {
      if (bg.prompt.opacity === 0) {
        document.documentElement.style.setProperty('--bg-prompt', 'transparent');
        document.documentElement.style.setProperty('--bg-input', 'rgba(0, 0, 0, 0.25)');
      } else if (bg.prompt.color) {
        document.documentElement.style.setProperty(
          '--bg-prompt',
          hexToRgba(bg.prompt.color, bg.prompt.opacity)
        );
        document.documentElement.style.setProperty(
          '--bg-input',
          hexToRgba(bg.prompt.color, Math.min(1, bg.prompt.opacity * 0.9))
        );
      }
    } else if (bg.image?.enabled && bg.image?.url) {
      // Default to translucent so the wallpaper flows down behind the prompt bar
      document.documentElement.style.setProperty('--bg-prompt', 'rgba(10, 10, 10, 0.55)');
      document.documentElement.style.setProperty('--bg-input', 'rgba(0, 0, 0, 0.35)');
    } else {
      document.documentElement.style.removeProperty('--bg-prompt');
      document.documentElement.style.removeProperty('--bg-input');
    }

    // 5. Cards & Bubbles
    if (bg.cards) {
      if (bg.cards.opacity === 0) {
        document.documentElement.style.setProperty('--bg-elevated', 'transparent');
        document.documentElement.style.setProperty('--activity-card-bg', 'transparent');
        document.documentElement.style.setProperty('--bg-user-bubble', 'transparent');
      } else if (bg.cards.color) {
        document.documentElement.style.setProperty(
          '--bg-elevated',
          hexToRgba(bg.cards.color, bg.cards.opacity)
        );
        document.documentElement.style.setProperty(
          '--activity-card-bg',
          hexToRgba(bg.cards.color, bg.cards.opacity)
        );
        document.documentElement.style.setProperty(
          '--bg-user-bubble',
          hexToRgba(bg.cards.color, bg.cards.opacity)
        );
      }
    } else {
      document.documentElement.style.removeProperty('--bg-elevated');
      document.documentElement.style.removeProperty('--activity-card-bg');
      document.documentElement.style.removeProperty('--bg-user-bubble');
    }
  }, [preferences.customBackground, preferences.theme]);

  // Preferences controller encapsulating immediate UI preferences logic
  const preferencesRef = useRef<UiPreferences>(preferences);
  preferencesRef.current = preferences;

  const preferencesControllerRef = useRef<PreferencesController | null>(null);
  if (!preferencesControllerRef.current) {
    preferencesControllerRef.current = new PreferencesController({
      getPreferences: () => preferencesRef.current,
      setPreferences: (updated) => setPreferences(updated),
      setWarning: (warning) => setPreferencesWarning(warning),
    });
  }

  // Immediate preferences updates without reconnecting Pi or resetting chat state
  const handleThemeChange = (newTheme: AppTheme) => {
    preferencesControllerRef.current?.setTheme(newTheme);
  };

  const handleLanguageChange = (newLanguage: SupportedLocale) => {
    preferencesControllerRef.current?.setLanguage(newLanguage);
  };

  const handleWorkAnimationChange = (newAnimation: WorkAnimationPreferences) => {
    preferencesControllerRef.current?.setWorkAnimation(newAnimation);
  };

  const handleCustomThemeColorsChange = (colors: { text?: string | null; label?: string | null }) => {
    preferencesControllerRef.current?.setCustomThemeColors(colors);
  };

  const handleCustomBackgroundChange = (newBg: CustomBackgroundPreferences | null) => {
    preferencesControllerRef.current?.setCustomBackground(newBg);
  };

  const setNotifications = (partial: Partial<NotificationPreferences>) => {
    preferencesControllerRef.current?.setNotifications(partial);
  };

  const setCustomCommands = (commands: CustomCommand[]) => {
    preferencesControllerRef.current?.setCustomCommands(commands);
  };

  const setHiddenCommandIds = (ids: string[]) => {
    preferencesControllerRef.current?.setHiddenCommandIds(ids);
  };

  const dismissPreferencesWarning = () => {
    setPreferencesWarning(null);
  };

  // Localized string resolver bound to current language
  const t = (key: TranslationKey, params?: Record<string, string | number>): string =>
    translate(preferences.language, key, params);

  return {
    preferences,
    preferencesWarning,
    dismissPreferencesWarning,
    handleThemeChange,
    handleLanguageChange,
    handleWorkAnimationChange,
    handleCustomThemeColorsChange,
    handleCustomBackgroundChange,
    setNotifications,
    setCustomCommands,
    setHiddenCommandIds,
    t,
  };
}
