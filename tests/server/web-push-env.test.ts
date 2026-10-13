import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWebApi, type Middleware } from '@server/web-api';
import { resolveWebPushConfig } from '@server/bridge/web-push';

const loadedEnv = {
  PI_VIEWER_VAPID_PUBLIC_KEY: 'B' + 'A'.repeat(86),
  PI_VIEWER_VAPID_PRIVATE_KEY: 'C'.repeat(43),
  PI_VIEWER_VAPID_SUBJECT: 'mailto:admin@example.com',
};

test('Web API uses explicitly loaded server config without publishing private VAPID fields', async () => {
  const routes = new Map<string, Middleware>();
  const server = new EventEmitter();
  installWebApi({ use: (route: string | Middleware, handler?: Middleware) => {
    if (typeof route === 'string' && handler) routes.set(route, handler);
  } }, server, { enabled: true, key: 'test-only-access' }, resolveWebPushConfig(loadedEnv));
  const req = { method: 'GET', url: '/api/push/config', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } };
  let body = '';
  const res = { statusCode: 0, setHeader: () => {}, end: (value: string) => { body = value; } };
  try {
    await routes.get('/api/push/config')!(req as never, res as never, () => {});
    await new Promise(done => setImmediate(done));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(body), { available: true, publicKey: loadedEnv.PI_VIEWER_VAPID_PUBLIC_KEY });
    assert.ok(!body.includes(loadedEnv.PI_VIEWER_VAPID_PRIVATE_KEY));
    assert.ok(!body.includes('privateKey'));
    assert.ok(!body.includes('subject'));
  } finally { server.emit('close'); }
});
