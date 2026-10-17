import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  handleIpcCommand,
  setSubprocessSpawnerForTest,
  resetPiRpcForTest,
  setSessionsRootDirForTest,
  setPiAgentDirForTest,
} from '@server/web-ipc-bridge';

test('server/bridge: regression: nonblocking connect warmup spawns deterministically under isolated fixture', { timeout: 5000 }, async (t) => {
  const fixtureRoot = path.resolve(`.tmp-shallow-spawner-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const tmpProject = path.join(fixtureRoot, 'project');
  const tmpAgentDir = path.join(fixtureRoot, 'agent');
  const tmpSessionsRoot = path.join(fixtureRoot, 'sessions');

  fs.mkdirSync(tmpProject, { recursive: true });
  fs.mkdirSync(tmpAgentDir, { recursive: true });
  fs.mkdirSync(tmpSessionsRoot, { recursive: true });

  setPiAgentDirForTest(tmpAgentDir);
  setSessionsRootDirForTest(tmpSessionsRoot);

  let capturedEnvSync: any = null;
  let notifySpawner!: (info: { cmd: string; args: string[]; env: any }) => void;
  const spawnerPromise = new Promise<{ cmd: string; args: string[]; env: any }>((resolve) => {
    notifySpawner = resolve;
  });

  setSubprocessSpawnerForTest((cmd, args, options) => {
    capturedEnvSync = options?.env;
    notifySpawner({ cmd, args, env: options?.env });
    return null;
  });

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    setPiAgentDirForTest(null);
    setSessionsRootDirForTest(null);
    resetPiRpcForTest();
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {}
  });

  const connectRes: any = await handleIpcCommand('connect', {
    payload: { workingDirectory: tmpProject },
  });

  // 1. Proves warmup is non-blocking: handleConnect resolves before background async materialization completes
  assert.ok(connectRes?.sessionId, 'Connect must immediately return valid session');
  assert.strictEqual(
    capturedEnvSync,
    null,
    'Immediate synchronous check must be null because warmup runs in non-blocking background'
  );

  // 2. Deterministic deferred event resolution: spawner executes reliably without sleep or polling
  const spawned = await spawnerPromise;
  assert.ok(spawned, 'Spawner must be called via deferred background activation');
  assert.strictEqual(
    spawned.env.GENTLE_SHELL_INTERACTIVE_HOST,
    '1',
    'Subprocess spawner must receive GENTLE_SHELL_INTERACTIVE_HOST=1'
  );

  // 3. Subprocess arguments verification (preserve native shallow loading without blanket suppression)
  assert.ok(spawned.args.includes('--mode'), 'Args must include --mode');
  assert.ok(spawned.args.includes('rpc'), 'Args must include rpc');
  assert.ok(spawned.args.includes('--approve'), 'Args must include --approve');
  assert.strictEqual(spawned.args.includes('--no-extensions'), false, 'Args must not include blanket --no-extensions');
  assert.strictEqual(spawned.args.includes('--no-mcp'), false, 'Args must not include blanket --no-mcp');
  const sessionIndex = spawned.args.indexOf('--session');
  assert.ok(sessionIndex >= 0, 'Args must include --session argument');
  const sessionArg = spawned.args[sessionIndex + 1];
  assert.ok(
    sessionArg.startsWith(tmpSessionsRoot),
    `Session file must reside in isolated test root: ${sessionArg}`
  );

  // 4. Assert isolated agent config: no unintended writes to ambient settings or policy
  assert.strictEqual(
    fs.existsSync(path.join(tmpAgentDir, 'settings.json')),
    false,
    'No unintended writes to settings.json in isolated agent fixture'
  );
  assert.strictEqual(
    fs.existsSync(path.join(tmpAgentDir, 'viewer-resource-activation.json')),
    false,
    'No unintended writes to viewer-resource-activation.json in isolated agent fixture'
  );
});
