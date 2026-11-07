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

test('S9.1: repository palette is stable, normalized and distributes representative identities', async () => {
  const { getWorktreeRepositoryColor } = await import('@features/projects/worktree-colors');
  const color = getWorktreeRepositoryColor('C:\\Repo');
  assert.ok(color);
  assert.equal(getWorktreeRepositoryColor('c:/repo/'), color);
  assert.equal(getWorktreeRepositoryColor('C:\\Repo'), color);
  const colors = new Set(Array.from({ length: 40 }, (_, i) => getWorktreeRepositoryColor(`/workspace/repository-${i}`)));
  assert.ok(colors.size > 1 && colors.size <= 16);
});

test('S9.1-S9.2: dock and modal share decorative repository marks without changing existing indicators', async () => {
  const { getWorktreeRepositoryColor } = await import('@features/projects/worktree-colors');
  const { ProjectWorktrees } = await import('@features/projects/ProjectWorktrees');
  const primary = addProject({ projects: [], activeProjectId: null }, repository).project;
  const linked = addProject({ projects: [], activeProjectId: null }, entries[1].path).project;
  const unknown = addProject({ projects: [], activeProjectId: null }, '/workspace/unknown').project;
  const getPrimaryPath = (path: string) => path === repository || path === entries[1].path || path === entries[2].path ? repository : undefined;
  const dock = renderToStaticMarkup(React.createElement(ProjectDock, {
    projects: [primary, linked, unknown], activeProjectId: linked.id, connectionState: 'connected',
    agentActivity: 'busy', isBusy: true, locale: 'en', getPrimaryPath,
    isSecondaryWorktree: (path: string) => path === linked.path,
    onSelectProject: () => {}, onRenameProject: () => {}, onRemoveProject: () => {},
  } as any));
  const modal = renderToStaticMarkup(React.createElement(ProjectWorktrees, {
    projectPath: repository, locale: 'en', onOpen: () => {}, initialWorktrees: entries, getPrimaryPath,
  } as any));
  const token = getWorktreeRepositoryColor(repository);
  const dockTile = (name: string) => dock.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';
  const row = (branch: string) => modal.match(new RegExp(`<button[^>]*class="[^"]*project-worktree-row[^"]*"[^>]*><strong>${branch}</strong>[\\s\\S]*?</button>`))?.[0] ?? '';
  // A shared class/token or CSS custom property on each entry links the surfaces.
  for (const fragment of [dockTile('repo'), dockTile('feature one'), row('main'), row('feature/one')]) assert.ok(fragment.includes(token), fragment);
  assert.ok(!dockTile('unknown').includes(token));
  assert.match(dockTile('repo'), /project-monogram[^>]*>RE</);
  assert.match(dockTile('feature one'), /<svg\b[^>]*stroke="currentColor"/);
  assert.match(dockTile('feature one'), /aria-current="true"/);
  assert.match(dockTile('feature one'), /project-status-dot status-busy/);
  assert.match(row('main'), /aria-current="true"/);
});

// S10 exercises the production dock using the same confirmed-primary lookup supplied by App on web.
function s10Fixture() {
  const make = (name: string) => addProject({ projects: [], activeProjectId: null }, `/s10/${name}`).project;
  const [ordinary, child1, other, parent, child2, orphan, unknown] =
    ['ordinary', 'child1', 'other', 'parent', 'child2', 'orphan', 'unknown'].map(make);
  const projects = [ordinary, child1, other, parent, child2, orphan, unknown];
  const getPrimaryPath = (path: string) => path === parent.path || path === child1.path || path === child2.path
    ? parent.path : path === orphan.path ? '/s10/missing' : undefined;
  const render = (activeProjectId: string | null, desktop = false, projectStatusMap: Record<string, { connectionState: 'connected' | 'disconnected'; agentActivity: 'idle' | 'busy'; isBusy: boolean }> = {}, projectOrder: string[] = []) => {
    const previous = (globalThis as any).window;
    try {
      (globalThis as any).window = desktop ? { __TAURI_INTERNALS__: {} } : { __IS_WEB_IPC__: true };
      return renderToStaticMarkup(React.createElement(ProjectDock, {
        projects, activeProjectId, connectionState: 'connected', agentActivity: 'busy', isBusy: true, locale: 'en', projectStatusMap, projectOrder,
        ...(desktop ? {} : { getPrimaryPath, isSecondaryWorktree: (path: string) => [child1.path, child2.path, orphan.path].includes(path) }),
        onSelectProject: () => {}, onRenameProject: () => {}, onRemoveProject: () => {},
      }));
    } finally {
      if (previous === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previous;
    }
  };
  const rows = (html: string) => [...html.matchAll(/<div class="([^"]*project-row[^"]*)" role="listitem"><button[^>]*aria-label="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => ({ className: match[1], name: match[2], tile: match[0] }));
  return { projects, ordinary, child1, other, parent, child2, orphan, unknown, render, rows };
}

test('S10.1: web groups children after registered parent, retaining decoration and input', () => {
  const f = s10Fixture();
  const before = structuredClone(f.projects);
  const rows = f.rows(f.render(null));
  assert.deepEqual(rows.map(row => row.name), ['ordinary', 'other', 'parent', 'child1', 'child2', 'orphan', 'unknown']);
  assert.deepEqual(f.projects, before);
  for (const name of ['child1', 'child2']) {
    const row = rows.find(row => row.name === name)!;
    assert.match(row.className, /\bproject-dock-row--worktree\b/);
    assert.match(row.tile, /<svg\b[^>]*stroke="currentColor"/);
    assert.match(row.tile, /--repository-color:/);
  }
  for (const name of ['parent', 'orphan', 'unknown']) assert.doesNotMatch(rows.find(row => row.name === name)!.className, /\bproject-dock-row--worktree\b/);
  assert.match(rows.find(row => row.name === 'parent')!.tile, /project-monogram/);
  assert.match(rows.find(row => row.name === 'parent')!.tile, /--repository-color:/);
});

test('S11.2: selection alone never reorders idle groups, including parent and children', () => {
  const f = s10Fixture();
  const idle = Object.fromEntries(f.projects.map(project => [project.id, { connectionState: 'connected' as const, agentActivity: 'idle' as const, isBusy: false }]));
  const expected = ['ordinary', 'other', 'parent', 'child1', 'child2', 'orphan', 'unknown'];
  for (const selected of [f.other, f.parent, f.child1, f.child2]) {
    const rows = f.rows(f.render(selected.id, false, idle));
    assert.deepEqual(rows.map(row => row.name), expected);
    assert.match(rows.find(row => row.name === selected.path.split('/').pop())!.tile, /aria-current="true"/);
  }
});

test('S12.2: busy primary or child does not promote an unvisited group', () => {
  const f = s10Fixture();
  for (const busy of [f.parent, f.child2]) {
    const statuses = Object.fromEntries(f.projects.map(project => [project.id, { connectionState: 'connected' as const, agentActivity: 'idle' as const, isBusy: project.id === busy.id }]));
    for (const selected of [f.ordinary, f.parent, f.child1]) {
      const rows = f.rows(f.render(selected.id, false, statuses));
      assert.deepEqual(rows.map(row => row.name), ['ordinary', 'other', 'parent', 'child1', 'child2', 'orphan', 'unknown']);
      assert.match(rows.find(row => row.name === selected.path.split('/').pop())!.tile, /aria-current="true"/);
    }
  }
});

test('S12.2: activity changes cannot reorder persisted group ranks', () => {
  const f = s10Fixture();
  const statuses = Object.fromEntries(f.projects.map(project => [project.id, {
    connectionState: project.id === f.ordinary.id ? 'disconnected' as const : 'connected' as const,
    agentActivity: project.id === f.ordinary.id ? 'busy' as const : 'idle' as const,
    isBusy: [f.other.id, f.child1.id, f.unknown.id].includes(project.id),
  }]));
  const expected = ['unknown', 'parent', 'child1', 'child2', 'ordinary', 'other', 'orphan'];
  for (const selected of [f.ordinary, f.parent, f.child2, f.unknown]) {
    assert.deepEqual(f.rows(f.render(selected.id, false, statuses, [f.unknown.id, f.child1.id, f.ordinary.id])).map(row => row.name), expected);
  }
});

test('S10.2: absent selection and orphan remain accessible; desktop unchanged', () => {
  const f = s10Fixture();
  assert.deepEqual(f.rows(f.render('unknown-id')).map(row => row.name), ['ordinary', 'other', 'parent', 'child1', 'child2', 'orphan', 'unknown']);
  assert.deepEqual(f.rows(f.render(f.child2.id, true)).map(row => row.name), ['ordinary', 'child1', 'other', 'parent', 'child2', 'orphan', 'unknown']);
});

test('S12.1: persisted child rank orders the entire group even after registry sync, desktop unaffected', () => {
  const f = s10Fixture();
  const before = structuredClone(f.projects);
  const order = [f.child2.id, f.other.id];
  const expected = ['parent', 'child1', 'child2', 'other', 'ordinary', 'orphan', 'unknown'];
  assert.deepEqual(f.rows(f.render(f.ordinary.id, false, {}, order)).map(row => row.name), expected);
  f.projects.reverse();
  const synced = structuredClone(f.projects);
  assert.deepEqual(f.rows(f.render(f.ordinary.id, false, {}, order)).map(row => row.name), ['parent', 'child2', 'child1', 'other', 'unknown', 'orphan', 'ordinary']);
  assert.deepEqual(f.projects, synced);
  assert.deepEqual(f.rows(f.render(f.child2.id, true, {}, order)).map(row => row.name), f.projects.map(p => p.path.split('/').pop()));
  assert.deepEqual(before.map(p => p.id), synced.map(p => p.id).reverse());
});

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

test('S7.1: opened worktree retains its identity and appears as an accessible icon tile', async () => {
  const ctx = await setup();
  await ctx.controller.load();
  await ctx.controller.open(entries[1].path);
  const id = ctx.registry().activeProjectId;
  const chat = ctx.chats().projects[id!];
  await ctx.controller.open(entries[1].path);
  assert.equal(ctx.registry().activeProjectId, id);
  assert.equal(ctx.registry().projects.length, 1);
  assert.equal(ctx.chats().projects[id!], chat);
  const primary = addProject(ctx.registry(), repository).project;
  const html = renderToStaticMarkup(React.createElement(ProjectDock, {
    projects: [primary, ...ctx.registry().projects], activeProjectId: id,
    connectionState: 'disconnected', agentActivity: 'idle', isBusy: false, locale: 'en',
    isSecondaryWorktree: (path: string) => path === entries[1].path,
    onSelectProject: () => {}, onRenameProject: () => {}, onRemoveProject: () => {},
  } as any));
  const tile = (name: string) => html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';
  assert.match(tile('feature one'), /<svg\b[^>]*stroke="currentColor"/);
  assert.match(tile('feature one'), /<path d="M8 12h/);
  assert.match(tile('repo'), /class="project-monogram"[^>]*>RE</);
  assert.doesNotMatch(tile('repo'), /<svg/);
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
    assert.doesNotMatch(web, /project-worktrees-details|class="project-worktrees"/i);
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

test('S4.1: web dock renders projects without inline worktree panels', () => {
  const previous = (globalThis as any).window;
  const primary = addProject({ projects: [], activeProjectId: null }, repository).project;
  try {
    (globalThis as any).window = { __IS_WEB_IPC__: true };
    const html = renderToStaticMarkup(React.createElement(ProjectDock, {
      projects: [primary], activeProjectId: primary.id, connectionState: 'disconnected',
      agentActivity: 'idle', isBusy: false, locale: 'en', onSelectProject: () => {},
      onAddProject: () => {}, onRenameProject: () => {}, onRemoveProject: () => {},
    }));
    assert.match(html, /aria-label="repo"/);
    assert.doesNotMatch(html, /project-worktrees-details|class="project-worktrees"/);
  } finally {
    if (previous === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previous;
  }
});

test('S4.2: web sidebar exposes a labelled worktrees icon button', async () => {
  const { SessionSidebar } = await import('@features/sessions/SessionSidebar');
  const previous = (globalThis as any).window;
  try {
    (globalThis as any).window = { __IS_WEB_IPC__: true };
    const html = renderToStaticMarkup(React.createElement(SessionSidebar, {
      sessions: [], isLoading: false, isSwitching: false, error: null,
      activeSessionId: null, activeSessionFile: null, onSelectSession: () => {},
      onNewSession: () => {}, onDeleteSession: () => {}, onRenameSession: () => {},
      onClose: () => {}, locale: 'en', filesPanel: null,
    }));
    const button = html.match(/<button[^>]*class="[^"]*worktree-button[^"]*"[^>]*>[\s\S]*?<\/button>/i)?.[0];
    assert.ok(button);
    assert.match(button, /aria-label="[^"]*worktree[^"]*"/i);
    assert.doesNotMatch(button, /<img\b/i);
    assert.match(button, /<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">/);
    assert.match(button, /<path d="M8 12h\.5a3\.5 3\.5 0 013\.5 3\.5 3\.5 3\.5 0 003\.5 3\.5h\.5"><\/path>/);
    assert.match(button, /<path d="M8\.5 12A3\.5 3\.5 0 0012 8\.5 3\.5 3\.5 0 0115\.5 5h\.5"><\/path>/);
    for (const [x, y] of [[16, 16], [16, 2], [2, 9]]) {
      assert.ok(button.includes(`<rect x="${x}" y="${y}" width="6" height="6" rx="1"></rect>`));
    }
  } finally {
    if (previous === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previous;
  }
});

test('S8.3: sidebar trigger appears only in primary web views', async () => {
  const { SessionSidebar } = await import('@features/sessions/SessionSidebar');
  const previous = (globalThis as any).window;
  const props = {
    sessions: [], isLoading: false, isSwitching: false, error: null,
    activeSessionId: null, activeSessionFile: null, onSelectSession: () => {},
    onNewSession: () => {}, onDeleteSession: () => {}, onRenameSession: () => {},
    onClose: () => {}, locale: 'en' as const, filesPanel: null,
  };
  try {
    (globalThis as any).window = { __IS_WEB_IPC__: true };
    const secondary = renderToStaticMarkup(React.createElement(SessionSidebar, { ...props, isSecondaryWorktree: true } as any));
    const primary = renderToStaticMarkup(React.createElement(SessionSidebar, { ...props, isSecondaryWorktree: false } as any));
    assert.doesNotMatch(secondary, /worktree-button/);
    assert.match(primary, /worktree-button/);
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(SessionSidebar, { ...props, isSecondaryWorktree: true } as any)), /worktree-button/);
  } finally {
    if (previous === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previous;
  }
});

test('S4.3: classification uses first checkout and project path comparison', async () => {
  const { isSecondaryWorktree } = await import('@features/projects/hooks/useProjectWorktrees');
  const list = [[{ path: 'C:\\Repo', branch: 'not-main' }, { path: 'C:\\Feature', branch: 'main' }]];
  assert.equal(isSecondaryWorktree('c:/repo/', list), false);
  assert.equal(isSecondaryWorktree('c:/FEATURE/', list), true);
  assert.equal(isSecondaryWorktree('c:/unknown', list), false);
  assert.equal(isSecondaryWorktree('c:/FEATURE/', []), false);
});

test('S5.1 concurrent consumers and reopened controller reuse one repository listing', async () => {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  const root = '/s5-dedup/repo';
  const listEntries = [{ path: root, branch: 'main' }, { path: '/s5-dedup/link', branch: 'feature' }];
  let resolve!: (value: typeof listEntries) => void;
  let calls = 0;
  const listWorktrees = () => { calls++; return new Promise<typeof listEntries>(r => { resolve = r; }); };
  const make = (projectPath: string) => createProjectWorktreesController({ projectPath, listWorktrees, createWorktree: async () => listEntries[1], onOpen: () => {} });
  const a = make(root), b = make(root);
  const first = a.load(), second = b.load();
  assert.equal(calls, 1);
  resolve(listEntries);
  await Promise.all([first, second]);
  assert.deepEqual(a.getState().worktrees, listEntries);
  assert.deepEqual(b.getState().worktrees, listEntries);
  const reopened = make(listEntries[1].path);
  await reopened.load();
  assert.equal(calls, 1);
  assert.deepEqual(reopened.getState().worktrees, listEntries);
});

test('S5.2 creation notifies linked consumers and protects newer data from an older pending refresh', async () => {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  const root = '/s5-create/repo', linked = '/s5-create/link';
  const original = [{ path: root, branch: 'main' }, { path: linked, branch: 'linked' }];
  const added = { path: '/s5-create/new', branch: 'new' };
  let resolveOld!: (value: typeof original) => void;
  let pending = false, notifications = 0;
  const listWorktrees = async () => { if (!pending) return original; return new Promise<typeof original>(r => { resolveOld = r; }); }; 
  const make = (projectPath: string, onChange = () => {}) => createProjectWorktreesController({ projectPath, listWorktrees, createWorktree: async () => added, onOpen: () => {}, onChange });
  const creator = make(root), observer = make(linked, () => { notifications++; });
  await creator.load(); await observer.load();
  pending = true;
  const old = (observer as any).refresh();
  await creator.create('new', added.path);
  assert.deepEqual(creator.getState().worktrees, [...original, added]);
  assert.deepEqual(observer.getState().worktrees, [...original, added]);
  assert.ok(notifications > 0);
  resolveOld(original); await old;
  assert.deepEqual(observer.getState().worktrees, [...original, added]);
  const reopened = make(linked); await reopened.load();
  assert.deepEqual(reopened.getState().worktrees, [...original, added]);
});

test('S5.2 failed creation preserves cached listing for linked consumers', async () => {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  const root = '/s5-failure/repo', linked = '/s5-failure/link';
  const items = [{ path: root, branch: 'main' }, { path: linked, branch: 'feature' }];
  let calls = 0;
  const listWorktrees = async () => { calls++; return items; };
  const make = (projectPath: string) => createProjectWorktreesController({ projectPath, listWorktrees, createWorktree: async () => { throw new Error('creation failed'); }, onOpen: () => {} });
  const creator = make(root); await creator.load(); await creator.create('new', '');
  assert.match(String(creator.getState().error), /creation failed/);
  assert.deepEqual(creator.getState().worktrees, items);
  const reopened = make(linked); await reopened.load();
  assert.equal(calls, 1); assert.deepEqual(reopened.getState().worktrees, items);
});

test('S5.3 explicit refresh and open validate fresh data and never activate stale paths', async () => {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  const root = '/s5-refresh/repo', linked = '/s5-refresh/link';
  const initial = [{ path: root, branch: 'main' }, { path: linked, branch: 'feature' }];
  let calls = 0; const opened: string[] = [];
  const controller = createProjectWorktreesController({ projectPath: root, listWorktrees: async () => { calls++; if (calls === 1) return initial; if (calls === 2) return initial; throw new Error('repository unavailable'); }, createWorktree: async () => initial[1], onOpen: path => opened.push(path) });
  await controller.load();
  await (controller as any).refresh();
  assert.equal(calls, 2); assert.deepEqual(controller.getState().worktrees, initial);
  await controller.open(linked);
  assert.equal(calls, 3); assert.deepEqual(opened, []);
  assert.match(String(controller.getState().error), /repository unavailable/);
});

test('S8.1: cache-hit load emits no busy transition or redundant listing', async () => {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  const root = '/s8-cache/repo';
  const rows = [{ path: root, branch: 'main' }, { path: '/s8-cache/link', branch: 'feature' }];
  let calls = 0;
  const listWorktrees = async () => { calls++; return rows; };
  const options = { projectPath: root, listWorktrees, createWorktree: async () => rows[1], onOpen: () => {} };
  const first = createProjectWorktreesController(options);
  await first.load();
  const snapshots: Array<{ busy: boolean; loaded: boolean; worktrees: typeof rows }> = [];
  const reopened = createProjectWorktreesController({ ...options, onChange: () => snapshots.push(reopened.getState()) });
  assert.deepEqual(reopened.getState().worktrees, rows);
  await reopened.load();
  assert.equal(calls, 1);
  assert.ok(snapshots.every(state => !state.busy && state.loaded && state.worktrees.length === rows.length), JSON.stringify(snapshots));
  first.dispose(); reopened.dispose();
});

test('S8.2: cached rows remain visible during failed refresh and stale-open refusal', async () => {
  const { createProjectWorktreesController } = await import('@features/projects/worktrees');
  const root = '/s8-refresh/repo';
  const rows = [{ path: root, branch: 'main' }, { path: '/s8-refresh/link', branch: 'feature' }];
  let calls = 0;
  let rejectRefresh!: (error: Error) => void;
  const opened: string[] = [];
  const controller = createProjectWorktreesController({
    projectPath: root,
    listWorktrees: () => {
      calls++;
      if (calls === 1) return Promise.resolve(rows);
      if (calls === 2) return new Promise((_, reject) => { rejectRefresh = reject; });
      return Promise.reject(new Error('open validation failed'));
    },
    createWorktree: async () => rows[1], onOpen: path => opened.push(path),
  });
  await controller.load();
  const refresh = controller.refresh();
  assert.equal(controller.getState().loaded, true);
  assert.deepEqual(controller.getState().worktrees, rows);
  rejectRefresh(new Error('refresh failed'));
  await refresh;
  assert.equal(controller.getState().loaded, true);
  assert.deepEqual(controller.getState().worktrees, rows);
  assert.equal(controller.getState().error, 'refresh failed');
  await controller.open(rows[1].path);
  assert.deepEqual(opened, []);
  assert.equal(controller.getState().error, 'open validation failed');
  assert.equal(controller.getState().loaded, true);
  assert.deepEqual(controller.getState().worktrees, rows);
  controller.dispose();
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
