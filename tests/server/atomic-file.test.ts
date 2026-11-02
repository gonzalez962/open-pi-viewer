import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeModelsConfigFileAtomically } from '@server/bridge/custom-providers';
import { saveViewerStorage, setStorageFilePathForTest } from '@server/storage';
import { saveProjectResourceActivation } from '@server/bridge/resource-activation';
import { handleDeleteMcpServer } from '@server/bridge/resource-deletion';
import { handleSaveProjectKanban } from '@server/bridge/kanban';
import { setPiAgentDirForTest } from '@server/bridge/state';

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

test('S2.1 storage, activation, deletion and kanban callers recover from Windows locks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-callers-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const rename = fs.renameSync;
  const attempts = new Map<string, number>();
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  setPiAgentDirForTest(dir);
  try {
    fs.mkdirSync(path.join(dir, '.pi'));
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'node' }, remove: { command: 'node' } } }));
    fs.writeFileSync(path.join(dir, '.gitignore'), '/.pi/kanban.json\n');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fs.renameSync = ((from, to) => {
      const target = String(to);
      const count = (attempts.get(target) || 0) + 1;
      attempts.set(target, count);
      if (count === 1) throw failure('EBUSY');
      return rename(from, to);
    }) as typeof fs.renameSync;
    assert.equal(saveViewerStorage({ projects: { sample: true } }).projects?.sample, true);
    saveProjectResourceActivation(dir, { version: 1, mcpServers: { keep: false } });
    assert.equal(handleDeleteMcpServer({ name: 'remove', scope: 'global' }).success, true);
    assert.deepEqual(handleSaveProjectKanban({ payload: { workingDirectory: dir, board: { cards: [] } } }), { cards: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).mcpServers, { keep: { command: 'node' } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.pi', 'resource-activation.json'), 'utf8')).mcpServers.keep, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.pi', 'kanban.json'), 'utf8')), { cards: [] });
    assert.equal(attempts.size, 4);
    for (const count of attempts.values()) assert.equal(count, 2);
  } finally {
    fs.renameSync = rename;
    Object.defineProperty(process, 'platform', platform);
    setStorageFilePathForTest(null);
    setPiAgentDirForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
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
