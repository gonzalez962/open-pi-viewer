import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  handleIpcCommand,
  setPiAgentDirForTest,
} from '@server/web-ipc-bridge';
import { getEnabledModelsPi } from '@infra/bridge';

function createIsolatedFixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-enabled-models-test-'));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  setPiAgentDirForTest(agentDir);

  const settingsPath = path.join(agentDir, 'settings.json');
  const modelsPath = path.join(agentDir, 'models.json');

  const writeSettings = (val: unknown) =>
    fs.writeFileSync(settingsPath, JSON.stringify(val, null, 2) + '\n', 'utf8');
  const readSettingsRaw = () => fs.readFileSync(settingsPath, 'utf8');

  const writeModels = (val: unknown) =>
    fs.writeFileSync(modelsPath, JSON.stringify(val, null, 2) + '\n', 'utf8');
  const readModelsJson = () => JSON.parse(fs.readFileSync(modelsPath, 'utf8'));

  return {
    root,
    agentDir,
    settingsPath,
    modelsPath,
    writeSettings,
    readSettingsRaw,
    writeModels,
    readModelsJson,
    cleanup() {
      setPiAgentDirForTest(null);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

test('S2.3 — Given settings.json, when get_enabled_models is called, then patterns are returned without modifying the file', async () => {
  const f = createIsolatedFixture();
  try {
    const originalSettings = {
      theme: 'dark',
      defaultProvider: 'anthropic',
      enabledModels: ['anthropic/*', 'openai/gpt-4o', '*sonnet*'],
      modelThinkingLevels: { 'anthropic/claude-3-5-sonnet': 'high' },
    };
    f.writeSettings(originalSettings);
    const bytesBefore = f.readSettingsRaw();

    const result = await handleIpcCommand('get_enabled_models');
    assert.deepEqual(result, ['anthropic/*', 'openai/gpt-4o', '*sonnet*'], 'Must return exact enabledModels array');

    // Read-only guarantee: file on disk must be identical byte-for-byte
    assert.equal(f.readSettingsRaw(), bytesBefore, 'settings.json must NOT be modified when reading enabledModels (S2.3)');
  } finally {
    f.cleanup();
  }
});

test('S2.3 — Given missing enabledModels in settings.json, get_enabled_models returns empty array without error', async () => {
  const f = createIsolatedFixture();
  try {
    f.writeSettings({ theme: 'light' });
    const bytesBefore = f.readSettingsRaw();

    const result = await handleIpcCommand('get_enabled_models');
    assert.deepEqual(result, [], 'Must return empty array when enabledModels is absent');
    assert.equal(f.readSettingsRaw(), bytesBefore, 'settings.json must NOT be modified');
  } finally {
    f.cleanup();
  }
});

test('S2.3 — Given nonexistent settings.json, get_enabled_models returns empty array without throwing or creating file', async () => {
  const f = createIsolatedFixture();
  try {
    const result = await handleIpcCommand('get_enabled_models');
    assert.deepEqual(result, []);
    assert.equal(fs.existsSync(f.settingsPath), false, 'Must not create settings.json');
  } finally {
    f.cleanup();
  }
});

test('S1.3 — upsert_custom_provider accepts built-in provider override without baseUrl/api and persists to models.json preserving unrelated config', async () => {
  const f = createIsolatedFixture();
  try {
    // Seed models.json with existing custom provider and other root keys
    const seed = {
      unrelatedKey: 'preserveMe',
      providers: {
        existingCustom: {
          baseUrl: 'https://api.custom.com/v1',
          api: 'openai-completions',
          models: [{ id: 'custom-1', name: 'Custom One' }],
        },
      },
    };
    f.writeModels(seed);

    // Built-in provider payload has NO baseUrl, NO api, NO apiKey
    const builtinPayload = {
      provider: {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'claude-3-5-sonnet-20241022',
            contextWindow: 200000,
          },
        ],
        excludedModels: ['claude-3-haiku*'],
        includedModels: ['claude-3*'],
      },
    };

    const result: any = await handleIpcCommand('upsert_custom_provider', builtinPayload);
    assert.ok(result, 'upsert_custom_provider must succeed');

    const updated = f.readModelsJson();
    assert.equal(updated.unrelatedKey, 'preserveMe', 'Unrelated root keys must be preserved');
    assert.ok(updated.providers.existingCustom, 'Existing custom provider must be preserved');
    assert.equal(updated.providers.existingCustom.baseUrl, 'https://api.custom.com/v1');

    // Built-in provider entry
    const savedBuiltin = updated.providers.anthropic;
    assert.ok(savedBuiltin, 'Built-in provider must be saved in providers');
    assert.equal(savedBuiltin.baseUrl, undefined, 'Must NOT persist baseUrl for built-in provider');
    assert.equal(savedBuiltin.api, undefined, 'Must NOT persist api protocol for built-in provider');
    assert.equal(savedBuiltin.apiKey, undefined, 'Must NOT persist fake apiKey');
    assert.deepEqual(savedBuiltin.excludedModels, ['claude-3-haiku*']);
    assert.deepEqual(savedBuiltin.includedModels, ['claude-3*']);
    assert.equal(savedBuiltin.models.length, 1);
    assert.equal(savedBuiltin.models[0].id, 'claude-3-5-sonnet-20241022');
    assert.equal(savedBuiltin.models[0].contextWindow, 200000);
  } finally {
    f.cleanup();
  }
});

test('S1.3 — pattern-only built-in override produces models.json accepted by installed Pi ModelRuntime composer', async () => {
  const f = createIsolatedFixture();
  try {
    const patternOnlyPayload = {
      provider: {
        id: 'anthropic',
        name: 'Anthropic',
        models: [],
        excludedModels: ['claude-3-haiku*'],
        includedModels: ['claude-3*'],
      },
    };

    await handleIpcCommand('upsert_custom_provider', patternOnlyPayload);

    // Verify directly with real installed Pi ModelConfig and composeModelProvider
    const agentPackageDir =
      'C:/Users/Personal/AppData/Local/pnpm/global/v11/9530-18dc61ef1941f0dc-0/node_modules/.pnpm/@earendil-works+pi-coding-a_c19e4ab82a0def5cb171f1af9a1d8b62/node_modules/@earendil-works/pi-coding-agent';
    if (!fs.existsSync(agentPackageDir)) {
      return;
    }
    const { pathToFileURL } = await import('node:url');
    const { ModelConfig } = await import(pathToFileURL(path.join(agentPackageDir, 'dist/core/model-config.js')).href);
    const { composeModelProvider } = await import(pathToFileURL(path.join(agentPackageDir, 'dist/core/provider-composer.js')).href);

    const config = await ModelConfig.load(f.modelsPath);
    assert.equal(config.error, undefined, 'ModelConfig.load must not produce error');

    const baseProvider = {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      auth: { apiKey: { type: 'api-key', getApiKey: () => 'test' } },
      getModels: () => [{ id: 'claude-3-5-sonnet', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }],
    };

    // This MUST not throw: "Provider anthropic: must specify baseUrl, headers, compat, modelOverrides, or models"
    const composed = composeModelProvider('anthropic', baseProvider as any, config, undefined);
    assert.ok(composed, 'composeModelProvider must succeed for pattern-only built-in override');
    assert.equal(composed.getModels().length, 1);
  } finally {
    f.cleanup();
  }
});

test('R3-001 — getEnabledModelsPi routes to server get_enabled_models IPC in web-shim mode with default invoke', async () => {
  const f = createIsolatedFixture();
  try {
    f.writeSettings({
      enabledModels: ['anthropic/*', 'openai/gpt-4o'],
    });

    const origWindow = (globalThis as any).window;
    const origIsTauri = (globalThis as any).isTauri;

    let calledCmd: string | null = null;
    (globalThis as any).isTauri = false;
    (globalThis as any).window = {
      __IS_WEB_IPC__: true,
      __TAURI_INTERNALS__: {
        __isWebIpc: true,
        invoke: async (cmd: string, args: any) => {
          calledCmd = cmd;
          return await handleIpcCommand(cmd, args);
        },
      },
      localStorage: {
        getItem: () => JSON.stringify(['mock-should-not-be-called']),
      },
    };

    try {
      const result = await getEnabledModelsPi();
      assert.equal(calledCmd, 'get_enabled_models', 'Must invoke server IPC get_enabled_models in web-shim');
      assert.deepEqual(result, ['anthropic/*', 'openai/gpt-4o']);
    } finally {
      if (origWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = origWindow;
      if (origIsTauri === undefined) delete (globalThis as any).isTauri;
      else (globalThis as any).isTauri = origIsTauri;
    }
  } finally {
    f.cleanup();
  }
});


