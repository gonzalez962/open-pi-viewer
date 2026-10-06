import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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
  resolveSessionsDir,
  setSessionsRootDirForTest,
  setSubprocessSpawnerForTest,
  resetPiRpcForTest,
  getSessionStatus,
  setSessionStatus,
  setSessionAliveChecker,
  sessionParseCache,
  invalidateSessionParseCache,
  parseSessionFile,
  parseEngramProjectFromStats,
  parseEngramCloudStatus,
  clearEngramCacheForTest,
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

test('server/bridge: resolveSessionsDir isolates projects with same basename and avoids fuzzy matching', (t) => {
  const tmpSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-sessions-root-'));
  setSessionsRootDirForTest(tmpSessionsRoot);

  t.after(() => {
    setSessionsRootDirForTest(null);
    fs.rmSync(tmpSessionsRoot, { recursive: true, force: true });
  });

  // Project A has sessions in safe directory
  const cwdA = path.resolve('tmp-fake-alpha', 'client');
  const dirA = resolveSessionsDir(cwdA);
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(
    path.join(dirA, '2026-01-01_sess-alpha.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'sess-alpha', timestamp: '2026-01-01', cwd: cwdA }) + '\n'
  );

  // Project B has identical basename ("client") but in a distinct location
  const cwdB = path.resolve('tmp-fake-beta', 'client');
  const dirB = resolveSessionsDir(cwdB);

  // Must NOT fuzzy-match project A's directory
  assert.notStrictEqual(dirB, dirA, 'Projects with distinct paths must resolve to distinct session directories');
  assert.ok(!dirB.includes('alpha'), 'Project B session directory must not point to project A');
});

test('server/bridge: connect to empty project creates and persists a new session file', async (t) => {
  const tmpSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-sessions-empty-'));
  const tmpEmptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-project-empty-'));
  setSessionsRootDirForTest(tmpSessionsRoot);
  setSubprocessSpawnerForTest(() => null);

  t.after(() => {
    setSessionsRootDirForTest(null);
    setSubprocessSpawnerForTest(null);
    resetPiRpcForTest();
    fs.rmSync(tmpSessionsRoot, { recursive: true, force: true });
    fs.rmSync(tmpEmptyProject, { recursive: true, force: true });
  });

  const res: any = await handleIpcCommand('connect', {
    payload: { workingDirectory: tmpEmptyProject },
  });

  assert.strictEqual(res.connected, true);
  assert.ok(res.sessionId, 'Connect must return a non-empty sessionId');
  assert.ok(res.sessionFile, 'Connect must return a persisted sessionFile path for an empty project');
  assert.ok(fs.existsSync(res.sessionFile), 'Session file must exist on disk');

  const content = fs.readFileSync(res.sessionFile, 'utf8');
  const header = JSON.parse(content.split('\n')[0]);
  assert.strictEqual(header.type, 'session');
  assert.strictEqual(header.id, res.sessionId);

  // Subsequent list_sessions must discover this persisted session
  const list: any = await handleIpcCommand('list_sessions', {
    payload: { workingDirectory: tmpEmptyProject },
  });
  assert.strictEqual(list.length, 1, 'list_sessions must discover the created session');
  assert.strictEqual(list[0].id, res.sessionId);
});

test('server/bridge: subprocess spawner receives GENTLE_SHELL_INTERACTIVE_HOST=1 in environment', async (t) => {
  let capturedEnv: any = null;
  setSubprocessSpawnerForTest((_cmd, _args, options) => {
    capturedEnv = options.env;
    return null;
  });
  t.after(() => {
    setSubprocessSpawnerForTest(null);
    resetPiRpcForTest();
  });

  await handleIpcCommand('connect', {
    payload: { workingDirectory: process.cwd() },
  });

  assert.ok(capturedEnv, 'Spawner must be called');
  assert.strictEqual(capturedEnv.GENTLE_SHELL_INTERACTIVE_HOST, '1');
});

test('server/bridge: getSessionStatus automatically drops zombie sessions from working/waiting to completed', (t) => {
  const fakeSessionPath = path.resolve('fake-session-test.jsonl');
  const anotherPath = path.resolve('another-alive-session.jsonl');
  let isProcessAlive = false;

  setSessionAliveChecker((norm) => (norm === fakeSessionPath || norm === anotherPath) && isProcessAlive);
  t.after(() => {
    setSessionAliveChecker(() => false);
  });

  // 1. Alive process preserves 'working'
  isProcessAlive = true;
  setSessionStatus(fakeSessionPath, 'working');
  assert.strictEqual(getSessionStatus(fakeSessionPath), 'working');

  // 2. Dead process immediately drops 'working' to 'completed'
  isProcessAlive = false;
  assert.strictEqual(getSessionStatus(fakeSessionPath), 'completed');

  // 3. Dead process with 'waiting' immediately drops to 'completed'
  isProcessAlive = false;
  setSessionStatus(fakeSessionPath, 'waiting');
  assert.strictEqual(getSessionStatus(fakeSessionPath), 'completed');

  // 4. Alive process with no recorded status returns completed
  isProcessAlive = true;
  assert.strictEqual(getSessionStatus(anotherPath), 'completed');
});

test('server/bridge: sessionParseCache caches parsed sessions and invalidates on modification', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parse-cache-test-'));
  const filePath = path.join(tmpDir, 'test-cache-sess.jsonl');

  t.after(() => {
    invalidateSessionParseCache(filePath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const header = { type: 'session', version: 3, id: 'cache-sess-1', timestamp: new Date().toISOString() };
  const msg1 = { type: 'message', message: { role: 'user', content: 'hello cache' } };
  fs.writeFileSync(filePath, JSON.stringify(header) + '\n' + JSON.stringify(msg1) + '\n', 'utf8');

  // First parse puts entry into sessionParseCache
  const parsed1 = parseSessionFile(filePath);
  assert.ok(parsed1);
  assert.strictEqual(parsed1.id, 'cache-sess-1');
  assert.strictEqual(parsed1.messageCount, 1);
  assert.ok(sessionParseCache.has(filePath));

  // Second parse reads from cache
  const parsed2 = parseSessionFile(filePath);
  assert.strictEqual(parsed2?.id, 'cache-sess-1');

  // Invalidate cache explicitly
  invalidateSessionParseCache(filePath);
  assert.strictEqual(sessionParseCache.has(filePath), false);

  // Re-parse re-populates cache
  const parsed3 = parseSessionFile(filePath);
  assert.strictEqual(parsed3?.id, 'cache-sess-1');
  assert.ok(sessionParseCache.has(filePath));
});

test('server/bridge: switch_session honors sliding window limit, loadAll, and hasMore flag', async (t) => {
  setSubprocessSpawnerForTest(() => null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-switch-window-test-'));
  const filePath = path.join(tmpDir, 'sess-large.jsonl');

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    resetPiRpcForTest();
    invalidateSessionParseCache(filePath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const header = { type: 'session', version: 3, id: 'sess-large-1', timestamp: new Date().toISOString() };
  let content = JSON.stringify(header) + '\n';
  for (let i = 0; i < 100; i++) {
    content += JSON.stringify({
      type: 'message',
      message: { id: `m-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `Message #${i}` },
    }) + '\n';
  }
  fs.writeFileSync(filePath, content, 'utf8');

  // 1. Default windowing (limit = 60)
  const resDefault: any = await handleIpcCommand('switch_session', {
    payload: { sessionPath: filePath },
  });
  assert.strictEqual(resDefault.cancelled, false);
  assert.strictEqual(resDefault.messageCount, 100);
  assert.strictEqual(resDefault.messages.length, 60);
  assert.strictEqual(resDefault.hasMore, true);
  assert.strictEqual(resDefault.messages[0].id, 'm-40');
  assert.strictEqual(resDefault.messages[59].id, 'm-99');

  // 2. Custom limit (limit = 10)
  const resLimit: any = await handleIpcCommand('switch_session', {
    payload: { sessionPath: filePath, limit: 10 },
  });
  assert.strictEqual(resLimit.messages.length, 10);
  assert.strictEqual(resLimit.hasMore, true);
  assert.strictEqual(resLimit.messages[0].id, 'm-90');
  assert.strictEqual(resLimit.messages[9].id, 'm-99');

  // 3. loadAll = true (returns all 100 messages, hasMore = false)
  const resLoadAll: any = await handleIpcCommand('switch_session', {
    payload: { sessionPath: filePath, loadAll: true },
  });
  assert.strictEqual(resLoadAll.messages.length, 100);
  assert.strictEqual(resLoadAll.hasMore, false);
  assert.strictEqual(resLoadAll.messages[0].id, 'm-0');
  assert.strictEqual(resLoadAll.messages[99].id, 'm-99');
});

test('server/bridge: Engram project and cloud status caches avoid repetitive subshell calls', async (t) => {
  clearEngramCacheForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-engram-test-'));
  const engramDir = path.join(tmpDir, '.engram');
  fs.mkdirSync(engramDir, { recursive: true });
  fs.writeFileSync(path.join(engramDir, 'config.json'), JSON.stringify({ name: 'cached-test-project' }), 'utf8');

  t.after(() => {
    clearEngramCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test get_engram_project fast-path and memory caching
  const proj1 = await handleIpcCommand('get_engram_project', { payload: { cwd: tmpDir } });
  assert.strictEqual(proj1, 'cached-test-project');

  // Second call must hit memory cache instantly
  const start2 = Date.now();
  const proj2 = await handleIpcCommand('get_engram_project', { payload: { cwd: tmpDir } });
  const elapsed2 = Date.now() - start2;
  assert.strictEqual(proj2, 'cached-test-project');
  assert.ok(elapsed2 < 10, 'Cached lookup must resolve in < 10ms');

  // Test get_engram_cloud_status cache hit
  const status1 = await handleIpcCommand('get_engram_cloud_status', { payload: { project: 'test-p', cwd: tmpDir } });
  const startStatus2 = Date.now();
  const status2 = await handleIpcCommand('get_engram_cloud_status', { payload: { project: 'test-p', cwd: tmpDir } });
  const elapsedStatus2 = Date.now() - startStatus2;
  assert.deepStrictEqual(status1, status2);
  assert.ok(elapsedStatus2 < 10, 'Cached cloud status lookup must resolve in < 10ms');
});

test('server/bridge: parseEngramProjectFromStats extracts project name and handles none yet', () => {
  const sample1 = `
Engram Memory Stats
  Sessions:     188
  Observations: 245
  Prompts:      438
  Projects:     my-real-project
  Database:     C:\\Users\\Personal\\.engram/engram.db
`;
  assert.strictEqual(parseEngramProjectFromStats(sample1), 'my-real-project');

  const sample2 = `
Engram Memory Stats
  Projects:     none yet
`;
  assert.strictEqual(parseEngramProjectFromStats(sample2), null);

  const sample3 = `Projects:`;
  assert.strictEqual(parseEngramProjectFromStats(sample3), null);

  const sampleEmpty = `No projects section here`;
  assert.strictEqual(parseEngramProjectFromStats(sampleEmpty), null);
});

test('server/bridge: parseEngramCloudStatus parses real CLI output accurately', () => {
  const stdout = `
Cloud status: configured (target=cloud)
Server: https://memory.myshortener.xyz/
Server source: cloud.json
Auth status: ready (token read from cloud.json)
Sync readiness: ready for explicit --project sync (project must be enrolled)
Project remotes:
  - adbuho: server=https://engram.marketcat.io token set, ****Sceg remote_id=33472dba5886
Project enrollment: not enrolled (open-pi-viewer)
Local daemon: running on port 7437
`;
  const parsed = parseEngramCloudStatus(stdout);
  assert.strictEqual(parsed.configured, true);
  assert.strictEqual(parsed.serverUrl, 'https://memory.myshortener.xyz/');
  assert.strictEqual(parsed.authReady, true);
  assert.strictEqual(parsed.enrolled, false);
  assert.strictEqual(parsed.daemonRunning, true);
  assert.strictEqual(parsed.daemonPort, 7437);
});
