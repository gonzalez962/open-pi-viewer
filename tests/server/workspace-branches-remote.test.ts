import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleListWorkspaceBranches, handleSwitchWorkspaceBranch } from '@server/bridge/paths';

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
