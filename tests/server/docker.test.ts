import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installWebApi, type Middleware } from '@server/web-api';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The injected runner is the only Docker boundary: these tests never invoke Docker.
async function fixture(enabled = true, sessionTtlMs = 60_000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-update-test-'));
  const config = path.join(dir, 'compose.yml');
  await fs.writeFile(config, 'services:\n  web:\n    image: app:latest\n');
  let labels: Record<string, string> = { 'com.docker.compose.project': 'project-one', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': dir, 'com.docker.compose.project.config_files': config };
  let failedCompose = '';
  const calls: string[][] = [];
  let fail = false;
  let running = false;
  let stream: ((args: string[], onOutput?: (stream: string, text: string) => void) => Promise<void>) | undefined;
  const runner = async (args: string[], onOutput?: (stream: string, text: string) => void) => {
    calls.push([...args]);
    if (fail) return { stdout: '', stderr: 'daemon unavailable', code: 1 };
    if (args[0] === 'ps') return { stdout: [
      JSON.stringify({ ID: 'aaaaaaaaaaaa', Names: 'alpha', State: 'running', Status: 'Up', Labels: 'com.docker.compose.project=one' }),
      JSON.stringify({ ID: 'bbbbbbbbbbbb', Names: 'beta', State: 'exited', Status: 'Exited', Labels: 'com.docker.compose.project=two' }),
      JSON.stringify({ ID: 'cccccccccccc', Names: 'standalone', State: 'exited', Status: 'Exited', Labels: '' }),
    ].join('\n'), stderr: '', code: 0 };
    if (args[0] === 'inspect') return { stdout: args[2] === '{{json .Config.Labels}}' ? JSON.stringify(labels) : args[2] === '{{.Config.Image}}' ? 'app:latest\n' : running ? 'running' : 'exited', stderr: '', code: 0 };
    if (args[0] === 'compose' && stream) await stream(args, onOutput);
    if (args[0] === 'compose' && failedCompose && args.includes(failedCompose)) return { stdout: '', stderr: `${failedCompose} failed`, code: 1 };
    if (args[0] === 'logs') return { stdout: 'bounded log', stderr: '', code: 0 };
    return { stdout: 'ok', stderr: '', code: 0 };
  };
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  let maxQueued = 0;
  const server = http.createServer((req, res) => {
    const write = res.write.bind(res);
    (res as any).write = (...args: any[]) => { const result = (write as any)(...args); maxQueued = Math.max(maxQueued, res.writableLength); return result; };
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
  return { calls, login, logout, request, dir, config, maxQueued: () => maxQueued, setStream(value: typeof stream) { stream = value; }, setLabels(value: Record<string, string>) { labels = value; }, setFailedCompose(value: string) { failedCompose = value; }, setFail(value: boolean) { fail = value; }, setRunning(value: boolean) { running = value; }, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('S6.1 HTTP sends output before pull finishes and then recreates', async () => {
  const f = await fixture(false);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setStream(async (args, output) => {
    if (args.includes('pull')) { output?.('stdout', 'pull-live\n'); await gate; }
    else output?.('stderr', 'recreate-live\n');
  });
  try {
    const request = f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true });
    const early = await Promise.race([request, new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
    assert.ok(early, 'response must start before pull completes');
    assert.match(early.headers.get('content-type') ?? '', /ndjson/i);
    const reader = early.body!.getReader();
    const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no live output')), 500))]);
    assert.match(new TextDecoder().decode(first.value), /pull/);
    release();
    let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    assert.match(rest, /recreate-live/); assert.match(rest, /"ok":true/);
    assert.equal(f.calls.length, 3);
  } finally { release(); await f.close(); }
});

async function liveResponse(promise: Promise<Response>): Promise<Response> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no live response')), 1000); })]); }
  finally { clearTimeout(timer!); }
}

test('S4 S6 live revocation suppresses later output and prevents recreation', { timeout: 5000 }, async () => {
  const f = await fixture(true);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setStream(async (args, output) => {
    if (args.includes('pull')) { output?.('stdout', 'before-revocation'); await gate; output?.('stderr', 'secret-after-revocation'); }
  });
  try {
    const cookie = await f.login();
    const response = await liveResponse(f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true }, cookie));
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('before-revocation')) { const item = await reader.read(); if (item.done) break; text += new TextDecoder().decode(item.value); }
    assert.match(text, /before-revocation/);
    assert.equal((await f.logout(cookie)).status, 200);
    release();
    while (true) { const item = await reader.read(); if (item.done) break; text += new TextDecoder().decode(item.value); }
    assert.doesNotMatch(text, /secret-after-revocation|"ok":true/);
    assert.equal(f.calls.length, 2); assert.ok(f.calls[1].includes('pull'));
  } finally { release(); await f.close(); }
});

test('S6 disconnect does not cancel an already started deployment', { timeout: 5000 }, async () => {
  const f = await fixture(false);
  let release!: () => void; let completed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  f.setStream(async (args, output) => {
    if (args.includes('pull')) { output?.('stdout', 'started'); await gate; }
    else { output?.('stdout', 'recreated'); completed(); }
  });
  try {
    const response = await liveResponse(f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true }));
    const reader = response.body!.getReader();
    const first = await reader.read(); assert.equal(first.done, false);
    await reader.cancel(); release(); await done;
    assert.equal(f.calls.length, 3); assert.ok(f.calls[2].includes('up'));
  } finally { release(); await f.close(); }
});

test('S6 transport remains bounded for a slow reader and large producer output', { timeout: 5000 }, async () => {
  const f = await fixture(false);
  let completed!: () => void; let callbacks = 0;
  const done = new Promise<void>(resolve => { completed = resolve; });
  f.setStream(async (args, output) => {
    if (args.includes('pull')) { assert.equal(typeof output, 'function'); for (let i = 0; i < 128; i++) { output!('stdout', 'x'.repeat(65536)); callbacks++; } }
    else completed();
  });
  try {
    const response = await f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true });
    await done;
    assert.equal(callbacks, 128);
    assert.ok(f.maxQueued() > 0 && f.maxQueued() <= 1024 * 1024, `queued ${f.maxQueued()} bytes`);
    await response.body?.cancel();
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test('S5.1 confirmed update uses inspected original Compose context for only selected service', async () => {
  const f = await fixture(false);
  try {
    const response = await f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true, project: 'evil', service: '--help', image: '--help', path: 'evil' });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /ndjson/i);
    assert.match(await response.text(), /"ok":true/);
    const prefix = ['compose', '-p', 'project-one', '--project-directory', f.dir, '-f', f.config];
    assert.deepEqual(f.calls, [['inspect', '--format', '{{json .Config.Labels}}', 'bbbbbbbbbbbb'], [...prefix, 'pull', 'web'], [...prefix, 'up', '-d', '--no-deps', '--force-recreate', 'web']]);
  } finally { await f.close(); }
});

test('S5.2 cancellation, missing metadata and inaccessible original files cannot update', async () => {
  const f = await fixture(false);
  try {
    const cancelled = await f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: false });
    assert.notEqual(cancelled.status, 200); assert.deepEqual(f.calls, []);
    for (const labels of [{}, { 'com.docker.compose.project': 'project-one' }, { 'com.docker.compose.project': 'project-one', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': f.dir, 'com.docker.compose.project.config_files': path.join(f.dir, 'missing.yml') }] as Record<string, string>[]) {
      f.setLabels(labels); f.calls.length = 0;
      const result = await f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true });
      assert.notEqual(result.status, 200); assert.match(JSON.stringify(await result.json()), /compose|unavailable|configuration/i);
      assert.deepEqual(f.calls, [['inspect', '--format', '{{json .Config.Labels}}', 'bbbbbbbbbbbb']]);
    }
  } finally { await f.close(); }
});

test('S5.2 pull failure stops before up; up failure reports partial update without rollback', async () => {
  const f = await fixture(false);
  try {
    const prefix = ['compose', '-p', 'project-one', '--project-directory', f.dir, '-f', f.config];
    for (const failure of ['pull', 'up']) {
      f.calls.length = 0; f.setFailedCompose(failure);
      const response = await f.request({ action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /ndjson/i);
      const error = await response.text();
      assert.match(error, new RegExp(`${failure} failed`, 'i'));
      if (failure === 'up') assert.match(error, /partial|downloaded|pulled/i);
      assert.deepEqual(f.calls, [['inspect', '--format', '{{json .Config.Labels}}', 'bbbbbbbbbbbb'], [...prefix, 'pull', 'web'], ...(failure === 'up' ? [[...prefix, 'up', '-d', '--no-deps', '--force-recreate', 'web']] : [])]);
    }
  } finally { await f.close(); }
});

test('S5 update HTTP requires enabled authentication and same origin', async () => {
  for (const enabled of [false, true]) {
    const f = await fixture(enabled);
    try {
      const body = { action: 'updateImage', containerId: 'bbbbbbbbbbbb', confirmed: true };
      if (enabled) { assert.equal((await f.request(body)).status, 401); assert.deepEqual(f.calls, []); }
      const cookie = enabled ? await f.login() : '';
      assert.equal((await f.request(body, cookie, 'http://evil.invalid')).status, 403); assert.deepEqual(f.calls, []);
      assert.equal((await f.request(body, cookie)).status, 200);
      assert.equal(f.calls.length, 3);
    } finally { await f.close(); }
  }
});

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

test('S4.1 enabled auth denies anonymous requests before executing Docker', async () => {
  const f = await fixture();
  try {
    for (const action of ['list', 'start', 'stop', 'restart', 'remove', 'logs']) {
      const response = await f.request({ action, containerId: 'bbbbbbbbbbbb', confirmed: true });
      assert.equal(response.status, 401);
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
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
