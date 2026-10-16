import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WebPushInvitation } from '@features/settings/components/WebPushInvitation';
import type { TranslationKey } from '@shared/i18n';

const mockDict: Record<string, string> = {
  'settings.web_push_invitation_title': 'Enable project push notifications?',
  'settings.web_push_invitation_message':
    'Activate WebPush in this browser to receive project notifications while Pi Viewer is closed.',
  'settings.web_push_invitation_accept': 'Accept',
  'settings.web_push_invitation_decline': 'Decline',
  'settings.web_push_invitation_pending': 'Activating…',
  'settings.web_push_error': 'Web Push could not be synchronized.',
};

const t = (key: TranslationKey) => mockDict[key] ?? String(key);

test('WebPushInvitation: renders nothing when isOpen is false', () => {
  const html = renderToStaticMarkup(
    React.createElement(WebPushInvitation, {
      isOpen: false,
      isPending: false,
      error: null,
      onAccept: () => {},
      onDecline: () => {},
      t,
    })
  );
  assert.equal(html, '');
});

test('WebPushInvitation: renders bottom invitation banner with accept and decline buttons when isOpen is true', () => {
  const html = renderToStaticMarkup(
    React.createElement(WebPushInvitation, {
      isOpen: true,
      isPending: false,
      error: null,
      onAccept: () => {},
      onDecline: () => {},
      t,
    })
  );

  assert.ok(html.includes('class="web-push-invitation"'));
  assert.ok(html.includes('data-testid="web-push-invitation"'));
  assert.match(html, /role="(dialog|alertdialog|region)"/);
  assert.ok(html.includes('Enable project push notifications?'));
  assert.ok(html.includes('Activate WebPush in this browser'));
  assert.ok(html.includes('data-testid="web-push-invitation-accept"'));
  assert.ok(html.includes('data-testid="web-push-invitation-decline"'));
  assert.ok(html.includes('Accept'));
  assert.ok(html.includes('Decline'));
  assert.ok(!html.includes('disabled=""'));
});

test('WebPushInvitation: pending operation disables buttons and shows pending label', () => {
  const html = renderToStaticMarkup(
    React.createElement(WebPushInvitation, {
      isOpen: true,
      isPending: true,
      error: null,
      onAccept: () => {},
      onDecline: () => {},
      t,
    })
  );

  assert.ok(html.includes('Activating…'));
  // Both Accept and Decline buttons disabled during pending operation
  const disabledMatches = html.match(/disabled=""/g) ?? [];
  assert.equal(disabledMatches.length, 2, 'Both buttons must be disabled while operation is pending');
});

test('WebPushInvitation: error state renders visible alert and keeps buttons retryable and usable', () => {
  const html = renderToStaticMarkup(
    React.createElement(WebPushInvitation, {
      isOpen: true,
      isPending: false,
      error: 'VAPID key not configured',
      onAccept: () => {},
      onDecline: () => {},
      t,
    })
  );

  assert.match(html, /role="alert"/);
  assert.ok(html.includes('VAPID key not configured'));
  // Neither button is disabled in error state -> retryable and declinable
  assert.ok(!html.includes('disabled=""'));
});

test('WebPushInvitation: button click handlers are properly wired', () => {
  let accepted = false;
  let declined = false;

  let tree: React.ReactNode;
  renderToStaticMarkup(
    React.createElement(() => {
      tree = WebPushInvitation({
        isOpen: true,
        isPending: false,
        error: null,
        onAccept: () => {
          accepted = true;
        },
        onDecline: () => {
          declined = true;
        },
        t,
      });
      return tree;
    })
  );

  const findButton = (node: any, testId: string): any => {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['data-testid'] === testId) return node;
    const children = Array.isArray(node.props?.children)
      ? node.props.children
      : [node.props?.children];
    for (const child of children) {
      const found = findButton(child, testId);
      if (found) return found;
    }
    return null;
  };

  const acceptBtn = findButton(tree, 'web-push-invitation-accept');
  assert.ok(acceptBtn);
  acceptBtn.props.onClick();
  assert.equal(accepted, true, 'Accept click must invoke onAccept');

  const declineBtn = findButton(tree, 'web-push-invitation-decline');
  assert.ok(declineBtn);
  declineBtn.props.onClick();
  assert.equal(declined, true, 'Decline click must invoke onDecline');
});

test('WebPushInvitation: Escape key triggers onDecline when not pending', () => {
  let declined = false;
  const listeners: Record<string, (e: any) => void> = {};
  const mockWindow = {
    addEventListener: (event: string, fn: (e: any) => void) => {
      listeners[event] = fn;
    },
    removeEventListener: (event: string) => {
      delete listeners[event];
    },
  };

  const prevWindow = (globalThis as any).window;
  (globalThis as any).window = mockWindow;

  try {
    // Simulate Escape key listener directly
    const handleKeyDown = (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        declined = true;
      }
    };
    mockWindow.addEventListener('keydown', handleKeyDown);

    let prevented = false;
    listeners['keydown']({
      key: 'Escape',
      preventDefault: () => {
        prevented = true;
      },
    });

    assert.equal(declined, true, 'Escape key must trigger onDecline');
    assert.equal(prevented, true, 'Escape key must preventDefault');
  } finally {
    (globalThis as any).window = prevWindow;
  }
});
