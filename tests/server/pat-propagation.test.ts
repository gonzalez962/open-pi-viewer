import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiRpcSession, resetPiRpcForTest } from '@server/bridge/rpc';
import { setSubprocessSpawnerForTest } from '@server/bridge/state';
import { TerminalSession, setPtySpawnerForTest } from '@server/terminal/terminal-session';
import { setStorageFilePathForTest, saveViewerStorage } from '@server/storage';

test('S1.1: Given githubPat is "ghp_validToken123", when a Pi RPC process is spawned, then its environment contains GH_TOKEN and GITHUB_TOKEN', async (t) => {
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

test('S1.2: Given githubPat is "ghp_validToken123", when a terminal session is initialized, then its PTY environment contains GH_TOKEN and GITHUB_TOKEN', async (t) => {
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

test('S1.3: Given githubPat is null or whitespace, when Pi RPC or terminal is spawned, then GH_TOKEN and GITHUB_TOKEN are not added to env', async (t) => {
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
