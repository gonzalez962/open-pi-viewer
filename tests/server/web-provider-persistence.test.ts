import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  handleIpcCommand,
  setPiAgentDirForTest,
} from '@server/web-ipc-bridge';

function createIsolatedFixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-provider-test-'));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  setPiAgentDirForTest(agentDir);

  const modelsPath = path.join(agentDir, 'models.json');
  const writeRaw = (content: string) => fs.writeFileSync(modelsPath, content, 'utf8');
  const writeJson = (val: unknown) => fs.writeFileSync(modelsPath, JSON.stringify(val, null, 2) + '\n', 'utf8');
  const readRaw = () => fs.readFileSync(modelsPath, 'utf8');
  const readJson = () => JSON.parse(readRaw());

  return {
    root,
    agentDir,
    modelsPath,
    writeRaw,
    writeJson,
    readRaw,
    readJson,
    cleanup() {
      setPiAgentDirForTest(null);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

test('S1.1 — upsert_custom_provider creates new provider, exposing model and pattern policy', async () => {
  const f = createIsolatedFixture();
  try {
    const payload = {
      provider: {
        id: 'cpam',
        name: 'CPAM Provider',
        baseUrl: 'https://cpam.example.com/v1',
        api: 'openai',
        includedModels: ['codex/gpt-6.1-*'],
        models: [
          {
            id: 'codex/gpt-6.1-sol',
            name: 'GPT 6.1 Sol',
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    };

    const result: any = await handleIpcCommand('upsert_custom_provider', payload);
    assert.ok(result, 'upsert_custom_provider must return result object');
    assert.ok(result.providers?.cpam, 'Returned config must contain cpam provider');
    assert.deepEqual(result.providers.cpam.includedModels, ['codex/gpt-6.1-*']);
    assert.equal(result.providers.cpam.models[0].id, 'codex/gpt-6.1-sol');

    // Public readback via get_custom_providers
    const customProviders: any = await handleIpcCommand('get_custom_providers', {});
    assert.ok(customProviders.providers?.cpam);
    assert.deepEqual(customProviders.providers.cpam.includedModels, ['codex/gpt-6.1-*']);

    // Public readback via get_available_models exposes saved model
    const availableModels: any = await handleIpcCommand('get_available_models', {});
    assert.ok(Array.isArray(availableModels));
    const savedModel = availableModels.find((m: any) => m.id === 'codex/gpt-6.1-sol' && m.provider === 'cpam');
    assert.ok(savedModel, 'get_available_models must expose codex/gpt-6.1-sol under provider cpam');
    assert.equal(savedModel.name, 'GPT 6.1 Sol');
  } finally {
    f.cleanup();
  }
});

test('S1.2 — upsert_custom_provider updates patterns/models preserving unrelated fields and model metadata', async () => {
  const f = createIsolatedFixture();
  try {
    const initialConfig = {
      rootMetadata: 'keep-root-value',
      modelOverrides: { 'some/model': { temperature: 0.7 } },
      providers: {
        unrelated: {
          baseUrl: 'https://unrelated.example.com',
          api: 'anthropic',
          models: [{ id: 'claude-3-5-sonnet', contextWindow: 200000 }],
        },
        cpam: {
          baseUrl: 'https://cpam.example.com/v1',
          api: 'openai',
          providerMetadata: 'keep-provider-meta',
          includedModels: ['old-pattern-*'],
          models: [
            {
              id: 'codex/gpt-6.1-sol',
              name: 'Old Sol Name',
              unknownModelField: 'keep-model-meta',
              contextWindow: 128000,
            },
            {
              id: 'codex/gpt-6.1-secondary',
              name: 'Secondary Model',
            },
          ],
        },
      },
    };
    f.writeJson(initialConfig);

    const updatePayload = {
      provider: {
        id: 'cpam',
        baseUrl: 'https://cpam-updated.example.com/v1',
        api: 'openai',
        includedModels: ['codex/gpt-6.1-*', 'codex/gpt-6.2-*'],
        models: [
          {
            id: 'codex/gpt-6.1-sol',
            name: 'New Sol Name',
            maxTokens: 8192,
          },
        ],
      },
    };

    const result: any = await handleIpcCommand('upsert_custom_provider', updatePayload);
    assert.equal(result.rootMetadata, 'keep-root-value', 'Preserves unrelated root keys');
    assert.ok(result.providers?.unrelated, 'Preserves unrelated provider');
    assert.equal(result.providers.unrelated.baseUrl, 'https://unrelated.example.com');

    const cpam = result.providers.cpam;
    assert.equal(cpam.baseUrl, 'https://cpam-updated.example.com/v1');
    assert.equal(cpam.providerMetadata, 'keep-provider-meta', 'Preserves unknown provider metadata');
    assert.deepEqual(cpam.includedModels, ['codex/gpt-6.1-*', 'codex/gpt-6.1-*'.replace('1', '2')], 'Patterns updated without retaining old patterns');
    assert.deepEqual(cpam.includedModels, ['codex/gpt-6.1-*', 'codex/gpt-6.2-*']);

    // Check models additive merge
    assert.equal(cpam.models.length, 2, 'Unmatched existing model preserved');
    const updatedSol = cpam.models.find((m: any) => m.id === 'codex/gpt-6.1-sol');
    assert.ok(updatedSol);
    assert.equal(updatedSol.name, 'New Sol Name');
    assert.equal(updatedSol.unknownModelField, 'keep-model-meta', 'Preserves unknown model field');
    assert.equal(updatedSol.contextWindow, 128000, 'Preserves existing model property not in update');
    assert.equal(updatedSol.maxTokens, 8192, 'Applies new model property');

    const secondary = cpam.models.find((m: any) => m.id === 'codex/gpt-6.1-secondary');
    assert.ok(secondary, 'Existing secondary model was retained');

    // Verify stored file matches readback
    const stored = f.readJson();
    assert.deepEqual(stored, result);
  } finally {
    f.cleanup();
  }
});

test('S2.1 — delete_custom_provider removes targeted provider and preserves other providers/root', async () => {
  const f = createIsolatedFixture();
  try {
    const initialConfig = {
      customRootField: 'keep-me',
      providers: {
        cpam: {
          baseUrl: 'https://cpam.example.com',
          api: 'openai',
          models: [{ id: 'm1' }],
        },
        otherProv: {
          baseUrl: 'https://other.example.com',
          api: 'anthropic',
          models: [{ id: 'm2' }],
        },
      },
    };
    f.writeJson(initialConfig);

    const result: any = await handleIpcCommand('delete_custom_provider', { providerId: 'cpam' });
    assert.ok(result, 'delete_custom_provider returns updated config');
    assert.equal(result.customRootField, 'keep-me');
    assert.equal(result.providers?.cpam, undefined, 'cpam was removed');
    assert.ok(result.providers?.otherProv, 'otherProv was preserved');

    // Readback via get_custom_providers
    const readback: any = await handleIpcCommand('get_custom_providers', {});
    assert.equal(readback.providers?.cpam, undefined);
    assert.ok(readback.providers?.otherProv);
    assert.equal(readback.customRootField, 'keep-me');

    // Stored bytes verify
    const stored = f.readJson();
    assert.deepEqual(stored, result);
  } finally {
    f.cleanup();
  }
});

test('S3.1 — fail closed: invalid provider payload/ID throws and leaves bytes unchanged', async () => {
  const f = createIsolatedFixture();
  try {
    const validConfig = {
      rootKey: 'untouched',
      providers: {
        validProv: { baseUrl: 'https://valid.example.com', api: 'openai', models: [] },
      },
    };
    f.writeJson(validConfig);
    const bytesBefore = f.readRaw();

    // Invalid ID: empty or whitespace
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: '', baseUrl: 'https://x.com', api: 'openai' } }),
      /Provider ID/
    );
    assert.equal(f.readRaw(), bytesBefore);

    await assert.rejects(
      () => handleIpcCommand('delete_custom_provider', { providerId: '   ' }),
      /Provider ID/
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid ID: characters not allowed
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'invalid id with spaces', baseUrl: 'https://x.com', api: 'openai' } }),
      /invalid characters/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    await assert.rejects(
      () => handleIpcCommand('delete_custom_provider', { providerId: 'bad@id!' }),
      /invalid characters/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid payload: non-object
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: 'not-an-object', providerId: 'test' }),
      /JSON object/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid baseUrl: missing, empty, or non-http(s)
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'p1', api: 'openai' } }),
      /baseUrl/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'p1', baseUrl: 'ftp://bad', api: 'openai' } }),
      /http:\/\/ or https:\/\//i
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid api: missing
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'p1', baseUrl: 'https://x.com' } }),
      /api/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid models: not an array
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'p1', baseUrl: 'https://x.com', api: 'openai', models: 'not-an-array' } }),
      /models/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid models: model missing id
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'p1', baseUrl: 'https://x.com', api: 'openai', models: [{ name: 'missing id' }] } }),
      /id/i
    );
    assert.equal(f.readRaw(), bytesBefore);

    // Invalid includedModels: not an array of strings
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'p1', baseUrl: 'https://x.com', api: 'openai', includedModels: [123] } }),
      /includedModels|string/i
    );
    assert.equal(f.readRaw(), bytesBefore);
  } finally {
    f.cleanup();
  }
});

test('S3.2 — fail closed: malformed JSON or invalid providers shape rejects and leaves bytes unchanged', async () => {
  const f = createIsolatedFixture();
  try {
    // Malformed JSON syntax
    const malformedSyntax = '{ "providers": { "cpam": { "baseUrl": "unclosed" ';
    f.writeRaw(malformedSyntax);

    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'cpam', baseUrl: 'https://x.com', api: 'openai' } }),
      /parse|JSON/i
    );
    assert.equal(f.readRaw(), malformedSyntax, 'Bytes must remain completely unchanged after syntax error');

    await assert.rejects(
      () => handleIpcCommand('delete_custom_provider', { providerId: 'cpam' }),
      /parse|JSON/i
    );
    assert.equal(f.readRaw(), malformedSyntax, 'Bytes must remain completely unchanged after delete on syntax error');

    // Root is not a JSON object
    const arrayRoot = '["not", "an", "object"]\n';
    f.writeRaw(arrayRoot);

    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'cpam', baseUrl: 'https://x.com', api: 'openai' } }),
      /object/i
    );
    assert.equal(f.readRaw(), arrayRoot);

    await assert.rejects(
      () => handleIpcCommand('delete_custom_provider', { providerId: 'cpam' }),
      /object/i
    );
    assert.equal(f.readRaw(), arrayRoot);

    // providers key is not an object
    const invalidProvidersShape = JSON.stringify({ providers: 'not-an-object', keep: 123 }, null, 2);
    f.writeRaw(invalidProvidersShape);

    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', { provider: { id: 'cpam', baseUrl: 'https://x.com', api: 'openai' } }),
      /providers.*object/i
    );
    assert.equal(f.readRaw(), invalidProvidersShape);

    await assert.rejects(
      () => handleIpcCommand('delete_custom_provider', { providerId: 'cpam' }),
      /providers.*object/i
    );
    assert.equal(f.readRaw(), invalidProvidersShape);
  } finally {
    f.cleanup();
  }
});

test('PRESERVE — legacy get_custom_providers and save_custom_providers still work on isolated agent dir', async () => {
  const f = createIsolatedFixture();
  try {
    const initial = { providers: { legacy: { baseUrl: 'https://legacy.example.com', api: 'openai' } } };
    f.writeJson(initial);

    const got: any = await handleIpcCommand('get_custom_providers', {});
    assert.ok(got.providers?.legacy);

    const saveResult: any = await handleIpcCommand('save_custom_providers', {
      providers: {
        legacy2: { baseUrl: 'https://legacy2.example.com', api: 'openai' },
      },
    });
    assert.ok(saveResult.providers?.legacy2);
    assert.equal(saveResult.providers?.legacy, undefined);

    const readback: any = await handleIpcCommand('get_custom_providers', {});
    assert.ok(readback.providers?.legacy2);
  } finally {
    f.cleanup();
  }
});

test('Defect 2 — rejects dangerous reserved provider IDs (__proto__, constructor, prototype) leaving stored bytes unchanged', async () => {
  const f = createIsolatedFixture();
  try {
    const initialConfig = {
      providers: {
        existing: { baseUrl: 'https://existing.example.com', api: 'openai' },
      },
    };
    f.writeJson(initialConfig);
    const bytesBefore = f.readRaw();

    const reservedIds = ['__proto__', 'constructor', 'prototype'];
    for (const badId of reservedIds) {
      await assert.rejects(
        () => handleIpcCommand('upsert_custom_provider', {
          provider: { id: badId, baseUrl: 'https://evil.example.com', api: 'openai' },
        }),
        /reserved|dangerous/i,
        `upsert_custom_provider must reject reserved ID ${badId}`
      );
      assert.equal(f.readRaw(), bytesBefore, `Bytes must remain unchanged after rejecting reserved upsert ID ${badId}`);

      await assert.rejects(
        () => handleIpcCommand('delete_custom_provider', { providerId: badId }),
        /reserved|dangerous/i,
        `delete_custom_provider must reject reserved ID ${badId}`
      );
      assert.equal(f.readRaw(), bytesBefore, `Bytes must remain unchanged after rejecting reserved delete ID ${badId}`);
    }
  } finally {
    f.cleanup();
  }
});

test('Defect 2 — prevents payload property __proto__ setter semantics including nested own keys', async () => {
  const f = createIsolatedFixture();
  try {
    const initialConfig = {
      providers: {
        safe: { baseUrl: 'https://safe.example.com', api: 'openai' },
      },
    };
    f.writeJson(initialConfig);
    const bytesBefore = f.readRaw();

    // 1. Direct own __proto__ in provider object
    const evilDirect = JSON.parse(
      '{"provider":{"id":"cpam","baseUrl":"https://evil.example.com","api":"openai","__proto__":{"polluted":true}}}'
    );
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', evilDirect),
      /dangerous|__proto__|property/i
    );
    assert.equal(f.readRaw(), bytesBefore);
    assert.equal((({} as any).polluted), undefined, 'Object.prototype must not be polluted');

    // 2. Nested __proto__ inside models array
    const evilModel = JSON.parse(
      '{"provider":{"id":"cpam","baseUrl":"https://evil.example.com","api":"openai","models":[{"id":"m1","__proto__":{"polluted":true}}]}}'
    );
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', evilModel),
      /dangerous|__proto__|property/i
    );
    assert.equal(f.readRaw(), bytesBefore);
    assert.equal((({} as any).polluted), undefined);

    // 3. Nested __proto__ inside unknown metadata
    const evilMeta = JSON.parse(
      '{"provider":{"id":"cpam","baseUrl":"https://evil.example.com","api":"openai","customMeta":{"__proto__":{"polluted":true}}}}'
    );
    await assert.rejects(
      () => handleIpcCommand('upsert_custom_provider', evilMeta),
      /dangerous|__proto__|property/i
    );
    assert.equal(f.readRaw(), bytesBefore);
    assert.equal((({} as any).polluted), undefined);
  } finally {
    f.cleanup();
  }
});

test('Defect 2 — inherited property names (toString, valueOf) work as ordinary provider IDs with safe dictionary and metadata preservation', async () => {
  const f = createIsolatedFixture();
  try {
    const initialConfig = {
      rootMeta: 'keep-root',
      providers: {},
    };
    f.writeJson(initialConfig);

    // Upsert provider named 'toString'
    const payload = {
      provider: {
        id: 'toString',
        name: 'ToString Provider',
        baseUrl: 'https://tostring.example.com',
        api: 'openai',
        extraMetadata: 'preserved-meta-val',
        models: [{ id: 'm-to-string', contextWindow: 64000 }],
      },
    };

    const result: any = await handleIpcCommand('upsert_custom_provider', payload);
    assert.ok(result.providers?.toString, 'Config must contain toString provider');
    assert.equal(result.providers.toString.extraMetadata, 'preserved-meta-val');
    assert.equal(result.providers.toString.baseUrl, 'https://tostring.example.com');
    assert.equal(result.rootMeta, 'keep-root');

    // Readback via get_custom_providers
    const readback: any = await handleIpcCommand('get_custom_providers', {});
    assert.ok(readback.providers?.toString);
    assert.equal(readback.providers.toString.extraMetadata, 'preserved-meta-val');

    // Delete provider 'toString'
    const afterDelete: any = await handleIpcCommand('delete_custom_provider', { providerId: 'toString' });
    assert.equal(Object.prototype.hasOwnProperty.call(afterDelete.providers, 'toString'), false, 'toString provider was removed from own properties');
    assert.equal(afterDelete.rootMeta, 'keep-root');

    // Readback via get_custom_providers confirms removal
    const readbackAfter: any = await handleIpcCommand('get_custom_providers', {});
    assert.equal(Object.prototype.hasOwnProperty.call(readbackAfter.providers, 'toString'), false, 'readback confirms toString provider removed');
    assert.equal(readbackAfter.rootMeta, 'keep-root');

    // Object.prototype.toString remains intact
    assert.equal(typeof Object.prototype.toString, 'function');
    assert.equal(({}).toString(), '[object Object]');
  } finally {
    f.cleanup();
  }
});

test('Defect 3 — atomic write uses exclusive temp creation, mode 0600 for new, and calls fchmodSync', async () => {
  const f = createIsolatedFixture();
  const openCalls: Array<{ path: string; flags: any; mode: any }> = [];
  const fchmodCalls: Array<{ fd: number; mode: any }> = [];

  const origOpenSync = fs.openSync;
  const origFchmodSync = fs.fchmodSync;

  fs.openSync = function (filePath: any, flags: any, mode?: any) {
    if (typeof filePath === 'string' && filePath.includes('.tmp.')) {
      openCalls.push({ path: filePath, flags, mode });
    }
    return origOpenSync.apply(this, arguments as any);
  };

  fs.fchmodSync = function (fd: number, mode: any) {
    fchmodCalls.push({ fd, mode });
    return origFchmodSync.apply(this, arguments as any);
  };

  try {
    const payload = {
      provider: {
        id: 'newprov',
        baseUrl: 'https://newprov.example.com',
        api: 'openai',
      },
    };

    await handleIpcCommand('upsert_custom_provider', payload);

    // Spied contract: openSync must have been called on temp file with exclusive flag and mode 0o600
    assert.ok(openCalls.length > 0, 'Atomic write must create temp file via openSync');
    const lastOpen = openCalls[openCalls.length - 1];
    const isExclusive =
      lastOpen.flags === 'wx' ||
      (typeof lastOpen.flags === 'number' &&
        (lastOpen.flags & (fs.constants.O_CREAT | fs.constants.O_EXCL)) ===
          (fs.constants.O_CREAT | fs.constants.O_EXCL));
    assert.ok(isExclusive, `openSync flags must be exclusive ('wx' or O_CREAT|O_EXCL), got ${lastOpen.flags}`);
    assert.equal(lastOpen.mode, 0o600, `openSync mode for new file must be 0o600, got ${lastOpen.mode}`);

    // Spied contract: fchmodSync must have been called with 0o600 to overcome umask
    assert.ok(fchmodCalls.length > 0, 'Atomic write must call fchmodSync on temp fd to enforce mode');
    const lastFchmod = fchmodCalls[fchmodCalls.length - 1];
    assert.equal(lastFchmod.mode, 0o600, `fchmodSync mode must be 0o600, got ${lastFchmod.mode}`);

    // Platform-dependent check: on Unix, stat permissions are verified. On Windows, report limitation.
    if (process.platform !== 'win32') {
      const stat = fs.statSync(f.modelsPath);
      assert.equal(stat.mode & 0o777, 0o600, 'Unix file mode must strictly equal 0600');
    }
  } finally {
    fs.openSync = origOpenSync;
    fs.fchmodSync = origFchmodSync;
    f.cleanup();
  }
});

test('Defect 3 — atomic write preserves existing file permission bits on replacement', async () => {
  const f = createIsolatedFixture();
  const openCalls: Array<{ path: string; flags: any; mode: any }> = [];
  const fchmodCalls: Array<{ fd: number; mode: any }> = [];

  const origOpenSync = fs.openSync;
  const origFchmodSync = fs.fchmodSync;

  fs.openSync = function (filePath: any, flags: any, mode?: any) {
    if (typeof filePath === 'string' && filePath.includes('.tmp.')) {
      openCalls.push({ path: filePath, flags, mode });
    }
    return origOpenSync.apply(this, arguments as any);
  };

  fs.fchmodSync = function (fd: number, mode: any) {
    fchmodCalls.push({ fd, mode });
    return origFchmodSync.apply(this, arguments as any);
  };

  try {
    const initialConfig = { providers: { existing: { baseUrl: 'https://ex.com', api: 'openai' } } };
    f.writeJson(initialConfig);

    const existingStat = fs.statSync(f.modelsPath);
    const existingMode = existingStat.mode & 0o777;

    const payload = {
      provider: {
        id: 'existing',
        baseUrl: 'https://ex-updated.com',
        api: 'openai',
      },
    };

    await handleIpcCommand('upsert_custom_provider', payload);

    assert.ok(openCalls.length > 0, 'Atomic write must create temp file via openSync');
    const lastOpen = openCalls[openCalls.length - 1];
    assert.equal(lastOpen.mode, existingMode, `openSync must preserve existing mode ${existingMode.toString(8)}, got ${lastOpen.mode?.toString(8)}`);

    assert.ok(fchmodCalls.length > 0, 'fchmodSync must be called on temp file fd');
    const lastFchmod = fchmodCalls[fchmodCalls.length - 1];
    assert.equal(lastFchmod.mode, existingMode, `fchmodSync must preserve existing mode ${existingMode.toString(8)}, got ${lastFchmod.mode?.toString(8)}`);

    if (process.platform !== 'win32') {
      const stat = fs.statSync(f.modelsPath);
      assert.equal(stat.mode & 0o777, existingMode, 'Unix file mode must be preserved on replacement');
    }
  } finally {
    fs.openSync = origOpenSync;
    fs.fchmodSync = origFchmodSync;
    f.cleanup();
  }
});

