import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const scripts = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).scripts;
const startArguments = scripts.start.split(/\s+/).slice(1, -1);

function probe(contents?: string, override?: string) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-start-env-'));
  try {
    if (contents !== undefined) fs.writeFileSync(path.join(root, '.env'), contents);
    const env = { ...process.env };
    delete env.PI_VIEWER_ENV_TEST;
    delete env.NODE_OPTIONS;
    if (override !== undefined) env.PI_VIEWER_ENV_TEST = override;
    return spawnSync(process.execPath, [...startArguments, '-e', 'console.log(process.env.PI_VIEWER_ENV_TEST ?? "missing")'], {
      cwd: root, env, encoding: 'utf8',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('start loads .env from its working directory before application evaluation', () => {
  const result = probe('PI_VIEWER_ENV_TEST="from file"\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'from file\n');
  assert.equal(result.stderr, '');
});

test('start keeps process environment precedence over .env', () => {
  const result = probe('PI_VIEWER_ENV_TEST=from-file\n', 'from-process');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'from-process\n');
  assert.equal(result.stderr, '');
});

test('start still works without .env when configuration comes from environment', () => {
  const result = probe(undefined, 'from-process');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'from-process\n');
  assert.match(result.stderr, /^$|\.env.*not found/i);
});
