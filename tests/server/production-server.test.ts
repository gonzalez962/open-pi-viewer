import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProductionServer } from '@server/production-server';

async function fixture(enabled = false) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-production-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>production interface</html>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("build")');
  fs.writeFileSync(path.join(root, 'push-sw.js'), 'self.addEventListener("push", () => {});');
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"name":"Pi Viewer"}');
  fs.writeFileSync(path.join(root, 'private.txt'), 'not a public asset');
  const server = createProductionServer({ staticDir: root, authConfig: { enabled, key: enabled ? 'test-key' : undefined } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, async cleanup() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } };
}

test('production server serves build assets, SPA routes and existing IPC without dev', async () => {
  const f = await fixture();
  try {
    const page = await fetch(f.base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /production interface/);
    const asset = await fetch(`${f.base}/assets/app.js`);
    assert.match(asset.headers.get('content-type') || '', /javascript/);
    assert.equal(await asset.text(), 'console.log("build")');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600');
    const worker = await fetch(`${f.base}/push-sw.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type') || '', /javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-cache');
    assert.equal(await worker.text(), 'self.addEventListener("push", () => {});');
    const manifest = await fetch(`${f.base}/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') || '', /json/);
    assert.equal(manifest.headers.get('cache-control'), 'no-cache');
    assert.equal(await manifest.text(), '{"name":"Pi Viewer"}');
    const route = await fetch(`${f.base}/projects/example`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /production interface/);
    const api = await fetch(`${f.base}/api/ipc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'get_bridge_state' }) });
    assert.equal(api.status, 200);
    assert.ok((await api.json()).result);
    assert.equal((await fetch(`${f.base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${f.base}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${f.base}/%2e%2e%2fpackage.json`)).status, 403);
    const sse = await fetch(`${f.base}/api/events`);
    assert.match(sse.headers.get('content-type') || '', /text\/event-stream/);
    await sse.body?.cancel();
  } finally { await f.cleanup(); }
});

test('production server preserves authentication before IPC and SSE routes', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await fetch(f.base)).status, 200);
    assert.equal((await fetch(`${f.base}/api/ipc`, { method: 'POST', headers: { origin: f.base }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${f.base}/api/events`, { headers: { origin: f.base } })).status, 401);
    const status = await fetch(`${f.base}/api/auth/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).required, true);
  } finally { await f.cleanup(); }
});

test('production startup rejects missing build', () => {
  assert.throws(() => createProductionServer({ staticDir: path.join(process.cwd(), '.workspace-no-build'), authConfig: { enabled: false } }), /npm run build/);
});

function withIsolatedPushEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevPub = process.env.PI_VIEWER_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.PI_VIEWER_VAPID_PRIVATE_KEY;
  const prevSub = process.env.PI_VIEWER_VAPID_SUBJECT;
  delete process.env.PI_VIEWER_VAPID_PUBLIC_KEY;
  delete process.env.PI_VIEWER_VAPID_PRIVATE_KEY;
  delete process.env.PI_VIEWER_VAPID_SUBJECT;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevPub !== undefined) process.env.PI_VIEWER_VAPID_PUBLIC_KEY = prevPub; else delete process.env.PI_VIEWER_VAPID_PUBLIC_KEY;
      if (prevPriv !== undefined) process.env.PI_VIEWER_VAPID_PRIVATE_KEY = prevPriv; else delete process.env.PI_VIEWER_VAPID_PRIVATE_KEY;
      if (prevSub !== undefined) process.env.PI_VIEWER_VAPID_SUBJECT = prevSub; else delete process.env.PI_VIEWER_VAPID_SUBJECT;
    });
}

test('S1.1: production server routes GET /api/push/config and returns available: false when unconfigured', async () => {
  await withIsolatedPushEnv(async () => {
    const f = await fixture(false);
    try {
      const res = await fetch(`${f.base}/api/push/config`, {
        headers: { origin: f.base },
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '{"available":false}');
    } finally {
      await f.cleanup();
    }
  });
});

test('S2.1: production server routes unsupported GET /api/push/subscriptions to 405 Method not allowed', async () => {
  const f = await fixture(false);
  try {
    const res = await fetch(`${f.base}/api/push/subscriptions`, {
      method: 'GET',
      headers: { origin: f.base },
    });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  } finally {
    await f.cleanup();
  }
});

test('S2.2: production server rejects push routes with /suffix appended with 404 Not found', async () => {
  const f = await fixture(false);
  try {
    const configSuffix = await fetch(`${f.base}/api/push/config/suffix`, {
      headers: { origin: f.base },
    });
    assert.equal(configSuffix.status, 404);
    assert.deepEqual(await configSuffix.json(), { error: 'Not found' });

    const subSuffix = await fetch(`${f.base}/api/push/subscriptions/suffix`, {
      headers: { origin: f.base },
    });
    assert.equal(subSuffix.status, 404);
    assert.deepEqual(await subSuffix.json(), { error: 'Not found' });
  } finally {
    await f.cleanup();
  }
});

test('S2.3: production server with authentication enabled rejects anonymous push route requests with 401', async () => {
  const f = await fixture(true);
  try {
    const configRes = await fetch(`${f.base}/api/push/config`, {
      headers: { origin: f.base },
    });
    assert.equal(configRes.status, 401);

    const subRes = await fetch(`${f.base}/api/push/subscriptions`, {
      headers: { origin: f.base },
    });
    assert.equal(subRes.status, 401);
  } finally {
    await f.cleanup();
  }
});
