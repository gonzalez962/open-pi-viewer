import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  sanitizeErrorMessage,
  buildChildGitEnv,
  cloneGithubRepository,
  defaultProcessRunner,
  setProcessRunnerForTest,
} from '@server/bridge/github';

// ---------------------------------------------------------------------------
// 1. Error sanitization: generic fallback for unknown child output, no leaks
// ---------------------------------------------------------------------------

test('sanitizeErrorMessage maps unknown child output to generic fixed error', () => {
  // Unknown child outputs must never be echoed verbatim
  assert.strictEqual(
    sanitizeErrorMessage('fatal: some unexpected internal gh error with secrets xyz'),
    'Clone operation failed'
  );
  assert.strictEqual(
    sanitizeErrorMessage('https://x-access-token:ghp_secret@github.com/org/repo.git failed'),
    'Clone operation failed'
  );
  assert.strictEqual(
    sanitizeErrorMessage(''),
    'Clone operation failed'
  );
});

test('sanitizeErrorMessage preserves mapped known error classes', () => {
  assert.strictEqual(
    sanitizeErrorMessage('fatal: repository not found'),
    'Repository not found or access denied'
  );
  assert.strictEqual(
    sanitizeErrorMessage('fatal: could not read Username for https://github.com: terminal prompts disabled'),
    'Repository not found or access denied'
  );
  assert.strictEqual(
    sanitizeErrorMessage('fatal: Authentication failed for https://github.com/org/repo.git'),
    'Repository not found or access denied'
  );
  assert.strictEqual(
    sanitizeErrorMessage('fatal: destination path already exists and is not an empty directory.'),
    'Destination path already exists'
  );
  assert.strictEqual(
    sanitizeErrorMessage('Command timed out after 120000ms'),
    'Cloning timed out after 120 seconds'
  );
});

test('cloneGithubRepository returns generic error and redacts PAT on unknown runner failure', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unknown-fail-test-'));
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  const secretPat = 'ghp_secretTokenShouldNotLeak999';
  setProcessRunnerForTest(async () => {
    return {
      stdout: 'internal git trace with token: ' + secretPat,
      stderr: 'random internal failure with token: ' + secretPat,
      exitCode: 1,
    };
  });

  try {
    await assert.rejects(
      async () => {
        await cloneGithubRepository({
          repository: 'octocat/Hello-World',
          parentPath: parentDir,
          token: secretPat,
        });
      },
      (err: Error) => {
        assert.ok(!err.message.includes(secretPat), 'Secret PAT must not appear in error');
        assert.ok(!err.message.includes('random internal failure'), 'Raw child output must not be echoed');
        assert.strictEqual(err.message, 'Clone operation failed');
        return true;
      }
    );
  } finally {
    setProcessRunnerForTest(null);
  }
});

// ---------------------------------------------------------------------------
// 2. Child environment hardening: trace scrubbing and gh credential helper
// ---------------------------------------------------------------------------

test('buildChildGitEnv scrubs GIT_TRACE* and GIT_CONFIG* variables to prevent PAT leak', () => {
  const origEnv = process.env;
  try {
    process.env = {
      ...origEnv,
      GIT_TRACE: '1',
      GIT_TRACE_CURL: '1',
      GIT_TRACE_PACKET: '1',
      GIT_TRACE_SETUP: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      GIT_SSH_COMMAND: 'ssh -v',
    };

    const env = buildChildGitEnv('ghp_testToken123');
    assert.strictEqual(env.GIT_TRACE, undefined, 'GIT_TRACE must be scrubbed');
    assert.strictEqual(env.GIT_TRACE_CURL, undefined, 'GIT_TRACE_CURL must be scrubbed');
    assert.strictEqual(env.GIT_TRACE_PACKET, undefined, 'GIT_TRACE_PACKET must be scrubbed');
    assert.strictEqual(env.GIT_TRACE_SETUP, undefined, 'GIT_TRACE_SETUP must be scrubbed');
    assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, undefined, 'GIT_CONFIG_NOSYSTEM must be scrubbed');
    assert.strictEqual(env.GIT_CONFIG_GLOBAL, undefined, 'GIT_CONFIG_GLOBAL must be scrubbed');
    assert.strictEqual(env.GIT_SSH_COMMAND, undefined, 'GIT_SSH_COMMAND must be scrubbed');
  } finally {
    process.env = origEnv;
  }
});

test('buildChildGitEnv configures scoped gh credential helper when useGhCredentialHelper is true', () => {
  const env = buildChildGitEnv(undefined, { isAnonymous: false, useGhCredentialHelper: true });

  const count = parseInt(env.GIT_CONFIG_COUNT || '0', 10);
  const configs: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    configs[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
  }

  // Base credential.helper disabled to prevent ambient helpers
  assert.strictEqual(configs['credential.helper'], '');
  // Scoped helper configured for https://github.com without token interpolation
  assert.strictEqual(configs['credential.https://github.com.helper'], '!gh auth git-credential');
});

test('buildChildGitEnv neutralizes url rewrite for https://github.com', () => {
  const env = buildChildGitEnv();
  const count = parseInt(env.GIT_CONFIG_COUNT || '0', 10);
  const configs: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    configs[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
  }

  assert.strictEqual(configs['url.https://github.com/.insteadOf'], 'https://github.com/');
});

// ---------------------------------------------------------------------------
// 3. Process runner: bounded output buffers and finite timeout
// ---------------------------------------------------------------------------

test('defaultProcessRunner caps stdout/stderr buffer to prevent memory exhaustion', async () => {
  // Use node to print 2MB of output
  const res = await defaultProcessRunner(
    process.execPath,
    ['-e', 'process.stdout.write("A".repeat(1500000)); process.stderr.write("B".repeat(1500000));'],
    { timeout: 10_000 }
  );

  assert.strictEqual(res.exitCode, 0);
  assert.ok(res.stdout.length <= 1024 * 1024, `stdout length (${res.stdout.length}) must be <= 1MB`);
  assert.ok(res.stderr.length <= 1024 * 1024, `stderr length (${res.stderr.length}) must be <= 1MB`);
});

test('defaultProcessRunner terminates within timeout if child process hangs', async () => {
  const start = Date.now();
  await assert.rejects(
    async () => {
      // Run node process that hangs indefinitely
      await defaultProcessRunner(
        process.execPath,
        ['-e', 'setInterval(() => {}, 10000);'],
        { timeout: 500 }
      );
    },
    (err: any) => {
      assert.strictEqual(err.code, 'ETIMEDOUT');
      return true;
    }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `Hanging process must terminate near timeout, elapsed: ${elapsed}ms`);
});
