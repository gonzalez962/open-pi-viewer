import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  decideCommandDispatch,
  matchCommands,
  movePaletteSelection,
  parseCommandInput,
  shouldShowPaletteQuery,
  type CommandSpec,
} from '@core/commands';

test('commands: registry catalog lists exactly the retained commands with required fields', () => {
  assert.deepEqual(
    COMMANDS.map((c) => c.name).sort(),
    ['/clear', '/compact', '/export', '/help', '/judgment-day', '/new', '/reload', '/zen'].sort()
  );

  for (const cmd of COMMANDS) {
    assert.ok(cmd.id, `command missing id: ${JSON.stringify(cmd)}`);
    assert.ok(cmd.name.startsWith('/'), `name must start with '/': ${cmd.name}`);
    assert.ok(cmd.description.es, `missing es description: ${cmd.name}`);
    assert.ok(cmd.description.en, `missing en description: ${cmd.name}`);
    assert.ok(
      cmd.execution === 'client' || cmd.execution === 'agent',
      `invalid execution mode: ${cmd.name}`
    );
    assert.ok(
      cmd.origin === 'gentle-ai' || cmd.origin === 'gentle-shell' || cmd.origin === 'pi-core',
      `invalid origin: ${cmd.name}`
    );
  }

  // Unique ids and names
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command ids found');
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'duplicate command names found');
});

test('commands: retained commands keep their origin, execution mode and aliases', () => {
  const byName = (name: string): CommandSpec | undefined =>
    COMMANDS.find((c) => c.name === name);

  assert.equal(byName('/judgment-day')?.origin, 'gentle-ai');
  assert.equal(byName('/judgment-day')?.execution, 'agent');
  assert.ok(byName('/judgment-day')?.aliases?.includes('/juzgar'));

  assert.equal(byName('/help')?.origin, 'pi-core');
  assert.equal(byName('/help')?.execution, 'client');
  assert.equal(byName('/export')?.origin, 'pi-core');
  assert.equal(byName('/export')?.execution, 'client');
  assert.equal(byName('/export')?.argumentHint, '[md|json]');
  assert.equal(byName('/clear')?.execution, 'client');
  assert.equal(byName('/new')?.execution, 'client');
  assert.ok(byName('/new')?.aliases?.includes('/reset'));
  assert.equal(byName('/reload')?.execution, 'client');
  assert.equal(byName('/compact')?.execution, 'agent');
  assert.equal(byName('/zen')?.origin, 'pi-core');
  assert.equal(byName('/zen')?.execution, 'client');
  assert.ok(byName('/zen')?.aliases?.includes('/focus'));
});

test('commands: removed commands are no longer in the catalog', () => {
  for (const removed of ['/sdd-init', '/cc', '/ci', '/theme', '/model', '/mcp', '/settings', '/btw']) {
    assert.equal(
      COMMANDS.some((c) => c.name === removed),
      false,
      `${removed} should have been removed from the catalog`
    );
  }
});

test('parseCommandInput: returns null when text does not start with "/"', () => {
  assert.equal(parseCommandInput(''), null);
  assert.equal(parseCommandInput('hello world'), null);
  assert.equal(parseCommandInput('  /clear'), null); // leading whitespace disqualifies
});

test('parseCommandInput: splits the leading command token from trailing args', () => {
  assert.deepEqual(parseCommandInput('/clear'), { command: '/clear', args: '' });
  assert.deepEqual(parseCommandInput('/compact all'), { command: '/compact', args: 'all' });
  assert.deepEqual(parseCommandInput('/judgment-day   src'), { command: '/judgment-day', args: 'src' });
  assert.deepEqual(
    parseCommandInput('/judgment-day   some longer argument   text'),
    { command: '/judgment-day', args: 'some longer argument   text' }
  );
  assert.deepEqual(parseCommandInput('/'), { command: '/', args: '' });
});

test('matchCommands: empty query after slash returns the full catalog', () => {
  const results = matchCommands('', COMMANDS);
  assert.equal(results.length, COMMANDS.length);
});

test('matchCommands: exact name match scores above prefix, alias, and substring matches', () => {
  const results = matchCommands('clear', COMMANDS);
  assert.equal(results[0].name, '/clear');
});

test('matchCommands: prefix match on name ranks above unrelated substring matches', () => {
  const results = matchCommands('re', COMMANDS);
  assert.ok(results.length > 0);
  // '/reload' is a name prefix match; '/new' only matches through its '/reset' alias.
  assert.equal(results[0].name, '/reload');
});

test('matchCommands: alias match finds a command by its alias token', () => {
  const results = matchCommands('juzgar', COMMANDS);
  assert.ok(results.some((c) => c.name === '/judgment-day'));
  assert.equal(results[0].name, '/judgment-day');
});

test('matchCommands: alias prefix ranks the aliased command highly', () => {
  const results = matchCommands('reset', COMMANDS);
  assert.equal(results[0].name, '/new');
});

test('matchCommands: substring match on description or name is still found but ranked lower', () => {
  const results = matchCommands('history', COMMANDS);
  const names = results.map((c) => c.name);
  assert.ok(names.includes('/compact'));
});

test('matchCommands: unknown query returns no matches', () => {
  const results = matchCommands('zzz-not-a-real-command-zzz', COMMANDS);
  assert.deepEqual(results, []);
});

test('matchCommands: accepts a query with a leading slash the same as without one', () => {
  const withSlash = matchCommands('/clear', COMMANDS);
  const withoutSlash = matchCommands('clear', COMMANDS);
  assert.deepEqual(withSlash.map((c) => c.id), withoutSlash.map((c) => c.id));
});

test('matchCommands: matches /export by exact name, prefix, and format keywords in description', () => {
  const exact = matchCommands('export', COMMANDS);
  assert.equal(exact[0].name, '/export');

  const prefix = matchCommands('/exp', COMMANDS);
  assert.equal(prefix[0].name, '/export');

  const byFormat = matchCommands('markdown', COMMANDS);
  assert.ok(byFormat.some((c) => c.name === '/export'));
});

test('shouldShowPaletteQuery: true while composing the command token, false once args start or text is not a command', () => {
  assert.equal(shouldShowPaletteQuery('/'), true);
  assert.equal(shouldShowPaletteQuery('/cl'), true);
  assert.equal(shouldShowPaletteQuery('/clear'), true);
  assert.equal(shouldShowPaletteQuery(''), false);
  assert.equal(shouldShowPaletteQuery('hello'), false);
  assert.equal(shouldShowPaletteQuery('/clear '), false); // whitespace = args started
  assert.equal(shouldShowPaletteQuery('/compact all'), false);
  assert.equal(shouldShowPaletteQuery(' /clear'), false); // leading whitespace disqualifies
});

test('movePaletteSelection: wraps forward and backward around the list bounds', () => {
  assert.equal(movePaletteSelection(0, 1, 5), 1);
  assert.equal(movePaletteSelection(4, 1, 5), 0); // wraps forward past the end
  assert.equal(movePaletteSelection(0, -1, 5), 4); // wraps backward past the start
  assert.equal(movePaletteSelection(2, -1, 5), 1);
});

test('movePaletteSelection: returns 0 for an empty list instead of dividing by zero', () => {
  assert.equal(movePaletteSelection(0, 1, 0), 0);
  assert.equal(movePaletteSelection(3, -1, 0), 0);
});

test('decideCommandDispatch: plain text (no leading slash) is not a command', () => {
  const decision = decideCommandDispatch('hello world');
  assert.equal(decision.kind, 'not-a-command');
  assert.equal(decision.command, null);
});

test('decideCommandDispatch: a known client command resolves to kind "client" with parsed args', () => {
  const decision = decideCommandDispatch('/help me');
  assert.equal(decision.kind, 'client');
  assert.equal(decision.command?.name, '/help');
  assert.equal(decision.args, 'me');
});

test('decideCommandDispatch: command matching is case-insensitive', () => {
  const decision = decideCommandDispatch('/CLEAR');
  assert.equal(decision.kind, 'client');
  assert.equal(decision.command?.name, '/clear');
});

test('decideCommandDispatch: resolves an alias to its canonical command', () => {
  const decision = decideCommandDispatch('/reset');
  assert.equal(decision.kind, 'client');
  assert.equal(decision.command?.name, '/new');
});

test('decideCommandDispatch: a known agent command resolves to kind "agent"', () => {
  const decision = decideCommandDispatch('/judgment-day');
  assert.equal(decision.kind, 'agent');
  assert.equal(decision.command?.name, '/judgment-day');
});

test('decideCommandDispatch: a removed catalog command (e.g. "/sdd-apply") is still forwarded to the agent verbatim', () => {
  const decision = decideCommandDispatch('/sdd-apply do it');
  assert.equal(decision.kind, 'agent');
  assert.equal(decision.command, null);
  assert.equal(decision.args, 'do it');
});

test('decideCommandDispatch: an unrecognized "/xxx" command is forwarded to the agent unchanged', () => {
  const decision = decideCommandDispatch('/totally-unknown-command foo bar');
  assert.equal(decision.kind, 'agent');
  assert.equal(decision.command, null);
  assert.equal(decision.args, 'foo bar');
});

test('decideCommandDispatch: /export resolves as client command preserving arguments for handler', () => {
  const bare = decideCommandDispatch('/export');
  assert.equal(bare.kind, 'client');
  assert.equal(bare.command?.name, '/export');
  assert.equal(bare.args, '');

  const withMd = decideCommandDispatch('/export md');
  assert.equal(withMd.kind, 'client');
  assert.equal(withMd.command?.name, '/export');
  assert.equal(withMd.args, 'md');

  const withJson = decideCommandDispatch('/export json');
  assert.equal(withJson.kind, 'client');
  assert.equal(withJson.command?.name, '/export');
  assert.equal(withJson.args, 'json');

  const withWhitespace = decideCommandDispatch('/export   json   ');
  assert.equal(withWhitespace.kind, 'client');
  assert.equal(withWhitespace.command?.name, '/export');
  assert.equal(withWhitespace.args, 'json');

  const caseInsensitive = decideCommandDispatch('/EXPORT md');
  assert.equal(caseInsensitive.kind, 'client');
  assert.equal(caseInsensitive.command?.name, '/export');
  assert.equal(caseInsensitive.args, 'md');
});
