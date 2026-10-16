import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebAuth, resolveWebAuthConfig } from '@server/bridge/web-auth';

const options = { enabled: true, key: 'secret', turnstileSiteKey: 'public-site', turnstileSecretKey: 'private-secret' };
function request(ip = '127.0.0.1') {
  return { method: 'POST', headers: { host: 'viewer.example:8443', origin: 'https://viewer.example:8443', 'content-type': 'application/json' }, socket: { remoteAddress: ip } };
}
function response() {
  return { statusCode: 0, headers: {} as Record<string, unknown>, body: '', setHeader(k: string, v: unknown) { this.headers[k.toLowerCase()] = v; }, end(v: string) { this.body = v; } };
}
const pass: typeof fetch = async () => new Response(JSON.stringify({ success: true, action: 'login', hostname: 'viewer.example' }));

test('Turnstile configuration requires paired keys and enabled web auth; status never leaks secret', () => {
  for (const env of [
    { PI_VIEWER_TURNSTILE_SITE_KEY: 'public' },
    { PI_VIEWER_TURNSTILE_SECRET_KEY: 'secret' },
    { PI_VIEWER_TURNSTILE_SITE_KEY: 'public', PI_VIEWER_TURNSTILE_SECRET_KEY: 'secret' },
  ]) assert.throws(() => resolveWebAuthConfig(env), /Turnstile/);
  const config = resolveWebAuthConfig({ PI_VIEWER_AUTH_ENABLED: 'true', PI_VIEWER_AUTH_KEY: 'key', PI_VIEWER_TURNSTILE_SITE_KEY: 'public', PI_VIEWER_TURNSTILE_SECRET_KEY: 'secret' });
  const auth = createWebAuth(config);
  const res = response();
  auth.handleStatus({ method: 'GET', headers: {} }, res);
  assert.deepEqual(JSON.parse(res.body), { required: true, authenticated: false, turnstileSiteKey: 'public' });
  assert.ok(!res.body.includes('secret'));
  auth.dispose();
});

test('Turnstile valid token uses fixed endpoint and creates a session only after Siteverify', async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init?.method, 'POST');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('secret'), 'private-secret');
    assert.equal(body.get('response'), 'token');
    assert.ok(init?.signal);
    return pass(url, init);
  };
  const auth = createWebAuth({ ...options, turnstileFetch: fetchFn });
  const res = response();
  await auth.handleLogin(request(), res, { key: 'secret', turnstileToken: 'token' });
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.ok(res.headers['set-cookie']);
  assert.equal(auth.getSessionsCount(), 1);
  auth.dispose();
});

test('Turnstile rejects missing or oversized token, origin, failed key, and upstream failures without session/cookie', async () => {
  for (const payload of [{}, { turnstileToken: '' }, { turnstileToken: 42 }, { turnstileToken: 'x'.repeat(2049) }]) {
    let calls = 0;
    const auth = createWebAuth({ ...options, turnstileFetch: async (...args) => { calls++; return pass(...args); } });
    const res = response();
    await auth.handleLogin(request(), res, { key: 'secret', ...payload });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'Missing or invalid Turnstile token' });
    assert.equal(calls, 0);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(auth.getSessionsCount(), 0);
    auth.dispose();
  }
  for (const result of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: 'true', action: 'login', hostname: 'viewer.example' },
    { success: true, action: 'other', hostname: 'viewer.example' },
    { success: true, action: 'login', hostname: 'other.example' },
    null,
  ]) {
    const auth = createWebAuth({ ...options, turnstileFetch: async () => new Response(JSON.stringify(result)) });
    const res = response();
    await auth.handleLogin(request(), res, { key: 'secret', turnstileToken: 'token' });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'Turnstile verification failed. Please try again.' });
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(auth.getSessionsCount(), 0);
    auth.dispose();
  }
  for (const fetchFn of [async () => { throw new Error('private-network-details'); }, async () => new Response('bad json'), async () => new Response('{}', { status: 503 })]) {
    const auth = createWebAuth({ ...options, turnstileFetch: fetchFn });
    const res = response();
    await auth.handleLogin(request(), res, { key: 'secret', turnstileToken: 'token' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'Turnstile verification unavailable. Please try again.' });
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(auth.getSessionsCount(), 0);
    auth.dispose();
  }
  let calls = 0;
  const auth = createWebAuth({ ...options, turnstileFetch: async (...args) => { calls++; return pass(...args); } });
  const req = request(); req.headers.origin = 'https://other.example';
  const denied = response();
  await auth.handleLogin(req, denied, { key: 'secret', turnstileToken: 'token' });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls, 0);
  assert.equal(auth.getSessionsCount(), 0);
  const wrong = response();
  await auth.handleLogin(request(), wrong, { key: 'wrong', turnstileToken: 'token' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.equal(auth.getSessionsCount(), 0);
  auth.dispose();
});

test('Turnstile limits all attempts before async verification, does not trust forwarded IP, resets only after window', async () => {
  let time = 0; let calls = 0;
  const auth = createWebAuth({ ...options, now: () => time, rateLimitMaxAttempts: 2, rateLimitWindowMs: 1000, turnstileFetch: async (...args) => { calls++; return pass(...args); } });
  for (let i = 0; i < 2; i++) {
    const res = response();
    await auth.handleLogin(request(), res, { key: 'secret' });
    assert.equal(res.statusCode, 400);
  }
  const blocked = response();
  const req = request(); Object.assign(req.headers, { 'x-forwarded-for': '8.8.8.8' });
  await auth.handleLogin(req, blocked, { key: 'secret', turnstileToken: 'token' });
  assert.equal(blocked.statusCode, 429);
  assert.equal(calls, 0);
  assert.equal(auth.getSessionsCount(), 0);
  time = 1000;
  const ok = response();
  await auth.handleLogin(request(), ok, { key: 'secret', turnstileToken: 'token' });
  assert.equal(ok.statusCode, 200);
  const ok2 = response();
  await auth.handleLogin(request(), ok2, { key: 'secret', turnstileToken: 'token2' });
  assert.equal(ok2.statusCode, 200);
  const denied = response();
  await auth.handleLogin(request(), denied, { key: 'secret', turnstileToken: 'token3' });
  assert.equal(denied.statusCode, 429);
  assert.equal(calls, 2);
  assert.equal(denied.headers['set-cookie'], undefined);
  assert.equal(auth.getSessionsCount(), 2);
  auth.dispose();
});

test('Turnstile concurrent verification reserves admission synchronously and dispose prevents pending session', async () => {
  let finish!: (value: Response) => void; let calls = 0;
  const auth = createWebAuth({ ...options, rateLimitMaxAttempts: 1, turnstileFetch: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = response();
  const pending = auth.handleLogin(request(), first, { key: 'secret', turnstileToken: 'one' });
  const second = response();
  await auth.handleLogin(request(), second, { key: 'secret', turnstileToken: 'two' });
  assert.equal(second.statusCode, 429);
  assert.equal(calls, 1);
  assert.equal(auth.getSessionsCount(), 0);
  auth.dispose();
  finish(await pass(''));
  await pending;
  assert.equal(first.statusCode, 503);
  assert.equal(first.headers['set-cookie'], undefined);
  assert.equal(auth.getSessionsCount(), 0);
});

test('official dummy secrets accept dummy response only on local hosts; production remains strict', async () => {
  const dummySecret = '1x0000000000000000000000000000000AA';
  for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173', 'viewer.example:8443']) {
    const auth = createWebAuth({ ...options, turnstileSecretKey: dummySecret, turnstileFetch: async () => new Response(JSON.stringify({ success: true, hostname: 'example.com' })) });
    const req = request(); req.headers.host = host; req.headers.origin = 'http://' + host;
    const res = response();
    await auth.handleLogin(req, res, { key: 'secret', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
    const local = host !== 'viewer.example:8443';
    assert.equal(res.statusCode, local ? 200 : 403);
    assert.equal(auth.getSessionsCount(), local ? 1 : 0);
    assert.equal(Boolean(res.headers['set-cookie']), local);
    auth.dispose();
  }
  for (const secret of [options.turnstileSecretKey, dummySecret]) {
    const auth = createWebAuth({ ...options, turnstileSecretKey: secret, turnstileFetch: async () => new Response(JSON.stringify({ success: secret === dummySecret ? false : true, hostname: 'example.com' })) });
    const req = request(); req.headers.host = 'localhost:5173'; req.headers.origin = 'http://localhost:5173';
    const res = response();
    await auth.handleLogin(req, res, { key: 'secret', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
    assert.equal(res.statusCode, 403);
    assert.equal(auth.getSessionsCount(), 0);
    assert.equal(res.headers['set-cookie'], undefined);
    auth.dispose();
  }
});
