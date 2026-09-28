import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  buildCommandCatalog,
  decideCommandDispatch,
  filterVisibleCommands,
  pruneHiddenCommandIds,
  sanitizeHiddenCommandIds,
  toggleHiddenCommandId,
  type CustomCommand,
} from '@core/commands';

const deploy: CustomCommand = {
  id: 'custom:deploy',
  name: '/deploy',
  description: 'Deploys the current branch.',
};

test('filterVisibleCommands: drops hidden built-in and custom commands, keeping order', () => {
  const catalog = buildCommandCatalog([deploy]);
  const visible = filterVisibleCommands(catalog, ['help', 'custom:deploy']);
  assert.deepEqual(
    visible.map((c) => c.id),
    catalog.filter((c) => c.id !== 'help' && c.id !== 'custom:deploy').map((c) => c.id)
  );
});

test('filterVisibleCommands: returns the full catalog when nothing is hidden', () => {
  const catalog = buildCommandCatalog([deploy]);
  assert.deepEqual(filterVisibleCommands(catalog, []), catalog);
  assert.deepEqual(filterVisibleCommands(catalog, ['unknown-id']), catalog);
});

test('hiding is purely visual: dispatch against the full catalog is unchanged', () => {
  const catalog = buildCommandCatalog([deploy]);
  // The app keeps dispatching against the full catalog, so hidden commands still resolve.
  assert.equal(decideCommandDispatch('/help', catalog).kind, 'client');
  assert.equal(decideCommandDispatch('/deploy now', catalog).kind, 'agent');
  assert.equal(filterVisibleCommands(catalog, ['help']).some((c) => c.id === 'help'), false);
});

test('sanitizeHiddenCommandIds: non-array -> [], drops non-strings and blanks, dedupes', () => {
  assert.deepEqual(sanitizeHiddenCommandIds('help'), []);
  assert.deepEqual(sanitizeHiddenCommandIds(null), []);
  assert.deepEqual(sanitizeHiddenCommandIds(undefined), []);
  assert.deepEqual(
    sanitizeHiddenCommandIds(['help', 42, '', '  ', 'help', 'custom:deploy', null]),
    ['help', 'custom:deploy']
  );
});

test('toggleHiddenCommandId: adds a missing id and removes a present one', () => {
  assert.deepEqual(toggleHiddenCommandId([], 'help'), ['help']);
  assert.deepEqual(toggleHiddenCommandId(['help', 'new'], 'help'), ['new']);
});

test('pruneHiddenCommandIds: drops ids of deleted custom commands, keeps built-ins', () => {
  assert.deepEqual(
    pruneHiddenCommandIds(['help', 'custom:deploy', 'custom:gone'], [deploy]),
    ['help', 'custom:deploy']
  );
  assert.deepEqual(pruneHiddenCommandIds(['custom:deploy'], []), []);
  // Built-in ids are never pruned, even when not in the catalog snapshot.
  assert.ok(COMMANDS.some((c) => c.id === 'help'));
});
