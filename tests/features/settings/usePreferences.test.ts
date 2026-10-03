import test from 'node:test';
import assert from 'node:assert/strict';
import { AppearanceLifecycleController, type AppearanceDomTarget } from '@features/settings/appearance';
import {
  DEFAULT_UI_PREFERENCES,
  PreferencesController,
  type UiPreferences,
} from '@infra/preferences';

function createMockDomTarget(): AppearanceDomTarget & {
  attributes: Map<string, string>;
  styles: Map<string, string>;
} {
  const attributes = new Map<string, string>();
  const styles = new Map<string, string>();
  return {
    attributes,
    styles,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    style: {
      colorScheme: '',
      setProperty(name: string, value: string) {
        styles.set(name, value);
      },
      removeProperty(name: string) {
        styles.delete(name);
      },
      getPropertyValue(name: string) {
        return styles.get(name) ?? '';
      },
    },
  };
}

function createFakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

test('synchronous preferencesRef update in setPreferences prevents stale consecutive mutations', () => {
  const fakeStorage = createFakeStorage();
  let livePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  const preferencesRef = { current: livePrefs };

  const controller = new PreferencesController({
    getPreferences: () => preferencesRef.current,
    setPreferences: (updated) => {
      preferencesRef.current = updated;
      livePrefs = updated;
    },
    setWarning: () => {},
    storage: fakeStorage,
  });

  // Consecutive mutations in the same tick
  controller.setLanguage('es');
  controller.setTheme('arch-electric');
  controller.setCustomAccent('#33ccff');

  assert.strictEqual(preferencesRef.current.language, 'es');
  assert.strictEqual(preferencesRef.current.theme, 'arch-electric');
  assert.strictEqual(preferencesRef.current.customAccent, '#33ccff');
  assert.strictEqual(livePrefs.language, 'es');
  assert.strictEqual(livePrefs.theme, 'arch-electric');
  assert.strictEqual(livePrefs.customAccent, '#33ccff');
});

test('usePreferences appearance lifecycle integration: single owner manages DOM without draft overwrite', () => {
  const domTarget = createMockDomTarget();
  let livePrefs: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: 'dark',
    customAccent: '#00e5ff',
  };
  const preferencesRef = { current: livePrefs };

  const prefController = new PreferencesController({
    getPreferences: () => preferencesRef.current,
    setPreferences: (updated) => {
      preferencesRef.current = updated;
      livePrefs = updated;
    },
    setWarning: () => {},
    storage: createFakeStorage(),
  });

  const lifecycleController = new AppearanceLifecycleController({
    getSavedAppearance: () => ({
      theme: preferencesRef.current.theme,
      customAccent: preferencesRef.current.customAccent,
    }),
    commitAppearance: (c) => prefController.commitAppearance(c),
    resetAppearance: () => prefController.resetAppearance(),
    rootElement: domTarget,
  }).start();

  // Initial appearance applied
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00e5ff');

  // Begin draft
  lifecycleController.begin();
  lifecycleController.update({
    theme: 'DjRomoro',
    customAccent: '#ff0055',
  });
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#ff0055');

  // External preference update while drafting
  prefController.setLanguage('es');
  lifecycleController.setSavedAppearance({
    theme: preferencesRef.current.theme,
    customAccent: preferencesRef.current.customAccent,
  });

  // Preview remains untouched
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'DjRomoro');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#ff0055');

  // Cancel restores saved
  lifecycleController.cancel();
  assert.strictEqual(domTarget.attributes.get('data-theme'), 'dark');
  assert.strictEqual(domTarget.styles.get('--accent-primary'), '#00e5ff');

  lifecycleController.dispose();
});
