import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DEFAULT_TOAST_DURATIONS,
  MAX_VISIBLE_TOASTS,
  SettingsToastContainer,
  SettingsToastContext,
  SettingsToastItem,
  useSettingsToast,
  type SettingsToastContextValue,
  type SettingsToastData,
} from '@features/settings/toast';

// ---------------------------------------------------------------------------
// SettingsToastItem Tests
// ---------------------------------------------------------------------------

test('SettingsToastItem: renders success toast with status role and icon', () => {
  const item: SettingsToastData = {
    id: 'test-1',
    type: 'success',
    message: 'Configuration saved successfully',
    createdAt: Date.now(),
  };

  const markup = renderToStaticMarkup(
    React.createElement(SettingsToastItem, {
      toast: item,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('settings-toast'));
  assert.ok(markup.includes('settings-toast-success'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes('Configuration saved successfully'));
  assert.ok(markup.includes('settings-toast-dismiss'));
});

test('SettingsToastItem: renders error toast with alert role', () => {
  const item: SettingsToastData = {
    id: 'test-2',
    type: 'error',
    message: 'Failed to connect to Pi runtime',
    createdAt: Date.now(),
  };

  const markup = renderToStaticMarkup(
    React.createElement(SettingsToastItem, {
      toast: item,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('settings-toast'));
  assert.ok(markup.includes('settings-toast-error'));
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes('Failed to connect to Pi runtime'));
});

test('SettingsToastItem: renders warning toast with status role and warning icon', () => {
  const item: SettingsToastData = {
    id: 'test-3',
    type: 'warning',
    message: 'Working directory does not exist yet',
    createdAt: Date.now(),
  };

  const markup = renderToStaticMarkup(
    React.createElement(SettingsToastItem, {
      toast: item,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('settings-toast-warning'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes('Working directory does not exist yet'));
});

test('SettingsToastItem: renders info toast with status role and info icon', () => {
  const item: SettingsToastData = {
    id: 'test-4',
    type: 'info',
    message: 'Auto-detected gentle-shell at /usr/local/bin/pi',
    createdAt: Date.now(),
  };

  const markup = renderToStaticMarkup(
    React.createElement(SettingsToastItem, {
      toast: item,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('settings-toast-info'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes('Auto-detected gentle-shell at /usr/local/bin/pi'));
});

test('SettingsToastItem: renders optional title and action button when supplied', () => {
  const item: SettingsToastData = {
    id: 'test-5',
    type: 'warning',
    title: 'Storage Warning',
    message: 'Persistent storage is in read-only mode',
    action: {
      label: 'Retry',
      onClick: () => {},
    },
    createdAt: Date.now(),
  };

  const markup = renderToStaticMarkup(
    React.createElement(SettingsToastItem, {
      toast: item,
      onDismiss: () => {},
    })
  );

  assert.ok(markup.includes('settings-toast-title'));
  assert.ok(markup.includes('Storage Warning'));
  assert.ok(markup.includes('settings-toast-action-btn'));
  assert.ok(markup.includes('Retry'));
});

// ---------------------------------------------------------------------------
// SettingsToastContainer Tests
// ---------------------------------------------------------------------------

test('SettingsToastContainer: returns null when there are no toasts', () => {
  const mockContext: SettingsToastContextValue = {
    toasts: [],
    showToast: () => '',
    dismissToast: () => {},
    clearAll: () => {},
    success: () => '',
    error: () => '',
    warning: () => '',
    info: () => '',
  };

  const markup = renderToStaticMarkup(
    React.createElement(
      SettingsToastContext.Provider,
      { value: mockContext },
      React.createElement(SettingsToastContainer, null)
    )
  );

  assert.equal(markup, '');
});

test('SettingsToastContainer: renders toasts with polite aria-live when no errors', () => {
  const mockContext: SettingsToastContextValue = {
    toasts: [
      {
        id: 'toast-1',
        type: 'success',
        message: 'Settings applied',
        createdAt: Date.now(),
      },
      {
        id: 'toast-2',
        type: 'info',
        message: 'Theme changed',
        createdAt: Date.now(),
      },
    ],
    showToast: () => '',
    dismissToast: () => {},
    clearAll: () => {},
    success: () => '',
    error: () => '',
    warning: () => '',
    info: () => '',
  };

  const markup = renderToStaticMarkup(
    React.createElement(
      SettingsToastContext.Provider,
      { value: mockContext },
      React.createElement(SettingsToastContainer, null)
    )
  );

  assert.ok(markup.includes('settings-toast-container'));
  assert.ok(markup.includes('aria-live="polite"'));
  assert.ok(markup.includes('Settings applied'));
  assert.ok(markup.includes('Theme changed'));
});

test('SettingsToastContainer: renders with assertive aria-live when at least one error toast exists', () => {
  const mockContext: SettingsToastContextValue = {
    toasts: [
      {
        id: 'toast-1',
        type: 'success',
        message: 'Binary paths refreshed',
        createdAt: Date.now(),
      },
      {
        id: 'toast-2',
        type: 'error',
        message: 'Invalid node path',
        createdAt: Date.now(),
      },
    ],
    showToast: () => '',
    dismissToast: () => {},
    clearAll: () => {},
    success: () => '',
    error: () => '',
    warning: () => '',
    info: () => '',
  };

  const markup = renderToStaticMarkup(
    React.createElement(
      SettingsToastContext.Provider,
      { value: mockContext },
      React.createElement(SettingsToastContainer, null)
    )
  );

  assert.ok(markup.includes('aria-live="assertive"'));
  assert.ok(markup.includes('Binary paths refreshed'));
  assert.ok(markup.includes('Invalid node path'));
});

// ---------------------------------------------------------------------------
// Context Defaults and Hook Tests
// ---------------------------------------------------------------------------

test('SettingsToast: default durations align with standard spec', () => {
  assert.equal(DEFAULT_TOAST_DURATIONS.success, 3500);
  assert.equal(DEFAULT_TOAST_DURATIONS.info, 3500);
  assert.equal(DEFAULT_TOAST_DURATIONS.warning, 5000);
  assert.equal(DEFAULT_TOAST_DURATIONS.error, 7000);
  assert.equal(MAX_VISIBLE_TOASTS, 4);
});

test('useSettingsToast: returns safe fallback no-op functions when rendered outside provider', () => {
  let captured: SettingsToastContextValue | null = null;
  function TestConsumer() {
    captured = useSettingsToast();
    return React.createElement('div', null, 'Consumer');
  }

  const markup = renderToStaticMarkup(React.createElement(TestConsumer, null));
  assert.ok(markup.includes('Consumer'));
  assert.ok(captured !== null);
  assert.deepEqual((captured as any).toasts, []);
  assert.equal((captured as any).showToast('success', 'test'), '');
  assert.equal((captured as any).success('test'), '');
  assert.equal((captured as any).error('test'), '');
  assert.equal((captured as any).warning('test'), '');
  assert.equal((captured as any).info('test'), '');
});
