import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installWebApi, type Middleware } from '@server/web-api';

test('download HTTP S3 confines project and manual variants and preserves rejected sources', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-download-http-boundary-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const sibling = path.join(fixture, 'project-other');
  const external = path.join(fixture, 'external');
  fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(sibling); fs.mkdirSync(external);
  const bytes = Buffer.from([0, 255, 23]);
  const file = path.join(project, 'data.bin');
  const siblingFile = path.join(sibling, 'data.bin');
  fs.writeFileSync(file, bytes); fs.writeFileSync(siblingFile, bytes); fs.writeFileSync(path.join(external, 'data.bin'), bytes);
  fs.symlinkSync(external, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(sibling, path.join(project, 'prefix'), process.platform === 'win32' ? 'junction' : 'dir');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => { const layer = layers[i++]; if (!layer) { res.writeHead(404); res.end(); return; } if (layer.route && req.url !== layer.route) return next(); void layer.handler(req, res, next); };
    next();
  });
  installWebApi(app, server, { enabled: true, key: 'fixture-key' }, { enabled: false } as any);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const headers = { origin: base, 'content-type': 'application/json' };
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ key: 'fixture-key' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (payload: unknown) => fetch(`${base}/api/download`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(payload) });
    const success = await request({ workingDirectory: project, relativePath: 'data.bin' });
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('content-disposition'), "attachment; filename*=UTF-8''data.bin");
    assert.deepEqual(Buffer.from(await success.arrayBuffer()), bytes);
    for (const [payload, error] of [
      [{ sourcePath: file }, 'Access denied: outside download root'],
      [{ workingDirectory: project, relativePath: '../project-other/data.bin' }, 'Invalid download payload'],
      [{ workingDirectory: project, relativePath: siblingFile }, 'Invalid download payload'],
      [{ workingDirectory: project, relativePath: 'escape/data.bin' }, 'Access denied: outside download root'],
      [{ workingDirectory: project, relativePath: 'prefix/data.bin' }, 'Access denied: outside download root'],
      [{ workingDirectory: project, relativePath: 'data.bin', sourcePath: null }, 'Invalid download payload'],
      [{ sourcePath: file, relativePath: null }, 'Invalid download payload'],
      [{ workingDirectory: project, relativePath: null }, 'Invalid download payload'],
    ] as const) {
      const response = await request(payload);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error });
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.deepEqual(fs.readFileSync(siblingFile), bytes);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('home download web middleware enforces auth and origin and streams large exact bytes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-download-api-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const bytes = Buffer.alloc(25 * 1024 * 1024 + 1, 0xa5); bytes[bytes.length - 1] = 42;
  fs.writeFileSync(path.join(home, 'large.bin'), bytes);
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => { const layer = layers[i++]; if (!layer) { res.writeHead(404); res.end(); return; } if (layer.route && req.url !== layer.route) return next(); void layer.handler(req, res, next); };
    next();
  });
  installWebApi(app, server, { enabled: true, key: 'fixture-key' }, { enabled: false } as any);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const headers = { origin: base, 'content-type': 'application/json' };
    const request = (extra: Record<string, string> = {}) => fetch(`${base}/api/download`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ sourcePath: 'large.bin' }) });
    assert.equal((await request()).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ key: 'fixture-key' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request({ cookie, origin: 'http://evil.invalid' })).status, 403);
    const response = await request({ cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition')!, /large.bin/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const outside = await fetch(`${base}/api/download`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ sourcePath: '../outside.bin' }) });
    assert.equal(outside.status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
