import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withGithubCredentials } from '@server/github-credentials';
import { saveViewerStorage, setStorageFilePathForTest } from '@server/storage';

test('S1: GitHub helper does not persist credentials and preserves inherited config entries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-helper-'));
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  saveViewerStorage({ githubPat: 'fake_secret_helper' });
  const store = path.join(dir, 'credentials');
  const config = path.join(dir, 'config');
  fs.writeFileSync(config, `[credential]\n\thelper = store --file=${store.replace(/\\/g, '/')}\n`);
  const env = withGithubCredentials({ ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'preserved' });
  const git = (args: string[], input = '') => spawnSync('git', args, { cwd: dir, env, input, encoding: 'utf8' });
  const name = git(['config', '--get', 'user.name']);
  assert.equal(name.status, 0); assert.equal(name.stdout, 'preserved\n'); assert.equal(name.stderr, '');
  const fill = git(['credential', 'fill'], 'url=https://github.com/owner/repo.git\n\n');
  assert.equal(fill.status, 0, fill.stderr); assert.equal(fill.stderr, '');
  assert.match(fill.stdout, /password=fake_secret_helper\n/);
  for (const action of ['approve', 'reject']) {
    const result = git(['credential', action], 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=fake_secret_helper\n\n');
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(store), false);
  }
  assert.ok(!Object.values(env).some((value) => typeof value === 'string' && value.includes('fake_secret_helper') && value !== 'fake_secret_helper'));
});

test('S1: embedded token control characters are rejected without exposing the token', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pat-invalid-'));
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  saveViewerStorage({ githubPat: 'fake_secret\nother=value' });
  assert.throws(() => withGithubCredentials({}), (error: Error) => error.message === 'Invalid GitHub token' && !error.message.includes('fake_secret'));
});
