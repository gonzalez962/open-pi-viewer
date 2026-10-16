import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsView } from '@features/settings/SettingsView';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';
import { translate, type TranslationKey } from '@shared/i18n';

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

  test(`settings suppresses unsubscribed status paragraph while preserving consent explanation (${locale})`, () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
    const html = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: locale, notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: 'unsubscribed',
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: (key, params) => translate(locale, key, params),
      loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    // Status text to remove: "Web Push is not registered on this device. Use Register this browser to enroll."
    assert.ok(!html.includes('Web Push is not registered on this device'));
    assert.ok(!html.includes('Web Push no está registrado en este dispositivo'));
    const unsubscribedText = translate(locale, 'settings.web_push_unsubscribed');
    assert.ok(!html.includes(unsubscribedText));

    // Consent explanation preserved
    const permissionHelp = translate(locale, 'settings.notifications_permission_help');
    assert.ok(html.includes(permissionHelp));
  });

  for (const status of ['denied', 'error', 'unsupported', 'unavailable'] as const) {
    test(`settings preserves diagnostic and error status paragraphs (${locale}, ${status})`, () => {
      const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
      const html = renderToStaticMarkup(React.createElement(SettingsView, {
        config, settingsDraft: config, setSettingsDraft: () => {},
        preferences: { theme: 'dark', language: locale, notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } },
        onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
        onSystemNotificationsToggle: async () => {}, webPushStatus: status,
        settingsError: null, settingsStorageNotice: null, isBusy: false,
        onSaveAndApply: () => {}, onClose: () => {},
        t: (key, params) => translate(locale, key, params),
        loadCustomProviders: async () => [], renderProviders: () => null,
      }));
      const diagnosticText = translate(locale, `settings.web_push_${status}`);
      assert.notEqual(diagnosticText, `settings.web_push_${status}`);
      assert.ok(html.includes(diagnosticText));
    });
  }

  test(`settings displays mutually exclusive Activate WebPush and Deactivate WebPush buttons (${locale})`, () => {
    const config = { nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' };
    const expectedActivate = locale === 'en' ? 'Activate WebPush' : 'Activar WebPush';
    const expectedDeactivate = locale === 'en' ? 'Deactivate WebPush' : 'Desactivar WebPush';

    // 1. Unenrolled + enabled -> shows Activate WebPush button, no Deactivate button
    const unenrolledHtml = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: locale, notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: 'unsubscribed',
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: (key, params) => translate(locale, key, params),
      loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    assert.ok(unenrolledHtml.includes('data-testid="web-push-enroll"'));
    assert.ok(unenrolledHtml.includes(expectedActivate));
    assert.ok(!unenrolledHtml.includes('data-testid="web-push-cancel"'));
    assert.ok(!unenrolledHtml.includes(expectedDeactivate));

    // 2. Enrolled -> shows Deactivate WebPush button, no Activate button
    const enrolledHtml = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: locale, notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: 'subscribed',
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: (key, params) => translate(locale, key, params),
      loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    assert.ok(enrolledHtml.includes('data-testid="web-push-cancel"'));
    assert.ok(enrolledHtml.includes(expectedDeactivate));
    assert.ok(!enrolledHtml.includes('data-testid="web-push-enroll"'));
    assert.ok(!enrolledHtml.includes(expectedActivate));

    // 3. Unenrolled + disabled notifications -> neither button is shown
    const disabledHtml = renderToStaticMarkup(React.createElement(SettingsView, {
      config, settingsDraft: config, setSettingsDraft: () => {},
      preferences: { theme: 'dark', language: locale, notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: false } },
      onThemeChange: () => {}, onLanguageChange: () => {}, onNotificationsChange: () => {},
      onSystemNotificationsToggle: async () => {}, webPushStatus: 'unsubscribed',
      settingsError: null, settingsStorageNotice: null, isBusy: false,
      onSaveAndApply: () => {}, onClose: () => {},
      t: (key, params) => translate(locale, key, params),
      loadCustomProviders: async () => [], renderProviders: () => null,
    }));
    assert.ok(!disabledHtml.includes('data-testid="web-push-enroll"'));
    assert.ok(!disabledHtml.includes('data-testid="web-push-cancel"'));
  });

  test(`startup invitation locale keys are defined for writer (${locale})`, () => {
    const expected: Record<TranslationKey, string> = locale === 'en' ? {
      'settings.web_push_invitation_title': 'Enable project push notifications?',
      'settings.web_push_invitation_message': 'Activate WebPush in this browser to receive project notifications while Pi Viewer is closed. You can deactivate it later in Settings.',
      'settings.web_push_invitation_accept': 'Accept',
      'settings.web_push_invitation_decline': 'Decline',
      'settings.web_push_invitation_pending': 'Activating…',
    } as const as Record<TranslationKey, string> : {
      'settings.web_push_invitation_title': '¿Activar notificaciones push de los proyectos?',
      'settings.web_push_invitation_message': 'Activa WebPush en este navegador para recibir avisos de los proyectos aunque Pi Viewer esté cerrado. Puedes desactivarlo después en Ajustes.',
      'settings.web_push_invitation_accept': 'Aceptar',
      'settings.web_push_invitation_decline': 'Declinar',
      'settings.web_push_invitation_pending': 'Activando…',
    } as const as Record<TranslationKey, string>;

    for (const [key, value] of Object.entries(expected) as [TranslationKey, string][]) {
      assert.equal(translate(locale, key), value);
    }
  });
}
