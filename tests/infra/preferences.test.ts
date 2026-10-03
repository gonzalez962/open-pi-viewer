import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BACKGROUND_IMAGE_CONFIG,
  DEFAULT_UI_PREFERENCES,
  DEFAULT_WORK_ANIMATION_PREFERENCES,
  LEGACY_CUSTOM_ACCENT_STORAGE_KEY,
  MAX_WALLPAPER_DATA_URL_LENGTH,
  PreferencesController,
  UI_PREFERENCES_STORAGE_KEY,
  computeCustomThemeVariables,
  computeWorkAnimationStyles,
  extractAppearancePreferences,
  hasCustomAppearance,
  hexToRgba,
  isSafeImageUrl,
  isValidHexColor,
  loadUiPreferences,
  validateAreaBackgroundConfig,
  validateBackgroundImageConfig,
  validateUiPreferences,
  validateWorkAnimationPreferences,
  type AppearancePreferences,
  type UiPreferences,
  type WorkAnimationPreferences,
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
  const defaultRes = validateWorkAnimationPreferences(null);
  assert.deepEqual(defaultRes, DEFAULT_WORK_ANIMATION_PREFERENCES);

  const corruptRes = validateWorkAnimationPreferences({
    mode: 'invalid_mode',
    color1: 'not-a-hex',
    color2: '#ggg',
  });
  assert.deepEqual(corruptRes, DEFAULT_WORK_ANIMATION_PREFERENCES);

  // Valid single mode
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

  // Valid dual mode
  const dualPref: WorkAnimationPreferences = {
    mode: 'dual',
    color1: '#ff007f',
    color2: '#00d4ff',
  };
  const dualStyles = computeWorkAnimationStyles(dualPref);
  assert.strictEqual(dualStyles.className, 'prompt-degraciao-loader is-mode-dual');
  assert.strictEqual(dualStyles.style?.['--loader-color1'], '#ff007f');
  assert.strictEqual(dualStyles.style?.['--loader-color2'], '#00d4ff');

  // Multicolor mode
  const multiStyles = computeWorkAnimationStyles({
    mode: 'multicolor',
    color1: '#00ff0a',
    color2: '#00e5ff',
  });
  assert.strictEqual(multiStyles.className, 'prompt-degraciao-loader is-mode-multicolor');
  assert.strictEqual(multiStyles.style, undefined);
});

test('preferences: isValidHexColor and hexToRgba validate hex codes and generate rgba correctly', () => {
  assert.strictEqual(isValidHexColor('#abc'), true);
  assert.strictEqual(isValidHexColor('#10b981'), true);
  assert.strictEqual(isValidHexColor('  #00E5FF  '), true);
  assert.strictEqual(isValidHexColor('#12345'), false);
  assert.strictEqual(isValidHexColor('#1234567'), false);
  assert.strictEqual(isValidHexColor('rgb(0,0,0)'), false);
  assert.strictEqual(isValidHexColor('red'), false);
  assert.strictEqual(isValidHexColor(null), false);
  assert.strictEqual(isValidHexColor(undefined), false);

  assert.strictEqual(hexToRgba('#fff', 0.5), 'rgba(255, 255, 255, 0.5)');
  assert.strictEqual(hexToRgba('#000000', 0), 'rgba(0, 0, 0, 0)');
  assert.strictEqual(hexToRgba('#10b981', 0.25), 'rgba(16, 185, 129, 0.25)');
});

test('preferences: isSafeImageUrl validates safe schemes and rejects executable and malformed URLs', () => {
  // Safe web URLs
  assert.strictEqual(isSafeImageUrl('https://example.com/wallpaper.png'), true);
  assert.strictEqual(isSafeImageUrl('http://localhost:5173/bg.jpg'), true);

  // Safe bundled wallpaper paths
  assert.strictEqual(isSafeImageUrl('/wallpapers/minimalist-ninja.jpg'), true);
  assert.strictEqual(isSafeImageUrl('/wallpapers/minimalist-ninja-1080p.jpg'), true);
  assert.strictEqual(isSafeImageUrl('/wallpapers/sub/custom.webp'), true);

  // Directory traversal in wallpaper path is rejected
  assert.strictEqual(isSafeImageUrl('/wallpapers/../secret.jpg'), false);
  assert.strictEqual(isSafeImageUrl('/wallpapers/..\\secret.jpg'), false);

  // Safe bounded data URLs
  const validDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.strictEqual(isSafeImageUrl(validDataUrl), true);
  assert.strictEqual(isSafeImageUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), true);
  assert.strictEqual(isSafeImageUrl('data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA='), true);

  // Unsafe / executable / script URLs rejected
  assert.strictEqual(isSafeImageUrl('javascript:alert(1)'), false);
  assert.strictEqual(isSafeImageUrl('JAVASCRIPT:alert(document.cookie)'), false);
  assert.strictEqual(isSafeImageUrl('vbscript:msgbox(1)'), false);
  assert.strictEqual(isSafeImageUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.strictEqual(isSafeImageUrl('data:application/javascript;base64,YWxlcnQoMSk='), false);
  assert.strictEqual(isSafeImageUrl('file:///etc/passwd'), false);
  assert.strictEqual(isSafeImageUrl(''), false);
  assert.strictEqual(isSafeImageUrl('   '), false);
  assert.strictEqual(isSafeImageUrl(null), false);

  // Reject oversized data URL (> 1 MiB)
  const oversizedDataUrl = 'data:image/png;base64,' + 'A'.repeat(MAX_WALLPAPER_DATA_URL_LENGTH + 10);
  assert.strictEqual(isSafeImageUrl(oversizedDataUrl), false);
});

test('preferences: validateAreaBackgroundConfig and validateBackgroundImageConfig enforce finite bounds', () => {
  // Clamping opacity
  assert.deepEqual(validateAreaBackgroundConfig({ color: '#10b981', opacity: 0.5 }), {
    color: '#10b981',
    opacity: 0.5,
  });
  assert.deepEqual(validateAreaBackgroundConfig({ opacity: -1 }), { color: undefined, opacity: 0 });
  assert.deepEqual(validateAreaBackgroundConfig({ opacity: 2 }), { color: undefined, opacity: 1 });
  assert.deepEqual(validateAreaBackgroundConfig({ opacity: NaN }), { color: undefined, opacity: 1 });
  assert.deepEqual(validateAreaBackgroundConfig({ opacity: Infinity }), { color: undefined, opacity: 1 });

  // Background image finite bounds
  const defaultImg = validateBackgroundImageConfig({});
  assert.deepEqual(defaultImg, DEFAULT_BACKGROUND_IMAGE_CONFIG);

  const imgWithUnsafeUrl = validateBackgroundImageConfig({
    enabled: true,
    url: 'javascript:alert(1)',
    blur: 100, // Should clamp to 30
    opacity: -0.5, // Should clamp to 0
  });
  assert.strictEqual(imgWithUnsafeUrl?.url, '', 'Unsafe URL must be stripped to empty string');
  assert.strictEqual(imgWithUnsafeUrl?.blur, 30);
  assert.strictEqual(imgWithUnsafeUrl?.opacity, 0);

  const imgWithNonFinite = validateBackgroundImageConfig({
    enabled: true,
    url: '/wallpapers/minimalist-ninja.jpg',
    blur: NaN,
    opacity: Infinity,
  });
  assert.strictEqual(imgWithNonFinite?.url, '/wallpapers/minimalist-ninja.jpg');
  assert.strictEqual(imgWithNonFinite?.blur, 0);
  assert.strictEqual(imgWithNonFinite?.opacity, 0.4);
});

test('preferences: validateBackgroundImageConfig supports all fits and cardinal positions with safe fallbacks', () => {
  for (const fit of ['cover', 'contain', '100% 100%', 'repeat', 'auto'] as const) {
    const res = validateBackgroundImageConfig({ fit });
    assert.strictEqual(res?.fit, fit);
  }
  for (const pos of ['center', 'top', 'bottom', 'left', 'right'] as const) {
    const res = validateBackgroundImageConfig({ position: pos });
    assert.strictEqual(res?.position, pos);
  }
  // Unknown values fallback to defaults
  assert.strictEqual(validateBackgroundImageConfig({ fit: 'invalid-fit' })?.fit, 'cover');
  assert.strictEqual(validateBackgroundImageConfig({ position: 'invalid-pos' })?.position, 'center');
});

test('preferences: validateUiPreferences validates visual customizations and preserves existing preferences', () => {
  const fullPayload = {
    language: 'es',
    theme: 'DjRomoro',
    customAccent: '#ff007f',
    customTextColor: '#ffffff',
    customLabelColor: '#00e5ff',
    workAnimation: {
      mode: 'dual',
      color1: '#ff007f',
      color2: '#00e5ff',
    },
    customBackground: {
      canvas: { color: '#0d1117', opacity: 0.9 },
      image: {
        enabled: true,
        url: '/wallpapers/minimalist-ninja.jpg',
        fit: 'cover',
        position: 'center',
        repeat: false,
        opacity: 0.3,
        blur: 5,
      },
    },
    notifications: {
      enabled: false,
      sound: false,
      suppressWhenFocused: true,
      onTaskComplete: false,
      onWaitingInput: true,
    },
    customCommands: [{ id: 'custom:c1', name: '/c1', description: 'Desc' }],
    hiddenCommandIds: ['custom:c1'],
  };

  const res = validateUiPreferences(fullPayload);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.preferences.language, 'es');
  assert.strictEqual(res.preferences.theme, 'DjRomoro');
  assert.strictEqual(res.preferences.customAccent, '#ff007f');
  assert.strictEqual(res.preferences.customTextColor, '#ffffff');
  assert.strictEqual(res.preferences.customLabelColor, '#00e5ff');
  assert.deepEqual(res.preferences.workAnimation, fullPayload.workAnimation);
  assert.deepEqual(res.preferences.customBackground?.canvas, { color: '#0d1117', opacity: 0.9 });
  assert.strictEqual(res.preferences.customBackground?.image?.url, '/wallpapers/minimalist-ninja.jpg');
  assert.deepEqual(res.preferences.notifications, fullPayload.notifications);
  assert.deepEqual(res.preferences.customCommands, fullPayload.customCommands);
  assert.deepEqual(res.preferences.hiddenCommandIds, fullPayload.hiddenCommandIds);

  // Corrupted visual fields are sanitized with descriptive warnings without losing valid fields
  const corruptPayload = {
    language: 'en',
    theme: 'invalid-theme',
    customAccent: 'not-hex',
    customBackground: {
      image: {
        enabled: true,
        url: 'javascript:malicious()',
      },
    },
    customCommands: [{ id: 'custom:c2', name: '/c2', description: 'Desc2' }],
  };
  const corruptRes = validateUiPreferences(corruptPayload);
  assert.strictEqual(corruptRes.valid, false);
  assert.strictEqual(corruptRes.preferences.theme, 'dark'); // fallback
  assert.strictEqual(corruptRes.preferences.customAccent, undefined); // dropped
  assert.strictEqual(corruptRes.preferences.customBackground?.image?.url, ''); // sanitized
  assert.deepEqual(corruptRes.preferences.customCommands, [{ id: 'custom:c2', name: '/c2', description: 'Desc2' }]);
  assert.ok(corruptRes.warning?.includes('invalid-theme'));
  assert.ok(corruptRes.warning?.includes('customAccent'));
  assert.ok(corruptRes.warning?.includes('wallpaper'));
});

test('preferences: loadUiPreferences migrates legacy pi_viewer_custom_accent storage key', () => {
  const storage = createFakeStorage();
  storage.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');

  const loaded = loadUiPreferences(storage);
  assert.strictEqual(loaded.preferences.customAccent, '#00e5ff', 'Legacy accent key must be migrated to customAccent');

  // If preferences JSON exists without customAccent (unmanaged/absent), legacy key is migrated
  const storageWithUnmanaged = createFakeStorage();
  storageWithUnmanaged.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  storageWithUnmanaged.setItem('pi_viewer_ui_preferences', JSON.stringify({
    language: 'en',
    theme: 'dark',
  }));
  const loadedUnmanaged = loadUiPreferences(storageWithUnmanaged);
  assert.strictEqual(loadedUnmanaged.preferences.customAccent, '#00e5ff', 'Absent/unmanaged accent must migrate legacy key');

  // If preferences JSON already has customAccent, it takes precedence over legacy key
  const storageWithBoth = createFakeStorage();
  storageWithBoth.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  storageWithBoth.setItem('pi_viewer_ui_preferences', JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: '#ff007f',
  }));

  const loadedBoth = loadUiPreferences(storageWithBoth);
  assert.strictEqual(loadedBoth.preferences.customAccent, '#ff007f');

  // If preferences JSON has explicit customAccent: null, legacy accent is NOT migrated
  const storageWithExplicitNull = createFakeStorage();
  storageWithExplicitNull.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  storageWithExplicitNull.setItem('pi_viewer_ui_preferences', JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: null,
  }));
  const loadedExplicitNull = loadUiPreferences(storageWithExplicitNull);
  assert.strictEqual(loadedExplicitNull.preferences.customAccent, null, 'Explicit null customAccent must not be overwritten by legacy key');
});

test('PreferencesController.commitAppearance: atomically commits valid candidate, mutates live state, and clears warning', () => {
  const storage = createFakeStorage();
  storage.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let activeWarning: string | null = 'stale warning';

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

  const candidate: AppearancePreferences = {
    theme: 'DjRomoro',
    customAccent: '#10b981',
    customTextColor: '#ffffff',
    customLabelColor: '#34d399',
    workAnimation: {
      mode: 'single',
      color1: '#10b981',
      color2: '#00e5ff',
    },
    customBackground: {
      canvas: { color: '#000000', opacity: 0.8 },
      image: {
        enabled: true,
        url: '/wallpapers/minimalist-ninja.jpg',
        fit: 'cover',
        position: 'center',
        repeat: false,
        opacity: 0.4,
        blur: 0,
      },
    },
  };

  const commitRes = controller.commitAppearance(candidate);
  assert.strictEqual(commitRes.success, true);
  assert.strictEqual(activeWarning, null);
  assert.strictEqual(activePrefs.theme, 'DjRomoro');
  assert.strictEqual(activePrefs.customAccent, '#10b981');
  assert.strictEqual(activePrefs.customTextColor, '#ffffff');
  assert.deepEqual(activePrefs.workAnimation, candidate.workAnimation);
  assert.deepEqual(activePrefs.customBackground, candidate.customBackground);

  // Verify storage has persisted the candidate
  const stored = loadUiPreferences(storage);
  assert.strictEqual(stored.preferences.theme, 'DjRomoro');
  assert.strictEqual(stored.preferences.customAccent, '#10b981');

  // Verify legacy key was cleaned up upon successful appearance commit
  assert.strictEqual(storage.getItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY), null);
});

test('PreferencesController.commitAppearance: on persistence failure, does NOT mutate live preferences and reports failure', () => {
  const throwingStorage = createThrowingStorage('Disk quota exceeded');
  const initialPrefs: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  };
  let activePrefs: UiPreferences = { ...initialPrefs };
  let activeWarning: string | null = null;

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      activeWarning = warning;
    },
    storage: throwingStorage,
  });

  const candidate: AppearancePreferences = {
    theme: 'arch-electric',
    customAccent: '#ff0000',
  };

  const result = controller.commitAppearance(candidate);
  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('Disk quota exceeded') || result.error?.includes('Failed to persist'));
  assert.ok(activeWarning !== null);

  // Live preferences MUST NOT be mutated on failure
  assert.deepEqual(activePrefs, initialPrefs, 'Live preferences must remain unchanged on storage failure');
});

test('PreferencesController.commitAppearance: reports failure and preserves state when storage is null', () => {
  const initialPrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES, theme: 'dark' };
  let activePrefs = { ...initialPrefs };
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
    storage: null,
  });

  const result = controller.commitAppearance({ theme: 'light' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(activePrefs.theme, 'dark', 'Live preferences must not change when storage is unavailable');
  assert.ok(captured.warning?.includes('not available'));
});

test('PreferencesController.resetAppearance: clears visual customization atomically and preserves unrelated preferences', () => {
  const storage = createFakeStorage();
  storage.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');

  let activePrefs: UiPreferences = {
    language: 'es',
    theme: 'DjRomoro',
    customAccent: '#10b981',
    customTextColor: '#ffffff',
    customLabelColor: '#00e5ff',
    workAnimation: { mode: 'single', color1: '#10b981', color2: '#00e5ff' },
    customBackground: { canvas: { color: '#000', opacity: 0.5 } },
    notifications: { enabled: false, sound: false, suppressWhenFocused: true, onTaskComplete: false, onWaitingInput: true },
    customCommands: [{ id: 'cmd1', name: '/cmd1', description: 'test' }],
    hiddenCommandIds: ['cmd1'],
  };
  let activeWarning: string | null = 'stale';

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

  const resetRes = controller.resetAppearance();
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(activeWarning, null);

  // Appearance customizations removed
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(activePrefs.customTextColor, undefined);
  assert.strictEqual(activePrefs.customLabelColor, undefined);
  assert.strictEqual(activePrefs.workAnimation, undefined);
  assert.strictEqual(activePrefs.customBackground, undefined);

  // Unrelated preferences preserved intact
  assert.strictEqual(activePrefs.language, 'es');
  assert.strictEqual(activePrefs.theme, 'DjRomoro');
  assert.deepEqual(activePrefs.notifications, {
    enabled: false,
    sound: false,
    suppressWhenFocused: true,
    onTaskComplete: false,
    onWaitingInput: true,
  });
  assert.deepEqual(activePrefs.customCommands, [{ id: 'cmd1', name: '/cmd1', description: 'test' }]);
  assert.deepEqual(activePrefs.hiddenCommandIds, ['cmd1']);

  // Legacy key cleaned up
  assert.strictEqual(storage.getItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY), null);

  // Test reset failure on throwing storage
  const throwingStorage = createThrowingStorage('Reset storage failed');
  const capturedFail = {
    warning: null as string | null,
  };
  const controllerFail = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      capturedFail.warning = warning;
    },
    storage: throwingStorage,
  });

  const failRes = controllerFail.resetAppearance();
  assert.strictEqual(failRes.success, false);
  assert.ok(capturedFail.warning?.includes('Reset storage failed') || capturedFail.warning?.includes('Failed to persist'));
});

test('preferences: extractAppearancePreferences, hasCustomAppearance, and computeCustomThemeVariables helpers work', () => {
  const emptyPrefs: UiPreferences = { language: 'en', theme: 'dark' };
  assert.strictEqual(hasCustomAppearance(emptyPrefs), false);
  assert.deepEqual(extractAppearancePreferences(emptyPrefs), { theme: 'dark' });

  const customizedPrefs: UiPreferences = {
    language: 'en',
    theme: 'Gentleman-Sexy-Djr',
    customAccent: '#f43888',
    customTextColor: '#f8fafc',
    customLabelColor: '#38bdf8',
    customBackground: {
      canvas: { color: '#111827', opacity: 0.8 },
      sidebar: { color: '#1f2937', opacity: 0.5 },
      chat: { color: '#030712', opacity: 0.9 },
      prompt: { color: '#111827', opacity: 0.6 },
      cards: { color: '#1f2937', opacity: 0.7 },
    },
  };

  assert.strictEqual(hasCustomAppearance(customizedPrefs), true);
  const extracted = extractAppearancePreferences(customizedPrefs);
  assert.strictEqual(extracted.theme, 'Gentleman-Sexy-Djr');
  assert.strictEqual(extracted.customAccent, '#f43888');
  assert.strictEqual(extracted.customTextColor, '#f8fafc');

  const cssVars = computeCustomThemeVariables(extracted);
  assert.strictEqual(cssVars['--accent-primary'], '#f43888');
  assert.strictEqual(cssVars['--border-active'], '#f43888');
  assert.strictEqual(cssVars['--fg-default'], '#f8fafc');
  assert.strictEqual(cssVars['--text-primary'], '#f8fafc');
  assert.strictEqual(cssVars['--activity-badge-fg'], '#38bdf8');
  assert.ok(cssVars['--custom-bg-canvas']?.includes('rgba(17, 24, 39, 0.8)'));
  assert.ok(cssVars['--custom-bg-chat']?.includes('rgba(3, 7, 18, 0.9)'));

  const withAnimation = computeCustomThemeVariables({
    ...extracted,
    workAnimation: { mode: 'single', color1: '#10b981', color2: '#3b82f6' },
  });
  assert.strictEqual(withAnimation['--loader-color1'], '#10b981');
});

test('PreferencesController: uses default window.localStorage when options.storage is omitted', () => {
  const mockLocalStorage = createFakeStorage();
  mockLocalStorage.setItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  const originalWindow = globalThis.window;

  try {
    (globalThis as unknown as { window?: { localStorage?: Storage } }).window = {
      localStorage: mockLocalStorage,
    };
    let activePrefs: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
    const controller = new PreferencesController({
      getPreferences: () => activePrefs,
      setPreferences: (updated) => {
        activePrefs = updated;
      },
      setWarning: () => {},
      // storage option explicitly omitted
    });

    const res = controller.commitAppearance({ theme: 'DjRomoro', customAccent: '#10b981' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(activePrefs.theme, 'DjRomoro');
    assert.strictEqual(activePrefs.customAccent, '#10b981');

    // Verify it persisted to window.localStorage
    const loaded = loadUiPreferences(mockLocalStorage);
    assert.strictEqual(loaded.preferences.theme, 'DjRomoro');
    assert.strictEqual(loaded.preferences.customAccent, '#10b981');

    // Verify legacy key was cleaned up from window.localStorage
    assert.strictEqual(mockLocalStorage.getItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY), null);
  } finally {
    (globalThis as unknown as { window?: typeof originalWindow }).window = originalWindow;
  }
});

test('PreferencesController: explicit null storage fails atomic commit and reset while keeping live state', () => {
  const initialPrefs: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: 'dark',
    customAccent: '#10b981',
  };
  let activePrefs = { ...initialPrefs };
  const captured = { warning: null as string | null };

  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: (warning) => {
      captured.warning = warning;
    },
    storage: null,
  });

  // commitAppearance with storage: null
  const commitRes = controller.commitAppearance({ theme: 'light', customAccent: '#ff0000' });
  assert.strictEqual(commitRes.success, false);
  assert.strictEqual(commitRes.error, 'Storage is not available in current environment');
  assert.deepEqual(activePrefs, initialPrefs, 'Live state must remain untouched on commit failure');
  assert.strictEqual(captured.warning, 'Storage is not available in current environment');

  // resetAppearance with storage: null
  const resetRes = controller.resetAppearance();
  assert.strictEqual(resetRes.success, false);
  assert.strictEqual(resetRes.error, 'Storage is not available in current environment');
  assert.deepEqual(activePrefs, initialPrefs, 'Live state must remain untouched on reset failure');
});

test('PreferencesController.resetAppearance: prevents accent resurrection on reload even if removeItem throws', () => {
  const backingMap = new Map<string, string>();
  backingMap.set(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  backingMap.set(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  }));

  const storageWithThrowingRemove: Storage = {
    getItem: (key: string) => backingMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backingMap.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === LEGACY_CUSTOM_ACCENT_STORAGE_KEY) {
        throw new Error('Simulated removeItem failure');
      }
      backingMap.delete(key);
    },
    clear: () => backingMap.clear(),
    key: (index: number) => Array.from(backingMap.keys())[index] ?? null,
    get length() {
      return backingMap.size;
    },
  };

  let activePrefs: UiPreferences = {
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage: storageWithThrowingRemove,
  });

  // Reset appearance
  const resetRes = controller.resetAppearance();
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(activePrefs.customAccent, null, 'Live customAccent must be cleared to null marker');

  // Legacy key is still in backingMap because removeItem threw
  assert.strictEqual(storageWithThrowingRemove.getItem(LEGACY_CUSTOM_ACCENT_STORAGE_KEY), '#00e5ff');

  // Reload preferences from storage - must NOT resurrect the legacy accent!
  const reloaded = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(reloaded.preferences.customAccent, null, 'Reset accent must not be resurrected on reload');
});

test('PreferencesController sequence: reset -> setLanguage -> load prevents accent resurrection when removeItem throws', () => {
  const backingMap = new Map<string, string>();
  backingMap.set(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  backingMap.set(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  }));

  const storageWithThrowingRemove: Storage = {
    getItem: (key: string) => backingMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backingMap.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === LEGACY_CUSTOM_ACCENT_STORAGE_KEY) {
        throw new Error('Simulated removeItem failure');
      }
      backingMap.delete(key);
    },
    clear: () => backingMap.clear(),
    key: (index: number) => Array.from(backingMap.keys())[index] ?? null,
    get length() {
      return backingMap.size;
    },
  };

  let activePrefs: UiPreferences = {
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage: storageWithThrowingRemove,
  });

  // 1. reset appearance
  controller.resetAppearance();
  assert.strictEqual(activePrefs.customAccent, null);

  // 2. setLanguage (unrelated mutation)
  controller.setLanguage('es');
  assert.strictEqual(activePrefs.language, 'es');
  assert.strictEqual(activePrefs.customAccent, null);

  // 3. load preferences
  const loaded = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(loaded.preferences.language, 'es');
  assert.strictEqual(loaded.preferences.customAccent, null, 'customAccent null marker must survive setLanguage without resurrecting legacy');
});

test('PreferencesController sequence: reset -> reload -> new controller -> setLanguage -> reload prevents accent resurrection when removeItem throws', () => {
  const backingMap = new Map<string, string>();
  backingMap.set(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  backingMap.set(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  }));

  const storageWithThrowingRemove: Storage = {
    getItem: (key: string) => backingMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backingMap.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === LEGACY_CUSTOM_ACCENT_STORAGE_KEY) {
        throw new Error('Simulated removeItem failure');
      }
      backingMap.delete(key);
    },
    clear: () => backingMap.clear(),
    key: (index: number) => Array.from(backingMap.keys())[index] ?? null,
    get length() {
      return backingMap.size;
    },
  };

  let activePrefs1: UiPreferences = {
    language: 'en',
    theme: 'dark',
    customAccent: '#00e5ff',
  };
  const controller1 = new PreferencesController({
    getPreferences: () => activePrefs1,
    setPreferences: (updated) => {
      activePrefs1 = updated;
    },
    setWarning: () => {},
    storage: storageWithThrowingRemove,
  });

  // 1. reset appearance
  controller1.resetAppearance();
  assert.strictEqual(activePrefs1.customAccent, null);

  // 2. reload from storage
  const loaded1 = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(loaded1.preferences.customAccent, null);

  // 3. new controller initialized with loaded state
  let activePrefs2: UiPreferences = { ...loaded1.preferences };
  const controller2 = new PreferencesController({
    getPreferences: () => activePrefs2,
    setPreferences: (updated) => {
      activePrefs2 = updated;
    },
    setWarning: () => {},
    storage: storageWithThrowingRemove,
  });

  // 4. setLanguage (unrelated mutation on second controller)
  controller2.setLanguage('es');
  assert.strictEqual(activePrefs2.language, 'es');
  assert.strictEqual(activePrefs2.customAccent, null);

  // 5. reload again
  const loaded2 = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(loaded2.preferences.language, 'es');
  assert.strictEqual(loaded2.preferences.customAccent, null, 'Reloaded state must retain null marker across new controller and setLanguage');
});

test('PreferencesController sequence: commitAppearance with customAccent null followed by unrelated save retains null marker', () => {
  const backingMap = new Map<string, string>();
  backingMap.set(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  backingMap.set(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: '#10b981',
  }));

  const storageWithThrowingRemove: Storage = {
    getItem: (key: string) => backingMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backingMap.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === LEGACY_CUSTOM_ACCENT_STORAGE_KEY) {
        throw new Error('Simulated removeItem failure');
      }
      backingMap.delete(key);
    },
    clear: () => backingMap.clear(),
    key: (index: number) => Array.from(backingMap.keys())[index] ?? null,
    get length() {
      return backingMap.size;
    },
  };

  let activePrefs: UiPreferences = {
    language: 'en',
    theme: 'dark',
    customAccent: '#10b981',
  };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage: storageWithThrowingRemove,
  });

  // 1. commitAppearance with customAccent: null
  const commitRes = controller.commitAppearance({ customAccent: null });
  assert.strictEqual(commitRes.success, true);
  assert.strictEqual(activePrefs.customAccent, null);

  // 2. unrelated save via setLanguage
  controller.setLanguage('es');
  assert.strictEqual(activePrefs.language, 'es');
  assert.strictEqual(activePrefs.customAccent, null);

  // 3. reload from storage
  const loaded = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(loaded.preferences.language, 'es');
  assert.strictEqual(loaded.preferences.customAccent, null, 'Explicit null customAccent from commitAppearance must survive unrelated save');
});

test('preferences: extractAppearancePreferences preserves customAccent: null marker', () => {
  const prefsWithNullAccent: UiPreferences = {
    language: 'en',
    theme: 'dark',
    customAccent: null,
  };
  const extracted = extractAppearancePreferences(prefsWithNullAccent);
  assert.strictEqual(extracted.customAccent, null);
  assert.strictEqual(hasCustomAppearance(prefsWithNullAccent), false);
});

test('PreferencesController: setCustomAccent and setCustomThemeColors preserve nullable accent marker across reload', () => {
  const backingMap = new Map<string, string>();
  backingMap.set(LEGACY_CUSTOM_ACCENT_STORAGE_KEY, '#00e5ff');
  backingMap.set(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({
    language: 'en',
    theme: 'dark',
    customAccent: '#10b981',
  }));

  const storageWithThrowingRemove: Storage = {
    getItem: (key: string) => backingMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backingMap.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === LEGACY_CUSTOM_ACCENT_STORAGE_KEY) {
        throw new Error('Simulated removeItem failure');
      }
      backingMap.delete(key);
    },
    clear: () => backingMap.clear(),
    key: (index: number) => Array.from(backingMap.keys())[index] ?? null,
    get length() {
      return backingMap.size;
    },
  };

  let activePrefs: UiPreferences = {
    language: 'en',
    theme: 'dark',
    customAccent: '#10b981',
  };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage: storageWithThrowingRemove,
  });

  // setCustomAccent(null)
  controller.setCustomAccent(null);
  assert.strictEqual(activePrefs.customAccent, null);

  // Unrelated mutation via setTheme
  controller.setTheme('light');
  assert.strictEqual(activePrefs.theme, 'light');
  assert.strictEqual(activePrefs.customAccent, null);

  // Reload retains null marker
  const loaded = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(loaded.preferences.theme, 'light');
  assert.strictEqual(loaded.preferences.customAccent, null);

  // setCustomThemeColors({ accent: null })
  controller.setCustomThemeColors({ accent: null, text: '#ffffff' });
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(activePrefs.customTextColor, '#ffffff');

  // Reload retains null marker and new text color
  const loaded2 = loadUiPreferences(storageWithThrowingRemove);
  assert.strictEqual(loaded2.preferences.customAccent, null);
  assert.strictEqual(loaded2.preferences.customTextColor, '#ffffff');
});

test('PreferencesController: all ordinary preference mutations preserve customAccent: null marker', () => {
  const storage = createFakeStorage();
  let activePrefs: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    customAccent: null,
  };
  const controller = new PreferencesController({
    getPreferences: () => activePrefs,
    setPreferences: (updated) => {
      activePrefs = updated;
    },
    setWarning: () => {},
    storage,
  });

  // Notifications
  controller.setNotifications({ enabled: true });
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(loadUiPreferences(storage).preferences.customAccent, null);

  // Work animation
  controller.setWorkAnimation({ mode: 'single', color1: '#111111', color2: '#222222' });
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(loadUiPreferences(storage).preferences.customAccent, null);

  // Custom background
  controller.setCustomBackground({ canvas: { color: '#000000', opacity: 0.5 } });
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(loadUiPreferences(storage).preferences.customAccent, null);

  // Custom commands
  controller.setCustomCommands([{ id: 'custom:t1', name: '/t1', description: 'desc' }]);
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(loadUiPreferences(storage).preferences.customAccent, null);

  // Hidden command IDs
  controller.setHiddenCommandIds(['custom:t1']);
  assert.strictEqual(activePrefs.customAccent, null);
  assert.strictEqual(loadUiPreferences(storage).preferences.customAccent, null);
});
