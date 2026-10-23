import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverPiCli, extractCliJsFromShim, getAgnosticExecEnv } from '@server/config';

test('extractCliJsFromShim: returns canonical path for direct cli.js file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-test-'));
  try {
    const cliPath = path.join(tmpDir, 'cli.js');
    fs.writeFileSync(cliPath, '// entrypoint', 'utf8');

    const result = extractCliJsFromShim(cliPath);
    assert.equal(result, path.resolve(cliPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('extractCliJsFromShim: extracts target from Windows .CMD shim using %~dp0', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-test-'));
  try {
    const binDir = path.join(tmpDir, 'bin');
    const targetDir = path.join(tmpDir, 'global', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const targetCli = path.join(targetDir, 'cli.js');
    fs.writeFileSync(targetCli, '// real cli', 'utf8');

    const cmdPath = path.join(binDir, 'pi.CMD');
    const cmdContent = `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\global\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\global\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n)\r\n`;
    fs.writeFileSync(cmdPath, cmdContent, 'utf8');

    const result = extractCliJsFromShim(cmdPath);
    assert.equal(result, path.resolve(targetCli));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('extractCliJsFromShim: extracts target from Unix/Git Bash shim using # cmd-shim-target=', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-test-'));
  try {
    const binDir = path.join(tmpDir, 'bin');
    const targetDir = path.join(tmpDir, 'dist', 'bundle');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const targetCli = path.join(targetDir, 'cli.js');
    fs.writeFileSync(targetCli, '// target', 'utf8');

    const shimPath = path.join(binDir, 'pi');
    const shimContent = `#!/bin/sh\nexec node "$basedir/../dist/bundle/cli.js" "$@"\n# cmd-shim-target=../dist/bundle/cli.js\n`;
    fs.writeFileSync(shimPath, shimContent, 'utf8');

    const result = extractCliJsFromShim(shimPath);
    assert.equal(result, path.resolve(targetCli));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('extractCliJsFromShim: returns null when target does not exist or file is empty', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-test-'));
  try {
    const emptyFile = path.join(tmpDir, 'pi.cmd');
    fs.writeFileSync(emptyFile, '', 'utf8');
    assert.equal(extractCliJsFromShim(emptyFile), null);

    const brokenShim = path.join(tmpDir, 'broken.cmd');
    fs.writeFileSync(brokenShim, 'node "%~dp0\\nonexistent\\cli.js"', 'utf8');
    assert.equal(extractCliJsFromShim(brokenShim), null);

    assert.equal(extractCliJsFromShim(path.join(tmpDir, 'does-not-exist')), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('discoverPiCli: returns configured entrypoint when valid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-test-'));
  try {
    const customCli = path.join(tmpDir, 'my-cli.js');
    fs.writeFileSync(customCli, '// custom', 'utf8');

    const result = discoverPiCli(customCli);
    assert.equal(result, path.resolve(customCli));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('discoverPiCli: returns PI_VIEWER_PI_CLI environment override when set', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-test-'));
  const originalEnv = process.env.PI_VIEWER_PI_CLI;
  try {
    const envCli = path.join(tmpDir, 'env-cli.js');
    fs.writeFileSync(envCli, '// env', 'utf8');
    process.env.PI_VIEWER_PI_CLI = envCli;

    const result = discoverPiCli();
    assert.equal(result, path.resolve(envCli));
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_VIEWER_PI_CLI = originalEnv;
    } else {
      delete process.env.PI_VIEWER_PI_CLI;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getAgnosticExecEnv: includes pnpm/bin in PATH on Windows', () => {
  if (process.platform !== 'win32') return;
  const env = getAgnosticExecEnv();
  assert.ok(env.PATH, 'PATH should be defined');
  // If LOCALAPPDATA exists and has pnpm/bin, it should be in PATH
  if (process.env.LOCALAPPDATA && fs.existsSync(path.join(process.env.LOCALAPPDATA, 'pnpm', 'bin'))) {
    assert.ok(
      env.PATH.toLowerCase().includes(path.join(process.env.LOCALAPPDATA, 'pnpm', 'bin').toLowerCase()),
      'PATH should include pnpm\\bin'
    );
  }
});
