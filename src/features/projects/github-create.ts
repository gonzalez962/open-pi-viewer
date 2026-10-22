import {
  getGitHubAuthStatusPi,
  createGitHubRepositoryPi,
  type GitHubAuthStatus,
  type CreateGitHubRepositoryPayload,
  type CreateGitHubRepositoryResult,
} from '@infra/bridge';
import {
  getSavedGitHubPat,
  saveGitHubPat,
  clearSavedGitHubPat,
} from './github-clone';

export {
  getSavedGitHubPat,
  saveGitHubPat,
  clearSavedGitHubPat,
};

export interface GitHubRepoNameValidationResult {
  valid: boolean;
  normalized?: string;
  errorKey?: string;
}

const GITHUB_REPO_NAME_REGEX = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Validates a GitHub repository name according to GitHub naming rules.
 * Must be 1-100 characters containing letters, numbers, hyphens, periods, or underscores.
 * Cannot start with a hyphen or be '.' or '..'.
 */
export function validateGitHubRepoName(rawName: string): GitHubRepoNameValidationResult {
  const name = rawName.trim();
  if (!name) {
    return { valid: false, errorKey: 'projects.github_create.error_name_required' };
  }

  if (name.startsWith('-') || name === '.' || name === '..' || !GITHUB_REPO_NAME_REGEX.test(name)) {
    return { valid: false, errorKey: 'projects.github_create.error_name_invalid' };
  }

  return {
    valid: true,
    normalized: name,
  };
}

/**
 * Sanitizes backend errors into localized translation keys.
 * Protects against leaking secrets, tokens, or raw paths to user interface.
 */
export function sanitizeCreateErrorMessage(err: unknown): string {
  const message = (
    err && typeof err === 'object'
      ? String((err as { message?: unknown }).message || '')
      : typeof err === 'string'
        ? err
        : ''
  ).toLowerCase();

  if (message.includes('already exists')) {
    return 'projects.github_create.error_already_exists';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'projects.github_create.error_timeout';
  }
  if (
    message.includes('destination directory') ||
    message.includes('cannot create directory') ||
    message.includes('permission denied')
  ) {
    return 'projects.github_create.error_destination_permission';
  }
  if (message.includes('authentication') || message.includes('token') || message.includes('credential')) {
    return 'projects.github_create.error_auth';
  }

  return 'projects.github_create.error_failed';
}

export interface GitHubCreateState {
  name: string;
  description: string;
  isPrivate: boolean;
  autoInit: boolean;
  cloneLocally: boolean;
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
  error: string | null;
  successResult: CreateGitHubRepositoryResult | null;
}

export interface GitHubCreateControllerOptions {
  initialDestinationPath?: string;
  storage?: Storage | null;
  getAuthStatus?: () => Promise<GitHubAuthStatus>;
  createRepository?: (payload: CreateGitHubRepositoryPayload) => Promise<CreateGitHubRepositoryResult>;
  onSuccess?: (result: CreateGitHubRepositoryResult) => void;
  onStateChange?: (state: GitHubCreateState) => void;
}

export interface GitHubCreateController {
  getState: () => GitHubCreateState;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setIsPrivate: (isPrivate: boolean) => void;
  setAutoInit: (autoInit: boolean) => void;
  setCloneLocally: (cloneLocally: boolean) => void;
  setDestinationPath: (destinationPath: string) => void;
  setToken: (token: string) => void;
  clearToken: () => void;
  fetchPatUser: (tokenToProbe?: string) => Promise<string | undefined>;
  loadAuthStatus: () => Promise<void>;
  submit: () => Promise<void>;
  reset: () => void;
}

export function createGitHubCreateController(
  options: GitHubCreateControllerOptions = {}
): GitHubCreateController {
  const {
    initialDestinationPath = '',
    storage,
    getAuthStatus = getGitHubAuthStatusPi,
    createRepository = createGitHubRepositoryPi,
    onSuccess,
    onStateChange,
  } = options;

  const savedToken = getSavedGitHubPat(storage);

  const state: GitHubCreateState = {
    name: '',
    description: '',
    isPrivate: false,
    autoInit: true,
    cloneLocally: true,
    destinationPath: initialDestinationPath,
    token: savedToken,
    hasSavedToken: Boolean(savedToken),
    patUser: undefined,
    isSubmitting: false,
    authStatus: {
      loading: false,
      installed: false,
      authenticated: false,
      username: undefined,
    },
    error: null,
    successResult: null,
  };

  const notify = () => {
    onStateChange?.({ ...state });
  };

  const fetchPatUser = async (tokenToProbe?: string): Promise<string | undefined> => {
    const activeToken = (tokenToProbe ?? state.token).trim();
    if (!activeToken || typeof fetch === 'undefined') {
      state.patUser = undefined;
      notify();
      return undefined;
    }
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${activeToken}`,
          'User-Agent': 'open-pi-viewer',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (res.ok) {
        const data: any = await res.json();
        if (data && typeof data.login === 'string') {
          state.patUser = data.login;
          notify();
          return data.login;
        }
      }
    } catch {}
    state.patUser = undefined;
    notify();
    return undefined;
  };

  const loadAuthStatus = async (): Promise<void> => {
    state.authStatus = { ...state.authStatus, loading: true };
    notify();
    try {
      const status = await getAuthStatus();
      state.authStatus = {
        loading: false,
        installed: status.installed,
        authenticated: status.authenticated,
        username: status.username,
      };
    } catch {
      state.authStatus = {
        loading: false,
        installed: false,
        authenticated: false,
        username: undefined,
      };
    }
    notify();
  };

  const setName = (name: string) => {
    state.name = name;
    if (state.error) state.error = null;
    notify();
  };

  const setDescription = (description: string) => {
    state.description = description;
    notify();
  };

  const setIsPrivate = (isPrivate: boolean) => {
    state.isPrivate = isPrivate;
    notify();
  };

  const setAutoInit = (autoInit: boolean) => {
    state.autoInit = autoInit;
    notify();
  };

  const setCloneLocally = (cloneLocally: boolean) => {
    state.cloneLocally = cloneLocally;
    notify();
  };

  const setDestinationPath = (dest: string) => {
    state.destinationPath = dest;
    if (state.error) state.error = null;
    notify();
  };

  const setToken = (token: string) => {
    state.token = token;
    state.hasSavedToken = Boolean(token.trim());
    saveGitHubPat(token, storage);
    void fetchPatUser(token);
    notify();
  };

  const clearToken = () => {
    state.token = '';
    state.hasSavedToken = false;
    state.patUser = undefined;
    clearSavedGitHubPat(storage);
    notify();
  };

  const submit = async (): Promise<void> => {
    if (state.isSubmitting) return;

    // Validate name
    const nameVal = validateGitHubRepoName(state.name);
    if (!nameVal.valid) {
      state.error = nameVal.errorKey || 'projects.github_create.error_name_invalid';
      notify();
      return;
    }

    // If cloning locally, validate destination path
    if (state.cloneLocally && !state.destinationPath.trim()) {
      state.error = 'projects.github_create.error_destination_required';
      notify();
      return;
    }

    state.isSubmitting = true;
    state.error = null;
    notify();

    try {
      const payload: CreateGitHubRepositoryPayload = {
        name: nameVal.normalized!,
        description: state.description.trim() || undefined,
        isPrivate: state.isPrivate,
        autoInit: state.autoInit,
        parentPath: state.cloneLocally ? state.destinationPath.trim() : undefined,
        token: state.token.trim() || undefined,
      };

      const result = await createRepository(payload);
      state.isSubmitting = false;
      state.successResult = result;
      notify();
      onSuccess?.(result);
    } catch (err) {
      state.isSubmitting = false;
      state.error = sanitizeCreateErrorMessage(err);
      notify();
    }
  };

  const reset = () => {
    state.name = '';
    state.description = '';
    state.isPrivate = false;
    state.autoInit = true;
    state.cloneLocally = true;
    state.error = null;
    state.isSubmitting = false;
    state.successResult = null;
    notify();
  };

  return {
    getState: () => ({ ...state }),
    setName,
    setDescription,
    setIsPrivate,
    setAutoInit,
    setCloneLocally,
    setDestinationPath,
    setToken,
    clearToken,
    fetchPatUser,
    loadAuthStatus,
    submit,
    reset,
  };
}
