import test from 'node:test';
import assert from 'node:assert/strict';
import { initWebIpcClient } from '@infra/web-ipc-client';
import { WEB_AUTH_READY_EVENT, WEB_AUTH_REQUIRED_EVENT } from '@infra/web-auth';

test('S2.3 reattaches live same-project sessions without restarting dead or stopped sessions or redirecting prompts', async () => {
  const originals = { window: globalThis.window, EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const listeners = new Map<string, EventListener>();
  const streams: any[] = [];
  const calls: any[] = [];
  const snapshots: any[] = [];
  const live = new Set(['/repo/a', '/repo/b', '/repo/c']);
  const fakeWindow: any = {
    addEventListener(name: string, callback: EventListener) { listeners.set(name, callback); },
    dispatchEvent(event: Event) { listeners.get(event.type)?.(event); return true; },
  };
  class FakeSource {
    onopen?: () => void;
    constructor() { streams.push(this); }
    close() {}
  }
  Object.assign(globalThis, { window: fakeWindow, EventSource: FakeSource, fetch: async (_url: string, options: any) => {
    const { cmd, args } = JSON.parse(options.body);
    calls.push({ cmd, args });
    const file = args.payload?.sessionFile ?? args.payload?.sessionPath;
    let result: any = {};
    if (cmd === 'stop_session') live.delete(file);
    if (cmd === 'switch_session') result = { sessionId: file, sessionFile: file, messages: [] };
    if (cmd === 'connect') {
      if (args.__reattach && !live.has(file)) {
        if (!args.payload.liveOnly) live.add(file); // normal connect would restart a historical runtime
        else result = { unavailable: true, canonicalCwd: '/repo', sessionFile: file };
      }
      if (!result.unavailable) result = { canonicalCwd: '/repo', sessionId: file, sessionFile: file, messages: [], activeJobs: [file] };
    }
    return { ok: true, json: async () => ({ result }) };
  } });
  try {
    initWebIpcClient();
    const ipc = fakeWindow.__TAURI_INTERNALS__;
    const handler = ipc.transformCallback((event: any) => snapshots.push(event.payload));
    await ipc.invoke('plugin:event|listen', { event: 'pi://event', handler });
    await ipc.invoke('connect', { payload: { workingDirectory: '/repo', sessionFile: '/repo/a' } });
    await ipc.invoke('switch_session', { payload: { sessionPath: '/repo/b' } });
    await ipc.invoke('switch_session', { payload: { sessionPath: '/repo/c' } });
    await ipc.invoke('stop_session', { payload: { sessionFile: '/repo/b' } });
    live.delete('/repo/a');
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
    streams[0].onopen();
    await new Promise(resolve => setTimeout(resolve, 0));
    await ipc.invoke('send_prompt', { payload: { id: 'p', message: 'hello' } });
    assert.equal([...calls].reverse().find(call => call.cmd === 'send_prompt').args.payload.sessionFile, '/repo/c');
    assert.equal(live.has('/repo/a'), false, 'dead session must not restart');
    assert.equal(live.has('/repo/b'), false, 'stopped session must not restart');
    assert.deepEqual(snapshots.filter(s => s.type === 'runtime_snapshot').map(s => s.sessionFile), ['/repo/c']);
  } finally { Object.assign(globalThis, originals); }
});

test('web-ipc-client defers EventSource until web-auth-ready is emitted', async () => {
  const originals = {
    window: globalThis.window,
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
  };

  const streams: FakeSource[] = [];
  class FakeSource {
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const listeners = new Map<string, Set<EventListener>>();
  const fakeWindow = {
    addEventListener(name: string, callback: EventListener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    dispatchEvent(event: Event) {
      listeners.get(event.type)?.forEach((cb) => cb(event));
      return true;
    },
  };

  Object.assign(globalThis, {
    window: fakeWindow,
    EventSource: FakeSource,
  });

  try {
    initWebIpcClient();

    // EventSource must NOT be opened eagerly before auth readiness is signaled
    assert.equal(streams.length, 0, 'EventSource should be deferred until web-auth-ready');

    // Emitting web-auth-ready opens EventSource
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
    assert.equal(streams.length, 1, 'EventSource should connect after web-auth-ready');
    assert.equal(streams[0].closed, false);

    // Emitting web-auth-required closes EventSource
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_REQUIRED_EVENT));
    assert.equal(streams[0].closed, true, 'EventSource should close on web-auth-required');
  } finally {
    Object.assign(globalThis, originals);
  }
});

test('web-ipc-client handles 401 IPC responses by closing SSE and signaling web-auth-required', async () => {
  const originals = {
    window: globalThis.window,
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
  };

  const streams: FakeSource[] = [];
  class FakeSource {
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const eventsDispatched: string[] = [];
  const listeners = new Map<string, Set<EventListener>>();
  const fakeWindow = {
    addEventListener(name: string, callback: EventListener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    dispatchEvent(event: Event) {
      eventsDispatched.push(event.type);
      listeners.get(event.type)?.forEach((cb) => cb(event));
      return true;
    },
  };

  // Fake fetch returns 401 Unauthorized for IPC
  const fakeFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  Object.assign(globalThis, {
    window: fakeWindow,
    EventSource: FakeSource,
    fetch: fakeFetch,
  });

  try {
    initWebIpcClient();
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
    assert.equal(streams.length, 1);
    assert.equal(streams[0].closed, false);

    const ipc = (fakeWindow as any).__TAURI_INTERNALS__;
    await assert.rejects(
      async () => ipc.invoke('get_bridge_state'),
      /Web IPC HTTP error 401/
    );

    // Assert that SSE was closed and web-auth-required was dispatched
    assert.equal(streams[0].closed, true, 'SSE must be closed on 401 response');
    assert.ok(
      eventsDispatched.includes(WEB_AUTH_REQUIRED_EVENT),
      'pi:web-auth-required event must be dispatched on 401'
    );
  } finally {
    Object.assign(globalThis, originals);
  }
});

test('EventSource.onerror probes auth status and signals web-auth-required when unauthenticated', async () => {
  const originals = {
    window: globalThis.window,
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
  };

  const streams: FakeSource[] = [];
  class FakeSource {
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const eventsDispatched: string[] = [];
  const listeners = new Map<string, Set<EventListener>>();
  const fakeWindow = {
    addEventListener(name: string, callback: EventListener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    dispatchEvent(event: Event) {
      eventsDispatched.push(event.type);
      listeners.get(event.type)?.forEach((cb) => cb(event));
      return true;
    },
  };

  let probedStatus = false;
  const fakeFetch: typeof fetch = async (input) => {
    if (input === '/api/auth/status') {
      probedStatus = true;
      return new Response(JSON.stringify({ required: true, authenticated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  };

  Object.assign(globalThis, {
    window: fakeWindow,
    EventSource: FakeSource,
    fetch: fakeFetch,
  });

  try {
    initWebIpcClient();
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
    assert.equal(streams.length, 1);
    assert.equal(streams[0].closed, false);

    // Trigger onerror on EventSource (simulating server stream expiration/close)
    streams[0].onerror?.();

    // Allow async status probe to resolve
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(probedStatus, true, 'SSE onerror should probe /api/auth/status');
    assert.equal(streams[0].closed, true, 'SSE stream should be closed on unauthenticated status probe');
    assert.ok(
      eventsDispatched.includes(WEB_AUTH_REQUIRED_EVENT),
      'pi:web-auth-required event must be dispatched when probe is unauthenticated'
    );
  } finally {
    Object.assign(globalThis, originals);
  }
});

test('subsequent web-auth-ready after web-auth-required reconnects EventSource cleanly', async () => {
  const originals = {
    window: globalThis.window,
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
  };

  const streams: FakeSource[] = [];
  class FakeSource {
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const listeners = new Map<string, Set<EventListener>>();
  const fakeWindow = {
    addEventListener(name: string, callback: EventListener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    dispatchEvent(event: Event) {
      listeners.get(event.type)?.forEach((cb) => cb(event));
      return true;
    },
  };

  Object.assign(globalThis, {
    window: fakeWindow,
    EventSource: FakeSource,
  });

  try {
    initWebIpcClient();

    // 1. Initial auth-ready connects stream 0
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
    assert.equal(streams.length, 1);
    assert.equal(streams[0].closed, false);

    // 2. Auth-required closes stream 0
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_REQUIRED_EVENT));
    assert.equal(streams[0].closed, true);

    // 3. User logs back in -> new auth-ready connects stream 1
    fakeWindow.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
    assert.equal(streams.length, 2);
    assert.equal(streams[1].closed, false);
  } finally {
    Object.assign(globalThis, originals);
  }
});
