import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ExportToast,
  type ExportToastState,
} from '@features/chat/components/ExportToast';
import { exportConversation } from '@features/chat/conversation-export';
import type { ChatMessage } from '@core/types/messages';
import { translate } from '@shared/i18n';

function createSampleMessages(): ChatMessage[] {
  return [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Hello, can you help me?',
      timestamp: '10:00:00 AM',
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: 'Sure! Here is the response.',
      timestamp: '10:00:05 AM',
    },
  ];
}

// ---------------------------------------------------------------------------
// ExportToast Component Tests
// ---------------------------------------------------------------------------

test('ExportToast: returns null when toast state is null', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ExportToast, {
      toast: null,
      onDismiss: () => {},
    })
  );
  assert.equal(markup, '');
});

test('ExportToast: renders loading state with spinner and polite live region', () => {
  const toastState: ExportToastState = {
    type: 'loading',
    message: 'Exporting conversation…',
  };
  const markup = renderToStaticMarkup(
    React.createElement(ExportToast, {
      toast: toastState,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('export-toast-container'));
  assert.ok(markup.includes('export-toast-loading'));
  assert.ok(markup.includes('export-toast-spinner'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes('aria-live="polite"'));
  assert.ok(markup.includes('Exporting conversation…'));
  assert.ok(markup.includes('export-toast-dismiss'));
});

test('ExportToast: renders success state with green checkmark and status role', () => {
  const toastState: ExportToastState = {
    type: 'success',
    message: 'Conversation saved: conversation-2026-10-05.md',
  };
  const markup = renderToStaticMarkup(
    React.createElement(ExportToast, {
      toast: toastState,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('export-toast-success'));
  assert.ok(markup.includes('is-success'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes('Conversation saved: conversation-2026-10-05.md'));
});

test('ExportToast: renders error state with assertive alert role', () => {
  const toastState: ExportToastState = {
    type: 'error',
    message: 'Export failed: disk full',
  };
  const markup = renderToStaticMarkup(
    React.createElement(ExportToast, {
      toast: toastState,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('export-toast-error'));
  assert.ok(markup.includes('is-error'));
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes('aria-live="assertive"'));
  assert.ok(markup.includes('Export failed: disk full'));
});

test('ExportToast: renders info state with info icon and status role', () => {
  const toastState: ExportToastState = {
    type: 'info',
    message: 'Nothing to export: current conversation has no messages.',
  };
  const markup = renderToStaticMarkup(
    React.createElement(ExportToast, {
      toast: toastState,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('export-toast-info'));
  assert.ok(markup.includes('is-info'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes('Nothing to export'));
});

test('ExportToast: uses custom closeAriaLabel when provided', () => {
  const toastState: ExportToastState = {
    type: 'success',
    message: 'Export initiated: test.md',
  };
  const markup = renderToStaticMarkup(
    React.createElement(ExportToast, {
      toast: toastState,
      onDismiss: () => {},
      closeAriaLabel: 'Cerrar notificación',
    })
  );

  assert.ok(markup.includes('aria-label="Cerrar notificación"'));
});

// ---------------------------------------------------------------------------
// Controller & Progress / Outcome Tests
// ---------------------------------------------------------------------------

test('exportConversation: invokes onProgress callback when validation passes before save', async () => {
  let progressCalled = false;
  const messages = createSampleMessages();

  const outcome = await exportConversation({
    args: 'md',
    messages,
    language: 'en',
    onProgress: () => {
      progressCalled = true;
    },
    saveAdapter: async (payload) => {
      const filename = payload.defaultFilename ?? 'export.md';
      return {
        outcome: 'saved',
        status: 'saved',
        filename,
        path: `/tmp/${filename}`,
      };
    },
  });

  assert.equal(progressCalled, true, 'onProgress should be called during valid export');
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.outcome, 'saved');
  if (outcome.status === 'success') {
    assert.ok(outcome.path?.startsWith('/tmp/'));
  }
});

test('exportConversation: does NOT invoke onProgress on invalid format or empty transcript', async () => {
  let progressCalled = false;

  const invalidOutcome = await exportConversation({
    args: 'invalid-format',
    messages: createSampleMessages(),
    language: 'en',
    onProgress: () => {
      progressCalled = true;
    },
  });
  assert.equal(invalidOutcome.status, 'invalid_format');
  assert.equal(progressCalled, false);

  const emptyOutcome = await exportConversation({
    args: '',
    messages: [],
    language: 'en',
    onProgress: () => {
      progressCalled = true;
    },
  });
  assert.equal(emptyOutcome.status, 'empty');
  assert.equal(progressCalled, false);
});

test('exportConversation: distinguishes saved (Tauri) vs initiated (Web) outcomes', async () => {
  const messages = createSampleMessages();

  // 1. Native Tauri saved
  const tauriOutcome = await exportConversation({
    args: 'json',
    messages,
    language: 'en',
    saveAdapter: async (payload) => {
      const filename = payload.defaultFilename ?? 'file.json';
      return {
        outcome: 'saved',
        status: 'saved',
        filename,
        path: `C:\\Users\\Personal\\Downloads\\${filename}`,
      };
    },
  });
  assert.equal(tauriOutcome.status, 'success');
  assert.equal(tauriOutcome.outcome, 'saved');

  // 2. Web initiated
  const webOutcome = await exportConversation({
    args: 'json',
    messages,
    language: 'en',
    saveAdapter: async (payload) => {
      const filename = payload.defaultFilename ?? 'file.json';
      return {
        outcome: 'initiated',
        status: 'initiated',
        filename,
      };
    },
  });
  assert.equal(webOutcome.status, 'success');
  assert.equal(webOutcome.outcome, 'initiated');
});

test('exportConversation: native dialog cancellation returns cancelled outcome silently', async () => {
  let progressCalled = false;
  const messages = createSampleMessages();

  const outcome = await exportConversation({
    args: 'md',
    messages,
    language: 'en',
    onProgress: () => {
      progressCalled = true;
    },
    saveAdapter: async () => ({
      outcome: 'cancelled',
      status: 'cancelled',
    }),
  });

  assert.equal(progressCalled, true);
  assert.equal(outcome.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// Translations Parity for Export Toast
// ---------------------------------------------------------------------------

test('i18n: export toast strings exist in both English and Spanish', () => {
  const inProgressEn = translate('en', 'command_palette.export_in_progress');
  const inProgressEs = translate('es', 'command_palette.export_in_progress');
  assert.ok(inProgressEn.length > 0);
  assert.ok(inProgressEs.length > 0);
  assert.notEqual(inProgressEn, inProgressEs);

  const savedEn = translate('en', 'command_palette.export_saved', { filename: 'file.md' });
  const savedEs = translate('es', 'command_palette.export_saved', { filename: 'file.md' });
  assert.ok(savedEn.includes('file.md'));
  assert.ok(savedEs.includes('file.md'));
  assert.notEqual(savedEn, savedEs);

  const closeEn = translate('en', 'command_palette.toast_close');
  const closeEs = translate('es', 'command_palette.toast_close');
  assert.ok(closeEn.length > 0);
  assert.ok(closeEs.length > 0);
  assert.notEqual(closeEn, closeEs);
});
