import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationDelivery, isNativeNotificationHost } from '@infra/notification-delivery';

 test('standalone web and web IPC shim are not native notification hosts', () => {
  assert.equal(isNativeNotificationHost(undefined), false);
  assert.equal(isNativeNotificationHost({}), false);
  assert.equal(isNativeNotificationHost({ __TAURI_INTERNALS__: {}, __IS_WEB_IPC__: true }), false);
  assert.equal(isNativeNotificationHost({ __TAURI_INTERNALS__: { __isWebIpc: true } }), false);
  assert.equal(isNativeNotificationHost({ __TAURI_INTERNALS__: {} }), true);
});

test('web shim selects browser delivery even when Tauri internals exist', async () => {
  let nativeLoads = 0;
  let requests = 0;
  const sent: unknown[] = [];
  const adapter = createNotificationDelivery({
    native: false,
    browser: { permission: () => 'granted', request: async () => { requests++; return 'granted'; }, send: options => { sent.push(options); } },
    loadNative: async () => { nativeLoads++; throw new Error('Must not load native plugin'); },
  });
  assert.equal(await adapter.permission(), 'granted');
  assert.equal(await adapter.send({ title: 'Complete', body: 'Task complete' }), true);
  assert.equal(requests, 0);
  assert.equal(nativeLoads, 0);
  assert.equal(sent.length, 1);
});

test('native adapter uses plugin rather than browser and requests only explicitly', async () => {
  let granted = false;
  let requests = 0;
  const sent: unknown[] = [];
  const adapter = createNotificationDelivery({ native: true, loadNative: async () => ({
    isPermissionGranted: async () => granted,
    requestPermission: async () => { requests++; granted = true; return 'granted'; },
    sendNotification: options => { sent.push(options); },
  }) });
  assert.equal(await adapter.permission(), 'default');
  assert.equal(await adapter.send({ title: 'Complete', body: 'Task complete' }), false);
  assert.equal(requests, 0);
  assert.equal(await adapter.requestPermission(), 'granted');
  assert.equal(await adapter.send({ title: 'Complete', body: 'Task complete' }), true);
  assert.equal(requests, 1);
  assert.deepEqual(sent, [{ title: 'Complete', body: 'Task complete' }]);
});

test('unsupported, denied and failing providers never report successful delivery', async () => {
  const unavailable = createNotificationDelivery({ native: false });
  assert.equal(await unavailable.permission(), 'unavailable');
  assert.equal(await unavailable.requestPermission(), 'unavailable');
  assert.equal(await unavailable.send({ title: 'Test', body: 'Test' }), false);
  let requests = 0;
  const denied = createNotificationDelivery({ native: false, browser: {
    permission: () => 'denied', request: async () => { requests++; return 'denied'; }, send: () => { throw new Error('Denied'); },
  } });
  assert.equal(await denied.permission(), 'denied');
  assert.equal(await denied.send({ title: 'Test', body: 'Test' }), false);
  assert.equal(requests, 0);
  const failing = createNotificationDelivery({ native: true, loadNative: async () => { throw new Error('Plugin unavailable'); } });
  assert.equal(await failing.permission(), 'unavailable');
  assert.equal(await failing.send({ title: 'Test', body: 'Test' }), false);
});
