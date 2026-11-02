import test from 'node:test';
import assert from 'node:assert/strict';
import { initWebIpcClient } from '@infra/web-ipc-client';
import { newSessionPi } from '@infra/bridge';

test('S3.1 legacy desktop mock invocation remains argument-free', async () => {
  const calls: unknown[] = [];
  const expected = { cancelled: false, sessionId: 'desktop', sessionFile: '/desktop.jsonl' };
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => { calls.push([cmd, args]); return expected as T; };
  assert.deepEqual(await newSessionPi(invoke), expected);
  assert.deepEqual(calls, [['new_session', undefined]]);
});

test('S2.1 late new-session response leaves B foreground and pins A for later use', async () => {
  const originals = { window: globalThis.window, fetch: globalThis.fetch };
  const win: any = { addEventListener() {} };
  const calls: any[] = [];
  let release!: (value: any) => void;
  const pending = new Promise<any>((resolve) => { release = resolve; });
  Object.assign(globalThis, { window: win, fetch: async (_url: string, options: any) => {
    const call = JSON.parse(options.body); calls.push(call);
    let result: any;
    if (call.cmd === 'new_session') result = await pending;
    else if (call.cmd === 'connect') result = { canonicalCwd: call.args.payload.workingDirectory, sessionFile: call.args.payload.sessionFile };
    else result = { id: 'prompt', accepted: true };
    return { ok: true, json: async () => ({ result }) };
  } });
  try {
    initWebIpcClient();
    const ipc = win.__TAURI_INTERNALS__;
    await ipc.invoke('connect', { payload: { workingDirectory: '/a', sessionFile: '/a/old.jsonl' } });
    const creation = ipc.invoke('new_session', { payload: { workingDirectory: '/a' } });
    await ipc.invoke('connect', { payload: { workingDirectory: '/b', sessionFile: '/b/old.jsonl' } });
    release({ cancelled: false, sessionId: 'a-new', sessionFile: '/a/new.jsonl' });
    assert.equal((await creation).sessionId, 'a-new');
    await ipc.invoke('send_prompt', { payload: { id: 'prompt', message: 'B' } });
    assert.deepEqual(calls.at(-1).args.payload, { id: 'prompt', message: 'B', cwd: '/b', sessionFile: '/b/old.jsonl' });
  } finally { Object.assign(globalThis, originals); }
});

test('S1.1 web new session remains target of next prompt in requesting project', async () => {
  const originals = { window: globalThis.window, fetch: globalThis.fetch };
  const win: any = { addEventListener() {} };
  const calls: any[] = [];
  Object.assign(globalThis, { window: win, fetch: async (_url: string, options: any) => {
    const call = JSON.parse(options.body); calls.push(call);
    const result = call.cmd === 'connect' ? { canonicalCwd: '/a', sessionFile: '/a/old.jsonl' } : call.cmd === 'new_session' ? { cancelled: false, sessionId: 'a-new', sessionFile: '/a/new.jsonl' } : { id: 'prompt' };
    return { ok: true, json: async () => ({ result }) };
  } });
  try {
    initWebIpcClient();
    const ipc = win.__TAURI_INTERNALS__;
    await ipc.invoke('connect', { payload: { workingDirectory: '/a' } });
    await ipc.invoke('new_session', { payload: { workingDirectory: '/a' } });
    await ipc.invoke('send_prompt', { payload: { id: 'prompt', message: 'hello' } });
    assert.deepEqual(calls[2].args.payload, { id: 'prompt', message: 'hello', cwd: '/a', sessionFile: '/a/new.jsonl' });
  } finally { Object.assign(globalThis, originals); }
});
