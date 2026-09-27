import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  canDeleteSession,
  canStartNewConversation,
  decideDeleteOutcome,
  decideNewConversationOutcome,
  decideSelectSession,
  fetchSwitchedSessionStats,
  shouldReloadSessionsOnIdle,
} from '@features/sessions/session-actions';
import { SidebarSearchBar } from '@features/sessions/components/SidebarSearchBar';
import type { SessionSummary } from '@core/types/sessions';

const activeSession: SessionSummary = {
  id: 'active-session-123',
  path: '/data/active.jsonl',
  firstMessage: 'Hello Pi',
  messageCount: 5,
  isActive: true,
};

const otherSession: SessionSummary = {
  id: 'other-session-456',
  path: '/data/other.jsonl',
  firstMessage: 'Other conversation',
  messageCount: 2,
  isActive: false,
};

test('decideSelectSession: blocked while switching or busy, regardless of which session was clicked', () => {
  const sessionState = { isSwitchingSession: true, sessionId: null, sessionFile: null };
  assert.deepStrictEqual(decideSelectSession(otherSession, sessionState, false, false), {
    action: 'blocked',
  });
  assert.deepStrictEqual(
    decideSelectSession(otherSession, { ...sessionState, isSwitchingSession: false }, true, false),
    { action: 'blocked' }
  );
});

test('decideSelectSession: clicking the active session never switches, only reports whether settings should close', () => {
  const sessionState = {
    isSwitchingSession: false,
    sessionId: 'active-session-123',
    sessionFile: '/data/active.jsonl',
  };

  assert.deepStrictEqual(decideSelectSession(activeSession, sessionState, false, true), {
    action: 'already-current',
    closeSettings: true,
  });
  assert.deepStrictEqual(decideSelectSession(activeSession, sessionState, false, false), {
    action: 'already-current',
    closeSettings: false,
  });
});

test('decideSelectSession: matches "current" by sessionId or sessionFile even when isActive is false', () => {
  const byId = decideSelectSession(
    { ...otherSession, isActive: false },
    { isSwitchingSession: false, sessionId: 'other-session-456', sessionFile: null },
    false,
    false
  );
  assert.strictEqual(byId.action, 'already-current');

  const byFile = decideSelectSession(
    { ...otherSession, isActive: false },
    { isSwitchingSession: false, sessionId: null, sessionFile: '/data/other.jsonl' },
    false,
    false
  );
  assert.strictEqual(byFile.action, 'already-current');
});

test('decideSelectSession: a genuinely different, inactive session switches', () => {
  const sessionState = {
    isSwitchingSession: false,
    sessionId: 'active-session-123',
    sessionFile: '/data/active.jsonl',
  };
  assert.deepStrictEqual(decideSelectSession(otherSession, sessionState, false, true), {
    action: 'switch',
  });
});

test('canDeleteSession: false while busy or switching, true otherwise', () => {
  assert.strictEqual(canDeleteSession(true, false), false);
  assert.strictEqual(canDeleteSession(false, true), false);
  assert.strictEqual(canDeleteSession(true, true), false);
  assert.strictEqual(canDeleteSession(false, false), true);
});

test('decideDeleteOutcome: a failed delete reports failed regardless of other fields', () => {
  assert.deepStrictEqual(decideDeleteOutcome({ success: false, wasActive: true }), {
    kind: 'failed',
  });
});

test('decideDeleteOutcome: deleting a non-active session reports plain success', () => {
  assert.deepStrictEqual(decideDeleteOutcome({ success: true, wasActive: false }), {
    kind: 'success',
  });
});

test('decideDeleteOutcome: deleting the active session with a full replacement reports active-replaced and asks to save the record', () => {
  const outcome = decideDeleteOutcome({
    success: true,
    wasActive: true,
    newSession: { cancelled: false, sessionId: 'new-1', sessionFile: '/data/new-1.jsonl' },
  });
  assert.deepStrictEqual(outcome, {
    kind: 'active-replaced',
    shouldSaveRecord: true,
    sessionId: 'new-1',
    sessionFile: '/data/new-1.jsonl',
  });
});

test('decideDeleteOutcome: deleting the active session with a partial replacement still reports active-replaced but does not ask to save', () => {
  const outcome = decideDeleteOutcome({
    success: true,
    wasActive: true,
    newSession: { cancelled: false, sessionId: 'new-1' },
  });
  assert.deepStrictEqual(outcome, {
    kind: 'active-replaced',
    shouldSaveRecord: false,
    sessionId: 'new-1',
    sessionFile: undefined,
  });
});

test('canStartNewConversation: false if busy, connecting or already resetting; true otherwise', () => {
  assert.strictEqual(canStartNewConversation(true, false, false), false);
  assert.strictEqual(canStartNewConversation(false, true, false), false);
  assert.strictEqual(canStartNewConversation(false, false, true), false);
  assert.strictEqual(canStartNewConversation(false, false, false), true);
});

test('decideNewConversationOutcome: cancelled result reports cancelled', () => {
  assert.deepStrictEqual(decideNewConversationOutcome({ cancelled: true }), { kind: 'cancelled' });
});

test('decideNewConversationOutcome: partial reset reports the backend error or the fail-closed default message', () => {
  assert.deepStrictEqual(
    decideNewConversationOutcome({ cancelled: false, partialReset: true, error: 'disk full' }),
    { kind: 'partial-reset', error: 'disk full' }
  );
  assert.deepStrictEqual(
    decideNewConversationOutcome({ cancelled: false, partialReset: true }),
    {
      kind: 'partial-reset',
      error: 'Session reset partially completed in Pi, but state reconciliation failed',
    }
  );
});

test('decideNewConversationOutcome: success reports whether the record should be saved', () => {
  assert.deepStrictEqual(
    decideNewConversationOutcome({
      cancelled: false,
      sessionId: 'sess-1',
      sessionFile: '/data/sess-1.jsonl',
    }),
    { kind: 'success', shouldSaveRecord: true, sessionId: 'sess-1', sessionFile: '/data/sess-1.jsonl' }
  );
  assert.deepStrictEqual(decideNewConversationOutcome({ cancelled: false }), {
    kind: 'success',
    shouldSaveRecord: false,
    sessionId: undefined,
    sessionFile: undefined,
  });
});

test('shouldReloadSessionsOnIdle: only true on the exact busy -> idle transition while connected', () => {
  assert.strictEqual(shouldReloadSessionsOnIdle(true, false, true), true);
  assert.strictEqual(shouldReloadSessionsOnIdle(true, false, false), false);
  assert.strictEqual(shouldReloadSessionsOnIdle(false, false, true), false);
  assert.strictEqual(shouldReloadSessionsOnIdle(true, true, true), false);
});

test('SidebarSearchBar: renders empty state, wrapper, svg icon, and input attributes', () => {
  assert.strictEqual(typeof SidebarSearchBar, 'function');

  const element = React.createElement(SidebarSearchBar, {
    value: '',
    onChange: () => {},
    placeholder: 'Search sessions...',
    clearAriaLabel: 'Clear session search',
    className: 'custom-sidebar-search',
    autoFocus: true,
  });

  const markup = renderToStaticMarkup(element);

  // Outer container and classes
  assert.ok(markup.includes('sidebar-search custom-sidebar-search'));
  assert.ok(markup.includes('search-input-wrapper'));
  // SVG icon
  assert.ok(markup.includes('search-icon'));
  assert.ok(markup.includes('aria-hidden="true"'));
  // Input attributes
  assert.ok(markup.includes('class="sidebar-search-input"'));
  assert.ok(markup.includes('placeholder="Search sessions..."'));
  assert.ok(markup.includes('aria-label="Search sessions..."'));
  assert.ok(markup.includes('value=""'));
  // Clear button is not rendered when value is empty
  assert.ok(!markup.includes('search-clear-btn'));
});

test('SidebarSearchBar: renders query state with clear button and handles onChange and clear click', () => {
  let changedVal = '';
  const element = React.createElement(SidebarSearchBar, {
    value: 'my-session',
    onChange: (val: string) => {
      changedVal = val;
    },
    placeholder: 'Search sessions...',
    clearAriaLabel: 'Clear session search',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('value="my-session"'));
  assert.ok(markup.includes('search-clear-btn'));
  assert.ok(markup.includes('aria-label="Clear session search"'));
  assert.ok(markup.includes('×'));

  // Direct component tree test for event callbacks
  const instance = SidebarSearchBar({
    value: 'my-session',
    onChange: (val: string) => {
      changedVal = val;
    },
    placeholder: 'Search sessions...',
    clearAriaLabel: 'Clear session search',
  });

  assert.ok(React.isValidElement(instance));
  assert.strictEqual(instance.props.className, 'sidebar-search');

  // Find wrapper and its children
  const wrapper = instance.props.children;
  assert.ok(React.isValidElement<{ children?: React.ReactNode }>(wrapper));
  const children = React.Children.toArray(wrapper.props.children);

  const inputEl = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'input'
  );
  assert.ok(inputEl);
  inputEl.props.onChange({ target: { value: 'another-session' } });
  assert.strictEqual(changedVal, 'another-session');

  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  assert.strictEqual(clearBtn.props['aria-label'], 'Clear session search');
  clearBtn.props.onClick();
  assert.strictEqual(changedVal, '');
});

test('SidebarSearchBar: uses default clearAriaLabel when omitted', () => {
  const instance = SidebarSearchBar({
    value: 'some-query',
    onChange: () => {},
    placeholder: 'Search...',
  });

  assert.ok(React.isValidElement(instance));
  const wrapper = instance.props.children;
  assert.ok(React.isValidElement<{ children?: React.ReactNode }>(wrapper));
  const children = React.Children.toArray(wrapper.props.children);
  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  assert.strictEqual(clearBtn.props['aria-label'], 'Clear search');
});

test('fetchSwitchedSessionStats returns stats for the switched session', async () => {
  const stats = { sessionId: 'other-session-456', totalMessages: 4 };
  const result = await fetchSwitchedSessionStats(async () => stats, 'other-session-456');
  assert.deepEqual(result, stats);
});

test('fetchSwitchedSessionStats accepts stats without a session id', async () => {
  const stats = { totalMessages: 4 };
  const result = await fetchSwitchedSessionStats(async () => stats, 'other-session-456');
  assert.deepEqual(result, stats);
});

test('fetchSwitchedSessionStats ignores stats that belong to another session', async () => {
  const result = await fetchSwitchedSessionStats(
    async () => ({ sessionId: 'stale-session', totalMessages: 9 }),
    'other-session-456'
  );
  assert.equal(result, null);
});

test('fetchSwitchedSessionStats returns null when stats are unavailable or the fetch fails', async () => {
  assert.equal(await fetchSwitchedSessionStats(async () => null, 'other-session-456'), null);
  assert.equal(
    await fetchSwitchedSessionStats(async () => {
      throw new Error('rpc timeout');
    }, 'other-session-456'),
    null
  );
});
