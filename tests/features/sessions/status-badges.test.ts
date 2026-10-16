import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionSidebar } from '@features/sessions/SessionSidebar';
import type { SessionRuntimeStatus } from '@core/types/sessions';

for (const status of ['working', 'waiting', 'completed'] as SessionRuntimeStatus[]) {
  test(`sidebar: ${status} badge only appears for an inactive session`, () => {
    for (const activeVia of ['none', 'flag', 'id', 'path']) {
      const html = renderToStaticMarkup(React.createElement(SessionSidebar, {
        sessions: [{ id: 'a', path: '/a.jsonl', firstMessage: 'A', messageCount: 1, isActive: activeVia === 'flag', status }],
        isLoading: false, isSwitching: false, error: null,
        activeSessionId: activeVia === 'id' ? 'a' : null,
        activeSessionFile: activeVia === 'path' ? '/a.jsonl' : null,
        onSelectSession: () => {}, onNewSession: () => {}, onDeleteSession: () => {},
        onRenameSession: () => {}, onClose: () => {}, locale: 'en', filesPanel: null,
      }));
      assert.equal(html.includes(`session-status-badge status-${status}`), status !== 'completed' && activeVia === 'none');
      assert.equal(html.includes('active-badge'), false);
      if (activeVia !== 'none') {
        assert.ok(html.includes('sidebar-item is-active'));
        assert.ok(html.includes('aria-current="true"'));
      }
    }
  });
}
