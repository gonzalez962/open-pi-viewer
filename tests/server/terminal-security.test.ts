import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

class MockRequest extends EventEmitter {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
  socket: { encrypted?: boolean; remoteAddress?: string };
  originalUrl?: string;

  constructor(options: {
    url?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    encrypted?: boolean;
    remoteAddress?: string;
  } = {}) {
    super();
    this.url = options.url || '/api/ipc';
    this.originalUrl = this.url;
    this.method = options.method || 'POST';
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

function createMockApp() {
  const routes: Array<{ route: string; handler: any }> = [];
  const app = {
    use(routeOrHandler: string | any, handler?: any) {
      if (typeof routeOrHandler === 'string') {
        routes.push({ route: routeOrHandler, handler });
      } else {
        routes.push({ route: '', handler: routeOrHandler });
      }
    },
  };

  const dispatch = async (req: MockRequest, res: MockResponse) => {
    let index = 0;
    const next = (err?: any) => {
      if (err) {
        res.statusCode = 500;
        res.end(String(err));
        return;
      }
      if (res.writableEnded) return;
      const current = routes[index++];
      if (!current) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const pathname = req.url.split('?')[0];
      if (current.route && pathname !== current.route && !pathname.startsWith(current.route + '/')) {
        next();
        return;
      }
      try {
        const result = current.handler(req, res, next);
        if (result && typeof result.catch === 'function') {
          result.catch(next);
        }
      } catch (e) {
        next(e);
      }
    };
    next();
  };

  return { app, dispatch };
}

function sendIpcRequest(dispatch: (req: MockRequest, res: MockResponse) => Promise<void>, options: {
  cmd: string;
  args?: any;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}): Promise<MockResponse> {
  return new Promise((resolve) => {
    const req = new MockRequest({
      url: '/api/ipc',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        ...options.headers,
      },
      remoteAddress: options.remoteAddress || '127.0.0.1',
    });
    const res = new MockResponse();

    res.once('finish', () => resolve(res));

    void dispatch(req, res);

    process.nextTick(() => {
      req.emit('data', JSON.stringify({ cmd: options.cmd, args: options.args || {} }));
      req.emit('end');
    });
  });
}

test('S4.1: Given the web backend, when a permitted client opens/writes/resizes/closes a terminal, then each operation reaches the real backend session and an untrusted remote or cross-origin request is rejected without spawning or changing sessions', async (t) => {
  const { installWebApi } = await import('@server/web-api');
  const { getTerminalManager, resetTerminalManagerForTest } = await import('@server/terminal/terminal-manager');
  resetTerminalManagerForTest();
  const manager = getTerminalManager();
  t.after(() => {
    manager.dispose();
    resetTerminalManagerForTest();
  });

  const { app, dispatch } = createMockApp();
  const server = new EventEmitter();
  installWebApi(app, server, { enabled: false });

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s41-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  // 1. Permitted client (verified loopback peer and host, same-origin)
  const openRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_open',
    args: { cwd: fixtureDir },
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  assert.strictEqual(openRes.statusCode, 200, `Expected 200 for permitted client, got ${openRes.statusCode}: ${openRes.body}`);
  const openBody = JSON.parse(openRes.body);
  assert.ok(openBody.result?.id, 'Session must be returned');
  const sessionId = openBody.result.id;

  // Write reaches session
  const writeRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_write',
    args: { id: sessionId, data: 'echo test\r\n' },
    remoteAddress: '127.0.0.1',
  });
  assert.strictEqual(writeRes.statusCode, 200);

  // Resize reaches session
  const resizeRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_resize',
    args: { id: sessionId, cols: 90, rows: 30 },
    remoteAddress: '127.0.0.1',
  });
  assert.strictEqual(resizeRes.statusCode, 200);

  // 2. Untrusted remote peer (non-loopback IP with auth disabled)
  const remoteRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_open',
    args: { cwd: fixtureDir },
    remoteAddress: '192.168.1.100',
    headers: { host: '192.168.1.100:5173', origin: 'http://192.168.1.100:5173' },
  });
  assert.ok(remoteRes.statusCode === 403 || remoteRes.statusCode === 401, 'Remote unauthenticated request must be rejected');
  const sessionsBefore = manager.listSessions().length;

  // 3. Spoofed loopback header from remote peer must NOT bypass security
  const spoofRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_open',
    args: { cwd: fixtureDir },
    remoteAddress: '192.168.1.100',
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'x-forwarded-for': '127.0.0.1',
      'x-real-ip': '127.0.0.1',
    },
  });
  assert.strictEqual(spoofRes.statusCode, 403, 'Spoofed loopback headers must be rejected');
  assert.strictEqual(manager.listSessions().length, sessionsBefore, 'No sessions must be spawned on rejected remote request');

  // 4. Cross-origin request must be rejected
  const csrfRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_open',
    args: { cwd: fixtureDir },
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:5173', origin: 'http://malicious-attacker.com' },
  });
  assert.strictEqual(csrfRes.statusCode, 403, 'Cross-origin request must be rejected');
  assert.strictEqual(manager.listSessions().length, sessionsBefore, 'No session must be spawned on cross-origin request');

  // 5. Permitted client closes session
  const closeRes = await sendIpcRequest(dispatch, {
    cmd: 'terminal_close',
    args: { id: sessionId },
    remoteAddress: '127.0.0.1',
  });
  assert.strictEqual(closeRes.statusCode, 200);
  assert.strictEqual(manager.getSession(sessionId), null, 'Session must be closed');
});

test('PRESERVE: existing /api/ipc commands continue to work without regression', async (t) => {
  const { installWebApi } = await import('@server/web-api');
  const { app, dispatch } = createMockApp();
  const server = new EventEmitter();
  installWebApi(app, server, { enabled: false });

  const res = await sendIpcRequest(dispatch, {
    cmd: 'detect_gentle_shell',
    args: {},
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.result, 'detect_gentle_shell must return result');
  assert.strictEqual(body.result.status, 'missing');
});
