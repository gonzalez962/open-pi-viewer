import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WebPushEnrollmentModal } from '@features/settings/components/WebPushEnrollmentModal';
import { SettingsView } from '@features/settings/SettingsView';
import { translate } from '@shared/i18n';

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

for (const status of ['unsubscribed', 'subscribed', 'unsupported'] as const) {
  test(`settings browser registration action is independent of active switch (${status})`, () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
    const html = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: 'en' },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: status,
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: key => translate('en', key), loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    const button = html.match(/<button[^>]*data-testid="web-push-enroll"[^>]*>/)?.[0];
    if (status === 'unsupported') assert.equal(button, undefined);
    else { assert.ok(button); assert.equal(button.includes('disabled=""'), status === 'subscribed'); }
    assert.equal((html.match(/role="switch"/g) ?? []).length, 1);
  });
}
