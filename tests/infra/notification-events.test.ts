import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';
import { notifyAppEvent, getNotificationPermission, requestNotificationPermission, showDesktopNotification } from '@infra/notifications';

test('web event delivery preserves focus/preferences, isolates sessions, and never prompts automatically', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  let requests = 0;
  const sent: Array<{ title: string; options: unknown }> = [];
  class MockNotification {
    static permission = 'granted';
    static async requestPermission() { requests++; return 'granted'; }
    constructor(title: string, options: unknown) { sent.push({ title, options }); }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true, __IS_WEB_IPC__: true, __TAURI_INTERNALS__: { __isWebIpc: true } } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: MockNotification });
  try {
    const base = { eventType: 'task_complete' as const, title: 'Task complete', body: 'Pi finished a task', preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, sound: false }, isWindowFocused: false, projectId: 'p' };
    notifyAppEvent({ ...base, sessionId: 'one' });
    notifyAppEvent({ ...base, sessionId: 'one' });
    notifyAppEvent({ ...base, sessionId: 'two' });
    notifyAppEvent({ ...base, sessionId: 'focused', isWindowFocused: true });
    notifyAppEvent({ ...base, sessionId: 'disabled', preferences: { ...base.preferences, enabled: false } });
    // Delivery is asynchronous but does not contact a backend or request permission.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].options, { body: 'Pi finished a task', silent: true });
    assert.equal(requests, 0);
    assert.equal(await getNotificationPermission(), 'granted');
    assert.equal(await requestNotificationPermission(), 'granted');
    assert.equal(requests, 0);
    assert.equal(await showDesktopNotification({ title: 'Test', body: 'Generic test' }), true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalNotification) Object.defineProperty(globalThis, 'Notification', originalNotification); else Reflect.deleteProperty(globalThis, 'Notification');
  }
});
