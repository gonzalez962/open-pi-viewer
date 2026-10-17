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

  // Global extensions directory fixture: valid directory extension with package internals + standalone file
  const tmpExtensionsDir = path.join(tmpAgentDir, 'extensions');
  const customPackDir = path.join(tmpExtensionsDir, 'custom-tool-pack');
  fs.mkdirSync(customPackDir, { recursive: true });
  fs.writeFileSync(
    path.join(customPackDir, 'package.json'),
    JSON.stringify(
      {
        name: 'custom-tool-pack',
        pi: {
          extensions: ['nested-tool-a.ts', 'nested-tool-b.ts'],
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(customPackDir, 'nested-tool-a.ts'), '// nested tool a');
  fs.writeFileSync(path.join(customPackDir, 'nested-tool-b.ts'), '// nested tool b');
  fs.writeFileSync(path.join(customPackDir, 'index.ts'), '// index fallback');
  fs.writeFileSync(path.join(tmpExtensionsDir, 'standalone-tool.ts'), '// standalone tool');

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

  // 5. Assert valid top-level directory remains discovered without expanding package internals
  const resourcesRes: any = await handleIpcCommand('get_pi_resources', { cwd: tmpProject });
  const resources = resourcesRes?.resources || [];

  const dirResource = resources.find((r: any) => r.id === 'ext-custom-tool-pack');
  assert.ok(dirResource, 'Valid top-level directory extension must remain discovered as a resource');
  assert.strictEqual(dirResource.kind, 'extension');
  assert.strictEqual(dirResource.source, 'extensions/custom-tool-pack');
  assert.strictEqual(dirResource.scope, 'global');
  assert.strictEqual(dirResource.enabled, true);

  const standaloneResource = resources.find((r: any) => r.id === 'ext-standalone-tool');
  assert.ok(standaloneResource, 'Valid standalone top-level extension must remain discovered');

  // Package internals (manifest pi.extensions or nested files) must NOT be expanded into individual resources
  const expandedInternals = resources.filter(
    (r: any) =>
      r.id.includes('nested-tool') ||
      r.source.includes('nested-tool') ||
      r.source.includes('custom-tool-pack/index')
  );
  assert.strictEqual(
    expandedInternals.length,
    0,
    'Package internals must not be expanded into individual resources contrary to shallow design'
  );
});

test('server/bridge: regression: valid top-level extension directory discovered as single root without expanding package internals', { timeout: 5000 }, async (t) => {
  const fixtureRoot = path.resolve(`.tmp-shallow-ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const tmpProject = path.join(fixtureRoot, 'project');
  const tmpAgentDir = path.join(fixtureRoot, 'agent');

  fs.mkdirSync(tmpProject, { recursive: true });
  fs.mkdirSync(tmpAgentDir, { recursive: true });

  const globalExtDir = path.join(tmpAgentDir, 'extensions');
  const globalPackDir = path.join(globalExtDir, 'global-pack');
  fs.mkdirSync(globalPackDir, { recursive: true });
  fs.writeFileSync(
    path.join(globalPackDir, 'package.json'),
    JSON.stringify(
      {
        name: 'global-pack',
        pi: {
          extensions: ['sub-ext-1.ts', 'sub-ext-2.ts'],
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(globalPackDir, 'sub-ext-1.ts'), '// sub 1');
  fs.writeFileSync(path.join(globalPackDir, 'sub-ext-2.ts'), '// sub 2');
  fs.writeFileSync(path.join(globalPackDir, 'index.ts'), '// index fallback');

  const projectExtDir = path.join(tmpProject, '.pi', 'extensions', 'project-pack');
  fs.mkdirSync(projectExtDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectExtDir, 'package.json'),
    JSON.stringify(
      {
        name: 'project-pack',
        pi: {
          extensions: ['proj-sub.ts'],
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(projectExtDir, 'proj-sub.ts'), '// proj sub');

  setPiAgentDirForTest(tmpAgentDir);

  t.after(() => {
    setPiAgentDirForTest(null);
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {}
  });

  const res: any = await handleIpcCommand('get_pi_resources', { cwd: tmpProject });
  const resources = res?.resources || [];

  // 1. Proves valid global top-level directory remains discovered
  const globalResource = resources.find((r: any) => r.id === 'ext-global-pack');
  assert.ok(globalResource, 'Global top-level directory extension must be discovered');
  assert.strictEqual(globalResource.kind, 'extension');
  assert.strictEqual(globalResource.source, 'extensions/global-pack');
  assert.strictEqual(globalResource.scope, 'global');

  // 2. Proves valid project top-level directory remains discovered
  const projectResource = resources.find((r: any) => r.id === 'ext-project-pack');
  assert.ok(projectResource, 'Project top-level directory extension must be discovered');
  assert.strictEqual(projectResource.kind, 'extension');
  assert.strictEqual(projectResource.source, 'extensions/project-pack');
  assert.strictEqual(projectResource.scope, 'project');

  // 3. Proves package internals are NOT expanded contrary to shallow design
  const expanded = resources.filter(
    (r: any) =>
      r.id.includes('sub-ext') ||
      r.source.includes('sub-ext') ||
      r.id.includes('proj-sub') ||
      r.source.includes('proj-sub')
  );
  assert.strictEqual(
    expanded.length,
    0,
    'No package internals may be expanded into individual resources'
  );
});
