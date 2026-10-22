import {
  getGitHubAuthStatusPi,
  cloneGitHubRepositoryPi,
  listGitHubRepositoriesPi,
  type GitHubAuthStatus,
  type CloneGitHubRepositoryPayload,
  type CloneGitHubRepositoryResult,
  type GitHubOwnerGroup,
  type GitHubRepositorySummary,
  type ListGitHubRepositoriesResult,
} from '@infra/bridge';

export interface GitHubRepoValidationResult {
  valid: boolean;
  normalized?: string;
  errorKey?: string;
}

export const GITHUB_PAT_STORAGE_KEY = 'pi_viewer_github_pat';

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {}
  return null;
}

/**
 * Loads the saved GitHub Personal Access Token from persistent storage.
 */
export function getSavedGitHubPat(storage?: Storage | null): string {
  try {
    const store = resolveStorage(storage);
    return (store?.getItem(GITHUB_PAT_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Persists a GitHub Personal Access Token to local storage for subsequent private repo clones.
 * If an empty or whitespace-only token is provided, the stored token is removed.
 */
export function saveGitHubPat(token: string, storage?: Storage | null): void {
  try {
    const store = resolveStorage(storage);
    const clean = token.trim();
    if (clean) {
      store?.setItem(GITHUB_PAT_STORAGE_KEY, clean);
    } else {
      store?.removeItem(GITHUB_PAT_STORAGE_KEY);
    }
    // Fire-and-forget sync to server viewer storage
    if (typeof window !== 'undefined') {
      import('@infra/viewer-storage')
        .then(({ updateViewerStorageKeyPi }) => {
          void updateViewerStorageKeyPi('githubPat', clean || null);
        })
        .catch(() => {});
    }
  } catch {
    // Fail-safe ignore quota or security exceptions
  }
}

/**
 * Removes the saved GitHub Personal Access Token from persistent storage.
 */
export function clearSavedGitHubPat(storage?: Storage | null): void {
  try {
    const store = resolveStorage(storage);
    store?.removeItem(GITHUB_PAT_STORAGE_KEY);
    // Fire-and-forget sync to server viewer storage
    if (typeof window !== 'undefined') {
      import('@infra/viewer-storage')
        .then(({ updateViewerStorageKeyPi }) => {
          void updateViewerStorageKeyPi('githubPat', null);
        })
        .catch(() => {});
    }
  } catch {
    // Fail-safe ignore
  }
}

export async function probeGitHubPatUser(token: string): Promise<string | undefined> {
  const clean = token.trim();
  if (!clean) return undefined;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${clean}`,
        'User-Agent': 'open-pi-viewer',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.ok) {
      const data: any = await res.json();
      if (data && typeof data.login === 'string') {
        return data.login;
      }
    }
  } catch {}
  return undefined;
}

const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Validates and normalizes user repository input into a credential-free HTTPS GitHub URL.
 * Accepts "owner/repo" or "https://github.com/owner/repo[.git]".
 * Rejects non-GitHub hosts (including www.github.com), query/hash, non-HTTPS protocols,
 * embedded credentials, path traversal, flags, custom ports, and invalid owners.
 */
export function normalizeGitHubRepository(rawInput: string): GitHubRepoValidationResult {
  const input = rawInput.trim();
  if (!input) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_required' };
  }

  // Reject CLI option flags
  if (input.startsWith('-')) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  // Reject embedded credentials or userinfo
  if (input.includes('@')) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  // Reject whitespace inside identity or control characters
  if (/[\s\r\n\0]/.test(input)) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  // Reject query parameters or hash fragments
  if (input.includes('?') || input.includes('#')) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  let owner = '';
  let rawRepo = '';

  if (input.startsWith('https://')) {
    try {
      const url = new URL(input);
      if (url.protocol !== 'https:') {
        return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
      }
      // Strict github.com only - reject www or other subdomains/hosts
      const hostname = url.hostname.toLowerCase();
      if (hostname !== 'github.com') {
        return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
      }
      if (url.username || url.password) {
        return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
      }
      if (url.port || /^https:\/\/[^/]+:\d+/i.test(input)) {
        return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
      }
      if (url.search || url.hash) {
        return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
      }

      const pathSegments = url.pathname.split('/').filter(Boolean);
      if (pathSegments.length !== 2) {
        return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
      }

      owner = pathSegments[0];
      rawRepo = pathSegments[1];
    } catch {
      return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
    }
  } else {
    // Reject other protocols or schemes
    if (input.includes('://') || input.includes(':')) {
      return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
    }

    const parts = input.split('/');
    if (parts.length !== 2) {
      return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
    }

    owner = parts[0];
    rawRepo = parts[1];
  }

  // Reject path traversal tokens
  if (
    owner === '.' ||
    owner === '..' ||
    owner.includes('..') ||
    rawRepo === '.' ||
    rawRepo === '..' ||
    rawRepo.includes('..')
  ) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!repo || repo === '.' || repo === '..' || repo.toLowerCase() === '.git') {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  // Strict owner and repo regex validation aligned with backend
  if (!GITHUB_OWNER_REGEX.test(owner) || !GITHUB_REPO_REGEX.test(repo)) {
    return { valid: false, errorKey: 'projects.github_clone.error_repo_invalid' };
  }

  return {
    valid: true,
    normalized: `https://github.com/${owner}/${repo}`,
  };
}

/**
 * Sanitizes arbitrary backend errors into safe, fixed localized translation keys.
 * Never leaks raw server stderr, credential fragments, or paths into user-facing UI.
 */
export function sanitizeCloneErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const message = String((err as { message?: unknown }).message || '').toLowerCase();
    if (message.includes('timeout') || message.includes('timed out')) {
      return 'projects.github_clone.error_timeout';
    }
    if (
      message.includes('destination directory') ||
      message.includes('cannot create directory') ||
      message.includes('destination permission denied')
    ) {
      return 'projects.github_clone.error_destination_permission';
    }
  } else if (typeof err === 'string') {
    const message = err.toLowerCase();
    if (message.includes('timeout') || message.includes('timed out')) {
      return 'projects.github_clone.error_timeout';
    }
    if (
      message.includes('destination directory') ||
      message.includes('cannot create directory') ||
      message.includes('destination permission denied')
    ) {
      return 'projects.github_clone.error_destination_permission';
    }
  }
  return 'projects.github_clone.error_failed';
}

export interface GitHubCloneState {
  repository: string;
  destinationPath: string;
  token: string;
  hasSavedToken: boolean;
  patUser?: string;
  isSubmitting: boolean;
  authStatus: {
    loading: boolean;
    installed: boolean;
    authenticated: boolean;
    username?: string;
  };
  repositories: {
    loading: boolean;
    error: string | null;
    groups: GitHubOwnerGroup[];
    total: number;
    selectedRepo?: GitHubRepositorySummary;
  };
  error: string | null;
  successPath: string | null;
}

export interface GitHubCloneControllerOptions {
  initialDestinationPath?: string;
  initialRepoState?: {
    loading?: boolean;
    error?: string | null;
    groups: GitHubOwnerGroup[];
    total: number;
    selectedRepo?: GitHubRepositorySummary;
  };
  storage?: Storage | null;
  getAuthStatus?: () => Promise<GitHubAuthStatus>;
  cloneRepository?: (payload: CloneGitHubRepositoryPayload) => Promise<CloneGitHubRepositoryResult>;
  listRepositories?: (payload?: { token?: string }) => Promise<ListGitHubRepositoriesResult>;
  onSuccess?: (clonedPath: string) => void;
  onStateChange?: (state: GitHubCloneState) => void;
}

export interface GitHubCloneController {
  getState: () => GitHubCloneState;
  setRepository: (repo: string) => void;
  setDestinationPath: (dest: string) => void;
  setToken: (token: string) => void;
  clearToken: () => void;
  fetchPatUser: (tokenToProbe?: string) => Promise<string | undefined>;
  loadAuthStatus: () => Promise<void>;
  loadRepositories: () => Promise<void>;
  selectRepository: (repo: GitHubRepositorySummary) => void;
  submit: () => Promise<void>;
  reset: () => void;
  dispose: () => void;
}

export function createGitHubCloneController(
  options: GitHubCloneControllerOptions = {}
): GitHubCloneController {
  const getAuth = options.getAuthStatus ?? getGitHubAuthStatusPi;
  const cloneRepo = options.cloneRepository ?? cloneGitHubRepositoryPi;
  const listRepos = options.listRepositories ?? listGitHubRepositoriesPi;
  const storage = options.storage;
  let isDisposed = false;

  const initialPat = getSavedGitHubPat(storage);

  let state: GitHubCloneState = {
    repository: '',
    destinationPath: options.initialDestinationPath || '',
    token: initialPat,
    hasSavedToken: Boolean(initialPat),
    isSubmitting: false,
    authStatus: {
      loading: false,
      installed: false,
      authenticated: false,
    },
    repositories: {
      loading: Boolean(options.initialRepoState?.loading),
      error: options.initialRepoState?.error ?? null,
      groups: options.initialRepoState?.groups ?? [],
      total: options.initialRepoState?.total ?? 0,
      selectedRepo: options.initialRepoState?.selectedRepo,
    },
    error: null,
    successPath: null,
  };

  const notify = () => {
    if (isDisposed) return;
    options.onStateChange?.({ ...state });
  };

  const updateState = (patch: Partial<GitHubCloneState>) => {
    if (isDisposed) return;
    state = { ...state, ...patch };
    notify();
  };

  const fetchPatUser = async (tokenToProbe?: string): Promise<string | undefined> => {
    const raw = tokenToProbe ?? state.token;
    const clean = raw?.trim();
    if (!clean) {
      updateState({ patUser: undefined });
      return undefined;
    }
    try {
      if (typeof fetch === 'function') {
        const resp = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${clean}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'open-pi-viewer',
          },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && typeof data.login === 'string') {
            if (!isDisposed) {
              updateState({ patUser: data.login });
            }
            return data.login;
          }
        }
      }
    } catch {
      // Non-blocking: network failure or CORS
    }
    if (!isDisposed) {
      updateState({ patUser: undefined });
    }
    return undefined;
  };

  return {
    getState: () => ({ ...state }),

    setRepository: (repository: string) => {
      if (isDisposed) return;
      updateState({ repository, error: null });
    },

    setDestinationPath: (destinationPath: string) => {
      if (isDisposed) return;
      updateState({ destinationPath, error: null });
    },

    setToken: (token: string) => {
      if (isDisposed) return;
      updateState({ token, hasSavedToken: Boolean(token.trim()), error: null });
      void fetchPatUser(token);
    },

    clearToken: () => {
      if (isDisposed) return;
      clearSavedGitHubPat(storage);
      updateState({ token: '', hasSavedToken: false, patUser: undefined });
    },

    fetchPatUser,

    loadAuthStatus: async () => {
      if (isDisposed) return;
      updateState({
        authStatus: { ...state.authStatus, loading: true },
      });
      try {
        const res = await getAuth();
        if (isDisposed) return;
        updateState({
          authStatus: {
            loading: false,
            installed: Boolean(res?.installed),
            authenticated: Boolean(res?.authenticated),
            username: res?.username,
          },
        });
      } catch {
        if (isDisposed) return;
        updateState({
          authStatus: {
            loading: false,
            installed: false,
            authenticated: false,
            username: undefined,
          },
        });
      }
      const effectiveToken = state.token.trim() || getSavedGitHubPat(storage);
      if (effectiveToken) {
        void fetchPatUser(effectiveToken);
      }
    },

    loadRepositories: async () => {
      if (isDisposed) return;
      const effectiveToken = state.token.trim() || getSavedGitHubPat(storage);
      const isAuth = state.authStatus.authenticated || Boolean(effectiveToken);

      if (!isAuth) {
        updateState({
          repositories: {
            loading: false,
            error: 'projects.github_clone.auth_required_browse',
            groups: [],
            total: 0,
          },
        });
        return;
      }

      updateState({
        repositories: { ...state.repositories, loading: true, error: null },
      });

      try {
        const payload = effectiveToken ? { token: effectiveToken } : undefined;
        const res = await listRepos(payload);
        if (isDisposed) return;
        updateState({
          repositories: {
            loading: false,
            error: null,
            groups: res?.groups || [],
            total: res?.total || 0,
          },
        });
      } catch (err: any) {
        if (isDisposed) return;
        const safeError = sanitizeCloneErrorMessage(err);
        updateState({
          repositories: {
            ...state.repositories,
            loading: false,
            error: safeError,
          },
        });
      }
    },

    selectRepository: (repo: GitHubRepositorySummary) => {
      if (isDisposed) return;
      updateState({
        repository: repo.fullName,
        repositories: {
          ...state.repositories,
          selectedRepo: repo,
        },
        error: null,
      });
    },

    submit: async () => {
      // Block duplicate concurrent submissions or disposed operations
      if (isDisposed || state.isSubmitting) {
        return;
      }

      // Validate repository
      const validation = normalizeGitHubRepository(state.repository);
      if (!validation.valid || !validation.normalized) {
        updateState({
          error: validation.errorKey || 'projects.github_clone.error_repo_invalid',
        });
        return;
      }

      // Validate destination
      const trimmedDest = state.destinationPath.trim();
      if (!trimmedDest) {
        updateState({
          error: 'projects.github_clone.error_destination_required',
        });
        return;
      }

      // Determine token handling:
      // PAT is primary: if entered or saved, send it (and persist it for this instance)
      // If NO PAT is present, fallback to gh CLI session (or anonymous for public repos)
      let tokenToSend: string | undefined = undefined;

      const trimmedToken = state.token.trim();
      const savedToken = getSavedGitHubPat(storage);
      const effectiveToken = trimmedToken || savedToken;

      if (effectiveToken) {
        tokenToSend = effectiveToken;
        saveGitHubPat(effectiveToken, storage);
        updateState({ token: effectiveToken, hasSavedToken: true });
      } else {
        clearSavedGitHubPat(storage);
        updateState({ token: '', hasSavedToken: false });
      }

      updateState({
        isSubmitting: true,
        error: null,
      });

      const payload: CloneGitHubRepositoryPayload = {
        repository: validation.normalized,
        parentPath: trimmedDest,
        ...(tokenToSend ? { token: tokenToSend } : {}),
      };

      try {
        const res = await cloneRepo(payload);
        if (isDisposed) return;
        updateState({
          isSubmitting: false,
          successPath: res.path,
          error: null,
        });
        options.onSuccess?.(res.path);
      } catch (err) {
        if (isDisposed) return;
        // UI errors are safe fixed localized text, never arbitrary server error containing secrets
        const safeErrorKey = sanitizeCloneErrorMessage(err);
        updateState({
          isSubmitting: false,
          error: safeErrorKey,
        });
        // No project registration on failure
      }
    },

    reset: () => {
      if (isDisposed) return;
      const currentSaved = getSavedGitHubPat(storage);
      updateState({
        repository: '',
        token: currentSaved,
        hasSavedToken: Boolean(currentSaved),
        isSubmitting: false,
        error: null,
        successPath: null,
      });
    },

    dispose: () => {
      isDisposed = true;
      state = {
        ...state,
        isSubmitting: false,
      };
    },
  };
}
