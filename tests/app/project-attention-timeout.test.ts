import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

test('visible toast expires after 15 seconds; advancing or dismissing cancels its timer', async (t) => {
  const { useProjectAttentionTimeout } = await import('@app/useProjectAttentionTimeout');
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const previous = dispatcher.current;
  let cleanup: (() => void) | undefined;
  let dismissals = 0;
  const first = { projectId: 'a', type: 'task_complete' as const };
  const second = { projectId: 'b', type: 'error' as const };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  dispatcher.current = { useEffect(effect: () => (() => void) | undefined) { cleanup = effect(); } };
  try {
    useProjectAttentionTimeout(first, () => { dismissals++; });
    t.mock.timers.tick(14999);
    assert.equal(dismissals, 0);
    t.mock.timers.tick(1);
    assert.equal(dismissals, 1);
    cleanup?.();
    useProjectAttentionTimeout(second, () => { dismissals++; });
    t.mock.timers.tick(5000);
    cleanup?.(); // Manual dismissal or a project change removes this toast.
    useProjectAttentionTimeout(first, () => { dismissals++; });
    t.mock.timers.tick(14999);
    assert.equal(dismissals, 1, 'previous toast timer must not dismiss the next toast');
    t.mock.timers.tick(1);
    assert.equal(dismissals, 2);
    cleanup?.();
    useProjectAttentionTimeout(null, () => { dismissals++; });
    t.mock.timers.tick(30000);
    assert.equal(dismissals, 2, 'no timer when no toast is visible');
  } finally {
    cleanup?.();
    dispatcher.current = previous;
    t.mock.timers.reset();
  }
});
