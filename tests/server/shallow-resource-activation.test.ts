import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getPiResourcesImpl,
  getMcpServersImpl,
  handleTogglePiResource,
  handleToggleMcpServer,
} from '@server/bridge/models';
import {
  setPiAgentDirForTest,
  setResourceActivation,
  loadResourceActivationPolicy,
  computeRpcStartupArgs,
} from '@server/bridge/resource-activation';

function createRepoTempDir(prefix: string): string {
  const baseDir = path.join(process.cwd(), 'tests', 'fixtures');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

test('Shallow activation: global resources inherit native configured enabled state without blanket suppression', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-inherit-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createRepoTempDir('proj-inherit-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global settings with an extension
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['./my-tool.ts'] }, null, 2)
  );
  // Global mcp.json with an enabled and a disabled server
  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'db-active': { command: 'node', args: ['db.js'], enabled: true },
        'db-disabled': { command: 'node', args: ['db.js'], enabled: false },
      },
    }, null, 2)
  );

  // Listing in project: inherits native enabled state without defaults-off suppression
  const resources = getPiResourcesImpl(projectDir);
  const ext = resources.resources.find((r) => r.source === './my-tool.ts');
  assert.ok(ext, 'Configured extension must be listed');
  assert.strictEqual(ext.enabled, true, 'Configured extension must inherit enabled state');
  assert.strictEqual(ext.hasProjectOverride, false, 'No project override flag when inheriting');

  const mcp = getMcpServersImpl(projectDir);
  const activeSrv = mcp.servers.find((s) => s.name === 'db-active');
  const disabledSrv = mcp.servers.find((s) => s.name === 'db-disabled');
  assert.ok(activeSrv);
  assert.strictEqual(activeSrv.enabled, true);
  assert.strictEqual(activeSrv.disabled, false);
  assert.strictEqual(activeSrv.hasProjectOverride, false);

  assert.ok(disabledSrv);
  assert.strictEqual(disabledSrv.enabled, false);
  assert.strictEqual(disabledSrv.disabled, true);
  assert.strictEqual(disabledSrv.hasProjectOverride, false);
});

test('Shallow inventory: top-level autoload folder is ONE root without manifest traversal', (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-autoload-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const extDir = path.join(fakeAgentDir, 'extensions', 'bundled-tool');
  fs.mkdirSync(extDir, { recursive: true });
  // Internal package.json declaring multiple internal extensions
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({
      name: 'bundled-tool',
      pi: {
        extensions: ['./sub/internal-a.ts', './sub/internal-b.ts'],
      },
    }, null, 2)
  );
  fs.mkdirSync(path.join(extDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'sub', 'internal-a.ts'), '// a');
  fs.writeFileSync(path.join(extDir, 'sub', 'internal-b.ts'), '// b');
  fs.writeFileSync(path.join(extDir, 'index.ts'), '// index');

  const resources = getPiResourcesImpl();
  // Must list ONE entry for the folder, NOT decomposed internal entries
  const bundledEntries = resources.resources.filter((r) => r.source.includes('bundled-tool'));
  assert.strictEqual(
    bundledEntries.length,
    1,
    `Expected exactly 1 root entry for bundled-tool folder, found: ${JSON.stringify(bundledEntries.map((b) => b.source))}`
  );
  assert.strictEqual(bundledEntries[0].kind, 'extension');
  assert.strictEqual(bundledEntries[0].name, 'bundled-tool');
  assert.strictEqual(bundledEntries[0].source, 'extensions/bundled-tool');
  assert.ok(
    !resources.resources.some((r) => r.source.includes('internal-a.ts') || r.source.includes('internal-b.ts')),
    'Internal manifest extensions must not be traversed into individual cards'
  );
});

test('Shallow inventory: glob masks do not create phantom cards, but declared disabled files remain listed as disabled and re-enableable', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-mask-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  // Create the actual disabled file so it exists
  fs.writeFileSync(path.join(fakeAgentDir, 'disabled-file.ts'), '// disabled');
  fs.writeFileSync(path.join(fakeAgentDir, 'valid-tool.ts'), '// valid');

  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({
      extensions: [
        './valid-tool.ts',
        '!/abs/path/extensions/excluded/**',
        '-./disabled-file.ts',
      ],
    }, null, 2)
  );

  const resources = getPiResourcesImpl();
  const valid = resources.resources.find((r) => r.source === './valid-tool.ts');
  assert.ok(valid, 'Valid tool should be present');
  assert.strictEqual(valid.enabled, true);

  // Glob mask must NOT create a card
  assert.ok(
    !resources.resources.some((r) => r.source.includes('excluded/**')),
    'Glob mask patterns like !path/** must not create phantom inventory cards'
  );

  // Disabled file with - marker remains listed as disabled card
  const disabledCard = resources.resources.find((r) => r.source === './disabled-file.ts');
  assert.ok(disabledCard, 'Disabled declared file must remain listed in inventory');
  assert.strictEqual(disabledCard.enabled, false, 'Disabled file must report enabled: false');

  // Re-enabling the file updates its state and removes - marker
  await handleTogglePiResource({
    kind: 'extension',
    source: './disabled-file.ts',
    enabled: true,
    scope: 'global',
  });

  const settingsAfter = JSON.parse(
    fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8')
  );
  assert.ok(
    !settingsAfter.extensions.includes('-./disabled-file.ts'),
    '-./disabled-file.ts must be removed from settings upon re-enabling'
  );

  const resourcesAfter = getPiResourcesImpl();
  const reenabledCard = resourcesAfter.resources.find((r) => r.source === './disabled-file.ts');
  assert.ok(reenabledCard);
  assert.strictEqual(reenabledCard.enabled, true, 'Re-enabled card must now report enabled: true');
});

test('Shallow inventory: explicit settings builtin:mcp is listed without resolving to filesystem path', (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-builtin-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['builtin:mcp'] }, null, 2)
  );

  const resources = getPiResourcesImpl();
  const builtin = resources.resources.find((r) => r.source === 'builtin:mcp');
  assert.ok(builtin, 'builtin:mcp must be listed when present in settings');
  assert.strictEqual(builtin.name, 'builtin:mcp');
  assert.strictEqual(builtin.kind, 'extension');
  assert.strictEqual(builtin.enabled, true);
  // Must NOT convert builtin:mcp to an absolute path like C:\...
  assert.strictEqual(builtin.extensionPath, undefined);
});

test('Shallow MCP: only global mcp.json and project .pi/mcp.json are listed; alternates ignored', (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-mcp-shallow-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createRepoTempDir('proj-mcp-shallow-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global mcp.json
  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'global-server': { command: 'node', args: ['srv.js'] },
      },
    }, null, 2)
  );

  // Alternate .mcp.json and .agents/mcp.json in workspace
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: { 'alt-dot-mcp': { command: 'node' } },
    }, null, 2)
  );
  const agentsDir = path.join(projectDir, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: { 'agents-mcp': { command: 'node' } },
    }, null, 2)
  );

  // Listing must ONLY include global-server, NOT alternate candidates
  const mcp = getMcpServersImpl(projectDir);
  const serverNames = mcp.servers.map((s) => s.name);
  assert.ok(serverNames.includes('global-server'));
  assert.ok(!serverNames.includes('alt-dot-mcp'), 'Alternate .mcp.json must not be included');
  assert.ok(!serverNames.includes('agents-mcp'), 'Alternate .agents/mcp.json must not be included');
});

test('Startup args: computeRpcStartupArgs returns empty array without blanket suppression', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-startup-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createRepoTempDir('proj-startup-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const args = await computeRpcStartupArgs(projectDir);
  assert.deepStrictEqual(args, [], 'Startup args must be empty, removing blanket --no-extensions and --no-mcp');
});

test('Toggle semantics: reject unknown toggle identities without writing', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-unknown-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createRepoTempDir('proj-unknown-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Toggling an unknown extension identity must reject without writing
  await assert.rejects(
    async () => {
      await handleTogglePiResource({
        kind: 'extension',
        source: 'nonexistent-extension.ts',
        enabled: false,
        cwd: projectDir,
      });
    },
    /Unknown extension identity/i
  );

  // Toggling an unknown MCP server must reject without writing
  await assert.rejects(
    async () => {
      await handleToggleMcpServer({
        name: 'ghost-server',
        enabled: false,
        cwd: projectDir,
      });
    },
    /Unknown MCP server/i
  );

  // No files written in projectDir
  const piDir = path.join(projectDir, '.pi');
  assert.ok(!fs.existsSync(piDir), 'No files should be written on rejected toggle');
});

test('Toggle semantics: package disabling throws explicit error rather than silent no-op', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-pkg-toggle-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ packages: ['npm:@company/tools'] }, null, 2)
  );

  await assert.rejects(
    async () => {
      await handleTogglePiResource({
        kind: 'package',
        source: 'npm:@company/tools',
        enabled: false,
      });
    },
    /disabling.*package.*not supported/i
  );
});

test('Toggle semantics: folder root exclusion writes scoped glob !<absroot>/**; re-enabling removes it', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-folder-toggle-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const extDir = path.join(fakeAgentDir, 'extensions', 'my-suite');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'index.ts'), '// test');

  // Disable folder extension globally
  const disableRes = await handleTogglePiResource({
    kind: 'extension',
    source: 'extensions/my-suite',
    enabled: false,
    scope: 'global',
  });
  assert.strictEqual(disableRes.success, true);
  assert.strictEqual(disableRes.enabled, false);

  const settingsFile = path.join(fakeAgentDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const posixDir = extDir.replace(/\\/g, '/');
  const expectedGlob = `!${posixDir}/**`;
  assert.ok(
    settings.extensions.includes(expectedGlob),
    `Settings extensions must contain scoped folder glob ${expectedGlob}, got: ${JSON.stringify(settings.extensions)}`
  );

  // Re-enable folder extension: removes the glob
  const enableRes = await handleTogglePiResource({
    kind: 'extension',
    source: 'extensions/my-suite',
    enabled: true,
    scope: 'global',
  });
  assert.strictEqual(enableRes.success, true);
  assert.strictEqual(enableRes.enabled, true);

  const settingsAfter = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.ok(
    !settingsAfter.extensions.includes(expectedGlob),
    'Re-enabling must remove the scoped folder glob'
  );
});

test('Toggle semantics: file exclusion writes -path; re-enabling removes it', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-file-toggle-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['./helper.ts'] }, null, 2)
  );

  // Disable file extension
  await handleTogglePiResource({
    kind: 'extension',
    source: './helper.ts',
    enabled: false,
    scope: 'global',
  });

  const settings = JSON.parse(fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8'));
  assert.ok(
    settings.extensions.includes('-./helper.ts'),
    `Disabling file must write -./helper.ts, got: ${JSON.stringify(settings.extensions)}`
  );
  assert.ok(
    !settings.extensions.includes('!./helper.ts'),
    'Disabling file must NOT use ! marker'
  );

  // Re-enable file extension
  await handleTogglePiResource({
    kind: 'extension',
    source: './helper.ts',
    enabled: true,
    scope: 'global',
  });

  const settingsAfter = JSON.parse(fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8'));
  assert.ok(
    !settingsAfter.extensions.includes('-./helper.ts'),
    'Re-enabling file must remove -./helper.ts'
  );
});

test('UI always-on toggle: set_resource_activation cwd:undefined enabled:false removes exception without global exclusion', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-always-on-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  // Extension exists in global settings
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['./my-tool.ts'] }, null, 2)
  );

  // Set always active
  await setResourceActivation({
    kind: 'extension',
    identity: './my-tool.ts',
    enabled: true,
  });

  let policy = loadResourceActivationPolicy();
  assert.ok(policy.alwaysExtensions.includes('./my-tool.ts'));

  // Uncheck always active (enabled: false, cwd: undefined)
  await setResourceActivation({
    kind: 'extension',
    identity: './my-tool.ts',
    enabled: false,
    cwd: undefined,
  });

  policy = loadResourceActivationPolicy();
  assert.ok(
    !policy.alwaysExtensions.includes('./my-tool.ts'),
    'Always-on exception must be removed'
  );

  // settings.json must NOT have added -./my-tool.ts or !./my-tool.ts
  const settings = JSON.parse(fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8'));
  assert.ok(
    !settings.extensions.includes('-./my-tool.ts') && !settings.extensions.includes('!./my-tool.ts'),
    'Removing always-active exception must not introduce a global exclusion in settings.json'
  );
});

test('Global off -> project on: project override force-includes global disabled extension', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-global-off-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createRepoTempDir('proj-override-on-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global settings has disabled extension
  const toolFile = path.join(fakeAgentDir, 'shared-tool.ts');
  fs.writeFileSync(toolFile, '// shared tool');
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['-./shared-tool.ts'] }, null, 2)
  );

  // Global query: disabled
  const globalRes = getPiResourcesImpl();
  const globalCard = globalRes.resources.find((r) => r.source === './shared-tool.ts');
  assert.ok(globalCard);
  assert.strictEqual(globalCard.enabled, false);

  // Toggle on in project scope
  await handleTogglePiResource({
    kind: 'extension',
    source: './shared-tool.ts',
    enabled: true,
    cwd: projectDir,
  });

  // Project query: enabled with hasProjectOverride: true
  const projectRes = getPiResourcesImpl(projectDir);
  const projectCard = projectRes.resources.find((r) => r.source === './shared-tool.ts');
  assert.ok(projectCard);
  assert.strictEqual(projectCard.enabled, true, 'Project override must force-enable globally disabled extension');
  assert.strictEqual(projectCard.hasProjectOverride, true);

  // Global query: still disabled
  const globalResAfter = getPiResourcesImpl();
  const globalCardAfter = globalResAfter.resources.find((r) => r.source === './shared-tool.ts');
  assert.ok(globalCardAfter);
  assert.strictEqual(globalCardAfter.enabled, false);
});

test('Native probe: DefaultPackageManager resolves viewer persisted project toggles', async (t) => {
  const probeModule = process.env.PI_VIEWER_NATIVE_PROBE_MODULE;

  if (!probeModule) {
    t.skip('PI_VIEWER_NATIVE_PROBE_MODULE not set; optional installed-runtime probe unavailable');
    return;
  }

  const isolatedFixtureDir = createRepoTempDir('isolated-native-probe-');
  t.after(() => {
    fs.rmSync(isolatedFixtureDir, { recursive: true, force: true });
  });

  const agentDir = path.join(isolatedFixtureDir, 'agent');
  const projDir = path.join(isolatedFixtureDir, 'project');
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(projDir, '.pi'), { recursive: true });

  setPiAgentDirForTest(agentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
  });

  const extFile = path.join(agentDir, 'extensions', 'probe-tool.ts');
  fs.writeFileSync(extFile, '// probe');

  // Use actual viewer toggle to write project setting
  await handleTogglePiResource({
    kind: 'extension',
    source: 'extensions/probe-tool.ts',
    enabled: false,
    cwd: projDir,
  });

  // Read the settings written by the viewer
  const projSettings = JSON.parse(
    fs.readFileSync(path.join(projDir, '.pi', 'settings.json'), 'utf8')
  );

  // Probe via native DefaultPackageManager with isolated environment
  const script = `
    const { DefaultPackageManager } = require("${probeModule.split(path.sep).join('/')}");
    (async () => {
      const pm = new DefaultPackageManager({
        cwd: "${projDir.split(path.sep).join('/')}",
        agentDir: "${agentDir.split(path.sep).join('/')}",
        settingsManager: {
          getGlobalSettings: () => ({ extensions: [] }),
          getProjectSettings: () => (${JSON.stringify(projSettings)}),
          isProjectTrusted: () => true,
        },
        builtinExtensions: [],
      });
      const res = await pm.resolve();
      const ext = res.extensions.find(e => e.path.includes("probe-tool.ts"));
      if (!ext) process.exit(2);
      if (ext.enabled !== false || ext.metadata.scope !== "project") process.exit(3);
      process.exit(0);
    })();
  `;

  const cp = await import('node:child_process');
  const result = cp.spawnSync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      HOME: isolatedFixtureDir,
      USERPROFILE: isolatedFixtureDir,
    },
  });

  assert.strictEqual(
    result.status,
    0,
    `Native probe must exit 0, got status ${result.status}, stderr: ${result.stderr?.toString()}`
  );
});
