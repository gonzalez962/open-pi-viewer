import assert from 'node:assert/strict';
import test from 'node:test';
import { type ProjectItem } from '@features/projects/projects';
import { appendProjectOrder, mergeVisibleProjectOrder } from '@features/projects/project-order';
import { getProjectDockGroups, moveProjectDockGroup } from '@features/projects/project-dock-reorder';

const projects: ProjectItem[] = ['alpha', 'child', 'beta', 'orphan', 'sibling'].map(id => ({
  id, path: `/${id}`, createdAt: '', lastOpenedAt: '',
}));
const primaryPath = (path: string) => ({ '/child': '/alpha', '/sibling': '/alpha', '/orphan': '/missing' })[path];
const ids = (groups: ProjectItem[][]) => groups.map(group => group.map(project => project.id));

test('web groups use the earliest saved member rank; unregistered parents and native order are unchanged', () => {
  assert.deepEqual(ids(getProjectDockGroups(projects, ['child', 'orphan'])), [['alpha'], ['child'], ['beta'], ['orphan'], ['sibling']]);
  assert.deepEqual(ids(getProjectDockGroups(projects, ['child', 'orphan'], primaryPath)), [['alpha', 'child', 'sibling'], ['orphan'], ['beta']]);
});

test('manual movement persists every visible member and retains hidden ranks; newly opened groups append', () => {
  const previous = ['stale', 'child', 'beta', 'hidden'];
  const groups = getProjectDockGroups(projects, previous, primaryPath);
  const moved = moveProjectDockGroup(groups, 'alpha', 2);
  assert.deepEqual(moved, ['beta', 'orphan', 'alpha', 'child', 'sibling']);
  const order = mergeVisibleProjectOrder(previous, moved!);
  assert.deepEqual(order, ['stale', 'beta', 'orphan', 'hidden', 'alpha', 'child', 'sibling']);
  assert.deepEqual(previous, ['stale', 'child', 'beta', 'hidden']);
  assert.strictEqual(appendProjectOrder(order, 'orphan'), order);
  const next = { id: 'next', path: '/next', createdAt: '', lastOpenedAt: '' };
  assert.deepEqual(ids(getProjectDockGroups([next, ...projects], appendProjectOrder(order, next.id), primaryPath)), [
    ['beta'], ['orphan'], ['alpha', 'child', 'sibling'], ['next'],
  ]);
});

test('same position, nonexistent groups and invalid drop destinations yield no order to save', () => {
  const previous = ['alpha', 'beta', 'orphan'];
  const groups = getProjectDockGroups(projects, previous, primaryPath);
  for (const [source, index] of [['beta', 1], ['missing', 1], ['child', 1], ['alpha', -1], ['alpha', 3]] as const) {
    assert.equal(moveProjectDockGroup(groups, source, index), null);
  }
  assert.strictEqual(mergeVisibleProjectOrder(previous, previous), previous);
  assert.deepEqual(ids(groups), [['alpha', 'child', 'sibling'], ['beta'], ['orphan']]);
});
