import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveWebAuthConfig,
  createWebAuth,
  validateSameOrigin,
  DEFAULT_WEB_AUTH_COOKIE_NAME,
} from '@server/bridge/web-auth';

// ---------------------------------------------------------------------------
// Test Mocks
// ---------------------------------------------------------------------------

class MockRequest extends EventEmitter {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
  socket: { encrypted?: boolean; remoteAddress?: string };

  constructor(options: {
    url?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    encrypted?: boolean;
    remoteAddress?: string;
  } = {}) {
    super();
    this.url = options.url || '/api/auth/status';
    this.method = options.method || 'GET';
    this.headers = { ...options.headers };
    this.socket = {
      encrypted: options.encrypted || false,
      remoteAddress: options.remoteAddress || '127.0.0.1',
    };
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

  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

function parseJsonBody(res: MockResponse): any {
  return JSON.parse(res.body || '{}');
}

function extractCookie(res: MockResponse, cookieName: string = DEFAULT_WEB_AUTH_COOKIE_NAME): string | null {
  const setCookie = res.getHeader('set-cookie');
  if (!setCookie) return null;
  const str = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
  const match = str.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

function simulateStreamingBody(req: MockRequest, body: string) {
  process.nextTick(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
}

// ---------------------------------------------------------------------------
// 1. Configuration & Startup Validation
// ---------------------------------------------------------------------------

test('enabled auth blocks case variants and SSE mount suffixes before downstream routing', () => {
  const auth = createWebAuth({ enabled: true, key: 'test-key' });
  try {
    for (const url of ['/API/ipc', '/Api/events', '/api/events.extra', '/api/events/extra']) {
      const req = new MockRequest({ url, headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } });
      const res = new MockResponse();
      let reachedHandler = false;
      auth.middleware(req, res, () => { reachedHandler = true; });
      assert.equal(reachedHandler, false, url);
      assert.ok(res.statusCode >= 400, url);
    }
  } finally { auth.dispose(); }
});

test('resolveWebAuthConfig: defaults to disabled when unset or empty', () => {
  const cfg1 = resolveWebAuthConfig({});
  assert.equal(cfg1.enabled, false);
  assert.equal(cfg1.key, undefined);
  assert.equal(cfg1.secureCookie, false);

  const cfg2 = resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: '' });
  assert.equal(cfg2.enabled, false);

  const cfg3 = resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: 'false' });
  assert.equal(cfg3.enabled, false);
});

test('resolveWebAuthConfig: enables auth with valid key and parses secure cookie flag', () => {
  const cfg = resolveWebAuthConfig({
    PI_VIEWER_AUTH_ENABLED: 'true',
    PI_VIEWER_AUTH_KEY: 'my-super-secret-passphrase',
    PI_VIEWER_AUTH_SECURE_COOKIE: 'true',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.key, 'my-super-secret-passphrase');
  assert.equal(cfg.secureCookie, true);
});

test('resolveWebAuthConfig: fails startup if enabled without nonblank key', () => {
  assert.throws(() => {
    resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: 'true' });
  }, /PI_VIEWER_AUTH_KEY/);

  assert.throws(() => {
    resolveWebAuthConfig({
      PI_VIEWER_AUTH_ENABLED: 'true',
      PI_VIEWER_AUTH_KEY: '   ',
    });
  }, /PI_VIEWER_AUTH_KEY/);
});

test('resolveWebAuthConfig: fails startup if PI_VIEWER_AUTH_ENABLED is not strictly true or false', () => {
  assert.throws(() => {
    resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: '1' });
  }, /strictly "true" or "false"/);

  assert.throws(() => {
    resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: 'yes' });
  }, /strictly "true" or "false"/);

  assert.throws(() => {
    resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: 'TRUE' });
  }, /strictly "true" or "false"/);
});

// ---------------------------------------------------------------------------
// 2. Disabled Mode Behavior
// ---------------------------------------------------------------------------

test('disabled mode: GET /api/auth/status returns { required: false, authenticated: true }', async () => {
  const webAuth = createWebAuth({ enabled: false });
  const req = new MockRequest({
    url: '/api/auth/status',
    method: 'GET',
    headers: { host: 'localhost:5173' },
  });
  const res = new MockResponse();

  let nextCalled = false;
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, false);
  const data = parseJsonBody(res);
  assert.deepEqual(data, { required: false, authenticated: true });
});

test('disabled mode: privileged /api routes pass through unblocked to next()', async () => {
  const webAuth = createWebAuth({ enabled: false });
  const req = new MockRequest({
    url: '/api/ipc',
    method: 'POST',
    headers: { host: 'localhost:5173' },
  });
  const res = new MockResponse();

  let nextCalled = false;
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.ended, false);
});

test('disabled mode: non-api routes pass through unblocked to next()', async () => {
  const webAuth = createWebAuth({ enabled: false });
  const req = new MockRequest({
    url: '/index.html',
    method: 'GET',
    headers: { host: 'localhost:5173' },
  });
  const res = new MockResponse();

  let nextCalled = false;
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

// ---------------------------------------------------------------------------
// 3. Enabled Mode - Bootstrap Auth Routes
// ---------------------------------------------------------------------------

test('enabled mode: GET /api/auth/status returns required=true and authenticated=false unauthenticated', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'valid-secret-key-1' });
  const req = new MockRequest({
    url: '/api/auth/status',
    method: 'GET',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  const res = new MockResponse();

  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});

  assert.equal(res.statusCode, 200);
  const data = parseJsonBody(res);
  assert.deepEqual(data, { required: true, authenticated: false });
});

test('enabled mode: method validation on bootstrap routes returns 405 Method Not Allowed', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'valid-secret-key-1' });

  // POST /api/auth/status -> 405
  const reqStatus = new MockRequest({
    url: '/api/auth/status',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  const resStatus = new MockResponse();
  await webAuth.middleware(reqStatus as unknown as IncomingMessage, resStatus as unknown as ServerResponse, () => {});
  assert.equal(resStatus.statusCode, 405);

  // GET /api/auth/login -> 405
  const reqLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'GET',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  const resLogin = new MockResponse();
  await webAuth.middleware(reqLogin as unknown as IncomingMessage, resLogin as unknown as ServerResponse, () => {});
  assert.equal(resLogin.statusCode, 405);

  // GET /api/auth/logout -> 405
  const reqLogout = new MockRequest({
    url: '/api/auth/logout',
    method: 'GET',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  const resLogout = new MockResponse();
  await webAuth.middleware(reqLogout as unknown as IncomingMessage, resLogout as unknown as ServerResponse, () => {});
  assert.equal(resLogout.statusCode, 405);
});

test('enabled mode: POST /api/auth/login with correct key succeeds and sets HttpOnly SameSite=Strict cookie', async () => {
  const webAuth = createWebAuth({
    enabled: true,
    key: 'correct-secret-123',
    secureCookie: false,
  });
  const req = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
    },
  });
  const res = new MockResponse();

  simulateStreamingBody(req, JSON.stringify({ key: 'correct-secret-123' }));
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});

  assert.equal(res.statusCode, 200);
  const data = parseJsonBody(res);
  assert.deepEqual(data, { ok: true });

  const setCookie = String(res.getHeader('set-cookie'));
  assert.ok(setCookie.includes(`${DEFAULT_WEB_AUTH_COOKIE_NAME}=`));
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('SameSite=Strict'));
  assert.ok(setCookie.includes('Path=/api'));
  assert.ok(!setCookie.includes('Secure')); // not secure
});

test('enabled mode: POST /api/auth/login with explicit secureCookie=true sets Secure flag without trusting X-Forwarded-Proto', async () => {
  const webAuth = createWebAuth({
    enabled: true,
    key: 'correct-secret-123',
    secureCookie: true,
  });
  const req = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
      'x-forwarded-proto': 'http', // must not override explicit secure setting
    },
  });
  const res = new MockResponse();

  simulateStreamingBody(req, JSON.stringify({ key: 'correct-secret-123' }));
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});

  assert.equal(res.statusCode, 200);
  const setCookie = String(res.getHeader('set-cookie'));
  assert.ok(setCookie.includes('Secure'));
});

test('enabled mode: POST /api/auth/login rejects wrong key with 401 without leaking secret', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'super-sensitive-master-key' });
  const req = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
    },
  });
  const res = new MockResponse();

  simulateStreamingBody(req, JSON.stringify({ key: 'wrong-guess' }));
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});

  assert.equal(res.statusCode, 401);
  const data = parseJsonBody(res);
  assert.ok(data.error);
  assert.ok(!data.error.includes('super-sensitive-master-key'));
});

test('enabled mode: POST /api/auth/login rejects missing or blank key with 400', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret-key' });

  // Missing key field
  const req1 = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const res1 = new MockResponse();
  simulateStreamingBody(req1, JSON.stringify({}));
  await webAuth.middleware(req1 as unknown as IncomingMessage, res1 as unknown as ServerResponse, () => {});
  assert.equal(res1.statusCode, 400);

  // Blank key string
  const req2 = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const res2 = new MockResponse();
  simulateStreamingBody(req2, JSON.stringify({ key: '   ' }));
  await webAuth.middleware(req2 as unknown as IncomingMessage, res2 as unknown as ServerResponse, () => {});
  assert.equal(res2.statusCode, 400);
});

test('enabled mode: POST /api/auth/login rejects malformed JSON with 400', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret-key' });
  const req = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const res = new MockResponse();
  simulateStreamingBody(req, 'not-valid-json{{{');
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});
  assert.equal(res.statusCode, 400);
});

test('enabled mode: POST /api/auth/login rejects oversized body with 413 Payload Too Large', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret-key' });
  const req = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const res = new MockResponse();
  const oversizedPayload = JSON.stringify({ key: 'a'.repeat(9000) });
  simulateStreamingBody(req, oversizedPayload);
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});
  assert.equal(res.statusCode, 413);
});

test('enabled mode: POST /api/auth/login rate limits failed attempts with 429', async () => {
  const webAuth = createWebAuth({
    enabled: true,
    key: 'ratelimit-target-key',
    rateLimitMaxAttempts: 3,
    rateLimitWindowMs: 60000,
  });

  for (let i = 0; i < 3; i++) {
    const req = new MockRequest({
      url: '/api/auth/login',
      method: 'POST',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
    });
    const res = new MockResponse();
    simulateStreamingBody(req, JSON.stringify({ key: 'bad-key' }));
    await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});
    assert.equal(res.statusCode, 401);
  }

  // 4th attempt is rate-limited even with the correct key
  const reqBlocked = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resBlocked = new MockResponse();
  simulateStreamingBody(reqBlocked, JSON.stringify({ key: 'ratelimit-target-key' }));
  await webAuth.middleware(reqBlocked as unknown as IncomingMessage, resBlocked as unknown as ServerResponse, () => {});
  assert.equal(resBlocked.statusCode, 429);
});

test('enabled mode: POST /api/auth/login rejects cross-origin request with 403', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'secret-key' });
  const req = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://malicious.evil.com',
      'content-type': 'application/json',
    },
  });
  const res = new MockResponse();
  simulateStreamingBody(req, JSON.stringify({ key: 'secret-key' }));
  await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});
  assert.equal(res.statusCode, 403);
});

test('enabled mode: authenticated status and logout lifecycle', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'lifecycle-key' });

  // 1. Login
  const reqLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resLogin = new MockResponse();
  simulateStreamingBody(reqLogin, JSON.stringify({ key: 'lifecycle-key' }));
  await webAuth.middleware(reqLogin as unknown as IncomingMessage, resLogin as unknown as ServerResponse, () => {});
  assert.equal(resLogin.statusCode, 200);

  const token = extractCookie(resLogin);
  assert.ok(token);

  // 2. GET /api/auth/status with cookie
  const reqStatus = new MockRequest({
    url: '/api/auth/status',
    method: 'GET',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resStatus = new MockResponse();
  await webAuth.middleware(reqStatus as unknown as IncomingMessage, resStatus as unknown as ServerResponse, () => {});
  assert.equal(resStatus.statusCode, 200);
  assert.deepEqual(parseJsonBody(resStatus), { required: true, authenticated: true });

  // 3. POST /api/auth/logout with cookie
  const reqLogout = new MockRequest({
    url: '/api/auth/logout',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resLogout = new MockResponse();
  await webAuth.middleware(reqLogout as unknown as IncomingMessage, resLogout as unknown as ServerResponse, () => {});
  assert.equal(resLogout.statusCode, 200);
  assert.deepEqual(parseJsonBody(resLogout), { ok: true });
  const clearCookie = String(resLogout.getHeader('set-cookie'));
  assert.ok(clearCookie.includes('Max-Age=0'));

  // 4. Status is now unauthenticated
  const reqStatusAfter = new MockRequest({
    url: '/api/auth/status',
    method: 'GET',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resStatusAfter = new MockResponse();
  await webAuth.middleware(reqStatusAfter as unknown as IncomingMessage, resStatusAfter as unknown as ServerResponse, () => {});
  assert.equal(resStatusAfter.statusCode, 200);
  assert.deepEqual(parseJsonBody(resStatusAfter), { required: true, authenticated: false });
});

// ---------------------------------------------------------------------------
// 4. Privileged /api Routes Protection & Strict Path Matching
// ---------------------------------------------------------------------------

test('enabled mode: protects privileged API endpoints (/api/ipc, /api/events, /api/oauth/authorize, /api/engram-daemon) with 401 when unauthenticated', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'privileged-guard-key' });
  const protectedPaths = [
    '/api/ipc',
    '/api/events',
    '/api/oauth/authorize',
    '/api/engram-daemon',
    '/api/engram-daemon/observations',
  ];

  for (const path of protectedPaths) {
    const req = new MockRequest({
      url: path,
      method: 'POST',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
    });
    const res = new MockResponse();
    let nextCalled = false;
    await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {
      nextCalled = true;
    });

    assert.equal(res.statusCode, 401, `Expected 401 for unauthenticated ${path}`);
    assert.equal(nextCalled, false, `next() must not be called for unauthenticated ${path}`);
  }
});

test('enabled mode: prevents prefix matching bypass (/api/auth/login/evil) and rejects unauthenticated request with 401', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'prefix-bypass-key' });
  const evilPaths = [
    '/api/auth/login/evil',
    '/api/auth/login/../../ipc',
    '/api/auth/status/evil',
    '/api/auth/logout/evil',
    '/api/auth/login%2fevil',
    '/api/auth/login.json',
    '/api/auth/login;params',
  ];

  for (const evilPath of evilPaths) {
    const req = new MockRequest({
      url: evilPath,
      method: 'POST',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
    });
    const res = new MockResponse();
    let nextCalled = false;
    await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {
      nextCalled = true;
    });

    assert.equal(res.statusCode, 401, `Path ${evilPath} must not bypass auth`);
    assert.equal(nextCalled, false);
  }
});

test('enabled mode: path normalization handles query parameters and trailing slashes for legitimate login without bypass', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'norm-key' });

  // Legitimate login with query string
  const reqWithQuery = new MockRequest({
    url: '/api/auth/login?source=web',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resWithQuery = new MockResponse();
  simulateStreamingBody(reqWithQuery, JSON.stringify({ key: 'norm-key' }));
  await webAuth.middleware(reqWithQuery as unknown as IncomingMessage, resWithQuery as unknown as ServerResponse, () => {});
  assert.equal(resWithQuery.statusCode, 200);

  // Legitimate login with trailing slash
  const reqWithSlash = new MockRequest({
    url: '/api/auth/login/',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resWithSlash = new MockResponse();
  simulateStreamingBody(reqWithSlash, JSON.stringify({ key: 'norm-key' }));
  await webAuth.middleware(reqWithSlash as unknown as IncomingMessage, resWithSlash as unknown as ServerResponse, () => {});
  assert.equal(resWithSlash.statusCode, 200);
});

test('enabled mode: enforces same-origin on privileged API calls for authenticated users', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'same-origin-key' });

  // 1. Login
  const reqLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resLogin = new MockResponse();
  simulateStreamingBody(reqLogin, JSON.stringify({ key: 'same-origin-key' }));
  await webAuth.middleware(reqLogin as unknown as IncomingMessage, resLogin as unknown as ServerResponse, () => {});
  const token = extractCookie(resLogin)!;

  // 2. Authenticated request with mismatched origin returns 403
  const reqEvil = new MockRequest({
    url: '/api/ipc',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://evil-attacker.com',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resEvil = new MockResponse();
  let nextEvil = false;
  await webAuth.middleware(reqEvil as unknown as IncomingMessage, resEvil as unknown as ServerResponse, () => {
    nextEvil = true;
  });
  assert.equal(resEvil.statusCode, 403);
  assert.equal(nextEvil, false);

  // 3. Authenticated request with valid origin proceeds to next()
  const reqGood = new MockRequest({
    url: '/api/ipc',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resGood = new MockResponse();
  let nextGood = false;
  await webAuth.middleware(reqGood as unknown as IncomingMessage, resGood as unknown as ServerResponse, () => {
    nextGood = true;
  });
  assert.equal(nextGood, true);
  assert.equal(resGood.ended, false);
});

test('validateSameOrigin helper: verifies Host matching Origin, Referer, and Sec-Fetch-Site', () => {
  // Matching origin
  assert.equal(
    validateSameOrigin({ headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } }),
    true
  );

  // Mismatched origin
  assert.equal(
    validateSameOrigin({ headers: { host: 'localhost:5173', origin: 'http://evil.com' } }),
    false
  );

  // Missing host fails closed
  assert.equal(
    validateSameOrigin({ headers: { origin: 'http://localhost:5173' } }),
    false
  );

  // Matching referer
  assert.equal(
    validateSameOrigin({ headers: { host: 'viewer.internal:8080', referer: 'https://viewer.internal:8080/chat' } }),
    true
  );

  // Mismatched referer
  assert.equal(
    validateSameOrigin({ headers: { host: 'viewer.internal:8080', referer: 'https://evil.internal:8080/chat' } }),
    false
  );

  // Sec-fetch-site same-origin
  assert.equal(
    validateSameOrigin({ headers: { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' } }),
    true
  );

  // Cross-site sec-fetch-site fails closed
  assert.equal(
    validateSameOrigin({ headers: { host: 'localhost:5173', 'sec-fetch-site': 'cross-site' } }),
    false
  );
});

// ---------------------------------------------------------------------------
// 5. Streaming Leases & SSE Termination
// ---------------------------------------------------------------------------

test('streaming leases: cap per-owner streams and terminate evicted owners', async () => {
  const auth = createWebAuth({ enabled: true, key: 'bounded-key', maxSessions: 1 });
  const headers = { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' };
  try {
    const loginRes = new MockResponse();
    await auth.handleLogin(new MockRequest({ method: 'POST', headers }), loginRes, { key: 'bounded-key' });
    const token = extractCookie(loginRes)!;
    const streams: MockResponse[] = [];
    for (let i = 0; i < 9; i++) {
      const res = new MockResponse();
      auth.middleware(new MockRequest({ url: '/api/events', headers: { ...headers, cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}` } }), res, () => {});
      streams.push(res);
    }
    assert.equal(auth.getActiveSseCount(), 8);
    assert.equal(streams[8].statusCode, 429);
    await auth.handleLogin(new MockRequest({ method: 'POST', headers }), new MockResponse(), { key: 'bounded-key' });
    assert.equal(auth.getActiveSseCount(), 0);
    assert.ok(streams.slice(0, 8).every(res => res.ended));
  } finally { auth.dispose(); }
});

test('streaming leases: active SSE streams terminate on session logout and clean up timers', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'sse-stream-key' });

  // Login
  const reqLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resLogin = new MockResponse();
  simulateStreamingBody(reqLogin, JSON.stringify({ key: 'sse-stream-key' }));
  await webAuth.middleware(reqLogin as unknown as IncomingMessage, resLogin as unknown as ServerResponse, () => {});
  const token = extractCookie(resLogin)!;

  // Connect to SSE (/api/events)
  const reqSse = new MockRequest({
    url: '/api/events',
    method: 'GET',
    headers: {
      host: 'localhost:5173',
      'sec-fetch-site': 'same-origin',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resSse = new MockResponse();
  let sseNextCalled = false;
  await webAuth.middleware(reqSse as unknown as IncomingMessage, resSse as unknown as ServerResponse, () => {
    sseNextCalled = true;
  });
  assert.equal(sseNextCalled, true);
  assert.equal(resSse.ended, false);
  assert.equal(webAuth.getActiveSseCount(), 1);

  // Logout must terminate the active SSE stream
  const reqLogout = new MockRequest({
    url: '/api/auth/logout',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resLogout = new MockResponse();
  await webAuth.middleware(reqLogout as unknown as IncomingMessage, resLogout as unknown as ServerResponse, () => {});

  assert.equal(resLogout.statusCode, 200);
  assert.equal(resSse.ended, true, 'SSE stream must be terminated on logout');
  assert.equal(webAuth.getActiveSseCount(), 0, 'Active SSE count must be 0 after logout');
});

test('streaming leases: active SSE streams terminate on session expiration and clean up timers', async () => {
  let currentTime = 1_000_000;
  const webAuth = createWebAuth({
    enabled: true,
    key: 'sse-expiry-key',
    sessionTtlMs: 50_000,
    now: () => currentTime,
  });

  // Login
  const reqLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resLogin = new MockResponse();
  simulateStreamingBody(reqLogin, JSON.stringify({ key: 'sse-expiry-key' }));
  await webAuth.middleware(reqLogin as unknown as IncomingMessage, resLogin as unknown as ServerResponse, () => {});
  const token = extractCookie(resLogin)!;

  // Connect to SSE
  const reqSse = new MockRequest({
    url: '/api/events',
    method: 'GET',
    headers: {
      host: 'localhost:5173',
      'sec-fetch-site': 'same-origin',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resSse = new MockResponse();
  await webAuth.middleware(reqSse as unknown as IncomingMessage, resSse as unknown as ServerResponse, () => {});
  assert.equal(resSse.ended, false);
  assert.equal(webAuth.getActiveSseCount(), 1);

  // Advance time past expiration
  currentTime += 55_000;
  webAuth.pruneExpired(currentTime);

  assert.equal(resSse.ended, true, 'SSE stream must be terminated after session expiration');
  assert.equal(webAuth.getActiveSseCount(), 0);
});

test('streaming leases: client disconnect cleans up timer and SSE tracking without leaks', async () => {
  const webAuth = createWebAuth({ enabled: true, key: 'sse-disconnect-key' });

  // Login
  const reqLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resLogin = new MockResponse();
  simulateStreamingBody(reqLogin, JSON.stringify({ key: 'sse-disconnect-key' }));
  await webAuth.middleware(reqLogin as unknown as IncomingMessage, resLogin as unknown as ServerResponse, () => {});
  const token = extractCookie(resLogin)!;

  // Connect SSE
  const reqSse = new MockRequest({
    url: '/api/events',
    method: 'GET',
    headers: {
      host: 'localhost:5173',
      'sec-fetch-site': 'same-origin',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${token}`,
    },
  });
  const resSse = new MockResponse();
  await webAuth.middleware(reqSse as unknown as IncomingMessage, resSse as unknown as ServerResponse, () => {});
  assert.equal(webAuth.getActiveSseCount(), 1);

  // Client disconnects (closes tab)
  reqSse.emit('close');
  assert.equal(webAuth.getActiveSseCount(), 0);

  webAuth.dispose();
});

// ---------------------------------------------------------------------------
// 6. Resource Bounding & SSE OAuth Owner Isolation
// ---------------------------------------------------------------------------

test('resource bounding: bounds sessions to maxSessions and evicts oldest', async () => {
  let currentTime = 1000;
  const webAuth = createWebAuth({
    enabled: true,
    key: 'capacity-key',
    maxSessions: 3,
    now: () => currentTime,
  });

  const tokens: string[] = [];
  for (let i = 0; i < 4; i++) {
    currentTime += 1000;
    const req = new MockRequest({
      url: '/api/auth/login',
      method: 'POST',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
      remoteAddress: `127.0.0.${i + 1}`,
    });
    const res = new MockResponse();
    simulateStreamingBody(req, JSON.stringify({ key: 'capacity-key' }));
    await webAuth.middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {});
    assert.equal(res.statusCode, 200);
    tokens.push(extractCookie(res)!);
  }

  assert.equal(webAuth.getSessionsCount(), 3, 'Sessions must be bounded to maxSessions');

  // Oldest token (tokens[0]) should have been evicted
  const reqOld = new MockRequest({
    url: '/api/ipc',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${tokens[0]}`,
    },
  });
  const resOld = new MockResponse();
  let nextOld = false;
  await webAuth.middleware(reqOld as unknown as IncomingMessage, resOld as unknown as ServerResponse, () => {
    nextOld = true;
  });
  assert.equal(resOld.statusCode, 401, 'Oldest session must be evicted and unauthorized');
  assert.equal(nextOld, false);

  // Newest token (tokens[3]) should still be valid
  const reqNew = new MockRequest({
    url: '/api/ipc',
    method: 'POST',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${tokens[3]}`,
    },
  });
  const resNew = new MockResponse();
  let nextNew = false;
  await webAuth.middleware(reqNew as unknown as IncomingMessage, resNew as unknown as ServerResponse, () => {
    nextNew = true;
  });
  assert.equal(nextNew, true, 'Newest session must remain valid');
});

test('SSE OAuth owner isolation: web-auth preserves separate OAuth access owner isolation', async () => {
  const { createOAuthAccess } = await import('@server/bridge/oauth-access');
  const { addSseClient, removeSseClient, broadcastSse } = await import('@server/bridge/sse');

  const webAuth = createWebAuth({ enabled: true, key: 'web-secret' });
  const oauthAccess = createOAuthAccess({ key: 'oauth-secret' });

  // 1. Authenticate with webAuth
  const reqWebLogin = new MockRequest({
    url: '/api/auth/login',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  const resWebLogin = new MockResponse();
  simulateStreamingBody(reqWebLogin, JSON.stringify({ key: 'web-secret' }));
  await webAuth.middleware(reqWebLogin as unknown as IncomingMessage, resWebLogin as unknown as ServerResponse, () => {});
  const webToken = extractCookie(resWebLogin, DEFAULT_WEB_AUTH_COOKIE_NAME)!;

  // 2. Authorize with oauthAccess (separate cookie)
  const reqOAuth = new MockRequest({
    url: '/api/oauth/authorize',
    method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  const resOAuth = new MockResponse();
  const oauthResult = await oauthAccess.authorize(
    reqOAuth as unknown as IncomingMessage,
    resOAuth as unknown as ServerResponse,
    { key: 'oauth-secret' }
  );
  assert.equal(oauthResult.ok, true);
  if (!oauthResult.ok) throw new Error('OAuth auth failed');
  const oauthToken = extractCookie(resOAuth, 'pi_oauth_session')!;

  // 3. Connect to SSE with both cookies present
  const reqSse = new MockRequest({
    url: '/api/events',
    method: 'GET',
    headers: {
      host: 'localhost:5173',
      'sec-fetch-site': 'same-origin',
      cookie: `${DEFAULT_WEB_AUTH_COOKIE_NAME}=${webToken}; pi_oauth_session=${oauthToken}`,
    },
  });
  const resSse = new MockResponse();
  let sseNextCalled = false;
  await webAuth.middleware(reqSse as unknown as IncomingMessage, resSse as unknown as ServerResponse, () => {
    sseNextCalled = true;
  });
  assert.equal(sseNextCalled, true);

  // Existing SSE handler logic
  const oauthOwner = oauthAccess.authenticate(reqSse as unknown as IncomingMessage) ?? undefined;
  assert.equal(oauthOwner, oauthResult.owner);

  addSseClient(resSse as unknown as ServerResponse, oauthOwner, () => Boolean(oauthOwner && oauthAccess.validateOwnerLease(oauthOwner)));

  // Broadcast private OAuth event to this owner
  broadcastSse('pi://oauth-event', { promptId: 'p1' }, oauthOwner);
  assert.ok(resSse.body.includes('pi://oauth-event'));

  // Cleanup
  removeSseClient(resSse as unknown as ServerResponse);
  webAuth.dispose();
});
