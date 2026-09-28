import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  buildCommandCatalog,
  customCommandToSpec,
  decideCommandDispatch,
  matchCommands,
  normalizeCommandName,
  parseAliasList,
  sanitizeCustomCommands,
  validateCustomCommandDraft,
  type CustomCommand,
} from '@core/commands';

const deploy: CustomCommand = {
  id: 'custom:deploy',
  name: '/deploy',
  description: 'Deploys the current branch.',
  aliases: ['/ship'],
};

test('custom commands: normalizeCommandName trims and auto-prefixes the leading slash', () => {
  assert.equal(normalizeCommandName('deploy'), '/deploy');
  assert.equal(normalizeCommandName('  /deploy  '), '/deploy');
  assert.equal(normalizeCommandName(''), '');
  assert.equal(normalizeCommandName('   '), '');
});

test('custom commands: parseAliasList splits comma-separated input and normalizes each alias', () => {
  assert.deepEqual(parseAliasList('ship, /release ,, '), ['/ship', '/release']);
  assert.deepEqual(parseAliasList(''), []);
});

test('custom commands: validateCustomCommandDraft accepts a valid draft and builds the command', () => {
  const result = validateCustomCommandDraft(
    { name: 'deploy', description: '  Deploys the current branch.  ', aliases: 'ship' },
    { builtIns: COMMANDS, existing: [] }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.command, deploy);
});

test('custom commands: validateCustomCommandDraft reports name errors', () => {
  const codes = (name: string) => {
    const r = validateCustomCommandDraft(
      { name, description: 'x', aliases: '' },
      { builtIns: COMMANDS, existing: [] }
    );
    return r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`);
  };
  assert.deepEqual(codes(''), ['name:required']);
  assert.deepEqual(codes('/'), ['name:required']);
  assert.deepEqual(codes('/my cmd'), ['name:whitespace']);
  assert.deepEqual(codes('/' + 'a'.repeat(64)), ['name:too_long']);
  // Case-insensitive clash with a built-in name and with a built-in alias.
  assert.deepEqual(codes('/HELP'), ['name:duplicate']);
  assert.deepEqual(codes('/reset'), ['name:duplicate']);
});

test('custom commands: validateCustomCommandDraft reports description and alias errors', () => {
  const r = validateCustomCommandDraft(
    { name: '/deploy', description: '   ', aliases: 'ship, juzgar, bad alias' },
    { builtIns: COMMANDS, existing: [] }
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(
    r.errors.map((e) => `${e.field}:${e.code}:${e.value ?? ''}`),
    ['description:required:', 'aliases:duplicate:/juzgar', 'aliases:whitespace:/bad alias']
  );
});

test('custom commands: alias equal to its own name or repeated is a duplicate', () => {
  const r = validateCustomCommandDraft(
    { name: '/deploy', description: 'd', aliases: 'deploy, ship, SHIP' },
    { builtIns: COMMANDS, existing: [] }
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(
    r.errors.map((e) => `${e.code}:${e.value}`),
    ['duplicate:/deploy', 'duplicate:/SHIP']
  );
});

test('custom commands: duplicates against other custom commands, but editing itself is allowed', () => {
  const clash = validateCustomCommandDraft(
    { name: '/SHIP', description: 'd', aliases: '' },
    { builtIns: COMMANDS, existing: [deploy] }
  );
  assert.equal(clash.ok, false);

  const edit = validateCustomCommandDraft(
    { name: '/deploy', description: 'New text', aliases: 'ship' },
    { builtIns: COMMANDS, existing: [deploy], editingId: deploy.id }
  );
  assert.equal(edit.ok, true);
});

test('custom commands: sanitizeCustomCommands drops malformed, invalid and conflicting entries', () => {
  const stored: unknown = [
    deploy,
    null,
    'nope',
    { id: 'x', name: 42, description: 'bad' },
    { id: 'custom:help', name: '/help', description: 'shadows a built-in' },
    { id: 'custom:ship2', name: '/ship', description: 'clashes with deploy alias' },
    { id: 'custom:lint', name: 'lint', description: ' Runs lint ', aliases: ['fmt', 7] },
    { id: 'custom:empty', name: '/empty', description: '' },
  ];
  const sanitized = sanitizeCustomCommands(stored, COMMANDS);
  assert.deepEqual(sanitized, [
    deploy,
    { id: 'custom:lint', name: '/lint', description: 'Runs lint', aliases: ['/fmt'] },
  ]);
  assert.deepEqual(sanitizeCustomCommands({ not: 'an array' }, COMMANDS), []);
  assert.deepEqual(sanitizeCustomCommands(undefined, COMMANDS), []);
});

test('custom commands: customCommandToSpec maps to an agent command with the custom origin', () => {
  const spec = customCommandToSpec(deploy);
  assert.equal(spec.origin, 'custom');
  assert.equal(spec.execution, 'agent');
  assert.deepEqual(spec.description, {
    en: 'Deploys the current branch.',
    es: 'Deploys the current branch.',
  });
  assert.deepEqual(spec.aliases, ['/ship']);
});

test('custom commands: buildCommandCatalog appends customs after built-ins, built-ins win', () => {
  const shadow = { id: 'custom:clear', name: '/clear', description: 'evil' };
  const catalog = buildCommandCatalog([deploy, shadow], COMMANDS);
  assert.equal(catalog.length, COMMANDS.length + 1);
  assert.deepEqual(catalog.slice(0, COMMANDS.length), COMMANDS);
  assert.equal(catalog[catalog.length - 1].name, '/deploy');
  assert.equal(catalog.filter((c) => c.name === '/clear').length, 1);
  assert.equal(catalog.find((c) => c.name === '/clear')?.origin, 'pi-core');
  assert.deepEqual(buildCommandCatalog([]), COMMANDS);
});

test('custom commands: matcher and dispatcher use the merged catalog', () => {
  const catalog = buildCommandCatalog([deploy]);
  assert.equal(matchCommands('dep', catalog)[0].name, '/deploy');
  assert.equal(matchCommands('ship', catalog)[0].name, '/deploy');

  const decision = decideCommandDispatch('/ship now', catalog);
  assert.equal(decision.kind, 'agent');
  assert.equal(decision.command?.id, 'custom:deploy');
  assert.equal(decision.args, 'now');

  // Built-ins keep dispatching client-side with the merged catalog.
  assert.equal(decideCommandDispatch('/clear', catalog).kind, 'client');
});
