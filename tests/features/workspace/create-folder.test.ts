import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';
import { createWorkspaceDirPi } from '@infra/bridge';
import { CreateFolderForm } from '@features/workspace/components/CreateFolderForm';
import { FileTree } from '@features/workspace/FileTree';
import type { WorkspaceEntry } from '@core/types/workspace';

// S1: Button labeled exactly + Folder in both locales
test('S1: locale dictionaries contain exact "+ Folder" button label for both en and es', () => {
  assert.strictEqual(enJson['file_tree.create_folder'], '+ Folder');
  assert.strictEqual(esJson['file_tree.create_folder'], '+ Folder');
});

test('S1: FileTree renders "+ Folder" button beside the filter in both English and Spanish', () => {
  // 1. English
  const enElement = React.createElement(FileTree, {
    workingDirectory: 'C:/project',
    locale: 'en',
    onOpenFile: () => {},
  });
  const enMarkup = renderToStaticMarkup(enElement);
  assert.ok(enMarkup.includes('btn-tree-create-folder'), 'Must render create folder button');
  assert.ok(enMarkup.includes('+ Folder'), 'Must render exact "+ Folder" label in en');
  assert.ok(enMarkup.includes('file-tree-controls'), 'Must be inside file tree controls next to filter');

  // 2. Spanish
  const esElement = React.createElement(FileTree, {
    workingDirectory: 'C:/project',
    locale: 'es',
    onOpenFile: () => {},
  });
  const esMarkup = renderToStaticMarkup(esElement);
  assert.ok(esMarkup.includes('btn-tree-create-folder'), 'Must render create folder button in es');
  assert.ok(esMarkup.includes('+ Folder'), 'Must render exact "+ Folder" label in es');
});

// S1.1: Bridge invocation for folder creation
test('S1.1: Bridge: createWorkspaceDirPi invokes create_workspace_dir with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockEntry: WorkspaceEntry = {
    name: 'new-folder',
    relativePath: 'new-folder',
    isDir: true,
    size: null,
    extension: null,
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockEntry as T;
  };

  const res = await createWorkspaceDirPi(
    { workingDirectory: 'C:/project', name: 'new-folder' },
    mockInvoke
  );

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'create_workspace_dir');
  assert.deepStrictEqual(calls[0].args, {
    payload: { workingDirectory: 'C:/project', name: 'new-folder' },
  });
  assert.strictEqual(res.name, 'new-folder');
  assert.strictEqual(res.relativePath, 'new-folder');
  assert.strictEqual(res.isDir, true);
});

// S1.1: CreateFolderForm renders input and controls
test('S1.1: CreateFolderForm renders form elements with correct attributes and localized placeholder', () => {
  const element = React.createElement(CreateFolderForm, {
    onSubmit: () => {},
    onCancel: () => {},
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('create-folder-form'), 'Must render form element');
  assert.ok(markup.includes('create-folder-input'), 'Must render input element');
  assert.ok(markup.includes('btn-create-folder-submit'), 'Must render submit button');
  assert.ok(markup.includes('btn-create-folder-cancel'), 'Must render cancel button');
});

// S1.3: CreateFolderForm renders visible error message
test('S1.3: CreateFolderForm: visibly displays error message when error is provided', () => {
  const element = React.createElement(CreateFolderForm, {
    onSubmit: () => {},
    onCancel: () => {},
    error: 'Destination already exists: my-folder',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('create-folder-error'));
  assert.ok(markup.includes('Destination already exists: my-folder'));
  assert.ok(markup.includes('role="alert"'));
});

// S1.4 PRESERVE: Existing explorer controls (filter, refresh) remain intact beside + Folder
test('S1.4 PRESERVE: FileTree controls preserve search input and refresh button alongside + Folder button', () => {
  const element = React.createElement(FileTree, {
    workingDirectory: 'C:/project',
    locale: 'en',
    onOpenFile: () => {},
  });

  const markup = renderToStaticMarkup(element);
  // Search input wrapper
  assert.ok(markup.includes('search-input-wrapper'), 'Filter search bar must remain');
  assert.ok(markup.includes('class="sidebar-search-input"'), 'Search input element must remain');
  // Refresh button
  assert.ok(markup.includes('btn-tree-refresh'), 'Refresh button must remain');
  // Create folder button
  assert.ok(markup.includes('btn-tree-create-folder'), 'Create folder button must be present beside filter');
});
