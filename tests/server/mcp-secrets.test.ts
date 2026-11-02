import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleIpcCommand, setPiAgentDirForTest } from '@server/web-ipc-bridge';

test('MCP responses hide stored env, headers, URL and arguments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-secrets-'));
  setPiAgentDirForTest(dir);
  try {
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'node', args: ['secret-argument'], url: 'https://secret-url.test', env: { TOKEN: 'secret-env' }, headers: { Authorization: 'secret-header' } } } }));
    const result = await handleIpcCommand('get_mcp_servers', {});
    const output = JSON.stringify(result);
    for (const secret of ['secret-argument', 'secret-url', 'secret-env', 'secret-header']) assert.equal(output.includes(secret), false, `${secret} leaked`);
    assert.deepEqual(result.servers[0].envKeys, ['TOKEN']);
  } finally {
    setPiAgentDirForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit transport switch replaces incompatible connection fields in project scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-switch-'));
  setPiAgentDirForTest(dir);
  const cwd = path.join(dir, 'project');
  const file = path.join(cwd, '.pi', 'mcp.json');
  try {
    await handleIpcCommand('save_mcp_server', { name: 'test', cwd, scope: 'project', server: { type: 'stdio', command: 'node', args: ['old-arg'] } });
    await handleIpcCommand('save_mcp_server', { name: 'test', cwd, scope: 'project', server: { type: 'sse', url: 'https://new.test' } });
    let saved = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.test;
    assert.equal(saved.command, undefined); assert.equal(saved.args, undefined); assert.equal(saved.url, 'https://new.test');
    await handleIpcCommand('save_mcp_server', { name: 'test', cwd, scope: 'project', server: { type: 'stdio', command: 'python', args: ['new-arg'] } });
    saved = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.test;
    assert.equal(saved.url, undefined); assert.equal(saved.command, 'python'); assert.deepEqual(saved.args, ['new-arg']);
    await handleIpcCommand('delete_mcp_server', { name: 'test', cwd, scope: 'project' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.test, undefined);
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MCP save preserves blanks, replaces values, deletes null keys and import does not overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-save-'));
  setPiAgentDirForTest(dir);
  const file = path.join(dir, 'mcp.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { example: { command: 'node', args: ['old-arg'], url: 'https://old.test', env: { A: 'old-a', B: 'old-b' }, headers: { H: 'old-h', D: 'delete' } } } }));
    await handleIpcCommand('save_mcp_server', { name: 'example', scope: 'global', server: { command: 'node', args: [], url: '', env: { A: '', B: 'new-b' }, headers: { H: '', D: null } } });
    let saved = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.example;
    assert.deepEqual(saved.args, ['old-arg']); assert.equal(saved.url, 'https://old.test');
    assert.deepEqual(saved.env, { A: 'old-a', B: 'new-b' }); assert.deepEqual(saved.headers, { H: 'old-h' });
    await handleIpcCommand('save_mcp_server', { name: 'example', scope: 'global', server: { args: ['new-arg'], url: 'https://new.test', env: { A: null } } });
    saved = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.example;
    assert.deepEqual(saved.args, ['new-arg']); assert.equal(saved.url, 'https://new.test'); assert.deepEqual(saved.env, { B: 'new-b' });
    assert.deepEqual(await handleIpcCommand('import_mcp_servers', { servers: [{ name: 'example', command: 'overwrite' }, { name: 'fresh', command: 'new' }] }), { imported: true });
    const all = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
    assert.equal(all.example.command, 'node'); assert.equal(all.fresh.command, 'new');
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});
