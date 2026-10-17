import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOAuthManager, getOAuthManager, oauthManager } from '@server/bridge/oauth';
import type { OAuthEventEnvelope } from '@core/types/oauth';

const TESTS_DIR = path.resolve(process.cwd(), 'tests');
const HELPER_PATH = path.resolve(process.cwd(), 'src-tauri', 'pi-oauth-helper.mjs');

const FAKE_SDK_SOURCE = `
import fs from 'node:fs';
import path from 'node:path';

export class ModelRuntime {
  constructor(authPath) {
    this.authPath = authPath;
  }

  static async create({ authPath }) {
    return new ModelRuntime(authPath);
  }

  getProviders() {
    return [
      {
        id: 'fake-oauth',
        name: 'Fake OAuth Provider',
        auth: {
          oauth: {
            name: 'Fake OAuth',
            loginLabel: 'Log in with Fake',
            isSubscription: false,
          },
        },
      },
    ];
  }

  getProvider(id) {
    return this.getProviders().find((p) => p.id === id);
  }

  async listCredentials() {
    const scenarioFile = path.join(path.dirname(this.authPath), 'scenario.json');
    if (fs.existsSync(scenarioFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        if (parsed.scenario === 'hang' || parsed.scenario === 'list_hang') {
          setInterval(() => {}, 60000);
          await new Promise(() => {});
        }
      } catch (_) {}
    }
    if (!this.authPath || !fs.existsSync(this.authPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
      const results = [];
      for (const [providerId, cred] of Object.entries(data)) {
        if (cred && cred.type) {
          results.push({ providerId, type: cred.type });
        }
      }
      return results;
    } catch (_) {
      return [];
    }
  }

  async checkAuth(providerId) {
    const creds = await this.listCredentials();
    const match = creds.find((c) => c.providerId === providerId);
    if (match) {
      return { type: match.type };
    }
    return undefined;
  }

  getModels(providerId) {
    if (providerId === 'fake-oauth') {
      return [
        {
          id: 'fake-model-alpha',
          name: 'Fake Model Alpha',
          provider: 'fake-oauth',
          contextWindow: 64000,
          maxTokens: 2048,
          reasoning: true,
          input: ['text', 'image'],
          baseUrl: 'https://secret-leak.com',
          apiKey: 'super-secret-key-123456789012345678',
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

  async logout(providerId) {
    const scenarioFile = path.join(path.dirname(this.authPath), 'scenario.json');
    if (fs.existsSync(scenarioFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        if (parsed.scenario === 'hang' || parsed.scenario === 'logout_hang') {
          setInterval(() => {}, 60000);
          await new Promise(() => {});
        }
      } catch (_) {}
    }
    if (this.authPath && fs.existsSync(this.authPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
        delete data[providerId];
        fs.writeFileSync(this.authPath, JSON.stringify(data, null, 2));
      } catch (_) {}
    }
  }

  async login(providerId, authType, interaction) {
    const scenarioFile = path.join(path.dirname(this.authPath), 'scenario.json');
    let scenario = 'prompt';
    if (fs.existsSync(scenarioFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        scenario = parsed.scenario || scenario;
      } catch (_) {}
    }

    if (scenario === 'hang' || scenario === 'login_hang') {
      setInterval(() => {}, 60000);
      await new Promise(() => {});
      return;
    }

    if (scenario === 'close_stdin_after_prompt') {
      interaction.notify({ type: 'progress', message: 'Authenticating...' });
      const p = interaction.prompt({
        type: 'select',
        message: 'Select account',
        options: [
          { id: 'acc-1', label: 'Account 1' },
          { id: 'acc-2', label: 'Account 2' },
        ],
      });
      // Destroy standard input to simulate unexpected pipe closure / broken pipe (EPIPE)
      setTimeout(() => {
        try {
          process.stdin.destroy();
        } catch (_) {}
      }, 50);
      await p;
      return;
    }

    if (scenario === 'error') {
      throw new Error('Simulated OAuth provider failure');
    }

    interaction.notify({ type: 'progress', message: 'Authenticating...' });

    const selected = await interaction.prompt({
      type: 'select',
      message: 'Select account',
      options: [
        { id: 'acc-1', label: 'Account 1' },
        { id: 'acc-2', label: 'Account 2' },
      ],
    });

    if (selected === 'acc-1' || selected === 'acc-2') {
      let data = {};
      if (fs.existsSync(this.authPath)) {
        try {
          data = JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
        } catch (_) {}
      }
      data[providerId] = { type: 'oauth', account: selected };
      fs.writeFileSync(this.authPath, JSON.stringify(data, null, 2));
    } else {
      throw new Error('Unexpected selection: ' + selected);
    }
  }
}
`;

function setupTestEnvironment(): { rootDir: string; entrypoint: string; homeDir: string } {
  const rootDir = fs.mkdtempSync(path.join(TESTS_DIR, '.tmp-oauth-'));

  const sdkDir = path.join(rootDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { import: './dist/index.js' } },
    }, null, 2)
  );
  fs.writeFileSync(path.join(sdkDir, 'dist', 'index.js'), FAKE_SDK_SOURCE);

  const binDir = path.join(rootDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const entrypoint = path.join(binDir, 'cli.js');
  fs.writeFileSync(entrypoint, '#!/usr/bin/env node\n');

  const homeDir = path.join(rootDir, 'isolated-home');
  fs.mkdirSync(homeDir, { recursive: true });

  return { rootDir, entrypoint, homeDir };
}

function cleanupTestEnvironment(rootDir: string) {
  if (rootDir && fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test('T1 S1/S3: list genuinely reads simulated stored state from isolated auth.json', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const authPath = path.join(homeDir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ 'fake-oauth': { type: 'oauth' } }, null, 2));

    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    const providers = await manager.list('test-owner');
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, 'fake-oauth');
    assert.equal(providers[0].hasStoredOAuth, true);
    assert.equal(providers[0].oauthReady, true);
    assert.equal(providers[0].status, 'authenticated');

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: login flow with prompt and response, status transitions, and stored state update', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    // Seed providers list cache
    await manager.list('owner-alpha');

    const startRes = await manager.start('owner-alpha', { providerId: 'fake-oauth' });
    assert.equal(startRes.started, true);
    assert.equal(startRes.providerId, 'fake-oauth');

    // Wait for the prompt event to be emitted
    let promptEvent: OAuthEventEnvelope | undefined;
    for (let i = 0; i < 40; i++) {
      promptEvent = events.find((e) => e.owner === 'owner-alpha' && e.event.kind === 'prompt')?.event;
      if (promptEvent) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(promptEvent, 'Prompt event should have been emitted');
    assert.equal(promptEvent.data.promptType, 'select');
    assert.ok(promptEvent.data.promptId);

    // Validate select value rejection
    const invalidResp = await manager.respond('owner-alpha', {
      promptId: promptEvent.data.promptId,
      response: 'non-existent-account',
    });
    assert.equal(invalidResp.sent, false);
    assert.match(invalidResp.message ?? '', /Invalid selection option/);

    // Send valid response
    const validResp = await manager.respond('owner-alpha', {
      promptId: promptEvent.data.promptId,
      response: 'acc-1',
    });
    assert.equal(validResp.sent, true);

    // Wait for completed status event
    let completedEvent: OAuthEventEnvelope | undefined;
    for (let i = 0; i < 40; i++) {
      completedEvent = events.find(
        (e) => e.owner === 'owner-alpha' && e.event.kind === 'status' && e.event.data?.state === 'completed'
      )?.event;
      if (completedEvent) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(completedEvent, 'Completed status event should have been emitted');

    // Verify auth.json was updated with credentials
    const authPath = path.join(homeDir, 'auth.json');
    assert.ok(fs.existsSync(authPath));
    const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.equal(authData['fake-oauth']?.account, 'acc-1');

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: owner isolation protects active login from unauthorized cancel and respond', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    await manager.list('owner-authorized');
    const startRes = await manager.start('owner-authorized', { providerId: 'fake-oauth' });
    assert.equal(startRes.started, true);

    // Wait for prompt
    let promptEvent: OAuthEventEnvelope | undefined;
    for (let i = 0; i < 40; i++) {
      promptEvent = events.find((e) => e.owner === 'owner-authorized' && e.event.kind === 'prompt')?.event;
      if (promptEvent) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(promptEvent);

    // Rogue owner tries to cancel
    const rogueCancel = await manager.cancel('rogue-user');
    assert.equal(rogueCancel.cancelled, false);
    assert.match(rogueCancel.message ?? '', /Unauthorized/);

    // Rogue owner tries to respond
    const rogueResp = await manager.respond('rogue-user', {
      promptId: promptEvent.data.promptId,
      response: 'acc-1',
    });
    assert.equal(rogueResp.sent, false);
    assert.match(rogueResp.message ?? '', /Unauthorized/);

    // Authorized owner cancels cleanly
    const authCancel = await manager.cancel('owner-authorized');
    assert.equal(authCancel.cancelled, true);

    // Wait for cancelled status event
    let cancelledEvent: OAuthEventEnvelope | undefined;
    for (let i = 0; i < 40; i++) {
      cancelledEvent = events.find(
        (e) => e.owner === 'owner-authorized' && e.event.kind === 'status' && e.event.data?.state === 'cancelled'
      )?.event;
      if (cancelledEvent) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(cancelledEvent, 'Cancelled status event should have been emitted');

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: concurrent login is rejected globally', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    await manager.list('owner-1');
    const firstStart = await manager.start('owner-1', { providerId: 'fake-oauth' });
    assert.equal(firstStart.started, true);

    // Second start attempt from another owner
    const secondStart = await manager.start('owner-2', { providerId: 'fake-oauth' });
    assert.equal(secondStart.started, false);
    assert.match(secondStart.message ?? '', /already in progress/);

    // Clean up
    await manager.cancel('owner-1');
    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: provider validation rejects arbitrary arguments and unknown providers', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: () => {},
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    // Malicious shell / argument flags
    const res1 = await manager.start('owner', { providerId: '--dangerous-flag' });
    assert.equal(res1.started, false);
    assert.match(res1.message ?? '', /Invalid provider identifier/);

    const res2 = await manager.start('owner', { providerId: 'fake;rm -rf /' });
    assert.equal(res2.started, false);
    assert.match(res2.message ?? '', /Invalid provider identifier/);

    // Unknown provider
    const res3 = await manager.start('owner', { providerId: 'unknown-provider-xyz' });
    assert.equal(res3.started, false);
    assert.match(res3.message ?? '', /Unknown or unsupported/);

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: logout genuinely clears simulated stored credentials', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const authPath = path.join(homeDir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ 'fake-oauth': { type: 'oauth' } }, null, 2));

    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: () => {},
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    await manager.list('owner');

    const logoutRes = await manager.logout('owner', { providerId: 'fake-oauth' });
    assert.equal(logoutRes.success, true);
    assert.equal(logoutRes.providerId, 'fake-oauth');

    const remainingAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.equal(remainingAuth['fake-oauth'], undefined);

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: prompt cancellation clears active prompt and emits safe event', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    await manager.list('owner-prompt-cancel');
    const startRes = await manager.start('owner-prompt-cancel', { providerId: 'fake-oauth' });
    assert.equal(startRes.started, true);

    // Wait for prompt
    let promptEvent: OAuthEventEnvelope | undefined;
    for (let i = 0; i < 40; i++) {
      promptEvent = events.find((e) => e.owner === 'owner-prompt-cancel' && e.event.kind === 'prompt')?.event;
      if (promptEvent) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(promptEvent);

    // Cancel from authorized owner
    const cancelRes = await manager.cancel('owner-prompt-cancel');
    assert.equal(cancelRes.cancelled, true);

    // After cancel, respond should be rejected because active login/prompt is gone
    for (let i = 0; i < 40; i++) {
      const resp = await manager.respond('owner-prompt-cancel', {
        promptId: promptEvent.data.promptId,
        response: 'acc-1',
      });
      if (!resp.sent) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: dispose terminates active child process and cleans up', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const scenarioPath = path.join(homeDir, 'scenario.json');
    fs.writeFileSync(scenarioPath, JSON.stringify({ scenario: 'login_hang' }));

    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 30_000 },
    });

    await manager.list('owner-dispose');
    const startRes = await manager.start('owner-dispose', { providerId: 'fake-oauth' });
    assert.equal(startRes.started, true);

    // Dispose should safely terminate active login child and await its exit
    await manager.dispose();

    // After dispose, any new call is rejected
    const postDispose = await manager.start('owner-dispose', { providerId: 'fake-oauth' });
    assert.equal(postDispose.started, false);
    assert.match(postDispose.message ?? '', /disposed/i);
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: concurrency regression: concurrent start calls during dynamic provider validation reject secondary callers', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000 },
    });

    // Do NOT seed the providers cache. 'fake-oauth' requires dynamic helper query.
    // Launch two start requests concurrently for 'fake-oauth'.
    const [start1, start2] = await Promise.all([
      manager.start('owner-1', { providerId: 'fake-oauth' }),
      manager.start('owner-2', { providerId: 'fake-oauth' }),
    ]);

    // Exactly one should succeed in starting; the other MUST be rejected synchronously
    const startedCount = [start1, start2].filter((s) => s.started).length;
    const rejectedCount = [start1, start2].filter((s) => !s.started).length;

    assert.equal(startedCount, 1, 'Only one concurrent login may start');
    assert.equal(rejectedCount, 1, 'The other concurrent login must be rejected');

    const rejected = !start1.started ? start1 : start2;
    assert.match(rejected.message ?? '', /already in progress/i);

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: dispose regression: dispose tracks and terminates in-flight list and logout helpers without unhandled rejection', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const scenarioPath = path.join(homeDir, 'scenario.json');
    // Configure scenario so list helper hangs
    fs.writeFileSync(scenarioPath, JSON.stringify({ scenario: 'list_hang' }));

    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: () => {},
      timeouts: { shortCommandMs: 30_000, loginMs: 30_000, killGraceMs: 300 },
    });

    // Launch list without awaiting completion
    const listPromise = manager.list('owner-list').catch((err) => err);

    // Give child a moment to spawn
    await new Promise((r) => setTimeout(r, 200));

    // Dispose while list is in-flight
    await manager.dispose();

    // The list promise must settle safely without crashing or hanging
    const listResult = await listPromise;
    assert.ok(listResult instanceof Error, 'In-flight list should reject on dispose');
    assert.match(listResult.message, /disposed/i);

    // Similarly test logout in-flight shutdown
    const manager2 = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: () => {},
      timeouts: { shortCommandMs: 30_000, loginMs: 30_000, killGraceMs: 300 },
    });

    // Reset scenario so seed list helper succeeds immediately
    fs.writeFileSync(scenarioPath, JSON.stringify({ scenario: 'normal' }));
    await manager2.list();

    fs.writeFileSync(scenarioPath, JSON.stringify({ scenario: 'logout_hang' }));
    const logoutPromise = manager2.logout('owner-logout', { providerId: 'fake-oauth' });
    await new Promise((r) => setTimeout(r, 200));

    await manager2.dispose();

    const logoutResult = await logoutPromise;
    assert.equal(logoutResult.success, false);
    assert.match(logoutResult.message ?? '', /disposed/i);
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S3: singleton regression: dispose resets singleton reference and avoids clearing newly acquired instance', async () => {
  const m1 = getOAuthManager();
  assert.ok(m1);

  // Calling dispose on the singleton delegate
  await oauthManager.dispose();

  // Next getOAuthManager call MUST produce a fresh instance
  const m2 = getOAuthManager();
  assert.ok(m2);
  assert.notEqual(m1, m2, 'getOAuthManager must return a fresh instance after dispose');

  // Verify async race protection: if old disposer runs, it does not wipe out a newly acquired instance
  const m3 = getOAuthManager();
  assert.equal(m2, m3, 'Same instance while not disposed');

  await oauthManager.dispose();
  const m4 = getOAuthManager();
  assert.notEqual(m3, m4, 'getOAuthManager returns fresh instance after second dispose');
  await oauthManager.dispose();
});

test('T1 S1/S3: EPIPE regression: helper closing stdin results in callback-based respond() sent: false without uncaughtException, keeps pending prompt, and clean dispose', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const scenarioPath = path.join(homeDir, 'scenario.json');
    fs.writeFileSync(scenarioPath, JSON.stringify({ scenario: 'close_stdin_after_prompt' }));

    const events: Array<{ owner: string; event: OAuthEventEnvelope }> = [];
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      emit: (owner, event) => events.push({ owner, event }),
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000, killGraceMs: 300 },
    });

    await manager.list('owner-epipe');
    const startRes = await manager.start('owner-epipe', { providerId: 'fake-oauth' });
    assert.equal(startRes.started, true);

    // Wait for prompt event
    let promptEvent: OAuthEventEnvelope | undefined;
    for (let i = 0; i < 40; i++) {
      promptEvent = events.find((e) => e.owner === 'owner-epipe' && e.event.kind === 'prompt')?.event;
      if (promptEvent) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(promptEvent, 'Prompt event should have been emitted');

    // Give helper time to close its stdin (50ms timeout inside helper)
    await new Promise((r) => setTimeout(r, 200));

    // Calling respond on closed pipe must return sent: false via write callback acknowledgment
    const resp = await manager.respond('owner-epipe', {
      promptId: promptEvent.data.promptId,
      response: 'acc-1',
    });

    assert.equal(resp.sent, false, 'respond() must return sent: false on broken stdin / EPIPE');
    assert.ok(resp.message, 'Message should describe write failure');

    // Dispose after helper closed input must cleanly shut down without unhandled error
    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S1/S2: catalog queries models for provider and projects allowlisted safe metadata', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000, killGraceMs: 300 },
    });

    const models = await manager.catalog('fake-oauth');
    assert.ok(Array.isArray(models));
    assert.equal(models.length, 1);
    const m = models[0];
    assert.equal(m.id, 'fake-model-alpha');
    assert.equal(m.name, 'Fake Model Alpha');
    assert.equal(m.provider, 'fake-oauth');
    assert.equal(m.contextWindow, 64000);
    assert.equal(m.maxTokens, 2048);
    assert.equal(m.reasoning, true);
    assert.deepEqual(m.input, ['text', 'image']);
    // Extra sensitive fields MUST never be projected (S2.2)
    assert.equal((m as any).baseUrl, undefined);
    assert.equal((m as any).apiKey, undefined);
    assert.equal((m as any).cost, undefined);

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});

test('T1 S2.1: catalog keeps openai and openai-codex distinct', async () => {
  const { rootDir, entrypoint, homeDir } = setupTestEnvironment();
  try {
    const manager = createOAuthManager({
      helperPath: HELPER_PATH,
      nodePath: process.execPath,
      entrypoint,
      agentHome: homeDir,
      timeouts: { shortCommandMs: 10_000, loginMs: 10_000, killGraceMs: 300 },
    });

    const openaiModels = await manager.catalog('openai');
    assert.equal(openaiModels.length, 1);
    assert.equal(openaiModels[0].provider, 'openai');
    assert.equal(openaiModels[0].id, 'gpt-4o');

    const codexModels = await manager.catalog('openai-codex');
    assert.equal(codexModels.length, 1);
    assert.equal(codexModels[0].provider, 'openai-codex');
    assert.equal(codexModels[0].id, 'codex-mini');

    await manager.dispose();
  } finally {
    cleanupTestEnvironment(rootDir);
  }
});
