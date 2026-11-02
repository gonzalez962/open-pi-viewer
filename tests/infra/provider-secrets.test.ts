import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyProviderCredentials, discoverProviderModelsPi } from '@infra/bridge';

test('legacy provider cleanup waits for acknowledgement and preserves failed imports', async () => {
  const source = JSON.stringify({ providers: { p: { apiKey: 'legacy-fake' } } });
  let current: string | null = source;
  const storage = { getItem: () => current, removeItem: () => { current = null; } } as unknown as Storage;
  await migrateLegacyProviderCredentials(storage, async () => { throw Error('offline'); });
  assert.equal(current, source);
  await migrateLegacyProviderCredentials(storage, async () => ({ imported: true }) as any);
  assert.equal(current, null);
});

test('discovery routes provider id to backend without saved credentials', async () => {
  let call: unknown;
  const result = await discoverProviderModelsPi('p', undefined, async (cmd, args) => { call = [cmd, args]; return [{ id: 'm' }] as any; });
  assert.deepEqual(call, ['discover_provider_models', { providerId: 'p', apiKey: undefined }]);
  assert.deepEqual(result, [{ id: 'm' }]);
});
