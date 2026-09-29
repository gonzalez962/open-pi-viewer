import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELPER_PATH = path.resolve('src-tauri/pi-oauth-helper.mjs');

const FAKE_SDK_SOURCE = `export class ModelRuntime {
  static async create() {
    return new ModelRuntime();
  }
  getProviders() {
    return [{ id: 'fake', name: 'Fake', auth: { oauth: { name: 'Fake OAuth' } } }];
  }
  async listCredentials() {
    return [];
  }
  async checkAuth() {
    return undefined;
  }
}
`;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function writeFakeSdkPackage(packageDir: string): void {
  writeJson(path.join(packageDir, 'package.json'), {
    name: '@earendil-works/pi-coding-agent',
    type: 'module',
    main: './dist/index.js',
    exports: { '.': { import: './dist/index.js' } },
  });
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), FAKE_SDK_SOURCE);
}

function runHelperList(entrypoint: string, home: string): { status: string; providers?: unknown[]; error?: string } {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [HELPER_PATH, 'list', '--entrypoint', entrypoint, '--home', home], {
      encoding: 'utf8',
    });
  } catch (err) {
    stdout = String((err as { stdout?: string }).stdout ?? '');
  }
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oauth-helper-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('OAuth helper resolves the Pi SDK when the entrypoint lives inside the SDK package', () => {
  withTempDir((dir) => {
    const sdkDir = path.join(dir, 'pi-coding-agent');
    writeFakeSdkPackage(sdkDir);
    const entrypoint = path.join(sdkDir, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const result = runHelperList(entrypoint, path.join(dir, 'home'));

    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.providers?.length, 1);
  });
});

test('OAuth helper resolves the Pi SDK from the Gentle Shell package dependencies', () => {
  withTempDir((dir) => {
    const shellDir = path.join(dir, 'gentle-pi');
    writeJson(path.join(shellDir, 'package.json'), { name: 'gentle-pi' });
    const entrypoint = path.join(shellDir, 'bin', 'gentle-shell.mjs');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');
    writeFakeSdkPackage(path.join(shellDir, 'node_modules', '@earendil-works', 'pi-coding-agent'));

    const result = runHelperList(entrypoint, path.join(dir, 'home'));

    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.providers?.length, 1);
  });
});

test('OAuth helper reports an error when no Pi SDK is reachable from the entrypoint', () => {
  withTempDir((dir) => {
    const entrypoint = path.join(dir, 'orphan', 'cli.js');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '');

    const result = runHelperList(entrypoint, path.join(dir, 'home'));

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /Unable to resolve Pi SDK/);
  });
});
