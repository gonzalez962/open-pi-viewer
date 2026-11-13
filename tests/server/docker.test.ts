import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installWebApi, type Middleware } from '@server/web-api';

// The injected runner is the only Docker boundary: these tests never invoke Docker.
async function fixture(enabled = true, sessionTtlMs = 60_000) {
  const calls: string[][] = [];
  let fail = false;
  let running = false;
  const runner = async (args: string[]) => {
    calls.push([...args]);
    if (fail) return { stdout: '', stderr: 'daemon unavailable', code: 1 };
    if (args[0] === 'ps') return { stdout: [
      JSON.stringify({ ID: 'aaaaaaaaaaaa', Names: 'alpha', State: 'running', Status: 'Up', Labels: 'com.docker.compose.project=one' }),
      JSON.stringify({ ID: 'bbbbbbbbbbbb', Names: 'beta', State: 'exited', Status: 'Exited', Labels: 'com.docker.compose.project=two' }),
      JSON.stringify({ ID: 'cccccccccccc', Names: 'standalone', State: 'exited', Status: 'Exited', Labels: '' }),
    ].join('\n'), stderr: '', code: 0 };
    if (args[0] === 'inspect') return { stdout: running ? 'running' : 'exited', stderr: '', code: 0 };
    if (args[0] === 'logs') return { stdout: 'bounded log', stderr: '', code: 0 };
    return { stdout: 'ok', stderr: '', code: 0 };
  };
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => { const layer = layers[i++]; if (!layer) { res.writeHead(404); res.end(); return; } if (layer.route && req.url !== layer.route) return next(); void layer.handler(req, res, next); };
    next();
  });
  // T1 adds this optional test seam; production uses its bounded process runner.
  (installWebApi as any)(app, server, enabled ? { enabled, key: 'fixture-key', sessionTtlMs } : { enabled }, { enabled: false }, { dockerRunner: runner });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { origin: base, 'content-type': 'application/json' };
  const login = async () => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ key: 'fixture-key' }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const request = (body: unknown, cookie = '', origin = base) => fetch(`${base}/api/docker`, { method: 'POST', headers: { ...headers, origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const logout = (cookie: string) => fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...headers, cookie } });
  return { calls, login, logout, request, setFail(value: boolean) { fail = value; }, setRunning(value: boolean) { running = value; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('S1.1 lists all existing containers without a project filter; errors are explicit', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    const response = await f.request({ action: 'list' }, cookie);
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.deepEqual(data.containers.map((c: any) => [c.id, c.state]), [['aaaaaaaaaaaa', 'running'], ['bbbbbbbbbbbb', 'exited'], ['cccccccccccc', 'exited']]);
    assert.equal(f.calls[0][0], 'ps');
    assert.ok(!f.calls[0].includes('--filter'));
    f.setFail(true);
    const failed = await f.request({ action: 'list' }, cookie);
    assert.notEqual(failed.status, 200);
    assert.match(JSON.stringify(await failed.json()), /daemon unavailable/);
  } finally { await f.close(); }
});

test('S1.2 lifecycle commands target exactly one container and report failures', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    for (const action of ['start', 'stop', 'restart']) {
      const response = await f.request({ action, containerId: 'bbbbbbbbbbbb' }, cookie);
      assert.equal(response.status, 200);
      assert.ok(f.calls.some(args => args[0] === action && args[args.length - 1] === 'bbbbbbbbbbbb'));
    }
    f.setFail(true);
    const response = await f.request({ action: 'start', containerId: 'bbbbbbbbbbbb' }, cookie);
    assert.notEqual(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /daemon unavailable/);
  } finally { await f.close(); }
});

test('S1.3 removal requires confirmation, refuses running containers, and preserves volumes', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    assert.notEqual((await f.request({ action: 'remove', containerId: 'bbbbbbbbbbbb', confirmed: false }, cookie)).status, 200);
    assert.equal(f.calls.length, 0);
    f.setRunning(true);
    assert.notEqual((await f.request({ action: 'remove', containerId: 'bbbbbbbbbbbb', confirmed: true }, cookie)).status, 200);
    assert.ok(!f.calls.some(args => args[0] === 'rm'));
    f.setRunning(false);
    assert.equal((await f.request({ action: 'remove', containerId: 'bbbbbbbbbbbb', confirmed: true }, cookie)).status, 200);
    const remove = f.calls.find(args => args[0] === 'rm')!;
    assert.ok(remove);
    assert.equal(remove[remove.length - 1], 'bbbbbbbbbbbb');
    assert.ok(!remove.includes('-v') && !remove.includes('--volumes') && !remove.includes('-f') && !remove.includes('--force'));
  } finally { await f.close(); }
});

test('S1.4 logs are bounded and failures are explicit', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    const response = await f.request({ action: 'logs', containerId: 'bbbbbbbbbbbb' }, cookie);
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /bounded log/);
    const args = f.calls.find(call => call[0] === 'logs')!;
    assert.ok(args.includes('--tail'));
    assert.ok(Number(args[args.indexOf('--tail') + 1]) > 0 && Number(args[args.indexOf('--tail') + 1]) <= 1000);
    f.setFail(true);
    const failed = await f.request({ action: 'logs', containerId: 'bbbbbbbbbbbb' }, cookie);
    assert.notEqual(failed.status, 200);
    assert.match(JSON.stringify(await failed.json()), /daemon unavailable/);
  } finally { await f.close(); }
});

test('S4.1 disabled auth and anonymous requests never execute Docker', async () => {
  for (const enabled of [false, true]) {
    const f = await fixture(enabled);
    try {
      for (const action of ['list', 'start', 'stop', 'restart', 'remove', 'logs']) {
        const response = await f.request({ action, containerId: 'bbbbbbbbbbbb', confirmed: true });
        assert.notEqual(response.status, 200);
      }
      assert.deepEqual(f.calls, []);
    } finally { await f.close(); }
  }
});

test('S4.2 authenticated owner and same origin required, logout revokes access', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    assert.notEqual((await f.request({ action: 'start', containerId: 'bbbbbbbbbbbb' }, cookie, 'http://evil.invalid')).status, 200);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.request({ action: 'start', containerId: 'bbbbbbbbbbbb' }, cookie)).status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.logout(cookie)).status, 200);
    assert.equal((await f.request({ action: 'start', containerId: 'bbbbbbbbbbbb' }, cookie)).status, 401);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('S4.2 expired sessions cannot execute Docker', async () => {
  const f = await fixture(true, 50);
  try {
    const cookie = await f.login();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await f.request({ action: 'list' }, cookie)).status, 401);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('S1.2 rejects option-like identifiers and unsupported create without executing Docker', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    for (const body of [{ action: 'start', containerId: '--help' }, { action: 'create', containerId: 'bbbbbbbbbbbb' }]) {
      assert.notEqual((await f.request(body, cookie)).status, 200);
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});
