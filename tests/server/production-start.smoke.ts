import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const reserve = createServer();
await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
const address = reserve.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(resolve => reserve.close(() => resolve()));
const home = fs.mkdtempSync(path.join(process.cwd(), '.workspace-start-smoke-'));
const child = spawn(process.execPath, ['dist-server/start.js'], {
  env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(port),
    PI_VIEWER_AUTH_ENABLED: 'false', PI_VIEWER_TURNSTILE_SITE_KEY: '', PI_VIEWER_TURNSTILE_SECRET_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let errors = '';
child.stderr.on('data', data => { errors += data.toString(); });
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 15000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${errors}`)); });
    child.stdout.on('data', data => {
      if (data.toString().includes('Pi Viewer listening')) { clearTimeout(timer); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(!html.includes('/@vite/client'));
  const asset = html.match(/src="([^"]+\/assets\/[^\"]+\.js)"/) || html.match(/src="(\/assets\/[^\"]+\.js)"/);
  assert.ok(asset, 'compiled asset reference required');
  assert.equal((await fetch(new URL(asset[1], base))).status, 200);
  const ipc = await fetch(`${base}/api/ipc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'get_bridge_state' }) });
  assert.ok((await ipc.json()).result);
  const sse = await fetch(`${base}/api/events`);
  assert.match(sse.headers.get('content-type') || '', /text\/event-stream/);
  await sse.body?.cancel();
  console.log('PASS: compiled Node start serves frontend assets, IPC and SSE without dev');
} finally {
  child.kill('SIGTERM');
  await exited;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
