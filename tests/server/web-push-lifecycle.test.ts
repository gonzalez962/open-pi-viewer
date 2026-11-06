import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPiAgentDirForTest, setSubprocessSpawnerForTest } from '@server/bridge/state';
import { setStorageFilePathForTest } from '@server/storage';
import webpush from 'web-push';
import {
  addPushNotificationHook,
  resetPiRpcForTest,
  PiRpcSession,
} from '@server/bridge/rpc';
import {
  createWebPush,
  type WebPushConfig,
} from '@server/bridge/web-push';
import { installWebApi, type MiddlewareApp } from '@server/web-api';

// ---------------------------------------------------------------------------
// Helpers & Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_WEB_AUTH_COOKIE_NAME = 'pi_viewer_auth_session';

const VALID_VAPID_CONFIG: WebPushConfig = {
  available: true,
  publicKey: 'BEI4d5FfKPKwCEG7mnhLQSGT9hw-wKrKWYWbYW5mTkN0bIlmNVP7nnL3XJNpk36jYvHvALsdmBeCzjLwn5P_yas',
  privateKey: 'YYnGT3-7VMS06hwEdQthVPsUMYo7mIuUh-VjJCvEeVQ',
  subject: 'mailto:admin@example.com',
};

const SUB_A = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-a',
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9AcUbVUtu_cmdndsmby471-V7V1pE307W7n2p59Y6pBfE4=',
    auth: '5K2bW78t_v73k1_4A17d6w==',
  },
};

const SUB_B = {
  endpoint: 'https://push.services.mozilla.com/push/v1/device-b',
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9AcUbVUtu_cmdndsmby471-V7V1pE307W7n2p59Y6pBfE4=',
    auth: '5K2bW78t_v73k1_4A17d6w==',
  },
};

class MockRequest extends EventEmitter {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
  socket: { encrypted?: boolean; remoteAddress?: string };
  body?: any;

  constructor(options: {
    url?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: any;
  } = {}) {
    super();
    this.url = options.url || '/api/events';
    this.method = options.method || 'GET';
    this.headers = { host: 'localhost:5173', origin: 'http://localhost:5173', ...options.headers };
    this.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
    this.body = options.body;
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string | string[]> = {};
  body = '';
  ended = false;
  writableEnded = false;
  destroyed = false;

  setHeader(name: string, value: string | string[]) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, headers?: Record<string, string | string[]>) {
    this.statusCode = statusCode;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.setHeader(k, v);
      }
    }
    return this;
  }

  write(chunk: any) {
    this.body += String(chunk);
    return true;
  }

  end(chunk?: any) {
    if (chunk) this.body += String(chunk);
    this.ended = true;
    this.writableEnded = true;
    this.emit('finish');
    return this;
  }
}

function extractCookie(res: MockResponse, cookieName: string = DEFAULT_WEB_AUTH_COOKIE_NAME): string | null {
  const setCookie = res.getHeader('set-cookie');
  if (!setCookie) return null;
  const str = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
  const match = str.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

class MockApp implements MiddlewareApp {
  routes: Array<{ path?: string; handler: (req: any, res: any, next: (err?: any) => void) => void | Promise<void> }> = [];

  use(arg1: any, arg2?: any): void {
    if (typeof arg1 === 'string') {
      this.routes.push({ path: arg1, handler: arg2 });
    } else {
      this.routes.push({ handler: arg1 });
    }
  }

  async handle(req: any, res: any): Promise<void> {
    for (const route of this.routes) {
      if (!route.path || req.url.startsWith(route.path)) {
        let isNext = false;
        const next = () => {
          isNext = true;
        };
        const endPromise = new Promise<void>((resolve) => {
          if (res.ended) return resolve();
          res.once('finish', () => resolve());
        });
        const maybePromise: unknown = route.handler(req, res, next);
        if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
          await (maybePromise as Promise<void>);
        }
        if (!isNext && route.path) {
          if (!res.ended) {
            await Promise.race([
              endPromise,
              new Promise((resolve) => setTimeout(resolve, 50)),
            ]);
          }
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. RPC Hooks: addPushNotificationHook, idempotent unsubscribe & error isolation
// ---------------------------------------------------------------------------

test('RPC listeners: addPushNotificationHook returns idempotent unsubscribe; closing one leaves other active', async () => {
  resetPiRpcForTest();

  const events1: any[] = [];
  const events2: any[] = [];

  const unsub1 = addPushNotificationHook((e) => {
    events1.push(e);
  });
  const unsub2 = addPushNotificationHook((e) => {
    events2.push(e);
  });

  const session = new PiRpcSession();
  (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });

  assert.equal(events1.length, 1);
  assert.equal(events2.length, 1);

  // Unsubscribe listener 1 idempotently
  unsub1();
  unsub1(); // second call must be safe no-op

  (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });

  assert.equal(events1.length, 1, 'Listener 1 must not receive after unsubscribe');
  assert.equal(events2.length, 2, 'Listener 2 must continue receiving events');

  unsub2();
  (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
  assert.equal(events2.length, 2);

  resetPiRpcForTest();
});

test('RPC listeners: error in one listener is isolated and does not block subsequent listeners', async () => {
  resetPiRpcForTest();

  let listener2Called = false;
  const unsub1 = addPushNotificationHook(() => {
    throw new Error('Boom in listener 1');
  });
  const unsub2 = addPushNotificationHook(() => {
    listener2Called = true;
  });

  const session = new PiRpcSession();
  // Must not throw out of handleStdoutLine
  assert.doesNotThrow(() => {
    (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
  });

  assert.equal(listener2Called, true, 'Subsequent listener must execute despite previous error');

  unsub1();
  unsub2();
  resetPiRpcForTest();
});

test('RPC listeners: resetPiRpcForTest clears listeners only in explicit reset', async () => {
  resetPiRpcForTest();

  let called = false;
  addPushNotificationHook(() => {
    called = true;
  });

  resetPiRpcForTest();

  const session = new PiRpcSession();
  (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });

  assert.equal(called, false, 'Listeners should be cleared by resetPiRpcForTest');
});

// ---------------------------------------------------------------------------
// 2. WebPush: isOwnerConnected suppression
// ---------------------------------------------------------------------------

test('WebPush: isOwnerConnected suppresses push only for connected owner; disconnected owner receives', async () => {
  const deliveries: Array<{ endpoint: string; owner: string }> = [];

  const connectedOwners = new Set<string>(['owner_A']);
  const isOwnerConnected = (owner: string) => connectedOwners.has(owner);

  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: (req: any) => req.headers['x-owner'],
    validateOwnerLease: () => true,
  };

  const push = createWebPush({
    webAuth: mockWebAuth,
    config: VALID_VAPID_CONFIG,
    isOwnerConnected,
    sendNotification: async (sub) => {
      deliveries.push({
        endpoint: sub.endpoint,
        owner: sub.endpoint === SUB_A.endpoint ? 'owner_A' : 'owner_B',
      });
    },
  });

  // Register subscription for owner_A
  const reqA = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner': 'owner_A' },
    body: { subscription: SUB_A },
  });
  await push.handleSubscriptions(reqA, new MockResponse());

  // Register subscription for owner_B
  const reqB = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner': 'owner_B' },
    body: { subscription: SUB_B },
  });
  await push.handleSubscriptions(reqB, new MockResponse());

  assert.equal(push.getSubscriptionsCount(), 2);

  // 1. Dispatch event while owner_A is connected: owner_A suppressed, owner_B receives
  await push.dispatchPushEvent({ type: 'agent_settled' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].owner, 'owner_B');

  // 2. Disconnect owner_A: now owner_A should receive
  connectedOwners.delete('owner_A');
  await push.dispatchPushEvent({ type: 'agent_settled' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(deliveries.length, 3); // B delivered again, A now delivered
  const lastDeliveries = deliveries.slice(1);
  const deliveredOwners = lastDeliveries.map((d) => d.owner).sort();
  assert.deepEqual(deliveredOwners, ['owner_A', 'owner_B']);
});

test('WebPush: isOwnerConnected defaults to false when not provided in options', async () => {
  const deliveries: string[] = [];

  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_A',
    validateOwnerLease: () => true,
  };

  const push = createWebPush({
    webAuth: mockWebAuth,
    config: VALID_VAPID_CONFIG,
    sendNotification: async (sub) => {
      deliveries.push(sub.endpoint);
    },
  });

  const req = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: SUB_A },
  });
  await push.handleSubscriptions(req, new MockResponse());

  await push.dispatchPushEvent({ type: 'agent_settled' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0], SUB_A.endpoint);
});

// ---------------------------------------------------------------------------
// 3. installWebApi: active webAuth SSE tracking and suppression integration
// ---------------------------------------------------------------------------

test('installWebApi: tracks active webAuth SSE connections; suppresses push for active owner and receives for disconnected owner', async () => {
  resetPiRpcForTest();
  process.env.PI_VIEWER_VAPID_PUBLIC_KEY = VALID_VAPID_CONFIG.publicKey;
  process.env.PI_VIEWER_VAPID_PRIVATE_KEY = VALID_VAPID_CONFIG.privateKey;
  process.env.PI_VIEWER_VAPID_SUBJECT = VALID_VAPID_CONFIG.subject;

  const deliveredEndpoints: string[] = [];
  const originalSend = webpush.sendNotification;
  webpush.sendNotification = (async (sub: any) => {
    deliveredEndpoints.push(sub.endpoint);
    return { statusCode: 201 };
  }) as any;

  try {
    const app = new MockApp();
    const server = new EventEmitter();
    const authConfig = { enabled: true, key: 'test-secret-key-123' };

    installWebApi(app, server, authConfig);

    // 1. Login user A
    const loginReqA = new MockRequest({
      url: '/api/auth/login',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { key: 'test-secret-key-123' },
    });
    const loginResA = new MockResponse();
    await app.handle(loginReqA, loginResA);
    const tokenA = extractCookie(loginResA);
    assert.ok(tokenA, 'User A should receive auth session token');

    // 2. Login user B
    const loginReqB = new MockRequest({
      url: '/api/auth/login',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { key: 'test-secret-key-123' },
    });
    const loginResB = new MockResponse();
    await app.handle(loginReqB, loginResB);
    const tokenB = extractCookie(loginResB);
    assert.ok(tokenB, 'User B should receive auth session token');

    // 3. Register subscriptions for user A and user B
    const regReqA = new MockRequest({
      url: '/api/push/subscriptions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${tokenA}`,
      },
      body: { subscription: SUB_A },
    });
    const regResA = new MockResponse();
    await app.handle(regReqA, regResA);
    assert.equal(regResA.statusCode, 200);

    const regReqB = new MockRequest({
      url: '/api/push/subscriptions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${tokenB}`,
      },
      body: { subscription: SUB_B },
    });
    const regResB = new MockResponse();
    await app.handle(regReqB, regResB);
    assert.equal(regResB.statusCode, 200);

    // 4. Connect user A to /api/events SSE
    const sseReqA = new MockRequest({
      url: '/api/events',
      method: 'GET',
      headers: {
        cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${tokenA}`,
      },
    });
    const sseResA = new MockResponse();
    await app.handle(sseReqA, sseResA);

    // 5. Fire public RPC event: user A should be suppressed (active SSE); user B should receive
    const session = new PiRpcSession();
    (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(deliveredEndpoints.length, 1);
    assert.equal(deliveredEndpoints[0], SUB_B.endpoint, 'User B must receive push; user A must be suppressed');

    // 6. Disconnect user A
    sseReqA.emit('close');
    sseResA.emit('close');

    // 7. Fire public RPC event again: now user A has no active SSE connection, receives push!
    (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(deliveredEndpoints.length, 3); // B delivered again (2), A now delivered (3)
    assert.ok(deliveredEndpoints.includes(SUB_A.endpoint), 'User A must receive push after disconnect');

    server.emit('close');
  } finally {
    webpush.sendNotification = originalSend;
    resetPiRpcForTest();
  }
});

test('installWebApi: stale ended or destroyed response or invalid webAuth lease is not considered connected', async () => {
  resetPiRpcForTest();
  process.env.PI_VIEWER_VAPID_PUBLIC_KEY = VALID_VAPID_CONFIG.publicKey;
  process.env.PI_VIEWER_VAPID_PRIVATE_KEY = VALID_VAPID_CONFIG.privateKey;
  process.env.PI_VIEWER_VAPID_SUBJECT = VALID_VAPID_CONFIG.subject;

  const deliveredEndpoints: string[] = [];
  const originalSend = webpush.sendNotification;
  webpush.sendNotification = (async (sub: any) => {
    deliveredEndpoints.push(sub.endpoint);
    return { statusCode: 201 };
  }) as any;

  try {
    const app = new MockApp();
    const server = new EventEmitter();
    const authConfig = { enabled: true, key: 'test-secret-key-123' };

    installWebApi(app, server, authConfig);

    // Login user A
    const loginReq = new MockRequest({
      url: '/api/auth/login',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { key: 'test-secret-key-123' },
    });
    const loginRes = new MockResponse();
    await app.handle(loginReq, loginRes);
    const token = extractCookie(loginRes);
    assert.ok(token);

    // Register subscription
    const regReq = new MockRequest({
      url: '/api/push/subscriptions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
      },
      body: { subscription: SUB_A },
    });
    const regRes = new MockResponse();
    await app.handle(regReq, regRes);
    assert.equal(regRes.statusCode, 200);

    // Connect user A to /api/events SSE
    const sseReq = new MockRequest({
      url: '/api/events',
      method: 'GET',
      headers: {
        cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
      },
    });
    const sseRes = new MockResponse();
    await app.handle(sseReq, sseRes);

    // Mark the response as writableEnded (stale)
    sseRes.writableEnded = true;

    // Fire RPC event: stale response must NOT suppress push!
    const session = new PiRpcSession();
    (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(deliveredEndpoints.length, 1);
    assert.equal(deliveredEndpoints[0], SUB_A.endpoint, 'Stale SSE response must not suppress push');

    server.emit('close');
  } finally {
    webpush.sendNotification = originalSend;
    resetPiRpcForTest();
  }
});

test('installWebApi: server close of A does not suppress B with public event injection', async () => {
  resetPiRpcForTest();
  process.env.PI_VIEWER_VAPID_PUBLIC_KEY = VALID_VAPID_CONFIG.publicKey;
  process.env.PI_VIEWER_VAPID_PRIVATE_KEY = VALID_VAPID_CONFIG.privateKey;
  process.env.PI_VIEWER_VAPID_SUBJECT = VALID_VAPID_CONFIG.subject;

  const deliveredEndpoints: string[] = [];
  const originalSend = webpush.sendNotification;
  webpush.sendNotification = (async (sub: any) => {
    deliveredEndpoints.push(sub.endpoint);
    return { statusCode: 201 };
  }) as any;

  try {
    const appA = new MockApp();
    const serverA = new EventEmitter();
    const authConfigA = { enabled: true, key: 'test-key-a' };
    installWebApi(appA, serverA, authConfigA);

    const appB = new MockApp();
    const serverB = new EventEmitter();
    const authConfigB = { enabled: true, key: 'test-key-b' };
    installWebApi(appB, serverB, authConfigB);

    // Register subscription on server B
    const loginReqB = new MockRequest({
      url: '/api/auth/login',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { key: 'test-key-b' },
    });
    const loginResB = new MockResponse();
    await appB.handle(loginReqB, loginResB);
    const tokenB = extractCookie(loginResB);
    assert.ok(tokenB);

    const regReqB = new MockRequest({
      url: '/api/push/subscriptions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${tokenB}`,
      },
      body: { subscription: SUB_B },
    });
    const regResB = new MockResponse();
    await appB.handle(regReqB, regResB);
    assert.equal(regResB.statusCode, 200);

    // Close server A: this unsubscribes only server A's hook
    serverA.emit('close');

    // Fire public RPC event: server B must still receive and dispatch push!
    const session = new PiRpcSession();
    (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(deliveredEndpoints.length, 1);
    assert.equal(deliveredEndpoints[0], SUB_B.endpoint, 'Server B must still dispatch push after server A close');

    serverB.emit('close');
  } finally {
    webpush.sendNotification = originalSend;
    resetPiRpcForTest();
  }
});


test('S1.1 Web Push defers completion for active children and jobs', async () => {
  const payloads: any[] = [];
  const push = createWebPush({ webAuth: { isEnabled: () => true, authenticate: () => 'owner', validateOwnerLease: () => true } as any, config: VALID_VAPID_CONFIG, gitResolver: () => null, sendNotification: async (_sub, payload) => { payloads.push(JSON.parse(payload)); } });
  await push.handleSubscriptions(new MockRequest({ url: '/api/push/subscriptions', method: 'POST', headers: { 'content-type': 'application/json' }, body: { subscription: SUB_A } }), new MockResponse());
  const base = { cwd: '/project', sessionId: 'one' };
  const widget = (status: string) => push.dispatchPushEvent({ ...base, type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', status } }] })] });
  await push.dispatchPushEvent({ ...base, type: 'agent_start' });
  await widget('running');
  await push.dispatchPushEvent({ ...base, type: 'tool_execution_end', toolName: 'bash_background', result: { details: { gentleJobs: { id: 'job' } } } });
  await push.dispatchPushEvent({ ...base, type: 'agent_settled' });
  assert.equal(payloads.length, 0);
  await widget('completed');
  assert.equal(payloads.length, 0);
  await push.dispatchPushEvent({ ...base, type: 'tool_execution_end', toolName: 'job_stop', result: { details: { gentleJobs: { id: 'job' } } } });
  assert.deepEqual(payloads.map(p => p.eventType), ['task_complete']);
  push.dispose();
});

async function deferredPushHarness() {
  const payloads: any[] = [];
  const push = createWebPush({ webAuth: { isEnabled: () => true, authenticate: () => 'owner', validateOwnerLease: () => true } as any, config: VALID_VAPID_CONFIG, gitResolver: () => null, sendNotification: async (_sub, payload) => { payloads.push(JSON.parse(payload)); } });
  await push.handleSubscriptions(new MockRequest({ url: '/api/push/subscriptions', method: 'POST', headers: { 'content-type': 'application/json' }, body: { subscription: SUB_A } }), new MockResponse());
  const send = (cwd: string, sessionId: string, event: Record<string, unknown>) => push.dispatchPushEvent({ ...event, type: String(event.type), cwd, sessionId });
  const widget = (cwd: string, sessionId: string, status: string) => send(cwd, sessionId, { type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', status } }] })] });
  const job = (cwd: string, sessionId: string, active: boolean) => send(cwd, sessionId, { type: 'tool_execution_end', toolName: active ? 'bash_background' : 'job_stop', result: { details: { gentleJobs: { id: 'job' } } } });
  return { push, payloads, send, widget, job };
}

for (const settleFirst of [true, false]) {
  test(`S1.2 Web Push ${settleFirst ? 'settlement first' : 'activity first'} with duplicates`, async () => {
    const h = await deferredPushHarness();
    await h.send('/one', 'one', { type: 'agent_start' });
    await h.widget('/one', 'one', 'running');
    await h.job('/one', 'one', true);
    if (settleFirst) await h.send('/one', 'one', { type: 'agent_settled' });
    await h.job('/one', 'one', false);
    await h.job('/one', 'one', false);
    assert.equal(h.payloads.length, 0);
    await h.widget('/one', 'one', 'completed');
    if (!settleFirst) {
      assert.equal(h.payloads.length, 0);
      await h.send('/one', 'one', { type: 'agent_settled' });
    }
    await h.send('/one', 'one', { type: 'agent_settled' });
    await h.widget('/one', 'one', 'completed');
    assert.deepEqual(h.payloads.map(p => p.eventType), ['task_complete']);
    h.push.dispose();
  });
}

test('S1.3 Web Push keeps concurrent session origins isolated', async () => {
  const h = await deferredPushHarness();
  for (const [cwd, id] of [['/one', 'one'], ['/two', 'two']]) {
    await h.send(cwd, id, { type: 'agent_start' });
    await h.widget(cwd, id, 'running');
    await h.send(cwd, id, { type: 'agent_settled' });
  }
  assert.equal(h.payloads.length, 0);
  await h.widget('/two', 'two', 'completed');
  assert.equal(h.payloads.length, 1);
  assert.match(h.payloads[0].title, /two$/);
  await h.widget('/one', 'one', 'completed');
  assert.equal(h.payloads.length, 2);
  assert.match(h.payloads[1].title, /one$/);
  h.push.dispose();
});

for (const invalidation of ['new turn', 'cancel']) {
  test(`S1.4 Web Push malformed activity and ${invalidation} do not release stale success`, async () => {
    const h = await deferredPushHarness();
    await h.send('/one', 'one', { type: 'agent_start' });
    await h.widget('/one', 'one', 'running');
    await h.send('/one', 'one', { type: 'agent_settled' });
    await h.send('/one', 'one', { type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: null })] });
    assert.deepEqual(h.payloads, []);
    await h.send('/one', 'one', { type: 'agent_start' });
    if (invalidation === 'cancel') {
      await h.send('/one', 'one', { type: 'message_end', message: { role: 'assistant', content: 'Cancelled', stopReason: 'aborted' } });
      await h.send('/one', 'one', { type: 'agent_settled' });
    }
    await h.widget('/one', 'one', 'completed');
    assert.deepEqual(h.payloads, []);
    h.push.dispose();
  });
}

for (const identity of ['known', 'unknown']) {
  test(`S1.4 Web Push runtime disconnect with ${identity} identity cannot release pending completion`, async () => {
    const h = await deferredPushHarness();
    await h.send('/one', 'one', { type: 'agent_start' });
    await h.widget('/one', 'one', 'running');
    await h.send('/one', 'one', { type: 'agent_settled' });
    assert.equal(h.payloads.length, 0);
    await h.push.dispatchPushEvent({ type: 'runtime_disconnected', cwd: '/one', ...(identity === 'known' ? { sessionId: 'one' } : {}) });
    await h.widget('/one', 'one', 'completed');
    assert.equal(h.payloads.length, 0);
    h.push.dispose();
  });
}

test('S1.4 Web Push replacement snapshot cannot release pending completion', async () => {
  const h = await deferredPushHarness();
  await h.send('/one', 'one', { type: 'runtime_snapshot', sessionFile: '/old', activeJobs: [] });
  await h.send('/one', 'one', { type: 'agent_start' });
  await h.widget('/one', 'one', 'running');
  await h.send('/one', 'one', { type: 'agent_settled' });
  await h.send('/one', 'one', { type: 'runtime_snapshot', sessionFile: '/new', activeJobs: [] });
  await h.widget('/one', 'one', 'completed');
  assert.equal(h.payloads.length, 0);
  h.push.dispose();
});

test('S1.4 bridge kill forwards runtime disconnect to Web Push', async () => {
  resetPiRpcForTest();
  const h = await deferredPushHarness();
  const events: any[] = [];
  const unsubscribe = addPushNotificationHook(event => { events.push(event); void h.push.dispatchPushEvent(event); });
  try {
    const session = new PiRpcSession();
    session.cwd = '/one';
    session.sessionId = 'one';
    await h.send('/one', 'one', { type: 'agent_start' });
    await h.widget('/one', 'one', 'running');
    await h.send('/one', 'one', { type: 'agent_settled' });
    session.kill();
    assert.equal(events[events.length - 1]?.type, 'runtime_disconnected');
    assert.equal(events[events.length - 1]?.sessionId, 'one');
    await h.widget('/one', 'one', 'completed');
    assert.equal(h.payloads.length, 0);
  } finally {
    unsubscribe();
    h.push.dispose();
    resetPiRpcForTest();
  }
});

for (const transition of ['exit', 'replacement']) {
  test(`S1.4 real subprocess ${transition} forwards disconnect and cannot release stale push`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-bridge-'));
    setPiAgentDirForTest(root);
    setStorageFilePathForTest(path.join(root, 'storage.json'));
    resetPiRpcForTest();
    const h = await deferredPushHarness();
    const forwarded: any[] = [];
    const unsubscribe = addPushNotificationHook(event => {
      forwarded.push(event);
      void h.push.dispatchPushEvent(event);
    });
    let child: ChildProcess;
    setSubprocessSpawnerForTest(() => {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    });
    const session = new PiRpcSession();
    const originalLog = console.log;
    try {
      // Answer only the handshake; process creation, stdout event routing and exit remain real.
      session.sendCommand = async () => ({ success: true, data: { sessionId: 'one', sessionFile: path.join(root, 'old') } });
      await session.ensureRunning(root);
      const cwd = session.cwd;
      const emit = (event: unknown) => (child.stdout as PassThrough).emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      emit({ type: 'agent_start' });
      emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', status: 'running' } }] })] });
      emit({ type: 'agent_end', willRetry: false });
      assert.equal(h.payloads.length, 0);
      const oldChild = child!;
      const exited = new Promise<void>(resolve => oldChild.once('exit', () => resolve()));
      console.log = () => {};
      if (transition === 'exit') oldChild.kill();
      else await session.ensureRunning(root, path.join(root, 'replacement'));
      await exited;
      assert.ok(forwarded.some(event => event.type === 'runtime_disconnected' && event.sessionId === 'one'));
      await h.widget(cwd, 'one', 'completed');
      assert.equal(h.payloads.length, 0);
    } finally {
      console.log = originalLog;
      session.kill();
      unsubscribe();
      h.push.dispose();
      setSubprocessSpawnerForTest(null);
      setPiAgentDirForTest(null);
      setStorageFilePathForTest(null);
      resetPiRpcForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('S1.2 bridge forwards activity to push hooks while preserving settled routing', () => {
  resetPiRpcForTest();
  const events: any[] = [];
  const unsubscribe = addPushNotificationHook(event => events.push(event));
  try {
    const session = new PiRpcSession();
    (session as any).handleStdoutLine({ type: 'tool_execution_end', toolCallId: 'start', toolName: 'bash_background', result: { details: { gentleJobs: { id: 'job' } } } });
    (session as any).handleStdoutLine({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [] })] });
    (session as any).handleStdoutLine({ type: 'agent_end', willRetry: false });
    assert.deepEqual(events.map(event => event.type), ['tool_execution_end', 'extension_ui_request', 'agent_settled']);
  } finally {
    unsubscribe();
    resetPiRpcForTest();
  }
});

test('S2.1 WebPush classifies final outcomes without leaking response content and honors waiting preferences', async () => {
  const payloads: any[] = [];
  const push = createWebPush({
    webAuth: { isEnabled: () => true, authenticate: () => 'owner', validateOwnerLease: () => true } as any,
    config: VALID_VAPID_CONFIG,
    sendNotification: async (_sub, payload) => { payloads.push(JSON.parse(payload)); },
  });
  await push.handleSubscriptions(new MockRequest({
    url: '/api/push/subscriptions', method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: SUB_A, language: 'es' },
  }), new MockResponse());
  for (const [text, stopReason, expected] of [
    ['Necesito que confirmes: secret-value', 'stop', 'waiting_input'],
    ['secret-value', 'error', 'error'],
    ['Completed: secret-value', 'stop', 'task_complete'],
  ]) {
    await push.dispatchPushEvent({ type: 'message_end', sessionId: 'one', message: { role: 'assistant', content: text, stopReason } });
    await push.dispatchPushEvent({ type: 'agent_settled', sessionId: 'one' });
    assert.equal(payloads[payloads.length - 1].eventType, expected);
    assert.ok(!JSON.stringify(payloads[payloads.length - 1]).includes('secret-value'));
  }
  await push.dispatchPushEvent({ type: 'agent_settled', messages: [{ role: 'assistant', content: '', stopReason: 'aborted' }] });
  assert.equal(payloads.length, 3);
  await push.handleSubscriptions(new MockRequest({
    url: '/api/push/subscriptions', method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: SUB_A, preferences: { enabled: true, onTaskComplete: true, onWaitingInput: false } },
  }), new MockResponse());
  await push.dispatchPushEvent({ type: 'agent_settled', messages: [{ role: 'assistant', content: 'Waiting for your confirmation' }] });
  assert.equal(payloads.length, 3);
});
