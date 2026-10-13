import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SW_PATH = path.resolve(import.meta.dirname, '../../public/push-sw.js');

interface MockClient {
  focused?: boolean;
  focus(): Promise<void>;
  url?: string;
  type?: string;
}

interface MockWindowOptions {
  clients?: MockClient[];
}

function createSwContext(options: MockWindowOptions = {}) {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const shownNotifications: Array<{ title: string; options?: any }> = [];
  const clientsList: MockClient[] = options.clients ?? [];
  let openedWindowUrl: string | null = null;

  const mockSelf: Record<string, any> = {
    addEventListener: (event: string, handler: (e: any) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    clients: {
      matchAll: async (_opts?: any) => [...clientsList],
      openWindow: async (url: string) => {
        openedWindowUrl = url;
        const newClient: MockClient = {
          url,
          type: 'window',
          focus: async () => {},
        };
        return newClient;
      },
    },
    registration: {
      showNotification: async (title: string, opts?: any) => {
        shownNotifications.push({ title, options: opts });
      },
    },
  };

  const sandbox = {
    self: mockSelf,
    console,
  };

  const context = vm.createContext(sandbox);
  const swCode = fs.readFileSync(SW_PATH, 'utf8');
  vm.runInContext(swCode, context);

  return {
    mockSelf,
    shownNotifications,
    getOpenedWindowUrl: () => openedWindowUrl,
    dispatchPush: async (data: any) => {
      const pushHandlers = listeners['push'] || [];
      for (const handler of pushHandlers) {
        let waitPromise: Promise<any> | null = null;
        const event = {
          data: data !== undefined ? {
            json: () => {
              if (typeof data === 'string') return JSON.parse(data);
              return data;
            },
            text: () => (typeof data === 'string' ? data : JSON.stringify(data)),
          } : null,
          waitUntil: (p: Promise<any>) => {
            waitPromise = p;
          },
        };
        handler(event);
        if (waitPromise) await waitPromise;
      }
    },
    dispatchClick: async (notification: any) => {
      const clickHandlers = listeners['notificationclick'] || [];
      for (const handler of clickHandlers) {
        let waitPromise: Promise<any> | null = null;
        let closed = false;
        const event = {
          notification: {
            ...notification,
            close: () => {
              closed = true;
            },
          },
          waitUntil: (p: Promise<any>) => {
            waitPromise = p;
          },
        };
        handler(event);
        if (waitPromise) await waitPromise;
        return { closed };
      }
      return { closed: false };
    },
  };
}

test('SW: received push remains visible even when a viewer window opens during delivery', async () => {
  const client: MockClient = {
    url: 'http://localhost:3000/viewer',
    type: 'window',
    focus: async () => {},
  };
  const env = createSwContext({ clients: [client] });

  await env.dispatchPush({
    title: 'Task completed',
    body: 'Build finished successfully',
    tag: 'task_complete',
  });

  assert.equal(env.shownNotifications.length, 1, 'userVisibleOnly pushes must not be silently consumed');
  assert.equal(env.shownNotifications[0].title, 'Task completed');
  assert.equal(env.shownNotifications[0].options.body, 'Build finished successfully');
});

test('SW: push event displays notification when page is closed (no window clients)', async () => {
  const env = createSwContext({ clients: [] });

  await env.dispatchPush({
    title: 'Task completed — my-project',
    body: 'Task complete',
    tag: 'agent_settled',
  });

  assert.equal(env.shownNotifications.length, 1);
  assert.equal(env.shownNotifications[0].title, 'Task completed — my-project');
  assert.equal(env.shownNotifications[0].options.body, 'Task complete');
  assert.equal(env.shownNotifications[0].options.tag, 'agent_settled');
});

test('SW: push handles malformed or empty data safely without throwing', async () => {
  const env = createSwContext({ clients: [] });

  // Missing data
  await env.dispatchPush(undefined);
  assert.equal(env.shownNotifications.length, 0);

  // Invalid JSON or null
  await env.dispatchPush(null);
  assert.equal(env.shownNotifications.length, 0);

  // Non-object
  await env.dispatchPush('just a string');
  assert.equal(env.shownNotifications.length, 0);

  // Object missing both title and body
  await env.dispatchPush({});
  assert.equal(env.shownNotifications.length, 0);
});

test('SW: push does not expose arbitrary navigation URL and truncates finite strings', async () => {
  const env = createSwContext({ clients: [] });

  const hugeTitle = 'A'.repeat(500);
  const hugeBody = 'B'.repeat(1000);

  await env.dispatchPush({
    title: hugeTitle,
    body: hugeBody,
    tag: 'test-tag',
    arbitraryUrl: 'http://malicious-site.com',
  });

  assert.equal(env.shownNotifications.length, 1);
  const shown = env.shownNotifications[0];
  assert.ok(shown.title.length <= 200, 'Title must be clamped to safe finite length');
  assert.ok(shown.options.body.length <= 500, 'Body must be clamped to safe finite length');
  assert.equal(shown.options.tag, 'test-tag');
  assert.equal((shown.options as any).arbitraryUrl, undefined, 'Must not forward arbitrary URLs');
});

test('SW: notificationclick closes notification and focuses existing viewer window', async () => {
  let focused = false;
  const client: MockClient = {
    url: 'http://localhost:3000/',
    type: 'window',
    focus: async () => {
      focused = true;
    },
  };
  const env = createSwContext({ clients: [client] });

  const result = await env.dispatchClick({
    tag: 'agent_settled',
  });

  assert.equal(result.closed, true, 'Must close notification on click');
  assert.equal(focused, true, 'Must focus existing client');
  assert.equal(env.getOpenedWindowUrl(), null, 'Must not open new window if one exists');
});

test('SW: notificationclick opens same origin root when no viewer window exists', async () => {
  const env = createSwContext({ clients: [] });

  const result = await env.dispatchClick({
    tag: 'agent_settled',
  });

  assert.equal(result.closed, true, 'Must close notification on click');
  assert.equal(env.getOpenedWindowUrl(), '/', 'Must open root / when no window exists');
});
