import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildChildGitEnv,
  cloneGithubRepository,
  setProcessRunnerForTest,
} from '@server/bridge/github';

const OS_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// ---------------------------------------------------------------------------
// 1. Child environment configuration isolation & scrubbing
// ---------------------------------------------------------------------------

test('buildChildGitEnv isolates system and global config when isolateConfig is enabled', () => {
  const origEnv = process.env;
  try {
    process.env = {
      ...origEnv,
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_GLOBAL: '/some/ambient/global.gitconfig',
    };

    const env = buildChildGitEnv(undefined, { isolateConfig: true });
    assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1', 'GIT_CONFIG_NOSYSTEM must be 1');
    assert.strictEqual(env.GIT_CONFIG_GLOBAL, OS_NULL_DEVICE, 'GIT_CONFIG_GLOBAL must point to OS null device');
  } finally {
    process.env = origEnv;
  }
});

test('buildChildGitEnv scrubs GIT_DIR, GIT_WORK_TREE, and related repo overrides', () => {
  const origEnv = process.env;
  try {
    process.env = {
      ...origEnv,
      GIT_DIR: '/tmp/evil/.git',
      GIT_WORK_TREE: '/tmp/evil',
      GIT_COMMON_DIR: '/tmp/evil/common',
      GIT_INDEX_FILE: '/tmp/evil/index',
      GIT_OBJECT_DIRECTORY: '/tmp/evil/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/evil/alt-objects',
      GIT_TEMPLATE_DIR: '/tmp/evil/templates',
      GIT_GRAFT_FILE: '/tmp/evil/grafts',
      GIT_SSH_COMMAND: 'evil-ssh',
    };

    const env = buildChildGitEnv(undefined, { isolateConfig: true });
    assert.strictEqual(env.GIT_DIR, undefined, 'GIT_DIR must be scrubbed');
    assert.strictEqual(env.GIT_WORK_TREE, undefined, 'GIT_WORK_TREE must be scrubbed');
    assert.strictEqual(env.GIT_COMMON_DIR, undefined, 'GIT_COMMON_DIR must be scrubbed');
    assert.strictEqual(env.GIT_INDEX_FILE, undefined, 'GIT_INDEX_FILE must be scrubbed');
    assert.strictEqual(env.GIT_OBJECT_DIRECTORY, undefined, 'GIT_OBJECT_DIRECTORY must be scrubbed');
    assert.strictEqual(env.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined, 'GIT_ALTERNATE_OBJECT_DIRECTORIES must be scrubbed');
    assert.strictEqual(env.GIT_TEMPLATE_DIR, undefined, 'GIT_TEMPLATE_DIR must be scrubbed');
    assert.strictEqual(env.GIT_GRAFT_FILE, undefined, 'GIT_GRAFT_FILE must be scrubbed');
    assert.strictEqual(env.GIT_SSH_COMMAND, undefined, 'GIT_SSH_COMMAND must be scrubbed');
  } finally {
    process.env = origEnv;
  }
});

test('buildChildGitEnv sets GIT_CEILING_DIRECTORIES when ceilingDir is provided', () => {
  const ceiling = path.resolve('/some/ceiling/path');
  const env = buildChildGitEnv(undefined, { isolateConfig: true, ceilingDir: ceiling });
  assert.strictEqual(env.GIT_CEILING_DIRECTORIES, ceiling);
});

// ---------------------------------------------------------------------------
// 2. Clone execution uses safe cwd (targetDir) and isolated environment
// ---------------------------------------------------------------------------

test('cloneGithubRepository executes in operation-owned targetDir cwd with isolated config and ceiling', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-safe-cwd-test-'));
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  let capturedCwd: string | undefined;
  let capturedEnv: NodeJS.ProcessEnv | undefined;

  setProcessRunnerForTest(async (_file, _args, options) => {
    capturedCwd = options.cwd;
    capturedEnv = options.env;
    return { stdout: 'Cloned successfully', stderr: '', exitCode: 0 };
  });

  try {
    const res = await cloneGithubRepository({
      repository: 'test-owner/test-repo',
      parentPath: parentDir,
    });

    const expectedTargetDir = path.join(parentDir, 'test-repo');
    assert.strictEqual(res.path, expectedTargetDir);
    assert.strictEqual(capturedCwd, expectedTargetDir, 'Runner cwd must be operation-owned targetDir');
    assert.strictEqual(capturedEnv?.GIT_CONFIG_NOSYSTEM, '1', 'GIT_CONFIG_NOSYSTEM must be 1');
    assert.strictEqual(capturedEnv?.GIT_CONFIG_GLOBAL, OS_NULL_DEVICE, 'GIT_CONFIG_GLOBAL must be OS null device');
    assert.strictEqual(capturedEnv?.GIT_CEILING_DIRECTORIES, path.resolve(parentDir), 'GIT_CEILING_DIRECTORIES must be parent directory');
  } finally {
    setProcessRunnerForTest(null);
  }
});

// ---------------------------------------------------------------------------
// 3. Real Git no-network regressions
// ---------------------------------------------------------------------------

test('real Git regression: longer URL rewrite does not affect canonical URL with isolated config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-rewrite-regression-'));
  try {
    const targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir);

    const evilGlobal = path.join(tmpDir, 'evil-global.gitconfig');
    fs.writeFileSync(
      evilGlobal,
      '[url "https://example.invalid/"]\n\tinsteadOf = https://github.com/owner/\n'
    );

    const origEnv = process.env;
    try {
      process.env = {
        ...origEnv,
        GIT_CONFIG_GLOBAL: evilGlobal,
      };

      const childEnv = buildChildGitEnv(undefined, {
        isAnonymous: true,
        isolateConfig: true,
        ceilingDir: tmpDir,
      });

      const res = childProcess.spawnSync(
        'git',
        ['ls-remote', '--get-url', 'https://github.com/owner/repo.git'],
        {
          cwd: targetDir,
          env: childEnv,
          timeout: 10_000,
        }
      );

      assert.strictEqual(res.status, 0, `git ls-remote --get-url failed: ${res.stderr.toString()}`);
      const resolvedUrl = res.stdout.toString().trim();
      assert.strictEqual(
        resolvedUrl,
        'https://github.com/owner/repo.git',
        'Longer rewrite rule must not bypass canonical URL'
      );
      assert.ok(
        !resolvedUrl.includes('example.invalid'),
        'URL must not be rewritten to example.invalid'
      );
    } finally {
      process.env = origEnv;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('real Git regression: ambient parent .git/config rewrites and extraheaders are ignored', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-parent-ambient-regression-'));
  try {
    const parentRepo = path.join(tmpDir, 'parent-repo');
    fs.mkdirSync(parentRepo);

    // Initialize ambient parent git repo with malicious configs
    const initRes = childProcess.spawnSync('git', ['init'], { cwd: parentRepo });
    assert.strictEqual(initRes.status, 0, 'git init in parent must succeed');

    childProcess.spawnSync(
      'git',
      ['config', 'url.https://malicious-parent.invalid/.insteadOf', 'https://github.com/owner/'],
      { cwd: parentRepo }
    );
    childProcess.spawnSync(
      'git',
      ['config', 'http.https://github.com/.extraheader', 'Authorization: stolen-from-parent'],
      { cwd: parentRepo }
    );

    const targetDir = path.join(parentRepo, 'child-target');
    fs.mkdirSync(targetDir);

    const childEnv = buildChildGitEnv(undefined, {
      isAnonymous: true,
      isolateConfig: true,
      ceilingDir: parentRepo,
    });

    // 1. Verify URL rewrite is NOT applied from parent repository
    const getUrlRes = childProcess.spawnSync(
      'git',
      ['ls-remote', '--get-url', 'https://github.com/owner/repo.git'],
      {
        cwd: targetDir,
        env: childEnv,
        timeout: 10_000,
      }
    );

    assert.strictEqual(getUrlRes.status, 0);
    const resolvedUrl = getUrlRes.stdout.toString().trim();
    assert.strictEqual(
      resolvedUrl,
      'https://github.com/owner/repo.git',
      'Parent repo rewrite must not affect canonical URL'
    );
    assert.ok(
      !resolvedUrl.includes('malicious-parent.invalid'),
      'URL must not be rewritten to malicious parent'
    );

    // 2. Verify ambient extraheader from parent is NOT visible
    const getHeaderRes = childProcess.spawnSync(
      'git',
      ['config', '--get', 'http.https://github.com/.extraheader'],
      {
        cwd: targetDir,
        env: childEnv,
        timeout: 10_000,
      }
    );

    // Since config is isolated and parent repo is stopped at ceiling, header should not exist (exitCode non-zero)
    const stdout = getHeaderRes.stdout.toString().trim();
    assert.ok(
      !stdout.includes('stolen-from-parent'),
      'Stolen extraheader from parent repo must not be inherited'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
