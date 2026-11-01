import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handlePublishWorkspaceBranch } from '@server/bridge/paths';
import { saveViewerStorage, setStorageFilePathForTest } from '@server/storage';

test('S1.2: branch publish passes usable GitHub credentials to Git without token-bearing arguments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-publish-'));
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(repo);
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'] as const;
  const original = keys.map((key) => process.env[key]);
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'absent-config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  t.after(() => {
    setStorageFilePathForTest(null);
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(dir, 'init', '--bare', remote);
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'commit', '--allow-empty', '-m', 'fixture');
  const branch = git(repo, 'branch', '--show-current').trim();
  git(repo, 'remote', 'add', 'origin', remote);
  const hook = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nprintf "url=https://github.com/owner/repo.git\\n\\n" | git credential fill > credential.txt\n');
  fs.chmodSync(hook, 0o755);
  saveViewerStorage({ githubPat: 'fake_pat_publish' });
  const result = handlePublishWorkspaceBranch({ workingDirectory: repo, remote: 'origin', branch });
  assert.equal(result.success, true);
  const credential = fs.readFileSync(path.join(repo, 'credential.txt'), 'utf8');
  assert.match(credential, /(?:^|\n)username=.+\n/);
  assert.match(credential, /(?:^|\n)password=fake_pat_publish\n/);
  assert.ok(!fs.readFileSync(path.join(repo, 'args.txt'), 'utf8').includes('fake_pat_publish'));
  assert.ok(!git(repo, 'remote', 'get-url', 'origin').includes('fake_pat_publish'));
});
