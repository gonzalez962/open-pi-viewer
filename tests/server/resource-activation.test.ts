import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  handleIpcCommand,
  getPiResourcesImpl,
  getMcpServersImpl,
} from '@server/web-ipc-bridge';
import {
  loadResourceActivationPolicy,
  setResourceActivation,
  normalizeProjectCwd,
  getEffectiveExtensionActivation,
  getEffectiveMcpActivation,
  materializeProjectMcpEnforcement,
  computeRpcStartupArgs,
  setPiAgentDirForTest,
  loadProjectResourceActivation,
  saveProjectResourceActivation,
  getProjectResourceActivationPath,
  discoverAllExtensions,
} from '@server/bridge/resource-activation';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Resource policy: missing policy defaults off for extensions and MCP servers', (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(policy.version, 1);
  assert.deepStrictEqual(policy.alwaysExtensions, []);
  assert.deepStrictEqual(policy.alwaysMcpServers, []);
  assert.deepStrictEqual(policy.projects, {});

  const testProject = path.join(fakeAgentDir, 'my-project');
  assert.strictEqual(
    getEffectiveExtensionActivation(policy, testProject, 'extensions/foo.ts'),
    false,
    'Extensions must default inactive'
  );
  assert.strictEqual(
    getEffectiveMcpActivation(policy, testProject, 'my-mcp'),
    false,
    'MCP servers must default inactive'
  );
});

test('Resource policy: project isolation ensures activation in Project A does not affect Project B', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const projectA = path.join(fakeAgentDir, 'project-a');
  const projectB = path.join(fakeAgentDir, 'project-b');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  await setResourceActivation({
    kind: 'extension',
    identity: 'extensions/helper.ts',
    enabled: true,
    cwd: projectA,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'db-server',
    enabled: true,
    cwd: projectA,
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(getEffectiveExtensionActivation(policy, projectA, 'extensions/helper.ts'), true);
  assert.strictEqual(getEffectiveMcpActivation(policy, projectA, 'db-server'), true);

  assert.strictEqual(
    getEffectiveExtensionActivation(policy, projectB, 'extensions/helper.ts'),
    false,
    'Project B must remain inactive'
  );
  assert.strictEqual(
    getEffectiveMcpActivation(policy, projectB, 'db-server'),
    false,
    'Project B must remain inactive'
  );
});

test('Resource policy: global Always activate exception enables resource across projects by default', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const projectA = path.join(fakeAgentDir, 'project-a');
  const projectB = path.join(fakeAgentDir, 'project-b');

  await setResourceActivation({
    kind: 'extension',
    identity: 'extensions/global-tool.ts',
    enabled: true,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'global-mcp',
    enabled: true,
  });

  const policy = loadResourceActivationPolicy();
  assert.ok(policy.alwaysExtensions.includes('extensions/global-tool.ts'));
  assert.ok(policy.alwaysMcpServers.includes('global-mcp'));

  assert.strictEqual(getEffectiveExtensionActivation(policy, projectA, 'extensions/global-tool.ts'), true);
  assert.strictEqual(getEffectiveExtensionActivation(policy, projectB, 'extensions/global-tool.ts'), true);
  assert.strictEqual(getEffectiveMcpActivation(policy, projectA, 'global-mcp'), true);
  assert.strictEqual(getEffectiveMcpActivation(policy, projectB, 'global-mcp'), true);

  // Disable global exception
  await setResourceActivation({
    kind: 'extension',
    identity: 'extensions/global-tool.ts',
    enabled: false,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'global-mcp',
    enabled: false,
  });

  const updatedPolicy = loadResourceActivationPolicy();
  assert.strictEqual(getEffectiveExtensionActivation(updatedPolicy, projectA, 'extensions/global-tool.ts'), false);
  assert.strictEqual(getEffectiveMcpActivation(updatedPolicy, projectA, 'global-mcp'), false);
});

test('Resource policy: explicit project false override takes precedence over global always-on', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const projectA = path.join(fakeAgentDir, 'project-a');

  // Set global always-on
  await setResourceActivation({
    kind: 'extension',
    identity: 'extensions/omnipresent.ts',
    enabled: true,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'omnipresent-mcp',
    enabled: true,
  });

  // Explicitly disable for projectA
  await setResourceActivation({
    kind: 'extension',
    identity: 'extensions/omnipresent.ts',
    enabled: false,
    cwd: projectA,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'omnipresent-mcp',
    enabled: false,
    cwd: projectA,
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(
    getEffectiveExtensionActivation(policy, projectA, 'extensions/omnipresent.ts'),
    false,
    'Explicit project override false must win over global always-on'
  );
  assert.strictEqual(
    getEffectiveMcpActivation(policy, projectA, 'omnipresent-mcp'),
    false,
    'Explicit project override false must win over global always-on'
  );
});

test('Resource policy: Windows path normalization normalizes casing in project keys', () => {
  const dirPath = 'C:\\Projects\\MyApp';
  const lowerPath = 'c:\\projects\\myapp';
  if (process.platform === 'win32') {
    assert.strictEqual(normalizeProjectCwd(dirPath), normalizeProjectCwd(lowerPath));
  } else {
    assert.strictEqual(path.isAbsolute(normalizeProjectCwd(dirPath)), true);
  }
});

test('Resource policy: set_resource_activation IPC validates payload and returns success: true', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  // Valid calls
  const res1: any = await handleIpcCommand('set_resource_activation', {
    kind: 'extension',
    identity: 'extensions/test.ts',
    enabled: true,
  });
  assert.deepStrictEqual(res1, { success: true });

  const res2: any = await handleIpcCommand('set_resource_activation', {
    kind: 'mcp',
    identity: 'test-mcp',
    enabled: true,
    cwd: fakeAgentDir,
  });
  assert.deepStrictEqual(res2, { success: true });

  // Invalid kind
  await assert.rejects(
    async () => {
      await handleIpcCommand('set_resource_activation', {
        kind: 'unknown',
        identity: 'test',
        enabled: true,
      });
    },
    /Invalid resource kind/
  );

  // Missing identity
  await assert.rejects(
    async () => {
      await handleIpcCommand('set_resource_activation', {
        kind: 'extension',
        identity: '',
        enabled: true,
      });
    },
    /Identity is required/
  );
});

test('Listing outputs: get_mcp_servers reports alwaysActive and effective enabled per project', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  // Write a global mcp.json
  const globalMcp = {
    mcpServers: {
      'global-server-1': { command: 'node', args: ['s1.js'] },
      'global-server-2': { command: 'node', args: ['s2.js'] },
    },
  };
  fs.writeFileSync(path.join(fakeAgentDir, 'mcp.json'), JSON.stringify(globalMcp, null, 2));

  const projectDir = path.join(fakeAgentDir, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });

  // Make global-server-2 always active
  await setResourceActivation({
    kind: 'mcp',
    identity: 'global-server-2',
    enabled: true,
  });

  // Global listing (no cwd): displays config enabled and alwaysActive
  const globalList = getMcpServersImpl();
  const g1 = globalList.servers.find((s: any) => s.name === 'global-server-1');
  const g2 = globalList.servers.find((s: any) => s.name === 'global-server-2');
  assert.ok(g1);
  assert.ok(g2);
  assert.strictEqual(g1.alwaysActive, false);
  assert.strictEqual(g2.alwaysActive, true);
  assert.strictEqual(g1.enabled, true, 'Global config state preserved');

  // Project listing: resources default inactive unless alwaysActive or overridden
  const projList1 = getMcpServersImpl(projectDir);
  const p1 = projList1.servers.find((s: any) => s.name === 'global-server-1');
  const p2 = projList1.servers.find((s: any) => s.name === 'global-server-2');
  assert.strictEqual(p1.enabled, false, 'Inactive by default');
  assert.strictEqual(p1.disabled, true);
  assert.strictEqual(p2.enabled, true, 'Enabled via alwaysActive');

  // Override p1 in project to enabled
  await setResourceActivation({
    kind: 'mcp',
    identity: 'global-server-1',
    enabled: true,
    cwd: projectDir,
  });
  const projList2 = getMcpServersImpl(projectDir);
  const p1Updated = projList2.servers.find((s: any) => s.name === 'global-server-1');
  assert.strictEqual(p1Updated.enabled, true);
});

test('Listing outputs: get_pi_resources reports alwaysActive and effective enabled for extensions', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  // Create global settings with package and extension
  const settings = {
    packages: ['npm:@test/my-pkg@1.0.0'],
    extensions: ['extensions/ext-a.ts'],
  };
  fs.writeFileSync(path.join(fakeAgentDir, 'settings.json'), JSON.stringify(settings, null, 2));

  // Create global extension in directory
  const extsDir = path.join(fakeAgentDir, 'extensions');
  fs.mkdirSync(extsDir, { recursive: true });
  fs.writeFileSync(path.join(extsDir, 'ext-b.ts'), '// test');

  const projectDir = path.join(fakeAgentDir, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });

  await setResourceActivation({
    kind: 'extension',
    identity: 'extensions/ext-b.ts',
    enabled: true,
  });

  // Project listing
  const list = getPiResourcesImpl(projectDir);
  const extA = list.resources.find((r: any) => r.source.includes('ext-a'));
  const extB = list.resources.find((r: any) => r.source.includes('ext-b'));
  const pkg = list.resources.find((r: any) => r.kind === 'package');

  assert.ok(extA);
  assert.ok(extB);
  assert.ok(pkg);

  assert.strictEqual(extA.enabled, false, 'Default inactive for project');
  assert.strictEqual(extA.alwaysActive, false);
  assert.strictEqual(extB.enabled, true, 'Active via alwaysActive');
  assert.strictEqual(extB.alwaysActive, true);
  assert.strictEqual(pkg.enabled, true, 'Packages preserve existing behavior');
});

test('Project toggles: toggle_mcp_server and toggle_pi_resource route to policy updates', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const projectDir = path.join(fakeAgentDir, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });

  await handleIpcCommand('toggle_mcp_server', {
    name: 'custom-mcp',
    enabled: true,
    cwd: projectDir,
  });
  await handleIpcCommand('toggle_pi_resource', {
    kind: 'extension',
    source: 'extensions/editor.ts',
    enabled: true,
    cwd: projectDir,
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(getEffectiveMcpActivation(policy, projectDir, 'custom-mcp'), true);
  assert.strictEqual(getEffectiveExtensionActivation(policy, projectDir, 'extensions/editor.ts'), true);
});

test('Startup enforcement: computeRpcStartupArgs includes --no-extensions, authorized -e, and builtin:mcp or --no-mcp', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const projectDir = path.join(fakeAgentDir, 'proj');
  fs.mkdirSync(path.join(projectDir, '.pi'), { recursive: true });

  // Set up an extension in global settings
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['./global-ext.ts'] }, null, 2)
  );

  // Case 1: No resources active -> --no-extensions and --no-mcp, no builtin:mcp
  const args1 = await computeRpcStartupArgs(projectDir);
  assert.ok(args1.includes('--no-extensions'));
  assert.ok(args1.includes('--no-mcp'));
  assert.ok(!args1.includes('builtin:mcp'));

  // Case 2: Authorize global-ext.ts and an MCP server
  await setResourceActivation({
    kind: 'extension',
    identity: './global-ext.ts',
    enabled: true,
    cwd: projectDir,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'any-server',
    enabled: true,
    cwd: projectDir,
  });

  const args2 = await computeRpcStartupArgs(projectDir);
  assert.ok(args2.includes('--no-extensions'));
  assert.ok(args2.includes('--extension'));
  assert.ok(!args2.includes('--no-mcp'));
  assert.ok(args2.includes('builtin:mcp'));

  // Extension runtime path is resolved relative to owning settings directory
  const expectedPath = path.resolve(fakeAgentDir, './global-ext.ts');
  assert.ok(
    args2.some((arg) => path.resolve(arg) === expectedPath),
    'Authorized extension runtime path must resolve relative to owning settings dir'
  );
});

test('Startup enforcement: materializeProjectMcpEnforcement writes atomic .pi/mcp.json preserving local definitions', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  // Global mcp.json with a server
  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'global-api': { command: 'node', args: ['api.js'], env: { SECRET: '123' } },
      },
    }, null, 2)
  );

  const projectDir = path.join(fakeAgentDir, 'proj');
  const projectPiDir = path.join(projectDir, '.pi');
  fs.mkdirSync(projectPiDir, { recursive: true });

  // Existing project .pi/mcp.json with unrelated key and complete local server definition
  const initialProjectMcp = {
    customMetadata: 'keep-me',
    mcpServers: {
      'local-worker': {
        command: 'python',
        args: ['worker.py'],
        env: { PORT: '5000' },
        enabled: true,
      },
    },
  };
  fs.writeFileSync(path.join(projectPiDir, 'mcp.json'), JSON.stringify(initialProjectMcp, null, 2));

  // Policy: local-worker is authorized, global-api is NOT authorized
  await setResourceActivation({
    kind: 'mcp',
    identity: 'local-worker',
    enabled: true,
    cwd: projectDir,
  });

  await materializeProjectMcpEnforcement(projectDir);

  const materialized = JSON.parse(fs.readFileSync(path.join(projectPiDir, 'mcp.json'), 'utf8'));
  assert.strictEqual(materialized.customMetadata, 'keep-me', 'Unrelated top-level metadata must be preserved');

  // Complete local definition is preserved with native enabled: true, without legacy disabled property
  assert.strictEqual(materialized.mcpServers['local-worker'].command, 'python');
  assert.deepStrictEqual(materialized.mcpServers['local-worker'].args, ['worker.py']);
  assert.deepStrictEqual(materialized.mcpServers['local-worker'].env, { PORT: '5000' });
  assert.strictEqual(materialized.mcpServers['local-worker'].enabled, true);
  assert.strictEqual(materialized.mcpServers['local-worker'].disabled, undefined, 'Must not include legacy disabled property');

  // Global server gets minimal override with enabled: false, without copying secrets/definitions
  assert.strictEqual(materialized.mcpServers['global-api'].enabled, false);
  assert.strictEqual(materialized.mcpServers['global-api'].disabled, undefined, 'Must not include legacy disabled property');
  assert.strictEqual(materialized.mcpServers['global-api'].command, undefined);
  assert.strictEqual(materialized.mcpServers['global-api'].env, undefined);
});

test('Startup enforcement: NODE_TEST_CONTEXT environment variable cannot bypass enforcement', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-test-ctx-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global server
  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'prod-server': { command: 'node', args: ['server.js'] },
      },
    }, null, 2)
  );

  const originalContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'test-context-active';
  t.after(() => {
    if (originalContext !== undefined) {
      process.env.NODE_TEST_CONTEXT = originalContext;
    } else {
      delete process.env.NODE_TEST_CONTEXT;
    }
  });

  await materializeProjectMcpEnforcement(projectDir);

  const targetMcp = path.join(projectDir, '.pi', 'mcp.json');
  assert.ok(fs.existsSync(targetMcp), 'Enforcement must run and write .pi/mcp.json even when NODE_TEST_CONTEXT is present');
  const parsed = JSON.parse(fs.readFileSync(targetMcp, 'utf8'));
  assert.strictEqual(parsed.mcpServers['prod-server'].enabled, false, 'Default inactive state must be enforced');
  assert.strictEqual(parsed.mcpServers['prod-server'].disabled, undefined);
});

test('Startup enforcement: corrupted policy file fails closed on enforcement', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-corrupt-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Corrupted viewer-resource-activation.json
  fs.writeFileSync(
    path.join(fakeAgentDir, 'viewer-resource-activation.json'),
    'INVALID JSON {'
  );

  await assert.rejects(
    async () => {
      await materializeProjectMcpEnforcement(projectDir);
    },
    /Failed to read viewer resource activation policy/
  );
});

test('Startup enforcement: corrupted global mcp.json fails closed on enforcement', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-corrupt-global-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Corrupted global mcp.json
  fs.writeFileSync(path.join(fakeAgentDir, 'mcp.json'), 'NOT JSON');

  await assert.rejects(
    async () => {
      await materializeProjectMcpEnforcement(projectDir);
    },
    /Failed to enforce MCP resource activation: Cannot parse global/
  );
});

test('Startup enforcement: fail closed on policy errors when .pi/mcp.json cannot be written', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { s1: { command: 'node' } } }, null, 2)
  );

  const projectDir = path.join(fakeAgentDir, 'proj-readonly');
  fs.mkdirSync(projectDir, { recursive: true });

  // Create .pi as a file so writing .pi/mcp.json fails
  fs.writeFileSync(path.join(projectDir, '.pi'), 'blocking file');

  await assert.rejects(
    async () => {
      await materializeProjectMcpEnforcement(projectDir);
    },
    /Failed to enforce MCP resource activation/
  );
});

test('Partial local MCP definitions: getMcpServersImpl merges partial overrides preserving global config', () => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);

  // Global server definition
  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'data-service': { command: 'node', args: ['data.js'], env: { KEY: 'xyz' } },
      },
    }, null, 2)
  );

  const projectDir = path.join(fakeAgentDir, 'proj');
  const projectPi = path.join(projectDir, '.pi');
  fs.mkdirSync(projectPi, { recursive: true });

  // Partial override in project (only enabled: false without command/args)
  fs.writeFileSync(
    path.join(projectPi, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'data-service': { enabled: false },
      },
    }, null, 2)
  );

  // When reading project servers, global command & args must be preserved on data-service
  const res = getMcpServersImpl(projectDir);
  const s = res.servers.find((srv: any) => srv.name === 'data-service');
  assert.ok(s);
  assert.strictEqual(s.command, 'node', 'Global command must be preserved');
  assert.deepStrictEqual(s.args, ['data.js']);
  assert.strictEqual(s.hasProjectOverride, true);

  setPiAgentDirForTest(null);
  fs.rmSync(fakeAgentDir, { recursive: true, force: true });
});

test('B1 regression: handleToggleMcpServer with cwd and global configPath preserves global file byte-for-byte and updates project policy', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-b1-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const globalMcpPath = path.join(fakeAgentDir, 'mcp.json');
  const initialContent = JSON.stringify(
    {
      mcpServers: {
        'shared-global': {
          command: 'node',
          args: ['shared.js'],
          env: { GLOBAL_SECRET: 'top-secret' },
          enabled: true,
        },
      },
    },
    null,
    2
  ) + '\n';
  fs.writeFileSync(globalMcpPath, initialContent, 'utf8');
  const bytesBefore = fs.readFileSync(globalMcpPath);

  // Client toggles the server in a project, passing configPath pointing to the global file
  const res: any = await handleIpcCommand('toggle_mcp_server', {
    name: 'shared-global',
    enabled: false,
    cwd: projectDir,
    configPath: globalMcpPath,
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.enabled, false);

  // Global file must be strictly byte-identical
  const bytesAfter = fs.readFileSync(globalMcpPath);
  assert.ok(bytesBefore.equals(bytesAfter), 'Global mcp.json must remain byte-identical after project toggle');

  // Policy must record the override for projectDir
  const policy = loadResourceActivationPolicy();
  assert.strictEqual(
    getEffectiveMcpActivation(policy, projectDir, 'shared-global'),
    false,
    'Project activation must record disabled override'
  );
});

test('B2 regression: discoverAllExtensions resolves relative paths against owning config directory (.pi.json ./root-tool.ts resolves to cwd/root-tool.ts)', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-b2-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Write .pi.json at the workspace root
  fs.writeFileSync(
    path.join(projectDir, '.pi.json'),
    JSON.stringify({
      extensions: ['./root-tool.ts'],
    }, null, 2)
  );

  // Authorize ./root-tool.ts in project policy
  await setResourceActivation({
    kind: 'extension',
    identity: './root-tool.ts',
    enabled: true,
    cwd: projectDir,
  });

  const startupArgs = await computeRpcStartupArgs(projectDir);
  const expectedResolvedPath = path.resolve(projectDir, 'root-tool.ts');
  const unexpectedWrongSubdirPath = path.resolve(projectDir, '.pi', 'root-tool.ts');

  assert.ok(
    startupArgs.includes(expectedResolvedPath),
    `Startup args must contain extension path resolved to cwd/root-tool.ts (${expectedResolvedPath})`
  );
  assert.ok(
    !startupArgs.includes(unexpectedWrongSubdirPath),
    `Startup args must NOT contain wrong hardcoded .pi subdir path (${unexpectedWrongSubdirPath})`
  );
});

test('B3 regression: materializeProjectMcpEnforcement merges alternate .mcp.json local servers (authorized complete preserved, unauthorized false in native file)', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-b3-');
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
        'global-worker': { command: 'node', args: ['worker.js'] },
      },
    }, null, 2)
  );

  // Alternate .mcp.json in workspace root (no .pi/mcp.json yet)
  const altMcp = {
    metadata: { team: 'core', version: '2.0' },
    mcpServers: {
      'alt-authorized': {
        command: 'node',
        args: ['authorized.js'],
        env: { API_KEY: 'xyz' },
        headers: { 'X-Custom': 'val' },
      },
      'alt-unauthorized': {
        command: 'python',
        args: ['unauthorized.py'],
        env: { DB: 'sqlite' },
      },
    },
  };
  fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify(altMcp, null, 2));

  // Authorize alt-authorized only
  await setResourceActivation({
    kind: 'mcp',
    identity: 'alt-authorized',
    enabled: true,
    cwd: projectDir,
  });

  await materializeProjectMcpEnforcement(projectDir);

  const nativeMcpPath = path.join(projectDir, '.pi', 'mcp.json');
  assert.ok(fs.existsSync(nativeMcpPath), 'Native .pi/mcp.json must be materialized');

  const materialized = JSON.parse(fs.readFileSync(nativeMcpPath, 'utf8'));

  // Unrelated metadata preserved from alternate file
  assert.deepStrictEqual(materialized.metadata, { team: 'core', version: '2.0' });

  // Authorized alternate server complete definition preserved with native enabled: true
  const authSrv = materialized.mcpServers['alt-authorized'];
  assert.ok(authSrv, 'Authorized alternate server must be present in native file');
  assert.strictEqual(authSrv.command, 'node');
  assert.deepStrictEqual(authSrv.args, ['authorized.js']);
  assert.deepStrictEqual(authSrv.env, { API_KEY: 'xyz' });
  assert.deepStrictEqual(authSrv.headers, { 'X-Custom': 'val' });
  assert.strictEqual(authSrv.enabled, true);
  assert.strictEqual(authSrv.disabled, undefined, 'Must not emit legacy disabled');

  // Unauthorized alternate server emitted with enabled: false
  const unauthSrv = materialized.mcpServers['alt-unauthorized'];
  assert.ok(unauthSrv, 'Unauthorized alternate server must be present in native file');
  assert.strictEqual(unauthSrv.enabled, false);
  assert.strictEqual(unauthSrv.disabled, undefined, 'Must not emit legacy disabled');

  // Global worker emitted with minimal enabled: false override
  const globSrv = materialized.mcpServers['global-worker'];
  assert.ok(globSrv);
  assert.strictEqual(globSrv.enabled, false);
  assert.strictEqual(globSrv.command, undefined, 'Must not duplicate global command');
});

test('Advisory regression: corrupted supported alternate configs fail closed rather than swallow parsing', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-corrupt-alt-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Corrupted .mcp.json
  fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{ MALFORMED JSON');

  await assert.rejects(
    async () => {
      await materializeProjectMcpEnforcement(projectDir);
    },
    /Failed to enforce MCP resource activation: Cannot parse/
  );

  assert.throws(
    () => {
      getMcpServersImpl(projectDir);
    },
    /Failed to parse MCP configuration file/
  );
});

test('MCP server identity: distinct foo-bar and foo_bar must not authorize each other', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-exact-mcp-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global mcp.json defines two distinct servers: foo-bar and foo_bar
  fs.writeFileSync(
    path.join(fakeAgentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'foo-bar': { command: 'node', args: ['dash.js'] },
        'foo_bar': { command: 'node', args: ['underscore.js'] },
      },
    }, null, 2)
  );

  // Authorize only foo-bar in project policy
  await setResourceActivation({
    kind: 'mcp',
    identity: 'foo-bar',
    enabled: true,
    cwd: projectDir,
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(getEffectiveMcpActivation(policy, projectDir, 'foo-bar'), true);
  assert.strictEqual(
    getEffectiveMcpActivation(policy, projectDir, 'foo_bar'),
    false,
    'Distinct foo_bar must NOT be authorized when foo-bar is authorized'
  );

  // Listings must maintain separate cards
  const res = getMcpServersImpl(projectDir);
  assert.strictEqual(res.servers.length, 2, 'foo-bar and foo_bar must remain distinct cards');
  const sDash = res.servers.find((s: any) => s.name === 'foo-bar');
  const sUnder = res.servers.find((s: any) => s.name === 'foo_bar');
  assert.ok(sDash && sUnder);
  assert.strictEqual(sDash.enabled, true);
  assert.strictEqual(sDash.hasProjectOverride, true);
  assert.strictEqual(sUnder.enabled, false);
  assert.strictEqual(sUnder.hasProjectOverride, false);

  // Materialize enforcement into .pi/mcp.json
  await materializeProjectMcpEnforcement(projectDir);
  const materialized = JSON.parse(fs.readFileSync(path.join(projectDir, '.pi', 'mcp.json'), 'utf8'));
  assert.strictEqual(materialized.mcpServers['foo-bar'].enabled, true);
  assert.strictEqual(materialized.mcpServers['foo_bar'].enabled, false);
});

test('normalizeProjectCwd: symlink/junction resolves to same canonical project policy target as realpath', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const targetDir = createTempDir('proj-target-');
  const aliasDir = path.join(os.tmpdir(), `proj-alias-${Date.now()}`);

  try {
    fs.symlinkSync(targetDir, aliasDir, 'junction');
  } catch {
    // Skip if permissions prevent junction creation
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    return;
  }

  t.after(() => {
    setPiAgentDirForTest(null);
    try {
      fs.unlinkSync(aliasDir);
    } catch {}
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  const normTarget = normalizeProjectCwd(targetDir);
  const normAlias = normalizeProjectCwd(aliasDir);
  assert.strictEqual(
    normAlias,
    normTarget,
    'Symlink/junction alias must normalize to exact same project key as target'
  );

  // Authorize resource using aliasDir
  await setResourceActivation({
    kind: 'extension',
    identity: 'ext-sym.ts',
    enabled: true,
    cwd: aliasDir,
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(
    getEffectiveExtensionActivation(policy, targetDir, 'ext-sym.ts'),
    true,
    'Policy looked up via targetDir must match activation set via aliasDir'
  );
});

test('MCP candidate parity: .agents/mcp.json candidate recognized, preserved across repeated startups', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-agents-mcp-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Create .agents/mcp.json
  const agentsDir = path.join(projectDir, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'mcp.json'),
    JSON.stringify({
      customMeta: 'agents-config',
      mcpServers: {
        'agent-tool': {
          command: 'node',
          args: ['agent.js'],
          env: { AGENT: '1' },
        },
      },
    }, null, 2)
  );

  // Listing recognizes .agents/mcp.json
  const listingBefore = getMcpServersImpl(projectDir);
  const agentSrv = listingBefore.servers.find((s: any) => s.name === 'agent-tool');
  assert.ok(agentSrv, '.agents/mcp.json server must be discovered in listings');
  assert.strictEqual(agentSrv.enabled, false, 'Defaults off');

  // Startup 1: Unauthorized by default -> materialized into .pi/mcp.json with enabled: false
  await materializeProjectMcpEnforcement(projectDir);
  const nativePath = path.join(projectDir, '.pi', 'mcp.json');
  assert.ok(fs.existsSync(nativePath));
  let materialized = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
  assert.strictEqual(materialized.customMeta, 'agents-config', 'Metadata from .agents/mcp.json preserved');
  assert.strictEqual(materialized.mcpServers['agent-tool'].enabled, false);
  assert.strictEqual(materialized.mcpServers['agent-tool'].command, 'node', 'Full definition preserved');

  // User authorizes agent-tool
  await setResourceActivation({
    kind: 'mcp',
    identity: 'agent-tool',
    enabled: true,
    cwd: projectDir,
  });

  // Startup 2 (Repeated startup): Reads existing .pi/mcp.json and .agents/mcp.json -> materializes with enabled: true
  await materializeProjectMcpEnforcement(projectDir);
  materialized = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
  assert.strictEqual(materialized.customMeta, 'agents-config');
  assert.strictEqual(materialized.mcpServers['agent-tool'].enabled, true, 'Updated to enabled: true on repeated startup');
  assert.strictEqual(materialized.mcpServers['agent-tool'].command, 'node', 'Full definition still preserved');
  assert.deepStrictEqual(materialized.mcpServers['agent-tool'].env, { AGENT: '1' });
});

test('Extension override: relative ./ prefix in project settings matches global extension and marks hasProjectOverride', (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-ext-prefix-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global settings defines "extensions/my-tool.ts"
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['extensions/my-tool.ts'] }, null, 2)
  );

  // Project settings overrides with "./extensions/my-tool.ts"
  fs.mkdirSync(path.join(projectDir, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.pi', 'settings.json'),
    JSON.stringify({ extensions: ['./extensions/my-tool.ts'] }, null, 2)
  );

  const res = getPiResourcesImpl(projectDir);
  const ext = res.resources.find((r: any) => r.kind === 'extension' && r.source.includes('my-tool'));
  assert.ok(ext, 'Extension card must exist');
  assert.strictEqual(ext.hasProjectOverride, true, 'hasProjectOverride must be true despite ./ prefix differences');
});

test('S6: bytes unchanged global on project toggle', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-bytes-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Set up global policy with an always-on exception and a legacy project entry
  await setResourceActivation({
    kind: 'extension',
    identity: 'global-shared.ts',
    enabled: true,
  });

  const globalPolicyPath = path.join(fakeAgentDir, 'viewer-resource-activation.json');
  assert.ok(fs.existsSync(globalPolicyPath));
  const bytesBefore = fs.readFileSync(globalPolicyPath);

  // Toggle project override
  await setResourceActivation({
    kind: 'extension',
    identity: 'project-local.ts',
    enabled: true,
    cwd: projectDir,
  });

  await setResourceActivation({
    kind: 'mcp',
    identity: 'local-mcp',
    enabled: true,
    cwd: projectDir,
  });

  // Global policy file bytes must be completely unchanged
  const bytesAfter = fs.readFileSync(globalPolicyPath);
  assert.ok(bytesBefore.equals(bytesAfter), 'Global viewer-resource-activation.json must remain byte-identical after project toggle');

  // Local file must be created with the overrides
  const localFile = getProjectResourceActivationPath(projectDir);
  assert.ok(fs.existsSync(localFile), 'Project local resource-activation.json must exist');
  const localData = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  assert.strictEqual(localData.version, 1);
  assert.strictEqual(localData.extensions['project-local.ts'], true);
  assert.strictEqual(localData.mcpServers['local-mcp'], true);
});

test('S6: directory move with local overrides preserves project activation', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir1 = createTempDir('proj-move-src-');
  const projectDir2 = path.join(os.tmpdir(), `proj-move-dest-${Date.now()}`);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    try {
      fs.rmSync(projectDir1, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(projectDir2, { recursive: true, force: true });
    } catch {}
  });

  // Set project activation on projectDir1
  await setResourceActivation({
    kind: 'extension',
    identity: 'portable-ext.ts',
    enabled: true,
    cwd: projectDir1,
  });
  await setResourceActivation({
    kind: 'mcp',
    identity: 'portable-mcp',
    enabled: true,
    cwd: projectDir1,
  });

  const policy = loadResourceActivationPolicy();
  assert.strictEqual(getEffectiveExtensionActivation(policy, projectDir1, 'portable-ext.ts'), true);
  assert.strictEqual(getEffectiveMcpActivation(policy, projectDir1, 'portable-mcp'), true);

  // Move project directory to projectDir2
  fs.renameSync(projectDir1, projectDir2);

  // Overrides must move with directory and be active in projectDir2
  assert.strictEqual(getEffectiveExtensionActivation(policy, projectDir2, 'portable-ext.ts'), true);
  assert.strictEqual(getEffectiveMcpActivation(policy, projectDir2, 'portable-mcp'), true);
});

test('S6: authoritative empty local masks legacy global overrides', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-mask-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const normCwd = normalizeProjectCwd(projectDir);

  // Write legacy global policy with project overrides
  const legacyPolicy = {
    version: 1,
    alwaysExtensions: [],
    alwaysMcpServers: [],
    projects: {
      [normCwd]: {
        extensions: { 'legacy-tool.ts': true },
        mcpServers: { 'legacy-server': true },
      },
    },
  };
  fs.writeFileSync(
    path.join(fakeAgentDir, 'viewer-resource-activation.json'),
    JSON.stringify(legacyPolicy, null, 2)
  );

  // Before local file exists: falls back to legacy
  let policy = loadResourceActivationPolicy();
  assert.strictEqual(getEffectiveExtensionActivation(policy, projectDir, 'legacy-tool.ts'), true);
  assert.strictEqual(getEffectiveMcpActivation(policy, projectDir, 'legacy-server'), true);

  // Now create authoritative empty local file using saveProjectResourceActivation
  const emptyLocal = { version: 1 as const, extensions: {}, mcpServers: {} };
  saveProjectResourceActivation(projectDir, emptyLocal);

  // Verify loadProjectResourceActivation reads it accurately
  const loadedEmpty = loadProjectResourceActivation(projectDir);
  assert.ok(loadedEmpty);
  assert.strictEqual(loadedEmpty.version, 1);
  assert.deepStrictEqual(loadedEmpty.extensions, {});
  assert.deepStrictEqual(loadedEmpty.mcpServers, {});

  // Local file must be authoritative: absent keys must NOT resurrect stale global legacy overrides
  policy = loadResourceActivationPolicy();
  assert.strictEqual(
    getEffectiveExtensionActivation(policy, projectDir, 'legacy-tool.ts'),
    false,
    'Empty local extensions must mask legacy overrides'
  );
  assert.strictEqual(
    getEffectiveMcpActivation(policy, projectDir, 'legacy-server'),
    false,
    'Empty local mcpServers must mask legacy overrides'
  );

  // Listings must show hasProjectOverride: false and enabled: false
  const mcpList = getMcpServersImpl(projectDir);
  const mcpItem = mcpList.servers.find((s: any) => s.name === 'legacy-server');
  if (mcpItem) {
    assert.strictEqual(mcpItem.enabled, false);
    assert.strictEqual(mcpItem.hasProjectOverride, false);
  }
});

test('S6: no read writes during resource listings and startup computation', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-no-write-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const localFile = getProjectResourceActivationPath(projectDir);
  assert.strictEqual(fs.existsSync(localFile), false);

  // Perform all read/discovery operations
  getMcpServersImpl(projectDir);
  getPiResourcesImpl(projectDir);
  discoverAllExtensions(projectDir);
  await computeRpcStartupArgs(projectDir);

  // Local file must still NOT exist
  assert.strictEqual(fs.existsSync(localFile), false, 'Listing and discovery operations must never write local resource-activation.json');
});

test('S6: first-toggle seeding from legacy global without mutating global', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-seed-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const normCwd = normalizeProjectCwd(projectDir);

  // Legacy global policy with prior choices
  const legacyPolicy = {
    version: 1,
    alwaysExtensions: ['global-ext.ts'],
    alwaysMcpServers: ['global-mcp'],
    projects: {
      [normCwd]: {
        extensions: { 'prior-ext.ts': true },
        mcpServers: { 'prior-mcp': true },
      },
    },
  };
  const globalPolicyPath = path.join(fakeAgentDir, 'viewer-resource-activation.json');
  fs.writeFileSync(globalPolicyPath, JSON.stringify(legacyPolicy, null, 2) + '\n');
  const globalBytesBefore = fs.readFileSync(globalPolicyPath);

  const localFile = getProjectResourceActivationPath(projectDir);
  assert.strictEqual(fs.existsSync(localFile), false);

  // First toggle on project: seed legacy, apply toggle, write local only
  await setResourceActivation({
    kind: 'extension',
    identity: 'new-added-ext.ts',
    enabled: true,
    cwd: projectDir,
  });

  assert.ok(fs.existsSync(localFile), 'Local resource-activation.json must be created on first toggle');
  const localData = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  assert.strictEqual(localData.version, 1);
  assert.strictEqual(localData.extensions['prior-ext.ts'], true, 'Legacy extension must be seeded into local file');
  assert.strictEqual(localData.extensions['new-added-ext.ts'], true, 'New toggle must be recorded');
  assert.strictEqual(localData.mcpServers['prior-mcp'], true, 'Legacy MCP server must be seeded into local file');

  // Global file bytes must be unchanged
  const globalBytesAfter = fs.readFileSync(globalPolicyPath);
  assert.ok(globalBytesBefore.equals(globalBytesAfter), 'Global policy must remain unchanged on first toggle');

  // Subsequent toggle writes local only
  await setResourceActivation({
    kind: 'mcp',
    identity: 'new-mcp-server',
    enabled: true,
    cwd: projectDir,
  });

  const localData2 = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  assert.strictEqual(localData2.mcpServers['new-mcp-server'], true);
  assert.strictEqual(localData2.mcpServers['prior-mcp'], true);
  const globalBytesFinal = fs.readFileSync(globalPolicyPath);
  assert.ok(globalBytesBefore.equals(globalBytesFinal), 'Global policy must remain unchanged on subsequent toggle');
});

test('S6: malformed local aborts spawn and enforcement fails closed', async (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-malformed-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const localPi = path.join(projectDir, '.pi');
  fs.mkdirSync(localPi, { recursive: true });
  fs.writeFileSync(path.join(localPi, 'resource-activation.json'), '{{ MALFORMED JSON');

  // Startup operations must fail closed (abort spawn)
  await assert.rejects(
    async () => {
      await computeRpcStartupArgs(projectDir);
    },
    /Failed to read project resource activation/
  );

  await assert.rejects(
    async () => {
      await materializeProjectMcpEnforcement(projectDir);
    },
    /Failed to read project resource activation/
  );

  // Listings must fail closed
  assert.throws(
    () => {
      getMcpServersImpl(projectDir);
    },
    /Failed to read project resource activation/
  );

  assert.throws(
    () => {
      getPiResourcesImpl(projectDir);
    },
    /Failed to read project resource activation/
  );
});

test('S6: metadata paths/name index trio and explicit declared name', (t) => {
  const fakeAgentDir = createTempDir('pi-agent-test-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createTempDir('proj-metadata-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const projectPi = path.join(projectDir, '.pi');
  fs.mkdirSync(projectPi, { recursive: true });

  // Create extension directory structures
  const toolDir = path.join(projectPi, 'tools', 'code-linter');
  const pluginDir = path.join(projectPi, 'plugins', 'formatter');
  const scriptDir = path.join(projectPi, 'scripts', 'bundler');
  const namedDir = path.join(projectPi, 'custom', 'special');
  const helperDir = path.join(projectPi, 'helpers');

  fs.mkdirSync(toolDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(namedDir, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });

  fs.writeFileSync(path.join(toolDir, 'index.ts'), '// linter');
  fs.writeFileSync(path.join(pluginDir, 'index.js'), '// formatter');
  fs.writeFileSync(path.join(scriptDir, 'index.mjs'), '// bundler');
  fs.writeFileSync(path.join(namedDir, 'index.ts'), '// named');
  fs.writeFileSync(path.join(helperDir, 'my-helper.ts'), '// helper');

  const settingsPath = path.join(projectPi, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        extensions: [
          './tools/code-linter/index.ts',
          './plugins/formatter/index.js',
          './scripts/bundler/index.mjs',
          { name: 'Explicitly Declared Extension', source: './custom/special/index.ts' },
          './helpers/my-helper.ts',
        ],
      },
      null,
      2
    )
  );

  const res = getPiResourcesImpl(projectDir);
  const exts = res.resources.filter((r: any) => r.kind === 'extension');

  // 1. Unnamed index.ts -> name is containing folder "code-linter"
  const linter = exts.find((r: any) => r.source.includes('code-linter'));
  assert.ok(linter);
  assert.strictEqual(linter.name, 'code-linter', 'Unnamed index.ts must use containing directory name');
  assert.strictEqual(linter.extensionPath, path.resolve(toolDir, 'index.ts'));
  assert.strictEqual(linter.extensionDir, path.resolve(toolDir));
  assert.strictEqual(linter.configPath, settingsPath, 'configPath must point to settings.json, distinct from extensionPath');

  // 2. Unnamed index.js -> name is containing folder "formatter"
  const formatter = exts.find((r: any) => r.source.includes('formatter'));
  assert.ok(formatter);
  assert.strictEqual(formatter.name, 'formatter', 'Unnamed index.js must use containing directory name');
  assert.strictEqual(formatter.extensionPath, path.resolve(pluginDir, 'index.js'));
  assert.strictEqual(formatter.extensionDir, path.resolve(pluginDir));
  assert.strictEqual(formatter.configPath, settingsPath);

  // 3. Unnamed index.mjs -> name is containing folder "bundler"
  const bundler = exts.find((r: any) => r.source.includes('bundler'));
  assert.ok(bundler);
  assert.strictEqual(bundler.name, 'bundler', 'Unnamed index.mjs must use containing directory name');
  assert.strictEqual(bundler.extensionPath, path.resolve(scriptDir, 'index.mjs'));
  assert.strictEqual(bundler.extensionDir, path.resolve(scriptDir));
  assert.strictEqual(bundler.configPath, settingsPath);

  // 4. Explicit declared name is preserved
  const explicit = exts.find((r: any) => r.source.includes('custom/special'));
  assert.ok(explicit);
  assert.strictEqual(explicit.name, 'Explicitly Declared Extension', 'Explicit declared name must be preserved');
  assert.strictEqual(explicit.extensionPath, path.resolve(namedDir, 'index.ts'));
  assert.strictEqual(explicit.extensionDir, path.resolve(namedDir));
  assert.strictEqual(explicit.configPath, settingsPath);

  // 5. Regular file -> name is base name without extension
  const helper = exts.find((r: any) => r.source.includes('my-helper'));
  assert.ok(helper);
  assert.strictEqual(helper.name, 'my-helper');
  assert.strictEqual(helper.extensionPath, path.resolve(helperDir, 'my-helper.ts'));
  assert.strictEqual(helper.extensionDir, path.resolve(helperDir));
  assert.strictEqual(helper.configPath, settingsPath);
});
