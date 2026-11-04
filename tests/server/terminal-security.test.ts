import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installWebApi } from '@server/web-api';
import { resetTerminalManagerForTest } from '@server/terminal/terminal-manager';

async function safeRmDir(dir: string, retries = 15, delayMs = 100): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

class MockRequest extends EventEmitter {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  originalUrl: string;
  method = 'POST';
  socket: { encrypted: boolean; remoteAddress: string };
  constructor(url: string, headers: Record<string, string | string[] | undefined>, remoteAddress: string) {
    super();
    this.url = this.originalUrl = url;
    this.headers = headers;
    this.socket = { encrypted: false, remoteAddress };
  }
}
class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string | string[]> = {};
  body = '';
  writableEnded = false;
  destroyed = false;
  setHeader(name: string, value: string | string[]) { this.headers[name.toLowerCase()] = value; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
  writeHead(status: number, headers: Record<string, string | string[]> = {}) {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    return this;
  }
  write(chunk: any) { this.body += String(chunk); return true; }
  end(chunk?: any) { if (chunk) this.body += String(chunk); this.writableEnded = true; this.emit('finish'); return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
function createMockApp() {
  const routes: Array<{ route: string; handler: any }> = [];
  const app = { use(route: string | any, handler?: any) {
    routes.push(typeof route === 'string' ? { route, handler } : { route: '', handler: route });
  } };
  const dispatch = (req: MockRequest, res: MockResponse) => {
    let index = 0;
    const next = (err?: any) => {
      if (err) { res.statusCode = 500; res.end(String(err)); return; }
      if (res.writableEnded) return;
      const current = routes[index++];
      if (!current) { res.statusCode = 404; res.end('Not found'); return; }
      const pathname = req.url.split('?')[0];
      if (current.route && pathname !== current.route && !pathname.startsWith(current.route + '/')) { next(); return; }
      try {
        const result = current.handler(req, res, next);
        if (result && typeof result.catch === 'function') result.catch(next);
      } catch (e) { next(e); }
    };
    next();
  };
  return { app, dispatch };
}
type Dispatch = ReturnType<typeof createMockApp>['dispatch'];
function request(dispatch: Dispatch, url: string, body: any, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1'): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    const req = new MockRequest(url, { 'content-type': 'application/json', host: 'localhost:5173', origin: 'http://localhost:5173', ...headers }, remoteAddress);
    const res = new MockResponse();
    const timer = setTimeout(() => {
      res.removeAllListeners('finish');
      res.destroy();
      req.emit('close');
      reject(new Error(`Request timed out: ${url} ${body?.cmd || ''}`));
    }, 2500);
    res.once('finish', () => { clearTimeout(timer); resolve(res); });
    dispatch(req, res);
    setImmediate(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  });
}
async function login(dispatch: Dispatch): Promise<string> {
  const res = await request(dispatch, '/api/auth/login', { key: 'test-key' });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = res.getHeader('set-cookie');
  assert.ok(cookie);
  return (Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0];
}
async function ipc(dispatch: Dispatch, cookie: string, cmd: string, args: any = {}) {
  return request(dispatch, '/api/ipc', { cmd, args }, cookie ? { cookie } : {});
}
async function result(dispatch: Dispatch, cookie: string, cmd: string, args: any = {}) {
  const res = await ipc(dispatch, cookie, cmd, args);
  assert.equal(res.statusCode, 200, `${cmd}: ${res.body}`);
  return JSON.parse(res.body).result;
}
async function waitReplay(dispatch: Dispatch, cookie: string, id: string, marker: string) {
  for (let i = 0; i < 100; i++) {
    const session = await result(dispatch, cookie, 'terminal_get', { id });
    if (session?.replay?.includes(marker)) return session;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`Timed out waiting for ${marker}`);
}

test('S1.1: distinct authenticated web sessions reattach and operate on the same live project terminal', async (t) => {
  await resetTerminalManagerForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-share-'));
  const { app, dispatch } = createMockApp();
  const server = new EventEmitter();
  installWebApi(app, server, { enabled: true, key: 'test-key' });
  t.after(async () => { server.emit('close'); await resetTerminalManagerForTest(); await safeRmDir(dir); });
  const alice = await login(dispatch);
  const bob = await login(dispatch);
  assert.notEqual(alice, bob);
  const first = await result(dispatch, alice, 'terminal_open', { cwd: dir });
  assert.ok(first.id && first.pid > 0 && first.running);
  const marker = 'SHARED_REPLAY_MARKER';
  assert.deepEqual(await result(dispatch, alice, 'terminal_write', { id: first.id, data: `echo ${marker}\r\n` }), { ok: true });
  await waitReplay(dispatch, alice, first.id, marker);
  const reopened = await result(dispatch, bob, 'terminal_open', { cwd: path.join(dir, '.') });
  assert.equal(reopened.id, first.id, 'different logins must reattach to the same ID');
  assert.equal(reopened.pid, first.pid);
  assert.equal(reopened.running, true);
  assert.ok(reopened.replay.includes(marker));
  assert.equal((await result(dispatch, bob, 'terminal_get', { id: first.id })).id, first.id);
  assert.equal((await result(dispatch, bob, 'terminal_get', { cwd: dir })).id, first.id);
  assert.ok((await result(dispatch, bob, 'terminal_list')).some((s: any) => s.id === first.id));
  const poll = await result(dispatch, bob, 'terminal_poll', { id: first.id, cursor: 0, timeoutMs: 0 });
  assert.ok(poll.data.includes(marker));
  assert.ok(poll.cursor > 0);
  const incremental = await result(dispatch, bob, 'terminal_poll', { id: first.id, cursor: poll.cursor, timeoutMs: 0 });
  assert.ok(!incremental.data.includes(marker));
  assert.ok(incremental.cursor >= poll.cursor);
  assert.deepEqual(await result(dispatch, bob, 'terminal_resize', { id: first.id, cols: 91, rows: 31 }), { ok: true });
  const resized = await result(dispatch, alice, 'terminal_get', { id: first.id });
  assert.equal(resized.cols, 91); assert.equal(resized.rows, 31);
  const secondMarker = 'SHARED_WRITE_MARKER';
  assert.deepEqual(await result(dispatch, bob, 'terminal_write', { id: first.id, data: `echo ${secondMarker}\r\n` }), { ok: true });
  await waitReplay(dispatch, alice, first.id, secondMarker);
  assert.deepEqual(await result(dispatch, bob, 'terminal_close', { id: first.id }), { ok: true });
  assert.equal(await result(dispatch, alice, 'terminal_get', { id: first.id }), null);
});

test('S1.2: closing or exiting one project replaces it without disturbing another project', async (t) => {
  await resetTerminalManagerForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-projects-'));
  const a = path.join(root, 'a'); const b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const { app, dispatch } = createMockApp(); const server = new EventEmitter();
  installWebApi(app, server, { enabled: true, key: 'test-key' });
  t.after(async () => { server.emit('close'); await resetTerminalManagerForTest(); await safeRmDir(root); });
  const cookie = await login(dispatch);
  const first = await result(dispatch, cookie, 'terminal_open', { cwd: a });
  const other = await result(dispatch, cookie, 'terminal_open', { cwd: b });
  assert.notEqual(first.id, other.id);
  await result(dispatch, cookie, 'terminal_close', { id: first.id });
  const replacement = await result(dispatch, cookie, 'terminal_open', { cwd: a });
  assert.notEqual(replacement.id, first.id);
  assert.equal((await result(dispatch, cookie, 'terminal_get', { id: other.id })).pid, other.pid);
  await result(dispatch, cookie, 'terminal_write', { id: replacement.id, data: 'exit\r\n' });
  let exited = false;
  for (let i = 0; i < 100; i++) {
    const current = await result(dispatch, cookie, 'terminal_get', { id: replacement.id });
    if (!current || !current.running) { exited = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(exited, 'shell must exit');
  const afterExit = await result(dispatch, cookie, 'terminal_open', { cwd: a });
  assert.notEqual(afterExit.id, replacement.id);
  const stillOther = await result(dispatch, cookie, 'terminal_open', { cwd: b });
  assert.equal(stillOther.id, other.id); assert.equal(stillOther.pid, other.pid); assert.equal(stillOther.running, true);
  await result(dispatch, cookie, 'terminal_write', { id: other.id, data: 'echo OTHER_ALIVE\r\n' });
  await waitReplay(dispatch, cookie, other.id, 'OTHER_ALIVE');
});

test('S2.1: HTTP authorization and verified loopback guard live terminals', async (t) => {
  await resetTerminalManagerForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-guard-'));
  const enabled = createMockApp(); const enabledServer = new EventEmitter();
  const local = createMockApp(); const localServer = new EventEmitter();
  installWebApi(enabled.app, enabledServer, { enabled: true, key: 'test-key' });
  installWebApi(local.app, localServer, { enabled: false });
  t.after(async () => { enabledServer.emit('close'); localServer.emit('close'); await resetTerminalManagerForTest(); await safeRmDir(dir); });
  const cookie = await login(enabled.dispatch);
  const session = await result(enabled.dispatch, cookie, 'terminal_open', { cwd: dir });
  for (const [cmd, args] of [
    ['terminal_open', { cwd: dir }], ['terminal_get', { id: session.id }], ['terminal_list', {}],
    ['terminal_poll', { id: session.id, cursor: 0 }], ['terminal_write', { id: session.id, data: 'echo FORBIDDEN_INPUT\r\n' }],
    ['terminal_resize', { id: session.id, cols: 111, rows: 44 }], ['terminal_close', { id: session.id }],
  ] as const) {
    const unauthorized = await ipc(enabled.dispatch, '', cmd, args);
    assert.equal(unauthorized.statusCode, 401); assert.deepEqual(JSON.parse(unauthorized.body), { error: 'Unauthorized: Web login session required' });
    const cross = await request(enabled.dispatch, '/api/ipc', { cmd, args }, { cookie, origin: 'http://attacker.invalid' });
    assert.equal(cross.statusCode, 403); assert.deepEqual(JSON.parse(cross.body), { error: 'Origin validation failed: access denied' });
    const remote = await request(local.dispatch, '/api/ipc', { cmd, args }, {}, '192.168.1.100');
    assert.equal(remote.statusCode, 403); assert.deepEqual(JSON.parse(remote.body), { error: 'Access denied: remote shell execution requires authentication' });
  }
  const spoofed = await request(local.dispatch, '/api/ipc', { cmd: 'terminal_resize', args: { id: session.id, cols: 111, rows: 44 } }, {
    'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1',
  }, '192.168.1.100');
  assert.equal(spoofed.statusCode, 403);
  assert.deepEqual(JSON.parse(spoofed.body), { error: 'Access denied: remote shell execution requires authentication' });
  const after = await result(enabled.dispatch, cookie, 'terminal_get', { id: session.id });
  assert.deepEqual([after.id, after.pid, after.cols, after.rows, after.running], [session.id, session.pid, session.cols, session.rows, true]);
  assert.ok(!after.replay.includes('FORBIDDEN_INPUT'));
  const streamReq = new MockRequest('/api/events', { host: 'localhost:5173', origin: 'http://localhost:5173', cookie }, '127.0.0.1');
  const streamRes = new MockResponse();
  enabled.dispatch(streamReq, streamRes);
  assert.equal(streamRes.statusCode, 200);
  assert.equal(streamRes.getHeader('content-type'), 'text/event-stream');
  try {
    await result(enabled.dispatch, cookie, 'terminal_write', { id: session.id, data: 'echo AUTHORIZED_ALIVE\r\n' });
    await waitReplay(enabled.dispatch, cookie, session.id, 'AUTHORIZED_ALIVE');
    assert.ok(!streamRes.body.includes('AUTHORIZED_ALIVE'), 'terminal output must not appear on shared SSE');
  } finally {
    streamReq.emit('close');
    streamRes.destroy();
  }
  const localOpen = await result(local.dispatch, '', 'terminal_open', { cwd: dir });
  assert.ok(localOpen.id && localOpen.running);
});

test('PRESERVE: existing /api/ipc commands continue to work without regression', async () => {
  const { app, dispatch } = createMockApp(); const server = new EventEmitter();
  installWebApi(app, server, { enabled: false });
  const response = await ipc(dispatch, '', 'detect_gentle_shell');
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.status, 'missing');
  server.emit('close');
});
