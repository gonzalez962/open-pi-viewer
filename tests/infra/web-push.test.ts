import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebPushSupported,
  getWebPushConfig,
  registerWebPush,
  unregisterWebPush,
  syncExistingSubscription,
  revokePushOnLogout,
  urlBase64ToUint8Array,
  type WebPushEnvironment,
  type WebPushProject,
} from '@infra/web-push';
import type { NotificationPreferences } from '@core/notifications';

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

const SAMPLE_VAPID_PUBLIC_KEY = 'BC1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmn';

function createMockSubscription(endpoint = 'https://push.example.com/sub/123') {
  let unsubscribed = false;
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: {
        p256dh: 'mock-p256dh',
        auth: 'mock-auth',
      },
    }),
    unsubscribe: async () => {
      unsubscribed = true;
      return true;
    },
    isUnsubscribed: () => unsubscribed,
  };
}

function createMockEnv(overrides: Partial<WebPushEnvironment> = {}): {
  env: WebPushEnvironment;
  calls: {
    fetches: Array<{ url: string; options?: RequestInit }>;
    permissionRequests: number;
    swRegistrations: string[];
    pushSubscribes: number;
    pushUnsubscribes: number;
  };
  mockSub: ReturnType<typeof createMockSubscription>;
} {
  const calls = {
    fetches: [] as Array<{ url: string; options?: RequestInit }>,
    permissionRequests: 0,
    swRegistrations: [] as string[],
    pushSubscribes: 0,
    pushUnsubscribes: 0,
  };

  const mockSub = createMockSubscription();

  let permission: NotificationPermission = 'default';

  const defaultEnv: WebPushEnvironment = {
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
        register: async (scriptURL: string) => {
          calls.swRegistrations.push(scriptURL);
          return {
            pushManager: {
              getSubscription: async () => mockSub.isUnsubscribed() ? null : mockSub,
              subscribe: async () => {
                calls.pushSubscribes++;
                return mockSub;
              },
            },
          } as any;
        },
        getRegistration: async () => {
          return {
            pushManager: {
              getSubscription: async () => mockSub.isUnsubscribed() ? null : mockSub,
              subscribe: async () => {
                calls.pushSubscribes++;
                return mockSub;
              },
            },
          } as any;
        },
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => mockSub.isUnsubscribed() ? null : mockSub,
            subscribe: async () => {
              calls.pushSubscribes++;
              return mockSub;
            },
          },
        } as any),
      },
    },
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.fetches.push({ url, options: init });
      if (url === '/api/push/config') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            available: true,
            publicKey: SAMPLE_VAPID_PUBLIC_KEY,
            privateKey: 'SECRET_DO_NOT_LEAK', // tests that privateKey is discarded
          }),
        } as any;
      }
      if (url === '/api/push/subscriptions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    },
  };

  return {
    env: { ...defaultEnv, ...overrides },
    calls,
    mockSub,
  };
}

// ---------------------------------------------------------------------------
// 1. urlBase64ToUint8Array
// ---------------------------------------------------------------------------

test('urlBase64ToUint8Array: correctly converts url-safe base64 strings to Uint8Array', () => {
  const testBase64 = 'BMa_abc123-xyz';
  const u8 = urlBase64ToUint8Array(testBase64);
  assert.ok(u8 instanceof Uint8Array);
  assert.ok(u8.length > 0);
});

// ---------------------------------------------------------------------------
// 2. isWebPushSupported
// ---------------------------------------------------------------------------

test('isWebPushSupported: returns false when native host is detected', () => {
  const { env } = createMockEnv({ isNativeHost: true });
  assert.equal(isWebPushSupported(env), false);
});

test('isWebPushSupported: returns false in insecure context', () => {
  const { env } = createMockEnv();
  (env.windowObj as any).isSecureContext = false;
  assert.equal(isWebPushSupported(env), false);
});

test('isWebPushSupported: returns false when required APIs are missing', () => {
  const { env } = createMockEnv();
  // No PushManager
  (env.windowObj as any).PushManager = undefined;
  assert.equal(isWebPushSupported(env), false);

  // No serviceWorker
  (env.navigatorObj as any).serviceWorker = undefined;
  assert.equal(isWebPushSupported(env), false);

  // No Notification
  (env.windowObj as any).Notification = undefined;
  assert.equal(isWebPushSupported(env), false);
});

test('isWebPushSupported: returns true when all APIs and secure web context are present', () => {
  const { env } = createMockEnv();
  assert.equal(isWebPushSupported(env), true);
});

// ---------------------------------------------------------------------------
// 3. getWebPushConfig
// ---------------------------------------------------------------------------

test('getWebPushConfig: retrieves valid config and discards any leaked private keys', async () => {
  const { env, calls } = createMockEnv();
  const config = await getWebPushConfig({ fetchFn: env.fetchFn });

  assert.equal(config.available, true);
  assert.equal(config.publicKey, SAMPLE_VAPID_PUBLIC_KEY);
  assert.equal((config as any).privateKey, undefined);
  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.fetches[0].url, '/api/push/config');
  assert.equal(calls.fetches[0].options?.credentials, 'same-origin');
});

test('getWebPushConfig: returns available:false on HTTP error or network failure', async () => {
  const configFail = await getWebPushConfig({
    fetchFn: async () => ({ ok: false, status: 500 } as any),
  });
  assert.equal(configFail.available, false);
  assert.equal(configFail.publicKey, undefined);

  const configThrow = await getWebPushConfig({
    fetchFn: async () => {
      throw new Error('Network error');
    },
  });
  assert.equal(configThrow.available, false);
});

// ---------------------------------------------------------------------------
// 4. registerWebPush (Explicit Activation)
// ---------------------------------------------------------------------------

test('registerWebPush: returns unsupported when environment does not support push', async () => {
  const { env } = createMockEnv({ isNativeHost: true });
  const result = await registerWebPush(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
});

test('registerWebPush: returns unavailable when server push config is disabled/unavailable', async () => {
  const { env } = createMockEnv({
    fetchFn: async (url: any) => {
      if (String(url) === '/api/push/config') {
        return { ok: true, json: async () => ({ available: false }) } as any;
      }
      return { ok: true } as any;
    },
  });

  const result = await registerWebPush(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
});

test('registerWebPush: returns denied when user denies notification permission', async () => {
  const { env } = createMockEnv();
  (env.windowObj as any).Notification.requestPermission = async () => 'denied';

  const result = await registerWebPush(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'denied');
});

test('registerWebPush: performs explicit registration, registers SW and POSTs payload', async () => {
  const { env, calls, mockSub } = createMockEnv();
  // Start with default permission:
  let perm: NotificationPermission = 'default';
  Object.defineProperty(env.windowObj!.Notification!, 'permission', {
    get: () => perm,
  });
  (env.windowObj as any).Notification.requestPermission = async () => {
    calls.permissionRequests++;
    perm = 'granted';
    return 'granted';
  };

  // Mock getSubscription initially returning null so it calls subscribe
  const regMock = {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => {
        calls.pushSubscribes++;
        return mockSub;
      },
    },
  };
  (env.navigatorObj as any).serviceWorker.register = async (url: string) => {
    calls.swRegistrations.push(url);
    return regMock as any;
  };

  const result = await registerWebPush(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'subscribed');
  assert.equal(calls.permissionRequests, 1, 'Must request permission during explicit gesture');
  assert.deepEqual(calls.swRegistrations, ['/push-sw.js'], 'Must register /push-sw.js');
  assert.equal(calls.pushSubscribes, 1, 'Must call pushManager.subscribe');

  const postCall = calls.fetches.find(f => f.url === '/api/push/subscriptions' && f.options?.method === 'POST');
  assert.ok(postCall, 'Must POST to /api/push/subscriptions');
  const body = JSON.parse(postCall!.options!.body as string);
  assert.equal(body.subscription.endpoint, mockSub.endpoint);
  assert.deepEqual(body.preferences, SAMPLE_PREFERENCES);
  assert.equal(body.language, 'en');
  assert.deepEqual(body.projects, SAMPLE_PROJECTS);
});

// ---------------------------------------------------------------------------
// 5. unregisterWebPush (Disable / Off)
// ---------------------------------------------------------------------------

test('unregisterWebPush: deletes endpoint on server, unsubscribes browser subscription', async () => {
  const { env, calls, mockSub } = createMockEnv();

  const result = await unregisterWebPush(undefined, env);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'unsubscribed');

  const deleteCall = calls.fetches.find(f => f.url === '/api/push/subscriptions' && f.options?.method === 'DELETE');
  assert.ok(deleteCall, 'Must DELETE from /api/push/subscriptions');
  const body = JSON.parse(deleteCall!.options!.body as string);
  assert.equal(body.endpoint, mockSub.endpoint);
  assert.equal(mockSub.isUnsubscribed(), true, 'Must unsubscribe locally');
});

test('unregisterWebPush: surfaces server DELETE error without claiming false success', async () => {
  const { env } = createMockEnv({
    fetchFn: async (url: any, init?: any) => {
      if (String(url) === '/api/push/subscriptions' && init?.method === 'DELETE') {
        return { ok: false, status: 500 } as any;
      }
      return { ok: true } as any;
    },
  });

  const result = await unregisterWebPush(undefined, env);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('500'), 'Must surface HTTP error');
});

test('unregisterWebPush: surfaces browser unsubscribe error without claiming success', async () => {
  const { env, mockSub } = createMockEnv();
  mockSub.unsubscribe = async () => {
    throw new Error('Browser unsubscribe failed');
  };

  const result = await unregisterWebPush(undefined, env);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('Browser unsubscribe failed'));
});

test('unregisterWebPush: returns error when getRegistration throws an exception', async () => {
  const { env } = createMockEnv();
  (env.navigatorObj as any).serviceWorker.getRegistration = async () => {
    throw new Error('Registration lookup failed');
  };

  const result = await unregisterWebPush(undefined, env);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('Registration lookup failed'), 'Must return error rather than false success');
});

test('unregisterWebPush: returns error when getSubscription throws an exception', async () => {
  const { env } = createMockEnv();
  (env.navigatorObj as any).serviceWorker.getRegistration = async () => ({
    pushManager: {
      getSubscription: async () => {
        throw new Error('PushManager error');
      },
    },
  });

  const result = await unregisterWebPush(undefined, env);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('PushManager error'), 'Must return error rather than false success');
});

test('registerWebPush: checks abort signal after subscribe and aborts before POST', async () => {
  const { env, calls, mockSub } = createMockEnv();
  const controller = new AbortController();

  (env.navigatorObj as any).serviceWorker.register = async () => ({
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => {
        controller.abort();
        return mockSub;
      },
    },
  });

  const result = await registerWebPush(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS, signal: controller.signal },
    env
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  const postCall = calls.fetches.find(f => f.url === '/api/push/subscriptions' && f.options?.method === 'POST');
  assert.equal(postCall, undefined, 'Must NOT POST when aborted before network call');
});

test('registerWebPush: times out when serviceWorker.ready hangs indefinitely', async () => {
  const { env } = createMockEnv({
    readyTimeoutMs: 50,
  } as any);

  (env.navigatorObj as any).serviceWorker.ready = new Promise(() => {}); // never resolves

  const result = await registerWebPush(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('timed out'));
});

// ---------------------------------------------------------------------------
// 6. syncExistingSubscription (No Prompt Mount / Auth Refresh)
// ---------------------------------------------------------------------------

test('syncExistingSubscription: NEVER prompts permission or creates new browser subscription', async () => {
  const { env, calls } = createMockEnv();

  // Permission is not yet granted
  Object.defineProperty(env.windowObj!.Notification!, 'permission', {
    value: 'default',
  });

  const result = await syncExistingSubscription(
    { preferences: SAMPLE_PREFERENCES, language: 'en', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, false);
  assert.equal(calls.permissionRequests, 0, 'Must NOT request permission during sync');
  assert.equal(calls.pushSubscribes, 0, 'Must NOT subscribe during sync');
});

test('syncExistingSubscription: updates server when subscription already exists and permission granted', async () => {
  const { env, calls, mockSub } = createMockEnv();

  Object.defineProperty(env.windowObj!.Notification!, 'permission', {
    value: 'granted',
  });

  const result = await syncExistingSubscription(
    { preferences: SAMPLE_PREFERENCES, language: 'es', projects: SAMPLE_PROJECTS },
    env
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'subscribed');
  assert.equal(calls.permissionRequests, 0, 'Must NOT request permission');
  assert.equal(calls.pushSubscribes, 0, 'Must NOT create new subscription');

  const postCall = calls.fetches.find(f => f.url === '/api/push/subscriptions' && f.options?.method === 'POST');
  assert.ok(postCall, 'Must POST updated session registration');
  const body = JSON.parse(postCall!.options!.body as string);
  assert.equal(body.language, 'es');
  assert.equal(body.subscription.endpoint, mockSub.endpoint);
});

// ---------------------------------------------------------------------------
// 7. revokePushOnLogout
// ---------------------------------------------------------------------------

test('revokePushOnLogout: removes server registration before browser unsubscribe and logout', async () => {
  const { env, calls, mockSub } = createMockEnv();

  const res = await revokePushOnLogout(env);

  assert.equal(res.ok, true);
  assert.equal(res.status, 'unsubscribed');
  const deleteCall = calls.fetches.find(f => f.url === '/api/push/subscriptions' && f.options?.method === 'DELETE');
  assert.ok(deleteCall, 'Must send DELETE to revoke server subscription');
  assert.equal(mockSub.isUnsubscribed(), true, 'Must unsubscribe locally');
});

test('revokePushOnLogout: is safe no-op on native host (Tauri)', async () => {
  const { env, calls } = createMockEnv({ isNativeHost: true });

  const res = await revokePushOnLogout(env);

  assert.equal(res.ok, true);
  assert.equal(res.status, 'unsupported');
  assert.equal(calls.fetches.length, 0, 'Must NOT attempt fetch on native host');
});

test('revokePushOnLogout: surfaces cleanup error when server DELETE fails', async () => {
  const { env } = createMockEnv({
    fetchFn: async (url: any, init?: any) => {
      if (String(url) === '/api/push/subscriptions' && init?.method === 'DELETE') {
        return { ok: false, status: 500 } as any;
      }
      return { ok: true } as any;
    },
  });

  const res = await revokePushOnLogout(env);

  assert.equal(res.ok, false);
  assert.equal(res.status, 'error');
  assert.ok(res.error?.includes('500'), 'Must surface error if cleanup fails');
});
