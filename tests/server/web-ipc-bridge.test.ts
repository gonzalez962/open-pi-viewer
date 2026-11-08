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
  setPiAgentDirForTest,
  setSubprocessSpawnerForTest,
  resetPiRpcForTest,
  getSessionStatus,
  setSessionStatus,
  setSessionAliveChecker,
  sessionParseCache,
  invalidateSessionParseCache,
  parseSessionFile,
  isConversationMessage,
  parseEngramProjectFromStats,
  parseEngramCloudStatus,
  clearEngramCacheForTest,
  setProcessRunnerForTest,
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

test('server/bridge: subprocess spawner receives GENTLE_SHELL_INTERACTIVE_HOST=1 in environment', { timeout: 5000 }, async (t) => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-spawner-test-'));
  const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-spawner-agent-'));
  const tmpSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-spawner-sessions-'));
  setPiAgentDirForTest(tmpAgentDir);
  setSessionsRootDirForTest(tmpSessionsRoot);

  let notifySpawner!: (info: { cmd: string; args: string[]; env: any }) => void;
  const spawnerPromise = new Promise<{ cmd: string; args: string[]; env: any }>((resolve) => {
    notifySpawner = resolve;
  });

  setSubprocessSpawnerForTest((cmd, args, options) => {
    notifySpawner({ cmd, args, env: options.env });
    return null;
  });

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    setPiAgentDirForTest(null);
    setSessionsRootDirForTest(null);
    resetPiRpcForTest();
    try {
      fs.rmSync(tmpProject, { recursive: true, force: true });
      fs.rmSync(tmpAgentDir, { recursive: true, force: true });
      fs.rmSync(tmpSessionsRoot, { recursive: true, force: true });
    } catch {}
  });

  await handleIpcCommand('connect', {
    payload: { workingDirectory: tmpProject },
  });

  const spawned = await spawnerPromise;
  assert.ok(spawned, 'Spawner must be called');
  assert.strictEqual(spawned.env.GENTLE_SHELL_INTERACTIVE_HOST, '1');
  assert.ok(spawned.args.includes('--mode'), 'Args must include --mode');
  assert.ok(spawned.args.includes('rpc'), 'Args must include rpc');
  assert.ok(spawned.args.includes('--approve'), 'Args must include --approve');
  assert.strictEqual(spawned.args.includes('--no-extensions'), false, 'Spawner must not inject blanket --no-extensions');
  assert.strictEqual(spawned.args.includes('--no-mcp'), false, 'Spawner must not inject blanket --no-mcp');
  assert.strictEqual(
    fs.existsSync(path.join(tmpAgentDir, 'settings.json')),
    false,
    'Startup config must not perform unintended writes'
  );
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

test('server/bridge: windowing ignores activity blocks so prior conversations are not hidden', async (t) => {
  setSubprocessSpawnerForTest(() => null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-activity-window-test-'));
  const filePath = path.join(tmpDir, 'sess-activity.jsonl');

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    resetPiRpcForTest();
    invalidateSessionParseCache(filePath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const header = { type: 'session', version: 3, id: 'sess-activity-1', timestamp: new Date().toISOString() };
  let content = JSON.stringify(header) + '\n';

  // Turn 1: user prompt + assistant reply
  content += JSON.stringify({
    type: 'message',
    message: { id: 'turn1-user', role: 'user', content: 'Create a plan' },
  }) + '\n';
  content += JSON.stringify({
    type: 'message',
    message: { id: 'turn1-asst', role: 'assistant', content: 'Here is the plan' },
  }) + '\n';

  // Turn 2: user prompt + 35 tool calls + 35 tool results + final assistant reply (72 messages in this turn)
  content += JSON.stringify({
    type: 'message',
    message: { id: 'turn2-user', role: 'user', content: 'Execute the plan' },
  }) + '\n';
  for (let i = 0; i < 35; i++) {
    content += JSON.stringify({
      type: 'message',
      message: {
        id: `turn2-toolcall-${i}`,
        role: 'assistant',
        content: [{ type: 'tool_call', id: `call-${i}`, name: 'bash', arguments: { command: `ls -la ${i}` } }],
      },
    }) + '\n';
    content += JSON.stringify({
      type: 'message',
      message: {
        id: `turn2-toolresult-${i}`,
        role: 'toolResult',
        toolCallId: `call-${i}`,
        content: `Output for step ${i}`,
      },
    }) + '\n';
  }
  content += JSON.stringify({
    type: 'message',
    message: { id: 'turn2-asst', role: 'assistant', content: 'Execution complete' },
  }) + '\n';

  fs.writeFileSync(filePath, content, 'utf8');

  // Total messages: 1 (turn1 user) + 1 (turn1 asst) + 1 (turn2 user) + 70 (activity) + 1 (turn2 asst) = 74 messages.
  // Conversational messages: 4.
  // With default limit = 60, activity blocks should NOT push out Turn 1 or Turn 2 user prompt.
  const res: any = await handleIpcCommand('switch_session', {
    payload: { sessionPath: filePath },
  });

  assert.strictEqual(res.cancelled, false);
  assert.strictEqual(res.messageCount, 4);
  // All 74 messages must be returned because conversational count (4) <= limit (60)
  assert.strictEqual(res.messages.length, 74);
  assert.strictEqual(res.hasMore, false);
  assert.strictEqual(res.messages[0].id, 'turn1-user');
  assert.strictEqual(res.messages[res.messages.length - 1].id, 'turn2-asst');
});

test('server/bridge: windowing expands to turn boundary to preserve user prompt and tool pairings', async (t) => {
  setSubprocessSpawnerForTest(() => null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-boundary-window-test-'));
  const filePath = path.join(tmpDir, 'sess-boundary.jsonl');

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    resetPiRpcForTest();
    invalidateSessionParseCache(filePath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const header = { type: 'session', version: 3, id: 'sess-boundary-1', timestamp: new Date().toISOString() };
  let content = JSON.stringify(header) + '\n';

  // Create 15 turns, each with user + 2 tool calls + 2 tool results + assistant text
  for (let tIdx = 0; tIdx < 15; tIdx++) {
    content += JSON.stringify({
      type: 'message',
      message: { id: `user-${tIdx}`, role: 'user', content: `Prompt ${tIdx}` },
    }) + '\n';
    content += JSON.stringify({
      type: 'message',
      message: {
        id: `toolcall-${tIdx}-0`,
        role: 'assistant',
        content: [{ type: 'tool_call', id: `c-${tIdx}-0`, name: 'read', args: { path: `f${tIdx}.txt` } }],
      },
    }) + '\n';
    content += JSON.stringify({
      type: 'message',
      message: {
        id: `toolresult-${tIdx}-0`,
        role: 'toolResult',
        toolCallId: `c-${tIdx}-0`,
        content: `file content ${tIdx}`,
      },
    }) + '\n';
    content += JSON.stringify({
      type: 'message',
      message: { id: `asst-${tIdx}`, role: 'assistant', content: `Answer ${tIdx}` },
    }) + '\n';
  }

  fs.writeFileSync(filePath, content, 'utf8');

  // Limit = 6 conversational messages -> should cover the last 3 complete turns (turns 12, 13, 14)
  // Each turn has 4 raw messages (user + toolcall + toolresult + asst)
  // 3 turns * 4 messages = 12 raw messages.
  const res: any = await handleIpcCommand('switch_session', {
    payload: { sessionPath: filePath, limit: 6 },
  });

  assert.strictEqual(res.cancelled, false);
  assert.strictEqual(res.hasMore, true);
  // Must start with user prompt of turn 12, never an orphaned tool or assistant response
  assert.strictEqual(res.messages[0].id, 'user-12');
  assert.strictEqual(res.messages[res.messages.length - 1].id, 'asst-14');
  assert.strictEqual(res.messages.length, 12);
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

test('server/bridge: IPC get_github_auth_status dispatches and returns status object', async () => {
  setProcessRunnerForTest(async (_file, args) => {
    if (args.includes('--version')) {
      return { stdout: 'gh version 2.45.0', stderr: '', exitCode: 0 };
    }
    if (args.includes('auth')) {
      return { stdout: 'Logged in as testuser', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const res: any = await handleIpcCommand('get_github_auth_status');
    assert.deepStrictEqual(res, { installed: true, authenticated: true, username: 'testuser' });
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('server/bridge: IPC clone_github_repository dispatches with payload or direct args', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-clone-test-'));
  const { setStorageFilePathForTest } = await import('@server/storage');
  setStorageFilePathForTest(path.join(tmpDir, 'storage.json'));
  t.after(() => {
    setStorageFilePathForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let capturedArgs: string[] = [];
  setProcessRunnerForTest(async (_file, args) => {
    capturedArgs = args;
    return { stdout: 'Cloned', stderr: '', exitCode: 0 };
  });

  try {
    // 1. Using direct args
    const resDirect: any = await handleIpcCommand('clone_github_repository', {
      repository: 'octocat/Hello-World',
      parentPath: tmpDir,
      token: 'ghp_ephemeral_token',
    });
    assert.strictEqual(resDirect.path, path.join(tmpDir, 'Hello-World'));

    // 2. Using payload wrapper
    const resPayload: any = await handleIpcCommand('clone_github_repository', {
      payload: {
        repository: 'octocat/Spoon-Knife',
        parentPath: tmpDir,
        token: 'ghp_ephemeral_token_2',
      },
    });
    assert.strictEqual(resPayload.path, path.join(tmpDir, 'Spoon-Knife'));
    assert.ok(capturedArgs.includes('clone'));
    assert.strictEqual(capturedArgs[capturedArgs.length - 1], path.join(tmpDir, 'Spoon-Knife'));
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('server/bridge: IPC create_github_repository dispatches with payload or direct args', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-create-storage-'));
  const { setStorageFilePathForTest } = await import('@server/storage');
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  setProcessRunnerForTest(async (file, args) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      return { stdout: 'Logged in to github.com account octocat', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('api')) {
      return {
        stdout: JSON.stringify({
          id: 555,
          name: 'ipc-created-repo',
          full_name: 'octocat/ipc-created-repo',
          owner: { login: 'octocat', type: 'User' },
          private: true,
          html_url: 'https://github.com/octocat/ipc-created-repo',
          clone_url: 'https://github.com/octocat/ipc-created-repo.git',
          fork: false,
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const resPayload: any = await handleIpcCommand('create_github_repository', {
      payload: {
        name: 'ipc-created-repo',
        isPrivate: true,
      },
    });
    assert.strictEqual(resPayload.repository.name, 'ipc-created-repo');
    assert.strictEqual(resPayload.repository.fullName, 'octocat/ipc-created-repo');
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('server/bridge: IPC preserves existing get_bridge_state dispatch', async () => {
  const state: any = await handleIpcCommand('get_bridge_state');
  assert.ok(state && typeof state === 'object');
  assert.strictEqual(state.connected, true);
  assert.strictEqual(typeof state.cwd, 'string');
  assert.ok(state.cwd.length > 0);
  assert.ok(path.isAbsolute(state.cwd));
});

test('server/bridge: session messageCount excludes tool-only activity and toolResults while counting conversation messages', async (t) => {
  setSubprocessSpawnerForTest(() => null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-count-test-'));
  const filePath = path.join(tmpDir, 'dummy-session.jsonl');

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    resetPiRpcForTest();
    invalidateSessionParseCache(filePath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Verify predicate semantics
  assert.strictEqual(isConversationMessage({ role: 'user', content: 'hello' }), true);
  assert.strictEqual(isConversationMessage({ role: 'assistant', content: [{ type: 'toolCall' }] }), false);
  assert.strictEqual(isConversationMessage({ role: 'toolResult', content: 'ok' }), false);
  assert.strictEqual(isConversationMessage({ role: 'assistant', content: 'text reply' }), true);
  assert.strictEqual(isConversationMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }), true);

  const header = { type: 'session', version: 3, id: 'dummy-sess-1', timestamp: new Date().toISOString() };
  let content = JSON.stringify(header) + '\n';

  // 1. User text message (countable)
  content += JSON.stringify({
    type: 'message',
    message: { id: 'msg-user-1', role: 'user', content: 'What is the current status?' },
  }) + '\n';

  // 2. Assistant message containing only a toolCall (excluded from count)
  content += JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-asst-toolcall',
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'status', arguments: {} }],
    },
  }) + '\n';

  // 3. ToolResult message (excluded from count)
  content += JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-toolresult-1',
      role: 'toolResult',
      toolCallId: 'call-1',
      content: 'All systems green',
    },
  }) + '\n';

  // 4. Assistant text reply (countable)
  content += JSON.stringify({
    type: 'message',
    message: { id: 'msg-asst-text', role: 'assistant', content: 'All systems are operating normally.' },
  }) + '\n';

  fs.writeFileSync(filePath, content, 'utf8');

  // Step 1 check: 4 raw messages in history, exactly 2 conversation messages
  const parsed = parseSessionFile(filePath);
  assert.ok(parsed);
  assert.strictEqual(parsed.messages.length, 4, 'Preserves all tool calls and results in history');
  assert.strictEqual(parsed.messageCount, 2, 'Excludes tool-only assistant entry and toolResult from message count');

  // Step 2: Mixed assistant content containing a conversation response + tool call (must be counted)
  content += JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-asst-mixed',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking disk usage...' },
        { type: 'toolCall', id: 'call-2', name: 'df', arguments: {} },
      ],
    },
  }) + '\n';

  // Followed by its toolResult (excluded)
  content += JSON.stringify({
    type: 'message',
    message: { id: 'msg-toolresult-2', role: 'toolResult', toolCallId: 'call-2', content: '/dev/sda1 40%' },
  }) + '\n';

  // Empty/whitespace assistant message (excluded)
  content += JSON.stringify({
    type: 'message',
    message: { id: 'msg-asst-empty', role: 'assistant', content: '   ' },
  }) + '\n';

  invalidateSessionParseCache(filePath);
  fs.writeFileSync(filePath, content, 'utf8');

  const parsedWithMixed = parseSessionFile(filePath);
  assert.ok(parsedWithMixed);
  assert.strictEqual(parsedWithMixed.messages.length, 7, 'All 7 entries preserved in history');
  assert.strictEqual(parsedWithMixed.messageCount, 3, 'User text (1) + assistant text (1) + mixed assistant (1) = 3');

  // Verify switch_session command returns the same conversation-only count
  const res: any = await handleIpcCommand('switch_session', {
    payload: { sessionPath: filePath },
  });
  assert.strictEqual(res.cancelled, false);
  assert.strictEqual(res.messageCount, 3);
  assert.strictEqual(res.messages.length, 7);
});
