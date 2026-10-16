import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { handleIpcCommand, setSessionsRootDirForTest, setSubprocessSpawnerForTest, resetPiRpcForTest, getOrCreatePiRpc, addSseClient, removeSseClient } from '@server/web-ipc-bridge';

class FakePi extends EventEmitter {
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: any[] = [];
  messages: any[] = [];
  busy = false;
  constructor(public file: string, public cwd: string) {
    super();
    this.stdin.on('data', (chunk) => {
      const command = JSON.parse(chunk.toString());
      this.commands.push(command);
      if (command.type === 'extension_ui_response') return;
      const data = command.type === 'get_state'
        ? { sessionId: path.basename(file), sessionFile: file, isStreaming: this.busy, model: null }
        : command.type === 'get_messages' ? { messages: this.messages } : {};
      queueMicrotask(() => this.event({ type: 'response', id: command.id, success: true, data }));
    });
  }
  event(event: any) { this.stdout.write(JSON.stringify(event) + '\n'); }
  kill() { this.exitCode = 0; this.emit('exit', 0, null); return true; }
}

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.continuity-test-'));
  const children: FakePi[] = [];
  setSessionsRootDirForTest(root);
  setSubprocessSpawnerForTest((_cmd, args, options) => {
    const file = args[args.indexOf('--session') + 1];
    const child = new FakePi(file, options.cwd);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  t.after(() => {
    resetPiRpcForTest();
    setSubprocessSpawnerForTest(null);
    setSessionsRootDirForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = (name: string) => {
    const value = path.join(root, `${name}.jsonl`);
    fs.writeFileSync(value, JSON.stringify({ type: 'session', version: 3, id: name, cwd: root }) + '\n');
    return value;
  };
  const connect = (sessionFile: string) => handleIpcCommand('connect', { payload: { workingDirectory: root, sessionFile } });
  return { root, children, file, connect };
}

test('web child exit reports project-scoped disconnected/error state to subscribers', async (t) => {
  const f = fixture(t);
  const events: any[] = [];
  const stream = { write: (chunk: string) => { events.push(JSON.parse(chunk.slice(6).trim())); } } as any;
  addSseClient(stream);
  t.after(() => removeSseClient(stream));
  for (const code of [0, 1]) {
    const file = f.file(`exit-${code}`);
    await getOrCreatePiRpc(f.root, file);
    const child = f.children[f.children.length - 1];
    child.event({ type: 'message_start', message: { role: 'assistant', content: '' } });
    child.exitCode = code;
    child.emit('exit', code, null);
    const status = events.filter((e) => e.event === 'pi://status-change').pop()?.payload;
    assert.equal(status?.state, code === 0 ? 'disconnected' : 'error');
    assert.equal(status?.cwd, f.root);
    assert.equal(status?.sessionId, path.basename(file));
  }
});

test('browser disconnect and SSE removal preserve the same working process and live messages', async (t) => {
  const f = fixture(t);
  const file = f.file('active');
  await getOrCreatePiRpc(f.root, file);
  const child = f.children[0];
  child.busy = true;
  child.messages = [{ role: 'user', content: 'work' }, { role: 'assistant', content: 'live progress' }];
  child.event({ type: 'agent_start' });
  child.event({ type: 'message_start', message: child.messages[1] });
  const stream = { write() {} } as any;
  addSseClient(stream);
  removeSseClient(stream);
  assert.equal(await handleIpcCommand('disconnect'), null);
  assert.equal(child.exitCode, null);
  const result = await f.connect(file);
  assert.equal(f.children.length, 1);
  assert.equal(result.activity, 'busy');
  assert.deepEqual(result.messages, child.messages);
  child.busy = false;
  child.event({ type: 'agent_end' });
  assert.equal((await f.connect(file)).activity, 'idle');
});

test('pending prompts survive reconnect and cannot be answered by another session or twice', async (t) => {
  const f = fixture(t);
  const a = f.file('a');
  const b = f.file('b');
  await getOrCreatePiRpc(f.root, a);
  await getOrCreatePiRpc(f.root, b);
  f.children[0].event({ type: 'extension_ui_request', id: 'approve', method: 'confirm', title: 'Continue?' });
  const snapshot = await f.connect(a);
  assert.equal(snapshot.activity, 'waiting');
  assert.equal(snapshot.pendingExtensionPrompts[0].id, 'approve');
  assert.equal(snapshot.pendingExtensionPrompts[0].sessionFile, a);
  const before = f.children[1].commands.length;
  await assert.rejects(handleIpcCommand('send_extension_ui_response', { payload: { id: 'approve', sessionFile: b, confirmed: true } }), /pending|request/i);
  assert.equal(f.children[1].commands.length, before);
  await handleIpcCommand('send_extension_ui_response', { payload: { id: 'approve', sessionFile: a, confirmed: true } });
  assert.equal(f.children[0].commands[f.children[0].commands.length - 1].type, 'extension_ui_response');
  await assert.rejects(handleIpcCommand('send_extension_ui_response', { payload: { id: 'approve', sessionFile: a, confirmed: true } }), /pending|request/i);
  assert.deepEqual((await f.connect(a)).pendingExtensionPrompts, []);
});

test('explicit session answers do not depend on the globally active project', async (t) => {
  const f = fixture(t);
  const a = f.file('background');
  await getOrCreatePiRpc(f.root, a);
  f.children[0].event({ type: 'extension_ui_request', id: 'background-request', method: 'confirm' });
  await handleIpcCommand('connect', { payload: { workingDirectory: path.join(f.root, 'other-project') } });
  await handleIpcCommand('send_extension_ui_response', { payload: { sessionFile: a, id: 'background-request', confirmed: true } });
  assert.equal(f.children[0].commands[f.children[0].commands.length - 1].id, 'background-request');
});

test('pool pressure preserves waiting sessions and concurrent attachment creates one process', async (t) => {
  const f = fixture(t);
  const a = f.file('waiting');
  await Promise.all([getOrCreatePiRpc(f.root, a), getOrCreatePiRpc(f.root, a)]);
  assert.equal(f.children.length, 1);
  f.children[0].event({ type: 'extension_ui_request', id: 'input', method: 'input' });
  for (let i = 0; i < 4; i++) await getOrCreatePiRpc(f.root, f.file(`idle-${i}`));
  assert.equal(f.children[0].exitCode, null);
  assert.equal((await f.connect(a)).activity, 'waiting');
});

test('abort leaves process alive, explicit stop targets one session and stale responses never spawn', async (t) => {
  const f = fixture(t);
  const a = f.file('a');
  const b = f.file('b');
  await getOrCreatePiRpc(f.root, a);
  await getOrCreatePiRpc(f.root, b);
  await handleIpcCommand('abort', { payload: { sessionFile: a } });
  assert.equal(f.children[0].commands[f.children[0].commands.length - 1].type, 'abort');
  assert.equal(f.children[0].exitCode, null);
  f.children[0].event({ type: 'extension_ui_request', id: 'stale', method: 'input' });
  await handleIpcCommand('stop_session', { payload: { sessionFile: a } });
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.children[1].exitCode, null);
  await assert.rejects(handleIpcCommand('send_extension_ui_response', { payload: { id: 'stale', sessionFile: a, value: 'x' } }), /active|pending/i);
  assert.equal(f.children.length, 2);
});
