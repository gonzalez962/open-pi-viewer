import assert from 'node:assert';
import test from 'node:test';

import {
  DEFAULT_LOCALE,
  dictionaries,
  formatLocalizedDiagnostic,
  formatLocalizedStatus,
  formatLocalizedStatusDetail,
  isSupportedLocale,
  setDocumentLanguage,
  SUPPORTED_LOCALES,
  translate,
  type TranslationKey,
} from '@shared/i18n';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';
import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  saveUiPreferences,
  UI_PREFERENCES_STORAGE_KEY,
  validateUiPreferences,
  type UiPreferences,
} from '@infra/preferences';
import {
  applyTheme,
  BUILTIN_THEMES,
  DEFAULT_THEME,
  getSystemPreferredTheme,
  isAppTheme,
  resolveTheme,
  SUPPORTED_THEMES,
  watchSystemTheme,
  type ResolvedTheme,
} from '@shared/theme';
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG, loadConnectConfig } from '@features/settings/config';

/**
 * Creates an in-memory Storage implementation for isolated unit testing.
 */
function createMockStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
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
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

/**
 * Creates a throwing Storage mock for testing fault-tolerance and error reporting.
 */
function createThrowingStorage(fault: 'getItem' | 'setItem'): Storage {
  return {
    getItem: () => {
      if (fault === 'getItem') {
        throw new Error('Simulated localStorage read SecurityError');
      }
      return null;
    },
    setItem: () => {
      if (fault === 'setItem') {
        throw new Error('Simulated localStorage QuotaExceededError');
      }
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Dictionary Structure and Key Parity
// ---------------------------------------------------------------------------

test('i18n: en.json and es.json maintain complete key parity', () => {
  const enKeys = Object.keys(enJson).sort();
  const esKeys = Object.keys(esJson).sort();

  assert.strictEqual(
    enKeys.length,
    esKeys.length,
    `Key counts differ: en has ${enKeys.length}, es has ${esKeys.length}`
  );

  const missingInEs = enKeys.filter((k) => !esKeys.includes(k));
  const missingInEn = esKeys.filter((k) => !enKeys.includes(k));

  assert.deepStrictEqual(
    missingInEs,
    [],
    `Keys present in en.json but missing in es.json: ${missingInEs.join(', ')}`
  );
  assert.deepStrictEqual(
    missingInEn,
    [],
    `Keys present in es.json but missing in en.json: ${missingInEn.join(', ')}`
  );

  assert.deepStrictEqual(enKeys, esKeys);
});

test('i18n: all dictionary entries are non-empty strings', () => {
  for (const [key, value] of Object.entries(enJson)) {
    assert.strictEqual(
      typeof value,
      'string',
      `en.json key '${key}' must be a string`
    );
    assert.ok(
      value.trim().length > 0,
      `en.json key '${key}' must not be empty or blank`
    );
  }

  for (const [key, value] of Object.entries(esJson)) {
    assert.strictEqual(
      typeof value,
      'string',
      `es.json key '${key}' must be a string`
    );
    assert.ok(
      value.trim().length > 0,
      `es.json key '${key}' must not be empty or blank`
    );
  }
});

test('i18n: supported locales list includes en and es with en as default', () => {
  assert.deepStrictEqual(SUPPORTED_LOCALES, ['en', 'es']);
  assert.strictEqual(DEFAULT_LOCALE, 'en');
  assert.strictEqual(isSupportedLocale('en'), true);
  assert.strictEqual(isSupportedLocale('es'), true);
  assert.strictEqual(isSupportedLocale('fr'), false);
  assert.strictEqual(isSupportedLocale(null), false);
  assert.strictEqual(isSupportedLocale(undefined), false);
});

// ---------------------------------------------------------------------------
// 2. Translation Lookup and Fallback Mechanics
// ---------------------------------------------------------------------------

test('i18n: translates keys directly in requested locale', () => {
  assert.strictEqual(translate('en', 'action.retry'), 'Retry');
  assert.strictEqual(translate('es', 'action.retry'), 'Reintentar');
  assert.strictEqual(translate('en', 'status.connected'), 'Connected');
  assert.strictEqual(translate('es', 'status.connected'), 'Conectado');
});

test('i18n: falls back to English when translation in Spanish is missing or blank', () => {
  // Simulate a custom dictionary with missing and blank keys
  const originalEs = dictionaries.es;
  try {
    dictionaries.es = {
      ...originalEs,
      'action.retry': '', // Blank translation in Spanish
    };
    delete (dictionaries.es as Record<string, string>)['action.new']; // Missing in Spanish

    // Blank value in Spanish should fall back to English 'Retry'
    assert.strictEqual(translate('es', 'action.retry'), 'Retry');

    // Missing key in Spanish should fall back to English 'New'
    assert.strictEqual(translate('es', 'action.new'), 'New');
  } finally {
    dictionaries.es = originalEs;
  }
});

test('i18n: falls back to raw key name when key is missing in all dictionaries', () => {
  const nonExistentKey = 'non.existent.key' as TranslationKey;
  assert.strictEqual(translate('en', nonExistentKey), 'non.existent.key');
  assert.strictEqual(translate('es', nonExistentKey), 'non.existent.key');
});

test('i18n: interpolates parameters safely without HTML execution', () => {
  const res = translate('en', 'status.detail_resumed_session', { count: 5 });
  assert.strictEqual(res, 'Resumed session (5 messages)');

  const resEs = translate('es', 'status.detail_resumed_session', { count: 12 });
  assert.strictEqual(resEs, 'Sesión reanudada (12 mensajes)');

  // Test HTML-like strings are treated strictly as plaintext
  const injection = '<script>alert(1)</script>';
  const interpolated = translate('en', 'prompt.status_tag', {
    status: injection,
  });
  assert.strictEqual(interpolated, 'Status: <script>alert(1)</script>');

  // Missing parameter preserves placeholder safely without throwing
  const missingParam = translate('en', 'status.detail_resumed_session', {});
  assert.strictEqual(missingParam, 'Resumed session ({count} messages)');
});

// ---------------------------------------------------------------------------
// 3. Status and Detail Presentation Mapping (Contract Preservation)
// ---------------------------------------------------------------------------

test('i18n: formatLocalizedStatus maps connection states and agent activity accurately', () => {
  assert.strictEqual(formatLocalizedStatus('disconnected', 'idle', 'en'), 'Disconnected');
  assert.strictEqual(formatLocalizedStatus('disconnected', 'idle', 'es'), 'Desconectado');

  assert.strictEqual(formatLocalizedStatus('connecting', 'idle', 'en'), 'Connecting');
  assert.strictEqual(formatLocalizedStatus('connecting', 'idle', 'es'), 'Conectando');

  assert.strictEqual(formatLocalizedStatus('connected', 'idle', 'en'), 'Connected');
  assert.strictEqual(formatLocalizedStatus('connected', 'idle', 'es'), 'Conectado');

  assert.strictEqual(formatLocalizedStatus('connected', 'busy', 'en'), 'Generating');
  assert.strictEqual(formatLocalizedStatus('connected', 'busy', 'es'), 'Generando');

  assert.strictEqual(formatLocalizedStatus('error', 'idle', 'en'), 'Error');
  assert.strictEqual(formatLocalizedStatus('error', 'idle', 'es'), 'Error');
});

test('i18n: formatLocalizedStatusDetail maps known descriptions and preserves technical errors verbatim', () => {
  // Known static descriptions
  assert.strictEqual(
    formatLocalizedStatusDetail(
      'Pi RPC process offline — configure and click Connect',
      'en'
    ),
    'Pi RPC process offline — configure and click Connect'
  );
  assert.strictEqual(
    formatLocalizedStatusDetail(
      'Pi RPC process offline — configure and click Connect',
      'es'
    ),
    'Proceso RPC de Pi sin conexión — configure y haga clic en Conectar'
  );

  assert.strictEqual(
    formatLocalizedStatusDetail('Spawning Pi RPC subprocess...', 'es'),
    'Iniciando subproceso RPC de Pi...'
  );

  assert.strictEqual(
    formatLocalizedStatusDetail('Connected to fresh session', 'es'),
    'Conectado a una sesión nueva'
  );

  // Dynamic resumed session pattern
  assert.strictEqual(
    formatLocalizedStatusDetail('Resumed session (42 messages)', 'es'),
    'Sesión reanudada (42 mensajes)'
  );

  // External technical error strings are preserved verbatim without corruption
  const technicalDiagnostic =
    'Node process exited with code 1: Cannot find module dist/cli.js';
  assert.strictEqual(
    formatLocalizedStatusDetail(technicalDiagnostic, 'es'),
    technicalDiagnostic
  );

  const rawBridgeTimeout = 'IPC command timeout after 30000ms';
  assert.strictEqual(
    formatLocalizedStatusDetail(rawBridgeTimeout, 'es'),
    rawBridgeTimeout
  );

  assert.strictEqual(formatLocalizedStatusDetail('', 'es'), '');
});

test('i18n: setDocumentLanguage updates document element lang attribute safely', () => {
  const fakeDoc = {
    documentElement: { lang: '' },
  };

  const originalDoc = (globalThis as unknown as { document?: typeof fakeDoc }).document;
  try {
    (globalThis as unknown as { document?: typeof fakeDoc }).document = fakeDoc;

    setDocumentLanguage('es');
    assert.strictEqual(fakeDoc.documentElement.lang, 'es');

    setDocumentLanguage('en');
    assert.strictEqual(fakeDoc.documentElement.lang, 'en');
  } finally {
    (globalThis as unknown as { document?: typeof fakeDoc }).document = originalDoc;
  }
});

// ---------------------------------------------------------------------------
// 4. Themes: Tokens, Resolution, and StrictMode-safe Media Watcher
// ---------------------------------------------------------------------------

test('theme: supported themes include dark, light, and system with dark as default', () => {
  assert.deepStrictEqual(BUILTIN_THEMES, ['dark', 'light', 'system']);
  assert.strictEqual(DEFAULT_THEME, 'dark');
  assert.ok(SUPPORTED_THEMES.includes('DjRomoro'));
  assert.strictEqual(isAppTheme('dark'), true);
  assert.strictEqual(isAppTheme('light'), true);
  assert.strictEqual(isAppTheme('system'), true);
  assert.strictEqual(isAppTheme('DjRomoro'), true);
  assert.strictEqual(isAppTheme('solarized'), false);
  assert.strictEqual(isAppTheme(null), false);
});

test('theme: resolveTheme resolves dark, light, and system with explicit fallback', () => {
  // Explicit dark always resolves to dark
  assert.strictEqual(resolveTheme('dark'), 'dark');
  assert.strictEqual(resolveTheme('dark', 'light'), 'dark');

  // Explicit light always resolves to light
  assert.strictEqual(resolveTheme('light'), 'light');
  assert.strictEqual(resolveTheme('light', 'dark'), 'light');

  // System follows system-preferred parameter
  assert.strictEqual(resolveTheme('system', 'dark'), 'dark');
  assert.strictEqual(resolveTheme('system', 'light'), 'light');
});

test('theme: getSystemPreferredTheme defaults to dark when matchMedia is absent', () => {
  assert.strictEqual(getSystemPreferredTheme(undefined), 'dark');
  assert.strictEqual(getSystemPreferredTheme({ matchMedia: undefined as unknown as (q: string) => MediaQueryList }), 'dark');
});

test('theme: getSystemPreferredTheme queries prefers-color-scheme accurately', () => {
  const darkWin = {
    matchMedia: (query: string) =>
      ({
        matches: query.includes('dark'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList,
  };
  assert.strictEqual(getSystemPreferredTheme(darkWin), 'dark');

  const lightWin = {
    matchMedia: () =>
      ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList,
  };
  assert.strictEqual(getSystemPreferredTheme(lightWin), 'light');
});

test('theme: applyTheme sets data-theme attribute and colorScheme property without CSS injection', () => {
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

  // Gracefully handles null element
  assert.doesNotThrow(() => applyTheme('dark', null));
});

test('theme: watchSystemTheme registers listener and cleanup function removes it cleanly (StrictMode-safe)', () => {
  const holder = {
    listener: null as (((e: { matches: boolean }) => void) | null),
  };
  let addCalls = 0;
  let removeCalls = 0;

  const mockMql = {
    addEventListener: (_type: string, listener: EventListener) => {
      addCalls++;
      holder.listener = listener as unknown as (e: { matches: boolean }) => void;
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      removeCalls++;
      if (holder.listener === (listener as unknown)) {
        holder.listener = null;
      }
    },
  };

  const mockWindow = {
    matchMedia: () => mockMql as unknown as MediaQueryList,
  } as unknown as Window;

  const observedThemes: ResolvedTheme[] = [];
  const cleanup = watchSystemTheme((theme) => {
    observedThemes.push(theme);
  }, mockWindow);

  assert.strictEqual(addCalls, 1, 'addEventListener must be invoked once on registration');
  assert.ok(holder.listener !== null, 'Listener must be registered');

  // Simulate system color scheme change to light
  holder.listener!({ matches: false });
  assert.deepStrictEqual([...observedThemes], ['light']);

  // Simulate system color scheme change back to dark
  holder.listener!({ matches: true });
  assert.deepStrictEqual([...observedThemes], ['light', 'dark']);

  // Cleanup invocation (as performed by useEffect unmount)
  cleanup();
  assert.strictEqual(removeCalls, 1, 'removeEventListener must be invoked once on cleanup');
  assert.strictEqual(holder.listener, null, 'Listener reference must be cleared');

  // Idempotent cleanup is safe
  assert.doesNotThrow(() => cleanup());
});

test('theme: watchSystemTheme supports legacy addListener/removeListener interfaces', () => {
  const holder = {
    cb: null as (((e: { matches: boolean }) => void) | null),
  };
  let addCalls = 0;
  let removeCalls = 0;

  const mockLegacyMql = {
    addListener: (cb: (e: { matches: boolean }) => void) => {
      addCalls++;
      holder.cb = cb;
    },
    removeListener: (cb: (e: { matches: boolean }) => void) => {
      removeCalls++;
      if (holder.cb === cb) holder.cb = null;
    },
  };

  const mockWindow = {
    matchMedia: () => mockLegacyMql as unknown as MediaQueryList,
  } as unknown as Window;

  const observedThemes: ResolvedTheme[] = [];
  const cleanup = watchSystemTheme((theme) => {
    observedThemes.push(theme);
  }, mockWindow);

  assert.strictEqual(addCalls, 1);
  assert.ok(holder.cb !== null);
  holder.cb!({ matches: false });
  assert.deepStrictEqual([...observedThemes], ['light']);

  cleanup();
  assert.strictEqual(removeCalls, 1);
  assert.strictEqual(holder.cb, null);
});

// ---------------------------------------------------------------------------
// 5. Preferences: Schema Validation, Storage, Error Handling
// ---------------------------------------------------------------------------

test('preferences: validateUiPreferences returns valid for compliant payload', () => {
  const valid: UiPreferences = { language: 'es', theme: 'light' };
  const res = validateUiPreferences(valid);

  assert.strictEqual(res.valid, true);
  assert.deepStrictEqual(res.preferences, { language: 'es', theme: 'light' });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.warning, undefined);
});

test('preferences: validateUiPreferences rejects non-object inputs with honest defaults', () => {
  for (const input of [null, undefined, 'string', 123, []]) {
    const res = validateUiPreferences(input);
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.preferences, DEFAULT_UI_PREFERENCES);
    assert.ok(res.error?.includes('object'));
  }
});

test('preferences: validateUiPreferences sanitizes invalid fields with defaults and warnings', () => {
  const invalid = { language: 'de', theme: 'neon' };
  const res = validateUiPreferences(invalid);

  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.preferences.language, 'en');
  assert.strictEqual(res.preferences.theme, 'dark');
  assert.ok(res.warning?.includes('de'));
  assert.ok(res.warning?.includes('neon'));
});

test('preferences: loadUiPreferences returns defaults when storage is empty', () => {
  const storage = createMockStorage();
  const res = loadUiPreferences(storage);

  assert.deepStrictEqual(res.preferences, DEFAULT_UI_PREFERENCES);
  assert.strictEqual(res.warning, undefined);
});

test('preferences: loadUiPreferences handles corrupted JSON with defaults and honest warning', () => {
  const storage = createMockStorage({
    [UI_PREFERENCES_STORAGE_KEY]: 'corrupted-{{json',
  });
  const res = loadUiPreferences(storage);

  assert.deepStrictEqual(res.preferences, DEFAULT_UI_PREFERENCES);
  assert.ok(res.warning?.includes('invalid JSON'));
});

test('preferences: loadUiPreferences handles storage read throws without crashing', () => {
  const throwingStorage = createThrowingStorage('getItem');
  const res = loadUiPreferences(throwingStorage);

  assert.deepStrictEqual(res.preferences, DEFAULT_UI_PREFERENCES);
  assert.ok(res.warning?.includes('Failed to read UI preferences'));
});

test('preferences: saveUiPreferences persists valid preferences and roundtrips accurately', () => {
  const storage = createMockStorage();
  const toSave: UiPreferences = { language: 'es', theme: 'light' };

  const saveRes = saveUiPreferences(toSave, storage);
  assert.strictEqual(saveRes.success, true);

  const loadRes = loadUiPreferences(storage);
  assert.deepStrictEqual(loadRes.preferences, toSave);
  assert.strictEqual(loadRes.warning, undefined);
});

test('preferences: saveUiPreferences handles storage write throws with descriptive error', () => {
  const throwingStorage = createThrowingStorage('setItem');
  const toSave: UiPreferences = { language: 'es', theme: 'system' };

  const saveRes = saveUiPreferences(toSave, throwingStorage);
  assert.strictEqual(saveRes.success, false);
  assert.ok(saveRes.error?.includes('Failed to persist UI preferences'));
});

test('preferences: saveUiPreferences rejects missing storage environment cleanly', () => {
  const saveRes = saveUiPreferences(DEFAULT_UI_PREFERENCES, null);
  assert.strictEqual(saveRes.success, false);
  assert.ok(saveRes.error?.includes('not available'));
});

// ---------------------------------------------------------------------------
// 6. Isolation: No Connection Side Effects
// ---------------------------------------------------------------------------

test('isolation: UI preferences and connection configuration use independent storage keys', () => {
  const storage = createMockStorage();

  // Save UI preferences
  saveUiPreferences({ language: 'es', theme: 'light' }, storage);

  // Verify connection config storage was not touched or corrupted
  assert.strictEqual(storage.getItem(CONFIG_STORAGE_KEY), null);
  const connectLoaded = loadConnectConfig(storage);
  assert.deepStrictEqual(connectLoaded.config, DEFAULT_CONFIG);

  // Save connection config
  storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(DEFAULT_CONFIG));

  // Verify UI preferences remain intact
  const uiLoaded = loadUiPreferences(storage);
  assert.deepStrictEqual(uiLoaded.preferences, {
    language: 'es',
    theme: 'light',
  });
});

// ---------------------------------------------------------------------------
// 7. App-Owned Diagnostics Presentation Mapping
// ---------------------------------------------------------------------------

test('i18n: formatLocalizedDiagnostic maps predictable app-owned validation errors to localized text', () => {
  // Empty field validations
  assert.strictEqual(
    formatLocalizedDiagnostic('Node executable path cannot be empty', 'es'),
    'La ruta del ejecutable de Node no puede estar vacía'
  );
  assert.strictEqual(
    formatLocalizedDiagnostic('Working directory path cannot be empty', 'es'),
    'La ruta del directorio de trabajo no puede estar vacía'
  );
  assert.strictEqual(
    formatLocalizedDiagnostic('Pi CLI entrypoint path cannot be empty', 'es'),
    'La ruta del punto de entrada del CLI de Pi no puede estar vacía'
  );
  assert.strictEqual(
    formatLocalizedDiagnostic('Configuration must be a non-null object', 'es'),
    'La configuración debe ser un objeto no nulo'
  );

  // Parameterized path validations
  assert.strictEqual(
    formatLocalizedDiagnostic("Pi entrypoint must be an absolute path: 'relative/cli.js'", 'es'),
    "El punto de entrada de Pi debe ser una ruta absoluta: 'relative/cli.js'"
  );
  assert.strictEqual(
    formatLocalizedDiagnostic("Working directory must be an absolute path: './project'", 'es'),
    "El directorio de trabajo debe ser una ruta absoluta: './project'"
  );
  assert.strictEqual(
    formatLocalizedDiagnostic(
      "Pi entrypoint must have a JavaScript extension (.js, .mjs, .cjs), got: 'C:\\pi\\cli.txt'",
      'es'
    ),
    "El punto de entrada de Pi debe tener una extensión JavaScript (.js, .mjs, .cjs); se obtuvo: 'C:\\pi\\cli.txt'"
  );
});

test('i18n: formatLocalizedDiagnostic maps predictable config storage warnings and preserves external details', () => {
  assert.strictEqual(
    formatLocalizedDiagnostic(
      'Corrupted configuration in storage; falling back to workstation defaults',
      'es'
    ),
    'Configuración dañada en el almacenamiento; recurriendo a los valores predeterminados de la estación de trabajo'
  );

  assert.strictEqual(
    formatLocalizedDiagnostic(
      'Local storage unavailable; using workstation defaults',
      'es'
    ),
    'Almacenamiento local no disponible; usando valores predeterminados de la estación de trabajo'
  );

  // Preserves external error details in {error}
  const accessWarning = 'Storage access failed (SecurityError: Access is denied); using workstation defaults';
  assert.strictEqual(
    formatLocalizedDiagnostic(accessWarning, 'es'),
    'Falló el acceso al almacenamiento (SecurityError: Access is denied); usando valores predeterminados de la estación de trabajo'
  );

  // Preserves missing fields in {fields}
  const partialWarning =
    'Partial configuration in storage missing required fields (nodePath, piEntrypoint); using workstation defaults';
  assert.strictEqual(
    formatLocalizedDiagnostic(partialWarning, 'es'),
    'Configuración parcial en almacenamiento faltan campos obligatorios (nodePath, piEntrypoint); usando valores predeterminados de la estación de trabajo'
  );
});

test('i18n: formatLocalizedDiagnostic maps nested validation errors inside config load warnings', () => {
  const nestedError =
    'Stored configuration is invalid (Working directory path cannot be empty); using workstation defaults';
  assert.strictEqual(
    formatLocalizedDiagnostic(nestedError, 'es'),
    'La configuración guardada no es válida (La ruta del directorio de trabajo no puede estar vacía); usando valores predeterminados de la estación de trabajo'
  );
});

test('i18n: formatLocalizedDiagnostic maps UI preference storage and validation warnings', () => {
  assert.strictEqual(
    formatLocalizedDiagnostic(
      'Stored UI preferences contained invalid JSON; defaulted to English and dark theme',
      'es'
    ),
    'Las preferencias guardadas contenían JSON no válido; se restablecieron a inglés y tema oscuro'
  );

  // Single preference warning
  assert.strictEqual(
    formatLocalizedDiagnostic("Invalid language 'fr'; defaulted to 'en'", 'es'),
    "Idioma no válido 'fr'; se restableció a 'en'"
  );

  // Compound preference warnings joined by semicolon
  const compound = "Invalid language 'it'; defaulted to 'en'; Invalid theme 'neon'; defaulted to 'dark'";
  assert.strictEqual(
    formatLocalizedDiagnostic(compound, 'es'),
    "Idioma no válido 'it'; se restableció a 'en'; Tema no válido 'neon'; se restableció a 'dark'"
  );
});

test('i18n: formatLocalizedDiagnostic preserves arbitrary Native/Pi technical error strings verbatim', () => {
  const nativeExitError = 'Node process exited with code 1: Cannot find module dist/cli.js';
  assert.strictEqual(formatLocalizedDiagnostic(nativeExitError, 'es'), nativeExitError);

  const ipcTimeout = 'Tauri IPC command timeout after 30000ms';
  assert.strictEqual(formatLocalizedDiagnostic(ipcTimeout, 'es'), ipcTimeout);

  const rustPanic = 'panicked at src/process.rs:42:10';
  assert.strictEqual(formatLocalizedDiagnostic(rustPanic, 'es'), rustPanic);
});

test('i18n: settings providers and custom providers keys interpolate and match in en and es', () => {
  const enAddTitle = translate('en', 'providers.modal_edit_title', { id: 'ollama' });
  const esAddTitle = translate('es', 'providers.modal_edit_title', { id: 'ollama' });
  assert.strictEqual(enAddTitle, 'Edit Provider: ollama');
  assert.strictEqual(esAddTitle, 'Editar proveedor: ollama');

  const enModels = translate('en', 'providers.models_heading', { count: 3 });
  const esModels = translate('es', 'providers.models_heading', { count: 3 });
  assert.strictEqual(enModels, 'Models (3)');
  assert.strictEqual(esModels, 'Modelos (3)');

  const enNotice = translate('en', 'providers.notice_added', { id: 'test' });
  const esNotice = translate('es', 'providers.notice_added', { id: 'test' });
  assert.strictEqual(enNotice, "Provider 'test' added successfully");
  assert.strictEqual(esNotice, "Proveedor 'test' agregado con éxito");
});

