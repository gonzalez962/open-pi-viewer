import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { initWebIpcClient } from '@infra/web-ipc-client';
import { sendPromptPi } from '@infra/bridge';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-test-'));
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

test('S1.1 web prompt stays in selected project during background reattachment', async (t) => {
  const f = fixture(t);
  const aCwd = path.join(f.root, 'project-a');
  const bCwd = path.join(f.root, 'project-b');
  fs.mkdirSync(aCwd);
  fs.mkdirSync(bCwd);
  const a = f.file('project-a');
  const b = f.file('project-b');
  await getOrCreatePiRpc(aCwd, a);
  await getOrCreatePiRpc(bCwd, b);
  const originals = { window: globalThis.window, EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const sources: any[] = [];
  const listeners = new Map<string, EventListener>();
  const win: any = {
    addEventListener(name: string, callback: EventListener) { listeners.set(name, callback); },
    dispatchEvent(event: Event) { listeners.get(event.type)?.(event); return true; },
  };
  class FakeSource {
    onopen?: () => void;
    constructor(_url: string) { sources.push(this); }
    close() {}
  }
  let releaseB!: () => void;
  const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
  let restoredA!: () => void;
  const aRestored = new Promise<void>((resolve) => { restoredA = resolve; });
  Object.assign(globalThis, { window: win, EventSource: FakeSource, fetch: async (_url: string, options: any) => {
    const { cmd, args } = JSON.parse(options.body);
    if (args?.__reattach && args.payload.workingDirectory === bCwd) await bGate;
    const result = await handleIpcCommand(cmd, args);
    if (args?.__reattach && args.payload.workingDirectory === aCwd) restoredA();
    return { ok: true, json: async () => ({ result }) };
  } });
  try {
    initWebIpcClient();
    win.dispatchEvent(new Event('pi:web-auth-ready'));
    const ipc = win.__TAURI_INTERNALS__;
    await ipc.invoke('connect', { payload: { workingDirectory: aCwd, sessionFile: a } });
    await ipc.invoke('connect', { payload: { workingDirectory: bCwd, sessionFile: b } });
    sources[0].onopen();
    await aRestored;
    await sendPromptPi('s1-1', 'project B prompt', undefined, ipc.invoke);
    const promptsA = f.children[0].commands.filter((command) => command.type === 'prompt');
    const promptsB = f.children[1].commands.filter((command) => command.type === 'prompt');
    assert.deepEqual(promptsA, []);
    assert.equal(promptsB.length, 1);
    assert.equal(promptsB[0].message, 'project B prompt');
    assert.equal(f.children[1].cwd, bCwd);
  } finally {
    releaseB();
    Object.assign(globalThis, originals);
  }
});

test('S1.2 mismatched project and session reject without commands or activity changes', async (t) => {
  const f = fixture(t);
  const aCwd = path.join(f.root, 'project-a');
  const bCwd = path.join(f.root, 'project-b');
  fs.mkdirSync(aCwd);
  fs.mkdirSync(bCwd);
  const a = f.file('project-a');
  const b = f.file('project-b');
  await getOrCreatePiRpc(aCwd, a);
  await getOrCreatePiRpc(bCwd, b);
  const events: any[] = [];
  const stream = { write: (chunk: string) => { events.push(JSON.parse(chunk.slice(6).trim())); } } as any;
  addSseClient(stream);
  t.after(() => removeSseClient(stream));
  const before = f.children.map((child) => child.commands.slice());
  let error: unknown;
  try {
    await handleIpcCommand('send_prompt', { payload: { id: 's1-2', message: 'wrong project', cwd: bCwd, sessionFile: a } });
  } catch (err) { error = err; }
  assert.deepEqual(f.children.map((child) => child.commands), before, 'rejected prompt must not send commands');
  assert.deepEqual(events, [], 'rejected prompt must not change session activity');
  assert.ok(error instanceof Error, 'mismatched identity must be rejected');
});

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
