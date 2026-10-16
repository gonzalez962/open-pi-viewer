import test from 'node:test';
import assert from 'node:assert/strict';
import { initWebIpcClient } from '@infra/web-ipc-client';
import { WEB_AUTH_READY_EVENT, WEB_AUTH_REQUIRED_EVENT } from '@infra/web-auth';

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
