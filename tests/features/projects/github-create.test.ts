import assert from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createGitHubRepositoryPi,
  type CreateGitHubRepositoryPayload,
  type CreateGitHubRepositoryResult,
} from '@infra/bridge';
import {
  validateGitHubRepoName,
  sanitizeCreateErrorMessage,
  createGitHubCreateController,
} from '@features/projects/github-create';
import { GitHubCreateModal } from '@features/projects/components/GitHubCreateModal';

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

test('validation: validateGitHubRepoName rejects empty names, flags, and special characters', () => {
  assert.strictEqual(validateGitHubRepoName('').valid, false);
  assert.strictEqual(validateGitHubRepoName('   ').valid, false);
  assert.strictEqual(validateGitHubRepoName('-flag').valid, false);
  assert.strictEqual(validateGitHubRepoName('.').valid, false);
  assert.strictEqual(validateGitHubRepoName('..').valid, false);
  assert.strictEqual(validateGitHubRepoName('repo with spaces').valid, false);
  assert.strictEqual(validateGitHubRepoName('owner/repo').valid, false);
  assert.strictEqual(validateGitHubRepoName('invalid@repo').valid, false);

  const validRes = validateGitHubRepoName('my-cool_repo.js');
  assert.strictEqual(validRes.valid, true);
  assert.strictEqual(validRes.normalized, 'my-cool_repo.js');
});

test('sanitization: sanitizeCreateErrorMessage maps raw errors to safe translation keys', () => {
  assert.strictEqual(
    sanitizeCreateErrorMessage({ message: 'Repository already exists on this account' }),
    'projects.github_create.error_already_exists'
  );
  assert.strictEqual(
    sanitizeCreateErrorMessage({ message: 'operation timed out after 120s' }),
    'projects.github_create.error_timeout'
  );
  assert.strictEqual(
    sanitizeCreateErrorMessage({ message: 'destination permission denied' }),
    'projects.github_create.error_destination_permission'
  );
  assert.strictEqual(
    sanitizeCreateErrorMessage({ message: 'authentication required or bad token' }),
    'projects.github_create.error_auth'
  );
  assert.strictEqual(
    sanitizeCreateErrorMessage('something random'),
    'projects.github_create.error_failed'
  );
});

test('bridge: createGitHubRepositoryPi invokes create_github_repository with payload', async () => {
  let invokedCmd = '';
  let passedPayload: any = null;

  const mockInvoke = async <T>(cmd: string, args?: any): Promise<T> => {
    invokedCmd = cmd;
    passedPayload = args?.payload;
    return {
      repository: {
        id: 777,
        name: 'test-repo',
        fullName: 'user/test-repo',
        owner: 'user',
        isPrivate: true,
        htmlUrl: 'https://github.com/user/test-repo',
        cloneUrl: 'https://github.com/user/test-repo.git',
        fork: false,
      },
      path: '/mock/path/test-repo',
    } as T;
  };

  const payload: CreateGitHubRepositoryPayload = {
    name: 'test-repo',
    isPrivate: true,
    parentPath: '/mock/path',
  };

  const result = await createGitHubRepositoryPi(payload, mockInvoke);
  assert.strictEqual(invokedCmd, 'create_github_repository');
  assert.strictEqual(passedPayload.name, 'test-repo');
  assert.strictEqual(result.repository.name, 'test-repo');
  assert.strictEqual(result.path, '/mock/path/test-repo');
});

test('controller: handles submit lifecycle and validation', async () => {
  const storage = createMemoryStorage();
  let createdPayload: any = null;
  let successResult: any = null;

  const mockCreate = async (payload: CreateGitHubRepositoryPayload): Promise<CreateGitHubRepositoryResult> => {
    createdPayload = payload;
    return {
      repository: {
        id: 123,
        name: payload.name,
        fullName: `user/${payload.name}`,
        owner: 'user',
        isPrivate: Boolean(payload.isPrivate),
        htmlUrl: `https://github.com/user/${payload.name}`,
        cloneUrl: `https://github.com/user/${payload.name}.git`,
        fork: false,
      },
      path: payload.parentPath ? `${payload.parentPath}/${payload.name}` : undefined,
    };
  };

  const controller = createGitHubCreateController({
    initialDestinationPath: '/home/user/projects',
    storage,
    createRepository: mockCreate,
    onSuccess: (res) => {
      successResult = res;
    },
  });

  // 1. Submit without name fails
  await controller.submit();
  assert.strictEqual(controller.getState().error, 'projects.github_create.error_name_required');

  // 2. Set valid name and submit with cloneLocally: true
  controller.setName('awesome-project');
  controller.setDescription('Awesome description');
  controller.setIsPrivate(true);
  controller.setAutoInit(true);

  await controller.submit();
  assert.strictEqual(controller.getState().error, null);
  assert.ok(createdPayload);
  assert.ok(successResult);
  assert.strictEqual(createdPayload.name, 'awesome-project');
  assert.strictEqual(createdPayload.description, 'Awesome description');
  assert.strictEqual(createdPayload.isPrivate, true);
  assert.strictEqual(createdPayload.parentPath, '/home/user/projects');
  assert.strictEqual(successResult.repository.name, 'awesome-project');
  assert.strictEqual(successResult.path, '/home/user/projects/awesome-project');
});

test('GitHubCreateModal: renders accessible dialog in English and Spanish', () => {
  // English render
  const enHtml = renderToStaticMarkup(
    React.createElement(GitHubCreateModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      initialAuthStatus: { loading: false, installed: true, authenticated: true, username: 'octocat' },
      onClose: () => {},
      onCreateSuccess: () => {},
    })
  );

  assert.ok(enHtml.includes('role="dialog"'), 'Must have role="dialog"');
  assert.ok(enHtml.includes('aria-modal="true"'), 'Must have aria-modal="true"');
  assert.ok(enHtml.includes('Create GitHub Repository'), 'Must have English title');
  assert.ok(enHtml.includes('@octocat'), 'Must display authenticated user in banner');
  assert.ok(enHtml.includes('id="github-create-name-input"'), 'Must have name input');
  assert.ok(enHtml.includes('id="github-create-desc-input"'), 'Must have desc input');

  // Spanish render
  const esHtml = renderToStaticMarkup(
    React.createElement(GitHubCreateModal, {
      isOpen: true,
      initialDestinationPath: '/home/user/projects',
      locale: 'es',
      initialAuthStatus: { loading: false, installed: true, authenticated: true, username: 'octocat' },
      onClose: () => {},
      onCreateSuccess: () => {},
    })
  );

  assert.ok(esHtml.includes('Crear Repositorio en GitHub'), 'Must have Spanish title');
  assert.ok(esHtml.includes('Nombre del repositorio'), 'Must have Spanish name label');

  // Closed modal
  const closedHtml = renderToStaticMarkup(
    React.createElement(GitHubCreateModal, {
      isOpen: false,
      initialDestinationPath: '/home/user/projects',
      locale: 'en',
      onClose: () => {},
      onCreateSuccess: () => {},
    })
  );

  assert.strictEqual(closedHtml, '');
});
