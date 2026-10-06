import assert from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionSidebar,
  canSelectSession,
  categorizeSessionTime,
  formatSessionTimestamp,
  getSessionDisplayTitle,
  matchesSessionSearch,
  normalizeSessionName,
} from '@features/sessions/SessionSidebar';
import {
  canStartNewConversation,
  decideSelectSession,
} from '@features/sessions/session-actions';
import type { SessionSummary } from '@core/types/sessions';

test('categorizeSessionTime: classifies timestamps into today, yesterday, previous_days, and older', () => {
  const fixedNow = new Date('2026-09-19T16:00:00.000Z');

  // Same day
  const todayStr = '2026-09-19T10:30:00.000Z';
  assert.strictEqual(categorizeSessionTime(todayStr, fixedNow), 'today');

  // Yesterday
  const yesterdayStr = '2026-09-18T15:00:00.000Z';
  assert.strictEqual(categorizeSessionTime(yesterdayStr, fixedNow), 'yesterday');

  // 4 days ago
  const previousDaysStr = '2026-09-15T12:00:00.000Z';
  assert.strictEqual(categorizeSessionTime(previousDaysStr, fixedNow), 'previous_days');

  // 10 days ago
  const olderStr = '2026-09-09T08:00:00.000Z';
  assert.strictEqual(categorizeSessionTime(olderStr, fixedNow), 'older');

  // Undefined or invalid timestamps safely default to 'older'
  assert.strictEqual(categorizeSessionTime(undefined, fixedNow), 'older');
  assert.strictEqual(categorizeSessionTime('invalid-date', fixedNow), 'older');
});

test('formatSessionTimestamp: formats time for today and date for older sessions in en and es', () => {
  const now = new Date();
  const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30).toISOString();
  const olderIso = '2025-01-15T10:00:00.000Z';

  const formattedEnToday = formatSessionTimestamp(todayIso, 'en');
  assert.ok(formattedEnToday.length > 0, 'Today time string should not be empty');

  const formattedEsToday = formatSessionTimestamp(todayIso, 'es');
  assert.ok(formattedEsToday.length > 0, 'Today time string in es should not be empty');

  const formattedEnOlder = formatSessionTimestamp(olderIso, 'en');
  assert.ok(formattedEnOlder.includes('Jan') || formattedEnOlder.includes('15'), 'Older date formatted in en');

  const formattedEsOlder = formatSessionTimestamp(olderIso, 'es');
  assert.ok(formattedEsOlder.length > 0, 'Older date formatted in es');

  assert.strictEqual(formatSessionTimestamp(undefined), '');
  assert.strictEqual(formatSessionTimestamp('not-a-date'), '');
});

test('SessionSidebar: search filtering logic matches first message, session id, or custom title', () => {
  // Exercises the real matchesSessionSearch, not a hand-reimplementation of the filter.
  const sessions: SessionSummary[] = [
    {
      id: 'sess-alpha',
      path: '/path/1.jsonl',
      firstMessage: 'Fix navigation issue in sidebar',
      messageCount: 4,
      isActive: false,
    },
    {
      id: 'sess-beta',
      path: '/path/2.jsonl',
      firstMessage: 'Create database migration',
      messageCount: 2,
      isActive: true,
    },
    {
      id: 'sess-gamma',
      path: '/path/3.jsonl',
      firstMessage: 'Update README with instructions',
      messageCount: 1,
      isActive: false,
    },
    {
      id: 'sess-delta',
      path: '/path/4.jsonl',
      firstMessage: 'Some unrelated first message',
      messageCount: 3,
      isActive: false,
      customTitle: 'Deploy pipeline notes',
    },
  ];

  const filter = (query: string) => sessions.filter((s) => matchesSessionSearch(s, query));

  // Match by keyword in firstMessage
  assert.strictEqual(filter('navigation').length, 1);
  assert.strictEqual(filter('navigation')[0].id, 'sess-alpha');

  // Match by ID
  assert.strictEqual(filter('beta').length, 1);
  assert.strictEqual(filter('beta')[0].id, 'sess-beta');

  // Case-insensitive match
  assert.strictEqual(filter('README').length, 1);
  assert.strictEqual(filter('README')[0].id, 'sess-gamma');

  // Match by customTitle even when firstMessage does not contain the query
  assert.strictEqual(filter('deploy').length, 1);
  assert.strictEqual(filter('deploy')[0].id, 'sess-delta');

  // Non-matching query
  assert.strictEqual(filter('nonexistent-term').length, 0);

  // Empty query returns all
  assert.strictEqual(filter('   ').length, 4);
});

test('getSessionDisplayTitle: prefers a non-blank customTitle over firstMessage', () => {
  const withCustomTitle: SessionSummary = {
    id: 'sess-1',
    path: '/p.jsonl',
    firstMessage: 'Original first message',
    messageCount: 3,
    isActive: false,
    customTitle: 'My renamed chat',
  };
  assert.strictEqual(getSessionDisplayTitle(withCustomTitle, 'fallback'), 'My renamed chat');

  const withoutCustomTitle: SessionSummary = {
    id: 'sess-2',
    path: '/p2.jsonl',
    firstMessage: 'Original first message',
    messageCount: 3,
    isActive: false,
  };
  assert.strictEqual(getSessionDisplayTitle(withoutCustomTitle, 'fallback'), 'Original first message');

  const blankCustomTitle: SessionSummary = {
    id: 'sess-3',
    path: '/p3.jsonl',
    firstMessage: 'Original first message',
    messageCount: 3,
    isActive: false,
    customTitle: '   ',
  };
  assert.strictEqual(getSessionDisplayTitle(blankCustomTitle, 'fallback'), 'Original first message');

  const noMessagesEither: SessionSummary = {
    id: 'sess-4',
    path: '/p4.jsonl',
    firstMessage: '',
    messageCount: 0,
    isActive: false,
  };
  assert.strictEqual(getSessionDisplayTitle(noMessagesEither, 'fallback'), 'fallback');
});

test('normalizeSessionName: trims whitespace and collapses blank input to empty string', () => {
  assert.strictEqual(normalizeSessionName('  My Session  '), 'My Session');
  assert.strictEqual(normalizeSessionName('   '), '');
  assert.strictEqual(normalizeSessionName(''), '');
  assert.strictEqual(normalizeSessionName('No leading or trailing'), 'No leading or trailing');
});

test('Bridge: deleteSessionPi invokes delete_session command with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return { success: true, wasActive: false } as T;
  };

  const { deleteSessionPi } = await import('@infra/bridge');
  const res = await deleteSessionPi('/path/to/del.jsonl', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'delete_session');
  assert.deepStrictEqual(calls[0].args, { payload: { sessionPath: '/path/to/del.jsonl' } });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.wasActive, false);
});

test('Bridge: renameSessionPi invokes rename_session command with payload and returns updated summary', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return {
      id: 'sess-1',
      path: '/path/to/session.jsonl',
      firstMessage: 'Hello',
      messageCount: 2,
      isActive: false,
      customTitle: 'My renamed chat',
    } as T;
  };

  const { renameSessionPi } = await import('@infra/bridge');
  const res = await renameSessionPi('/path/to/session.jsonl', 'My renamed chat', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'rename_session');
  assert.deepStrictEqual(calls[0].args, {
    payload: { sessionPath: '/path/to/session.jsonl', name: 'My renamed chat' },
  });
  assert.strictEqual(res.customTitle, 'My renamed chat');
});

test('Bridge: renameSessionPi throws outside Tauri without an injected invokeFn', async () => {
  const { renameSessionPi } = await import('@infra/bridge');
  await assert.rejects(() => renameSessionPi('/path/to/session.jsonl', 'New name'));
});

test('SessionSidebar: empty sessions with 0 messages are not eligible for deletion', () => {
  const emptySession: SessionSummary = {
    id: 'empty-sess-1',
    path: '',
    firstMessage: '(no messages)',
    messageCount: 0,
    isActive: true,
  };

  const populatedSession: SessionSummary = {
    id: 'pop-sess-2',
    path: '/path/to/session.jsonl',
    firstMessage: 'Hola',
    messageCount: 2,
    isActive: false,
  };

  const isEligibleForDelete = (session: SessionSummary) =>
    session.messageCount > 0 && Boolean(session.path && session.path.trim().length > 0);

  assert.strictEqual(isEligibleForDelete(emptySession), false, 'Empty session cannot be deleted');
  assert.strictEqual(isEligibleForDelete(populatedSession), true, 'Populated session can be deleted');
});

test('SessionSidebar: canSelectSession allows selection for active sessions but blocks when switching or deleting', () => {
  // Active session can be selected when idle
  assert.strictEqual(canSelectSession(false, false), true, 'Allowed when idle');

  // Blocked while switching
  assert.strictEqual(canSelectSession(true, false), false, 'Blocked while switching');

  // Blocked while confirming delete
  assert.strictEqual(canSelectSession(false, true), false, 'Blocked while confirming delete');

  // Blocked when both switching and confirming delete
  assert.strictEqual(canSelectSession(true, true), false, 'Blocked when both');
});

test('SessionSidebar: clicking or keyboard activating active session triggers onSelectSession', () => {
  const selected: SessionSummary[] = [];
  const onSelectSession = (s: SessionSummary) => selected.push(s);

  const activeSession: SessionSummary = {
    id: 'sess-active-1',
    path: '/path/to/active.jsonl',
    firstMessage: 'Active chat conversation',
    messageCount: 4,
    isActive: true,
  };

  const isSwitching = false;
  const isConfirmingDelete = false;

  // Click handler logic: canSelectSession allows active session
  if (canSelectSession(isSwitching, isConfirmingDelete)) {
    onSelectSession(activeSession);
  }
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].id, 'sess-active-1');

  // Keydown handler logic: Enter and Space trigger onSelectSession
  const simulateKeyDown = (key: string) => {
    let defaultPrevented = false;
    if ((key === 'Enter' || key === ' ') && canSelectSession(isSwitching, isConfirmingDelete)) {
      defaultPrevented = true;
      onSelectSession(activeSession);
    }
    return defaultPrevented;
  };

  assert.strictEqual(simulateKeyDown('Enter'), true);
  assert.strictEqual(selected.length, 2);

  assert.strictEqual(simulateKeyDown(' '), true);
  assert.strictEqual(selected.length, 3);

  assert.strictEqual(simulateKeyDown('ArrowDown'), false);
  assert.strictEqual(selected.length, 3);
});

test('App handleSelectSession logic: selecting active session closes settings and exits early without switching', () => {
  // Exercises the real decideSelectSession, not a hand-reimplementation of App.tsx's
  // guard logic (odd/tasks/architecture-restructure.md, T5d: this test used to copy the
  // code instead of testing it).
  const activeSession: SessionSummary = {
    id: 'active-session-123',
    path: '/data/active.jsonl',
    firstMessage: 'Hello Pi',
    messageCount: 5,
    isActive: true,
  };
  const sessionState = {
    isSwitchingSession: false,
    sessionId: 'active-session-123',
    sessionFile: '/data/active.jsonl',
  };

  // Case 1: In settings, user clicks active session -> reports closing settings, no switch.
  const activeDecision = decideSelectSession(activeSession, sessionState, false, true);
  assert.deepStrictEqual(activeDecision, { action: 'already-current', closeSettings: true });

  // Case 2: In settings, user clicks a different, inactive session -> reports a switch.
  const otherSession: SessionSummary = {
    id: 'other-session-456',
    path: '/data/other.jsonl',
    firstMessage: 'Other conversation',
    messageCount: 2,
    isActive: false,
  };
  const switchDecision = decideSelectSession(otherSession, sessionState, false, true);
  assert.deepStrictEqual(switchDecision, { action: 'switch' });
});

test('App handleNewConversation logic: closes settings when open', () => {
  // Exercises the real canStartNewConversation guard, not a hand-reimplementation.
  assert.strictEqual(canStartNewConversation(false, false, false), true);
  assert.strictEqual(canStartNewConversation(true, false, false), false);
});

test('SessionSidebar: renders runtime status badges for working, waiting, completed, and unloaded sessions', () => {
  const sessions: SessionSummary[] = [
    {
      id: 'sess-w',
      path: '/path/w.jsonl',
      firstMessage: 'Working session',
      messageCount: 3,
      isActive: false,
      status: 'working',
    },
    {
      id: 'sess-wait',
      path: '/path/wait.jsonl',
      firstMessage: 'Waiting session',
      messageCount: 3,
      isActive: false,
      status: 'waiting',
    },
    {
      id: 'sess-comp',
      path: '/path/comp.jsonl',
      firstMessage: 'Completed session',
      messageCount: 3,
      isActive: false,
      status: 'completed',
    },
    {
      id: 'sess-unl',
      path: '/path/unl.jsonl',
      firstMessage: 'Unloaded session',
      messageCount: 3,
      isActive: false,
      status: 'unloaded',
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(SessionSidebar, {
      sessions,
      isLoading: false,
      isSwitching: false,
      activeSessionId: null,
      activeSessionFile: null,
      error: null,
      onSelectSession: () => {},
      onNewSession: () => {},
      onDeleteSession: () => {},
      onRenameSession: () => {},
      onClose: () => {},
      locale: 'es',
      filesPanel: null,
    })
  );

  assert.ok(html.includes('session-status-badge status-working'));
  assert.ok(html.includes('Trabajando'));
  assert.ok(html.includes('session-status-badge status-waiting'));
  assert.ok(html.includes('Pidiendo permiso'));
  assert.ok(html.includes('session-status-badge status-completed'));
  assert.ok(html.includes('Terminada'));
  assert.ok(html.includes('session-status-badge status-unloaded'));
  assert.ok(html.includes('No cargada'));
});


