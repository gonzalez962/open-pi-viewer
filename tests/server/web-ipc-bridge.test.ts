import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  getHomeDir,
  discoverNodeExecutable,
  discoverEngramBinary,
  getAgnosticExecEnv,
  loadBridgeConfig,
} from '@server/config';
import {
  resolveCrossPlatformCwd,
  handleIpcCommand,
} from '@server/web-ipc-bridge';

test('server/config: getHomeDir returns non-empty user home', () => {
  const home = getHomeDir();
  assert.ok(typeof home === 'string' && home.length > 0);
  assert.strictEqual(home, process.env.HOME || process.env.USERPROFILE || os.homedir());
});

test('server/config: discoverNodeExecutable falls back to process.execPath', () => {
  const exec = discoverNodeExecutable();
  assert.strictEqual(exec, process.execPath);
});

test('server/config: discoverNodeExecutable ignores non-existent custom path and falls back', () => {
  const exec = discoverNodeExecutable('non/existent/node/binary/path');
  assert.strictEqual(exec, process.execPath);
});

test('server/config: discoverEngramBinary returns a valid string without throwing', () => {
  const bin = discoverEngramBinary();
  assert.ok(typeof bin === 'string' && bin.length > 0);
});

test('server/config: getAgnosticExecEnv contains valid augmented PATH', () => {
  const env = getAgnosticExecEnv();
  assert.ok(env.PATH && env.PATH.length > 0);
  // Must preserve current PATH entries
  if (process.env.PATH) {
    const segments = process.env.PATH.split(path.delimiter);
    assert.ok(segments.some((s) => env.PATH!.includes(s)));
  }
});

test('server/config: loadBridgeConfig provides honest defaults', () => {
  const config = loadBridgeConfig();
  assert.ok(typeof config.baseWorkspace === 'string' && config.baseWorkspace.length > 0);
  assert.strictEqual(config.nodeExecutable, process.execPath);
  assert.strictEqual(config.allowUnconfinedNavigation, true);
  assert.ok(typeof config.engramServerUrl === 'string');
});

test('server/bridge: resolveCrossPlatformCwd handles empty input with base workspace', () => {
  const resolvedEmpty = resolveCrossPlatformCwd('');
  const resolvedNull = resolveCrossPlatformCwd(null);
  assert.ok(path.isAbsolute(resolvedEmpty));
  assert.ok(path.isAbsolute(resolvedNull));
  assert.strictEqual(resolvedEmpty, resolvedNull);
});

test('server/bridge: resolveCrossPlatformCwd expands tilde paths', () => {
  const home = getHomeDir();
  const resolvedTilde = resolveCrossPlatformCwd('~');
  assert.strictEqual(resolvedTilde, home);

  const resolvedTildeSub = resolveCrossPlatformCwd('~/my-folder');
  assert.strictEqual(resolvedTildeSub, path.join(home, 'my-folder'));
});

test('server/bridge: resolveCrossPlatformCwd canonicalizes relative paths', () => {
  const resolved = resolveCrossPlatformCwd('.');
  assert.strictEqual(resolved, path.resolve('.'));
});

test('server/bridge: IPC pick_directory honors defaultPath when provided', async () => {
  const custom = path.resolve('docs');
  const res = await handleIpcCommand('pick_directory', { defaultPath: custom });
  assert.strictEqual(res, custom);
});

test('server/bridge: IPC pick_directory defaults to active or base workspace', async () => {
  const res = await handleIpcCommand('pick_directory', {});
  assert.ok(typeof res === 'string' && res.length > 0);
  assert.ok(path.isAbsolute(res));
});

test('server/bridge: IPC get_bridge_state reports connection and cwd', async () => {
  const state: any = await handleIpcCommand('get_bridge_state', {});
  assert.strictEqual(state.connected, true);
  assert.ok(typeof state.cwd === 'string' && state.cwd.length > 0);
  assert.ok(path.isAbsolute(state.cwd));
});

test('server/bridge: IPC browse_filesystem provides folders and dynamic shortcuts', async () => {
  const cwd = path.resolve('.');
  const res: any = await handleIpcCommand('browse_filesystem', { payload: { path: cwd } });

  assert.ok(res);
  assert.strictEqual(res.currentPath, cwd);
  assert.ok(Array.isArray(res.folders));
  assert.ok(Array.isArray(res.shortcuts));

  // Must not include ignored directories (.git, node_modules, dist)
  const folderNames = res.folders.map((f: any) => f.name);
  assert.ok(!folderNames.includes('.git'));
  assert.ok(!folderNames.includes('node_modules'));
  assert.ok(!folderNames.includes('dist'));

  // Shortcuts must include workspace and home
  const shortcutPaths = res.shortcuts.map((s: any) => s.path);
  assert.ok(shortcutPaths.includes(cwd) || shortcutPaths.some((p: string) => path.resolve(p) === cwd));
  assert.ok(shortcutPaths.includes(getHomeDir()));
});

test('server/bridge: IPC discover_environment reports discovered Node and valid entrypoint structure', async () => {
  const env: any = await handleIpcCommand('discover_environment', {});
  assert.ok(env);
  assert.strictEqual(env.nodePath, process.execPath);
  assert.ok(['ready', 'missing'].includes(env.status));
  assert.ok(env.entrypoint);
  assert.ok(['discovered', 'missing'].includes(env.entrypoint.status));
  assert.ok(env.initialDirectory);
  assert.strictEqual(env.initialDirectory.status, 'discovered');
  assert.ok(path.isAbsolute(env.initialDirectory.path));
});
