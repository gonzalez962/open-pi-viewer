import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// Authorization & Security Boundary
// ---------------------------------------------------------------------------
// Existing web authentication middleware (webAuth.middleware in server/web-api.ts)
// is installed before the /api/ipc route, guarding all IPC dispatching when web
// authentication is enabled (PI_VIEWER_AUTH_ENABLED=true).
//
// The separate oauthAccess.requireOAuthOwner check strictly gates built-in OAuth
// commands (PROTECTED_OAUTH_COMMANDS). The GitHub integration commands
// (get_github_auth_status, clone_github_repository) follow the standard IPC
// authorization boundary and do not expand unrelated OAuth scope.
//
// Security invariants:
// - Ephemeral PAT: used only for a single operation in a child-process environment.
//   Never stored in localStorage, credential files, git config on disk, or remote URLs.
// - Argument vectors: all commands are executed via execFile / spawn with explicit
//   argument arrays and shell: false, eliminating shell injection vulnerabilities.
// - Child environment: Git configs are passed via GIT_CONFIG_COUNT/KEY_n/VALUE_n.
//   Host-process note: process environment is visible to other local processes
//   running under the same OS user. It avoids disk persistence and argv exposure.
// - Inherited Git environment (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS, askpass)
//   is scrubbed so ambient host configs cannot override security boundaries.
// - Credential material and tokens are never leaked in IPC results, errors, or logs.
// ---------------------------------------------------------------------------

export interface GithubAuthStatus {
  installed: boolean;
  authenticated: boolean;
  username?: string;
}

export interface CloneGithubRepositoryArgs {
  repository: string;
  parentPath: string;
  token?: string;
}

export interface CloneGithubRepositoryResult {
  path: string;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProcessRunner = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  }
) => Promise<ProcessRunResult>;

const PROBE_TIMEOUT_MS = 5_000;
const CLONE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB buffer limit per stream

let customProcessRunner: ProcessRunner | null = null;

export function setProcessRunnerForTest(runner?: ProcessRunner | null): void {
  customProcessRunner = runner ?? null;
}

export async function defaultProcessRunner(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  }
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const cleanupTimers = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          if (child.pid) {
            if (process.platform === 'win32') {
              try {
                childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                  windowsHide: true,
                  stdio: 'ignore',
                }).on('error', () => {});
              } catch {}
            }
          }
          child.kill('SIGTERM');
        } catch {}

        // Destroy stdio pipes so descendants holding open pipe handles do not cause indefinite hang
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {}

        // Secondary bounded timer to force settlement if child or descendants hang
        forceKillTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanupTimers();
            try {
              child.kill('SIGKILL');
            } catch {}
            const err = new Error(`Command timed out after ${options.timeout}ms`);
            (err as any).code = 'ETIMEDOUT';
            reject(err);
          }
        }, 500);
        forceKillTimer.unref?.();
      }, options.timeout);
    }

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdout.length;
        stdout += chunk.toString('utf8').slice(0, remaining);
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderr.length;
        stderr += chunk.toString('utf8').slice(0, remaining);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    });

    child.on('exit', () => {
      if (timedOut && !settled) {
        settled = true;
        cleanupTimers();
        const err = new Error(`Command timed out after ${options.timeout}ms`);
        (err as any).code = 'ETIMEDOUT';
        reject(err);
      }
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (timedOut) {
        const err = new Error(`Command timed out after ${options.timeout}ms`);
        (err as any).code = 'ETIMEDOUT';
        return reject(err);
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (signal ? 1 : 0),
      });
    });
  });
}

function getRunner(): ProcessRunner {
  return customProcessRunner ?? defaultProcessRunner;
}

// ---------------------------------------------------------------------------
// Repository Identity Validation & Canonicalization
// ---------------------------------------------------------------------------

export interface ParsedGithubRepository {
  owner: string;
  repo: string;
  canonicalHttpsUrl: string;
}

const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9_.-]{1,100}$/;

export function parseGithubRepository(input: unknown): ParsedGithubRepository {
  if (typeof input !== 'string') {
    throw new Error('Repository is required and must be a string');
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Repository is required and cannot be empty');
  }

  // Reject option/flag injection
  if (trimmed.startsWith('-')) {
    throw new Error(`Invalid repository identifier: "${trimmed}"`);
  }

  // Reject forbidden control characters, spaces or null bytes
  if (/[\s\r\n\0]/.test(trimmed)) {
    throw new Error('Repository identifier contains invalid whitespace or control characters');
  }

  let owner = '';
  let repo = '';

  if (trimmed.startsWith('https://')) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      throw new Error(`Invalid GitHub repository URL: "${trimmed}"`);
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTPS protocol is supported for GitHub repositories');
    }

    if (parsedUrl.hostname.toLowerCase() !== 'github.com') {
      throw new Error(`Unsupported host "${parsedUrl.hostname}". Only github.com is supported`);
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('Repository URL must not contain embedded credentials');
    }

    if (parsedUrl.port) {
      throw new Error('Repository URL must not specify a custom port');
    }

    if (parsedUrl.search || parsedUrl.hash) {
      throw new Error('Repository URL must not contain query parameters or hash fragments');
    }

    // Pathname should be /<owner>/<repo>[.git][/]
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new Error(`Invalid GitHub repository path: "${parsedUrl.pathname}"`);
    }

    owner = segments[0];
    repo = segments[1];
  } else {
    // Reject arbitrary scheme/transport prefixes
    if (trimmed.includes('://') || trimmed.includes('@') || trimmed.includes(':')) {
      throw new Error('Unsupported protocol or identity format. Only owner/repo or https://github.com/owner/repo is supported');
    }

    const segments = trimmed.split('/');
    if (segments.length !== 2) {
      throw new Error(`Invalid GitHub repository format: "${trimmed}". Expected owner/repo`);
    }

    owner = segments[0];
    repo = segments[1];
  }

  // Strip optional .git suffix from repo
  if (repo.toLowerCase().endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  // Reject path traversal tokens
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new Error('Directory traversal elements are not allowed in repository identifier');
  }

  if (!GITHUB_OWNER_REGEX.test(owner)) {
    throw new Error(`Invalid GitHub owner name: "${owner}"`);
  }

  if (!GITHUB_REPO_REGEX.test(repo)) {
    throw new Error(`Invalid GitHub repository name: "${repo}"`);
  }

  const canonicalHttpsUrl = `https://github.com/${owner}/${repo}.git`;

  return {
    owner,
    repo,
    canonicalHttpsUrl,
  };
}

// ---------------------------------------------------------------------------
// Child Process Environment Construction
// ---------------------------------------------------------------------------

/**
 * Builds a hardened, URL-scoped process environment for child git/gh execution.
 *
 * NOTE ON ENVIRONMENT SECURITY:
 * Child process environment variables are memory-only and ephemeral for the lifetime
 * of the spawned subprocess. They are not persisted to ~/.gitconfig, repo config,
 * or shell history. However, environment variables may be inspected by other local
 * processes running under the same operating system user account (e.g. via /proc on
 * Linux or Process Explorer on Windows). They are host-process sensitive.
 */
export interface BuildChildGitEnvOptions {
  isAnonymous?: boolean;
  useGhCredentialHelper?: boolean;
  isolateConfig?: boolean;
  ceilingDir?: string;
}

const OS_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export function buildChildGitEnv(
  token?: string,
  options: BuildChildGitEnvOptions = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // 1. Scrub inherited GIT_CONFIG_*, GIT_TRACE*, GIT_DIR, GIT_WORK_TREE, and other repo overrides
  // to prevent ambient overrides and prevent PAT leakage via Git trace diagnostics
  const scrubOverrides = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_TEMPLATE_DIR',
    'GIT_GRAFT_FILE',
    'GIT_SSH_COMMAND',
    'GIT_CEILING_DIRECTORIES',
  ]);

  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith('GIT_CONFIG') ||
      upper.startsWith('GIT_TRACE') ||
      scrubOverrides.has(upper)
    ) {
      delete env[key];
    }
  }

  // 2. Strip ambient GitHub tokens for anonymous clones or explicit token clones
  // so ambient credentials do not leak or override user intent
  if (options.isAnonymous || (typeof token === 'string' && token.trim().length > 0)) {
    delete env['GH_TOKEN'];
    delete env['GITHUB_TOKEN'];
    delete env['GH_ENTERPRISE_TOKEN'];
    delete env['GITHUB_ENTERPRISE_TOKEN'];
  }

  // 3. Disable interactive terminal prompts and askpass helpers
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_ASKPASS'] = '';
  env['SSH_ASKPASS'] = '';

  // 4. Strictly limit transport protocols to HTTPS
  env['GIT_ALLOW_PROTOCOL'] = 'https';

  // 5. Isolate system and global git config if requested (for clone execution)
  if (options.isolateConfig) {
    env['GIT_CONFIG_NOSYSTEM'] = '1';
    env['GIT_CONFIG_GLOBAL'] = OS_NULL_DEVICE;
    if (options.ceilingDir) {
      env['GIT_CEILING_DIRECTORIES'] = options.ceilingDir;
    }
  }

  // 6. Injected URL-scoped and security Git configs
  const gitConfigs: Array<{ key: string; value: string }> = [
    // Disable external credential helpers
    { key: 'credential.helper', value: '' },
    // Prevent redirect following to prevent credential leaks to arbitrary endpoints
    { key: 'http.followRedirects', value: 'false' },
    // Prevent execution of template hooks during clone
    { key: 'init.templateDir', value: '' },
    // Neutralize ambient URL rewrites (e.g. url.*.insteadOf rewriting https to ssh or evil URLs)
    { key: 'url.https://github.com/.insteadOf', value: 'https://github.com/' },
  ];

  // If PAT is provided, inject url-scoped HTTP Basic extraheader
  if (typeof token === 'string' && token.trim().length > 0) {
    const cleanToken = token.trim();
    if (/[\r\n\0]/.test(cleanToken)) {
      throw new Error('Token contains invalid characters');
    }
    const basicAuth = Buffer.from(`x-access-token:${cleanToken}`).toString('base64');
    gitConfigs.push({
      key: 'http.https://github.com/.extraheader',
      value: `AUTHORIZATION: basic ${basicAuth}`,
    });
  } else if (options.useGhCredentialHelper) {
    // When using authenticated gh CLI, route credential retrieval to gh auth git-credential
    // scoped exclusively to https://github.com without shell token interpolation
    gitConfigs.push({
      key: 'credential.https://github.com.helper',
      value: '!gh auth git-credential',
    });
  }

  env['GIT_CONFIG_COUNT'] = String(gitConfigs.length);
  gitConfigs.forEach((cfg, idx) => {
    env[`GIT_CONFIG_KEY_${idx}`] = cfg.key;
    env[`GIT_CONFIG_VALUE_${idx}`] = cfg.value;
  });

  return env;
}

// ---------------------------------------------------------------------------
// Error Sanitization
// ---------------------------------------------------------------------------

export function sanitizeErrorMessage(rawMessage: string, token?: string): string {
  let sanitized = rawMessage || '';

  if (typeof token === 'string' && token.trim().length > 0) {
    const cleanToken = token.trim();
    sanitized = sanitized.split(cleanToken).join('[REDACTED]');
    try {
      const basicToken = Buffer.from(`x-access-token:${cleanToken}`).toString('base64');
      sanitized = sanitized.split(basicToken).join('[REDACTED]');
    } catch {}
  }

  // Normalize common git/gh error patterns to clean generic messages
  const lower = sanitized.toLowerCase();
  if (
    lower.includes('repository not found') ||
    lower.includes('could not read username') ||
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('not found or access denied') ||
    lower.includes('could not read from remote')
  ) {
    return 'Repository not found or access denied';
  }
  if (lower.includes('destination path already exists') || lower.includes('already exists')) {
    return 'Destination path already exists';
  }
  if (lower.includes('timed out') || lower.includes('etimedout')) {
    return 'Cloning timed out after 120 seconds';
  }
  if (lower.includes('invalid characters') || lower.includes('token contains invalid')) {
    return 'Token contains invalid characters';
  }

  // Generic fixed error for unknown child output: never echo arbitrary child output,
  // secrets, tokens, or URLs to the caller
  return 'Clone operation failed';
}

export function parseGhUsername(output: string): string | undefined {
  if (!output || typeof output !== 'string') return undefined;
  // Match "account <username>" or "Logged in as <username>"
  const match = output.match(/(?:account|Logged in as)\s+([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})/i);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// GitHub Auth Status
// ---------------------------------------------------------------------------

export async function getGithubAuthStatus(): Promise<GithubAuthStatus> {
  const runner = getRunner();

  // 1. Probe gh binary existence
  try {
    const versionRes = await runner('gh', ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
    });
    if (versionRes.exitCode !== 0) {
      return { installed: false, authenticated: false };
    }
  } catch {
    return { installed: false, authenticated: false };
  }

  // 2. Probe gh authentication status
  try {
    const authRes = await runner('gh', ['auth', 'status'], {
      timeout: PROBE_TIMEOUT_MS,
    });
    const authenticated = authRes.exitCode === 0;
    const combined = `${authRes.stdout || ''}\n${authRes.stderr || ''}`;
    const username = authenticated ? parseGhUsername(combined) : undefined;
    return {
      installed: true,
      authenticated,
      ...(username ? { username } : {}),
    };
  } catch {
    return { installed: true, authenticated: false };
  }
}

// ---------------------------------------------------------------------------
// Clone Operation
// ---------------------------------------------------------------------------

export async function cloneGithubRepository(
  args: CloneGithubRepositoryArgs
): Promise<CloneGithubRepositoryResult> {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object with repository and parentPath');
  }

  const { repository, parentPath, token } = args;

  // 1. Validate repository input
  const { repo, canonicalHttpsUrl } = parseGithubRepository(repository);

  // 2. Validate parent directory
  if (!parentPath || typeof parentPath !== 'string' || !parentPath.trim()) {
    throw new Error('Parent directory path is required');
  }

  const resolvedParent = path.resolve(parentPath.trim());
  try {
    const parentStat = fs.statSync(resolvedParent);
    if (!parentStat.isDirectory()) {
      throw new Error(`Parent path "${resolvedParent}" is not a directory`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.message?.includes('not a directory')) {
      throw new Error(`Parent directory does not exist or is not a directory: "${resolvedParent}"`);
    }
    throw err;
  }

  // 3. Determine destination directory and atomically reserve it
  const targetDir = path.join(resolvedParent, repo);

  // Reject path escaping outside parent
  if (path.dirname(targetDir) !== resolvedParent) {
    throw new Error('Destination path traversal detected');
  }

  // Reject pre-existing target (including broken symlinks or existing files)
  try {
    const lstat = fs.lstatSync(targetDir);
    if (lstat) {
      throw new Error(`Destination path already exists: "${targetDir}"`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  // Atomically reserve destination with mkdir (non-recursive)
  try {
    fs.mkdirSync(targetDir, { recursive: false });
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      throw new Error(`Destination path already exists: "${targetDir}"`);
    }
    throw err;
  }

  let reservationOwned = true;

  try {
    const runner = getRunner();
    const hasExplicitToken = typeof token === 'string' && token.trim().length > 0;

    let tool = 'git';
    let toolArgs: string[] = [];
    let childEnv: NodeJS.ProcessEnv;

    const ceilingDir = resolvedParent;

    if (hasExplicitToken) {
      // Ephemeral PAT fallback: strictly uses git clone with url-scoped extraheader
      tool = 'git';
      toolArgs = ['clone', '--', canonicalHttpsUrl, targetDir];
      childEnv = buildChildGitEnv(token, { isolateConfig: true, ceilingDir });
    } else {
      // Check whether gh is authenticated
      const auth = await getGithubAuthStatus();
      if (auth.installed && auth.authenticated) {
        // gh authenticated: force canonical HTTPS URL so gh doesn't attempt SSH
        tool = 'gh';
        toolArgs = ['repo', 'clone', canonicalHttpsUrl, targetDir];
        childEnv = buildChildGitEnv(undefined, {
          isAnonymous: false,
          useGhCredentialHelper: true,
          isolateConfig: true,
          ceilingDir,
        });
      } else {
        // Anonymous public clone: use git clone with ambient gh tokens stripped
        tool = 'git';
        toolArgs = ['clone', '--', canonicalHttpsUrl, targetDir];
        childEnv = buildChildGitEnv(undefined, {
          isAnonymous: true,
          isolateConfig: true,
          ceilingDir,
        });
      }
    }

    const runResult = await runner(tool, toolArgs, {
      cwd: targetDir,
      env: childEnv,
      timeout: CLONE_TIMEOUT_MS,
    });

    if (runResult.exitCode !== 0) {
      const combinedOutput = `${runResult.stderr}\n${runResult.stdout}`;
      throw new Error(sanitizeErrorMessage(combinedOutput, token));
    }

    // Success: reservation is now the cloned repository
    reservationOwned = false;
    return { path: targetDir };
  } catch (err: any) {
    // Only clean up the destination if WE reserved it in this operation
    if (reservationOwned) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {}
    }
    throw new Error(sanitizeErrorMessage(err.message || String(err), token));
  }
}
