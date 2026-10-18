import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseGithubRepository,
  buildChildGitEnv,
  getGithubAuthStatus,
  cloneGithubRepository,
  setProcessRunnerForTest,
} from '@server/bridge/github';

// ---------------------------------------------------------------------------
// 1. Repository parsing & validation
// ---------------------------------------------------------------------------

test('T2 S1: parseGithubRepository parses valid owner/repo shorthand', () => {
  const parsed = parseGithubRepository('octocat/Hello-World');
  assert.strictEqual(parsed.owner, 'octocat');
  assert.strictEqual(parsed.repo, 'Hello-World');
  assert.strictEqual(parsed.canonicalHttpsUrl, 'https://github.com/octocat/Hello-World.git');
});

test('T2 S1: parseGithubRepository parses valid owner/repo.git shorthand', () => {
  const parsed = parseGithubRepository('octocat/Hello-World.git');
  assert.strictEqual(parsed.owner, 'octocat');
  assert.strictEqual(parsed.repo, 'Hello-World');
  assert.strictEqual(parsed.canonicalHttpsUrl, 'https://github.com/octocat/Hello-World.git');
});

test('T2 S1: parseGithubRepository parses valid HTTPS URL without .git', () => {
  const parsed = parseGithubRepository('https://github.com/torvalds/linux');
  assert.strictEqual(parsed.owner, 'torvalds');
  assert.strictEqual(parsed.repo, 'linux');
  assert.strictEqual(parsed.canonicalHttpsUrl, 'https://github.com/torvalds/linux.git');
});

test('T2 S1: parseGithubRepository parses valid HTTPS URL with .git and trailing slash', () => {
  const parsed = parseGithubRepository('https://github.com/facebook/react.git/');
  assert.strictEqual(parsed.owner, 'facebook');
  assert.strictEqual(parsed.repo, 'react');
  assert.strictEqual(parsed.canonicalHttpsUrl, 'https://github.com/facebook/react.git');
});

test('T2 S1: parseGithubRepository rejects embedded credentials', () => {
  assert.throws(
    () => parseGithubRepository('https://user:token@github.com/owner/repo'),
    /credential/i
  );
  assert.throws(
    () => parseGithubRepository('https://token@github.com/owner/repo'),
    /credential/i
  );
});

test('T2 S1: parseGithubRepository rejects non-HTTPS protocols', () => {
  assert.throws(() => parseGithubRepository('http://github.com/owner/repo'), /protocol|https/i);
  assert.throws(() => parseGithubRepository('ssh://git@github.com/owner/repo'), /protocol|https/i);
  assert.throws(() => parseGithubRepository('git://github.com/owner/repo'), /protocol|https/i);
  assert.throws(() => parseGithubRepository('git@github.com:owner/repo.git'), /protocol|https/i);
  assert.throws(() => parseGithubRepository('file:///etc/passwd'), /protocol|https/i);
});

test('T2 S1: parseGithubRepository rejects non-github hosts', () => {
  assert.throws(() => parseGithubRepository('https://gitlab.com/owner/repo'), /host|github\.com/i);
  assert.throws(() => parseGithubRepository('https://github.evil.com/owner/repo'), /host|github\.com/i);
});

test('T2 S1: parseGithubRepository rejects flag injection, directory traversal and malformed inputs', () => {
  assert.throws(() => parseGithubRepository('-o/repo'), /invalid/i);
  assert.throws(() => parseGithubRepository('--upload-pack=foo'), /invalid/i);
  assert.throws(() => parseGithubRepository('../evil/repo'), /invalid/i);
  assert.throws(() => parseGithubRepository('owner/../repo'), /invalid/i);
  assert.throws(() => parseGithubRepository('owner/repo/extra'), /invalid/i);
  assert.throws(() => parseGithubRepository(''), /invalid|required/i);
  assert.throws(() => parseGithubRepository('   '), /invalid|required/i);
  assert.throws(() => parseGithubRepository('owner'), /invalid/i);
});

// ---------------------------------------------------------------------------
// 2. Child process environment construction & credential protection
// ---------------------------------------------------------------------------

test('T2 S2: buildChildGitEnv scrubs inherited GIT_CONFIG_* and parameters', () => {
  const origEnv = process.env;
  try {
    process.env = {
      ...origEnv,
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'malicious',
      GIT_CONFIG_PARAMETERS: "'core.autocrlf=true'",
      GH_TOKEN: 'ambient-gh-token',
      GITHUB_TOKEN: 'ambient-github-token',
    };

    const env = buildChildGitEnv(undefined, { isAnonymous: true });
    assert.strictEqual(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.strictEqual(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.strictEqual(env.GH_TOKEN, undefined);
    assert.strictEqual(env.GITHUB_TOKEN, undefined);
  } finally {
    process.env = origEnv;
  }
});

test('T2 S2: buildChildGitEnv sets protocol restriction, terminal prompt and empty templates', () => {
  const env = buildChildGitEnv();
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(env.GIT_ASKPASS, '');
  assert.strictEqual(env.SSH_ASKPASS, '');
  assert.strictEqual(env.GIT_ALLOW_PROTOCOL, 'https');

  const count = parseInt(env.GIT_CONFIG_COUNT || '0', 10);
  assert.ok(count >= 3);

  const configs: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    configs[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
  }

  assert.strictEqual(configs['credential.helper'], '');
  assert.strictEqual(configs['http.followRedirects'], 'false');
  assert.strictEqual(configs['init.templateDir'], '');
});

test('T2 S2: buildChildGitEnv injects url-scoped Basic x-access-token header for PAT and strips ambient tokens', () => {
  const origEnv = process.env;
  try {
    process.env = {
      ...origEnv,
      GH_TOKEN: 'ambient-token',
      GITHUB_TOKEN: 'ambient-token-2',
    };

    const pat = 'ghp_secretTokenValue123456';
    const env = buildChildGitEnv(pat);

    // Ambient tokens must be stripped
    assert.strictEqual(env.GH_TOKEN, undefined);
    assert.strictEqual(env.GITHUB_TOKEN, undefined);

    const count = parseInt(env.GIT_CONFIG_COUNT || '0', 10);
    const configs: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      configs[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
    }

    const expectedAuth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${pat}`).toString('base64')}`;
    assert.strictEqual(configs['http.https://github.com/.extraheader'], expectedAuth);
  } finally {
    process.env = origEnv;
  }
});

test('T2 S2: buildChildGitEnv rejects tokens with CRLF injection characters', () => {
  assert.throws(() => buildChildGitEnv('token\r\nInjected: value'), /invalid/i);
  assert.throws(() => buildChildGitEnv('token\nInjected: value'), /invalid/i);
});

// ---------------------------------------------------------------------------
// 3. Auth status detection
// ---------------------------------------------------------------------------

test('T2 S3: getGithubAuthStatus returns {installed: false, authenticated: false} when gh is missing', async () => {
  setProcessRunnerForTest(async (_file, _args, options) => {
    assert.ok(options.timeout && options.timeout <= 5000, 'Probe timeout must be <= 5000ms');
    const err: any = new Error('spawn gh ENOENT');
    err.code = 'ENOENT';
    throw err;
  });

  try {
    const status = await getGithubAuthStatus();
    assert.deepStrictEqual(status, { installed: false, authenticated: false });
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T2 S3: getGithubAuthStatus returns {installed: true, authenticated: false} when gh exits non-zero', async () => {
  setProcessRunnerForTest(async (_file, args, options) => {
    assert.ok(options.timeout && options.timeout <= 5000, 'Probe timeout must be <= 5000ms');
    if (args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    // gh auth status exits with 1 when unauthenticated
    return { stdout: '', stderr: 'You are not logged into any GitHub hosts.', exitCode: 1 };
  });

  try {
    const status = await getGithubAuthStatus();
    assert.deepStrictEqual(status, { installed: true, authenticated: false });
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T2 S3: getGithubAuthStatus returns {installed: true, authenticated: true, username} and never leaks secrets', async () => {
  setProcessRunnerForTest(async (_file, args, options) => {
    assert.ok(options.timeout && options.timeout <= 5000, 'Probe timeout must be <= 5000ms');
    if (args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    return {
      stdout: 'Logged in to github.com account testuser (keyring)\nToken: gho_secret_12345',
      stderr: '',
      exitCode: 0,
    };
  });

  try {
    const status = await getGithubAuthStatus();
    assert.deepStrictEqual(status, { installed: true, authenticated: true, username: 'testuser' });
    // Verify no secret leak on status object
    assert.strictEqual(Object.keys(status).sort().join(','), 'authenticated,installed,username');
    assert.strictEqual((status as any).token, undefined);
  } finally {
    setProcessRunnerForTest(null);
  }
});

// ---------------------------------------------------------------------------
// 4. Destination validation & atomic reservation
// ---------------------------------------------------------------------------

test('T2 S4: cloneGithubRepository rejects non-existent parent directory', async (_t) => {
  const nonExistent = path.join(os.tmpdir(), `non-existent-parent-${Date.now()}`);
  await assert.rejects(
    async () => {
      await cloneGithubRepository({
        repository: 'octocat/Hello-World',
        parentPath: nonExistent,
      });
    },
    /parent directory does not exist/i
  );
});

test('T2 S4: cloneGithubRepository rejects pre-existing destination and preserves foreign data', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-parent-test-'));
  const targetDir = path.join(parentDir, 'Hello-World');
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, 'foreign.txt'), 'precious user data');

  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  await assert.rejects(
    async () => {
      await cloneGithubRepository({
        repository: 'octocat/Hello-World',
        parentPath: parentDir,
      });
    },
    /already exists/i
  );

  // Pre-existing directory and foreign file must be untouched!
  assert.ok(fs.existsSync(path.join(targetDir, 'foreign.txt')));
  assert.strictEqual(fs.readFileSync(path.join(targetDir, 'foreign.txt'), 'utf8'), 'precious user data');
});

// ---------------------------------------------------------------------------
// 5. Clone execution: precedence, argument vectors, timeout and cleanup
// ---------------------------------------------------------------------------

test('T2 S5: clone with explicit PAT uses git clone with extraheader, never argv token, and timeout 120s', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-pat-test-'));
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  const pat = 'ghp_mySecretEphemeralToken';
  let capturedCmd = '';
  let capturedArgs: string[] = [];
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedTimeout: number | undefined;

  setProcessRunnerForTest(async (file, args, options) => {
    capturedCmd = file;
    capturedArgs = args;
    capturedEnv = options.env;
    capturedTimeout = options.timeout;
    return { stdout: 'Cloned successfully', stderr: '', exitCode: 0 };
  });

  try {
    const res = await cloneGithubRepository({
      repository: 'octocat/Hello-World',
      parentPath: parentDir,
      token: pat,
    });

    assert.strictEqual(capturedCmd, 'git');
    assert.strictEqual(capturedTimeout, 120_000, 'Clone timeout must be 120s');
    // Token must NOT be in argv!
    assert.ok(!capturedArgs.some((a) => a.includes(pat)), 'Token must never be in argv');
    assert.strictEqual(capturedArgs[0], 'clone');
    assert.strictEqual(capturedArgs[1], '--');
    assert.strictEqual(capturedArgs[2], 'https://github.com/octocat/Hello-World.git');
    assert.strictEqual(capturedArgs[3], path.join(parentDir, 'Hello-World'));

    // Token must be in url-scoped extraheader in env
    const count = parseInt(capturedEnv?.GIT_CONFIG_COUNT || '0', 10);
    const configs: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      configs[capturedEnv![`GIT_CONFIG_KEY_${i}`]!] = capturedEnv![`GIT_CONFIG_VALUE_${i}`]!;
    }
    const expectedHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${pat}`).toString('base64')}`;
    assert.strictEqual(configs['http.https://github.com/.extraheader'], expectedHeader);

    assert.strictEqual(res.path, path.join(parentDir, 'Hello-World'));
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T2 S5: clone without PAT and authenticated gh uses gh repo clone with canonical HTTPS URL', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-gh-test-'));
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  const calls: Array<{ file: string; args: string[]; timeout?: number }> = [];

  setProcessRunnerForTest(async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth') && args.includes('status')) {
      return { stdout: 'Logged in as testuser', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('repo') && args.includes('clone')) {
      return { stdout: 'Cloned into destination', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'Unknown command', exitCode: 1 };
  });

  try {
    const res = await cloneGithubRepository({
      repository: 'octocat/Hello-World',
      parentPath: parentDir,
    });

    const cloneCall = calls.find((c) => c.args.includes('repo') && c.args.includes('clone'));
    assert.ok(cloneCall, 'Must call gh repo clone');
    assert.strictEqual(cloneCall.file, 'gh');
    assert.strictEqual(cloneCall.timeout, 120_000);
    // Must force canonical HTTPS URL even if gh prefers SSH
    assert.ok(cloneCall.args.includes('https://github.com/octocat/Hello-World.git'));
    assert.strictEqual(res.path, path.join(parentDir, 'Hello-World'));
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T2 S5: clone without PAT and unauthenticated gh uses git clone anonymously', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-anon-test-'));
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  let gitCloneCalled = false;
  let capturedEnv: NodeJS.ProcessEnv | undefined;

  setProcessRunnerForTest(async (file, args, options) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      // Unauthenticated gh
      return { stdout: '', stderr: 'Not logged in', exitCode: 1 };
    }
    if (file === 'git' && args.includes('clone')) {
      gitCloneCalled = true;
      capturedEnv = options.env;
      return { stdout: 'Cloned anonymously', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const res = await cloneGithubRepository({
      repository: 'octocat/Hello-World',
      parentPath: parentDir,
    });

    assert.ok(gitCloneCalled, 'Must fall back to git clone');
    assert.strictEqual(res.path, path.join(parentDir, 'Hello-World'));
    // Ambient tokens must be stripped in anonymous mode
    assert.strictEqual(capturedEnv?.GH_TOKEN, undefined);
    assert.strictEqual(capturedEnv?.GITHUB_TOKEN, undefined);
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T2 S5: clone failure cleans up only reserved destination and sanitizes errors without leaking token', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-fail-test-'));
  const targetDir = path.join(parentDir, 'Hello-World');
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  const secretPat = 'ghp_superSecretTokenValue999';

  setProcessRunnerForTest(async (_file, _args, _options) => {
    // Simulate git failure with stderr that might contain internal error details
    return {
      stdout: '',
      stderr: `fatal: Authentication failed for 'https://github.com/octocat/Hello-World.git' using ${secretPat}`,
      exitCode: 128,
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
        // Secret token must NEVER be leaked in the error!
        assert.ok(!err.message.includes(secretPat), 'Secret token must never be leaked in error');
        return true;
      }
    );

    // Reserved destination must be cleaned up!
    assert.strictEqual(fs.existsSync(targetDir), false, 'Reserved destination must be cleaned up on failure');
    // Parent directory must still exist!
    assert.strictEqual(fs.existsSync(parentDir), true, 'Parent directory must be preserved');
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T2 S5: clone with authenticated gh falls back to anonymous git clone if gh fails (e.g. Linux SSH/keyring issues)', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-fallback-test-'));
  t.after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  let ghCalled = false;
  let gitFallbackCalled = false;

  setProcessRunnerForTest(async (file, args, _options) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      // Authenticated gh CLI
      return { stdout: 'Logged in to github.com as testuser', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('repo') && args.includes('clone')) {
      ghCalled = true;
      // Simulate Linux gh failure (e.g. SSH permission denied or keyring failure)
      return { stdout: '', stderr: 'git@github.com: Permission denied (publickey).', exitCode: 1 };
    }
    if (file === 'git' && args.includes('clone')) {
      gitFallbackCalled = true;
      // Fallback succeeds anonymously for public repository
      return { stdout: 'Cloned successfully via anonymous HTTPS', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const res = await cloneGithubRepository({
      repository: 'octocat/Hello-World',
      parentPath: parentDir,
    });

    assert.ok(ghCalled, 'Must have attempted gh repo clone first');
    assert.ok(gitFallbackCalled, 'Must have fallen back to anonymous git clone');
    assert.strictEqual(res.path, path.join(parentDir, 'Hello-World'));
  } finally {
    setProcessRunnerForTest(null);
  }
});
