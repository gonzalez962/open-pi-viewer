import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  shouldShowWebPushPrompt,
  loadWebPushPromptCooldown,
  saveWebPushPromptCooldown,
  clearWebPushPromptCooldown,
  createWebPushPromptController,
  useWebPushPrompt,
  WEB_PUSH_PROMPT_COOLDOWN_MS,
  WEB_PUSH_PROMPT_COOLDOWN_KEY,
  type WebPushPromptEligibilityOptions,
} from '@features/settings/hooks/useWebPushPrompt';
import type { UseWebPushReturn } from '@features/settings/hooks/useWebPush';

// ---------------------------------------------------------------------------
// 1. Pure policy: sync gating & transient enrollment protection
// ---------------------------------------------------------------------------

test('web-push-prompt policy: gating blocks prompt while startup sync has not settled', () => {
  const base: WebPushPromptEligibilityOptions = {
    isWeb: true,
    notificationsEnabled: true,
    isSupported: true,
    status: 'unsubscribed',
    isSyncSettled: false,
    permission: 'default',
    cooldownUntil: null,
    sessionDismissed: false,
  };

  assert.equal(shouldShowWebPushPrompt(base), false, 'Must not prompt during initial startup sync');

  const settled = { ...base, isSyncSettled: true };
  assert.equal(shouldShowWebPushPrompt(settled), true, 'Must prompt once startup sync settles');
});

// ---------------------------------------------------------------------------
// 2. Pure policy: platform, preferences, and status gating
// ---------------------------------------------------------------------------

test('web-push-prompt policy: desktop native host suppresses prompt', () => {
  const options: WebPushPromptEligibilityOptions = {
    isWeb: false, // Desktop Tauri
    notificationsEnabled: true,
    isSupported: true,
    status: 'unsubscribed',
    isSyncSettled: true,
    permission: 'default',
    cooldownUntil: null,
    sessionDismissed: false,
  };

  assert.equal(shouldShowWebPushPrompt(options), false, 'Desktop native must not prompt');
});

test('web-push-prompt policy: disabled notifications preference suppresses prompt', () => {
  const options: WebPushPromptEligibilityOptions = {
    isWeb: true,
    notificationsEnabled: false,
    isSupported: true,
    status: 'unsubscribed',
    isSyncSettled: true,
    permission: 'default',
    cooldownUntil: null,
    sessionDismissed: false,
  };

  assert.equal(shouldShowWebPushPrompt(options), false, 'Disabled notifications must not prompt');
});

test('web-push-prompt policy: non-unsubscribed statuses suppress prompt', () => {
  const nonEligibleStatuses = [
    'subscribed',
    'unsupported',
    'unavailable',
    'denied',
    'error',
  ] as const;

  for (const status of nonEligibleStatuses) {
    const options: WebPushPromptEligibilityOptions = {
      isWeb: true,
      notificationsEnabled: true,
      isSupported: true,
      status,
      isSyncSettled: true,
      permission: 'default',
      cooldownUntil: null,
      sessionDismissed: false,
    };

    assert.equal(
      shouldShowWebPushPrompt(options),
      false,
      `Status '${status}' must suppress prompt`
    );
  }
});

test('web-push-prompt policy: denied browser permission suppresses prompt even if status is unsubscribed', () => {
  const options: WebPushPromptEligibilityOptions = {
    isWeb: true,
    notificationsEnabled: true,
    isSupported: true,
    status: 'unsubscribed',
    isSyncSettled: true,
    permission: 'denied',
    cooldownUntil: null,
    sessionDismissed: false,
  };

  assert.equal(shouldShowWebPushPrompt(options), false, 'Denied permission must suppress prompt');
});

test('web-push-prompt policy: unsupported browser suppresses prompt', () => {
  const options: WebPushPromptEligibilityOptions = {
    isWeb: true,
    notificationsEnabled: true,
    isSupported: false,
    status: 'unsubscribed',
    isSyncSettled: true,
    permission: 'default',
    cooldownUntil: null,
    sessionDismissed: false,
  };

  assert.equal(shouldShowWebPushPrompt(options), false, 'Unsupported browser must suppress prompt');
});

// ---------------------------------------------------------------------------
// 3. Pure policy: 24h cooldown, boundary condition, and session dismissal
// ---------------------------------------------------------------------------

test('web-push-prompt policy: 24h cooldown suppresses prompt before boundary and allows at exact boundary', () => {
  const t0 = 1_700_000_000_000;
  const cooldownUntil = t0 + WEB_PUSH_PROMPT_COOLDOWN_MS;

  const base: WebPushPromptEligibilityOptions = {
    isWeb: true,
    notificationsEnabled: true,
    isSupported: true,
    status: 'unsubscribed',
    isSyncSettled: true,
    permission: 'default',
    cooldownUntil,
    sessionDismissed: false,
  };

  // 1ms before 24h boundary -> active cooldown, must not show
  assert.equal(
    shouldShowWebPushPrompt({ ...base, now: cooldownUntil - 1 }),
    false,
    'Must suppress before 24h boundary'
  );

  // Exact 24h boundary -> eligible on next opening
  assert.equal(
    shouldShowWebPushPrompt({ ...base, now: cooldownUntil }),
    true,
    'Must be eligible at exact 24h boundary'
  );

  // Past 24h boundary -> eligible
  assert.equal(
    shouldShowWebPushPrompt({ ...base, now: cooldownUntil + 1000 }),
    true,
    'Must be eligible after 24h boundary'
  );
});

test('web-push-prompt policy: session dismissal suppresses prompt even if cooldown expired', () => {
  const options: WebPushPromptEligibilityOptions = {
    isWeb: true,
    notificationsEnabled: true,
    isSupported: true,
    status: 'unsubscribed',
    isSyncSettled: true,
    permission: 'default',
    cooldownUntil: null,
    sessionDismissed: true,
  };

  assert.equal(shouldShowWebPushPrompt(options), false, 'Session dismissal must suppress prompt');
});

// ---------------------------------------------------------------------------
// 4. Storage helper resilience (catch storage failures)
// ---------------------------------------------------------------------------

test('web-push-prompt storage: catches read/write failures gracefully without throwing', () => {
  const throwingStorage: Storage = {
    getItem: () => {
      throw new Error('SecurityError: The operation is insecure.');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('Access denied');
    },
    clear: () => {},
    key: () => null,
    length: 0,
  };

  // Read handles throw
  const loaded = loadWebPushPromptCooldown(throwingStorage);
  assert.equal(loaded, null, 'Must catch storage read exception and return null');

  // Write handles throw
  const saved = saveWebPushPromptCooldown(123456, throwingStorage);
  assert.equal(saved, false, 'Must catch storage write exception and return false');
});

test('web-push-prompt storage: roundtrips cooldown timestamp accurately', () => {
  const map = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };

  assert.equal(loadWebPushPromptCooldown(mockStorage), null);
  const targetTime = Date.now() + WEB_PUSH_PROMPT_COOLDOWN_MS;
  saveWebPushPromptCooldown(targetTime, mockStorage);
  assert.equal(loadWebPushPromptCooldown(mockStorage), targetTime);
  assert.equal(map.get(WEB_PUSH_PROMPT_COOLDOWN_KEY), String(targetTime));
  clearWebPushPromptCooldown(mockStorage);
  assert.equal(loadWebPushPromptCooldown(mockStorage), null);
});

// ---------------------------------------------------------------------------
// 5. Controller & Hook lifecycle: startup gating, Accept, Decline, and errors
// ---------------------------------------------------------------------------

test('controller: prevents transient prompt for already-enrolled device on startup', () => {
  const mockStorage: Storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };

  // Phase 1: Mounting / startup sync in flight.
  // Hook status starts at 'unsubscribed', but isSyncSettled is false.
  const webPushMounting: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: true,
    isSyncSettled: false,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: webPushMounting,
    notificationsEnabled: true,
    isWeb: true,
    storage: mockStorage,
  });

  assert.equal(
    controller.getState().isOpen,
    false,
    'Must NOT open prompt during initial startup sync even though initial status is unsubscribed'
  );

  // Phase 2: Startup sync finishes and reveals the device is already subscribed.
  const webPushSettledSubscribed: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: true,
    isLoading: false,
    isSyncSettled: true,
    status: 'subscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  controller.updateProps({ webPush: webPushSettledSubscribed });

  assert.equal(
    controller.getState().isOpen,
    false,
    'Must NOT open prompt once sync settles to subscribed'
  );
});

test('controller: genuinely unsubscribed browser opens prompt once sync settles', () => {
  const webPushMounting: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: true,
    isSyncSettled: false,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: webPushMounting,
    notificationsEnabled: true,
    isWeb: true,
  });

  assert.equal(controller.getState().isOpen, false);

  // Sync finishes and confirms unsubscribed
  controller.updateProps({
    webPush: { ...webPushMounting, isSyncSettled: true, isLoading: false },
  });

  assert.equal(controller.getState().isOpen, true, 'Must open when genuinely unsubscribed');
});

test('controller: Accept directly calls webPush.enable without a second modal and clears cooldown', async () => {
  let enableCalls = 0;
  const map = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };

  // Seed old cooldown
  map.set(WEB_PUSH_PROMPT_COOLDOWN_KEY, '1000');

  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => {
      enableCalls++;
      return { ok: true, status: 'subscribed' };
    },
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
    storage: mockStorage,
    now: () => 2000,
  });

  assert.equal(controller.getState().isOpen, true);

  await controller.accept();

  assert.equal(enableCalls, 1, 'Accept must directly call webPush.enable');
  assert.equal(map.has(WEB_PUSH_PROMPT_COOLDOWN_KEY), false, 'Must clear cooldown on success');
  assert.equal(controller.getState().isOpen, false, 'Must close prompt on success');
  assert.equal(controller.getState().isPending, false);
});

test('controller: Accept failure leaves prompt open, shows error, and remains retryable', async () => {
  let enableCalls = 0;

  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => {
      enableCalls++;
      return { ok: false, status: 'error', error: 'Network failure' };
    },
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  assert.equal(controller.getState().isOpen, true);

  await controller.accept();

  assert.equal(enableCalls, 1);
  assert.equal(controller.getState().error, 'Network failure');
  assert.equal(controller.getState().isOpen, true, 'Prompt must remain open on failure');
  assert.equal(controller.getState().isPending, false);

  // Retry Accept
  await controller.accept();
  assert.equal(enableCalls, 2, 'Accept must be retryable after failure');
});

test('controller: Decline persists 24h cooldown to storage and closes prompt', () => {
  const map = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };

  const fixedTime = 1_700_000_000_000;
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
    storage: mockStorage,
    now: () => fixedTime,
  });

  assert.equal(controller.getState().isOpen, true);

  controller.decline();

  const expectedCooldown = fixedTime + WEB_PUSH_PROMPT_COOLDOWN_MS;
  assert.equal(
    map.get(WEB_PUSH_PROMPT_COOLDOWN_KEY),
    String(expectedCooldown),
    'Decline must persist exactly 24h cooldown timestamp'
  );
  assert.equal(controller.getState().isOpen, false, 'Decline must close the prompt');
});

test('controller: Decline is ignored during pending Accept operation', async () => {
  const map = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };

  let resolveEnable!: (val: any) => void;
  const enablePromise = new Promise((resolve) => {
    resolveEnable = resolve;
  });

  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: () => enablePromise as any,
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
    storage: mockStorage,
  });

  // Start in-flight accept
  const acceptTask = controller.accept();
  assert.equal(controller.getState().isPending, true);

  // Try decline during pending operation
  controller.decline();

  // Cooldown must not have been set and prompt must still be pending
  assert.equal(map.has(WEB_PUSH_PROMPT_COOLDOWN_KEY), false, 'Must not decline while pending');
  assert.equal(controller.getState().isPending, true);

  // Finish accept
  resolveEnable({ ok: true, status: 'subscribed' });
  await acceptTask;
});

test('useWebPushPrompt: React hook mounts and renders initial controller state', () => {
  let hookReturn: any;
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const Harness = () => {
    hookReturn = useWebPushPrompt({
      webPush: mockWebPush,
      notificationsEnabled: true,
      isWeb: true,
    });
    return null;
  };

  renderToStaticMarkup(React.createElement(Harness));

  assert.equal(hookReturn.isOpen, true);
  assert.equal(hookReturn.isPending, false);
  assert.equal(hookReturn.error, null);
  assert.equal(typeof hookReturn.accept, 'function');
  assert.equal(typeof hookReturn.decline, 'function');
  assert.equal(typeof hookReturn.dismiss, 'function');
});

// ---------------------------------------------------------------------------
// 6. Regression tests: A, D, and settlement
// ---------------------------------------------------------------------------

test('regression A: retry after enable failure keeps prompt visible during in-flight retry, closes on success, respects preferences and cooldown', async () => {
  let resolveRetry!: (val: any) => void;
  let retryCallCount = 0;

  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => {
      retryCallCount++;
      if (retryCallCount === 1) {
        return { ok: false, status: 'error', error: 'Network failure' };
      }
      return new Promise((resolve) => {
        resolveRetry = resolve;
      });
    },
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  assert.equal(controller.getState().isOpen, true);

  // 1. First attempt fails
  await controller.accept();
  assert.equal(controller.getState().isOpen, true, 'Prompt must remain open after first failure');
  assert.equal(controller.getState().error, 'Network failure');

  // Hook/App reflects status: 'error'
  controller.updateProps({
    webPush: { ...mockWebPush, status: 'error', error: 'Network failure' },
  });
  assert.equal(controller.getState().isOpen, true, 'Prompt remains open when status is error');

  // 2. Retry started with deferred promise
  const retryPromise = controller.accept();

  // DURING in-flight retry: isPending is true, error was reset to null
  assert.equal(controller.getState().isPending, true);
  assert.equal(controller.getState().error, null);
  // Defect A: Previously, computeIsOpen() returned false because error was cleared while status was still 'error'!
  assert.equal(
    controller.getState().isOpen,
    true,
    'Prompt must stay visible during in-flight retry even when error is cleared'
  );

  // Preference gate check: disabling notifications preference closes prompt even during in-flight retry
  controller.updateProps({ notificationsEnabled: false });
  assert.equal(controller.getState().isOpen, false, 'Preference gate must close prompt');
  controller.updateProps({ notificationsEnabled: true });
  assert.equal(controller.getState().isOpen, true, 'Re-enabling preference restores prompt');

  // 3. Retry succeeds
  resolveRetry({ ok: true, status: 'subscribed' });
  await retryPromise;

  assert.equal(controller.getState().isPending, false);
  assert.equal(controller.getState().isOpen, false, 'Must close prompt on success');
});

test('regression D: controller subscribe before updateProps receives updates without lost events', () => {
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: true,
    isSyncSettled: false,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  const receivedStates: boolean[] = [];

  // Subscribe FIRST (mimicking corrected hook effect order)
  const unsubscribe = controller.subscribe((state) => {
    receivedStates.push(state.isOpen);
  });

  // Then updateProps fires (as in second effect on mount / prop change)
  controller.updateProps({
    webPush: { ...mockWebPush, isSyncSettled: true, isLoading: false },
  });

  assert.equal(receivedStates.length, 1, 'Subscriber must receive state update from updateProps');
  assert.equal(receivedStates[0], true, 'Subscriber must receive isOpen=true');

  unsubscribe();
});

test('integration: controller startup sync error leaves browser non-unsubscribed and suppresses prompt without unhandled rejection', async () => {
  let status: any = 'unsubscribed';
  let isSyncSettled = false;
  let error: string | null = null;

  const mockThrowingDependencies: any = {
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
      serviceWorker: {
        register: async () => {
          throw new Error('Push engine initialization crash');
        },
        getRegistration: async () => {
          throw new Error('Push engine initialization crash');
        },
        ready: new Promise(() => {}),
      },
    },
    fetchFn: async () => {
      throw new Error('Network offline');
    },
  };

  const { createWebPushController } = await import('@features/settings/hooks/useWebPush');

  const pushController = createWebPushController({
    preferences: {
      enabled: true,
      sound: true,
      suppressWhenFocused: true,
      onTaskComplete: true,
      onWaitingInput: true,
    },
    language: 'en',
    projects: [{ path: '/test/proj' }],
    dependencies: mockThrowingDependencies,
    onStatusChange: (next) => {
      status = next;
    },
    onError: (err) => {
      error = err;
    },
    onSettled: () => {
      isSyncSettled = true;
    },
  });

  // Must not reject
  await assert.doesNotReject(async () => {
    await pushController.init();
  });

  assert.equal(isSyncSettled, true, 'Init must settle');
  assert.equal(status, 'error', 'Status must be error, proving error is NOT rewritten to unsubscribed');
  assert.ok(error !== null);

  const mockWebPushReturn: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled,
    status,
    error,
    enable: () => pushController.enable(),
    disable: () => pushController.disable(),
    sync: () => pushController.sync(),
  };

  const promptController = createWebPushPromptController({
    webPush: mockWebPushReturn,
    notificationsEnabled: true,
    isWeb: true,
  });

  assert.equal(
    promptController.getState().isOpen,
    false,
    'Invitation prompt must remain suppressed when startup sync results in error'
  );
});

// ---------------------------------------------------------------------------
// 7. Suppression of redundant notifications & Stable Lifecycle
// ---------------------------------------------------------------------------

test('controller: suppresses redundant notifications when webPush object is fresh but values unchanged, notifies exactly once on value change, and notifies on accept/decline/retry', async () => {
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  assert.equal(controller.getState().isOpen, true);

  let notifyCount = 0;
  const unsubscribe = controller.subscribe(() => {
    notifyCount++;
  });

  // Call updateProps twice with fresh webPush objects having identical values
  controller.updateProps({
    webPush: { ...mockWebPush },
  });
  controller.updateProps({
    webPush: { ...mockWebPush },
  });

  // Behavioral assertion: redundant notifications suppressed when values unchanged
  assert.equal(
    notifyCount,
    0,
    'subscribe count must be 0 after two updateProps with fresh webPush objects but identical values'
  );

  // Value change: status changes from unsubscribed to subscribed
  controller.updateProps({
    webPush: { ...mockWebPush, status: 'subscribed', isSubscribed: true },
  });

  assert.equal(
    notifyCount,
    1,
    'value change must notify exactly once'
  );
  assert.equal(controller.getState().isOpen, false);

  // Another updateProps with identical 'subscribed' status
  controller.updateProps({
    webPush: { ...mockWebPush, status: 'subscribed', isSubscribed: true },
  });
  assert.equal(
    notifyCount,
    1,
    'identical values must not trigger another notification'
  );

  unsubscribe();

  // Test accept/decline/retry notification behavior on a fresh controller
  let retryCount = 0;
  let shouldFail = true;
  const retryMockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => {
      retryCount++;
      if (shouldFail) {
        return { ok: false, status: 'error', error: 'Push activation failed' };
      }
      return { ok: true, status: 'subscribed' };
    },
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const actionController = createWebPushPromptController({
    webPush: retryMockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  const actionStates: Array<{ isOpen: boolean; isPending: boolean; error: string | null }> = [];
  actionController.subscribe((s) => {
    actionStates.push({ ...s });
  });

  // Accept attempt 1 (fails)
  await actionController.accept();
  assert.equal(actionStates.length, 2);
  assert.equal(actionStates[0].isPending, true);
  assert.equal(actionStates[1].isPending, false);
  assert.equal(actionStates[1].error, 'Push activation failed');
  assert.equal(actionStates[1].isOpen, true);

  // Retry accept attempt 2 (succeeds)
  shouldFail = false;
  await actionController.accept();
  assert.equal(actionStates.length, 4);
  assert.equal(actionStates[2].isPending, true);
  assert.equal(actionStates[3].isPending, false);
  assert.equal(actionStates[3].isOpen, false);
  assert.equal(actionStates[3].error, null);

  // Decline on another fresh controller
  const declineController = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });
  let declineNotified = 0;
  declineController.subscribe(() => {
    declineNotified++;
  });
  declineController.decline();
  assert.equal(declineNotified, 1, 'Decline must notify appropriately');
  assert.equal(declineController.getState().isOpen, false);
});

test('lifecycle proof: snapshot synchronization is resilient regardless of updateProps ordering', () => {
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: true,
    isSyncSettled: false,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  // Inverted order: updateProps runs before subscriber registers
  controller.updateProps({
    webPush: { ...mockWebPush, isSyncSettled: true, isLoading: false },
  });

  // Direct snapshot check proves state updated without needing an active listener at time of update
  assert.equal(controller.getState().isOpen, true);

  // Initial snapshot capture on subscribe mimics hook mount behavior
  const received: boolean[] = [];
  received.push(controller.getState().isOpen);
  const unsubscribe = controller.subscribe((state) => {
    received.push(state.isOpen);
  });

  assert.equal(received.length, 1);
  assert.equal(received[0], true);

  // Subsequent value change fires listener
  controller.updateProps({
    webPush: { ...mockWebPush, isSyncSettled: true, status: 'subscribed', isSubscribed: true },
  });
  assert.equal(received.length, 2);
  assert.equal(received[1], false);

  unsubscribe();
});

test('lifecycle proof: controller getState returns referentially identical object when values unchanged', () => {
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  const controller = createWebPushPromptController({
    webPush: mockWebPush,
    notificationsEnabled: true,
    isWeb: true,
  });

  const snapshot1 = controller.getState();
  const snapshot2 = controller.getState();
  assert.equal(snapshot1, snapshot2, 'getState must return referentially stable snapshot when values unchanged');

  // After updateProps with fresh object but same values
  controller.updateProps({ webPush: { ...mockWebPush } });
  const snapshot3 = controller.getState();
  assert.equal(snapshot1, snapshot3, 'getState must remain referentially stable after identical updateProps');

  // After actual value change
  controller.updateProps({ webPush: { ...mockWebPush, status: 'subscribed' } });
  const snapshot4 = controller.getState();
  assert.notEqual(snapshot1, snapshot4, 'getState must update snapshot reference when value changes');
  assert.equal(snapshot4.isOpen, false);
});

test('useWebPushPrompt: rerendering with fresh webPush object reference does not cause loop or state instability', () => {
  const mockWebPush: UseWebPushReturn = {
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    isSyncSettled: true,
    status: 'unsubscribed',
    error: null,
    enable: async () => ({ ok: true, status: 'subscribed' }),
    disable: async () => ({ ok: true, status: 'unsubscribed' }),
    sync: async () => ({ ok: true, status: 'subscribed' }),
  };

  let renderCount = 0;
  let hookReturn: any;

  const Harness = ({ iteration }: { iteration: number }) => {
    renderCount++;
    // Mimic App: fresh webPush object on every render
    const freshWebPush: UseWebPushReturn = { ...mockWebPush };
    hookReturn = useWebPushPrompt({
      webPush: freshWebPush,
      notificationsEnabled: true,
      isWeb: true,
    });
    return React.createElement('div', null, `render-${iteration}`);
  };

  // Render multiple times with fresh webPush objects
  renderToStaticMarkup(React.createElement(Harness, { iteration: 1 }));
  renderToStaticMarkup(React.createElement(Harness, { iteration: 2 }));
  renderToStaticMarkup(React.createElement(Harness, { iteration: 3 }));

  assert.equal(renderCount, 3);
  assert.equal(hookReturn.isOpen, true);
  assert.equal(hookReturn.isPending, false);
  assert.equal(hookReturn.error, null);
});





