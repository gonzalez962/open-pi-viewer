import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebPushController,
} from '@features/settings/hooks/useWebPush';
import type { NotificationPreferences } from '@core/notifications';
import { WEB_AUTH_READY_EVENT } from '@infra/web-auth';
import type { WebPushEnvironment, WebPushProject } from '@infra/web-push';

const SAMPLE_PREFERENCES: NotificationPreferences = {
  enabled: true,
  sound: true,
  suppressWhenFocused: true,
  onTaskComplete: true,
  onWaitingInput: true,
};

const SAMPLE_PROJECTS: WebPushProject[] = [
  { path: '/repos/gentle-pi', customName: 'Gentle Pi' },
];

function createMockEnv(overrides: Partial<WebPushEnvironment> = {}) {
  let permission: NotificationPermission = 'default';
  let isUnsubscribed = false;

  const mockSub = {
    endpoint: 'https://push.example.com/sub/device-1',
    toJSON: () => ({
      endpoint: 'https://push.example.com/sub/device-1',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    }),
    unsubscribe: async () => {
      isUnsubscribed = true;
      return true;
    },
  };

  const calls = {
    permissionRequests: 0,
    swRegistrations: 0,
    pushSubscribes: 0,
    postSubscriptions: 0,
    deleteSubscriptions: 0,
  };

  const env: WebPushEnvironment = {
    isNativeHost: false,
    windowObj: {
      isSecureContext: true,
      Notification: {
        get permission() {
          return permission;
        },
        requestPermission: async () => {
          calls.permissionRequests++;
          permission = 'granted';
          return 'granted';
        },
      },
      PushManager: class PushManager {},
    },
    navigatorObj: {
      serviceWorker: {
        register: async () => {
          calls.swRegistrations++;
          return {
            pushManager: {
              getSubscription: async () => isUnsubscribed ? null : mockSub,
              subscribe: async () => {
                calls.pushSubscribes++;
                isUnsubscribed = false;
                return mockSub;
              },
            },
          } as any;
        },
        getRegistration: async () => {
          return {
            pushManager: {
              getSubscription: async () => isUnsubscribed ? null : mockSub,
              subscribe: async () => {
                calls.pushSubscribes++;
                isUnsubscribed = false;
                return mockSub;
              },
            },
          } as any;
        },
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => isUnsubscribed ? null : mockSub,
            subscribe: async () => {
              calls.pushSubscribes++;
              isUnsubscribed = false;
              return mockSub;
            },
          },
        } as any),
      },
    },
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/push/config') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            available: true,
            publicKey: 'VAPID_PUBLIC_KEY',
          }),
        } as any;
      }
      if (url === '/api/push/subscriptions') {
        if (init?.method === 'DELETE') {
          calls.deleteSubscriptions++;
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
        }
        calls.postSubscriptions++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: false, status: 404 } as any;
    },
    ...overrides,
  };

  return {
    env,
    calls,
    setPermission: (p: NotificationPermission) => {
      permission = p;
    },
    setUnsubscribed: (val: boolean) => {
      isUnsubscribed = val;
    },
  };
}

class SimpleEventTarget {
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const h of handlers) {
        h(event);
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// 1. Controller Initial State and Mount Sync (No Prompt)
// ---------------------------------------------------------------------------

test('controller: mount sync does NOT prompt permission when permission is default', async () => {
  const { env, calls } = createMockEnv();
  const target = new SimpleEventTarget();

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
    eventTarget: target as any,
  });

  await controller.init();

  assert.equal(calls.permissionRequests, 0, 'Must not prompt permission on init');
  assert.equal(calls.pushSubscribes, 0, 'Must not subscribe on init when permission default');
  assert.equal(controller.getStatus(), 'unsubscribed');
});

test('controller: mount sync updates registration when permission was already granted', async () => {
  const { env, calls, setPermission } = createMockEnv();
  setPermission('granted');
  const target = new SimpleEventTarget();

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
    eventTarget: target as any,
  });

  await controller.init();

  assert.equal(calls.permissionRequests, 0, 'Must not prompt permission');
  assert.equal(calls.postSubscriptions, 1, 'Must sync existing subscription with server');
  assert.equal(controller.getStatus(), 'subscribed');
});

// ---------------------------------------------------------------------------
// 2. Auth-ready event re-syncs
// ---------------------------------------------------------------------------

test('controller: WEB_AUTH_READY_EVENT re-syncs existing subscription to new auth session', async () => {
  const { env, calls, setPermission } = createMockEnv();
  setPermission('granted');
  const target = new SimpleEventTarget();

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
    eventTarget: target as any,
  });

  await controller.init();
  assert.equal(calls.postSubscriptions, 1);

  // Trigger web auth ready event (e.g. after user logged in again)
  target.dispatchEvent(new Event(WEB_AUTH_READY_EVENT));
  // Wait a microtask tick
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(calls.postSubscriptions, 2, 'Must re-sync subscription under new auth lease');
});

// ---------------------------------------------------------------------------
// 3. Explicit Enable distinguishes status
// ---------------------------------------------------------------------------

test('controller: enable() explicitly requests permission, registers, and marks subscribed', async () => {
  const { env, calls } = createMockEnv();
  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  const res = await controller.enable();

  assert.equal(res.ok, true);
  assert.equal(res.status, 'subscribed');
  assert.equal(controller.getStatus(), 'subscribed');
  assert.equal(calls.permissionRequests, 1);
  assert.equal(calls.swRegistrations, 1);
});

test('controller: enable() distinguishes unavailable from true success when server disabled', async () => {
  const { env } = createMockEnv({
    fetchFn: async (url: any) => {
      if (String(url) === '/api/push/config') {
        return { ok: true, status: 200, json: async () => ({ available: false }) } as any;
      }
      return { ok: true } as any;
    },
  });

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  const res = await controller.enable();

  assert.equal(res.ok, false);
  assert.equal(res.status, 'unavailable');
  assert.equal(controller.getStatus(), 'unavailable');
});

test('controller: enable() distinguishes denied status when permission is denied', async () => {
  const { env } = createMockEnv();
  (env.windowObj as any).Notification.requestPermission = async () => 'denied';

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  const res = await controller.enable();

  assert.equal(res.ok, false);
  assert.equal(res.status, 'denied');
  assert.equal(controller.getStatus(), 'denied');
});

// ---------------------------------------------------------------------------
// 4. Disable
// ---------------------------------------------------------------------------

test('controller: disable() calls unregister, deletes server endpoint, sets unsubscribed', async () => {
  const { env, calls, setPermission } = createMockEnv();
  setPermission('granted');

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  await controller.init();
  assert.equal(controller.getStatus(), 'subscribed');

  const res = await controller.disable();

  assert.equal(res.ok, true);
  assert.equal(res.status, 'unsubscribed');
  assert.equal(controller.getStatus(), 'unsubscribed');
  assert.equal(calls.deleteSubscriptions, 1);
});

// ---------------------------------------------------------------------------
// 5. Dynamic update on preferences/language/projects change
// ---------------------------------------------------------------------------

test('controller: updateProps re-syncs to server when subscribed, but ignores when unsubscribed', async () => {
  const { env, calls, setPermission } = createMockEnv();
  setPermission('granted');

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  await controller.init();
  assert.equal(calls.postSubscriptions, 1);

  // Updating props while subscribed triggers sync
  await controller.updateProps({
    preferences: { ...SAMPLE_PREFERENCES, sound: false },
    language: 'es',
    projects: SAMPLE_PROJECTS,
  });
  assert.equal(calls.postSubscriptions, 2);

  // Disable
  await controller.disable();
  const prevPosts = calls.postSubscriptions;

  // Updating props while unsubscribed does NOT trigger sync
  await controller.updateProps({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
  });
  assert.equal(calls.postSubscriptions, prevPosts, 'Must not post when unsubscribed');
});

test('controller: enable() snapshots enabled:true even if initial preferences was false', async () => {
  let postedPreferences: any = null;
  const { env } = createMockEnv({
    fetchFn: async (url: any, init?: any) => {
      if (String(url) === '/api/push/config') {
        return { ok: true, status: 200, json: async () => ({ available: true, publicKey: 'VAPID' }) } as any;
      }
      if (String(url) === '/api/push/subscriptions') {
        postedPreferences = JSON.parse(init?.body as string).preferences;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: false, status: 404 } as any;
    },
  });

  const controller = createWebPushController({
    preferences: { ...SAMPLE_PREFERENCES, enabled: false },
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  const res = await controller.enable();
  assert.equal(res.ok, true);
  assert.equal(postedPreferences?.enabled, true, 'Snapshot must ensure enabled:true');
});

test('controller: disposal prevents subsequent calls, and new controller instance works after disposal', async () => {
  const { env, setPermission } = createMockEnv();
  setPermission('granted');

  const ctrl1 = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  await ctrl1.init();
  assert.equal(ctrl1.getStatus(), 'subscribed');
  ctrl1.dispose();
  assert.equal(ctrl1.isDisposed(), true);

  // Calling enable on disposed controller returns error
  const resDisposed = await ctrl1.enable();
  assert.equal(resDisposed.ok, false);
  assert.equal(resDisposed.error, 'Controller disposed');

  // StrictMode remount: new controller instance initializes cleanly
  const ctrl2 = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  await ctrl2.init();
  assert.equal(ctrl2.getStatus(), 'subscribed');
  assert.equal(ctrl2.isDisposed(), false);
});

test('controller: updateProps during in-flight enable does not abort enable', async () => {
  const { env } = createMockEnv();
  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
  });

  const enablePromise = controller.enable();
  // While enable is in-flight, updateProps fires (as React re-renders)
  await controller.updateProps({
    preferences: { ...SAMPLE_PREFERENCES, enabled: true },
    language: 'en',
    projects: SAMPLE_PROJECTS,
  });

  const res = await enablePromise;
  assert.equal(res.ok, true, 'In-flight enable must succeed without being aborted');
  assert.equal(controller.getStatus(), 'subscribed');
});

// ---------------------------------------------------------------------------
// 6. Regression tests: B, C, and settlement
// ---------------------------------------------------------------------------

test('regression B: controller init preserves sync error status instead of rewriting to unsubscribed', async () => {
  const { env, setPermission } = createMockEnv({
    fetchFn: async (url: any) => {
      const urlStr = String(url);
      if (urlStr === '/api/push/config') {
        // Server config is available with valid VAPID key
        return {
          ok: true,
          status: 200,
          json: async () => ({ available: true, publicKey: 'VAPID_KEY' }),
        } as any;
      }
      if (urlStr === '/api/push/subscriptions') {
        // Sync endpoint fails on server with 500
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Database unavailable' }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    },
  });
  // Browser is already enrolled with granted permission and subscription
  setPermission('granted');

  let observedStatus: string | null = null;
  let observedError: string | null = null;

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
    onStatusChange: (s) => {
      observedStatus = s;
    },
    onError: (e) => {
      observedError = e;
    },
  });

  await controller.init();

  // Defect B: Previously, failure went to config fallback, which saw config available
  // and permission granted, and rewrote status to 'unsubscribed', falsely inviting enrolled browser!
  assert.equal(controller.getStatus(), 'error', 'Must preserve error status for enrolled sync failure');
  assert.equal(observedStatus, 'error', 'Must notify status change as error');
  assert.ok(observedError !== null, 'Must preserve sync error details');
  assert.notEqual(controller.getStatus(), 'unsubscribed', 'Must NOT rewrite enrolled browser to unsubscribed');
});

test('regression B: controller init preserves denied and unavailable results without rewriting to unsubscribed', async () => {
  // Case 1: Permission denied
  const { env: deniedEnv, setPermission } = createMockEnv();
  setPermission('denied');

  const controllerDenied = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: deniedEnv,
  });

  await controllerDenied.init();
  assert.equal(controllerDenied.getStatus(), 'denied', 'Must preserve denied status');

  // Case 2: Config unavailable for genuinely unsubscribed browser
  const { env: unavailEnv, setUnsubscribed } = createMockEnv({
    fetchFn: async (url: any) => {
      if (String(url) === '/api/push/config') {
        return { ok: true, status: 200, json: async () => ({ available: false }) } as any;
      }
      return { ok: true } as any;
    },
  });
  setUnsubscribed(true);

  const controllerUnavail = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: unavailEnv,
  });

  await controllerUnavail.init();
  assert.equal(controllerUnavail.getStatus(), 'unavailable', 'Must preserve unavailable status');
});

test('regression C: init catches unexpected exceptions safely, sets error, settles, and suppresses unhandled rejection', async () => {
  const throwingEnv: WebPushEnvironment = {
    isNativeHost: false,
    windowObj: {
      isSecureContext: true,
      Notification: {
        permission: 'granted',
        requestPermission: async () => 'granted',
      },
      PushManager: class PushManager {},
    },
    navigatorObj: {
      get serviceWorker(): any {
        throw new Error('Fatal ServiceWorker engine crash');
      },
    },
    fetchFn: async () => {
      throw new Error('Fatal network crash');
    },
  };

  let settledCalled = false;
  let statusReported: string | null = null;
  const errorReports: string[] = [];

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: throwingEnv,
    onStatusChange: (s) => {
      statusReported = s;
    },
    onError: (e) => {
      if (e) errorReports.push(e);
    },
    onSettled: () => {
      settledCalled = true;
    },
  });

  // Calling init() must NOT reject with an unhandled exception
  await assert.doesNotReject(
    async () => {
      await controller.init();
    },
    'init must catch and handle exceptions safely rather than rejecting'
  );

  // Defect C: Previously, exception bubbled past status setting, leaving status at default 'unsubscribed'!
  assert.equal(controller.isSettled(), true, 'Must settle despite exception');
  assert.equal(settledCalled, true, 'onSettled callback must fire');
  assert.equal(controller.getStatus(), 'error', 'Must set status to error, not default unsubscribed');
  assert.equal(statusReported, 'error', 'Status listener must receive error');
  assert.ok(
    errorReports.some((msg) => msg.includes('Fatal ServiceWorker engine crash')),
    'Error listener must receive failure message'
  );
});

test('regression C: disposed/aborted controller does not report live success after settlement', async () => {
  let resolveSync!: (val: any) => void;
  const syncDeferred = new Promise((resolve) => {
    resolveSync = resolve;
  });

  const { env, setPermission } = createMockEnv({
    fetchFn: async (url: any) => {
      if (String(url) === '/api/push/subscriptions') {
        await syncDeferred;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ available: true, publicKey: 'KEY' }) } as any;
    },
  });
  setPermission('granted');

  let statusChangeCount = 0;
  let lastStatus = '';
  let settledCalled = false;

  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
    onStatusChange: (s) => {
      statusChangeCount++;
      lastStatus = s;
    },
    onSettled: () => {
      settledCalled = true;
    },
  });

  // Start init in background
  const initPromise = controller.init();

  // Controller is disposed before sync completes (e.g. StrictMode unmount)
  controller.dispose();
  assert.equal(controller.isDisposed(), true);

  // Complete the underlying network sync operation
  resolveSync(true);
  await initPromise;

  // Disposed controller must NOT have reported live success ('subscribed')
  assert.notEqual(lastStatus, 'subscribed', 'Disposed controller must not report subscribed');
  assert.notEqual(controller.getStatus(), 'subscribed');
  assert.equal(statusChangeCount, 0);
  assert.equal(settledCalled, false);
});

test('settlement: isSettled state transitions deterministically via deferred promise without timers', async () => {
  let resolveConfig!: (val: any) => void;
  const configDeferred = new Promise((resolve) => {
    resolveConfig = resolve;
  });

  const { env, setUnsubscribed } = createMockEnv({
    fetchFn: async (url: any) => {
      if (String(url) === '/api/push/config') {
        await configDeferred;
        return {
          ok: true,
          status: 200,
          json: async () => ({ available: true, publicKey: 'VAPID' }),
        } as any;
      }
      return { ok: true } as any;
    },
  });
  setUnsubscribed(true);

  let settledFired = false;
  const controller = createWebPushController({
    preferences: SAMPLE_PREFERENCES,
    language: 'en',
    projects: SAMPLE_PROJECTS,
    dependencies: env,
    onSettled: () => {
      settledFired = true;
    },
  });

  // Prior to init completion, isSettled is false
  assert.equal(controller.isSettled(), false);
  assert.equal(settledFired, false);

  const initTask = controller.init();

  // In flight: still not settled
  assert.equal(controller.isSettled(), false);
  assert.equal(settledFired, false);

  // Resolve deferred promise
  resolveConfig(true);
  await initTask;

  // Deterministically settled without timer retries
  assert.equal(controller.isSettled(), true);
  assert.equal(settledFired, true);
});

