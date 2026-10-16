import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebAuth } from '@server/bridge/web-auth';
import {
  createWebPush,
  resolveWebPushConfig,
  type WebPushConfig,
} from '@server/bridge/web-push';
import { PiRpcSession, addPushNotificationHook, resetPiRpcForTest } from '@server/bridge/rpc';

// ---------------------------------------------------------------------------
// Mock HTTP Fixtures
// ---------------------------------------------------------------------------

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
    encrypted?: boolean;
    remoteAddress?: string;
    body?: any;
  } = {}) {
    super();
    this.url = options.url || '/api/push/config';
    this.method = options.method || 'GET';
    this.headers = { host: 'localhost:5173', origin: 'http://localhost:5173', ...options.headers };
    this.socket = {
      encrypted: options.encrypted || false,
      remoteAddress: options.remoteAddress || '127.0.0.1',
    };
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

function parseJson(res: MockResponse): any {
  return JSON.parse(res.body || '{}');
}

function streamRequestBody(req: MockRequest, body: string) {
  process.nextTick(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
}

const VALID_VAPID_CONFIG: WebPushConfig = {
  available: true,
  publicKey: 'BEI4d5FfKPKwCEG7mnhLQSGT9hw-wKrKWYWbYW5mTkN0bIlmNVP7nnL3XJNpk36jYvHvALsdmBeCzjLwn5P_yas',
  privateKey: 'YYnGT3-7VMS06hwEdQthVPsUMYo7mIuUh-VjJCvEeVQ',
  subject: 'mailto:admin@example.com',
};

const VALID_FCM_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-token-12345',
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9AcUbVUtu_cmdndsmby471-V7V1pE307W7n2p59Y6pBfE4=',
    auth: '5K2bW78t_v73k1_4A17d6w==',
  },
};

// ---------------------------------------------------------------------------
// 0. VAPID Configuration Resolver
// ---------------------------------------------------------------------------

test('resolveWebPushConfig: unavailable when env vars are missing or invalid', () => {
  assert.equal(resolveWebPushConfig({}).available, false);
  assert.equal(
    resolveWebPushConfig({
      PI_VIEWER_VAPID_PUBLIC_KEY: 'invalid-key',
      PI_VIEWER_VAPID_PRIVATE_KEY: 'invalid-key',
      PI_VIEWER_VAPID_SUBJECT: 'not-mailto-or-https',
    }).available,
    false
  );
});

test('resolveWebPushConfig: available when valid base64url keys and mailto subject are provided', () => {
  const cfg = resolveWebPushConfig({
    PI_VIEWER_VAPID_PUBLIC_KEY: VALID_VAPID_CONFIG.publicKey,
    PI_VIEWER_VAPID_PRIVATE_KEY: VALID_VAPID_CONFIG.privateKey,
    PI_VIEWER_VAPID_SUBJECT: VALID_VAPID_CONFIG.subject,
  });
  assert.equal(cfg.available, true);
  assert.equal(cfg.publicKey, VALID_VAPID_CONFIG.publicKey);
  assert.equal(cfg.subject, VALID_VAPID_CONFIG.subject);
});

// ---------------------------------------------------------------------------
// 1. Config Endpoint (GET /api/push/config)
// ---------------------------------------------------------------------------

test('push config: unavailable for remote access when auth is disabled', async () => {
  const webAuth = createWebAuth({ enabled: false });
  const push = createWebPush({
    webAuth,
    config: VALID_VAPID_CONFIG,
  });

  const req = new MockRequest({ url: '/api/push/config', method: 'GET', remoteAddress: '192.168.1.5' });
  const res = new MockResponse();
  await push.handleConfig(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(parseJson(res), { available: false });
});

test('push config: unavailable when VAPID keys are missing, even if auth enabled', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret' });
  const push = createWebPush({
    webAuth,
    config: { available: false },
  });

  const req = new MockRequest({ url: '/api/push/config', method: 'GET' });
  const res = new MockResponse();
  await push.handleConfig(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(parseJson(res), { available: false });
});

test('push config: returns available=true and publicKey when auth enabled and VAPID configured', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret' });
  const push = createWebPush({
    webAuth,
    config: VALID_VAPID_CONFIG,
  });

  const req = new MockRequest({ url: '/api/push/config', method: 'GET' });
  const res = new MockResponse();
  await push.handleConfig(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(parseJson(res), {
    available: true,
    publicKey: VALID_VAPID_CONFIG.publicKey,
  });
});

test('push config: rejects cross-origin request with 403', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret' });
  const push = createWebPush({ webAuth, config: VALID_VAPID_CONFIG });

  const req = new MockRequest({
    url: '/api/push/config',
    method: 'GET',
    headers: { host: 'localhost:5173', origin: 'http://malicious.com' },
  });
  const res = new MockResponse();
  await push.handleConfig(req, res);

  assert.equal(res.statusCode, 403);
});

test('push config: rejects suffix aliases with 404 and wrong methods with 405', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret' });
  const push = createWebPush({ webAuth, config: VALID_VAPID_CONFIG });

  // Suffix alias
  const reqSuffix = new MockRequest({ url: '/api/push/config/suffix', method: 'GET' });
  const resSuffix = new MockResponse();
  await push.handleConfig(reqSuffix, resSuffix);
  assert.equal(resSuffix.statusCode, 404);

  // Method not allowed
  const reqPost = new MockRequest({ url: '/api/push/config', method: 'POST' });
  const resPost = new MockResponse();
  await push.handleConfig(reqPost, resPost);
  assert.equal(resPost.statusCode, 405);
});

// ---------------------------------------------------------------------------
// 2. Subscription Validation & Bounding
// ---------------------------------------------------------------------------

test('subscriptions: rejects unauthenticated registration with 401 when webAuth enabled', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret' });
  const push = createWebPush({ webAuth, config: VALID_VAPID_CONFIG });

  const req = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: VALID_FCM_SUB },
  });
  const res = new MockResponse();
  await push.handleSubscriptions(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(push.getSubscriptionsCount(), 0);
});

test('subscriptions: rejects invalid endpoints (http, localhost, credentials, CRLF) with 400 and keeps store unchanged', async () => {
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_valid',
    validateOwnerLease: () => true,
  };
  const push = createWebPush({ webAuth: mockWebAuth, config: VALID_VAPID_CONFIG });

  const invalidEndpoints = [
    'http://fcm.googleapis.com/fcm/send/token', // not https
    'https://localhost:8080/push', // localhost not in allowlist
    'https://fcm.googleapis.com:8080/fcm/send/token', // arbitrary port blocked
    'https://fcm.googleapis.com./fcm/send/token', // trailing dot blocked
    'https://user:pass@fcm.googleapis.com/fcm/send/token', // credentials forbidden
    'https://fcm.googleapis.com/fcm/send/token\r\nX-Injected: evil', // CRLF
    'https://internal.lan/notify', // not allowed vendor
  ];

  for (const endpoint of invalidEndpoints) {
    const req = new MockRequest({
      url: '/api/push/subscriptions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        subscription: { ...VALID_FCM_SUB, endpoint },
        preferences: { enabled: true, sound: true, suppressWhenFocused: true, onTaskComplete: true, onWaitingInput: true },
        language: 'en',
      },
    });
    const res = new MockResponse();
    await push.handleSubscriptions(req, res);
    assert.equal(res.statusCode, 400, `Expected 400 for endpoint ${endpoint}`);
  }

  assert.equal(push.getSubscriptionsCount(), 0);
});

test('subscriptions: rejects invalid keys (non-base64, CRLF, bad lengths) with 400', async () => {
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_valid',
    validateOwnerLease: () => true,
  };
  const push = createWebPush({ webAuth: mockWebAuth, config: VALID_VAPID_CONFIG });

  const invalidKeySets = [
    { p256dh: 'too-short', auth: 'valid-auth-1234567890' },
    { p256dh: VALID_FCM_SUB.keys.p256dh, auth: 'bad\r\nauth' },
    { p256dh: 'invalid!characters!not!base64!'.repeat(4), auth: 'valid-auth-1234567890' },
  ];

  for (const keys of invalidKeySets) {
    const req = new MockRequest({
      url: '/api/push/subscriptions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        subscription: { endpoint: VALID_FCM_SUB.endpoint, keys },
        language: 'en',
      },
    });
    const res = new MockResponse();
    await push.handleSubscriptions(req, res);
    assert.equal(res.statusCode, 400);
  }

  assert.equal(push.getSubscriptionsCount(), 0);
});

test('subscriptions: rejects invalid language and excessive project count with 400', async () => {
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_valid',
    validateOwnerLease: () => true,
  };
  const push = createWebPush({ webAuth: mockWebAuth, config: VALID_VAPID_CONFIG });

  // Invalid language
  const reqLang = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      subscription: VALID_FCM_SUB,
      language: 'fr',
    },
  });
  const resLang = new MockResponse();
  await push.handleSubscriptions(reqLang, resLang);
  assert.equal(resLang.statusCode, 400);

  // Excessive projects (> 100)
  const tooManyProjects = Array.from({ length: 101 }, (_, i) => ({ path: `/repo/${i}`, customName: `Proj ${i}` }));
  const reqProj = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      subscription: VALID_FCM_SUB,
      language: 'en',
      projects: tooManyProjects,
    },
  });
  const resProj = new MockResponse();
  await push.handleSubscriptions(reqProj, resProj);
  assert.equal(resProj.statusCode, 400);

  assert.equal(push.getSubscriptionsCount(), 0);
});

test('subscriptions: rejects body larger than 32KB with 413', async () => {
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_valid',
    validateOwnerLease: () => true,
  };
  const push = createWebPush({ webAuth: mockWebAuth, config: VALID_VAPID_CONFIG });

  const largeBody = JSON.stringify({
    subscription: VALID_FCM_SUB,
    padding: 'x'.repeat(40000),
  });

  const req = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const res = new MockResponse();

  const promise = push.handleSubscriptions(req, res);
  streamRequestBody(req, largeBody);
  await promise;

  assert.equal(res.statusCode, 413);
  assert.equal(push.getSubscriptionsCount(), 0);
});

// ---------------------------------------------------------------------------
// 3. Leases, Cross-Owner Protection & Takeover Lifecycle (S3 & S4)
// ---------------------------------------------------------------------------

test('subscriptions: prevents cross-owner mutation when prior lease is active; allows takeover when lease expired', async () => {
  let activeOwners = new Set(['owner_A']);
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: (req: any) => req.headers['x-test-owner'] || null,
    validateOwnerLease: (owner: string) => activeOwners.has(owner),
  };
  const push = createWebPush({ webAuth: mockWebAuth, config: VALID_VAPID_CONFIG });

  // 1. Owner A registers
  const req1 = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-owner': 'owner_A' },
    body: { subscription: VALID_FCM_SUB, language: 'en' },
  });
  const res1 = new MockResponse();
  await push.handleSubscriptions(req1, res1);
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(parseJson(res1), { ok: true });
  assert.equal(push.getSubscriptionsCount(), 1);

  // 2. Owner B attempts to overwrite while Owner A lease is active -> 403 Forbidden
  const req2 = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-owner': 'owner_B' },
    body: { subscription: VALID_FCM_SUB, language: 'es' },
  });
  const res2 = new MockResponse();
  await push.handleSubscriptions(req2, res2);
  assert.equal(res2.statusCode, 403);
  assert.equal(push.getSubscription(VALID_FCM_SUB.endpoint)?.owner, 'owner_A');

  // 3. Owner A lease expires or logs out
  activeOwners.delete('owner_A');
  activeOwners.add('owner_B');

  // 4. Owner B takes over the endpoint (e.g. login renew on same device) -> Allowed!
  const req3 = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-owner': 'owner_B' },
    body: { subscription: VALID_FCM_SUB, language: 'es' },
  });
  const res3 = new MockResponse();
  await push.handleSubscriptions(req3, res3);
  assert.equal(res3.statusCode, 200);
  assert.equal(push.getSubscription(VALID_FCM_SUB.endpoint)?.owner, 'owner_B');
  assert.equal(push.getSubscription(VALID_FCM_SUB.endpoint)?.language, 'es');
});

test('subscriptions: multiple devices register independently; DELETE removes single endpoint', async () => {
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_multi',
    validateOwnerLease: () => true,
  };
  const push = createWebPush({ webAuth: mockWebAuth, config: VALID_VAPID_CONFIG });

  const subDevice1 = {
    endpoint: 'https://push.services.mozilla.com/push/v1/dev1',
    keys: VALID_FCM_SUB.keys,
  };
  const subDevice2 = {
    endpoint: 'https://web.push.apple.com/dev2',
    keys: VALID_FCM_SUB.keys,
  };

  // Register device 1
  const req1 = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: subDevice1, language: 'en' },
  });
  const res1 = new MockResponse();
  await push.handleSubscriptions(req1, res1);
  assert.equal(res1.statusCode, 200);

  // Register device 2
  const req2 = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: subDevice2, language: 'es' },
  });
  const res2 = new MockResponse();
  await push.handleSubscriptions(req2, res2);
  assert.equal(res2.statusCode, 200);

  assert.equal(push.getSubscriptionsCount(), 2);

  // Delete device 1
  const reqDel = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: { endpoint: subDevice1.endpoint },
  });
  const resDel = new MockResponse();
  await push.handleSubscriptions(reqDel, resDel);
  assert.equal(resDel.statusCode, 200);
  assert.deepEqual(parseJson(resDel), { ok: true });

  assert.equal(push.getSubscriptionsCount(), 1);
  assert.equal(push.getSubscription(subDevice1.endpoint), undefined);
  assert.notEqual(push.getSubscription(subDevice2.endpoint), undefined);
});

// ---------------------------------------------------------------------------
// 4. Origin Naming Hierarchy & Payload Format (S2)
// ---------------------------------------------------------------------------

test('origin naming: prefers customName > Git root basename > folder basename; no paths in payload', async () => {
  const sentPayloads: any[] = [];
  const senderSpy = async (sub: any, payload: string) => {
    sentPayloads.push({ sub, data: JSON.parse(payload) });
  };

  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_origin',
    validateOwnerLease: () => true,
  };

  const push = createWebPush({
    webAuth: mockWebAuth,
    config: VALID_VAPID_CONFIG,
    sendNotification: senderSpy,
    gitResolver: (dir: string) => {
      if (dir.includes('git-project')) return 'repo-basename';
      return null;
    },
  });

  // Register sub with customName mapping for /workspace/custom
  const req = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      subscription: VALID_FCM_SUB,
      language: 'en',
      projects: [{ path: '/workspace/custom', customName: 'My Special Project' }],
    },
  });
  const res = new MockResponse();
  await push.handleSubscriptions(req, res);
  assert.equal(res.statusCode, 200);

  // 1. Matched custom project
  await push.dispatchPushEvent({ type: 'agent_settled', cwd: '/workspace/custom' });
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].data.title, 'Task finished — My Special Project');
  assert.equal(sentPayloads[0].data.body, 'The task has finished');
  assert.equal(sentPayloads[0].data.eventType, 'task_complete');
  assert.equal(sentPayloads[0].data.path, undefined);
  assert.equal(sentPayloads[0].data.cwd, undefined);

  // 2. Git repo fallback
  await push.dispatchPushEvent({ type: 'agent_settled', cwd: '/workspace/git-project/sub' });
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[1].data.title, 'Task finished — repo-basename');

  // 3. Folder fallback
  await push.dispatchPushEvent({ type: 'agent_settled', cwd: '/workspace/plain-folder' });
  assert.equal(sentPayloads.length, 3);
  assert.equal(sentPayloads[2].data.title, 'Task finished — plain-folder');

  // 4. Spanish localization for waiting_input
  const subEs = { endpoint: 'https://web.push.apple.com/es-device', keys: VALID_FCM_SUB.keys };
  const reqEs = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: subEs, language: 'es' },
  });
  await push.handleSubscriptions(reqEs, new MockResponse());

  await push.dispatchPushEvent({ type: 'extension_ui_request', cwd: '/workspace/plain-folder', method: 'confirm' });
  const esPayload = sentPayloads.find((p) => p.sub.endpoint === subEs.endpoint && p.data.eventType === 'waiting_input');
  assert.ok(esPayload);
  assert.equal(esPayload.data.title, 'Esperando tu respuesta — plain-folder');
  assert.equal(esPayload.data.body, 'Pi necesita tu aprobación, respuesta o una acción para continuar');
});

// ---------------------------------------------------------------------------
// 5. RPC Public Event Hook & Delivery Integration (S1, S4)
// ---------------------------------------------------------------------------

test('rpc to sender injection integration: public event triggers synchronous push dispatch; handles 410 gone pruning', async () => {
  const sentPayloads: any[] = [];
  let shouldFailWith410 = false;

  const senderSpy = async (sub: any, payload: string) => {
    if (shouldFailWith410) {
      const err: any = new Error('Subscription expired');
      err.statusCode = 410;
      throw err;
    }
    sentPayloads.push({ endpoint: sub.endpoint, payload });
  };

  let leaseActive = true;
  const mockWebAuth: any = {
    isEnabled: () => true,
    authenticate: () => 'owner_rpc',
    validateOwnerLease: () => leaseActive,
  };

  const push = createWebPush({
    webAuth: mockWebAuth,
    config: VALID_VAPID_CONFIG,
    sendNotification: senderSpy,
  });

  // Register subscription
  const req = new MockRequest({
    url: '/api/push/subscriptions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { subscription: VALID_FCM_SUB, language: 'en' },
  });
  await push.handleSubscriptions(req, new MockResponse());
  assert.equal(push.getSubscriptionsCount(), 1);

  // Hook push to RPC
  const unsubHook = addPushNotificationHook((event) => push.dispatchPushEvent(event));

  // Create PiRpcSession and simulate stdout line for agent_settled
  const session = new PiRpcSession();
  (session as any).handleStdoutLine({
    type: 'agent_end',
    willRetry: false,
  });

  // Allow next microtask for synchronous non-blocking dispatch
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].endpoint, VALID_FCM_SUB.endpoint);

  // Paused when lease inactive
  leaseActive = false;
  (session as any).handleStdoutLine({
    type: 'extension_ui_request',
    method: 'confirm',
    id: 'req-1',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sentPayloads.length, 1, 'Delivery must be paused when lease is invalid');

  // Prune on 410 Gone
  leaseActive = true;
  shouldFailWith410 = true;
  (session as any).handleStdoutLine({
    type: 'agent_end',
    willRetry: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(push.getSubscriptionsCount(), 0, 'Subscription must be pruned on 410 Gone');

  // Clean up
  unsubHook();
  session.kill();
  resetPiRpcForTest();
});
