import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runDocker, manageDocker, DOCKER_OUTPUT_LIMIT } from '@server/bridge/docker';
import { installWebApi, type Middleware } from '@server/web-api';

test('S5.1 update checks authority before inspect', async () => {
  const calls: string[][] = [];
  await assert.rejects(manageDocker({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true }, async args => {
    calls.push(args); return { stdout: '', stderr: '', code: 0 };
  }, () => false), /expired/i);
  assert.deepEqual(calls, []);
});

test('S5 update stops after inspect or pull when authority is revoked', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-lease-test-'));
  try {
    const config = path.join(dir, 'compose.yml');
    await fs.writeFile(config, 'services:\n  web:\n    image: app\n');
    const labels = { 'com.docker.compose.project': 'project', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': dir, 'com.docker.compose.project.config_files': config };
    const inspect = ['inspect', '--format', '{{json .Config.Labels}}', 'bbbbbbbbbbbb'];
    const pull = ['compose', '-p', 'project', '--project-directory', dir, '-f', config, 'pull', 'web'];
    for (const revokeAfter of [1, 2]) {
      let allowed = true;
      const calls: string[][] = [];
      await assert.rejects(manageDocker({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true }, async args => {
        calls.push([...args]);
        if (calls.length === revokeAfter) allowed = false;
        return { stdout: args[0] === 'inspect' ? JSON.stringify(labels) : '', stderr: '', code: 0 };
      }, () => allowed), /Web session expired/);
      assert.deepEqual(calls, revokeAfter === 1 ? [inspect] : [inspect, pull]);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('S5 pull runner retains bounded output without killing a noisy download', async () => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killed = 0; child.kill = () => { killed++; return true; };
  const result = runDocker(['compose', '-p', 'project', 'pull', 'web'], (() => child) as any);
  child.stdout.emit('data', Buffer.alloc(DOCKER_OUTPUT_LIMIT + 100, 'a'));
  child.stderr.emit('data', Buffer.from('extra'));
  child.emit('close', 0);
  const output = await result;
  assert.equal(output.stdout.length, DOCKER_OUTPUT_LIMIT);
  assert.equal(output.stderr, ''); assert.equal(output.code, 0); assert.equal(killed, 0);
});

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

test('S4.1 disabled auth allows same-origin Docker requests but rejects invalid origins', async () => {
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  let calls = 0;
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => { const layer = layers[i++]; if (!layer) { res.writeHead(404); res.end(); return; } if (layer.route && req.url !== layer.route) return next(); void layer.handler(req, res, next); };
    next();
  });
  (installWebApi as any)(app, server, { enabled: false }, { enabled: false }, { dockerRunner: async () => { calls++; return { stdout: '', stderr: '', code: 0 }; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const response = await fetch(`${base}/api/docker`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { containers: [] });
    assert.equal(calls, 1);
    const rejected = await fetch(`${base}/api/docker`, { method: 'POST', headers: { origin: 'http://evil.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: 'Origin validation failed' });
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
