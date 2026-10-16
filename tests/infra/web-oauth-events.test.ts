import test from 'node:test';
import assert from 'node:assert/strict';
import { initWebIpcClient } from '@infra/web-ipc-client';

test('web authorization reconnects events before OAuth actions resume', async () => {
  const originalWindow = globalThis.window;
  const originalSource = globalThis.EventSource;
  const listeners = new Map<string, EventListener>();
  const streams: FakeSource[] = [];
  class FakeSource {
    closed = false;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(public url: string) { streams.push(this); }
    close() { this.closed = true; }
  }
  const fakeWindow = {
    addEventListener(name: string, callback: EventListener) { listeners.set(name, callback); },
    dispatchEvent(event: Event) { listeners.get(event.type)?.(event); return true; },
  };
  Object.assign(globalThis, { window: fakeWindow, EventSource: FakeSource });
  try {
    initWebIpcClient();
    fakeWindow.dispatchEvent(new Event('pi:web-auth-ready'));
    assert.equal(streams.length, 1);
    let ready = false;
    const detail = { ready: () => { ready = true; } };
    const event = new Event('pi:oauth-authorized');
    Object.assign(event, { detail });
    fakeWindow.dispatchEvent(event);
    assert.equal(streams[0].closed, true);
    assert.equal(streams.length, 2);
    assert.equal(ready, false);
    streams[1].onopen?.();
    assert.equal(ready, true);
    const invoke = (fakeWindow as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: object) => Promise<number> } }).__TAURI_INTERNALS__.invoke;
    assert.equal(await invoke('plugin:event|listen', { event: 'pi://oauth-event', handler: 7 }), 7);
  } finally {
    Object.assign(globalThis, { window: originalWindow, EventSource: originalSource });
  }
});
