import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { handleIpcCommand, parseEngramCloudStatus, clearEngramCacheForTest } from '@server/web-ipc-bridge';

const parse = parseEngramCloudStatus as (stdout: string, project?: string) => ReturnType<typeof parseEngramCloudStatus>;
const output = `Cloud status: configured (target=cloud)
Server: https://global.example/
Auth status: ready (token read from cloud.json)
Project remotes:
  - alpha: server=https://alpha.example/ token set, ****1234 remote_id=alpha-id
  - beta: server=https://beta.example/ token not set remote_id=beta-id
Project enrollment: enrolled (beta)
Local daemon: running on port 7437
`;

test('S1.1 selected remote overrides global and other project', () => {
  const status = parse(output, 'alpha');
  assert.equal(status.serverUrl, 'https://alpha.example/');
  assert.equal(status.authReady, true);
  assert.equal(status.configured, true);
});

test('S1.3 tokenless override does not inherit global auth or change enrollment', () => {
  const status = parse(output, 'beta');
  assert.equal(status.serverUrl, 'https://beta.example/');
  assert.equal(status.authReady, false);
  assert.equal(status.enrolled, true);
});

test('S1.2 canonical project name is preferred and cached over IPC', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-project-test-'));
  t.after(() => { clearEngramCacheForTest(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, '.engram'));
  const config = path.join(dir, '.engram', 'config.json');
  fs.writeFileSync(config, JSON.stringify({ project_name: 'canonical', name: 'legacy' }));
  clearEngramCacheForTest();
  assert.equal(await handleIpcCommand('get_engram_project', { payload: { cwd: dir } }), 'canonical');
  fs.writeFileSync(config, JSON.stringify({ project_name: 'changed' }));
  assert.equal(await handleIpcCommand('get_engram_project', { payload: { cwd: dir } }), 'canonical');
});

test('S1.3 fallback isolates project token and leaves enrollment unknown', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fallback-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.engram'));
  const cloud = path.join(dir, '.engram', 'cloud.json');
  const bridge = pathToFileURL(path.resolve('server/bridge/engram.ts')).href;
  const config = pathToFileURL(path.resolve('server/config.ts')).href;
  const script = `import { setBridgeConfig } from ${JSON.stringify(config)};
    import { getEngramCloudStatusImpl } from ${JSON.stringify(bridge)};
    setBridgeConfig({ baseWorkspace: process.env.HOME, engramBinary: 'missing-synthetic-engram', engramServerUrl: 'https://default.example/' });
    globalThis.fetch = async () => null;
    console.log(JSON.stringify(await getEngramCloudStatusImpl('beta', process.env.HOME)));`;
  for (const token of ['', 'synthetic-project-token']) {
    fs.writeFileSync(cloud, JSON.stringify({ server_url: 'https://global.example/', token: 'synthetic-global-token', projects: { beta: { server_url: 'https://beta.example/', token } } }));
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir },
    }));
    assert.equal(result.serverUrl, 'https://beta.example/');
    assert.equal(result.authReady, Boolean(token));
    assert.equal(result.enrolled, null);
  }
});

test('S1.4 CLI invalid override does not expose global remote or authentication', () => {
  const invalid = output.replace('  - beta: server=https://beta.example/ token not set remote_id=beta-id', '  - beta: invalid override (invalid server URL)');
  const status = parse(invalid, 'beta');
  assert.equal(status.configured, false);
  assert.equal(status.serverUrl, null);
  assert.equal(status.authReady, false);
  assert.equal(status.enrolled, true);
});

test('S1.4 fallback missing or invalid project URL does not expose global remote or authentication', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-invalid-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.engram'));
  const cloud = path.join(dir, '.engram', 'cloud.json');
  const bridge = pathToFileURL(path.resolve('server/bridge/engram.ts')).href;
  const config = pathToFileURL(path.resolve('server/config.ts')).href;
  const script = `import { setBridgeConfig } from ${JSON.stringify(config)};
    import { getEngramCloudStatusImpl } from ${JSON.stringify(bridge)};
    setBridgeConfig({ baseWorkspace: process.env.HOME, engramBinary: 'missing-synthetic-engram', engramServerUrl: 'https://default.example/' });
    globalThis.fetch = async () => null;
    console.log(JSON.stringify(await getEngramCloudStatusImpl('beta', process.env.HOME)));`;
  const results = [];
  for (const server_url of [undefined, '', 'ftp://host/', 'https://host/?query=1', 'https://host/#fragment']) {
    fs.writeFileSync(cloud, JSON.stringify({ server_url: 'https://global.example/', token: 'synthetic-global-token', projects: { beta: { server_url, token: 'synthetic-project-token' } } }));
    const status = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir },
    }));
    results.push([status.configured, status.serverUrl, status.authReady, status.enrolled]);
  }
  assert.deepEqual(results, Array.from({ length: 5 }, () => [false, null, false, null]));
});

test('S2.1 base status remains global with selected project', () => {
  const base = `Cloud status: configured (target=cloud)\nServer: https://global.example/\nAuth status: ready\nProject enrollment: not enrolled (alpha)\nLocal daemon: running on port 7437\n`;
  assert.deepEqual(parse(base, 'alpha'), parse(base));
  const status = parse(base, 'alpha');
  assert.deepEqual([status.configured, status.serverUrl, status.authReady, status.enrolled, status.daemonRunning, status.daemonPort], [true, 'https://global.example/', true, false, true, 7437]);
});

test('S2.2 legacy project config remains supported over IPC', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-legacy-test-'));
  t.after(() => { clearEngramCacheForTest(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, '.engram'));
  fs.writeFileSync(path.join(dir, '.engram', 'config.json'), JSON.stringify({ project: 'legacy' }));
  clearEngramCacheForTest();
  assert.equal(await handleIpcCommand('get_engram_project', { payload: { cwd: dir } }), 'legacy');
});
