import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBaseBinaryPaths } from '@features/settings/reset-binary-paths';
import type { DiscoveredEnvironment } from '@infra/bridge';

const discovered: DiscoveredEnvironment = {
  status: 'ready', nodePath: '/usr/bin/node',
  entrypoint: { status: 'discovered', path: '/opt/pi/cli.js', candidates: ['/opt/pi/cli.js'] },
  initialDirectory: { status: 'discovered', path: '/different/project' }, issues: [],
};

test('base binary reset bypasses saved entrypoint and returns only binary paths', async () => {
  const draft = { nodePath: '/old/node', piEntrypoint: '/old/shell.js', workingDirectory: '/keep/project', fileTreeRefreshInterval: 30 };
  const paths = await discoverBaseBinaryPaths(draft.workingDirectory, async payload => {
    assert.deepEqual(payload, { preferredEntrypoint: null, preferredCwd: '/keep/project' });
    return discovered;
  });
  assert.deepEqual(paths, { nodePath: '/usr/bin/node', piEntrypoint: '/opt/pi/cli.js' });
  assert.deepEqual({ ...draft, ...paths }, { ...draft, nodePath: '/usr/bin/node', piEntrypoint: '/opt/pi/cli.js' });
  assert.equal(draft.nodePath, '/old/node');
});

for (const status of ['missing', 'ambiguous'] as const) {
  test(`base binary reset refuses ${status} entrypoint without returning partial paths`, async () => {
    await assert.rejects(() => discoverBaseBinaryPaths('/keep/project', async () => ({
      ...discovered, entrypoint: { status, path: null, candidates: ['/one/cli.js', '/two/cli.js'], message: 'Select a Pi installation' },
    })), /Select a Pi installation/);
  });
}

test('base binary reset rejects missing Node and missing entrypoint path', async () => {
  for (const result of [{ ...discovered, nodePath: null }, { ...discovered, entrypoint: { ...discovered.entrypoint, path: null } }]) {
    await assert.rejects(() => discoverBaseBinaryPaths('/keep/project', async () => result));
  }
});

test('base binary reset propagates discovery failures without modifying configuration', async () => {
  await assert.rejects(() => discoverBaseBinaryPaths('/keep/project', async () => { throw new Error('Discovery unavailable'); }), /Discovery unavailable/);
});
