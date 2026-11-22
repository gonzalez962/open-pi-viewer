import assert from 'node:assert/strict';
import test from 'node:test';
import { getProjectDockSwipe, isProjectDockSwipeClick } from '@features/projects/project-dock-swipe';

const start = { pointerId: 7, clientX: 100, clientY: 100 };
const point = (dx: number, dy: number) => ({ ...start, clientX: start.clientX + dx, clientY: start.clientY + dy });

test('project dock swipes expand to the right and collapse to the left after 32 horizontal pixels', () => {
  assert.equal(getProjectDockSwipe(start, point(32, 3)), 'expand');
  assert.equal(getProjectDockSwipe(start, point(-32, -3)), 'collapse');
  assert.equal(getProjectDockSwipe(start, point(31, 0)), null);
  assert.equal(getProjectDockSwipe(start, point(-31, 0)), null);
});

test('project dock ignores vertical, ambiguous diagonal, and other-pointer movement', () => {
  assert.equal(getProjectDockSwipe(start, point(0, -80)), null);
  assert.equal(getProjectDockSwipe(start, point(-45, 50)), null);
  assert.equal(getProjectDockSwipe(start, point(45, 45)), null);
  assert.equal(getProjectDockSwipe(start, { ...point(80, 0), pointerId: 8 }), null);
});

test('project dock suppresses only the completed swipe click, not keyboard or mouse activation', () => {
  const end = point(60, 0);
  const click = { ...end, pointerType: 'touch', detail: 1 };
  assert.equal(isProjectDockSwipeClick(end, click), true);
  assert.equal(isProjectDockSwipeClick(end, { ...click, detail: 0 }), false);
  assert.equal(isProjectDockSwipeClick(end, { ...click, pointerType: 'mouse' }), false);
  assert.equal(isProjectDockSwipeClick(end, { ...click, pointerId: 8 }), false);
  // Older browsers may send a MouseEvent without pointer metadata for a touch click.
  assert.equal(isProjectDockSwipeClick(end, { clientX: end.clientX + 1, clientY: end.clientY, detail: 1 }), true);
  assert.equal(isProjectDockSwipeClick(end, { clientX: end.clientX + 10, clientY: end.clientY, detail: 1 }), false);
});
