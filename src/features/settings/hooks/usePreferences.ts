import { useEffect, useRef, useState } from 'react';
import {
  loadUiPreferences,
  PreferencesController,
  type UiPreferences,
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
    setNotifications,
    setCustomCommands,
    setHiddenCommandIds,
    t,
  };
}
