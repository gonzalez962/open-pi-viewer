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
import { WallpaperPlaceholder } from '@features/settings/components/appearance/WallpaperPlaceholder';
import { PreviewSandbox } from '@features/settings/components/appearance/PreviewSandbox';
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

test('ThemeCustomizer: WallpaperPlaceholder clearly indicates unavailable until T5 without file inputs', () => {
  const html = renderToStaticMarkup(
    React.createElement(WallpaperPlaceholder, {
      t: tEn,
    })
  );

  assert.match(html, /Background Image/);
  assert.match(html, /T5/);
  assert.doesNotMatch(html, /<input[^>]*type="file"/);
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

