import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleIpcCommand, setPiAgentDirForTest } from '@server/web-ipc-bridge';

function fixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-resource-delete-'));
  const agent = path.join(root, 'agent');
  const project = path.join(root, 'project');
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  setPiAgentDirForTest(agent);
  const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { agent, project, write, read, cleanup() {
    setPiAgentDirForTest(null);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } };
}

test('web MCP deletion removes only the requested global definition and preserves project configuration', async () => {
  const f = fixture();
  try {
    const global = path.join(f.agent, 'mcp.json');
    const project = path.join(f.project, '.pi', 'mcp.json');
    f.write(global, { metadata: 'keep', mcpServers: { selected: { command: 'selected' }, other: { command: 'other' } } });
    f.write(project, { mcpServers: { selected: { enabled: false } } });
    const projectBefore = fs.readFileSync(project, 'utf8');
    const result = await handleIpcCommand('delete_mcp_server', { name: 'selected', scope: 'global', cwd: f.project });
    assert.deepEqual(result, { success: true, name: 'selected', path: global });
    assert.deepEqual(f.read(global), { metadata: 'keep', mcpServers: { other: { command: 'other' } } });
    assert.equal(fs.readFileSync(project, 'utf8'), projectBefore);
    // Use the isolated agent directory as a project with no project MCP configuration.
    const globalListing = await handleIpcCommand('get_mcp_servers', { cwd: f.agent });
    assert.deepEqual(globalListing.servers.map((s: any) => s.name), ['other']);
    const projectListing = await handleIpcCommand('get_mcp_servers', { cwd: f.project });
    assert.deepEqual(projectListing.servers.map((s: any) => s.name).sort(), ['other', 'selected']);
    const preserved = projectListing.servers.find((s: any) => s.name === 'selected');
    assert.equal(preserved.scope, 'project');
    assert.equal(preserved.configPath, project);
  } finally { f.cleanup(); }
});

test('web extension deletion matches disabled directory entries and preserves packages and source files', async () => {
  const f = fixture();
  try {
    const settings = path.join(f.agent, 'settings.json');
    const extension = path.join(f.agent, 'extensions', 'selected', 'index.ts');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, '// keep extension code');
    f.write(settings, { theme: 'dark', extensions: ['!extensions/selected', { source: 'other', custom: true }], packages: ['npm:keep'] });
    const result = await handleIpcCommand('delete_pi_resource', { kind: 'extension', source: 'selected/index.ts', scope: 'global' });
    assert.deepEqual(result, { success: true, id: 'global:extension:selected/index.ts', kind: 'extension', source: 'selected/index.ts', scope: 'global', configPath: settings, requiresReload: true });
    assert.deepEqual(f.read(settings), { theme: 'dark', extensions: [{ source: 'other', custom: true }], packages: ['npm:keep'] });
    assert.equal(fs.readFileSync(extension, 'utf8'), '// keep extension code');
  } finally { f.cleanup(); }
});

test('web deletion rejects invalid and missing targets without changing configuration', async () => {
  const f = fixture();
  try {
    const mcp = path.join(f.agent, 'mcp.json');
    const settings = path.join(f.agent, 'settings.json');
    f.write(mcp, { servers: { keep: { command: 'keep' } } });
    f.write(settings, { extensions: ['keep'], packages: ['npm:keep'] });
    const beforeMcp = fs.readFileSync(mcp, 'utf8');
    const beforeSettings = fs.readFileSync(settings, 'utf8');
    for (const [command, payload] of [
      ['delete_mcp_server', { name: 'missing', scope: 'global' }],
      ['delete_mcp_server', { name: '', scope: 'global' }],
      ['delete_mcp_server', { name: 'keep', scope: 'invalid' }],
      ['delete_mcp_server', { name: 'keep', scope: 'project' }],
      ['delete_pi_resource', { kind: 'extension', source: 'missing', scope: 'global' }],
      ['delete_pi_resource', { kind: 'invalid', source: 'keep', scope: 'global' }],
      ['delete_pi_resource', { kind: 'extension', source: '', scope: 'global' }],
      ['delete_pi_resource', { kind: 'extension', source: 'keep', scope: 'invalid' }],
      ['delete_pi_resource', { kind: 'extension', source: 'keep', scope: 'project' }],
    ] as const) {
      await assert.rejects(() => handleIpcCommand(command, payload));
      assert.equal(fs.readFileSync(mcp, 'utf8'), beforeMcp);
      assert.equal(fs.readFileSync(settings, 'utf8'), beforeSettings);
    }
  } finally { f.cleanup(); }
});

test('web deletion respects project scope and supports legacy MCP maps and package objects', async () => {
  const f = fixture();
  try {
    const global = path.join(f.agent, 'settings.json');
    const settings = path.join(f.project, '.pi.json');
    const mcp = path.join(f.project, '.mcp.json');
    f.write(global, { packages: ['npm:selected'], extensions: ['keep'] });
    f.write(settings, { packages: [{ source: 'npm:selected', extensions: ['keep'] }, 'npm:other'], extensions: ['keep'] });
    f.write(mcp, { metadata: true, servers: { selected: { command: 'selected' }, keep: { command: 'keep' } } });
    const before = fs.readFileSync(global, 'utf8');
    assert.equal((await handleIpcCommand('delete_mcp_server', { name: 'selected', scope: 'project', cwd: f.project })).path, mcp);
    assert.deepEqual(f.read(mcp), { metadata: true, servers: { keep: { command: 'keep' } } });
    assert.equal((await handleIpcCommand('delete_pi_resource', { kind: 'package', source: 'npm:selected', cwd: f.project })).scope, 'project');
    assert.deepEqual(f.read(settings), { packages: ['npm:other'], extensions: ['keep'] });
    assert.equal(fs.readFileSync(global, 'utf8'), before);
  } finally { f.cleanup(); }
});

test('web deletion rejects malformed files and preserves activation policies byte-for-byte', async () => {
  const f = fixture();
  try {
    const mcp = path.join(f.agent, 'mcp.json');
    const settings = path.join(f.agent, 'settings.json');
    const policy = path.join(f.agent, 'viewer-resource-activation.json');
    f.write(policy, { version: 1, alwaysExtensions: ['selected'], alwaysMcpServers: ['selected'], projects: {} });
    const before = fs.readFileSync(policy, 'utf8');
    for (const content of ['{broken', '[]', 'null']) {
      fs.writeFileSync(mcp, content);
      fs.writeFileSync(settings, content);
      await assert.rejects(() => handleIpcCommand('delete_mcp_server', { name: 'selected', scope: 'global' }));
      await assert.rejects(() => handleIpcCommand('delete_pi_resource', { kind: 'extension', source: 'selected', scope: 'global' }));
      assert.equal(fs.readFileSync(mcp, 'utf8'), content);
      assert.equal(fs.readFileSync(settings, 'utf8'), content);
    }
    f.write(mcp, { mcpServers: { selected: { command: 'selected' } } });
    f.write(settings, { extensions: ['selected'] });
    await handleIpcCommand('delete_mcp_server', { payload: { name: 'selected', scope: 'global' } });
    await handleIpcCommand('delete_pi_resource', { payload: { kind: 'extension', source: 'selected', scope: 'global' } });
    assert.equal(fs.readFileSync(policy, 'utf8'), before);
  } finally { f.cleanup(); }
});
