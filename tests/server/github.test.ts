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
  listGithubRepositories,
  groupRepositoriesByOwner,
  parsePaginatedJsonArrays,
  setProcessRunnerForTest,
  createGithubRepository,
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

// ---------------------------------------------------------------------------
// 6. List Repositories and Categorization by Owner
// ---------------------------------------------------------------------------

test('T6 S1: parsePaginatedJsonArrays handles single and concatenated arrays from --paginate', () => {
  const single = '[{"name":"repo1"},{"name":"repo2"}]';
  const multi = '[{"name":"repo1"}][{"name":"repo2"},{"name":"repo3"}]';
  assert.deepStrictEqual(parsePaginatedJsonArrays(single), [{ name: 'repo1' }, { name: 'repo2' }]);
  assert.deepStrictEqual(parsePaginatedJsonArrays(multi), [
    { name: 'repo1' },
    { name: 'repo2' },
    { name: 'repo3' },
  ]);
  assert.deepStrictEqual(parsePaginatedJsonArrays(''), []);
});

test('T6 S2: groupRepositoriesByOwner categorizes repos by owner, places current user first, and handles deduplication', () => {
  const sampleRepos: any[] = [
    {
      id: 1,
      name: 'widget-core',
      fullName: 'acme-corp/widget-core',
      owner: 'acme-corp',
      ownerType: 'Organization',
      ownerAvatarUrl: 'https://avatars.example.com/acme',
      isPrivate: true,
      pushedAt: '2026-03-01T00:00:00Z',
    },
    {
      id: 2,
      name: 'personal-site',
      fullName: 'alice/personal-site',
      owner: 'alice',
      ownerType: 'User',
      ownerAvatarUrl: 'https://avatars.example.com/alice',
      isPrivate: false,
      pushedAt: '2026-04-01T00:00:00Z',
    },
    {
      id: 3,
      name: 'dotfiles',
      fullName: 'alice/dotfiles',
      owner: 'alice',
      ownerType: 'User',
      isPrivate: true,
      pushedAt: '2026-02-01T00:00:00Z',
    },
    {
      id: 4,
      name: 'collab-repo',
      fullName: 'bob/collab-repo',
      owner: 'bob',
      ownerType: 'User',
      isPrivate: true,
      pushedAt: '2026-01-01T00:00:00Z',
    },
    {
      // Duplicate ID test
      id: 2,
      name: 'personal-site-dupe',
      fullName: 'alice/personal-site',
      owner: 'alice',
    },
  ];

  const groups = groupRepositoriesByOwner(sampleRepos, 'alice');

  // Should have 3 groups: alice (current user), acme-corp, bob
  assert.strictEqual(groups.length, 3);

  // Group 0 must be current user 'alice'
  assert.strictEqual(groups[0].owner, 'alice');
  assert.strictEqual(groups[0].isCurrentUser, true);
  assert.strictEqual(groups[0].repositories.length, 2);
  // Repositories within group are sorted alphabetically: dotfiles before personal-site
  assert.strictEqual(groups[0].repositories[0].name, 'dotfiles');
  assert.strictEqual(groups[0].repositories[1].name, 'personal-site');

  // Next groups sorted alphabetically: acme-corp, bob
  assert.strictEqual(groups[1].owner, 'acme-corp');
  assert.strictEqual(groups[1].isCurrentUser, false);
  assert.strictEqual(groups[1].ownerType, 'Organization');
  assert.strictEqual(groups[1].repositories.length, 1);

  assert.strictEqual(groups[2].owner, 'bob');
  assert.strictEqual(groups[2].isCurrentUser, false);
  assert.strictEqual(groups[2].repositories.length, 1);
});

test('T6 S3: listGithubRepositories via gh CLI parses paginated output and returns grouped result', async () => {
  setProcessRunnerForTest(async (file, args, _options) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      return { stdout: 'Logged in to github.com account octocat (keyring)', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('api')) {
      const page1 = JSON.stringify([
        {
          id: 101,
          name: 'octo-lib',
          full_name: 'octocat/octo-lib',
          owner: { login: 'octocat', type: 'User', avatar_url: 'https://avatars.com/octocat' },
          private: false,
          description: 'Official octo library',
          default_branch: 'main',
          updated_at: '2026-05-01T00:00:00Z',
          pushed_at: '2026-05-01T00:00:00Z',
          html_url: 'https://github.com/octocat/octo-lib',
          clone_url: 'https://github.com/octocat/octo-lib.git',
          fork: false,
          archived: false,
        },
      ]);
      const page2 = JSON.stringify([
        {
          id: 202,
          name: 'external-tool',
          full_name: 'acme/external-tool',
          owner: { login: 'acme', type: 'Organization', avatar_url: 'https://avatars.com/acme' },
          private: true,
          description: 'Acme external tool',
          default_branch: 'master',
          updated_at: '2026-04-01T00:00:00Z',
          pushed_at: '2026-04-01T00:00:00Z',
          html_url: 'https://github.com/acme/external-tool',
          clone_url: 'https://github.com/acme/external-tool.git',
          fork: false,
          archived: false,
        },
      ]);
      return { stdout: `${page1}${page2}`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const result = await listGithubRepositories();
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.currentUser, 'octocat');
    assert.strictEqual(result.groups.length, 2);

    // Current user group
    const userGroup = result.groups.find((g) => g.isCurrentUser);
    assert.ok(userGroup, 'Must have current user group');
    assert.strictEqual(userGroup.owner, 'octocat');
    assert.strictEqual(userGroup.repositories[0].name, 'octo-lib');

    // Organization group
    const orgGroup = result.groups.find((g) => g.owner === 'acme');
    assert.ok(orgGroup, 'Must have acme org group');
    assert.strictEqual(orgGroup.ownerType, 'Organization');
    assert.strictEqual(orgGroup.repositories[0].name, 'external-tool');
    assert.strictEqual(orgGroup.repositories[0].isPrivate, true);
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T6 S4: listGithubRepositories throws error when not authenticated and no token', async () => {
  setProcessRunnerForTest(async (file, args, _options) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      return { stdout: '', stderr: 'You are not logged into any GitHub hosts', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    await assert.rejects(
      async () => listGithubRepositories(),
      /authentication required/i
    );
  } finally {
    setProcessRunnerForTest(null);
  }
});

// ---------------------------------------------------------------------------
// 7. Repository Creation
// ---------------------------------------------------------------------------

test('T7 S1: createGithubRepository validates repository name format', async () => {
  await assert.rejects(
    async () => createGithubRepository({ name: '' }),
    /name is required/i
  );
  await assert.rejects(
    async () => createGithubRepository({ name: '   ' }),
    /name is required/i
  );
  await assert.rejects(
    async () => createGithubRepository({ name: '-invalid-flag' }),
    /invalid repository name/i
  );
  await assert.rejects(
    async () => createGithubRepository({ name: 'owner/repo' }),
    /invalid repository name/i
  );
  await assert.rejects(
    async () => createGithubRepository({ name: 'repo with spaces' }),
    /invalid repository name/i
  );
  await assert.rejects(
    async () => createGithubRepository({ name: 'repo\nnewline' }),
    /invalid repository name/i
  );
});

test('T7 S2: createGithubRepository throws when unauthenticated and no token', async () => {
  setProcessRunnerForTest(async (file, args) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      return { stdout: '', stderr: 'You are not logged into any GitHub hosts', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    await assert.rejects(
      async () => createGithubRepository({ name: 'new-app' }),
      /authentication required/i
    );
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T7 S3: createGithubRepository via gh CLI invokes api and returns summary', async () => {
  let capturedArgs: string[] = [];
  setProcessRunnerForTest(async (file, args) => {
    if (file === 'gh' && args.includes('--version')) {
      return { stdout: 'gh version 2.50.0', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('auth')) {
      return { stdout: 'Logged in to github.com account octocat', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && args.includes('api')) {
      capturedArgs = args;
      const createdRepo = {
        id: 999,
        name: 'new-cool-project',
        full_name: 'octocat/new-cool-project',
        owner: { login: 'octocat', type: 'User' },
        private: true,
        description: 'A great new project',
        default_branch: 'main',
        html_url: 'https://github.com/octocat/new-cool-project',
        clone_url: 'https://github.com/octocat/new-cool-project.git',
        fork: false,
      };
      return { stdout: JSON.stringify(createdRepo), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const res = await createGithubRepository({
      name: 'new-cool-project',
      description: 'A great new project',
      isPrivate: true,
      autoInit: true,
    });

    assert.ok(capturedArgs.length > 0);
    assert.strictEqual(res.repository.name, 'new-cool-project');
    assert.strictEqual(res.repository.fullName, 'octocat/new-cool-project');
    assert.strictEqual(res.repository.isPrivate, true);
    assert.strictEqual(res.repository.htmlUrl, 'https://github.com/octocat/new-cool-project');
  } finally {
    setProcessRunnerForTest(null);
  }
});

test('T7 S4: createGithubRepository via PAT uses fetch directly and clones if parentPath provided', async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-github-create-test-'));

  try {
    let fetchCalled = false;
    let fetchUrl = '';
    let fetchHeaders: any = null;
    let fetchBody: any = null;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalled = true;
      fetchUrl = String(input);
      fetchHeaders = init?.headers;
      fetchBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 12345,
          name: 'pat-repo',
          full_name: 'tokenuser/pat-repo',
          owner: { login: 'tokenuser', type: 'User' },
          private: false,
          description: 'Repo via token',
          default_branch: 'main',
          html_url: 'https://github.com/tokenuser/pat-repo',
          clone_url: 'https://github.com/tokenuser/pat-repo.git',
          fork: false,
        }),
      } as any;
    };

    setProcessRunnerForTest(async (file, args, _options) => {
      // Mocking git clone invocation
      if (file === 'git' && args.includes('clone')) {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        return { stdout: 'Cloned successfully', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const res = await createGithubRepository({
      name: 'pat-repo',
      token: 'ghp_secret1234567890123456',
      parentPath: tempDir,
      isPrivate: false,
      description: 'Repo via token',
    });

    assert.ok(fetchCalled);
    assert.strictEqual(fetchUrl, 'https://api.github.com/user/repos');
    assert.strictEqual(fetchHeaders['Authorization'], 'Bearer ghp_secret1234567890123456');
    assert.strictEqual(fetchBody.name, 'pat-repo');
    assert.strictEqual(fetchBody.private, false);
    assert.strictEqual(res.repository.name, 'pat-repo');
    assert.ok(res.path);
    assert.strictEqual(res.path, path.join(tempDir, 'pat-repo'));
  } finally {
    globalThis.fetch = originalFetch;
    setProcessRunnerForTest(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test('T7 S5: createGithubRepository sanitizes PAT from error messages on 422 failure', async () => {
  const originalFetch = globalThis.fetch;
  const token = 'ghp_super_secret_pat_99999999';

  try {
    globalThis.fetch = async (): Promise<Response> => {
      return {
        ok: false,
        status: 422,
        json: async () => ({
          message: `Repository name already exists for token ${token}`,
          errors: [{ message: 'name already exists' }],
        }),
      } as any;
    };

    await assert.rejects(
      async () => createGithubRepository({ name: 'duplicate-repo', token }),
      (err: Error) => {
        assert.ok(!err.message.includes(token), 'Error message must not leak token');
        assert.ok(err.message.includes('[REDACTED]') || err.message.includes('already exists'));
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

