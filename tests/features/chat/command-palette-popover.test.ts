import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translate } from '@shared/i18n';
import { COMMANDS, buildCommandCatalog, matchCommands } from '@core/commands';
import { CommandPalettePopover } from '@features/chat/components/CommandPalettePopover';

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);

test('CommandPalettePopover: renders every matched command with its name and origin badge', () => {
  const commands = matchCommands('', COMMANDS);
  const markup = renderToStaticMarkup(
    React.createElement(CommandPalettePopover, {
      commands,
      selectedIndex: 0,
      onSelect: () => {},
      onHoverIndex: () => {},
      language: 'en',
      t,
    })
  );

  for (const cmd of commands) {
    assert.ok(markup.includes(cmd.name), `expected markup to include ${cmd.name}`);
  }
  assert.ok(markup.includes('Gentle AI / SDD'));
  assert.ok(markup.includes('Pi Native'));
});

test('CommandPalettePopover: marks the selected index with the "selected" class and aria-selected', () => {
  const commands = matchCommands('clear', COMMANDS);
  assert.ok(commands.length > 0);
  const markup = renderToStaticMarkup(
    React.createElement(CommandPalettePopover, {
      commands,
      selectedIndex: 0,
      onSelect: () => {},
      onHoverIndex: () => {},
      language: 'en',
      t,
    })
  );

  assert.ok(markup.includes('command-palette-item selected'));
  assert.ok(markup.includes('aria-selected="true"'));
});

test('CommandPalettePopover: shows the empty state when no commands match', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CommandPalettePopover, {
      commands: [],
      selectedIndex: 0,
      onSelect: () => {},
      onHoverIndex: () => {},
      language: 'en',
      t,
    })
  );

  assert.ok(markup.includes('No matching commands'));
});

test('CommandPalettePopover: renders the Spanish half of a command description when language is "es"', () => {
  const commands = matchCommands('clear', COMMANDS);
  const markup = renderToStaticMarkup(
    React.createElement(CommandPalettePopover, {
      commands,
      selectedIndex: 0,
      onSelect: () => {},
      onHoverIndex: () => {},
      language: 'es',
      t: (key, params) => translate('es', key, params),
    })
  );

  const clearCommand = commands.find((c) => c.name === '/clear');
  assert.ok(clearCommand);
  assert.ok(markup.includes(clearCommand!.description.es));
});

test('CommandPalettePopover: renders user-registered commands with the Custom badge', () => {
  const commands = matchCommands(
    'deploy',
    buildCommandCatalog([{ id: 'custom:deploy', name: '/deploy', description: 'Deploys it' }])
  );
  const render = (language: 'en' | 'es') =>
    renderToStaticMarkup(
      React.createElement(CommandPalettePopover, {
        commands,
        selectedIndex: 0,
        onSelect: () => {},
        onHoverIndex: () => {},
        language,
        t: (key: Parameters<typeof translate>[1]) => translate(language, key),
      })
    );

  const en = render('en');
  assert.ok(en.includes('/deploy'));
  assert.ok(en.includes('Deploys it'));
  assert.ok(en.includes('command-palette-origin-custom'));
  assert.ok(en.includes('>Custom<'));
  assert.ok(render('es').includes('>Personalizado<'));
});
