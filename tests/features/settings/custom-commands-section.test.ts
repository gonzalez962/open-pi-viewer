import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsView } from '@features/settings/SettingsView';
import {
  CustomCommandsSection,
  formatCustomCommandError,
} from '@features/settings/components/CustomCommandsSection';
import { COMMANDS, type CustomCommand } from '@core/commands';
import type { ConnectConfig } from '@core/types/connection';
import type { UiPreferences } from '@infra/preferences';
import { translate } from '@shared/i18n';

const t = (key: any, params?: any) => translate('en', key, params);

const deploy: CustomCommand = {
  id: 'custom:deploy',
  name: '/deploy',
  description: 'Deploys the current branch.',
  aliases: ['/ship', '/release'],
};

const sampleConfig: ConnectConfig = {
  nodePath: 'node',
  piEntrypoint: 'C:\\pi\\dist\\cli.js',
  workingDirectory: 'C:\\projects\\demo',
  fileTreeRefreshInterval: 15,
};

test('CustomCommandsSection: lists custom commands with delete/edit buttons and the add form', () => {
  const html = renderToStaticMarkup(
    React.createElement(CustomCommandsSection, {
      customCommands: [deploy],
      builtInCommands: COMMANDS,
      hiddenCommandIds: [],
      language: 'en',
      onChange: () => {},
      onHiddenCommandIdsChange: () => {},
      defaultExpanded: true,
      t,
    })
  );

  assert.match(html, /Commands/);
  assert.match(html, /\/deploy/);
  assert.match(html, /Deploys the current branch\./);
  assert.match(html, /Aliases: \/ship, \/release/);
  assert.match(html, /aria-label="Delete \/deploy"/);
  assert.match(html, /aria-label="Edit \/deploy"/);

  // Labelled form inputs.
  assert.match(html, /<label[^>]*for="custom-command-name-input"/);
  assert.match(html, /id="custom-command-name-input"/);
  assert.match(html, /<label[^>]*for="custom-command-description-input"/);
  assert.match(html, /<label[^>]*for="custom-command-aliases-input"/);
  assert.match(html, /Add command/);

  // Built-ins are shown read-only for reference.
  assert.match(html, /Built-in commands/);
  assert.match(html, /\/judgment-day/);
});

test('CustomCommandsSection: shows the empty state when no custom commands exist', () => {
  const html = renderToStaticMarkup(
    React.createElement(CustomCommandsSection, {
      customCommands: [],
      builtInCommands: COMMANDS,
      hiddenCommandIds: [],
      language: 'en',
      onChange: () => {},
      onHiddenCommandIdsChange: () => {},
      defaultExpanded: true,
      t,
    })
  );
  assert.match(html, /No custom commands registered yet\./);
});

test('formatCustomCommandError: maps validator errors to localized messages', () => {
  assert.equal(
    formatCustomCommandError({ field: 'name', code: 'duplicate' }, t),
    'This name is already used by another command or alias.'
  );
  assert.equal(
    formatCustomCommandError({ field: 'aliases', code: 'whitespace', value: '/a b' }, t),
    'Alias "/a b" cannot contain spaces.'
  );
  assert.match(
    formatCustomCommandError({ field: 'name', code: 'too_long' }, t),
    /at most 64 characters/
  );
  const es = (key: any, params?: any) => translate('es', key, params);
  assert.equal(
    formatCustomCommandError({ field: 'description', code: 'required' }, es),
    'Ingresa una descripción.'
  );
});

test('SettingsView: renders the Commands section with stored custom commands', () => {
  const preferences: UiPreferences = { theme: 'dark', language: 'en', customCommands: [deploy] };
  const html = renderToStaticMarkup(
    React.createElement(SettingsView, {
      config: sampleConfig,
      settingsDraft: sampleConfig,
      setSettingsDraft: () => {},
      preferences,
      onThemeChange: () => {},
      onLanguageChange: () => {},
      onCustomCommandsChange: () => {},
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
  // Lists are collapsed by default: the disclosure shows the count, not the entries.
  assert.match(html, /Your commands \(1\)/);
  assert.doesNotMatch(html, /Deploys the current branch\./);

  // The Commands section is the last section of the General tab.
  const commandsAt = html.indexOf('id="settings-commands-heading"');
  const fileTreeAt = html.indexOf('File Explorer');
  assert.ok(commandsAt > 0, 'commands section rendered');
  assert.ok(fileTreeAt > 0, 'file tree section rendered');
  assert.ok(commandsAt > fileTreeAt, 'commands section comes after every other section');
});

const baseProps = {
  customCommands: [deploy],
  builtInCommands: COMMANDS,
  hiddenCommandIds: [] as string[],
  language: 'en' as const,
  onChange: () => {},
  onHiddenCommandIdsChange: () => {},
  t,
};

test('CustomCommandsSection: both lists are collapsed by default and show their counts', () => {
  const html = renderToStaticMarkup(React.createElement(CustomCommandsSection, baseProps));
  assert.match(html, /Your commands \(1\)/);
  assert.ok(html.includes(`Built-in commands (${COMMANDS.length})`));
  const expanded = html.match(/aria-expanded="(true|false)"/g) ?? [];
  assert.deepEqual(expanded, ['aria-expanded="false"', 'aria-expanded="false"']);
  assert.match(html, /aria-controls="custom-commands-panel"/);
  assert.match(html, /aria-controls="builtin-commands-panel"/);
  // Entries, the add form and built-in rows stay out of the DOM while collapsed.
  assert.doesNotMatch(html, /Deploys the current branch\./);
  assert.doesNotMatch(html, /id="custom-command-name-input"/);
  assert.doesNotMatch(html, /\/judgment-day/);
});

test('CustomCommandsSection: every command has a Hide toggle with an accessible name', () => {
  const html = renderToStaticMarkup(
    React.createElement(CustomCommandsSection, { ...baseProps, defaultExpanded: true })
  );
  assert.match(html, /aria-label="Hide \/deploy from the palette and \/help"/);
  assert.match(html, /aria-label="Hide \/help from the palette and \/help"/);
  assert.doesNotMatch(html, /custom-command-item-hidden/);
});

test('CustomCommandsSection: hidden rows are dimmed, labelled Hidden and offer Show', () => {
  const html = renderToStaticMarkup(
    React.createElement(CustomCommandsSection, {
      ...baseProps,
      hiddenCommandIds: ['custom:deploy', 'help'],
      defaultExpanded: true,
    })
  );
  assert.equal((html.match(/custom-command-item-hidden/g) ?? []).length, 2);
  assert.match(html, /aria-label="Show \/deploy in the palette and \/help"/);
  assert.match(html, /aria-label="Show \/help in the palette and \/help"/);
  assert.match(html, />Hidden</);
  // Delete stays a separate action for the hidden custom command.
  assert.match(html, /aria-label="Delete \/deploy"/);
});

test('CustomCommandsSection: Spanish copy for the visibility toggle', () => {
  const es = (key: any, params?: any) => translate('es', key, params);
  const html = renderToStaticMarkup(
    React.createElement(CustomCommandsSection, {
      ...baseProps,
      language: 'es',
      t: es,
      hiddenCommandIds: ['help'],
      defaultExpanded: true,
    })
  );
  assert.match(html, /aria-label="Ocultar \/deploy de la paleta y de \/help"/);
  assert.match(html, /aria-label="Mostrar \/help en la paleta y en \/help"/);
  assert.match(html, />Oculto</);
});
