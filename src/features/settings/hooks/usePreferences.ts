import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractAppearancePreferences,
  loadUiPreferences,
  PreferencesController,
  type AppearanceInput,
  type PreferencesSaveResult,
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
import type { AppTheme } from '@shared/theme';
import { AppearanceLifecycleController } from '@features/settings/appearance';

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
  /** Atomically commits candidate appearance preferences. */
  commitAppearance: (candidate: AppearanceInput) => PreferencesSaveResult;
  /** Atomically resets appearance customizations back to defaults. */
  resetAppearance: () => PreferencesSaveResult;
  /** Production lifecycle controller managing DOM appearance, system listeners, and draft preview. */
  appearanceController: AppearanceLifecycleController;
  appearanceControllerRef: React.MutableRefObject<AppearanceLifecycleController | null>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/**
 * Owns UI preferences (language & visual appearance), separate from connection settings.
 * Single owner for DOM appearance application and media-query system scheme listening
 * via AppearanceLifecycleController.
 */
export function usePreferences(): UsePreferencesResult {
  // Single mount-time storage read feeding both pieces of state.
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

  // Synchronous preferences ref for live reads without waiting on React re-render cycles.
  // Updated synchronously inside setPreferences callback to eliminate stale consecutive mutations.
  const preferencesRef = useRef<UiPreferences>(preferences);
  preferencesRef.current = preferences;

  const preferencesControllerRef = useRef<PreferencesController | null>(null);
  if (!preferencesControllerRef.current) {
    preferencesControllerRef.current = new PreferencesController({
      getPreferences: () => preferencesRef.current,
      setPreferences: (updated) => {
        preferencesRef.current = updated;
        setPreferences(updated);
      },
      setWarning: (warning) => setPreferencesWarning(warning),
    });
  }

  // Central appearance lifecycle controller:
  // Pure constructor; effect-owned activation and single ownership of DOM/system watcher.
  const appearanceControllerRef = useRef<AppearanceLifecycleController | null>(null);
  if (!appearanceControllerRef.current) {
    appearanceControllerRef.current = new AppearanceLifecycleController({
      getSavedAppearance: () => extractAppearancePreferences(preferencesRef.current),
      commitAppearance: (candidate) => preferencesControllerRef.current!.commitAppearance(candidate),
      resetAppearance: () => preferencesControllerRef.current!.resetAppearance(),
    });
  }

  // Effect-owned start/stop lifecycle: StrictMode-safe activation and teardown
  useEffect(() => {
    const controller = appearanceControllerRef.current;
    if (!controller) return;

    controller.start();

    return () => {
      controller.stop();
    };
  }, []);

  // Synchronize saved appearance whenever persisted preferences change.
  // Controller protects any active draft preview from being overwritten.
  useEffect(() => {
    appearanceControllerRef.current?.setSavedAppearance(
      extractAppearancePreferences(preferences)
    );
  }, [
    preferences.theme,
    preferences.customAccent,
    preferences.customTextColor,
    preferences.customLabelColor,
    preferences.workAnimation,
    preferences.customBackground,
  ]);

  // Immediate preferences updates without reconnecting Pi or resetting chat state
  const handleThemeChange = useCallback((newTheme: AppTheme) => {
    preferencesControllerRef.current?.setTheme(newTheme);
  }, []);

  const handleLanguageChange = useCallback((newLanguage: SupportedLocale) => {
    preferencesControllerRef.current?.setLanguage(newLanguage);
  }, []);

  const setNotifications = useCallback((partial: Partial<NotificationPreferences>) => {
    preferencesControllerRef.current?.setNotifications(partial);
  }, []);

  const setCustomCommands = useCallback((commands: CustomCommand[]) => {
    preferencesControllerRef.current?.setCustomCommands(commands);
  }, []);

  const setHiddenCommandIds = useCallback((ids: string[]) => {
    preferencesControllerRef.current?.setHiddenCommandIds(ids);
  }, []);

  const commitAppearance = useCallback((candidate: AppearanceInput): PreferencesSaveResult => {
    return (
      preferencesControllerRef.current?.commitAppearance(candidate) ?? {
        success: false,
        error: 'Preferences controller not initialized',
      }
    );
  }, []);

  const resetAppearance = useCallback((): PreferencesSaveResult => {
    return (
      preferencesControllerRef.current?.resetAppearance() ?? {
        success: false,
        error: 'Preferences controller not initialized',
      }
    );
  }, []);

  const dismissPreferencesWarning = useCallback(() => {
    setPreferencesWarning(null);
  }, []);

  // Localized string resolver bound to current language
  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string =>
      translate(preferences.language, key, params),
    [preferences.language]
  );

  return {
    preferences,
    preferencesWarning,
    dismissPreferencesWarning,
    handleThemeChange,
    handleLanguageChange,
    setNotifications,
    setCustomCommands,
    setHiddenCommandIds,
    commitAppearance,
    resetAppearance,
    appearanceController: appearanceControllerRef.current,
    appearanceControllerRef,
    t,
  };
}
