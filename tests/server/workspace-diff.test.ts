import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleIpcCommand } from '@server/web-ipc-bridge';
import { parseUnifiedDiff } from '@features/workspace/FileViewerModal';

// Keep all mutable fixtures inside the project and remove them after each test.
function fixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-diff-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'file.txt'), 'before\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const diff = (relativePath: string, workingDirectory = root) =>
    handleIpcCommand('get_workspace_file_diff', { payload: { relativePath, workingDirectory } });
  return { root, git, diff, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('web diff command exposes removed and added lines, including staged changes', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'nested', 'file.txt'), 'after\n');
    for (const staged of [false, true]) {
      if (staged) f.git('add', '.');
      const result = await f.diff('nested/file.txt');
      assert.equal(result.relativePath, 'nested/file.txt');
      assert.equal(result.hasDiff, true);
      const lines = parseUnifiedDiff(result.diff);
      assert.ok(lines.some(line => line.type === 'del' && line.text === 'before'));
      assert.ok(lines.some(line => line.type === 'add' && line.text === 'after'));
    }
    const nestedResult = await f.diff('file.txt', path.join(f.root, 'nested'));
    assert.equal(nestedResult.relativePath, 'file.txt');
    assert.match(nestedResult.diff, /-before\n\+after/);
  } finally { f.cleanup(); }
});

test('web diff command returns no diff for unchanged files and additions for untracked files', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.diff('nested/file.txt'), { relativePath: 'nested/file.txt', hasDiff: false, diff: '' });
    fs.writeFileSync(path.join(f.root, 'new file.txt'), 'new content\n');
    const result = await f.diff('new file.txt');
    assert.equal(result.hasDiff, true);
    assert.ok(parseUnifiedDiff(result.diff).some(line => line.type === 'add' && line.text === 'new content'));
  } finally { f.cleanup(); }
});

test('web diff command rejects escaped paths without mutating workspace state', async () => {
  const f = fixture();
  try {
    const before = f.git('status', '--porcelain').toString();
    for (const relativePath of ['../package.json', 'nested/../../package.json', f.root, 'nested']) {
      await assert.rejects(f.diff(relativePath), /traversal|outside|directory/i);
    }
    assert.equal(f.git('status', '--porcelain').toString(), before);
    assert.equal(fs.readFileSync(path.join(f.root, 'nested', 'file.txt'), 'utf8'), 'before\n');
  } finally { f.cleanup(); }
});
