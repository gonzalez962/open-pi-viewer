import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ThemeCustomizer,
  createThemeCustomizerActions,
} from '@features/settings/components/ThemeCustomizer';
import { ConfirmationCard } from '@features/settings/components/appearance/ConfirmationCard';
import { PresetGallery } from '@features/settings/components/appearance/PresetGallery';
import { ColorOverrides } from '@features/settings/components/appearance/ColorOverrides';
import { AreaTransparencySection } from '@features/settings/components/appearance/AreaTransparencySection';
import { WorkAnimationSection } from '@features/settings/components/appearance/WorkAnimationSection';
import { WallpaperSection } from '@features/settings/components/appearance/WallpaperSection';
import { PreviewSandbox } from '@features/settings/components/appearance/PreviewSandbox';
import {
  WallpaperProcessCoordinator,
  WallpaperProcessingError,
  mapWallpaperErrorToTranslationKey,
} from '@features/settings/wallpaper';
import { AppearanceLifecycleController } from '@features/settings/appearance';
import {
  PreferencesController,
  loadUiPreferences,
  extractAppearancePreferences,
  type AppearancePreferences,
} from '@infra/preferences';
import { translate } from '@shared/i18n';

const tEn = (key: any, params?: any) => translate('en', key, params);
const tEs = (key: any, params?: any) => translate('es', key, params);

test('ThemeCustomizer: renders full customizer structure with modular sections and accessibility attributes', () => {
  let savedState: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#00e5ff',
  };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => savedState,
    commitAppearance: (c) => {
      savedState = { ...savedState, ...c } as AppearancePreferences;
      return { success: true };
    },
    resetAppearance: () => {
      savedState = { theme: 'dark' };
      return { success: true };
    },
  });

  const html = renderToStaticMarkup(
    React.createElement(ThemeCustomizer, {
      controller,
      t: tEn,
    })
  );

  // Customizer heading & subtitle
  assert.match(html, /Theme Customizer/);
  assert.match(html, /Select a color theme, preview changes in real time/);

  // Confirmation card module
  assert.match(html, /Theme Confirmation Module/);
  assert.match(html, /Confirm and Apply Theme/);

  // Preset gallery radiogroup
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /Choose from curated high-contrast/);
  assert.match(html, /DjRomoro/);
  assert.match(html, /Arch Electric/);
  assert.match(html, /Gentleman Sexy/);
  assert.match(html, /Minimalist Ninja/);

  // Accent, text and label color sections
  assert.match(html, /Accent Color Override/);
  assert.match(html, /Text Color/);
  assert.match(html, /Labels &amp; Tags Color/);

  // Area transparency section
  assert.match(html, /Background &amp; Transparency per Area/);
  assert.match(html, /Global Canvas/);
  assert.match(html, /Sidebars/);

  // Work animation section
  assert.match(html, /Work Loading Animation/);
  assert.match(html, /Multicolor/);

  // Wallpaper placeholder disabled for T5
  assert.match(html, /Background Image/);
  assert.match(html, /disabled/i);

  // Preview Sandbox
  assert.match(html, /Live Preview Sandbox/);
  assert.match(html, /sandbox-viewport/);
});

test('ThemeCustomizer: PresetGallery renders 7 presets with accessible radio roles and localized descriptions', () => {
  const html = renderToStaticMarkup(
    React.createElement(PresetGallery, {
      activeTheme: 'DjRomoro',
      savedTheme: 'dark',
      onSelectPreset: () => {},
      t: tEs,
    })
  );

  assert.match(html, /Colección de Temas/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /role="radio"/);
  // DjRomoro should be checked (aria-checked="true")
  assert.match(html, /aria-checked="true"[^>]*>[\s\S]*?DjRomoro/);
});

test('ThemeCustomizer: ConfirmationCard renders dirty state, confirm, cancel, and atomic reset with proper labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(ConfirmationCard, {
      isDirty: true,
      isDrafting: true,
      activeThemeName: 'Cyberpunk',
      onConfirm: () => {},
      onCancel: () => {},
      onResetAppearance: () => {},
      error: null,
      saveFeedback: false,
      t: tEn,
    })
  );

  assert.match(html, /Confirm and Apply Theme/);
  assert.match(html, /Reset to Previous Theme/);
  assert.match(html, /Reset appearance/i);
  assert.match(html, /Previewing \(Unsaved\)/);
});

test('ThemeCustomizer: ColorOverrides renders scoped IDs and labels for color inputs', () => {
  const html = renderToStaticMarkup(
    React.createElement(ColorOverrides, {
      accentColor: '#00e5ff',
      textColor: '#ffffff',
      labelColor: '#10b981',
      defaultAccent: '#1f6feb',
      defaultText: '#e6edf3',
      defaultLabel: '#10b981',
      onAccentChange: () => {},
      onTextColorChange: () => {},
      onLabelColorChange: () => {},
      t: tEn,
      idPrefix: 'customizer-test',
    })
  );

  assert.match(html, /id="customizer-test-accent-picker"/);
  assert.match(html, /for="customizer-test-accent-picker"/);
  assert.match(html, /id="customizer-test-text-picker"/);
  assert.match(html, /for="customizer-test-text-picker"/);
  assert.match(html, /id="customizer-test-label-picker"/);
  assert.match(html, /for="customizer-test-label-picker"/);
});

test('ThemeCustomizer: AreaTransparencySection renders area selector buttons and range inputs', () => {
  const html = renderToStaticMarkup(
    React.createElement(AreaTransparencySection, {
      backgroundConfig: {
        canvas: { color: '#000000', opacity: 0.5 },
      },
      activePresetPalette: {
        bg: '#05080d',
        surface: '#07131d',
        border: '#245066',
        accent: '#00e5ff',
        text: '#e6f7ff',
      },
      onUpdateAreaOpacity: () => {},
      onUpdateAreaColor: () => {},
      onResetArea: () => {},
      t: tEn,
    })
  );

  assert.match(html, /Global Canvas/);
  assert.match(html, /Background Opacity/);
  assert.match(html, /type="range"/);
});

test('ThemeCustomizer: WorkAnimationSection renders mode pills and preview loader', () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkAnimationSection, {
      animationConfig: {
        mode: 'dual',
        color1: '#00e5ff',
        color2: '#ff007f',
      },
      onChangeAnimation: () => {},
      t: tEn,
    })
  );

  assert.match(html, /prompt-degraciao-loader is-mode-dual/);
  assert.match(html, /Working/);
  assert.match(html, /Two Colors/);
});

test('ThemeCustomizer: WallpaperSection renders accessible controls, inputs, presets, and fit modes', () => {
  const html = renderToStaticMarkup(
    React.createElement(WallpaperSection, {
      imageConfig: {
        enabled: true,
        url: 'https://example.com/custom.jpg',
        fit: 'repeat',
        position: 'center',
        repeat: true,
        opacity: 0.65,
        blur: 10,
      },
      onUpdateImage: () => {},
      onClearImage: () => {},
      t: tEn,
    })
  );

  // Section heading & active badge
  assert.match(html, /Background Image/);
  assert.match(html, /Active/);

  // Accessible inputs
  assert.match(html, /<input[^>]*type="checkbox"/);
  assert.match(html, /<input[^>]*type="file"/);
  assert.match(html, /<input[^>]*type="text"/);
  assert.match(html, /Apply URL/);
  assert.match(html, /Upload from device/);
  assert.match(html, /Remove Image/);

  // Bundled presets
  assert.match(html, /Minimalist Ninja \(1080p\)/);
  assert.match(html, /Minimalist Ninja \(Original\)/);

  // Remote warning notice
  assert.match(html, /Remote images contact an external host/);

  // Fit & Position radiogroups
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /Repeat Tile/);
  assert.match(html, /Cover/);
  assert.match(html, /Center/);

  // Sliders
  assert.match(html, /<input[^>]*type="range"/);
  assert.match(html, /65%/);
  assert.match(html, /10px/);
});

test('ThemeCustomizer: action adapter handles wallpaper updates, clearance, live preview, and atomic confirmation', () => {
  let savedState: AppearancePreferences = {
    theme: 'dark',
    customBackground: null,
  };
  let commitCalls = 0;

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => savedState,
    commitAppearance: (c) => {
      commitCalls++;
      savedState = { ...savedState, ...c } as AppearancePreferences;
      return { success: true };
    },
    resetAppearance: () => {
      savedState = { theme: 'dark' };
      return { success: true };
    },
  });

  const actions = createThemeCustomizerActions(controller);

  // 1. Begin draft
  controller.begin();
  assert.equal(commitCalls, 0);

  // 2. Update wallpaper via UI adapter
  actions.updateWallpaper({
    enabled: true,
    url: '/wallpapers/minimalist-ninja-1080p.jpg',
    fit: 'repeat',
    position: 'center',
    opacity: 0.5,
  });

  assert.equal(commitCalls, 0, 'Updating wallpaper must not commit early');
  assert.equal(controller.getState().isDirty, true);
  assert.equal(
    controller.getState().effectiveAppearance.customBackground?.image?.url,
    '/wallpapers/minimalist-ninja-1080p.jpg'
  );
  assert.equal(
    controller.getState().effectiveAppearance.customBackground?.image?.fit,
    'repeat'
  );

  // 3. Clear wallpaper via UI adapter
  actions.clearWallpaper();
  assert.equal(commitCalls, 0);
  assert.equal(
    controller.getState().effectiveAppearance.customBackground?.image?.url,
    ''
  );

  // 4. Cancel reverts to saved state (null background)
  actions.cancel();
  assert.equal(commitCalls, 0);
  assert.equal(controller.getState().effectiveAppearance.customBackground, null);

  // 5. Update and confirm persists atomically
  controller.begin();
  actions.updateWallpaper({
    enabled: true,
    url: '/wallpapers/minimalist-ninja-1080p.jpg',
    fit: 'cover',
  });
  const res = actions.confirm();
  assert.equal(res.success, true);
  assert.equal(commitCalls, 1);
  assert.equal(
    savedState.customBackground?.image?.url,
    '/wallpapers/minimalist-ninja-1080p.jpg'
  );
});

test('ThemeCustomizer: UI action adapter synchronously cancels pending upload on confirm, cancel, reset, and preset', () => {
  let savedState: AppearancePreferences = { theme: 'dark', customBackground: null };
  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => savedState,
    commitAppearance: (c) => {
      savedState = { ...savedState, ...c } as AppearancePreferences;
      return { success: true };
    },
    resetAppearance: () => {
      savedState = { theme: 'dark' };
      return { success: true };
    },
  });

  const coordinator = new WallpaperProcessCoordinator();
  const actions = createThemeCustomizerActions(controller, coordinator);

  controller.begin();

  // Test 1: Preset switch cancels in-flight upload
  coordinator.start();
  assert.equal(coordinator.isProcessing(), true);
  actions.selectPreset('DjRomoro');
  assert.equal(coordinator.isProcessing(), false, 'Preset selection must cancel pending upload');

  // Test 2: Clear wallpaper cancels in-flight upload
  coordinator.start();
  assert.equal(coordinator.isProcessing(), true);
  actions.clearWallpaper();
  assert.equal(coordinator.isProcessing(), false, 'Clear wallpaper must cancel pending upload');

  // Test 3: Confirm cancels in-flight upload BEFORE commit
  coordinator.start();
  assert.equal(coordinator.isProcessing(), true);
  actions.confirm();
  assert.equal(coordinator.isProcessing(), false, 'Confirm must cancel pending upload before saving');

  // Test 4: Cancel cancels in-flight upload
  controller.begin();
  coordinator.start();
  assert.equal(coordinator.isProcessing(), true);
  actions.cancel();
  assert.equal(coordinator.isProcessing(), false, 'Cancel must cancel pending upload');

  // Test 5: Reset appearance cancels in-flight upload
  coordinator.start();
  assert.equal(coordinator.isProcessing(), true);
  actions.resetAppearance();
  assert.equal(coordinator.isProcessing(), false, 'Reset appearance must cancel pending upload');
});

test('ThemeCustomizer: localized error mapping prevents raw untranslated error messages at boundary', () => {
  const pixelError = new WallpaperProcessingError('pixel_limit_exceeded', 'Unsafe 24MP buffer in memory');
  const enKey = mapWallpaperErrorToTranslationKey(pixelError);
  const esKey = mapWallpaperErrorToTranslationKey(pixelError);

  const enText = tEn(enKey);
  const esText = tEs(esKey);

  assert.equal(enText, 'Image resolution exceeds 16 megapixels limit.');
  assert.equal(esText, 'La resolución de la imagen supera el límite de 16 megapíxeles.');
  assert.doesNotMatch(enText, /Unsafe 24MP buffer/);
  assert.doesNotMatch(esText, /Unsafe 24MP buffer/);
});

test('ThemeCustomizer: PreviewSandbox displays mock layout with syntax highlights and working loader', () => {
  const html = renderToStaticMarkup(
    React.createElement(PreviewSandbox, {
      effectiveAppearance: {
        theme: 'DjRomoro',
        customAccent: '#00e5ff',
        workAnimation: { mode: 'multicolor', color1: '#00e5ff', color2: '#ff007f' },
      },
      t: tEn,
    })
  );

  assert.match(html, /sandbox-header-mock/);
  assert.match(html, /sandbox-chat-area/);
  assert.match(html, /sandbox-code-card/);
  assert.match(html, /prompt-degraciao-loader/);
});

test('ThemeCustomizer: PreviewSandbox renders wallpaper layer with valid auto backgroundSize for repeat', () => {
  const html = renderToStaticMarkup(
    React.createElement(PreviewSandbox, {
      effectiveAppearance: {
        theme: 'DjRomoro',
        customBackground: {
          image: {
            enabled: true,
            url: '/wallpapers/minimalist-ninja-1080p.jpg',
            fit: 'repeat',
            position: 'center',
            repeat: true,
            opacity: 0.5,
            blur: 4,
          },
        },
      },
      t: tEn,
    })
  );

  assert.match(html, /app-custom-background-layer/);
  assert.match(html, /minimalist-ninja-1080p\.jpg/);
  assert.match(html, /background-size:auto/i);
  assert.match(html, /background-repeat:repeat/i);
});

test('ThemeCustomizer: controller delegation handles update, confirm, cancel, and resetAppearance without persisting early', () => {
  let savedState: AppearancePreferences = {
    theme: 'dark',
    customAccent: '#1f6feb',
  };
  let commitCalls = 0;
  let resetCalls = 0;

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => savedState,
    commitAppearance: (c) => {
      commitCalls++;
      savedState = { ...savedState, ...c } as AppearancePreferences;
      return { success: true };
    },
    resetAppearance: () => {
      resetCalls++;
      savedState = { theme: 'dark' };
      return { success: true };
    },
  });

  // Begin draft
  controller.begin();
  assert.equal(commitCalls, 0, 'Beginning draft must not persist');

  // Update theme to DjRomoro
  controller.update({ theme: 'DjRomoro' });
  assert.equal(commitCalls, 0, 'Updating draft theme must not persist');
  assert.equal(controller.getState().draft?.theme, 'DjRomoro');
  assert.equal(controller.getState().isDirty, true);

  // Update accent
  controller.update({ customAccent: '#00e5ff' });
  assert.equal(commitCalls, 0, 'Updating customAccent must not persist');
  assert.equal(controller.getState().draft?.customAccent, '#00e5ff');

  // Cancel discards
  controller.cancel();
  assert.equal(commitCalls, 0, 'Cancel must not persist');
  assert.equal(controller.getState().isDrafting, false);
  assert.equal(controller.getState().draft, null);
  assert.equal(controller.getState().effectiveAppearance.theme, 'dark');

  // Begin and confirm persists atomically
  controller.begin();
  controller.update({ theme: 'arch-electric' });
  const result = controller.confirm();
  assert.equal(result.success, true);
  assert.equal(commitCalls, 1, 'Confirm must call commitAppearance exactly once');
  assert.equal(savedState.theme, 'arch-electric');

  // Explicit atomic reset
  const resetResult = controller.resetAppearance();
  assert.equal(resetResult.success, true);
  assert.equal(resetCalls, 1, 'resetAppearance must call reset handler exactly once');
  assert.equal(savedState.theme, 'dark');
});

test('SettingsView: renders theme tab and customizer, and includes 7 presets in general tab dropdown', async () => {
  const { SettingsView } = await import('@features/settings/SettingsView');

  const sampleConfig = {
    nodePath: 'node',
    piEntrypoint: 'cli.js',
    workingDirectory: 'C:\\test',
    fileTreeRefreshInterval: 15,
  };

  const samplePrefs = {
    theme: 'dark' as const,
    language: 'en' as const,
  };

  // 1. General tab includes customizer shortcut button and renders selected theme
  const generalHtml = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: { ...samplePrefs, theme: 'DjRomoro' },
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      initialTab: 'general',
      t: tEn,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(generalHtml, /DjRomoro/);
  assert.match(generalHtml, /🎨 Theme Customizer →/);

  // 2. Theme tab renders the ThemeCustomizer container
  const themeTabHtml = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: samplePrefs,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      initialTab: 'theme',
      t: tEn,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(themeTabHtml, /theme-customizer-container/);
  assert.match(themeTabHtml, /Theme Confirmation Module/);
});

test('ThemeCustomizer: renders cleanly in Spanish without untranslated keys', () => {
  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => ({ theme: 'dark' }),
    commitAppearance: () => ({ success: true }),
    resetAppearance: () => ({ success: true }),
  });

  const html = renderToStaticMarkup(
    React.createElement(ThemeCustomizer, {
      controller,
      t: tEs,
    })
  );

  assert.match(html, /Personalizador de Temas/);
  assert.match(html, /Colección de Temas/);
  assert.match(html, /Módulo de Confirmación de Tema/);
  assert.match(html, /Color de Acento Primario/);
  assert.match(html, /Color del Texto/);
  assert.match(html, /Color de las Etiquetas/);
  assert.match(html, /Fondo y Transparencia por Área/);
  assert.match(html, /Animación de Carga/);
  assert.match(html, /Módulo de Vista Previa en Vivo/);
  assert.doesNotMatch(html, /theme\.[a-z_]+/);
});

test('ConfirmationCard: displays error banner when error is present', () => {
  const html = renderToStaticMarkup(
    React.createElement(ConfirmationCard, {
      isDirty: true,
      isDrafting: true,
      activeThemeName: 'Dark',
      onConfirm: () => {},
      onCancel: () => {},
      error: 'Simulated storage quota exceeded',
      saveFeedback: false,
      t: tEn,
    })
  );

  assert.match(html, /theme-error-banner/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Simulated storage quota exceeded/);
});

test('regression: text and label reset via UI action adapter clears effective values, marks dirty, and persists clearance on confirm', () => {
  let inMemoryStorage: Record<string, string> = {
    pi_viewer_ui_preferences: JSON.stringify({
      theme: 'dark',
      language: 'en',
      customTextColor: '#ffffff',
      customLabelColor: '#10b981',
    }),
  };

  const mockStorage: Storage = {
    getItem: (k: string) => inMemoryStorage[k] ?? null,
    setItem: (k: string, v: string) => { inMemoryStorage[k] = String(v); },
    removeItem: (k: string) => { delete inMemoryStorage[k]; },
    clear: () => { inMemoryStorage = {}; },
    key: (i: number) => Object.keys(inMemoryStorage)[i] ?? null,
    get length() { return Object.keys(inMemoryStorage).length; },
  };

  let currentPrefs = loadUiPreferences(mockStorage).preferences;
  const prefController = new PreferencesController({
    getPreferences: () => currentPrefs,
    setPreferences: (up: any) => { currentPrefs = up; },
    setWarning: () => {},
    storage: mockStorage,
  });

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => extractAppearancePreferences(currentPrefs),
    commitAppearance: (c) => prefController.commitAppearance(c),
    resetAppearance: () => prefController.resetAppearance(),
  });

  const actions = createThemeCustomizerActions(controller);

  // 1. Text color clear
  actions.setTextColor(null);
  assert.equal(controller.getState().isDirty, true, 'Clearing text color must mark draft dirty');
  assert.equal(
    controller.getEffectiveAppearance().customTextColor,
    null,
    'Effective text color must be cleared (null), not falling back to saved'
  );

  // 2. Label color clear
  actions.setLabelColor(null);
  assert.equal(controller.getState().isDirty, true, 'Clearing label color must mark draft dirty');
  assert.equal(
    controller.getEffectiveAppearance().customLabelColor,
    null,
    'Effective label color must be cleared (null), not falling back to saved'
  );

  // 3. Confirm and reload
  const confirmResult = actions.confirm();
  assert.equal(confirmResult.success, true);

  const reloaded = loadUiPreferences(mockStorage).preferences;
  assert.equal(reloaded.customTextColor, undefined, 'Reloaded text color must be cleared');
  assert.equal(reloaded.customLabelColor, undefined, 'Reloaded label color must be cleared');
});

test('regression: resetting single remaining background area via UI actions clears preview and persists removal', () => {
  let inMemoryStorage: Record<string, string> = {
    pi_viewer_ui_preferences: JSON.stringify({
      theme: 'dark',
      language: 'en',
      customBackground: {
        canvas: { color: '#000000', opacity: 0.5 },
      },
    }),
  };

  const mockStorage: Storage = {
    getItem: (k: string) => inMemoryStorage[k] ?? null,
    setItem: (k: string, v: string) => { inMemoryStorage[k] = String(v); },
    removeItem: (k: string) => { delete inMemoryStorage[k]; },
    clear: () => { inMemoryStorage = {}; },
    key: (i: number) => Object.keys(inMemoryStorage)[i] ?? null,
    get length() { return Object.keys(inMemoryStorage).length; },
  };

  let currentPrefs = loadUiPreferences(mockStorage).preferences;
  const prefController = new PreferencesController({
    getPreferences: () => currentPrefs,
    setPreferences: (up: any) => { currentPrefs = up; },
    setWarning: () => {},
    storage: mockStorage,
  });

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => extractAppearancePreferences(currentPrefs),
    commitAppearance: (c) => prefController.commitAppearance(c),
    resetAppearance: () => prefController.resetAppearance(),
  });

  const actions = createThemeCustomizerActions(controller);

  // Reset the single remaining area
  actions.resetArea('canvas');
  assert.equal(controller.getState().isDirty, true, 'Resetting only area must mark draft dirty');
  assert.equal(
    controller.getEffectiveAppearance().customBackground,
    null,
    'Effective custom background must be cleared (null)'
  );

  // Confirm and reload
  const confirmResult = actions.confirm();
  assert.equal(confirmResult.success, true);

  const reloaded = loadUiPreferences(mockStorage).preferences;
  assert.equal(reloaded.customBackground, undefined, 'Reloaded custom background must be undefined');
});
