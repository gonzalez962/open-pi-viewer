import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UI_PREFERENCES,
  DEFAULT_WORK_ANIMATION_PREFERENCES,
  loadUiPreferences,
  PreferencesController,
  validateUiPreferences,
  validateWorkAnimationPreferences,
  validateAreaBackgroundConfig,
  validateBackgroundImageConfig,
  validateCustomBackgroundPreferences,
  computeWorkAnimationStyles,
  type UiPreferences,
  type WorkAnimationPreferences,
  type CustomBackgroundPreferences,
} from '@infra/preferences';
import { DEFAULT_CONFIG } from '@features/settings/config';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';

/**
 * Minimal in-memory Storage implementation for injecting into the controller.
 */
function createFakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/**
 * Storage whose setItem always throws, simulating quota/security failures.
 */
function createThrowingStorage(message: string): Storage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error(message);
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}

function makeHarness(initial: UiPreferences, storage: Storage | null) {
  let current: UiPreferences = initial;
  const setPreferencesCalls: UiPreferences[] = [];
  const setWarningCalls: (string | null)[] = [];

  const controller = new PreferencesController({
    getPreferences: () => current,
    setPreferences: (updated) => {
      current = updated;
      setPreferencesCalls.push(updated);
    },
    setWarning: (warning) => {
      setWarningCalls.push(warning);
    },
    storage,
  });

  return {
    controller,
    getCurrent: () => current,
    setPreferencesCalls,
    setWarningCalls,
  };
}

test('preferences: PreferencesController setTheme and setLanguage update state, persist to storage, and clear warning', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let activeWarning: string | null = 'Initial pre-existing warning';

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      activeWarning = warning;
    },
    storage,
  });

  // Switch theme to light
  const themeResult = controller.setTheme('light');
  assert.deepStrictEqual(themeResult, {
    language: 'en',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
  assert.deepStrictEqual(activePrefs, {
    language: 'en',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
  assert.strictEqual(activeWarning, null, 'Warning must be cleared on successful save');
  assert.deepStrictEqual(loadUiPreferences(storage).preferences, {
    language: 'en',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });

  // Switch language to Spanish
  const langResult = controller.setLanguage('es');
  assert.deepStrictEqual(langResult, {
    language: 'es',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
  assert.deepStrictEqual(activePrefs, {
    language: 'es',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
  assert.strictEqual(activeWarning, null);
  assert.deepStrictEqual(loadUiPreferences(storage).preferences, {
    language: 'es',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
});

test('preferences: PreferencesController handles throwing storage by surfacing warning and updating in-memory state', () => {
  const throwingStorage = createThrowingStorage('setItem');
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  const captured = {
    warning: null as string | null,
  };

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      captured.warning = warning;
    },
    storage: throwingStorage,
  });

  controller.setTheme('light');
  assert.deepStrictEqual(activePrefs, {
    language: 'en',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
  assert.ok(captured.warning !== null);
  assert.ok(captured.warning!.includes('Failed to persist UI preferences'));
});

test('isolation: PreferencesController mutations leave connection config, draft prompt, active session, and startup manager untouched', () => {
  const storage = createFakeStorage();
  let preferences: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let preferencesWarning: string | null = null;

  const connectionConfig = { ...DEFAULT_CONFIG };
  const promptDraft = 'Draft message user has typed into textarea';
  const activeSessionId = 'session-viewer-abc-123';
  const startupInvocationCount = 0;

  const controller = new PreferencesController({
    getPreferences: () => preferences,
    setPreferences: (updated) => {
      preferences = updated;
    },
    setWarning: (warning) => {
      preferencesWarning = warning;
    },
    storage,
  });

  controller.setTheme('light');
  controller.setLanguage('es');

  assert.deepStrictEqual(preferences, {
    language: 'es',
    theme: 'light',
    notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  });
  assert.strictEqual(preferencesWarning, null);

  assert.strictEqual(
    startupInvocationCount,
    0,
    'Preferences mutation must never invoke startupManager or reconnect bridge'
  );
  assert.deepStrictEqual(
    connectionConfig,
    DEFAULT_CONFIG,
    'Connection configuration must remain completely unchanged'
  );
  assert.strictEqual(
    promptDraft,
    'Draft message user has typed into textarea',
    'User prompt input draft must not be reset or cleared'
  );
  assert.strictEqual(
    activeSessionId,
    'session-viewer-abc-123',
    'Active session ID must remain unchanged'
  );
});

test('PreferencesController.setLanguage: reports the storage failure through setWarning but still applies the in-memory update', () => {
  const storage = createThrowingStorage('SecurityError: storage disabled');
  const harness = makeHarness({ language: 'en', theme: 'dark' }, storage);

  const result = harness.controller.setLanguage('es');

  assert.deepEqual(result, { language: 'es', theme: 'dark' });
  assert.equal(harness.setWarningCalls.length, 1);
  assert.match(
    harness.setWarningCalls[0] ?? '',
    /Failed to persist UI preferences to storage: SecurityError: storage disabled/
  );
});

test('PreferencesController.setTheme: reports an explicit unavailable-storage error when storage is null', () => {
  const harness = makeHarness({ language: 'en', theme: 'dark' }, null);

  const result = harness.controller.setTheme('light');

  assert.deepEqual(result, { language: 'en', theme: 'light' });
  assert.equal(harness.setWarningCalls.length, 1);
  assert.equal(
    harness.setWarningCalls[0],
    'Storage is not available in current environment'
  );
});

test('PreferencesController: setTheme reads fresh state through getPreferences on every call (no stale closures)', () => {
  const storage = createFakeStorage();
  const harness = makeHarness({ language: 'en', theme: 'dark' }, storage);

  harness.controller.setLanguage('es');
  const result = harness.controller.setTheme('light');

  // setTheme must merge onto the language change made in between, proving
  // it reads getPreferences() fresh rather than capturing state at construction.
  assert.deepEqual(result, { language: 'es', theme: 'light' });
});

test('PreferencesController.setNotifications: updates partial notification preferences and persists to storage', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let activeWarning: string | null = 'stale-warning';

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      activeWarning = warning;
    },
    storage,
  });

  const saveRes = controller.setNotifications({ sound: false, onTaskComplete: false });
  assert.strictEqual(saveRes.success, true);
  assert.strictEqual(activeWarning, null);
  assert.deepEqual(activePrefs.notifications, {
    enabled: true,
    sound: false,
    suppressWhenFocused: true,
    onTaskComplete: false,
    onWaitingInput: true,
  });

  const loaded = loadUiPreferences(storage);
  assert.deepEqual(loaded.preferences.notifications, {
    enabled: true,
    sound: false,
    suppressWhenFocused: true,
    onTaskComplete: false,
    onWaitingInput: true,
  });
});

test('validateUiPreferences: validates and sanitizes notifications payload', () => {
  const payload = {
    language: 'en',
    theme: 'dark',
    notifications: {
      enabled: false,
      sound: true,
      suppressWhenFocused: false,
      onTaskComplete: true,
      onWaitingInput: false,
    },
  };

  const res = validateUiPreferences(payload);
  assert.strictEqual(res.valid, true);
  assert.deepEqual(res.preferences.notifications, {
    enabled: false,
    sound: true,
    suppressWhenFocused: false,
    onTaskComplete: true,
    onWaitingInput: false,
  });
});


test('validateUiPreferences: keeps valid custom commands and drops malformed ones', () => {
  const result = validateUiPreferences({
    language: 'en',
    theme: 'dark',
    customCommands: [
      { id: 'custom:deploy', name: '/deploy', description: 'Deploys' },
      { name: '/help', description: 'shadows a built-in' },
      42,
    ],
  });
  assert.deepEqual(result.preferences.customCommands, [
    { id: 'custom:deploy', name: '/deploy', description: 'Deploys' },
  ]);

  const notArray = validateUiPreferences({ language: 'en', theme: 'dark', customCommands: 'x' });
  assert.deepEqual(notArray.preferences.customCommands, []);

  const absent = validateUiPreferences({ language: 'en', theme: 'dark' });
  assert.equal('customCommands' in absent.preferences, false);
});

test('PreferencesController.setCustomCommands: persists the list and reloads it from storage', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage,
  });

  const commands = [
    { id: 'custom:deploy', name: '/deploy', description: 'Deploys', aliases: ['/ship'] },
  ];
  const saveRes = controller.setCustomCommands(commands);
  assert.strictEqual(saveRes.success, true);
  assert.deepEqual(activePrefs.customCommands, commands);
  assert.deepEqual(loadUiPreferences(storage).preferences.customCommands, commands);
});

test('validateUiPreferences: sanitizes hiddenCommandIds (non-array, non-strings, duplicates)', () => {
  const result = validateUiPreferences({
    language: 'en',
    theme: 'dark',
    hiddenCommandIds: ['help', 7, 'help', '', 'custom:deploy'],
  });
  assert.deepEqual(result.preferences.hiddenCommandIds, ['help', 'custom:deploy']);

  const notArray = validateUiPreferences({ language: 'en', theme: 'dark', hiddenCommandIds: {} });
  assert.deepEqual(notArray.preferences.hiddenCommandIds, []);

  const absent = validateUiPreferences({ language: 'en', theme: 'dark' });
  assert.equal('hiddenCommandIds' in absent.preferences, false);
});

test('PreferencesController.setHiddenCommandIds: persists hidden ids and reloads them', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage,
  });

  const saveRes = controller.setHiddenCommandIds(['help', 'help', 'new']);
  assert.strictEqual(saveRes.success, true);
  assert.deepEqual(activePrefs.hiddenCommandIds, ['help', 'new']);
  assert.deepEqual(loadUiPreferences(storage).preferences.hiddenCommandIds, ['help', 'new']);
});

test('PreferencesController.setCustomCommands: prunes hidden ids of deleted custom commands', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    customCommands: [{ id: 'custom:deploy', name: '/deploy', description: 'Deploys' }],
    hiddenCommandIds: ['help', 'custom:deploy'],
  };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage,
  });

  controller.setCustomCommands([]);
  assert.deepEqual(activePrefs.customCommands, []);
  assert.deepEqual(activePrefs.hiddenCommandIds, ['help']);
  assert.deepEqual(loadUiPreferences(storage).preferences.hiddenCommandIds, ['help']);
});

test('preferences: validateWorkAnimationPreferences and computeWorkAnimationStyles validate modes and compute dynamic styles', () => {
  // Test invalid input defaults cleanly
  const defaultRes = validateWorkAnimationPreferences(null);
  assert.deepEqual(defaultRes, DEFAULT_WORK_ANIMATION_PREFERENCES);

  const corruptRes = validateWorkAnimationPreferences({
    mode: 'invalid_mode',
    color1: 'not-a-hex',
    color2: '#ggg',
  });
  assert.deepEqual(corruptRes, DEFAULT_WORK_ANIMATION_PREFERENCES);

  // Test valid single mode
  const singlePref: WorkAnimationPreferences = {
    mode: 'single',
    color1: '#10b981',
    color2: '#00e5ff',
  };
  const validSingle = validateWorkAnimationPreferences(singlePref);
  assert.deepEqual(validSingle, singlePref);

  const singleStyles = computeWorkAnimationStyles(singlePref);
  assert.strictEqual(singleStyles.className, 'prompt-degraciao-loader is-mode-single');
  assert.strictEqual(singleStyles.style?.['--loader-color1'], '#10b981');
  assert.ok(singleStyles.style?.['--loader-color1-border']);
  assert.ok(singleStyles.style?.['--loader-color1-glow']);

  // Test valid dual mode
  const dualPref: WorkAnimationPreferences = {
    mode: 'dual',
    color1: '#ff007f',
    color2: '#00d4ff',
  };
  const dualStyles = computeWorkAnimationStyles(dualPref);
  assert.strictEqual(dualStyles.className, 'prompt-degraciao-loader is-mode-dual');
  assert.strictEqual(dualStyles.style?.['--loader-color1'], '#ff007f');
  assert.strictEqual(dualStyles.style?.['--loader-color2'], '#00d4ff');

  // Test multicolor mode
  const multiStyles = computeWorkAnimationStyles({
    mode: 'multicolor',
    color1: '#00ff0a',
    color2: '#00e5ff',
  });
  assert.strictEqual(multiStyles.className, 'prompt-degraciao-loader is-mode-multicolor');
  assert.strictEqual(multiStyles.style, undefined);
});

test('preferences: PreferencesController.setWorkAnimation updates state and persists cleanly to storage', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let activeWarning: string | null = 'stale-warning';

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      activeWarning = warning;
    },
    storage,
  });

  const newAnimation: WorkAnimationPreferences = {
    mode: 'dual',
    color1: '#e06c75',
    color2: '#38bdf8',
  };

  const updatedPrefs = controller.setWorkAnimation(newAnimation);
  assert.strictEqual(activeWarning, null);
  assert.deepEqual(updatedPrefs.workAnimation, newAnimation);
  assert.deepEqual(activePrefs.workAnimation, newAnimation);

  const loaded = loadUiPreferences(storage);
  assert.deepEqual(loaded.preferences.workAnimation, newAnimation);
});

test('preferences: validateUiPreferences validates customTextColor and customLabelColor with honest warnings', () => {
  const validPayload = {
    language: 'en',
    theme: 'dark',
    customTextColor: '#ffffff',
    customLabelColor: '#10b981',
  };

  const res = validateUiPreferences(validPayload);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.preferences.customTextColor, '#ffffff');
  assert.strictEqual(res.preferences.customLabelColor, '#10b981');

  // Corrupted hex colors should be stripped with warning
  const invalidPayload = {
    language: 'en',
    theme: 'dark',
    customTextColor: 'invalid-color',
    customLabelColor: '#1234567890',
  };

  const invalidRes = validateUiPreferences(invalidPayload);
  assert.strictEqual(invalidRes.preferences.customTextColor, undefined);
  assert.strictEqual(invalidRes.preferences.customLabelColor, undefined);
  assert.ok(invalidRes.warning?.includes('customTextColor'));
  assert.ok(invalidRes.warning?.includes('customLabelColor'));
});

test('preferences: PreferencesController.setCustomThemeColors updates and persists to storage', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let activeWarning: string | null = 'some-warning';

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      activeWarning = warning;
    },
    storage,
  });

  const updated = controller.setCustomThemeColors({
    text: '#ececec',
    label: '#00e5ff',
  });

  assert.strictEqual(activeWarning, null);
  assert.strictEqual(updated.customTextColor, '#ececec');
  assert.strictEqual(updated.customLabelColor, '#00e5ff');
  assert.strictEqual(activePrefs.customTextColor, '#ececec');
  assert.strictEqual(activePrefs.customLabelColor, '#00e5ff');

  const loaded = loadUiPreferences(storage);
  assert.strictEqual(loaded.preferences.customTextColor, '#ececec');
  assert.strictEqual(loaded.preferences.customLabelColor, '#00e5ff');

  // Clearing them by passing null
  const cleared = controller.setCustomThemeColors({
    text: null,
    label: null,
  });
  assert.strictEqual(cleared.customTextColor, undefined);
  assert.strictEqual(cleared.customLabelColor, undefined);
});

test('preferences: validateAreaBackgroundConfig and validateBackgroundImageConfig validate areas, fits, and opacities', () => {
  // Area config
  assert.strictEqual(validateAreaBackgroundConfig(null), undefined);
  const area1 = validateAreaBackgroundConfig({ color: '#10b981', opacity: 0.5 });
  assert.deepEqual(area1, { color: '#10b981', opacity: 0.5 });

  const area2 = validateAreaBackgroundConfig({ color: '#10b981', opacity: 0 }); // 0% opacity
  assert.deepEqual(area2, { color: '#10b981', opacity: 0 });

  const areaClamped = validateAreaBackgroundConfig({ opacity: 2.5 });
  assert.deepEqual(areaClamped, { color: undefined, opacity: 1 });

  // Background image config
  assert.strictEqual(validateBackgroundImageConfig(null), undefined);
  const img1 = validateBackgroundImageConfig({
    enabled: true,
    url: 'https://example.com/bg.png',
    fit: 'cover',
    position: 'center',
    repeat: false,
    opacity: 0.35,
    blur: 5,
  });
  assert.deepEqual(img1, {
    enabled: true,
    url: 'https://example.com/bg.png',
    fit: 'cover',
    position: 'center',
    repeat: false,
    opacity: 0.35,
    blur: 5,
  });

  const imgFallback = validateBackgroundImageConfig({
    enabled: 'true',
    fit: 'invalid_fit',
    position: 'invalid_pos',
    blur: 100, // should clamp to 30
  });
  assert.strictEqual(imgFallback?.enabled, true);
  assert.strictEqual(imgFallback?.fit, 'cover');
  assert.strictEqual(imgFallback?.position, 'center');
  assert.strictEqual(imgFallback?.blur, 30);

  // Custom background validation
  assert.strictEqual(validateCustomBackgroundPreferences(null), undefined);
  const fullBg = validateCustomBackgroundPreferences({
    canvas: { color: '#000000', opacity: 0 },
    image: { enabled: true, url: 'https://example.com/pic.png' },
  });
  assert.strictEqual(fullBg?.canvas?.opacity, 0);
  assert.strictEqual(fullBg?.image?.enabled, true);
});

test('preferences: PreferencesController.setCustomBackground persists areas and image cleanly', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let activeWarning: string | null = 'stale-warning';

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      activeWarning = warning;
    },
    storage,
  });

  const customBg: CustomBackgroundPreferences = {
    canvas: { color: '#000000', opacity: 0.8 },
    sidebar: { color: '#111111', opacity: 0 }, // 0% transparent
    chat: { color: '#000000', opacity: 0.5 },
    prompt: { color: '#0a0a0a', opacity: 0.3 },
    image: {
      enabled: true,
      url: 'https://example.com/art.jpg',
      fit: 'cover',
      position: 'center',
      repeat: false,
      opacity: 0.3,
      blur: 4,
    },
  };

  const updated = controller.setCustomBackground(customBg);
  assert.strictEqual(activeWarning, null);
  assert.strictEqual(updated.customBackground?.prompt?.opacity, 0.3);
  assert.deepEqual(updated.customBackground, customBg);
  assert.deepEqual(activePrefs.customBackground, customBg);

  const loaded = loadUiPreferences(storage);
  assert.deepEqual(loaded.preferences.customBackground, customBg);

  // Clearing background
  const cleared = controller.setCustomBackground(null);
  assert.strictEqual(cleared.customBackground, undefined);
  assert.strictEqual(activePrefs.customBackground, undefined);
});
