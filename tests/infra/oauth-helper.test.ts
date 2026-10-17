import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELPER_PATH = path.resolve('src-tauri/pi-oauth-helper.mjs');

const FAKE_SDK_SOURCE = `
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SettingsManager {
  constructor(agentDir) {
    this.agentDir = agentDir;
    this.settingsPath = path.join(agentDir, 'settings.json');
    this.globalSettings = {};
    if (fs.existsSync(this.settingsPath)) {
      try {
        this.globalSettings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      } catch (_) {}
    }
    this.writePromise = null;
  }

  static create(cwd, agentDir) {
    return new SettingsManager(agentDir);
  }

  getOrCreateDeviceId() {
    if (!this.globalSettings.deviceId) {
      this.globalSettings.deviceId = crypto.randomUUID();
      this.writePromise = new Promise((resolve) => {
        setImmediate(() => {
          fs.mkdirSync(this.agentDir, { recursive: true });
          fs.writeFileSync(this.settingsPath, JSON.stringify(this.globalSettings, null, 2), 'utf8');
          resolve();
        });
      });
    }
    return this.globalSettings.deviceId;
  }

  async flush() {
    if (this.writePromise) {
      await this.writePromise;
    }
  }
}

export class ModelRuntime {
  constructor(authPath) {
    this.authPath = authPath;
  }

  static async create({ authPath } = {}) {
    return new ModelRuntime(authPath);
  }

  getProviders() {
    return [
      { id: 'fake', name: 'Fake', auth: { oauth: { name: 'Fake OAuth' } } },
    ];
  }

  getProvider(id) {
    if (id === 'openai') {
      return { id: 'openai', name: 'OpenAI (ChatGPT subscription)', auth: { oauth: { name: 'OpenAI' } } };
    }
    if (id === 'openai-error') {
      return { id: 'openai-error', name: 'OpenAI Failing', auth: { oauth: { name: 'OpenAI Failing' } } };
    }
    if (id === 'legacy-provider') {
      return { id: 'legacy-provider', name: 'Legacy Provider', auth: { oauth: { name: 'Legacy OAuth' } } };
    }
    return this.getProviders().find((p) => p.id === id);
  }

  async listCredentials() {
    return [];
  }

  async checkAuth() {
    return undefined;
  }

  getModels(providerId) {
    if (providerId === 'fake') {
      return [
        {
          id: 'fake-model-1',
          name: 'Fake Model 1',
          provider: 'fake',
          contextWindow: 128000,
          maxTokens: 4096,
          reasoning: true,
          input: ['text', 'image'],
          baseUrl: 'https://secret.api.com',
          apiKey: 'sk-secret-123456789012345678',
          cost: { input: 1, output: 2 },
        },
      ];
    }
    if (providerId === 'openai') {
      return [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false }];
    }
    if (providerId === 'openai-codex') {
      return [{ id: 'codex-mini', name: 'Codex Mini', provider: 'openai-codex', reasoning: true }];
    }
    return [];
  }

  async login(providerId, type, interaction, options) {
    if (providerId === 'openai') {
      const deviceId = options?.getDeviceId?.();
      if (!deviceId || !UUID_PATTERN.test(deviceId)) {
        throw new Error('Sign in with ChatGPT requires a device ID (UUID) for this installation');
      }
      return { type: 'oauth', access: 'token' };
    }
    if (providerId === 'openai-error') {
      const deviceId = options?.getDeviceId?.();
      if (!deviceId || !UUID_PATTERN.test(deviceId)) {
        throw new Error('Sign in with ChatGPT requires a device ID (UUID) for this installation');
      }
      throw new Error('Simulated authentication error');
    }
    if (providerId === 'legacy-provider' || providerId === 'fake') {
      return { type: 'oauth', access: 'token' };
    }
    throw new Error('Unknown provider: ' + providerId);
  }
}
`;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function writeFakeSdkPackage(packageDir: string): void {
  writeJson(path.join(packageDir, 'package.json'), {
    name: '@earendil-works/pi-coding-agent',
    type: 'module',
    main: './dist/index.js',
    exports: { '.': { import: './dist/index.js' } },
  });
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), FAKE_SDK_SOURCE);
}

function runHelperList(entrypoint: string, home: string): { status: string; providers?: unknown[]; error?: string } {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [HELPER_PATH, 'list', '--entrypoint', entrypoint, '--home', home], {
      encoding: 'utf8',
    });
  } catch (err) {
    stdout = String((err as { stdout?: string }).stdout ?? '');
  }
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
}

function runHelperLogin(
  entrypoint: string,
  home: string,
  provider: string,
): { type: string; providerId?: string; error?: string } {
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      [HELPER_PATH, 'login', '--entrypoint', entrypoint, '--home', home, '--provider', provider],
      {
        encoding: 'utf8',
      },
    );
  } catch (err) {
    stdout = String((err as { stdout?: string }).stdout ?? '');
  }
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
}

function runHelperCatalog(
  entrypoint: string,
  home: string,
  provider: string,
): { status: string; providerId?: string; models?: any[]; error?: string } {
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      [HELPER_PATH, 'catalog', '--entrypoint', entrypoint, '--home', home, '--provider', provider],
      {
        encoding: 'utf8',
      },
    );
  } catch (err) {
    stdout = String((err as { stdout?: string }).stdout ?? '');
  }
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oauth-helper-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('OAuth helper resolves the Pi SDK when the entrypoint lives inside the SDK package', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const result = runHelperList(entrypoint, path.join(dir, 'home'));

    assert.equal(result.status, 'ok', result.error ?? '');
    assert.equal(result.providers?.length, 1);
  });
});

test('OAuth helper resolves the Pi SDK from the Gentle Shell package dependencies', () => {
  withTempDir((dir) => {
    const shellDir = path.join(dir, 'gentle-pi');
    writeJson(path.join(shellDir, 'package.json'), { name: 'gentle-pi' });
    const entrypoint = path.join(shellDir, 'bin', 'gentle-shell.mjs');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');
    writeFakeSdkPackage(path.join(shellDir, 'node_modules', '@earendil-works', 'pi-coding-agent'));

    const result = runHelperList(entrypoint, path.join(dir, 'home'));

    assert.equal(result.status, 'ok', result.error ?? '');
    assert.equal(result.providers?.length, 1);
  });
});

test('OAuth helper reports an error when no Pi SDK is reachable from the entrypoint', () => {
  withTempDir((dir) => {
    const entrypoint = path.join(dir, 'orphan', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const result = runHelperList(entrypoint, path.join(dir, 'home'));

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /Unable to resolve Pi SDK/);
  });
});

test('S2.1: legacy OAuth login succeeds without requiring or generating device identity', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const home = path.join(dir, 'home');
    const result = runHelperLogin(entrypoint, home, 'legacy-provider');

    assert.equal(result.type, 'success', result.error ?? '');
    assert.equal(result.providerId, 'legacy-provider');
    // Lazy callback: settings.json was not created and device identity was not generated
    assert.equal(fs.existsSync(path.join(home, 'settings.json')), false);
  });
});

test('S1.1: OpenAI login receives valid installation UUID from SDK SettingsManager callback', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const home = path.join(dir, 'home');
    const result = runHelperLogin(entrypoint, home, 'openai');

    assert.equal(result.type, 'success', result.error ?? '');
    assert.equal(result.providerId, 'openai');

    const settingsPath = path.join(home, 'settings.json');
    assert.equal(fs.existsSync(settingsPath), true, 'settings.json should be persisted');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.match(
      settings.deviceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'deviceId should be a valid UUID',
    );
  });
});

test('S1.2: subsequent logins against the same agent home reuse device UUID and preserve existing settings', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const settingsPath = path.join(home, 'settings.json');
    writeJson(settingsPath, {
      defaultModel: 'test-model',
      unrelatedSetting: 'preserved-value',
    });

    const firstRun = runHelperLogin(entrypoint, home, 'openai');
    assert.equal(firstRun.type, 'success', firstRun.error ?? '');

    const firstSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const initialUuid = firstSettings.deviceId;
    assert.match(
      initialUuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    assert.equal(firstSettings.defaultModel, 'test-model');
    assert.equal(firstSettings.unrelatedSetting, 'preserved-value');

    const secondRun = runHelperLogin(entrypoint, home, 'openai');
    assert.equal(secondRun.type, 'success', secondRun.error ?? '');

    const secondSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(secondSettings.deviceId, initialUuid, 'UUID must remain stable across helper subprocesses');
    assert.equal(secondSettings.defaultModel, 'test-model');
    assert.equal(secondSettings.unrelatedSetting, 'preserved-value');
  });
});

test('S1.2: device identity is flushed and persists even when login fails after ID generation', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const home = path.join(dir, 'home');
    const result = runHelperLogin(entrypoint, home, 'openai-error');
    assert.equal(result.type, 'error');
    assert.match(result.error ?? '', /Simulated authentication error/);

    const settingsPath = path.join(home, 'settings.json');
    assert.equal(fs.existsSync(settingsPath), true, 'settings.json should be flushed on error');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.match(
      settings.deviceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

test('S1.1: helper catalog returns runtime models with allowlisted metadata for specific provider', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const result = runHelperCatalog(entrypoint, path.join(dir, 'home'), 'fake');

    assert.equal(result.status, 'ok', result.error ?? '');
    assert.equal(result.providerId, 'fake');
    assert.equal(result.models?.length, 1);
    const model = result.models?.[0];
    assert.equal(model.id, 'fake-model-1');
    assert.equal(model.name, 'Fake Model 1');
    assert.equal(model.provider, 'fake');
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 4096);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    // Sensitive/internal fields MUST be excluded (S2.2)
    assert.equal(model.baseUrl, undefined);
    assert.equal(model.apiKey, undefined);
    assert.equal(model.cost, undefined);
  });
});

test('S1.1: helper catalog keeps openai vs openai-codex models distinct', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const openaiResult = runHelperCatalog(entrypoint, path.join(dir, 'home'), 'openai');
    assert.equal(openaiResult.status, 'ok', openaiResult.error ?? '');
    assert.equal(openaiResult.models?.[0]?.provider, 'openai');

    const codexResult = runHelperCatalog(entrypoint, path.join(dir, 'home'), 'openai-codex');
    assert.equal(codexResult.status, 'ok', codexResult.error ?? '');
    assert.equal(codexResult.models?.[0]?.provider, 'openai-codex');
    assert.notEqual(openaiResult.models?.[0]?.id, codexResult.models?.[0]?.id);
  });
});

test('S1.2 / S2.2: helper catalog does not create agent directory or auth file if missing', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const nonExistentHome = path.join(dir, 'non-existent-agent-dir');
    const result = runHelperCatalog(entrypoint, nonExistentHome, 'fake');

    assert.equal(result.status, 'ok', result.error ?? '');
    assert.equal(fs.existsSync(nonExistentHome), false, 'Effective home must not be created for catalog action');
  });
});
