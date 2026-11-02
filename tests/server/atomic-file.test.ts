import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeModelsConfigFileAtomically } from '@server/bridge/custom-providers';

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

test('S2.1 staged replacement retries transient Windows errors and preserves permissions', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-retry-'));
    const file = path.join(dir, 'config.json');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const rename = fs.renameSync;
    let attempts = 0;
    const sources: string[] = [];
    try {
      fs.writeFileSync(file, '{"old":true}', { mode: 0o640 });
      const mode = fs.statSync(file).mode & 0o777;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      fs.renameSync = ((from, to) => {
        attempts++;
        assert.equal(to, file);
        sources.push(String(from));
        assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
        if (attempts === 1) throw failure(code);
        return rename(from, to);
      }) as typeof fs.renameSync;
      writeModelsConfigFileAtomically(file, { providers: {} });
      assert.equal(attempts, 2);
      for (const source of sources) assert.match(path.basename(source), /^config\.json\.tmp\./);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { providers: {} });
      assert.equal(fs.statSync(file).mode & 0o777, mode);
      assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    } finally {
      fs.renameSync = rename;
      Object.defineProperty(process, 'platform', platform);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('S2.2 permanent and non-retryable errors preserve destination and clean staging', () => {
  for (const code of ['EPERM', 'ENOENT']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-fail-'));
    const file = path.join(dir, 'config.json');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const rename = fs.renameSync;
    const error = failure(code);
    let attempts = 0;
    try {
      fs.writeFileSync(file, '{"old":true}');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      fs.renameSync = (() => { attempts++; throw error; }) as typeof fs.renameSync;
      assert.throws(() => writeModelsConfigFileAtomically(file, { providers: {} }), err => err === error);
      if (code === 'ENOENT') assert.equal(attempts, 1);
      else assert.ok(attempts > 1 && attempts <= 10, `attempts: ${attempts}`);
      assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
      assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    } finally {
      fs.renameSync = rename;
      Object.defineProperty(process, 'platform', platform);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
