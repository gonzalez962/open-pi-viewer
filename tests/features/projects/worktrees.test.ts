import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectDock } from '@features/projects/ProjectDock';
import { addProject, decideSelectProject, type ProjectsRegistry } from '@features/projects/projects';
import { createInitialMultiProjectState, multiProjectChatReducer } from '@core/reducer/multi-project';

const repository = '/workspace/repo';
const entries = [
  { path: repository, branch: 'main' },
  { path: '/workspace/feature one', branch: 'feature/one' },
  { path: '/workspace/feature-two', branch: 'feature/two' },
];

// The controller is the public interaction seam used by ProjectWorktrees; its
// onOpen callback is the dock's existing onAddProject path-based flow.
async function setup(list: () => Promise<typeof entries> = async () => entries, create = async () => entries[1]) {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  let registry: ProjectsRegistry = { projects: [], activeProjectId: null };
  let chats = createInitialMultiProjectState();
  const opened: string[] = [];
  const controller = createProjectWorktreesController({
    projectPath: repository,
    listWorktrees: list,
    createWorktree: create,
    onOpen: (path: string) => {
      opened.push(path);
      const result = addProject(registry, path);
      registry = result.registry;
      chats = multiProjectChatReducer(chats, { type: 'SET_ACTIVE_PROJECT', payload: { projectId: result.project.id } });
    },
  });
  return { controller, opened, registry: () => registry, chats: () => chats };
}

test('S3.1: opening and reopening listed paths activates independent existing project identities', async () => {
  const ctx = await setup();
  await ctx.controller.load();
  await ctx.controller.open(entries[1].path);
  const first = ctx.registry().activeProjectId!;
  const firstChat = ctx.chats().projects[first];
  await ctx.controller.open(entries[2].path);
  const second = ctx.registry().activeProjectId!;
  assert.notEqual(first, second);
  assert.equal(ctx.registry().projects.length, 2);
  assert.notEqual(ctx.chats().projects[first], ctx.chats().projects[second]);
  await ctx.controller.open(entries[1].path);
  assert.equal(ctx.registry().activeProjectId, first);
  assert.equal(ctx.registry().projects.length, 2);
  assert.equal(ctx.chats().projects[first], firstChat);
  assert.deepEqual(ctx.opened, [entries[1].path, entries[2].path, entries[1].path]);
});

test('S3.1: repository panel displays listed branches and paths together', async () => {
  const { ProjectWorktrees } = await import('@features/projects/ProjectWorktrees');
  const html = renderToStaticMarkup(React.createElement(ProjectWorktrees, {
    projectPath: repository, locale: 'en', onOpen: () => {}, initialWorktrees: entries,
  }));
  assert.ok(html.includes(repository));
  for (const entry of entries) {
    assert.ok(html.includes(entry.path));
    assert.ok(html.includes(entry.branch));
  }
  assert.match(html, /worktree/i);
});

test('S3.2: create failure exposes error and never activates a project', async () => {
  const ctx = await setup(undefined, async () => { throw new Error('destination already exists'); });
  await ctx.controller.create('feature/new', '/workspace/occupied');
  assert.match(String(ctx.controller.getState().error), /destination already exists/i);
  assert.deepEqual(ctx.opened, []);
  assert.deepEqual(ctx.registry(), { projects: [], activeProjectId: null });
  const { ProjectWorktrees } = await import('@features/projects/ProjectWorktrees');
  const html = renderToStaticMarkup(React.createElement(ProjectWorktrees, {
    projectPath: repository, locale: 'en', onOpen: () => {}, initialError: ctx.controller.getState().error,
  }));
  assert.match(html, /destination already exists/i);
});

test('S3.2: stale listing refuses open, displays error and leaves project selection usable', async () => {
  let calls = 0;
  const ctx = await setup(async () => { if (calls++ < 2) return entries; throw new Error('repository unavailable'); });
  await ctx.controller.load();
  await ctx.controller.open(entries[1].path);
  const before = ctx.registry();
  await ctx.controller.load();
  await ctx.controller.open(entries[2].path);
  assert.match(String(ctx.controller.getState().error), /repository unavailable/i);
  const { ProjectWorktrees } = await import('@features/projects/ProjectWorktrees');
  const html = renderToStaticMarkup(React.createElement(ProjectWorktrees, {
    projectPath: repository, locale: 'en', onOpen: () => {}, initialError: ctx.controller.getState().error,
  }));
  assert.match(html, /repository unavailable/i);
  assert.deepEqual(ctx.registry(), before);
  assert.deepEqual(ctx.opened, [entries[1].path]);
  const other = addProject(before, '/workspace/other');
  const decision = decideSelectProject(other.registry, before.projects[0]);
  assert.equal(decision.action, 'apply');
  assert.equal(decision.path, entries[1].path);
});

test('S3: worktree controls appear on web only and desktop project selection is preserved', () => {
  const previous = (globalThis as any).window;
  const project = addProject({ projects: [], activeProjectId: null }, repository).project;
  let selected = '';
  const props = {
    projects: [project], activeProjectId: project.id, connectionState: 'disconnected' as const,
    agentActivity: 'idle' as const, isBusy: false, locale: 'en' as const,
    onSelectProject: (p: typeof project) => { selected = p.id; }, onAddProject: () => {},
    onRenameProject: () => {}, onRemoveProject: () => {},
  };
  try {
    (globalThis as any).window = { __IS_WEB_IPC__: true };
    const web = renderToStaticMarkup(React.createElement(ProjectDock, props));
    assert.match(web, /worktree/i);
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    let tree: any;
    const desktop = renderToStaticMarkup(React.createElement(() => { tree = ProjectDock(props); return tree; }));
    assert.doesNotMatch(desktop, /worktree/i);
    assert.ok(desktop.includes('aria-label="repo"'));
    function find(node: any): any {
      if (!node || typeof node !== 'object') return null;
      if (node.props?.['aria-label'] === 'repo' && node.type === 'button') return node;
      for (const child of React.Children.toArray(node.props?.children)) { const found = find(child); if (found) return found; }
      return null;
    }
    const button = find(tree);
    assert.ok(button);
    button.props.onClick({ stopPropagation() {} });
    assert.equal(selected, project.id);
  } finally {
    if (previous === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previous;
  }
});

test('S3: bridge sends exact list and create payloads', async () => {
  const bridge = await import('@infra/bridge');
  const calls: unknown[] = [];
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return (command === 'list_project_worktrees' ? entries : entries[1]) as T;
  };
  assert.deepEqual(await bridge.listProjectWorktreesPi({ projectPath: repository }, invoke), entries);
  const payload = { projectPath: repository, branch: 'feature/one', destinationPath: entries[1].path };
  assert.deepEqual(await bridge.createProjectWorktreePi(payload, invoke), entries[1]);
  assert.deepEqual(calls, [
    { command: 'list_project_worktrees', args: { payload: { projectPath: repository } } },
    { command: 'create_project_worktree', args: { payload } },
  ]);
});
