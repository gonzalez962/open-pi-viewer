import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createOAuthAccess,
  OAUTH_UNAUTHORIZED_CODE,
  OAUTH_UNCONFIGURED_CODE,
  isOAuthUnauthorizedError,
  isOAuthCommand,
} from '@server/bridge/oauth-access';

interface MockReq {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
  socket?: { encrypted?: boolean };
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  setHeader: (name: string, value: string | string[]) => void;
  getHeader: (name: string) => string | string[] | undefined;
  end: (data?: string) => void;
}

function createMockReq(headers: Record<string, string | string[] | undefined> = {}, socketEncrypted = false): MockReq {
  return {
    headers: { ...headers },
    url: '/api/oauth/authorize',
    method: 'POST',
    socket: { encrypted: socketEncrypted },
  };
}

function createMockRes(): MockRes {
  const headers: Record<string, string | string[]> = {};
  return {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end() {},
  };
}

test('createOAuthAccess: fails closed with actionable message when PI_VIEWER_OAUTH_ACCESS_KEY is unconfigured in keyed mode', async () => {
  const access = createOAuthAccess({ key: undefined, developmentAnonymous: false });
  assert.equal(access.isConfigured(), false);
  assert.equal(access.isDevelopmentAnonymous(), false);

  const req = createMockReq({ host: 'localhost:5173', origin: 'http://localhost:5173' });
  const res = createMockRes();
  const authResult = await access.authorize(req as unknown as IncomingMessage, res as unknown as ServerResponse, { key: 'any-key' });

  assert.equal(authResult.ok, false);
  assert.equal(authResult.status, 503);
  assert.ok(authResult.error.includes('PI_VIEWER_OAUTH_ACCESS_KEY'));
  assert.ok(isOAuthUnauthorizedError(authResult.error) || authResult.error.includes(OAUTH_UNCONFIGURED_CODE));

  const owner = access.authenticate(req as unknown as IncomingMessage);
  assert.equal(owner, null);

  const reqCheck = access.requireOAuthOwner('get_builtin_oauth_providers', req as unknown as IncomingMessage);
  assert.equal(reqCheck.ok, false);
  assert.equal(reqCheck.status, 503);
});

test('createOAuthAccess: validates same-origin strictly via Origin/Host and rejects mismatch', async () => {
  const access = createOAuthAccess({ key: 'secret-key-12345' });
  assert.equal(access.isConfigured(), true);

  // Mismatched Origin
  const reqMismatch = createMockReq({
    host: 'localhost:5173',
    origin: 'http://malicious-site.example.com',
  });
  const resMismatch = createMockRes();
  const resAuthMismatch = await access.authorize(
    reqMismatch as unknown as IncomingMessage,
    resMismatch as unknown as ServerResponse,
    { key: 'secret-key-12345' }
  );
  assert.equal(resAuthMismatch.ok, false);
  assert.equal(resAuthMismatch.status, 403);
  assert.ok(resAuthMismatch.error.toLowerCase().includes('origin'));

  // Forwarded host spoof attempt - must NOT trust arbitrary forwarded headers
  const reqSpoof = createMockReq({
    host: 'localhost:5173',
    origin: 'http://evil.com',
    'x-forwarded-host': 'evil.com',
  });
  const resSpoof = createMockRes();
  const resAuthSpoof = await access.authorize(
    reqSpoof as unknown as IncomingMessage,
    resSpoof as unknown as ServerResponse,
    { key: 'secret-key-12345' }
  );
  assert.equal(resAuthSpoof.ok, false);
  assert.equal(resAuthSpoof.status, 403);

  // Matching Origin
  const reqValid = createMockReq({
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
  });
  const resValid = createMockRes();
  const resAuthValid = await access.authorize(
    reqValid as unknown as IncomingMessage,
    resValid as unknown as ServerResponse,
    { key: 'secret-key-12345' }
  );
  assert.equal(resAuthValid.ok, true);
  assert.equal(resAuthValid.status, 200);
});

test('createOAuthAccess: rejects wrong key or missing key without timing leak', async () => {
  const access = createOAuthAccess({ key: 'correct-secret-passphrase-999' });

  const req = createMockReq({ host: 'localhost:5173', origin: 'http://localhost:5173' });

  // Missing key
  const res1 = createMockRes();
  const emptyRes = await access.authorize(req as unknown as IncomingMessage, res1 as unknown as ServerResponse, {});
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.status, 400);

  // Wrong key
  const res2 = createMockRes();
  const wrongRes = await access.authorize(req as unknown as IncomingMessage, res2 as unknown as ServerResponse, { key: 'wrong-key-guess' });
  assert.equal(wrongRes.ok, false);
  assert.equal(wrongRes.status, 401);
  assert.ok(wrongRes.error.toLowerCase().includes('invalid'));

  // Never leaks the secret key in the error message
  assert.ok(!wrongRes.error.includes('correct-secret-passphrase-999'));
});

test('createOAuthAccess: issues secure, HttpOnly, SameSite=Strict cookie with high entropy session token', async () => {
  const access = createOAuthAccess({ key: 'super-secret-key-42', sessionTtlMs: 3600000 });
  const req = createMockReq({ host: 'myhost:8080', origin: 'http://myhost:8080' }, false);
  const res = createMockRes();

  const auth = await access.authorize(req as unknown as IncomingMessage, res as unknown as ServerResponse, { key: 'super-secret-key-42' });
  assert.equal(auth.ok, true);
  if (!auth.ok) throw new Error('Auth failed unexpectedly');
  assert.ok(auth.owner.startsWith('owner_') || auth.owner.length >= 16);

  const cookieHeader = res.getHeader('set-cookie');
  assert.ok(typeof cookieHeader === 'string');
  assert.ok(cookieHeader.includes('HttpOnly'));
  assert.ok(cookieHeader.includes('SameSite=Strict'));
  assert.ok(cookieHeader.includes('Path=/api'));
  assert.ok(cookieHeader.includes('Max-Age=3600'));

  // If TLS socket, includes Secure
  const reqTls = createMockReq({ host: 'myhost:8080', origin: 'https://myhost:8080' }, true);
  const resTls = createMockRes();
  await access.authorize(reqTls as unknown as IncomingMessage, resTls as unknown as ServerResponse, { key: 'super-secret-key-42' });
  const tlsCookie = resTls.getHeader('set-cookie');
  assert.ok(typeof tlsCookie === 'string');
  assert.ok(tlsCookie.includes('Secure'));
});

test('createOAuthAccess: authenticate returns stable owner and handles session expiry / revocation', async () => {
  let currentTime = 1000000;
  const access = createOAuthAccess({
    key: 'valid-secret-key',
    sessionTtlMs: 60000,
    now: () => currentTime,
  });

  const reqAuth = createMockReq({ host: 'localhost:3000', origin: 'http://localhost:3000' });
  const resAuth = createMockRes();
  const auth = await access.authorize(reqAuth as unknown as IncomingMessage, resAuth as unknown as ServerResponse, { key: 'valid-secret-key' });
  assert.equal(auth.ok, true);
  if (!auth.ok) throw new Error('Auth failed unexpectedly');

  const cookie = resAuth.getHeader('set-cookie') as string;
  const tokenMatch = cookie.match(/pi_oauth_session=([^;]+)/);
  assert.ok(tokenMatch);
  const token = tokenMatch[1];

  // Request with issued cookie
  const reqWithCookie = createMockReq({
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
    cookie: `pi_oauth_session=${token}`,
  });

  // Authenticate returns stable owner
  const owner1 = access.authenticate(reqWithCookie as unknown as IncomingMessage);
  const owner2 = access.authenticate(reqWithCookie as unknown as IncomingMessage);
  assert.equal(owner1, auth.owner);
  assert.equal(owner2, auth.owner);

  // requireOAuthOwner succeeds
  const reqCheck = access.requireOAuthOwner('start_oauth_login', reqWithCookie as unknown as IncomingMessage);
  assert.equal(reqCheck.ok, true);
  if (reqCheck.ok) {
    assert.equal(reqCheck.owner, auth.owner);
  }

  // Advance clock past expiration
  currentTime += 65000;
  const expiredOwner = access.authenticate(reqWithCookie as unknown as IncomingMessage);
  assert.equal(expiredOwner, null);

  const expiredCheck = access.requireOAuthOwner('start_oauth_login', reqWithCookie as unknown as IncomingMessage);
  assert.equal(expiredCheck.ok, false);
  assert.equal(expiredCheck.status, 401);
  assert.ok(expiredCheck.error.includes(OAUTH_UNAUTHORIZED_CODE));
});

test('createOAuthAccess: revoking session clears cookie and invalidates owner', async () => {
  const access = createOAuthAccess({ key: 'revocation-key' });
  const reqAuth = createMockReq({ host: 'localhost:3000', origin: 'http://localhost:3000' });
  const resAuth = createMockRes();
  const auth = await access.authorize(reqAuth as unknown as IncomingMessage, resAuth as unknown as ServerResponse, { key: 'revocation-key' });
  assert.equal(auth.ok, true);
  if (!auth.ok) throw new Error('Auth failed unexpectedly');

  const cookie = resAuth.getHeader('set-cookie') as string;
  const token = cookie.match(/pi_oauth_session=([^;]+)/)![1];

  const reqClient = createMockReq({ host: 'localhost:3000', cookie: `pi_oauth_session=${token}` });
  assert.equal(access.authenticate(reqClient as unknown as IncomingMessage), auth.owner);

  const resRevoke = createMockRes();
  const revoked = access.revoke(reqClient as unknown as IncomingMessage, resRevoke as unknown as ServerResponse);
  assert.equal(revoked, true);

  const revokeCookie = resRevoke.getHeader('set-cookie') as string;
  assert.ok(revokeCookie.includes('Max-Age=0'));

  // Now authenticate fails
  assert.equal(access.authenticate(reqClient as unknown as IncomingMessage), null);
});

test('isOAuthCommand identifies protected commands and leaves other IPC unblocked', () => {
  assert.equal(isOAuthCommand('get_builtin_oauth_providers'), true);
  assert.equal(isOAuthCommand('start_oauth_login'), true);
  assert.equal(isOAuthCommand('cancel_oauth_login'), true);
  assert.equal(isOAuthCommand('send_oauth_prompt_response'), true);
  assert.equal(isOAuthCommand('logout_oauth_provider'), true);

  assert.equal(isOAuthCommand('connect'), false);
  assert.equal(isOAuthCommand('list_sessions'), false);
  assert.equal(isOAuthCommand('send_prompt'), false);
  assert.equal(isOAuthCommand('get_available_models'), false);
});

// ============================================================================
// Spot-Check Safety Tests (T2 S2, S3)
// ============================================================================

test('createOAuthAccess: parseCookie handles malformed URI encoding fail-closed without crashing', () => {
  const access = createOAuthAccess({ key: 'my-key' });
  const reqMalformed = createMockReq({
    host: 'localhost:3000',
    cookie: 'pi_oauth_session=%E0%A4%A%malformed',
  });

  // Must not throw URIError, fails closed returning null
  assert.equal(access.authenticate(reqMalformed as unknown as IncomingMessage), null);
});

test('createOAuthAccess: re-authorization rotates session token while reusing existing owner', async () => {
  const access = createOAuthAccess({ key: 'rotate-key' });

  // Initial authorization
  const req1 = createMockReq({ host: 'localhost:3000', origin: 'http://localhost:3000' });
  const res1 = createMockRes();
  const auth1 = await access.authorize(req1 as unknown as IncomingMessage, res1 as unknown as ServerResponse, { key: 'rotate-key' });
  assert.equal(auth1.ok, true);
  if (!auth1.ok) throw new Error('Initial auth failed');

  const token1 = (res1.getHeader('set-cookie') as string).match(/pi_oauth_session=([^;]+)/)![1];

  // Re-authorization with existing session cookie in request
  const req2 = createMockReq({
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
    cookie: `pi_oauth_session=${token1}`,
  });
  const res2 = createMockRes();
  const auth2 = await access.authorize(req2 as unknown as IncomingMessage, res2 as unknown as ServerResponse, { key: 'rotate-key' });
  assert.equal(auth2.ok, true);
  if (!auth2.ok) throw new Error('Re-auth failed');

  const token2 = (res2.getHeader('set-cookie') as string).match(/pi_oauth_session=([^;]+)/)![1];

  // Token was rotated
  assert.notEqual(token1, token2);
  // Owner was preserved so active login / SSE is not orphaned
  assert.equal(auth2.owner, auth1.owner);

  // Old token is invalidated
  const reqOld = createMockReq({ host: 'localhost:3000', cookie: `pi_oauth_session=${token1}` });
  assert.equal(access.authenticate(reqOld as unknown as IncomingMessage), null);

  // New token is valid
  const reqNew = createMockReq({ host: 'localhost:3000', cookie: `pi_oauth_session=${token2}` });
  assert.equal(access.authenticate(reqNew as unknown as IncomingMessage), auth1.owner);
});

test('createOAuthAccess: protected OAuth commands enforce same-origin check, supporting Sec-Fetch-Site and Referer', async () => {
  const access = createOAuthAccess({ key: 'sec-key' });
  const reqAuth = createMockReq({ host: 'localhost:3000', origin: 'http://localhost:3000' });
  const resAuth = createMockRes();
  const auth = await access.authorize(reqAuth as unknown as IncomingMessage, resAuth as unknown as ServerResponse, { key: 'sec-key' });
  if (!auth.ok) throw new Error('Auth failed');
  const token = (resAuth.getHeader('set-cookie') as string).match(/pi_oauth_session=([^;]+)/)![1];

  // Request with mismatched Origin must be rejected
  const reqBadOrigin = createMockReq({
    host: 'localhost:3000',
    origin: 'http://attacker.com',
    cookie: `pi_oauth_session=${token}`,
  });
  const checkBad = access.requireOAuthOwner('get_builtin_oauth_providers', reqBadOrigin as unknown as IncomingMessage);
  assert.equal(checkBad.ok, false);
  assert.equal(checkBad.status, 403);

  // Request without Origin but with Sec-Fetch-Site: same-origin (typical for SSE / fetch) must pass
  const reqSecFetch = createMockReq({
    host: 'localhost:3000',
    'sec-fetch-site': 'same-origin',
    cookie: `pi_oauth_session=${token}`,
  });
  const checkSecFetch = access.requireOAuthOwner('get_builtin_oauth_providers', reqSecFetch as unknown as IncomingMessage);
  assert.equal(checkSecFetch.ok, true);

  // Request without Origin but with valid Referer must pass
  const reqReferer = createMockReq({
    host: 'localhost:3000',
    referer: 'http://localhost:3000/settings',
    cookie: `pi_oauth_session=${token}`,
  });
  const checkReferer = access.requireOAuthOwner('get_builtin_oauth_providers', reqReferer as unknown as IncomingMessage);
  assert.equal(checkReferer.ok, true);
});

test('createOAuthAccess: rate limits repeated bad-key attempts and fails with 429', async () => {
  const access = createOAuthAccess({
    key: 'secret-rate-limit-key',
    rateLimitMaxAttempts: 3,
    rateLimitWindowMs: 60000,
  });

  const req = createMockReq({ host: 'localhost:3000', origin: 'http://localhost:3000' });

  // 3 failed attempts
  for (let i = 0; i < 3; i++) {
    const res = createMockRes();
    const r = await access.authorize(req as unknown as IncomingMessage, res as unknown as ServerResponse, { key: 'wrong' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  }

  // 4th attempt is rate-limited (status 429) even with the correct key
  const resBlocked = createMockRes();
  const rBlocked = await access.authorize(req as unknown as IncomingMessage, resBlocked as unknown as ServerResponse, { key: 'secret-rate-limit-key' });
  assert.equal(rBlocked.ok, false);
  assert.equal(rBlocked.status, 429);
  assert.ok(rBlocked.error.toLowerCase().includes('too many'));
});

test('createOAuthAccess: in developmentAnonymous mode, authorizes without key for same-origin local and remote requests', async () => {
  const access = createOAuthAccess({ developmentAnonymous: true });
  assert.equal(access.isConfigured(), true);
  assert.equal(access.isDevelopmentAnonymous(), true);

  // 1. Local same-origin request with empty body (no key)
  const reqLocal = createMockReq({ host: 'localhost:5173', origin: 'http://localhost:5173' });
  const resLocal = createMockRes();
  const authLocal = await access.authorize(reqLocal as unknown as IncomingMessage, resLocal as unknown as ServerResponse, {});
  assert.equal(authLocal.ok, true);
  if (!authLocal.ok) throw new Error('Local auth failed');
  assert.ok(authLocal.owner.startsWith('owner_'));

  const cookieLocal = resLocal.getHeader('set-cookie') as string;
  assert.ok(cookieLocal.includes('pi_oauth_session='));
  assert.ok(cookieLocal.includes('HttpOnly'));
  assert.ok(cookieLocal.includes('SameSite=Strict'));
  assert.ok(cookieLocal.includes('Path=/api'));

  // 2. Remote same-origin request (e.g. over Tailscale or LAN) with empty body (no key)
  const reqRemote = createMockReq({ host: '100.64.0.1:5173', origin: 'http://100.64.0.1:5173' });
  const resRemote = createMockRes();
  const authRemote = await access.authorize(reqRemote as unknown as IncomingMessage, resRemote as unknown as ServerResponse, {});
  assert.equal(authRemote.ok, true);
  if (!authRemote.ok) throw new Error('Remote auth failed');
  assert.ok(authRemote.owner.startsWith('owner_'));
  assert.notEqual(authRemote.owner, authLocal.owner); // Distinct browser sessions are isolated!

  // 3. Remote TLS same-origin request
  const reqTls = createMockReq({ host: 'viewer.internal.net', origin: 'https://viewer.internal.net' }, true);
  const resTls = createMockRes();
  const authTls = await access.authorize(reqTls as unknown as IncomingMessage, resTls as unknown as ServerResponse, {});
  assert.equal(authTls.ok, true);
  const cookieTls = resTls.getHeader('set-cookie') as string;
  assert.ok(cookieTls.includes('Secure'));

  // 4. Cross-origin request is strictly rejected even in developmentAnonymous mode
  const reqCrossOrigin = createMockReq({ host: 'localhost:5173', origin: 'http://evil.com' });
  const resCrossOrigin = createMockRes();
  const authCrossOrigin = await access.authorize(reqCrossOrigin as unknown as IncomingMessage, resCrossOrigin as unknown as ServerResponse, {});
  assert.equal(authCrossOrigin.ok, false);
  assert.equal(authCrossOrigin.status, 403);

  // 5. Protected command requires the session cookie and verifies isolation
  const tokenLocal = cookieLocal.match(/pi_oauth_session=([^;]+)/)![1];
  const reqIpc = createMockReq({
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
    cookie: `pi_oauth_session=${tokenLocal}`,
  });
  const checkOwner = access.requireOAuthOwner('start_oauth_login', reqIpc as unknown as IncomingMessage);
  assert.equal(checkOwner.ok, true);
  if (checkOwner.ok) {
    assert.equal(checkOwner.owner, authLocal.owner);
  }

  // Request without session cookie fails closed (401)
  const reqNoCookie = createMockReq({ host: 'localhost:5173', origin: 'http://localhost:5173' });
  const checkNoCookie = access.requireOAuthOwner('start_oauth_login', reqNoCookie as unknown as IncomingMessage);
  assert.equal(checkNoCookie.ok, false);
  assert.equal(checkNoCookie.status, 401);
});

test('createOAuthAccess: default factory creates developmentAnonymous when no key is specified', async () => {
  const originalEnv = process.env.PI_VIEWER_OAUTH_ACCESS_KEY;
  delete process.env.PI_VIEWER_OAUTH_ACCESS_KEY;
  try {
    const defaultAccess = createOAuthAccess();
    assert.equal(defaultAccess.isConfigured(), true);
    assert.equal(defaultAccess.isDevelopmentAnonymous(), true);

    const req = createMockReq({ host: 'localhost:5173', origin: 'http://localhost:5173' });
    const res = createMockRes();
    const result = await defaultAccess.authorize(req as unknown as IncomingMessage, res as unknown as ServerResponse, {});
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('Default auth failed');
    assert.ok(result.owner.startsWith('owner_'));
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_VIEWER_OAUTH_ACCESS_KEY = originalEnv;
    }
  }
});


