import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleIpcCommand } from '@server/web-ipc-bridge';

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-worktrees-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'source');
  const globalConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  fs.mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0' } });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'keep\n');
  const snapshot = () => ({
    head: git(repo, 'rev-parse', 'HEAD'),
    branch: git(repo, 'branch', '--show-current'),
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    index: git(repo, 'ls-files', '--stage'),
    status: git(repo, 'status', '--porcelain'),
    tracked: fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'),
    untracked: fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8'),
  });
  const list = (projectPath = repo) => handleIpcCommand('list_project_worktrees', { payload: { projectPath } });
  const create = (branch: string, destinationPath: string) => handleIpcCommand('create_project_worktree', { payload: { projectPath: repo, branch, destinationPath } });
  return { dir, repo, git, snapshot, list, create };
}

test('S1.1 lists main and linked worktrees including spaces without changing checkout', async (t) => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'linked with spaces');
  f.git(f.repo, 'worktree', 'add', '-b', 'feature/linked', linked);
  const before = f.snapshot();
  const result = await f.list();
  assert.ok(Array.isArray(result), 'worktrees must be returned as an array');
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((entry: { path: string; branch: string }) => ({ path: fs.realpathSync(entry.path), branch: entry.branch })).sort((a: { branch: string }, b: { branch: string }) => a.branch.localeCompare(b.branch)), [
    { path: fs.realpathSync(linked), branch: 'feature/linked' },
    { path: fs.realpathSync(f.repo), branch: 'main' },
  ]);
  assert.deepEqual(f.snapshot(), before);
});

test('S1.2 rejects a non-repository with an actionable error and creates no files', async (t) => {
  const f = fixture(t);
  const plain = path.join(f.dir, 'not-a-repository');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'keep.txt'), 'keep');
  await assert.rejects(f.list(plain), /repository|git/i);
  assert.deepEqual(fs.readdirSync(plain), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(plain, 'keep.txt'), 'utf8'), 'keep');
});

test('S2.1 creates a new branch at source HEAD without changing source files or checkout', async (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const destination = path.join(f.dir, 'new worktree');
  const result = await f.create('feature/new', destination);
  assert.ok(result, 'creation must return a result');
  assert.equal(f.git(destination, 'branch', '--show-current'), 'feature/new');
  assert.equal(f.git(destination, 'rev-parse', 'HEAD'), before.head);
  assert.equal(fs.readFileSync(path.join(destination, 'tracked.txt'), 'utf8'), 'committed\n');
  const after = f.snapshot();
  assert.equal(after.refs.includes('refs/heads/feature/new ' + before.head), true);
  assert.deepEqual({ ...after, refs: before.refs }, before);
});

test('S2.2 rejects invalid and option-like branches, occupied destinations, existing branches and missing parents without mutation', async (t) => {
  const f = fixture(t);
  f.git(f.repo, 'branch', 'existing');
  const occupied = path.join(f.dir, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'preserve');
  const cases = [
    { branch: 'bad..name', destination: path.join(f.dir, 'invalid'), error: /branch/i },
    { branch: '--force', destination: path.join(f.dir, 'option'), error: /branch/i },
    { branch: 'bad;touch injected', destination: path.join(f.dir, 'injection'), error: /branch/i },
    { branch: 'new-occupied', destination: occupied, error: /exist|destination|occupied/i },
    { branch: 'existing', destination: path.join(f.dir, 'existing-branch'), error: /branch|exist/i },
    { branch: 'new-missing-parent', destination: path.join(f.dir, 'missing', 'child'), error: /parent|directory|exist/i },
  ];
  for (const c of cases) {
    const before = f.snapshot();
    await assert.rejects(f.create(c.branch, c.destination), c.error, c.branch);
    assert.deepEqual(f.snapshot(), before, c.branch);
    assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'preserve');
    if (c.destination !== occupied) assert.equal(fs.existsSync(c.destination), false, c.branch);
    assert.equal(fs.existsSync(path.join(f.repo, 'injected')), false);
  }
});

test('S6.1 omitted and blank destinations use a sanitized child of primary root from either checkout', async (t) => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'caller');
  f.git(f.repo, 'worktree', 'add', '-b', 'caller', linked);
  const sourceHead = f.git(linked, 'rev-parse', 'HEAD');
  const sourceBranch = f.git(linked, 'branch', '--show-current');
  const before = f.snapshot();
  for (const [projectPath, branch, destinationPath, label] of [
    [f.repo, 'feature/primary', undefined, 'feature-primary'],
    [linked, 'feature/linked', '  ', 'feature-linked'],
  ] as const) {
    const result = await handleIpcCommand('create_project_worktree', { payload: { projectPath, branch, ...(destinationPath === undefined ? {} : { destinationPath }) } });
    const expected = path.join(f.repo, label);
    assert.equal(fs.realpathSync(result.path), fs.realpathSync(expected));
    assert.equal(f.git(expected, 'branch', '--show-current'), branch);
    assert.equal(f.git(expected, 'rev-parse', 'HEAD'), sourceHead);
    assert.equal(fs.existsSync(path.join(f.repo, 'feature')), false);
  }
  assert.equal(f.git(linked, 'rev-parse', 'HEAD'), sourceHead);
  assert.equal(f.git(linked, 'branch', '--show-current'), sourceBranch);
  const after = f.snapshot();
  assert.deepEqual({ ...after, refs: before.refs, status: before.status }, before);
});

test('S6.2 collisions and reserved labels reject without mutation; explicit destination remains supported', async (t) => {
  const f = fixture(t);
  const occupied = path.join(f.repo, 'feature-collision');
  fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'keep.txt'), 'preserve');
  for (const branch of ['feature/collision', 'CON', 'aux']) {
    const before = f.snapshot();
    await assert.rejects(handleIpcCommand('create_project_worktree', { payload: { projectPath: f.repo, branch } }), branch === 'feature/collision' ? /destination already exists/i : /reserved|unusable/i);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'preserve');
    assert.equal(fs.existsSync(path.join(f.repo, 'feature')), false);
  }
  const before = f.snapshot();
  const explicit = path.join(f.dir, 'explicit worktree');
  const result = await f.create('feature/explicit', explicit);
  assert.equal(fs.realpathSync(result.path), fs.realpathSync(explicit));
  assert.equal(f.git(explicit, 'rev-parse', 'HEAD'), before.head);
  assert.equal(f.git(explicit, 'branch', '--show-current'), 'feature/explicit');
  const after = f.snapshot();
  assert.deepEqual({ ...after, refs: before.refs }, before);
});

test('existing get_workspace_git_status IPC continues to report dirty source', async (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = await handleIpcCommand('get_workspace_git_status', { payload: { workingDirectory: f.repo } });
  assert.equal(result.isRepo, true);
  assert.equal(result.branch, 'main');
  assert.deepEqual(result.modifiedFiles, ['tracked.txt']);
  assert.deepEqual(result.untrackedFiles, ['untracked.txt']);
  assert.deepEqual(f.snapshot(), before);
});
