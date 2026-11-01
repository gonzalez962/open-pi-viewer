import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PiRpcSession, resetPiRpcForTest } from '@server/bridge/rpc';
import { setSubprocessSpawnerForTest } from '@server/bridge/state';
import { TerminalSession, setPtySpawnerForTest } from '@server/terminal/terminal-session';
import { setStorageFilePathForTest, saveViewerStorage } from '@server/storage';

test('PRESERVE: Given githubPat is "ghp_validToken123", when a Pi RPC process is spawned, then its environment contains GH_TOKEN and GITHUB_TOKEN', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-s11-'));
  const testStorageFile = path.join(tmpDir, 'open-pi-viewer.json');
  setStorageFilePathForTest(testStorageFile);
  saveViewerStorage({ githubPat: 'ghp_validToken123' });

  let capturedEnv: any = null;
  setSubprocessSpawnerForTest((_cmd, _args, options) => {
    capturedEnv = options?.env;
    return null;
  });

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    setStorageFilePathForTest(null);
    resetPiRpcForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const session = new PiRpcSession();
  await session.ensureRunning(tmpDir);

  assert.ok(capturedEnv, 'Pi RPC spawner must be called');
  assert.strictEqual(capturedEnv.GH_TOKEN, 'ghp_validToken123');
  assert.strictEqual(capturedEnv.GITHUB_TOKEN, 'ghp_validToken123');
});

test('PRESERVE: Given githubPat is "ghp_validToken123", when a terminal session is initialized, then its PTY environment contains GH_TOKEN and GITHUB_TOKEN', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-s12-'));
  const testStorageFile = path.join(tmpDir, 'open-pi-viewer.json');
  setStorageFilePathForTest(testStorageFile);
  saveViewerStorage({ githubPat: 'ghp_validToken123' });

  let capturedOptions: any = null;
  setPtySpawnerForTest((_file, _args, options) => {
    capturedOptions = options;
    return {
      pid: 0,
      onData: () => {},
      onExit: () => {},
    };
  });

  t.after(() => {
    setPtySpawnerForTest(null);
    setStorageFilePathForTest(null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const session = new TerminalSession({ cwd: tmpDir, canonicalCwd: tmpDir });
  await session.kill();

  assert.ok(capturedOptions, 'PTY spawner must be called');
  assert.strictEqual(capturedOptions.env?.GH_TOKEN, 'ghp_validToken123');
  assert.strictEqual(capturedOptions.env?.GITHUB_TOKEN, 'ghp_validToken123');
});

test('S1.4: Given githubPat is null or whitespace, when Pi RPC or terminal is spawned, then GH_TOKEN and GITHUB_TOKEN are not added to env', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-s13-'));
  const testStorageFile = path.join(tmpDir, 'open-pi-viewer.json');
  setStorageFilePathForTest(testStorageFile);

  const origGh = process.env.GH_TOKEN;
  const origGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;

  let capturedRpcEnv: any = null;
  setSubprocessSpawnerForTest((_cmd, _args, options) => {
    capturedRpcEnv = options?.env;
    return null;
  });

  let capturedPtyOptions: any = null;
  setPtySpawnerForTest((_file, _args, options) => {
    capturedPtyOptions = options;
    return {
      pid: 0,
      onData: () => {},
      onExit: () => {},
    };
  });

  t.after(() => {
    if (origGh !== undefined) process.env.GH_TOKEN = origGh;
    if (origGithub !== undefined) process.env.GITHUB_TOKEN = origGithub;
    setSubprocessSpawnerForTest(null);
    setPtySpawnerForTest(null);
    setStorageFilePathForTest(null);
    resetPiRpcForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Case A: githubPat is null
  saveViewerStorage({ githubPat: null });
  const sessionNull = new PiRpcSession();
  await sessionNull.ensureRunning(tmpDir);
  assert.ok(capturedRpcEnv);
  assert.strictEqual(capturedRpcEnv.GH_TOKEN, undefined);
  assert.strictEqual(capturedRpcEnv.GITHUB_TOKEN, undefined);

  const termNull = new TerminalSession({ cwd: tmpDir, canonicalCwd: tmpDir });
  await termNull.kill();
  assert.ok(capturedPtyOptions);
  assert.strictEqual(capturedPtyOptions.env?.GH_TOKEN, undefined);
  assert.strictEqual(capturedPtyOptions.env?.GITHUB_TOKEN, undefined);

  // Case B: githubPat is whitespace
  capturedRpcEnv = null;
  capturedPtyOptions = null;
  resetPiRpcForTest();
  saveViewerStorage({ githubPat: '   ' });

  const sessionWs = new PiRpcSession();
  await sessionWs.ensureRunning(tmpDir);
  assert.ok(capturedRpcEnv);
  assert.strictEqual(capturedRpcEnv.GH_TOKEN, undefined);
  assert.strictEqual(capturedRpcEnv.GITHUB_TOKEN, undefined);

  const termWs = new TerminalSession({ cwd: tmpDir, canonicalCwd: tmpDir });
  await termWs.kill();
  assert.ok(capturedPtyOptions);
  assert.strictEqual(capturedPtyOptions.env?.GH_TOKEN, undefined);
  assert.strictEqual(capturedPtyOptions.env?.GITHUB_TOKEN, undefined);
});

test('S1 boundary: githubPat with leading/trailing whitespace is trimmed for RPC and terminal', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-trim-'));
  const testStorageFile = path.join(tmpDir, 'open-pi-viewer.json');
  setStorageFilePathForTest(testStorageFile);
  saveViewerStorage({ githubPat: '  ghp_trimmedToken456 \t\n ' });

  let capturedRpcEnv: any = null;
  setSubprocessSpawnerForTest((_cmd, _args, options) => {
    capturedRpcEnv = options?.env;
    return null;
  });

  let capturedPtyOptions: any = null;
  setPtySpawnerForTest((_file, _args, options) => {
    capturedPtyOptions = options;
    return {
      pid: 0,
      onData: () => {},
      onExit: () => {},
    };
  });

  t.after(() => {
    setSubprocessSpawnerForTest(null);
    setPtySpawnerForTest(null);
    setStorageFilePathForTest(null);
    resetPiRpcForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const session = new PiRpcSession();
  await session.ensureRunning(tmpDir);
  assert.strictEqual(capturedRpcEnv?.GH_TOKEN, 'ghp_trimmedToken456');
  assert.strictEqual(capturedRpcEnv?.GITHUB_TOKEN, 'ghp_trimmedToken456');

  const term = new TerminalSession({ cwd: tmpDir, canonicalCwd: tmpDir });
  await term.kill();
  assert.strictEqual(capturedPtyOptions?.env?.GH_TOKEN, 'ghp_trimmedToken456');
  assert.strictEqual(capturedPtyOptions?.env?.GITHUB_TOKEN, 'ghp_trimmedToken456');
});

test('PRESERVE: terminal-session preserves options.env and ambient environment variables', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-preserve-'));
  const testStorageFile = path.join(tmpDir, 'open-pi-viewer.json');
  setStorageFilePathForTest(testStorageFile);
  saveViewerStorage({ githubPat: null });

  let capturedPtyOptions: any = null;
  setPtySpawnerForTest((_file, _args, options) => {
    capturedPtyOptions = options;
    return {
      pid: 0,
      onData: () => {},
      onExit: () => {},
    };
  });

  t.after(() => {
    setPtySpawnerForTest(null);
    setStorageFilePathForTest(null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const term = new TerminalSession({
    cwd: tmpDir,
    canonicalCwd: tmpDir,
    env: {
      MY_CUSTOM_VAR: 'custom_value_123',
    },
  });
  await term.kill();

  assert.ok(capturedPtyOptions);
  assert.strictEqual(capturedPtyOptions.env?.MY_CUSTOM_VAR, 'custom_value_123');
});

test('S1.4: no PAT preserves custom environment and inherited Git configuration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-config-'));
  const config = path.join(dir, 'gitconfig');
  fs.writeFileSync(config, '[credential "https://github.com"]\n\tusername = inherited-user\n');
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  saveViewerStorage({ githubPat: null });
  let env: NodeJS.ProcessEnv | undefined;
  setPtySpawnerForTest((_file, _args, options) => { env = options.env; return { pid: 0, onData() {}, onExit() {} }; });
  t.after(() => { setPtySpawnerForTest(null); setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  new TerminalSession({ cwd: dir, canonicalCwd: dir, env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GH_TOKEN: 'custom-gh', CUSTOM_VALUE: 'kept' } });
  assert.ok(env);
  assert.equal(env.GH_TOKEN, 'custom-gh');
  assert.equal(env.CUSTOM_VALUE, 'kept');
  assert.equal(env.GIT_CONFIG_GLOBAL, config);
  const result = spawnSync('git', ['config', '--get', 'credential.https://github.com.username'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'inherited-user\n');
  assert.equal(result.stderr, '');
});

test('S2.1: running RPC survives PAT changes and new RPC sessions use current snapshots', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-rpc-snapshot-'));
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  const envs: NodeJS.ProcessEnv[] = [];
  let kills = 0;
  setSubprocessSpawnerForTest((_file, _args, options) => {
    envs.push(options!.env!);
    const child = new EventEmitter() as any;
    child.exitCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString());
      child.stdout.write(JSON.stringify({ id: request.id, success: true, data: {} }) + '\n');
    });
    child.kill = () => { kills++; child.exitCode = 0; };
    return child;
  });
  const sessions: PiRpcSession[] = [];
  t.after(() => { sessions.forEach((session) => session.kill()); setSubprocessSpawnerForTest(null); resetPiRpcForTest(); setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const token of ['fake_rpc_first', 'fake_rpc_second', null]) {
    saveViewerStorage({ githubPat: token });
    const session = new PiRpcSession(); sessions.push(session);
    await session.ensureRunning(dir);
  }
  await sessions[0].ensureRunning(dir);
  assert.equal(kills, 0);
  assert.equal(envs.length, 3);
  for (const [index, token] of ['fake_rpc_first', 'fake_rpc_second'].entries()) {
    const result = credentialFill(envs[index], 'https://github.com/owner/repo.git', dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(`password=${token}\n`));
  }
  const removed = credentialFill(envs[2], 'https://github.com/owner/repo.git', dir);
  assert.notEqual(removed.status, 0);
  assert.equal(removed.stdout, '');
  assert.ok(!removed.stderr.includes('fake_rpc_'));
});

function credentialFill(env: NodeJS.ProcessEnv, url: string, dir: string) {
  return spawnSync('git', ['credential', 'fill'], {
    cwd: dir, input: `url=${url}\n\n`, encoding: 'utf8',
    env: { ...env, GIT_CONFIG_GLOBAL: path.join(dir, 'absent-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

for (const kind of ['terminal', 'rpc'] as const) {
  test(`S1.1: ${kind} resolves GitHub HTTPS credentials with the saved PAT`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-git-'));
    setStorageFilePathForTest(path.join(dir, 'storage.json'));
    saveViewerStorage({ githubPat: 'fake_pat_s11' });
    let env: NodeJS.ProcessEnv | undefined;
    setPtySpawnerForTest((_file, _args, options) => {
      env = options.env;
      return { pid: 0, onData() {}, onExit() {} };
    });
    setSubprocessSpawnerForTest((_file, _args, options) => { env = options?.env; return null; });
    t.after(() => {
      setPtySpawnerForTest(null); setSubprocessSpawnerForTest(null);
      resetPiRpcForTest(); setStorageFilePathForTest(null);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    if (kind === 'terminal') new TerminalSession({ cwd: dir, canonicalCwd: dir });
    else await new PiRpcSession().ensureRunning(dir);
    assert.ok(env);
    assert.equal(env.GH_TOKEN, 'fake_pat_s11');
    assert.equal(env.GITHUB_TOKEN, 'fake_pat_s11');
    const result = credentialFill(env, 'https://github.com/owner/repo.git', dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /(?:^|\n)username=.+\n/);
    assert.match(result.stdout, /(?:^|\n)password=fake_pat_s11\n/);
  });
}

test('S1.3: terminal credentials are not returned to other or deceptive hosts or HTTP', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-host-'));
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  saveViewerStorage({ githubPat: 'fake_pat_s13' });
  let env: NodeJS.ProcessEnv | undefined;
  setPtySpawnerForTest((_file, _args, options) => {
    env = options.env;
    return { pid: 0, onData() {}, onExit() {} };
  });
  t.after(() => {
    setPtySpawnerForTest(null); setStorageFilePathForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  new TerminalSession({ cwd: dir, canonicalCwd: dir });
  assert.ok(env);
  for (const url of ['https://example.com/owner/repo.git', 'https://github.com.example.com/owner/repo.git', 'http://github.com/owner/repo.git']) {
    const result = credentialFill(env, url, dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('fake_pat_s13'));
  }
});

test('S2.1: new terminal sessions snapshot changed and removed PAT without interrupting existing sessions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-snapshot-'));
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  const envs: NodeJS.ProcessEnv[] = [];
  let kills = 0;
  setPtySpawnerForTest((_file, _args, options) => {
    envs.push(options.env);
    return { pid: 0, onData() {}, onExit() {}, kill() { kills++; } };
  });
  t.after(() => {
    setPtySpawnerForTest(null); setStorageFilePathForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const token of ['fake_pat_first', 'fake_pat_second', null]) {
    saveViewerStorage({ githubPat: token });
    new TerminalSession({ cwd: dir, canonicalCwd: dir });
  }
  assert.equal(kills, 0);
  for (const [index, token] of ['fake_pat_first', 'fake_pat_second'].entries()) {
    const result = credentialFill(envs[index], 'https://github.com/owner/repo.git', dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(`password=${token}\n`));
  }
  const removed = credentialFill(envs[2], 'https://github.com/owner/repo.git', dir);
  assert.notEqual(removed.status, 0);
  assert.equal(removed.stdout, '');
  assert.ok(!removed.stderr.includes('fake_pat_'));
});
