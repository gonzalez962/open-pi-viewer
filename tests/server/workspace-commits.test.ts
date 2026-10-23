import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleIpcCommand } from '@server/web-ipc-bridge';
import { handleListWorkspaceBranchCommits } from '@server/bridge/paths';

function fixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-commits-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  git('checkout', '-B', 'main');

  // Create initial commit on main
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial commit');

  return {
    root,
    git,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('handleListWorkspaceBranchCommits: loads first 10 commits and detects hasMore', () => {
  const f = fixture();
  try {
    // Create 15 commits on a new branch
    f.git('checkout', '-b', 'feature/test-branch');
    for (let i = 1; i <= 15; i++) {
      fs.writeFileSync(path.join(f.root, 'file.txt'), `content ${i}\n`);
      f.git('add', '.');
      f.git('-c', 'commit.gpgsign=false', 'commit', '-m', `commit number ${i}`);
    }

    // First round: 10 commits
    const round1 = handleListWorkspaceBranchCommits({
      workingDirectory: f.root,
      branch: 'feature/test-branch',
      limit: 10,
      offset: 0,
    });

    assert.equal(round1.branch, 'feature/test-branch');
    assert.equal(round1.commits.length, 10);
    assert.equal(round1.hasMore, true);
    assert.equal(round1.commits[0].subject, 'commit number 15');
    assert.equal(round1.commits[9].subject, 'commit number 6');
    // In a repository without remotes, commits are marked unpushed
    assert.equal(round1.commits[0].isUnpushed, true);

    // Second round: remaining commits
    const round2 = handleListWorkspaceBranchCommits({
      workingDirectory: f.root,
      branch: 'feature/test-branch',
      limit: 10,
      offset: 10,
    });

    assert.equal(round2.commits.length, 6); // 15 - 10 + 1 (initial commit) = 6
    assert.equal(round2.hasMore, false);
    assert.equal(round2.commits[0].subject, 'commit number 5');
    assert.equal(round2.commits[5].subject, 'initial commit');
  } finally {
    f.cleanup();
  }
});

test('handleListWorkspaceBranchCommits: distinguishes unpushed commits when upstream exists', () => {
  const f = fixture();
  try {
    // Create a local bare "remote" repository to test upstream tracking
    const remoteDir = fs.mkdtempSync(path.join(process.cwd(), '.workspace-remote-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir, stdio: 'pipe' });

      f.git('remote', 'add', 'origin', remoteDir);
      f.git('checkout', '-b', 'feat/sync-test');

      fs.writeFileSync(path.join(f.root, 'file.txt'), 'remote commit\n');
      f.git('add', '.');
      f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'commit pushed to remote');

      // Push to origin and set upstream
      f.git('push', '-u', 'origin', 'feat/sync-test');

      // Add a second commit locally that is NOT pushed
      fs.writeFileSync(path.join(f.root, 'file.txt'), 'local unpushed\n');
      f.git('add', '.');
      f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'local unpushed commit');

      const result = handleListWorkspaceBranchCommits({
        workingDirectory: f.root,
        branch: 'feat/sync-test',
        limit: 10,
        offset: 0,
      });

      assert.equal(result.commits.length >= 2, true);
      // Newest commit is not pushed
      assert.equal(result.commits[0].subject, 'local unpushed commit');
      assert.equal(result.commits[0].isUnpushed, true);

      // Previous commit was pushed to upstream
      assert.equal(result.commits[1].subject, 'commit pushed to remote');
      assert.equal(result.commits[1].isUnpushed, false);
    } finally {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});

test('handleListWorkspaceBranchCommits: rejects invalid branch names', () => {
  const f = fixture();
  try {
    assert.throws(
      () => handleListWorkspaceBranchCommits({ workingDirectory: f.root, branch: 'bad;injection' }),
      /Invalid branch name/
    );
    assert.throws(
      () => handleListWorkspaceBranchCommits({ workingDirectory: f.root, branch: '..//bad' }),
      /Invalid branch name/
    );
    assert.throws(
      () => handleListWorkspaceBranchCommits({ workingDirectory: f.root, branch: '' }),
      /Invalid branch name/
    );
  } finally {
    f.cleanup();
  }
});

test('web IPC bridge: handles list_workspace_branch_commits command', async () => {
  const f = fixture();
  try {
    const res = await handleIpcCommand('list_workspace_branch_commits', {
      payload: {
        workingDirectory: f.root,
        branch: 'main',
        limit: 10,
        offset: 0,
      },
    });

    assert.ok(res);
    assert.equal(res.branch, 'main');
    assert.ok(Array.isArray(res.commits));
    assert.equal(res.commits.length, 1);
    assert.equal(res.commits[0].subject, 'initial commit');
    assert.ok(res.commits[0].hash);
    assert.ok(res.commits[0].shortHash);
  } finally {
    f.cleanup();
  }
});
