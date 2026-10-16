import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsView } from '@features/settings/SettingsView';
import { translate } from '@shared/i18n';

for (const locale of ['en', 'es'] as const) {
  for (const busy of [false, true]) {
    test(`binary path reset button is localized and safe (${locale}, busy=${busy})`, () => {
      const config = { nodePath: 'node', piEntrypoint: '/old/shell.js', workingDirectory: '/keep/project', fileTreeRefreshInterval: 30 };
      const html = renderToStaticMarkup(React.createElement(SettingsView, {
        config, settingsDraft: config, setSettingsDraft: () => {},
        preferences: { theme: 'dark', language: locale }, onThemeChange: () => {}, onLanguageChange: () => {},
        settingsError: null, settingsStorageNotice: null, isBusy: busy,
        onSaveAndApply: () => {}, onClose: () => {},
        t: (key, params) => translate(locale, key, params),
        loadCustomProviders: async () => [], renderProviders: () => null,
      }));
      const label = translate(locale, 'settings.reset_binary_paths');
      assert.notEqual(label, 'settings.reset_binary_paths');
      const button = html.match(/<button\b[^>]*>[^<]*<\/button>/g)?.find(value => value.includes(label));
      assert.ok(button);
      assert.match(button, /type="button"/);
      assert.equal(button.includes('disabled=""'), busy);
      assert.match(html, /value="\/keep\/project"/);
      assert.match(html, /value="\/old\/shell\.js"/);
    });
  }
}
