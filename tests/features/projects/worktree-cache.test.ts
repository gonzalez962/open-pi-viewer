import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorktreeCache } from '@features/projects/worktree-cache';

const primary = '/alias/repo';
const linked = '/alias/linked';
const initial = [{ path: primary, branch: 'main' }, { path: linked, branch: 'feature' }];

test('S9.1: primary lookup uses accepted full lists without fetching or inferring add-only identity', async () => {
  let calls = 0;
  const root = 'C:\\Repo';
  const child = 'C:\\Feature';
  const cache = createWorktreeCache(async () => { calls++; return [{ path: root, branch: 'main' }, { path: child, branch: 'feature' }]; });
  const lookup = (path: string) => (cache as any).getPrimaryPath(path);
  assert.equal(lookup(root), undefined);
  cache.add(root, { path: child, branch: 'feature' });
  assert.equal(lookup(root), undefined);
  assert.equal(lookup(child), undefined);
  assert.equal(calls, 0);
  await cache.read(root, true);
  assert.equal(lookup('c:/repo/'), root);
  assert.equal(lookup('c:/FEATURE/'), root);
  assert.equal(lookup('c:/unknown'), undefined);
  assert.equal(calls, 1);
  assert.deepEqual(cache.classify(root), { kind: 'unknown' });
  assert.deepEqual(cache.classify(child), { kind: 'linked', primaryPath: root });
});

for (const creator of [primary, linked]) {
  test(`S5.1-S5.2: concurrent aliases converge and creation via ${creator} survives a stale response`, async () => {
    const requests: Array<(value: typeof initial) => void> = [];
    const cache = createWorktreeCache(() => new Promise(resolve => requests.push(resolve)));
    let notifications = 0;
    cache.subscribe(() => { notifications++; });
    const first = cache.read(primary);
    const second = cache.read(linked);
    assert.equal(requests.length, 2);
    requests[0](initial);
    await first;
    requests[1](initial);
    await second;
    const stale = cache.read(linked, true);
    assert.equal(requests.length, 3);
    const added = { path: '/alias/new', branch: 'new' };
    cache.add(creator, added);
    const expected = [...initial, added];
    assert.deepEqual(cache.get(primary), expected);
    assert.deepEqual(cache.get(linked), expected);
    assert.deepEqual(cache.get(added.path), expected);
    requests[2](initial);
    assert.deepEqual(await stale, expected);
    assert.deepEqual(await cache.read(primary), expected);
    assert.deepEqual(await cache.read(linked), expected);
    assert.deepEqual(await cache.read(added.path), expected);
    assert.equal(requests.length, 3);
    assert.ok(notifications > 0);
  });
}

test('S7.2: fresh primary absence hides known linked entry without changing identity or history', async () => {
  const { classifyProjectWorktree } = await import('@features/projects/hooks/useProjectWorktrees');
  const { addProject } = await import('@features/projects/projects');
  const { createInitialMultiProjectState, multiProjectChatReducer } = await import('@core/reducer/multi-project');
  let listing = initial;
  const calls: string[] = [];
  const cache = createWorktreeCache(async ({ projectPath }) => { calls.push(projectPath); return listing; });
  const registry = addProject({ projects: [], activeProjectId: null }, linked).registry;
  const id = registry.activeProjectId!;
  const chats = multiProjectChatReducer(createInitialMultiProjectState(), { type: 'SET_ACTIVE_PROJECT', payload: { projectId: id } });
  await cache.read(primary);
  assert.deepEqual(classifyProjectWorktree(linked, cache), { kind: 'linked', primaryPath: primary });
  listing = [initial[0]];
  await cache.read(linked, true);
  assert.deepEqual(calls, [primary, primary]);
  assert.deepEqual(classifyProjectWorktree(linked, cache), { kind: 'missing', primaryPath: primary });
  assert.equal(registry.projects[0].id, id);
  assert.equal(registry.activeProjectId, id);
  assert.ok(chats.projects[id]);
});

test('S7.2: errors and add-only cached data do not hide known or unknown projects', async () => {
  const { classifyProjectWorktree } = await import('@features/projects/hooks/useProjectWorktrees');
  let fail = false;
  const cache = createWorktreeCache(async () => { if (fail) throw new Error('unavailable'); return initial; });
  await cache.read(primary);
  fail = true;
  await assert.rejects(cache.read(linked, true), /unavailable/);
  assert.deepEqual(classifyProjectWorktree(linked, cache), { kind: 'linked', primaryPath: primary });
  const added = { path: '/alias/added', branch: 'added' };
  cache.add(primary, added);
  assert.deepEqual(classifyProjectWorktree(linked, cache), { kind: 'linked', primaryPath: primary });
  const addOnly = createWorktreeCache(async () => initial);
  addOnly.add(primary, added);
  assert.deepEqual(classifyProjectWorktree(linked, addOnly), { kind: 'unknown' });
});

test('S5.2: creation during an undiscovered alias read survives its late response', async () => {
  const requests: Array<(value: typeof initial) => void> = [];
  const cache = createWorktreeCache(() => new Promise(resolve => requests.push(resolve)));
  const first = cache.read(primary);
  const stale = cache.read(linked);
  requests[0](initial);
  await first;
  const added = { path: '/alias/new', branch: 'new' };
  cache.add(primary, added);
  requests[1](initial);
  assert.deepEqual(await stale, [...initial, added]);
  assert.deepEqual(cache.get(linked), [...initial, added]);
});
