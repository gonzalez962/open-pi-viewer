import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { initWebIpcClient } from '@infra/web-ipc-client';

test('EventSource reconnect requests an identity-pinned snapshot and delivers missed prompts', async () => {
  const originals = { window: globalThis.window, EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const sources: any[] = [];
  const calls: any[] = [];
  class FakeSource {
    onopen?: () => void;
    onmessage?: (e: any) => void;
    constructor(_url: string) { sources.push(this); }
    close() {}
  }
  const listeners = new Map<string, Set<EventListener>>();
  const win: any = {
    addEventListener(name: string, callback: EventListener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    dispatchEvent(event: Event) {
      listeners.get(event.type)?.forEach((cb) => cb(event));
      return true;
    },
  };
  Object.assign(globalThis, { window: win, EventSource: FakeSource, fetch: async (_url: string, options: any) => {
    const call = JSON.parse(options.body);
    calls.push(call);
    const sessionFile = call.args.payload.sessionFile ?? '/work/a.jsonl';
    const awaitingApproval = call.args.__reattach && sessionFile === '/work/b.jsonl';
    return { ok: true, json: async () => ({ result: {
      canonicalCwd: '/work', sessionFile, activity: awaitingApproval ? 'waiting' : 'idle', messages: [],
      pendingExtensionPrompts: awaitingApproval ? [{ id: 'approval' }] : [],
    } }) };
  } });
  try {
    initWebIpcClient();
    win.dispatchEvent(new Event('pi:web-auth-ready'));
    const events: any[] = [];
    const ipc = win.__TAURI_INTERNALS__;
    const callback = ipc.transformCallback((event: any) => events.push(event.payload));
    await ipc.invoke('plugin:event|listen', { event: 'pi://event', handler: callback });
    await ipc.invoke('connect', { payload: { workingDirectory: '/work' } });
    await ipc.invoke('connect', { payload: { workingDirectory: '/work', sessionFile: '/work/b.jsonl' } });
    const beforeReconnect = calls.length;
    sources[0].onopen();
    // Let the immediately resolved mock RPCs publish their snapshots.
    await setImmediate();
    assert.deepEqual(
      calls.slice(beforeReconnect).sort((a, b) => a.args.payload.sessionFile.localeCompare(b.args.payload.sessionFile)),
      ['/work/a.jsonl', '/work/b.jsonl'].map(sessionFile => ({
        cmd: 'connect', args: { payload: { workingDirectory: '/work', sessionFile, liveOnly: true }, __reattach: true },
      })),
    );
    assert.deepEqual(
      events.map(({ type, cwd, sessionFile, activity, pendingExtensionPrompts }) =>
        ({ type, cwd, sessionFile, activity, pendingExtensionPrompts }))
        .sort((a, b) => a.sessionFile.localeCompare(b.sessionFile)),
      [
        { type: 'runtime_snapshot', cwd: '/work', sessionFile: '/work/a.jsonl', activity: 'idle', pendingExtensionPrompts: [] },
        { type: 'runtime_snapshot', cwd: '/work', sessionFile: '/work/b.jsonl', activity: 'waiting', pendingExtensionPrompts: [{ id: 'approval' }] },
      ],
    );
  } finally { Object.assign(globalThis, originals); }
});

test('foreground session changes remain pinned for ordinary prompts and reattachment', async () => {
  const originals = { window: globalThis.window, EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const calls: any[] = [];
  const listeners = new Map<string, EventListener>();
  const sources: any[] = [];
  const win: any = {
    addEventListener(name: string, listener: EventListener) { listeners.set(name, listener); },
    dispatchEvent(event: Event) { listeners.get(event.type)?.(event); return true; },
  };
  class FakeSource {
    onopen?: () => void;
    constructor(_url: string) { sources.push(this); }
    close() {}
  }
  Object.assign(globalThis, { window: win, EventSource: FakeSource, fetch: async (_url: string, options: any) => {
    const call = JSON.parse(options.body);
    calls.push(call);
    const sessionFile = call.cmd === 'switch_session' ? '/work/b.jsonl' : call.cmd === 'new_session' ? '/work/c.jsonl' : call.args?.payload?.sessionFile || '/work/a.jsonl';
    return { ok: true, json: async () => ({ result: { canonicalCwd: '/work', sessionFile, id: 'prompt' } }) };
  } });
  try {
    initWebIpcClient();
    win.dispatchEvent(new Event('pi:web-auth-ready'));
    const ipc = win.__TAURI_INTERNALS__;
    const snapshots: any[] = [];
    const handler = ipc.transformCallback((event: any) => snapshots.push(event.payload));
    await ipc.invoke('plugin:event|listen', { event: 'pi://event', handler });
    await ipc.invoke('connect', { payload: { workingDirectory: '/work' } });
    await ipc.invoke('switch_session', { payload: { sessionPath: '/work/b.jsonl' } });
    await ipc.invoke('send_prompt', { payload: { id: 'prompt', message: 'hello' } });
    assert.deepEqual(calls[2].args.payload, { id: 'prompt', message: 'hello', cwd: '/work', sessionFile: '/work/b.jsonl' });
    await ipc.invoke('new_session');
    await ipc.invoke('send_prompt', { payload: { id: 'prompt', message: 'hello again' } });
    assert.equal(calls[4].args.payload.sessionFile, '/work/c.jsonl');
    const beforeReconnect = calls.length;
    sources[0].onopen();
    await setImmediate();
    const sessions = ['/work/a.jsonl', '/work/b.jsonl', '/work/c.jsonl'];
    assert.deepEqual(
      calls.slice(beforeReconnect).sort((a, b) => a.args.payload.sessionFile.localeCompare(b.args.payload.sessionFile)),
      sessions.map(sessionFile => ({
        cmd: 'connect', args: { payload: { workingDirectory: '/work', sessionFile, liveOnly: true }, __reattach: true },
      })),
    );
    assert.deepEqual(
      snapshots.map(({ type, cwd, sessionFile }) => ({ type, cwd, sessionFile }))
        .sort((a, b) => a.sessionFile.localeCompare(b.sessionFile)),
      sessions.map(sessionFile => ({ type: 'runtime_snapshot', cwd: '/work', sessionFile })),
    );
    await ipc.invoke('send_prompt', { payload: { id: 'after-reconnect', message: 'still here' } });
    assert.deepEqual(calls.at(-1), {
      cmd: 'send_prompt', args: { payload: { id: 'after-reconnect', message: 'still here', cwd: '/work', sessionFile: '/work/c.jsonl' } },
    });
  } finally { Object.assign(globalThis, originals); }
});
