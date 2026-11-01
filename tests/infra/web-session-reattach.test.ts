import test from 'node:test';
import assert from 'node:assert/strict';
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
  const snapshot = { canonicalCwd: '/work', sessionFile: '/work/a.jsonl', activity: 'waiting', messages: [], pendingExtensionPrompts: [{ id: 'approval' }] };
  Object.assign(globalThis, { window: win, EventSource: FakeSource, fetch: async (_url: string, options: any) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ result: snapshot }) };
  } });
  try {
    initWebIpcClient();
    win.dispatchEvent(new Event('pi:web-auth-ready'));
    const events: any[] = [];
    const ipc = win.__TAURI_INTERNALS__;
    const callback = ipc.transformCallback((event: any) => events.push(event.payload));
    await ipc.invoke('plugin:event|listen', { event: 'pi://event', handler: callback });
    await ipc.invoke('connect', { payload: { workingDirectory: '/work' } });
    snapshot.sessionFile = '/work/b.jsonl';
    await ipc.invoke('connect', { payload: { workingDirectory: '/work', sessionFile: '/work/b.jsonl' } });
    const received = new Promise<void>((resolve) => {
      const original = ipc.callbacks.get(callback);
      ipc.callbacks.set(callback, (event: any) => { original(event); resolve(); });
    });
    sources[0].onopen();
    await received;
    assert.equal(calls.length, 3, 'reconnect must not revisit historical sessions from this project');
    assert.equal(calls[2].args.payload.sessionFile, '/work/b.jsonl');
    assert.equal(events[0].type, 'runtime_snapshot');
    assert.equal(events[0].activity, 'waiting');
    assert.equal(events[0].pendingExtensionPrompts[0].id, 'approval');
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
    await ipc.invoke('connect', { payload: { workingDirectory: '/work' } });
    await ipc.invoke('switch_session', { payload: { sessionPath: '/work/b.jsonl' } });
    await ipc.invoke('send_prompt', { payload: { id: 'prompt', message: 'hello' } });
    assert.deepEqual(calls[2].args.payload, { id: 'prompt', message: 'hello', cwd: '/work', sessionFile: '/work/b.jsonl' });
    await ipc.invoke('new_session');
    await ipc.invoke('send_prompt', { payload: { id: 'prompt', message: 'hello again' } });
    assert.equal(calls[4].args.payload.sessionFile, '/work/c.jsonl');
    sources[0].onopen();
    assert.equal(calls[5].args.payload.sessionFile, '/work/c.jsonl');
  } finally { Object.assign(globalThis, originals); }
});
