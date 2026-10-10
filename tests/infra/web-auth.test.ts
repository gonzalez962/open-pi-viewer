import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAuthStatus,
  loginWithKey,
  logout,
  emitWebAuthReady,
  emitWebAuthRequired,
  WEB_AUTH_READY_EVENT,
  WEB_AUTH_REQUIRED_EVENT,
} from '@infra/web-auth';

test('checkAuthStatus: returns status when auth is disabled', async () => {
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(input, '/api/auth/status');
    assert.equal(init?.method, 'GET');
    return new Response(JSON.stringify({ required: false, authenticated: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const status = await checkAuthStatus({ fetchFn: fakeFetch });
  assert.deepEqual(status, { required: false, authenticated: false });
});

test('checkAuthStatus: returns required=true, authenticated=false when unauthenticated', async () => {
  const fakeFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ required: true, authenticated: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const status = await checkAuthStatus({ fetchFn: fakeFetch });
  assert.deepEqual(status, { required: true, authenticated: false });
});

test('checkAuthStatus: fails closed on network failure or non-200 status', async () => {
  const rejectingFetch: typeof fetch = async () => {
    throw new Error('Network offline');
  };

  await assert.rejects(
    async () => checkAuthStatus({ fetchFn: rejectingFetch }),
    /Network offline/
  );

  const errorFetch: typeof fetch = async () => {
    return new Response('Server error', { status: 500 });
  };

  await assert.rejects(
    async () => checkAuthStatus({ fetchFn: errorFetch }),
    /HTTP 500/
  );
});

test('loginWithKey: sends JSON key and returns ok: true on 200', async () => {
  let requestBody: any = null;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(input, '/api/auth/login');
    assert.equal(init?.method, 'POST');
    requestBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await loginWithKey('valid-secret-key', { fetchFn: fakeFetch });
  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, { key: 'valid-secret-key' });
});

test('loginWithKey: returns ok: false and error message on 401 invalid key', async () => {
  const fakeFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: 'Invalid key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await loginWithKey('wrong-key', { fetchFn: fakeFetch });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid key');
});

test('loginWithKey: preserves exact raw key bytes including spaces', async () => {
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const keyWithSpaces = '  secret key with spaces  ';
  const result = await loginWithKey(keyWithSpaces, { fetchFn: fakeFetch });
  assert.equal(result.ok, true);
  assert.equal(capturedBody.key, keyWithSpaces, 'Key bytes must be preserved without trimming');
});

test('logout: treats 401 as successful revoke (already expired on server)', async () => {
  const expiredFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Must not throw when server returns 401 because the session is already revoked/invalid
  await assert.doesNotReject(async () => logout({ fetchFn: expiredFetch }));
});

test('logout: throws on 500 server error', async () => {
  const errorFetch: typeof fetch = async () => {
    return new Response('Internal Server Error', { status: 500 });
  };

  await assert.rejects(
    async () => logout({ fetchFn: errorFetch }),
    /Logout failed: HTTP 500/
  );
});

test('logout: throws on network failure', async () => {
  const rejectingFetch: typeof fetch = async () => {
    throw new Error('Connection refused');
  };

  await assert.rejects(
    async () => logout({ fetchFn: rejectingFetch }),
    /Connection refused/
  );
});

test('emitWebAuthReady and emitWebAuthRequired dispatch custom events on target', () => {
  const target = new EventTarget();
  let readyDispatched = false;
  let requiredDispatched = false;

  target.addEventListener(WEB_AUTH_READY_EVENT, () => {
    readyDispatched = true;
  });
  target.addEventListener(WEB_AUTH_REQUIRED_EVENT, () => {
    requiredDispatched = true;
  });

  emitWebAuthReady({ eventTarget: target });
  assert.equal(readyDispatched, true);

  emitWebAuthRequired({ eventTarget: target });
  assert.equal(requiredDispatched, true);
});
