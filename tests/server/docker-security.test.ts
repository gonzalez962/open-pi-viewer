import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { runDocker, DOCKER_OUTPUT_LIMIT } from '@server/bridge/docker';
import { installWebApi, type Middleware } from '@server/web-api';

test('S1.4 process runner bounds combined output and terminates overflowing command', async () => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = 0;
  child.kill = () => { killed++; return true; };
  const result = runDocker(['logs', '--tail', '500', 'bbbbbbbbbbbb'], (() => child) as any);
  child.stdout.emit('data', Buffer.alloc(DOCKER_OUTPUT_LIMIT));
  child.stderr.emit('data', Buffer.from('x'));
  await assert.rejects(result, /Docker output limit exceeded/);
  assert.equal(killed, 1);
});

test('S4.1 Docker endpoint exists and denies access when web auth is disabled', async () => {
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  let calls = 0;
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => { const layer = layers[i++]; if (!layer) { res.writeHead(404); res.end(); return; } if (layer.route && req.url !== layer.route) return next(); void layer.handler(req, res, next); };
    next();
  });
  (installWebApi as any)(app, server, { enabled: false }, { enabled: false }, { dockerRunner: async () => { calls++; throw new Error('must not execute'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const response = await fetch(`${base}/api/docker`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
