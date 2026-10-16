import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
