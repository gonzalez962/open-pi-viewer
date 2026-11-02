import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleIpcCommand, setPiAgentDirForTest } from '@server/web-ipc-bridge';
import { formDataToSavePayload, parseArgsText, serverConfigToFormData } from '../../../src/features/mcp/types';

test('argument parser preserves ordinary quotes, newlines and Windows paths', () => {
  assert.deepEqual(parseArgsText(`plain "two words" 'single words'\nC:\\temp\\new "C:\\Program Files\\node"`), ['plain', 'two words', 'single words', 'C:\\temp\\new', 'C:\\Program Files\\node']);
});

async function fixture(dir: string, args: string[]) {
  setPiAgentDirForTest(dir);
  await handleIpcCommand('save_mcp_server', { name: 'example', scope: 'global', server: { command: 'node', args, env: { TOKEN: 'secret-env' }, headers: { Authorization: 'secret-header' } } });
  await handleIpcCommand('save_mcp_server', { name: 'remote', scope: 'global', server: { url: 'https://secret-url.test' } });
}

async function inventory() {
  const result = await handleIpcCommand('get_mcp_servers', {});
  const output = JSON.stringify(result);
  for (const secret of ['secret-env', 'secret-header', 'secret-url']) assert.equal(output.includes(secret), false, `${secret} leaked`);
  return result.servers.find((server: any) => server.name === 'example');
}

test('S1.2 inventory editor save preserves exact arguments and redacts other secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-args-'));
  const args = ['plain', 'with spaces', 'line\nbreak', '"quoted"', "single'quote", 'C:\\Program Files\\tool\\', '', 'tab\there'];
  try {
    await fixture(dir, args);
    const original = await inventory();
    assert.deepEqual(original.args, args);
    const form = serverConfigToFormData(original);
    await handleIpcCommand('save_mcp_server', formDataToSavePayload(form, original.name, undefined, original));
    assert.deepEqual((await inventory()).args, args);
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S1.3 clearing editor arguments clears inventory; omitted args preserve and secrets remain unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-clear-'));
  try {
    await fixture(dir, ['original']);
    await handleIpcCommand('save_mcp_server', { name: 'example', scope: 'global', server: { enabled: false } });
    const original = await inventory();
    assert.deepEqual(original.args, ['original']);
    assert.equal(original.enabled, false);
    const form = serverConfigToFormData(original);
    form.argsText = '';
    await handleIpcCommand('save_mcp_server', formDataToSavePayload(form, original.name, undefined, original));
    const after = await inventory();
    assert.deepEqual(after.args, []);
    assert.equal(after.command, 'node');
    assert.equal(after.enabled, false);
    assert.deepEqual(after.envKeys, ['TOKEN']);
    assert.deepEqual(after.headers, { Authorization: '' });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).mcpServers;
    assert.deepEqual(stored.example.env, { TOKEN: 'secret-env' });
    assert.deepEqual(stored.example.headers, { Authorization: 'secret-header' });
    assert.equal(stored.remote.url, 'https://secret-url.test');
  } finally { setPiAgentDirForTest(null); fs.rmSync(dir, { recursive: true, force: true }); }
});
