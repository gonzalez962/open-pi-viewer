import assert from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  getGitHubAuthStatusPi,
  cloneGitHubRepositoryPi,
  listGitHubRepositoriesPi,
  type CloneGitHubRepositoryPayload,
} from '@infra/bridge';
import {
  normalizeGitHubRepository,
  createGitHubCloneController,
  getSavedGitHubPat,
  saveGitHubPat,
  clearSavedGitHubPat,
  sanitizeCloneErrorMessage,
  GITHUB_PAT_STORAGE_KEY,
} from '@features/projects/github-clone';
import { GitHubCloneModal } from '@features/projects/components/GitHubCloneModal';

// Helper mock storage
function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

// 0. PAT Storage tests
test('PAT storage: getSavedGitHubPat, saveGitHubPat, and clearSavedGitHubPat manage storage lifecycle', () => {
  const storage = createMemoryStorage();

  assert.strictEqual(getSavedGitHubPat(storage), '', 'Empty storage returns empty string');

  saveGitHubPat('  ghp_test_token_123  ', storage);
  assert.strictEqual(storage.getItem(GITHUB_PAT_STORAGE_KEY), 'ghp_test_token_123', 'Token is trimmed and saved');
  assert.strictEqual(getSavedGitHubPat(storage), 'ghp_test_token_123', 'getSavedGitHubPat returns saved token');

  clearSavedGitHubPat(storage);
  assert.strictEqual(storage.getItem(GITHUB_PAT_STORAGE_KEY), null, 'Token is removed on clear');
  assert.strictEqual(getSavedGitHubPat(storage), '', 'Cleared storage returns empty string');

  // Saving empty or blank removes the key
  saveGitHubPat('ghp_temp', storage);
  assert.strictEqual(getSavedGitHubPat(storage), 'ghp_temp');
  saveGitHubPat('   ', storage);
  assert.strictEqual(getSavedGitHubPat(storage), '', 'Saving blank string removes token');
});

// 1. Bridge tests
test('bridge: getGitHubAuthStatusPi invokes get_github_auth_status command', async () => {
  let invokedCmd = '';
  const mockInvoke = async <T>(cmd: string): Promise<T> => {
    invokedCmd = cmd;
    return { installed: true, authenticated: true } as T;
  };

  const status = await getGitHubAuthStatusPi(mockInvoke);
  assert.strictEqual(invokedCmd, 'get_github_auth_status');
  assert.deepStrictEqual(status, { installed: true, authenticated: true });
});

test('bridge: cloneGitHubRepositoryPi invokes clone_github_repository with payload', async () => {
  let invokedCmd = '';
  let invokedArgs: Record<string, unknown> | undefined;

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    invokedCmd = cmd;
    invokedArgs = args;
    return { path: '/path/to/cloned/repo' } as T;
  };

  const payload: CloneGitHubRepositoryPayload = {
    repository: 'https://github.com/owner/repo',
    parentPath: '/dest/parent',
    token: 'ghp_secret_token_123',
  };

  const res = await cloneGitHubRepositoryPi(payload, mockInvoke);
  assert.strictEqual(invokedCmd, 'clone_github_repository');
  assert.deepStrictEqual(invokedArgs, { payload });
  assert.strictEqual(res.path, '/path/to/cloned/repo');
});

test('bridge: listGitHubRepositoriesPi invokes list_github_repositories with payload', async () => {
  let invokedCmd = '';
  let invokedArgs: Record<string, unknown> | undefined;

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    invokedCmd = cmd;
    invokedArgs = args;
    return {
      groups: [
        {
          owner: 'octocat',
          isCurrentUser: true,
          repositories: [
            {
              id: 1,
              name: 'hello-world',
              fullName: 'octocat/hello-world',
              owner: 'octocat',
              isPrivate: false,
              htmlUrl: 'https://github.com/octocat/hello-world',
              cloneUrl: 'https://github.com/octocat/hello-world.git',
              fork: false,
            },
          ],
        },
      ],
      total: 1,
      currentUser: 'octocat',
    } as T;
  };

  const res = await listGitHubRepositoriesPi({ token: 'ghp_test' }, mockInvoke);
  assert.strictEqual(invokedCmd, 'list_github_repositories');
  assert.deepStrictEqual(invokedArgs, { payload: { token: 'ghp_test' } });
  assert.strictEqual(res.total, 1);
  assert.strictEqual(res.groups[0].owner, 'octocat');
});

test('bridge: getGitHubAuthStatusPi returns uninstalled/unauthenticated fallback in browser preview with default invoke', async () => {
  const origWindow = (globalThis as any).window;
  const origIsTauri = (globalThis as any).isTauri;
  try {
    delete (globalThis as any).window;
    delete (globalThis as any).isTauri;
    const status = await getGitHubAuthStatusPi();
    assert.deepStrictEqual(status, { installed: false, authenticated: false });
  } finally {
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
    if (origIsTauri === undefined) {
      delete (globalThis as any).isTauri;
    } else {
      (globalThis as any).isTauri = origIsTauri;
    }
  }
});

test('bridge: cloneGitHubRepositoryPi throws browser preview error with default invoke', async () => {
  const origWindow = (globalThis as any).window;
  const origIsTauri = (globalThis as any).isTauri;
  try {
    delete (globalThis as any).window;
    delete (globalThis as any).isTauri;
    const payload: CloneGitHubRepositoryPayload = {
      repository: 'https://github.com/owner/repo',
      parentPath: '/dest/parent',
    };
    await assert.rejects(
      async () => cloneGitHubRepositoryPi(payload),
      /Desktop runtime unavailable: running in browser preview without Tauri bridge/
    );
  } finally {
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
    if (origIsTauri === undefined) {
      delete (globalThis as any).isTauri;
    } else {
      (globalThis as any).isTauri = origIsTauri;
    }
  }
});

test('bridge: getGitHubAuthStatusPi dispatches to default invoke in web shim when native isTauri is false', async () => {
  const origWindow = (globalThis as any).window;
  const origIsTauri = (globalThis as any).isTauri;
  let invokedCmd = '';
  let invokedArgs: Record<string, unknown> | undefined;

  try {
    delete (globalThis as any).isTauri;
    (globalThis as any).window = {
      __IS_WEB_IPC__: true,
      __TAURI_INTERNALS__: {
        isTauri: false, // proves __TAURI_INTERNALS__.isTauri false/absent does not prevent web shim invoke
        invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
          invokedCmd = cmd;
          invokedArgs = args;
          return { installed: true, authenticated: true } as T;
        },
      },
    };

    const status = await getGitHubAuthStatusPi();
    assert.strictEqual(invokedCmd, 'get_github_auth_status');
    assert.deepStrictEqual(invokedArgs, {}, 'Auth status probe must send no credentials or payload');
    assert.deepStrictEqual(status, { installed: true, authenticated: true });
  } finally {
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
    if (origIsTauri === undefined) {
      delete (globalThis as any).isTauri;
    } else {
      (globalThis as any).isTauri = origIsTauri;
    }
  }
});

test('bridge: cloneGitHubRepositoryPi dispatches to default invoke in web shim when native isTauri is false', async () => {
  const origWindow = (globalThis as any).window;
  const origIsTauri = (globalThis as any).isTauri;
  let invokedCmd = '';
  let invokedArgs: Record<string, unknown> | undefined;

  try {
    delete (globalThis as any).isTauri;
    (globalThis as any).window = {
      __IS_WEB_IPC__: true,
      __TAURI_INTERNALS__: {
        // isTauri absent
        invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
          invokedCmd = cmd;
          invokedArgs = args;
          return { path: '/shim/cloned/repo' } as T;
        },
      },
    };

    const payload: CloneGitHubRepositoryPayload = {
      repository: 'https://github.com/owner/web-shim-repo',
      parentPath: '/dest/web-shim',
      token: 'ghp_token_web_shim',
    };

    const res = await cloneGitHubRepositoryPi(payload);
    assert.strictEqual(invokedCmd, 'clone_github_repository');
    assert.deepStrictEqual(invokedArgs, { payload });
    assert.strictEqual(res.path, '/shim/cloned/repo');
  } finally {
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
    if (origIsTauri === undefined) {
      delete (globalThis as any).isTauri;
    } else {
      (globalThis as any).isTauri = origIsTauri;
    }
  }
});

// 2. Repository normalization and validation
test('github-clone: normalizeGitHubRepository accepts owner/repo and normalizes to HTTPS URL', () => {
  const result = normalizeGitHubRepository('facebook/react');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.normalized, 'https://github.com/facebook/react');
  assert.strictEqual(result.errorKey, undefined);
});

test('github-clone: normalizeGitHubRepository accepts HTTPS GitHub URLs with or without .git', () => {
  const withGit = normalizeGitHubRepository('https://github.com/facebook/react.git');
  assert.strictEqual(withGit.valid, true);
  assert.strictEqual(withGit.normalized, 'https://github.com/facebook/react');

  const withoutGit = normalizeGitHubRepository('https://github.com/facebook/react');
  assert.strictEqual(withoutGit.valid, true);
  assert.strictEqual(withoutGit.normalized, 'https://github.com/facebook/react');
});

test('github-clone: normalizeGitHubRepository rejects non-GitHub hosts, protocols, credentials, and flags', () => {
  // Empty
  assert.strictEqual(normalizeGitHubRepository('').valid, false);
  assert.strictEqual(normalizeGitHubRepository('   ').valid, false);

  // Non-GitHub host
  const gitlab = normalizeGitHubRepository('https://gitlab.com/owner/repo');
  assert.strictEqual(gitlab.valid, false);

  // Embedded credentials
  const withCreds = normalizeGitHubRepository('https://user:token@github.com/owner/repo');
  assert.strictEqual(withCreds.valid, false);

  // SSH protocol
  const ssh = normalizeGitHubRepository('git@github.com:owner/repo.git');
  assert.strictEqual(ssh.valid, false);

  // CLI option injection
  const flag = normalizeGitHubRepository('--upload-pack=evil');
  assert.strictEqual(flag.valid, false);

  // Path traversal
  const traversal = normalizeGitHubRepository('owner/../../etc/passwd');
  assert.strictEqual(traversal.valid, false);
});

test('github-clone: normalizeGitHubRepository strictly rejects www.github.com, query parameters, and hash fragments', () => {
  // Reject www.github.com (strict github.com only)
  assert.strictEqual(normalizeGitHubRepository('https://www.github.com/facebook/react').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://www.github.com/facebook/react.git').valid, false);

  // Reject query parameters (avoid silent normalization)
  assert.strictEqual(normalizeGitHubRepository('https://github.com/facebook/react?query=1').valid, false);
  assert.strictEqual(normalizeGitHubRepository('facebook/react?query=1').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com/facebook/react.git?tab=readme').valid, false);

  // Reject hash fragments (avoid silent normalization)
  assert.strictEqual(normalizeGitHubRepository('https://github.com/facebook/react#readme').valid, false);
  assert.strictEqual(normalizeGitHubRepository('facebook/react#readme').valid, false);

  // Reject custom port
  assert.strictEqual(normalizeGitHubRepository('https://github.com:443/facebook/react').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com:8443/facebook/react').valid, false);
});

test('github-clone: normalizeGitHubRepository rejects invalid owner formats and directory traversal', () => {
  // Owner cannot start or end with hyphen, have consecutive hyphens, or special characters
  assert.strictEqual(normalizeGitHubRepository('-owner/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('owner-/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('owner--name/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('owner.name/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('owner_name/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com/-owner/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com/owner-/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com/owner--name/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com/owner.name/repo').valid, false);
  assert.strictEqual(normalizeGitHubRepository('https://github.com/owner_name/repo').valid, false);

  // Owner cannot be .git or traversal
  assert.strictEqual(normalizeGitHubRepository('owner/.git').valid, false);
  assert.strictEqual(normalizeGitHubRepository('owner/..').valid, false);
  assert.strictEqual(normalizeGitHubRepository('../owner/repo').valid, false);

  // Owner maximum length is 39 characters
  assert.strictEqual(normalizeGitHubRepository(`${'a'.repeat(40)}/repo`).valid, false);
  assert.strictEqual(normalizeGitHubRepository(`${'a'.repeat(39)}/repo`).valid, true);
});

// 3. Controller behavior tests
test('github-clone controller: submission calls cloneRepository and registers project on success', async () => {
  let cloneCalledWith: CloneGitHubRepositoryPayload | null = null;
  let successPath: string | null = null;

  const controller = createGitHubCloneController({
    initialDestinationPath: '/home/user/workspace',
    cloneRepository: async (payload) => {
      cloneCalledWith = payload;
      return { path: '/home/user/workspace/react' };
    },
    onSuccess: (path) => {
      successPath = path;
    },
  });

  controller.setRepository('facebook/react');
  await controller.submit();

  assert.ok(cloneCalledWith !== null, 'cloneRepository should be called');
  assert.strictEqual((cloneCalledWith as any).repository, 'https://github.com/facebook/react');
  assert.strictEqual((cloneCalledWith as any).parentPath, '/home/user/workspace');
  assert.strictEqual((cloneCalledWith as any).token, undefined);
  assert.strictEqual(successPath, '/home/user/workspace/react');
  assert.strictEqual(controller.getState().error, null);
  assert.strictEqual(controller.getState().isSubmitting, false);
});

test('github-clone controller: submission failure does NOT register project and provides safe fixed error key', async () => {
  let successCalled = false;

  const controller = createGitHubCloneController({
    initialDestinationPath: '/home/user/workspace',
    cloneRepository: async () => {
      // Simulate backend error with secret or path exposure
      throw new Error('fatal: could not read Username for https://ghp_secret@github.com: terminal prompts disabled');
    },
    onSuccess: () => {
      successCalled = true;
    },
  });

  controller.setRepository('facebook/react');
  await controller.submit();

  assert.strictEqual(successCalled, false, 'onSuccess must NOT be called on failure');
  const errorKey = controller.getState().error;
  assert.ok(errorKey, 'Safe error key must be set');
  // Must NOT contain the raw secret or server error message
  assert.strictEqual(errorKey?.includes('ghp_secret'), false);
  assert.strictEqual(errorKey, 'projects.github_clone.error_failed');
  assert.strictEqual(controller.getState().isSubmitting, false);
});

test('github-clone controller: duplicate submissions while in-flight are blocked', async () => {
  let callCount = 0;
  let resolveClone: (val: { path: string }) => void;
  const clonePromise = new Promise<{ path: string }>((resolve) => {
    resolveClone = resolve;
  });

  const controller = createGitHubCloneController({
    initialDestinationPath: '/home/user/workspace',
    cloneRepository: async () => {
      callCount++;
      return clonePromise;
    },
  });

  controller.setRepository('facebook/react');
  const submit1 = controller.submit();
  const submit2 = controller.submit(); // Duplicate concurrent submit

  assert.strictEqual(callCount, 1, 'Only first submission must be dispatched');
  assert.strictEqual(controller.getState().isSubmitting, true);

  resolveClone!({ path: '/dest/react' });
  await Promise.all([submit1, submit2]);
  assert.strictEqual(callCount, 1);
  assert.strictEqual(controller.getState().isSubmitting, false);
});

test('github-clone controller: PAT is saved to storage on submit and reused for private repos when gh is not logged in', async () => {
  const storage = createMemoryStorage();
  let capturedToken: string | undefined;

  const controller = createGitHubCloneController({
    initialDestinationPath: '/home/user/workspace',
    storage,
    cloneRepository: async (payload) => {
      capturedToken = payload.token;
      return { path: '/dest/private-repo' };
    },
  });

  controller.setRepository('myorg/private-repo');
  controller.setToken('ghp_super_secret_pat_999');
  assert.strictEqual(controller.getState().token, 'ghp_super_secret_pat_999');

  await controller.submit();
  assert.strictEqual(capturedToken, 'ghp_super_secret_pat_999');
  // Token must be saved in persistent storage so it can be used for subsequent clones
  assert.strictEqual(storage.getItem(GITHUB_PAT_STORAGE_KEY), 'ghp_super_secret_pat_999');
  assert.strictEqual(controller.getState().hasSavedToken, true);

  // A new controller instance loads the saved PAT from storage automatically
  const controller2 = createGitHubCloneController({
    initialDestinationPath: '/home/user/workspace',
    storage,
    cloneRepository: async (payload) => {
      capturedToken = payload.token;
      return { path: '/dest/another-private-repo' };
    },
  });

  assert.strictEqual(controller2.getState().token, 'ghp_super_secret_pat_999');
  assert.strictEqual(controller2.getState().hasSavedToken, true);

  // Submitting without entering token again reuses the saved PAT
  controller2.setRepository('myorg/another-private-repo');
  await controller2.submit();
  assert.strictEqual(capturedToken, 'ghp_super_secret_pat_999');

  // Explicit clearToken removes token from storage and controller state
  controller2.clearToken();
  assert.strictEqual(controller2.getState().token, '');
  assert.strictEqual(controller2.getState().hasSavedToken, false);
  assert.strictEqual(storage.getItem(GITHUB_PAT_STORAGE_KEY), null);
});

test('github-clone controller: does not dispatch saved PAT when gh is authenticated', async () => {
  const storage = createMemoryStorage({ [GITHUB_PAT_STORAGE_KEY]: 'ghp_saved_pat_123' });
  let capturedToken: string | undefined = 'initial';

  const controller = createGitHubCloneController({
    initialDestinationPath: '/home/user/workspace',
    storage,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
    cloneRepository: async (payload) => {
      capturedToken = payload.token;
      return { path: '/dest/repo' };
    },
  });

  await controller.loadAuthStatus();
  controller.setRepository('myorg/repo');
  await controller.submit();

  // When gh is authenticated, token is omitted so gh repo clone is used
  assert.strictEqual(capturedToken, undefined);
  // Stored PAT remains untouched in storage
  assert.strictEqual(storage.getItem(GITHUB_PAT_STORAGE_KEY), 'ghp_saved_pat_123');
});

test('github-clone controller: dispose suppresses late async completion notifications and onSuccess', async () => {
  let resolveClone!: (val: { path: string }) => void;
  const clonePromise = new Promise<{ path: string }>((resolve) => {
    resolveClone = resolve;
  });
  let onSuccessCalled = false;
  const statesAfterDispose: any[] = [];

  const controller = createGitHubCloneController({
    initialDestinationPath: '/dest',
    cloneRepository: async () => clonePromise,
    onSuccess: () => {
      onSuccessCalled = true;
    },
    onStateChange: (s) => {
      statesAfterDispose.push(s);
    },
  });

  controller.setRepository('facebook/react');
  const submitPromise = controller.submit();
  assert.strictEqual(controller.getState().isSubmitting, true);

  // Dispose controller while submission is in-flight
  controller.dispose();
  statesAfterDispose.length = 0;

  // Resolve the underlying clone after disposal
  resolveClone({ path: '/dest/react' });
  await submitPromise;

  assert.strictEqual(onSuccessCalled, false, 'onSuccess must NOT be called after dispose');
  assert.strictEqual(statesAfterDispose.length, 0, 'onStateChange must NOT be notified after dispose');
});

test('github-clone controller: dispose suppresses late async failure notifications', async () => {
  let rejectClone!: (err: any) => void;
  const clonePromise = new Promise<{ path: string }>((_, reject) => {
    rejectClone = reject;
  });
  const statesAfterDispose: any[] = [];

  const controller = createGitHubCloneController({
    initialDestinationPath: '/dest',
    cloneRepository: async () => clonePromise,
    onStateChange: (s) => {
      statesAfterDispose.push(s);
    },
  });

  controller.setRepository('facebook/react');
  const submitPromise = controller.submit();
  assert.strictEqual(controller.getState().isSubmitting, true);

  // Dispose controller while submission is in-flight
  controller.dispose();
  statesAfterDispose.length = 0;

  rejectClone(new Error('fatal: clone failed'));
  await submitPromise;

  assert.strictEqual(statesAfterDispose.length, 0, 'onStateChange must NOT be notified of errors after dispose');
});

test('github-clone controller: dispose suppresses late async auth status updates', async () => {
  let resolveAuth!: (val: any) => void;
  const authPromise = new Promise<any>((resolve) => {
    resolveAuth = resolve;
  });
  const statesAfterDispose: any[] = [];

  const controller = createGitHubCloneController({
    getAuthStatus: async () => authPromise,
    onStateChange: (s) => {
      statesAfterDispose.push(s);
    },
  });

  const authTask = controller.loadAuthStatus();
  assert.strictEqual(controller.getState().authStatus.loading, true);

  // Dispose controller while auth probe is in-flight
  controller.dispose();
  statesAfterDispose.length = 0;

  resolveAuth({ installed: true, authenticated: true });
  await authTask;

  assert.strictEqual(statesAfterDispose.length, 0, 'onStateChange must NOT be notified of auth status after dispose');
});

test('github-clone controller: auth branching for gh authenticated vs unauthenticated', async () => {
  const controller = createGitHubCloneController({
    getAuthStatus: async () => ({ installed: true, authenticated: true, username: 'octocat' }),
  });

  await controller.loadAuthStatus();
  assert.deepStrictEqual(controller.getState().authStatus, {
    loading: false,
    installed: true,
    authenticated: true,
    username: 'octocat',
  });

  const unauthController = createGitHubCloneController({
    getAuthStatus: async () => ({ installed: false, authenticated: false }),
  });

  await unauthController.loadAuthStatus();
  assert.deepStrictEqual(unauthController.getState().authStatus, {
    loading: false,
    installed: false,
    authenticated: false,
    username: undefined,
  });
});

test('github-clone controller: fetches PAT user when token is provided', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url: any) => {
      assert.strictEqual(String(url), 'https://api.github.com/user');
      return {
        ok: true,
        json: async () => ({ login: 'mona-lisa' }),
      } as any;
    };

    const controller = createGitHubCloneController();
    const user = await controller.fetchPatUser('ghp_test_token');
    assert.strictEqual(user, 'mona-lisa');
    assert.strictEqual(controller.getState().patUser, 'mona-lisa');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// 4. Modal rendering tests
test('GitHubCloneModal: renders accessible dialog with role="dialog", aria-modal="true"', () => {
  const html = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );

  assert.ok(html.includes('role="dialog"'), 'Must have role="dialog"');
  assert.ok(html.includes('aria-modal="true"'), 'Must have aria-modal="true"');
  assert.ok(html.includes('Clone GitHub Repository'), 'Must have modal title');
  assert.ok(html.includes('type="password"'), 'Token input must be type="password"');
  assert.ok(html.includes('Saved locally'), 'Must display notice that PAT is saved locally');
});

test('GitHubCloneModal: PAT field is asked when gh is NOT authenticated, and hidden when gh IS authenticated', () => {
  // 1. Not authenticated (gh missing or not logged in): PAT field is asked
  const unauthHtml = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      initialAuthStatus: { loading: false, installed: false, authenticated: false },
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );
  assert.ok(unauthHtml.includes('github-clone-pat-input'), 'PAT input must be asked when gh is not logged in');

  // 2. Authenticated: PAT field is NOT asked
  const authHtml = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      initialAuthStatus: { loading: false, installed: true, authenticated: true },
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );
  assert.strictEqual(authHtml.includes('github-clone-pat-input'), false, 'PAT input must NOT be asked when gh is authenticated');
});

test('GitHubCloneModal: displays authenticated username for gh CLI and for saved PAT', () => {
  // 1. With gh CLI authenticated username
  const ghAuthHtml = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      initialAuthStatus: { loading: false, installed: true, authenticated: true, username: 'octocat' },
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );
  assert.ok(ghAuthHtml.includes('@octocat'), 'Must render @octocat in authenticated banner');

  // 2. Spanish localization with username
  const ghAuthEsHtml = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'es',
      initialAuthStatus: { loading: false, installed: true, authenticated: true, username: 'torvalds' },
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );
  assert.ok(ghAuthEsHtml.includes('@torvalds'), 'Must render @torvalds in Spanish authenticated banner');
});

test('GitHubCloneModal: closed state renders null', () => {
  const html = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: false,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );

  assert.strictEqual(html, '');
});

test('GitHubCloneModal: localized in Spanish', () => {
  const html = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'es',
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );

  assert.ok(html.includes('Clonar Repositorio de GitHub'), 'Spanish title must be rendered');
  assert.ok(html.includes('Guardado localmente'), 'Spanish PAT notice must be rendered');
});

test('GitHubCloneModal: renders Local Repo button with + icon when onOpenLocalFolder is provided', () => {
  const enHtml = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      onClose: () => {},
      onCloneSuccess: () => {},
      onOpenLocalFolder: () => {},
    })
  );

  assert.ok(enHtml.includes('github-clone-local-repo-btn'), 'Button must have github-clone-local-repo-btn class');
  assert.ok(enHtml.includes('Local Repo'), 'Button text in English must be Local Repo');
  assert.ok(enHtml.includes('<line x1="12" y1="5" x2="12" y2="19"'), 'Button must include + icon svg');

  const esHtml = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'es',
      onClose: () => {},
      onCloneSuccess: () => {},
      onOpenLocalFolder: () => {},
    })
  );
  assert.ok(esHtml.includes('Repo Local'), 'Button text in Spanish must be Repo Local');
});

function findElement(node: any, predicate: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = React.Children.toArray(node.props?.children);
  for (const child of children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

test('GitHubCloneModal: modal overlay ignores click during pending submission', () => {
  let closed = false;
  let capturedTree: any;

  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = GitHubCloneModal({
        isOpen: true,
        initialIsSubmitting: true,
        locale: 'en',
        onClose: () => {
          closed = true;
        },
        onCloneSuccess: () => {},
      });
      return capturedTree;
    })
  );

  const overlay = findElement(
    capturedTree,
    (el) =>
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('github-clone-overlay')
  );

  assert.ok(overlay, 'Overlay must exist');
  // Overlay must either not have an onClick or its onClick must not call onClose when isSubmitting is true
  if (typeof overlay.props.onClick === 'function') {
    overlay.props.onClick();
  }
  assert.strictEqual(closed, false, 'Clicking overlay during submission must not trigger onClose');
});

test('GitHubCloneModal: clicking modal overlay when idle does not trigger onClose', () => {
  let closed = false;
  let capturedTree: any;

  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = GitHubCloneModal({
        isOpen: true,
        initialIsSubmitting: false,
        locale: 'en',
        onClose: () => {
          closed = true;
        },
        onCloneSuccess: () => {},
      });
      return capturedTree;
    })
  );

  const overlay = findElement(
    capturedTree,
    (el) =>
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('github-clone-overlay')
  );

  assert.ok(overlay, 'Overlay must exist');
  assert.strictEqual(overlay.props.onClick, undefined, 'Overlay must not have onClick to avoid accidental dismissal');
  assert.strictEqual(closed, false, 'Modal must remain open when clicking outside/overlay');
});

test('sanitizeCloneErrorMessage: maps destination directory permission errors to localized destination permission key', () => {
  assert.strictEqual(
    sanitizeCloneErrorMessage(new Error('Permission denied on destination directory')),
    'projects.github_clone.error_destination_permission'
  );
  assert.strictEqual(
    sanitizeCloneErrorMessage('Permission denied: cannot create directory "/opt/repo"'),
    'projects.github_clone.error_destination_permission'
  );
  assert.strictEqual(
    sanitizeCloneErrorMessage('destination permission denied'),
    'projects.github_clone.error_destination_permission'
  );
});

// 5. Repository browsing and categorization controller tests
test('github-clone controller: loadRepositories fetches and groups repositories by owner', async () => {
  let listCalled = false;
  const mockGroups: any[] = [
    {
      owner: 'octocat',
      isCurrentUser: true,
      repositories: [
        {
          id: 1,
          name: 'octo-project',
          fullName: 'octocat/octo-project',
          owner: 'octocat',
          isPrivate: false,
        },
      ],
    },
    {
      owner: 'acme-corp',
      isCurrentUser: false,
      ownerType: 'Organization',
      repositories: [
        {
          id: 2,
          name: 'acme-sdk',
          fullName: 'acme-corp/acme-sdk',
          owner: 'acme-corp',
          isPrivate: true,
        },
      ],
    },
  ];

  const controller = createGitHubCloneController({
    getAuthStatus: async () => ({ installed: true, authenticated: true, username: 'octocat' }),
    listRepositories: async () => {
      listCalled = true;
      return {
        groups: mockGroups,
        total: 2,
        currentUser: 'octocat',
      };
    },
  });

  await controller.loadAuthStatus();
  await controller.loadRepositories();

  assert.strictEqual(listCalled, true, 'listRepositories must be called');
  const repoState = controller.getState().repositories;
  assert.strictEqual(repoState.loading, false);
  assert.strictEqual(repoState.total, 2);
  assert.strictEqual(repoState.groups.length, 2);
  assert.strictEqual(repoState.groups[0].owner, 'octocat');
  assert.strictEqual(repoState.groups[0].isCurrentUser, true);
  assert.strictEqual(repoState.groups[1].owner, 'acme-corp');
  assert.strictEqual(repoState.groups[1].isCurrentUser, false);

  // Test selecting a repository
  controller.selectRepository(mockGroups[1].repositories[0]);
  assert.strictEqual(controller.getState().repository, 'acme-corp/acme-sdk');
  assert.strictEqual(controller.getState().repositories.selectedRepo?.name, 'acme-sdk');
});

test('github-clone controller: loadRepositories sets error when user is unauthenticated', async () => {
  const controller = createGitHubCloneController({
    getAuthStatus: async () => ({ installed: false, authenticated: false }),
  });

  await controller.loadAuthStatus();
  await controller.loadRepositories();

  const repoState = controller.getState().repositories;
  assert.strictEqual(repoState.loading, false);
  assert.strictEqual(repoState.error, 'projects.github_clone.auth_required_browse');
  assert.strictEqual(repoState.groups.length, 0);
});

test('GitHubCloneModal: renders browse tabs and categorized repository groups', () => {
  const mockGroups: any[] = [
    {
      owner: 'testuser',
      isCurrentUser: true,
      repositories: [
        {
          id: 1,
          name: 'my-repo',
          fullName: 'testuser/my-repo',
          owner: 'testuser',
          isPrivate: false,
          description: 'My cool repository',
        },
      ],
    },
    {
      owner: 'external-org',
      isCurrentUser: false,
      ownerType: 'Organization',
      repositories: [
        {
          id: 2,
          name: 'org-tool',
          fullName: 'external-org/org-tool',
          owner: 'external-org',
          isPrivate: true,
          description: 'External team tool',
        },
      ],
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(GitHubCloneModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      initialAuthStatus: { loading: false, installed: true, authenticated: true, username: 'testuser' },
      listRepositories: async () => ({
        groups: mockGroups,
        total: 2,
        currentUser: 'testuser',
      }),
      onClose: () => {},
      onCloneSuccess: () => {},
    })
  );

  assert.ok(html.includes('Browse Repositories'), 'Must render Browse Repositories tab');
  assert.ok(html.includes('Manual URL'), 'Must render Manual URL tab');
  assert.ok(html.includes('github-clone-tabs'), 'Must render tabs bar');
});

