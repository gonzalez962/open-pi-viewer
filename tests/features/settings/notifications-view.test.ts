import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsView } from '@features/settings/SettingsView';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';
import { translate } from '@shared/i18n';

for (const enabled of [true, false]) {
  test(`notification settings use one switch and preserve the options list (enabled=${enabled})`, () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project', fileTreeRefreshInterval: 30 };
    const html = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: 'en', notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled } },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: (key, params) => translate('en', key, params),
      loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    assert.equal((html.match(/role="switch"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`role="switch"[^>]*aria-checked="${enabled}"`));
    assert.doesNotMatch(html, /id="settings-notifications-enable"/);
    const permissionLabel = translate('en', 'settings.notifications_request_permission');
    assert.match(html, new RegExp(`aria-label="${permissionLabel}"`));
    assert.ok(html.includes(`<span>${permissionLabel}</span>`));
    const testButton = html.match(/<button[^>]*title="Test notification"[^>]*>/)?.[0];
    assert.ok(testButton);
    assert.equal(testButton.includes('disabled=""'), !enabled);
    assert.doesNotMatch(html, new RegExp(`<button[^>]*>\\s*${permissionLabel}\\s*</button>`));
    for (const option of ['sound', 'suppress-focused', 'on-task-complete', 'on-waiting-input']) {
      const input = html.match(new RegExp(`<input[^>]*id="settings-notifications-${option}"[^>]*>`))?.[0];
      assert.ok(input);
      assert.equal(input.includes('disabled=""'), !enabled);
    }
  });
}
