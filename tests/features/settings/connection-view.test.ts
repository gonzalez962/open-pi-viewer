import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsView } from '@features/settings/SettingsView';
import type { ConnectConfig } from '@core/types/connection';
import type { UiPreferences } from '@infra/preferences';
import { translate } from '@shared/i18n';
import { detectGentleShellPi } from '@infra/bridge';

const sampleConfig: ConnectConfig = {
  nodePath: 'node',
  piEntrypoint: 'C:\\pi\\dist\\cli.js',
  workingDirectory: 'C:\\projects\\demo',
  fileTreeRefreshInterval: 15,
};

const samplePreferences: UiPreferences = {
  theme: 'dark',
  language: 'en',
};

const t = (key: any, params?: any) => translate('en', key, params);

test('SettingsView: renders connection configuration inputs with draft values', () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /id="settings-node-path-input"/);
  assert.match(html, /value="node"/);
  assert.match(html, /id="settings-pi-entry-input"/);
  assert.match(html, /value="C:\\pi\\dist\\cli\.js"/);
  assert.match(html, /id="settings-cwd-input"/);
  assert.match(html, /value="C:\\projects\\demo"/);
  assert.match(html, /Save &amp; Apply/);
});

test('SettingsView: renders Gentle Mesh network connection fields when connectionType is mesh', () => {
  const meshConfig: ConnectConfig = {
    nodePath: '',
    piEntrypoint: '',
    workingDirectory: '/remote/workspace',
    connectionType: 'mesh',
    meshCoordinatorUrl: 'http://100.64.0.1:8080',
    meshToken: 'secret-token-xyz',
    fileTreeRefreshInterval: 15,
  };

  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: meshConfig,
      settingsDraft: meshConfig,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /id="settings-connection-type-select"/);
  assert.match(html, /id="settings-mesh-url-input"/);
  assert.match(html, /value="http:\/\/100\.64\.0\.1:8080"/);
  assert.match(html, /id="settings-mesh-token-input"/);
  assert.match(html, /value="secret-token-xyz"/);
  assert.match(html, /id="settings-cwd-input"/);
  assert.match(html, /value="\/remote\/workspace"/);
  // Ensure local subprocess inputs are omitted in mesh mode
  assert.doesNotMatch(html, /id="settings-node-path-input"/);
  assert.doesNotMatch(html, /id="settings-pi-entry-input"/);
});

test('SettingsView: renders Browse directory button for portable configuration', () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /Browse\.\.\./);
});

test('SettingsView: renders validation error banner when settingsError is present', () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: "Working directory must be an absolute path: 'relative/path'",
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /class="validation-error-banner"/);
  assert.match(html, /Working directory must be an absolute path/);
});

test('SettingsView: renders storage warning banner when settingsStorageNotice is present', () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: "Failed to save configuration to local storage",
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /class="storage-warning-banner"/);
  assert.match(html, /Failed to save configuration to local storage/);
});

test('SettingsView: renders unconfigured empty draft with placeholders intact and editable', () => {
  const emptyDraft: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
    fileTreeRefreshInterval: 15,
  };

  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: emptyDraft,
      settingsDraft: emptyDraft,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /placeholder="C:\\path\\to\\pi\\dist\\cli\.js"/);
  assert.match(html, /placeholder="C:\\path\\to\\project"/);
  assert.match(html, /value=""/);
});

test('SettingsView: renders Detect Gentle Shell button beside piEntrypoint input', () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: samplePreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /Detect Gentle Shell/);
  assert.match(html, /title="Detect configured Gentle Shell from gentle-pi package in Pi settings"/);
});

test('SettingsView: renders Detect Gentle Shell button in Spanish locale without English leak', () => {
  const tEs = (key: any, params?: any) => translate('es', key, params);
  const esPreferences: UiPreferences = {
    theme: 'dark',
    language: 'es',
  };

  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences: esPreferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      settingsError: null,
      settingsStorageNotice: null,
      isBusy: false,
      onSaveAndApply: () => {},
      onClose: () => {},
      t: tEs,
      loadCustomProviders: async () => [],
      renderProviders: () => null,
    })
  );

  assert.match(html, /Detectar Gentle Shell/);
  assert.match(html, /title="Detectar Gentle Shell configurado desde el paquete gentle-pi en los ajustes de Pi"/);
});

test('bridge: detectGentleShellPi returns safe missing in browser preview without invokeFn', async () => {
  const result = await detectGentleShellPi();
  assert.equal(result.status, 'missing');
  assert.equal(result.path, null);
  assert.deepEqual(result.candidates, []);
  assert.match(result.message || '', /Desktop runtime unavailable/);
});

test('bridge: detectGentleShellPi invokes detect_gentle_shell with payload and returns discovered result', async () => {
  let invokedCommand: string | null = null;
  let invokedPayload: any = null;

  const mockInvoke = async <T>(cmd: string, args?: any): Promise<T> => {
    invokedCommand = cmd;
    invokedPayload = args;
    return {
      status: 'discovered',
      path: 'C:\\test\\gentle-shell.mjs',
      entrypoint: 'C:\\test\\gentle-shell.mjs',
      candidates: ['C:\\test\\gentle-shell.mjs'],
      message: null,
    } as T;
  };

  const res = await detectGentleShellPi({ cwd: 'C:\\test\\workspace' }, mockInvoke);
  assert.equal(invokedCommand, 'detect_gentle_shell');
  assert.deepEqual(invokedPayload, { payload: { cwd: 'C:\\test\\workspace' } });
  assert.equal(res.status, 'discovered');
  assert.equal(res.path, 'C:\\test\\gentle-shell.mjs');
  assert.deepEqual(res.candidates, ['C:\\test\\gentle-shell.mjs']);
});

test('bridge: detectGentleShellPi handles ambiguous result with multiple candidates', async () => {
  const mockInvoke = async <T>(_cmd: string, _args?: any): Promise<T> => {
    return {
      status: 'ambiguous',
      path: null,
      entrypoint: null,
      candidates: ['/path1/gentle-shell.js', '/path2/gentle-shell.mjs'],
      message: 'Multiple gentle-pi packages configured',
    } as T;
  };

  const res = await detectGentleShellPi(undefined, mockInvoke);
  assert.equal(res.status, 'ambiguous');
  assert.equal(res.path, null);
  assert.equal(res.candidates.length, 2);
  assert.match(res.message || '', /Multiple gentle-pi packages/);
});

test('SettingsView: translates ambiguous detection result in Spanish with candidates list and no English leak', () => {
  const tEs = (key: any, params?: any) => translate('es', key, params);
  const candidates = '/test/pkg1/gentle-shell.mjs, /test/pkg2/gentle-shell.mjs';
  const translated = tEs('settings.detect_gentle_shell_ambiguous', { candidates });

  assert.match(translated, /Se encontraron múltiples paquetes gentle-pi/);
  assert.match(translated, /\/test\/pkg1\/gentle-shell\.mjs/);
  assert.doesNotMatch(translated, /Multiple gentle-pi packages configured/i);
});

test('SettingsView: translates missing detection result in Spanish without English leak', () => {
  const tEs = (key: any, params?: any) => translate('es', key, params);
  const translated = tEs('settings.detect_gentle_shell_missing');

  assert.match(translated, /No se encontró el paquete gentle-pi/);
  assert.doesNotMatch(translated, /not configured in Pi settings/i);
});
