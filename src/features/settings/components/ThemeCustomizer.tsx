import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppTheme } from '@shared/theme';
import type { TranslationKey } from '@shared/i18n';
import type {
  BackgroundImageConfig,
  CustomBackgroundPreferences,
  PreferencesSaveResult,
  WorkAnimationPreferences,
} from '@infra/preferences';
import { DEFAULT_BACKGROUND_IMAGE_CONFIG } from '@infra/preferences';
import { AppearanceLifecycleController } from '@features/settings/appearance';
import { useAppearanceDraft } from '@features/settings/hooks/useAppearanceDraft';
import { ConfirmationCard } from './appearance/ConfirmationCard';
import { PresetGallery } from './appearance/PresetGallery';
import { ColorOverrides } from './appearance/ColorOverrides';
import {
  AreaTransparencySection,
  type BackgroundAreaKey,
} from './appearance/AreaTransparencySection';
import { WorkAnimationSection } from './appearance/WorkAnimationSection';
import { WallpaperSection } from './appearance/WallpaperSection';
import { PreviewSandbox } from './appearance/PreviewSandbox';
import { findPresetDefinition, resolvePresetPalette } from './appearance/presetData';
import {
  WallpaperProcessCoordinator,
  type WallpaperBrowserAdapter,
} from '@features/settings/wallpaper';

export interface ThemeCustomizerProps {
  controller?: AppearanceLifecycleController | null;
  currentTheme?: AppTheme;
  onThemeChange?: (theme: AppTheme) => void;
  workAnimation?: WorkAnimationPreferences;
  onWorkAnimationChange?: (animation: WorkAnimationPreferences) => void;
  customTextColor?: string | null;
  customLabelColor?: string | null;
  onCustomThemeColorsChange?: (colors: { text?: string | null; label?: string | null }) => void;
  customBackground?: CustomBackgroundPreferences | null;
  onCustomBackgroundChange?: (bg: CustomBackgroundPreferences | null) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  idPrefix?: string;
  wallpaperAdapter?: WallpaperBrowserAdapter;
  wallpaperCoordinator?: WallpaperProcessCoordinator;
}

export interface ThemeCustomizerActionAdapter {
  selectPreset: (theme: AppTheme) => void;
  setAccentColor: (hex: string | null) => void;
  setTextColor: (hex: string | null) => void;
  setLabelColor: (hex: string | null) => void;
  updateAreaOpacity: (area: BackgroundAreaKey, opacity: number) => void;
  updateAreaColor: (area: BackgroundAreaKey, color: string) => void;
  resetArea: (area: BackgroundAreaKey) => void;
  setAnimation: (anim: WorkAnimationPreferences) => void;
  updateWallpaper: (patch: Partial<BackgroundImageConfig>) => void;
  clearWallpaper: () => void;
  confirm: () => PreferencesSaveResult;
  cancel: () => void;
  resetAppearance: () => PreferencesSaveResult;
}

/**
 * Pure UI action adapter for ThemeCustomizer.
 * Encapsulates all user interaction operations delegating directly to the controller
 * without intermediate local state desync or premature storage writes.
 */
export function createThemeCustomizerActions(
  controller: AppearanceLifecycleController,
  coordinator?: WallpaperProcessCoordinator
): ThemeCustomizerActionAdapter {
  return {
    selectPreset: (theme: AppTheme) => {
      coordinator?.cancel();
      controller.update({ theme });
    },
    setAccentColor: (hex: string | null) => {
      controller.update({ customAccent: hex });
    },
    setTextColor: (hex: string | null) => {
      controller.update({ customTextColor: hex });
    },
    setLabelColor: (hex: string | null) => {
      controller.update({ customLabelColor: hex });
    },
    updateAreaOpacity: (area: BackgroundAreaKey, opacity: number) => {
      const currentBg = controller.getEffectiveAppearance().customBackground ?? {};
      const currentArea = currentBg[area] ?? { opacity: 1 };
      controller.update({
        customBackground: {
          ...currentBg,
          [area]: { ...currentArea, opacity },
        },
      });
    },
    updateAreaColor: (area: BackgroundAreaKey, color: string) => {
      const currentBg = controller.getEffectiveAppearance().customBackground ?? {};
      const currentArea = currentBg[area] ?? { opacity: 1 };
      controller.update({
        customBackground: {
          ...currentBg,
          [area]: { ...currentArea, color },
        },
      });
    },
    resetArea: (area: BackgroundAreaKey) => {
      const currentBg = { ...(controller.getEffectiveAppearance().customBackground ?? {}) };
      delete currentBg[area];
      controller.update({
        customBackground: Object.keys(currentBg).length > 0 ? currentBg : null,
      });
    },
    setAnimation: (anim: WorkAnimationPreferences) => {
      controller.update({ workAnimation: anim });
    },
    updateWallpaper: (patch: Partial<BackgroundImageConfig>) => {
      const currentBg = controller.getEffectiveAppearance().customBackground ?? {};
      const currentImage = currentBg.image ?? { ...DEFAULT_BACKGROUND_IMAGE_CONFIG };
      controller.update({
        customBackground: {
          ...currentBg,
          image: {
            ...currentImage,
            ...patch,
          },
        },
      });
    },
    clearWallpaper: () => {
      coordinator?.cancel();
      const currentBg = controller.getEffectiveAppearance().customBackground ?? {};
      const currentImage = currentBg.image ?? { ...DEFAULT_BACKGROUND_IMAGE_CONFIG };
      controller.update({
        customBackground: {
          ...currentBg,
          image: {
            ...currentImage,
            url: '',
          },
        },
      });
    },
    confirm: () => {
      // Synchronously cancel in-flight wallpaper processing before atomic commit
      coordinator?.cancel();
      return controller.confirm();
    },
    cancel: () => {
      coordinator?.cancel();
      controller.cancel();
    },
    resetAppearance: () => {
      coordinator?.cancel();
      return controller.resetAppearance();
    },
  };
}

export const ThemeCustomizer: React.FC<ThemeCustomizerProps> = ({
  controller,
  t,
  idPrefix = 'theme-customizer',
  wallpaperAdapter,
  wallpaperCoordinator,
}) => {
  const draft = useAppearanceDraft(controller ?? undefined);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [lifecycleRevision, setLifecycleRevision] = useState(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localCoordinatorRef = useRef<WallpaperProcessCoordinator | null>(null);
  if (!localCoordinatorRef.current) {
    localCoordinatorRef.current = new WallpaperProcessCoordinator();
  }
  const activeCoordinator = wallpaperCoordinator || localCoordinatorRef.current;

  const actions = useMemo(
    () => createThemeCustomizerActions(draft.controller, activeCoordinator),
    [draft.controller, activeCoordinator]
  );

  // Initialize draft session on mount or when controller reference changes.
  // Never re-begins automatically on confirm or cancel.
  useEffect(() => {
    if (controller && !controller.getState().isDrafting) {
      controller.begin();
      setLifecycleRevision((r) => r + 1);
    }
  }, [controller]);

  // Clean up any feedback timers or in-flight wallpaper processing on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      activeCoordinator.cancel();
    };
  }, [activeCoordinator]);

  const activeTheme =
    draft.draft?.theme ?? draft.effectiveAppearance.theme ?? draft.saved.theme ?? 'dark';
  const savedTheme = draft.saved.theme ?? 'dark';

  const activePreset = useMemo(
    () => findPresetDefinition(activeTheme),
    [activeTheme]
  );
  const activePresetPalette = useMemo(
    () => resolvePresetPalette(activeTheme, draft.systemPreferred),
    [activeTheme, draft.systemPreferred]
  );
  const activeThemeName = t(activePreset.nameKey);

  const handleSelectPreset = useCallback(
    (presetId: AppTheme) => {
      actions.selectPreset(presetId);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleAccentChange = useCallback(
    (hex: string | null) => {
      actions.setAccentColor(hex);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleTextColorChange = useCallback(
    (hex: string | null) => {
      actions.setTextColor(hex);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleLabelColorChange = useCallback(
    (hex: string | null) => {
      actions.setLabelColor(hex);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleUpdateAreaOpacity = useCallback(
    (area: BackgroundAreaKey, opacity: number) => {
      actions.updateAreaOpacity(area, opacity);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleUpdateAreaColor = useCallback(
    (area: BackgroundAreaKey, color: string) => {
      actions.updateAreaColor(area, color);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleResetArea = useCallback(
    (area: BackgroundAreaKey) => {
      actions.resetArea(area);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleChangeAnimation = useCallback(
    (anim: WorkAnimationPreferences) => {
      actions.setAnimation(anim);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleUpdateWallpaper = useCallback(
    (patch: Partial<BackgroundImageConfig>) => {
      actions.updateWallpaper(patch);
      setSaveFeedback(false);
    },
    [actions]
  );

  const handleClearWallpaper = useCallback(() => {
    actions.clearWallpaper();
    setSaveFeedback(false);
  }, [actions]);

  const handleConfirm = useCallback(() => {
    const result = actions.confirm();
    setLifecycleRevision((r) => r + 1);
    if (result.success) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveFeedback(true);
      saveTimerRef.current = setTimeout(() => setSaveFeedback(false), 3000);
    }
  }, [actions]);

  const handleCancel = useCallback(() => {
    actions.cancel();
    setLifecycleRevision((r) => r + 1);
    setSaveFeedback(false);
  }, [actions]);

  const handleResetAppearance = useCallback(() => {
    const result = actions.resetAppearance();
    setLifecycleRevision((r) => r + 1);
    if (result.success) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveFeedback(true);
      saveTimerRef.current = setTimeout(() => setSaveFeedback(false), 3000);
    }
  }, [actions]);

  return (
    <div className="theme-customizer-container">
      {/* Header Info */}
      <div className="theme-customizer-header">
        <h2 className="theme-customizer-title">{t('theme.customizer_title')}</h2>
        <p className="theme-customizer-subtitle">{t('theme.customizer_subtitle')}</p>
      </div>

      {/* Confirmation Module */}
      <ConfirmationCard
        isDirty={draft.isDirty}
        isDrafting={draft.isDrafting}
        activeThemeName={activeThemeName}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onResetAppearance={handleResetAppearance}
        error={draft.error}
        saveFeedback={saveFeedback}
        t={t}
        idPrefix={idPrefix}
      />

      {/* Preset Gallery */}
      <PresetGallery
        activeTheme={activeTheme}
        savedTheme={savedTheme}
        onSelectPreset={handleSelectPreset}
        t={t}
        idPrefix={idPrefix}
      />

      {/* Accent, Text, and Label Color Overrides */}
      <ColorOverrides
        accentColor={draft.effectiveAppearance.customAccent}
        textColor={draft.effectiveAppearance.customTextColor}
        labelColor={draft.effectiveAppearance.customLabelColor}
        defaultAccent={activePresetPalette.accent}
        defaultText={activePresetPalette.text}
        defaultLabel={activePresetPalette.accent}
        onAccentChange={handleAccentChange}
        onTextColorChange={handleTextColorChange}
        onLabelColorChange={handleLabelColorChange}
        t={t}
        idPrefix={idPrefix}
      />

      {/* Area Transparency and Colors */}
      <AreaTransparencySection
        backgroundConfig={draft.effectiveAppearance.customBackground ?? undefined}
        activePresetPalette={activePresetPalette}
        onUpdateAreaOpacity={handleUpdateAreaOpacity}
        onUpdateAreaColor={handleUpdateAreaColor}
        onResetArea={handleResetArea}
        t={t}
        idPrefix={idPrefix}
      />

      {/* Work Animation */}
      <WorkAnimationSection
        animationConfig={draft.effectiveAppearance.workAnimation}
        onChangeAnimation={handleChangeAnimation}
        t={t}
        idPrefix={idPrefix}
      />

      {/* Modular Translated Accessible Wallpaper Section */}
      <WallpaperSection
        imageConfig={draft.effectiveAppearance.customBackground?.image}
        onUpdateImage={handleUpdateWallpaper}
        onClearImage={handleClearWallpaper}
        t={t}
        idPrefix={idPrefix}
        adapter={wallpaperAdapter}
        coordinator={activeCoordinator}
        lifecycleRevision={lifecycleRevision}
      />

      {/* Live Preview Sandbox */}
      <PreviewSandbox
        effectiveAppearance={draft.effectiveAppearance}
        t={t}
      />
    </div>
  );
};
