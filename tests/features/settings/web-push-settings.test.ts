import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsView } from '@features/settings/SettingsView';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';
import { translate } from '@shared/i18n';

for (const locale of ['en', 'es'] as const) {
  test(`settings displays Web Push status without a second toggle (${locale})`, () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
    const html = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: locale, notifications: DEFAULT_NOTIFICATION_PREFERENCES },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: 'subscribed',
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: (key, params) => translate(locale, key, params),
      loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    const expected = translate(locale, 'settings.web_push_subscribed');
    assert.notEqual(expected, 'settings.web_push_subscribed');
    assert.ok(html.includes(expected));
    assert.equal((html.match(/role="switch"/g) ?? []).length, 1);
  });
}
