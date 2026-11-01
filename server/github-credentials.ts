import { loadViewerStorage, saveViewerStorage } from './storage';

export function getSavedGithubPat(): string {
  const value = loadViewerStorage().githubPat;
  return typeof value === 'string' ? value.trim() : '';
}

export function githubCredentialStatus() { return { configured: Boolean(getSavedGithubPat()) }; }

export function saveGithubCredential(token: unknown, importOnly = false) {
  // Synchronous read/check/write has no await: concurrent IPC handlers cannot interleave in this process.
  if (importOnly && getSavedGithubPat()) return { configured: true };
  if (typeof token !== 'string' || !token.trim() || /[\x00-\x1f\x7f]/.test(token.trim())) throw new Error('Invalid GitHub token');
  saveViewerStorage({ githubPat: token.trim() });
  return githubCredentialStatus();
}

export function clearGithubCredential() {
  saveViewerStorage({ githubPat: null });
  return githubCredentialStatus();
}

// Git invokes this shell function for get/store/erase. The secret is only in the
// child environment; neither the helper command nor Git configuration contains it.
const githubHelper = `!f() { [ "$1" = get ] || return 0; protocol= host=; while IFS= read -r line && [ -n "$line" ]; do case "$line" in protocol=*) protocol=\${line#protocol=} ;; host=*) host=\${line#host=} ;; esac; done; if [ "$protocol" = https ] && [ "$host" = github.com ]; then printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; fi; }; f`;

export function withGithubCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const saved = loadViewerStorage().githubPat;
  const pat = typeof saved === 'string' ? saved.trim() : '';
  if (!pat) return env;
  if (/[\x00-\x1f\x7f]/.test(pat)) throw new Error('Invalid GitHub token');
  const rawCount = env.GIT_CONFIG_COUNT;
  const count = rawCount === undefined ? 0 : Number(rawCount);
  if (!Number.isSafeInteger(count) || count < 0 || (rawCount !== undefined && !/^\d+$/.test(rawCount))) {
    throw new Error('Invalid Git configuration environment');
  }
  return {
    ...env,
    GH_TOKEN: pat,
    GITHUB_TOKEN: pat,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${count + 1}`]: githubHelper,
  };
}
