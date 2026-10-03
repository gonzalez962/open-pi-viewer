import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTheme,
  BUILTIN_THEMES,
  CUSTOM_THEMES,
  DEFAULT_THEME,
  getSystemPreferredTheme,
  isAppTheme,
  resolveTheme,
  SUPPORTED_THEMES,
  watchSystemTheme,
  type CustomThemeId,
} from '@shared/theme';

test('theme: supported themes include built-in themes and all PR custom presets', () => {
  assert.deepStrictEqual(BUILTIN_THEMES, ['dark', 'light', 'system']);
  assert.strictEqual(DEFAULT_THEME, 'dark');

  const expectedPresets: CustomThemeId[] = [
    'DjRomoro',
    'arch-electric',
    'Gentleman-Sexy-Djr',
    'Minimalist-Ninja',
  ];
  assert.deepStrictEqual(CUSTOM_THEMES, expectedPresets);
  assert.deepStrictEqual(SUPPORTED_THEMES, [...BUILTIN_THEMES, ...CUSTOM_THEMES]);

  // Built-in guards
  assert.strictEqual(isAppTheme('dark'), true);
  assert.strictEqual(isAppTheme('light'), true);
  assert.strictEqual(isAppTheme('system'), true);

  // Custom preset guards
  for (const preset of expectedPresets) {
    assert.strictEqual(isAppTheme(preset), true, `Theme preset '${preset}' must be recognized`);
  }

  // Reject unsupported themes
  assert.strictEqual(isAppTheme('solarized'), false);
  assert.strictEqual(isAppTheme(''), false);
  assert.strictEqual(isAppTheme(null), false);
  assert.strictEqual(isAppTheme(undefined), false);
  assert.strictEqual(isAppTheme(123), false);
});

test('theme: resolveTheme resolves built-in and custom presets correctly', () => {
  // Builtin dark and light
  assert.strictEqual(resolveTheme('dark'), 'dark');
  assert.strictEqual(resolveTheme('light'), 'light');

  // System follows system preferred parameter
  assert.strictEqual(resolveTheme('system', 'dark'), 'dark');
  assert.strictEqual(resolveTheme('system', 'light'), 'light');

  // Custom presets resolve to their respective IDs
  assert.strictEqual(resolveTheme('DjRomoro'), 'DjRomoro');
  assert.strictEqual(resolveTheme('arch-electric'), 'arch-electric');
  assert.strictEqual(resolveTheme('Gentleman-Sexy-Djr'), 'Gentleman-Sexy-Djr');
  assert.strictEqual(resolveTheme('Minimalist-Ninja'), 'Minimalist-Ninja');
});

test('theme: getSystemPreferredTheme defaults to dark and inspects media query', () => {
  assert.strictEqual(getSystemPreferredTheme(undefined), 'dark');
  const mockLightWindow = {
    matchMedia: () =>
      ({
        matches: false,
      }) as unknown as MediaQueryList,
  };
  assert.strictEqual(getSystemPreferredTheme(mockLightWindow), 'light');

  const mockDarkWindow = {
    matchMedia: (query: string) =>
      ({
        matches: query.includes('dark'),
      }) as unknown as MediaQueryList,
  };
  assert.strictEqual(getSystemPreferredTheme(mockDarkWindow), 'dark');
});

test('theme: applyTheme sets data-theme attribute and dark colorScheme for custom presets', () => {
  const root = {
    dataTheme: '',
    style: { colorScheme: '' },
    setAttribute(name: string, value: string) {
      if (name === 'data-theme') this.dataTheme = value;
    },
  };

  applyTheme('dark', root);
  assert.strictEqual(root.dataTheme, 'dark');
  assert.strictEqual(root.style.colorScheme, 'dark');

  applyTheme('light', root);
  assert.strictEqual(root.dataTheme, 'light');
  assert.strictEqual(root.style.colorScheme, 'light');

  // Custom presets use dark colorScheme natively
  applyTheme('DjRomoro', root);
  assert.strictEqual(root.dataTheme, 'DjRomoro');
  assert.strictEqual(root.style.colorScheme, 'dark');

  applyTheme('Minimalist-Ninja', root);
  assert.strictEqual(root.dataTheme, 'Minimalist-Ninja');
  assert.strictEqual(root.style.colorScheme, 'dark');
});

test('theme: watchSystemTheme registers listener and cleans up safely', () => {
  let addListenerCalled = false;
  let removeListenerCalled = false;

  const mockMql = {
    matches: false,
    addEventListener: () => {
      addListenerCalled = true;
    },
    removeEventListener: () => {
      removeListenerCalled = true;
    },
  };

  const mockWindow = {
    matchMedia: () => mockMql as unknown as MediaQueryList,
  } as unknown as Window;

  const cleanup = watchSystemTheme(() => {}, mockWindow);
  assert.strictEqual(addListenerCalled, true);
  cleanup();
  assert.strictEqual(removeListenerCalled, true);
});
