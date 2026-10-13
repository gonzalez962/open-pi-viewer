import test from 'node:test';
import assert from 'node:assert/strict';
import { unregisterWebPush } from '@infra/web-push';

test('native disable never queries service workers or sends browser API requests', async () => {
  let queries = 0;
  let requests = 0;
  const result = await unregisterWebPush(undefined, {
    isNativeHost: true,
    navigatorObj: { serviceWorker: {
      register: async () => { throw new Error('Native register must not run'); },
      getRegistration: async () => { queries++; throw new Error('Native lookup must not run'); },
      ready: Promise.resolve({} as ServiceWorkerRegistration),
    } },
    fetchFn: async () => { requests++; throw new Error('Native fetch must not run'); },
  });
  assert.deepEqual(result, { ok: true, status: 'unsubscribed' });
  assert.equal(queries, 0);
  assert.equal(requests, 0);
});
