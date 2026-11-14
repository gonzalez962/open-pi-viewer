import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { installWebApi, type Middleware } from '@server/web-api';

// All paths and file contents in these tests are disposable fixtures, never host configuration.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docker-files-test-'));
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  await mkdir(one); await mkdir(two);
  const yaml = path.join(one, 'compose.yaml');
  const yml = path.join(two, 'extra.yml');
  const env = path.join(one, '.env');
  await writeFile(yaml, 'services:\n  app:\n    image: example\n    env_file: .env\n');
  await writeFile(yml, 'services:\n  worker:\n    image: example\n');
  await writeFile(env, 'VALUE=original\n');
  let labels: Record<string, string> = {
    'com.docker.compose.project.config_files': `${yaml},${yml}`,
    'com.docker.compose.project.working_dir': one,
  };
  const calls: string[][] = [];
  let validationError = '';
  let validate: ((args: string[]) => Promise<void>) | undefined;
  const runner = async (args: string[]) => {
    calls.push([...args]);
    if (args[0] === 'inspect') return { stdout: JSON.stringify(labels), stderr: '', code: 0 };
    if (args[0] === 'compose') {
      await validate?.(args);
      return { stdout: '', stderr: validationError, code: validationError ? 1 : 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const layers: { route?: string; handler: Middleware }[] = [];
  const app = { use(route: string | Middleware, handler?: Middleware) { layers.push(typeof route === 'string' ? { route, handler: handler! } : { handler: route }); } };
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => { const layer = layers[i++]; if (!layer) { res.writeHead(404); res.end(); return; } if (layer.route && req.url !== layer.route) return next(); void layer.handler(req, res, next); };
    next();
  });
  installWebApi(app, server, { enabled: true, key: 'fixture-key', sessionTtlMs: 60_000 }, { available: false }, { dockerRunner: runner });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { origin: base, 'content-type': 'application/json' };
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ key: 'fixture-key' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = async (body: unknown, options: { origin?: string; cookie?: string } = {}) => {
    const response = await fetch(`${base}/api/docker`, { method: 'POST', headers: { ...headers, origin: options.origin ?? base, cookie: options.cookie ?? cookie }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const discover = () => request({ action: 'files', containerId: 'aaaaaaaaaaaa' });
  const open = (file: unknown) => request({ action: 'readFile', containerId: 'aaaaaaaaaaaa', file });
  const save = (file: unknown, version: unknown, content: string) => request({ action: 'saveFile', containerId: 'aaaaaaaaaaaa', file, version, content });
  return { root, one, yaml, yml, env, calls, request, discover, open, save, cookie,
    logout: () => fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...headers, cookie } }),
    setLabels(value: Record<string, string>) { labels = value; },
    setValidationError(value: string) { validationError = value; },
    onValidate(fn: (args: string[]) => Promise<void>) { validate = fn; },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
  };
}

// File descriptors returned by discovery are opaque to the client; the server rediscovers them.
function selected(files: any[], name: string) {
  const item = files.find(file => file.path === name);
  assert.ok(item, `missing discovered file ${name}`);
  return item;
}

test('S2.1 discovers compose files in different directories and sibling env without grants', async () => {
  const f = await fixture();
  try {
    const result = await f.discover();
    assert.equal(result.status, 200);
    for (const name of [f.yaml, f.yml, f.env]) {
      const opened = await f.open(selected(result.body.files, name));
      assert.equal(opened.status, 200);
      assert.equal(opened.body.content, await readFile(name, 'utf8'));
    }
  } finally { await f.close(); }
});

test('S2.2 missing metadata and missing files report unavailable without disabling controls', async () => {
  const f = await fixture();
  try {
    f.setLabels({});
    const missing = await f.discover();
    assert.notEqual(missing.status, 200);
    assert.match(JSON.stringify(missing.body), /unavailable|metadata/i);
    f.setLabels({ 'com.docker.compose.project.config_files': path.join(f.root, 'absent.yaml'), 'com.docker.compose.project.working_dir': f.one });
    const absent = await f.discover();
    assert.notEqual(absent.status, 200);
    assert.match(JSON.stringify(absent.body), /unavailable|not found|missing/i);
    assert.equal((await f.request({ action: 'start', containerId: 'aaaaaaaaaaaa' })).status, 200);
  } finally { await f.close(); }
});

test('S2.3 arbitrary paths and stale discovery identities cannot read or save', async () => {
  const f = await fixture();
  try {
    const discovered = await f.discover();
    assert.equal(discovered.status, 200);
    const file = selected(discovered.body.files, f.yaml);
    const opened = await f.open(file);
    assert.equal(opened.status, 200);
    const before = await readFile(f.yaml, 'utf8');
    const outside = path.join(f.root, 'other.yaml');
    await writeFile(outside, 'untouched');
    assert.notEqual((await f.open({ ...file, path: outside })).status, 200);
    assert.notEqual((await f.save({ ...file, path: outside }, opened.body.version, 'changed')).status, 200);
    f.setLabels({ 'com.docker.compose.project.config_files': f.yml, 'com.docker.compose.project.working_dir': f.one });
    assert.notEqual((await f.open(file)).status, 200);
    assert.notEqual((await f.save(file, opened.body.version, 'changed')).status, 200);
    assert.equal(await readFile(f.yaml, 'utf8'), before);
    assert.equal(await readFile(outside, 'utf8'), 'untouched');
  } finally { await f.close(); }
});

test('S3.1 saves raw YAML and env independently using candidate validation without lifecycle calls', async () => {
  const f = await fixture();
  try {
    const discovered = await f.discover();
    assert.equal(discovered.status, 200);
    for (const name of [f.yaml, f.env]) {
      const file = selected(discovered.body.files, name);
      const opened = await f.open(file);
      assert.equal(opened.status, 200);
      const candidate = name === f.env ? 'VALUE=candidate\n# raw\n' : 'services:\n  app:\n    image: changed\n    env_file: .env\n';
      const original = await readFile(name, 'utf8');
      f.onValidate(async args => {
        assert.ok(args.includes('config') && args.includes('--quiet'));
        assert.equal(await readFile(name, 'utf8'), original, 'original must not be overwritten during validation');
        // Candidate must be used as actual Compose input, including env_file references.
        const fileArgs = args.flatMap((arg, i) => ['-f', '--file', '--env-file'].includes(arg) ? [args[i + 1]] : []);
        const contents = await Promise.all(fileArgs.map(p => readFile(p, 'utf8').catch(() => '')));
        assert.ok(contents.some(content => content.includes(candidate)), 'validation must see candidate bytes');
        const yamlFiles = args.flatMap((arg, i) => arg === '-f' ? [args[i + 1]] : []);
        assert.equal(yamlFiles.length, 2);
        assert.equal(path.dirname(yamlFiles[0]), path.dirname(yamlFiles[1]));
        assert.equal(args[args.indexOf('--project-directory') + 1], path.dirname(yamlFiles[0]));
        const envPath = args[args.indexOf('--env-file') + 1];
        assert.equal(envPath, path.join(path.dirname(yamlFiles[0]), '.env'));
        assert.equal(await readFile(envPath, 'utf8'), name === f.env ? candidate : await readFile(f.env, 'utf8'));
      });
      const saved = await f.save(file, opened.body.version, candidate);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(await readFile(name, 'utf8'), candidate);
    }
    assert.ok(!f.calls.some(args => ['start', 'stop', 'restart', 'up', 'down', 'rm'].includes(args[0])));
  } finally { await f.close(); }
});

test('S3.2 invalid configuration or inaccessible dependency preserves all originals', async () => {
  const f = await fixture();
  try {
    const discovered = await f.discover();
    assert.equal(discovered.status, 200);
    const file = selected(discovered.body.files, f.yaml);
    const opened = await f.open(file);
    const before = await Promise.all([f.yaml, f.yml, f.env].map(p => readFile(p, 'utf8')));
    for (const error of ['invalid compose configuration', 'dependency inaccessible']) {
      f.setValidationError(error);
      const result = await f.save(file, opened.body.version, 'invalid candidate');
      assert.notEqual(result.status, 200);
      assert.match(JSON.stringify(result.body), new RegExp(error));
      assert.deepEqual(await Promise.all([f.yaml, f.yml, f.env].map(p => readFile(p, 'utf8'))), before);
    }
  } finally { await f.close(); }
});

test('S3.3 concurrent edits and replaced files are rejected without overwriting', async () => {
  const f = await fixture();
  try {
    const discovered = await f.discover();
    assert.equal(discovered.status, 200);
    const file = selected(discovered.body.files, f.yaml);
    const opened = await f.open(file);
    await writeFile(f.yaml, 'concurrent edit');
    assert.notEqual((await f.save(file, opened.body.version, 'candidate')).status, 200);
    assert.equal(await readFile(f.yaml, 'utf8'), 'concurrent edit');
    const reopened = await f.open(file);
    assert.equal(reopened.status, 200);
    await writeFile(path.join(f.root, 'replacement'), 'replacement');
    await rename(path.join(f.root, 'replacement'), f.yaml);
    assert.notEqual((await f.save(file, reopened.body.version, 'candidate')).status, 200);
    assert.equal(await readFile(f.yaml, 'utf8'), 'replacement');
  } finally { await f.close(); }
});

test('S3.3 simultaneous viewer saves reject the second while the first validates', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const discovered = await f.discover();
    const file = selected(discovered.body.files, f.yaml);
    const opened = await f.open(file);
    const original = await readFile(f.yaml, 'utf8');
    f.onValidate(async () => { entered(); await gate; });
    const first = f.save(file, opened.body.version, 'first');
    await started;
    const second = f.save(file, opened.body.version, 'second');
    const outcome = await Promise.race([second, new Promise<null>(resolve => setTimeout(() => resolve(null), 300))]);
    assert.notEqual(outcome, null, 'second save must be rejected without waiting for validation');
    assert.notEqual(outcome!.status, 200);
    assert.equal(await readFile(f.yaml, 'utf8'), original);
    release();
    assert.equal((await first).status, 200);
    assert.equal(await readFile(f.yaml, 'utf8'), 'first');
  } finally { release(); await f.close(); }
});

test('S4.2 same-origin live authenticated owner can edit; bad origin and revoked owner cannot', async () => {
  const f = await fixture();
  try {
    const denied = await f.request({ action: 'files', containerId: 'aaaaaaaaaaaa' }, { origin: 'http://evil.invalid' });
    assert.equal(denied.status, 403);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.discover()).status, 200);
    const count = f.calls.length;
    assert.equal((await f.logout()).status, 200);
    assert.equal((await f.discover()).status, 401);
    assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});
