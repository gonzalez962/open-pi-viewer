import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleListWorkspaceBranches, handleSwitchWorkspaceBranch } from '@server/bridge/paths';

function branchFixture(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-branch-cache-'));
  const local = path.join(dir, 'local');
  const remote = path.join(dir, 'remote.git');
  const worker = path.join(dir, 'worker');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git(dir, 'init', '--bare', remote);
  fs.mkdirSync(local);
  git(local, 'init', '-b', 'main');
  git(local, 'config', 'user.name', 'Tester');
  git(local, 'config', 'user.email', 'tester@example.com');
  git(local, 'commit', '--allow-empty', '-m', 'initial');
  git(local, 'remote', 'add', 'origin', remote);
  git(local, 'push', '-u', 'origin', 'main');
  git(dir, 'clone', '--branch', 'main', remote, worker);
  const pushBranch = (name: string) => git(worker, 'push', 'origin', `HEAD:refs/heads/${name}`);
  const list = (options: Record<string, unknown> = {}) =>
    handleListWorkspaceBranches({ workingDirectory: local, ...options });
  return { dir, local, remote, git, pushBranch, list };
}

test('S1.1 caches successful remote retrieval across listings', (t) => {
  const f = branchFixture(t);
  f.pushBranch('first');
  assert.ok(f.list().branches.some((b) => b.name === 'origin/first'));
  f.pushBranch('later');
  const second = f.list();
  assert.ok(second.branches.some((b) => b.name === 'origin/first'));
  assert.ok(!second.branches.some((b) => b.name === 'origin/later'), 'second listing must not fetch');
  assert.equal(second.current, 'main');
});

test('S4.1 offline listing retains local and previously fetched refs', (t) => {
  const f = branchFixture(t);
  f.pushBranch('available');
  assert.ok(f.list().branches.some((b) => b.name === 'origin/available'));
  f.git(f.local, 'remote', 'set-url', 'origin', path.join(f.dir, 'unreachable.git'));
  const offline = f.list({ sync: true });
  assert.equal(offline.current, 'main');
  assert.ok(offline.branches.some((b) => b.name === 'main'));
  assert.ok(offline.branches.some((b) => b.name === 'origin/available'));
});

test('S2.1 explicit sync refreshes the cached remote snapshot', (t) => {
  const f = branchFixture(t);
  f.list();
  f.pushBranch('new-remote');
  const synced = f.list({ sync: true });
  assert.ok(synced.branches.some((b) => b.name === 'origin/new-remote'));
  f.pushBranch('after-sync');
  assert.ok(!f.list().branches.some((b) => b.name === 'origin/after-sync'), 'sync refresh must itself be cached');
});

test('S2.2 a new local branch triggers synchronization', (t) => {
  const f = branchFixture(t);
  f.list();
  f.pushBranch('new-remote');
  f.git(f.local, 'branch', 'new-local');
  const refreshed = f.list();
  assert.ok(refreshed.branches.some((b) => b.name === 'new-local'));
  assert.ok(refreshed.branches.some((b) => b.name === 'origin/new-remote'));
  f.pushBranch('after-refresh');
  assert.ok(!f.list().branches.some((b) => b.name === 'origin/after-refresh'), 'local-triggered refresh must be cached');
});

test('S3.1 ordered filtered ranges exhaust without gaps and retain complete bases', (t) => {
  const f = branchFixture(t);
  for (const name of ['feature-z', 'feature-a', 'feature-m', 'other']) f.git(f.local, 'branch', name);
  const legacy = f.list();
  assert.deepEqual(new Set(legacy.branches.map((b) => b.name)), new Set(['main', 'feature-a', 'feature-m', 'feature-z', 'other']));
  const first = f.list({ offset: 0, limit: 2, filter: 'feature' });
  const second = f.list({ offset: 2, limit: 2, filter: 'feature' });
  assert.deepEqual(first.branches.map((b) => b.name), ['feature-a', 'feature-m']);
  assert.deepEqual(second.branches.map((b) => b.name), ['feature-z']);
  assert.equal((first as typeof first & { hasMore: boolean }).hasMore, true);
  assert.equal((second as typeof second & { hasMore: boolean }).hasMore, false);
  assert.deepEqual(first.allBases, legacy.allBases);
  assert.deepEqual(second.allBases, legacy.allBases);
});

test('handleListWorkspaceBranches: fetches remote branches when remote exists and includes remote-only branches', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-branches-'));
  const localRepo = path.join(dir, 'local');
  const remoteRepo = path.join(dir, 'remote.git');
  const workerRepo = path.join(dir, 'worker');

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };

  // 1. Create bare remote
  git(dir, 'init', '--bare', remoteRepo);

  // 2. Create local repo and push main to remote
  fs.mkdirSync(localRepo);
  git(localRepo, 'init', '-b', 'main');
  git(localRepo, 'config', 'user.name', 'Tester');
  git(localRepo, 'config', 'user.email', 'tester@example.com');
  fs.writeFileSync(path.join(localRepo, 'README.md'), '# Main');
  git(localRepo, 'add', 'README.md');
  git(localRepo, 'commit', '-m', 'Initial commit');
  git(localRepo, 'remote', 'add', 'origin', remoteRepo);
  git(localRepo, 'push', '-u', 'origin', 'main');

  // 3. From a worker clone, create and push a new branch 'feature-on-remote' to remote
  git(dir, 'clone', remoteRepo, workerRepo);
  git(workerRepo, 'config', 'user.name', 'Worker');
  git(workerRepo, 'config', 'user.email', 'worker@example.com');
  git(workerRepo, 'checkout', '-b', 'feature-on-remote');
  fs.writeFileSync(path.join(workerRepo, 'feature.txt'), 'Feature work');
  git(workerRepo, 'add', 'feature.txt');
  git(workerRepo, 'commit', '-m', 'Worker commit');
  git(workerRepo, 'push', '-u', 'origin', 'feature-on-remote');

  // At this point, localRepo has NOT fetched feature-on-remote yet!
  // 4. Calling handleListWorkspaceBranches on localRepo must auto-fetch from origin
  // and list origin/feature-on-remote as a branch with isRemote: true.
  const branchList = handleListWorkspaceBranches({ workingDirectory: localRepo });

  assert.equal(branchList.current, 'main');
  const localMain = branchList.branches.find((b) => b.name === 'main');
  assert.ok(localMain, 'Local main branch must be in branches list');
  assert.equal(localMain.isCurrent, true);
  assert.equal(localMain.isRemote, false || undefined);

  const remoteBranch = branchList.branches.find((b) => b.name === 'origin/feature-on-remote');
  assert.ok(remoteBranch, 'Remote branch origin/feature-on-remote must be included in branches list');
  assert.equal(remoteBranch.isRemote, true);
  assert.equal(remoteBranch.isCurrent, false);

  // 5. Calling handleSwitchWorkspaceBranch with origin/feature-on-remote
  // should create tracking local branch 'feature-on-remote' without entering detached HEAD.
  const switchRes = handleSwitchWorkspaceBranch({
    workingDirectory: localRepo,
    branch: 'origin/feature-on-remote',
  });
  assert.equal(switchRes.success, true);

  const currentAfterSwitch = git(localRepo, 'branch', '--show-current');
  assert.equal(currentAfterSwitch, 'feature-on-remote', 'Must be on branch feature-on-remote, not detached HEAD');
});
