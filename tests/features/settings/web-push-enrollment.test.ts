import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WebPushEnrollmentModal } from '@features/settings/components/WebPushEnrollmentModal';
import { SettingsView } from '@features/settings/SettingsView';
import { translate } from '@shared/i18n';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';

for (const locale of ['en', 'es'] as const) {
  test(`enrollment modal explains device scope and requires confirmation (${locale})`, () => {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const html = renderToStaticMarkup(React.createElement(WebPushEnrollmentModal, {
      isOpen: true, pending: false, error: null, onConfirm: () => {}, onCancel: () => {}, t,
    }));
    assert.match(html, /role="alertdialog"/);
    for (const key of ['settings.web_push_enroll_title', 'settings.web_push_enroll_message', 'settings.web_push_enroll_confirm'] as const) {
      assert.notEqual(t(key), key);
      assert.ok(html.includes(t(key).replace(/&/g, '&amp;').replace(/'/g, '&#x27;')));
    }
    const pending = renderToStaticMarkup(React.createElement(WebPushEnrollmentModal, {
      isOpen: true, pending: true, error: 'Enrollment failed', onConfirm: () => {}, onCancel: () => {}, t,
    }));
    assert.match(pending, /role="alert"/);
    assert.ok(pending.includes('Enrollment failed'));
    assert.equal((pending.match(/disabled=""/g) ?? []).length, 2);
  });
}

for (const enabled of [true, false]) {
for (const status of ['unsubscribed', 'subscribed', 'unsupported', 'unavailable', 'denied', 'error'] as const) {
  test(`settings push actions follow notification switch and enrollment (${status}, enabled=${enabled})`, () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
    const html = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: 'en', notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled } },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: status,
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: key => translate('en', key), loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    const button = html.match(/<button[^>]*data-testid="web-push-enroll"[^>]*>/)?.[0];
    if (status === 'unsupported' || status === 'subscribed' || !enabled) assert.equal(button, undefined);
    else {
      assert.ok(button);
      assert.equal(button.includes('disabled=""'), false);
    }
    const header = html.slice(html.indexOf('class="notifications-header-actions"'), html.indexOf('<p role="status"'));
    if (status !== 'subscribed') {
      assert.ok(!header.includes('data-testid="web-push-cancel"'));
      if (enabled && status !== 'unsupported') {
        assert.ok(header.includes('Activate WebPush'));
      }
    } else {
      const cancel = header.match(/<button[^>]*data-testid="web-push-cancel"[^>]*>/)?.[0];
      assert.ok(cancel);
      assert.equal(cancel.includes('disabled=""'), false);
      assert.ok(header.includes('Deactivate WebPush'));
    }
    assert.equal((html.match(/role="switch"/g) ?? []).length, 1);
  });
}
}

for (const fail of [false, true]) {
  test(`cancel push subscription preserves local notification preferences (failure=${fail})`, async () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
    const changes: unknown[] = [];
    const toggles: boolean[] = [];
    let settled!: () => void;
    const complete = new Promise<void>(resolve => { settled = resolve; });
    let tree: React.ReactNode;
    renderToStaticMarkup(React.createElement(() => {
      tree = SettingsView({
        config, settingsDraft: config, setSettingsDraft: () => {},
        preferences: { theme: 'dark', language: 'en', notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } },
        onThemeChange: () => {}, onLanguageChange: () => {},
        onNotificationsChange: change => { changes.push(change); },
        onSystemNotificationsToggle: async enabled => {
          toggles.push(enabled);
          settled();
          if (fail) throw new Error('Unsubscribe failed');
        },
        webPushStatus: 'subscribed', settingsError: null, settingsStorageNotice: null, isBusy: false,
        onSaveAndApply: () => {}, onClose: () => {}, t: key => translate('en', key),
        loadCustomProviders: async () => [], renderProviders: () => null,
      });
      return tree;
    }));
    const findCancel = (node: React.ReactNode): React.ReactElement<any> | undefined => {
      for (const child of React.Children.toArray(node)) {
        if (!React.isValidElement<any>(child)) continue;
        if (child.props['data-testid'] === 'web-push-cancel') return child;
        const found = findCancel(child.props.children);
        if (found) return found;
      }
    };
    const button = findCancel(tree!);
    assert.ok(button);
    button.props.onClick();
    await complete;
    await Promise.resolve();
    assert.deepEqual(toggles, [false]);
    assert.deepEqual(changes, [], 'push cancellation must not alter local notification preferences');
  });
}
