import { loadViewerStorage } from './storage';

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
