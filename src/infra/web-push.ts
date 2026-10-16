import type { NotificationPreferences } from '@core/notifications';
import { isNativeNotificationHost } from './notification-delivery';

export type { NotificationPreferences };

export interface WebPushProject {
  path: string;
  customName?: string;
}

export interface WebPushConfig {
  available: boolean;
  publicKey?: string;
}

export type WebPushStatus =
  | 'unsupported'
  | 'unavailable'
  | 'denied'
  | 'subscribed'
  | 'unsubscribed'
  | 'error';

export interface WebPushOperationResult {
  ok: boolean;
  status: WebPushStatus;
  error?: string;
}

export interface WebPushEnvironment {
  isNativeHost?: boolean;
  windowObj?: {
    isSecureContext?: boolean;
    Notification?: {
      permission: NotificationPermission;
      requestPermission: () => Promise<NotificationPermission>;
    };
    PushManager?: unknown;
  } | null;
  navigatorObj?: {
    serviceWorker?: {
      register: (scriptURL: string, options?: RegistrationOptions) => Promise<ServiceWorkerRegistration>;
      getRegistration: (clientURL?: string) => Promise<ServiceWorkerRegistration | undefined>;
      ready: Promise<ServiceWorkerRegistration>;
    };
  } | null;
  fetchFn?: typeof fetch;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface WebPushSyncParams {
  preferences: NotificationPreferences;
  language: string;
  projects: WebPushProject[];
  signal?: AbortSignal;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_READY_TIMEOUT_MS = 5000;

/**
 * Creates an AbortSignal that aborts either when caller signal fires or when
 * timeout expires, avoiding unbounded network or local hangs.
 */
function createBoundedSignal(callerSignal?: AbortSignal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onAbort = () => {
    controller.abort(callerSignal?.reason ?? new Error('Operation aborted'));
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason ?? new Error('Operation aborted'));
    } else {
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Bounded promise racer to prevent indefinite hangs on local browser promises.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Converts a URL-safe Base64 string to an explicit Uint8Array<ArrayBuffer> for PushManager subscription.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

  if (typeof atob !== 'undefined') {
    const rawData = atob(base64);
    const buffer = new ArrayBuffer(rawData.length);
    const outputArray = new Uint8Array(buffer);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // Node runtime fallback with owned ArrayBuffer (BufferSource compatible in TS 5.9)
  const buf = Buffer.from(base64, 'base64');
  const buffer = new ArrayBuffer(buf.byteLength);
  const outputArray = new Uint8Array(buffer);
  outputArray.set(buf);
  return outputArray;
}

/**
 * Checks if Web Push is supported in the current environment:
 * - Requires web platform (not native host)
 * - Requires secure context (HTTPS or localhost)
 * - Requires Notification, PushManager, and serviceWorker APIs
 */
export function isWebPushSupported(env?: WebPushEnvironment): boolean {
  if (env?.isNativeHost === true) return false;

  const win = env?.windowObj !== undefined ? env.windowObj : (typeof window !== 'undefined' ? window : null);
  const nav = env?.navigatorObj !== undefined ? env.navigatorObj : (typeof navigator !== 'undefined' ? navigator : null);

  if (!win || !nav) return false;

  if (env?.isNativeHost === undefined && typeof window !== 'undefined' && isNativeNotificationHost(window)) {
    return false;
  }

  if (win.isSecureContext === false) return false;

  return Boolean(win.Notification && win.PushManager && nav.serviceWorker);
}

/**
 * Fetches Web Push configuration from the server.
 * Returns { available: false } on failure or disabled state, and discards any
 * unexpected private keys to prevent client leakage.
 */
export async function getWebPushConfig(options?: {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<WebPushConfig> {
  const bounded = createBoundedSignal(options?.signal);
  const fetchFn = options?.fetchFn ?? fetch;
  try {
    const res = await fetchFn('/api/push/config', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: bounded.signal,
    });
    if (!res.ok) {
      return { available: false };
    }
    const data = await res.json();
    if (
      data &&
      typeof data === 'object' &&
      data.available === true &&
      typeof data.publicKey === 'string' &&
      data.publicKey.trim()
    ) {
      return {
        available: true,
        publicKey: data.publicKey.trim(),
      };
    }
    return { available: false };
  } catch {
    return { available: false };
  } finally {
    bounded.cleanup();
  }
}

/**
 * Explicit user switch activation:
 * 1. Checks support
 * 2. Fetches VAPID config
 * 3. Requests browser notification permission during user gesture
 * 4. Registers /push-sw.js service worker with bounded ready deadline
 * 5. Subscribes pushManager with userVisibleOnly and applicationServerKey
 * 6. Checks abort signal before POST
 * 7. POSTs subscription payload to /api/push/subscriptions
 */
export async function registerWebPush(
  params: WebPushSyncParams,
  env?: WebPushEnvironment
): Promise<WebPushOperationResult> {
  if (!isWebPushSupported(env)) {
    return { ok: false, status: 'unsupported', error: 'Web Push is not supported in this environment' };
  }

  const bounded = createBoundedSignal(params.signal, env?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  try {
    const config = await getWebPushConfig({ fetchFn: env?.fetchFn, signal: bounded.signal });
    if (!config.available || !config.publicKey) {
      return { ok: false, status: 'unavailable', error: 'Web Push is not configured on the server' };
    }

    if (bounded.signal.aborted) {
      return { ok: false, status: 'error', error: 'Operation aborted' };
    }

    const win = env?.windowObj !== undefined ? env.windowObj : (typeof window !== 'undefined' ? window : null);
    if (!win?.Notification) {
      return { ok: false, status: 'unsupported', error: 'Notification API is unavailable' };
    }

    let permission: NotificationPermission;
    try {
      permission = await win.Notification.requestPermission();
    } catch (err) {
      return { ok: false, status: 'denied', error: err instanceof Error ? err.message : String(err) };
    }

    if (permission !== 'granted') {
      return { ok: false, status: 'denied', error: 'Notification permission denied' };
    }

    if (bounded.signal.aborted) {
      return { ok: false, status: 'error', error: 'Operation aborted' };
    }

    const nav = env?.navigatorObj !== undefined ? env.navigatorObj : (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav?.serviceWorker) {
      return { ok: false, status: 'unsupported', error: 'ServiceWorker API is unavailable' };
    }

    let registration: ServiceWorkerRegistration;
    try {
      registration = await nav.serviceWorker.register('/push-sw.js', { scope: '/' });
      if (nav.serviceWorker.ready) {
        const readyTimeout = env?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
        await withTimeout(nav.serviceWorker.ready, readyTimeout, `Service worker ready timed out after ${readyTimeout}ms`);
      }
    } catch (err) {
      return { ok: false, status: 'error', error: `Service worker registration failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (bounded.signal.aborted) {
      return { ok: false, status: 'error', error: 'Operation aborted' };
    }

    let subscription: PushSubscription | null = null;
    try {
      subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const applicationServerKey = urlBase64ToUint8Array(config.publicKey);
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }
    } catch (err) {
      return { ok: false, status: 'error', error: `Push subscription failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!subscription) {
      return { ok: false, status: 'error', error: 'Failed to acquire push subscription' };
    }

    if (bounded.signal.aborted) {
      return { ok: false, status: 'error', error: 'Operation aborted' };
    }

    const fetchFn = env?.fetchFn ?? fetch;
    try {
      const payload = {
        subscription: subscription.toJSON(),
        preferences: params.preferences,
        language: params.language,
        projects: params.projects,
      };

      const res = await fetchFn('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: bounded.signal,
      });

      if (!res.ok) {
        return { ok: false, status: 'error', error: `Server failed to store subscription: HTTP ${res.status}` };
      }
    } catch (err) {
      return { ok: false, status: 'error', error: `Server sync failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { ok: true, status: 'subscribed' };
  } finally {
    bounded.cleanup();
  }
}

/**
 * Turning off push:
 * 1. Queries existing subscription (errors returned, never false success on exception)
 * 2. DELETEs this device's endpoint from /api/push/subscriptions (errors surfaced)
 * 3. Unsubscribes locally in browser PushManager (errors surfaced)
 */
export async function unregisterWebPush(
  options?: { signal?: AbortSignal },
  env?: WebPushEnvironment
): Promise<WebPushOperationResult> {
  if (env?.isNativeHost === true || (env?.isNativeHost === undefined &&
    typeof window !== 'undefined' && isNativeNotificationHost(window))) {
    return { ok: true, status: 'unsubscribed' };
  }
  const bounded = createBoundedSignal(options?.signal, env?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  try {
    const nav = env?.navigatorObj !== undefined ? env.navigatorObj : (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav?.serviceWorker) {
      return { ok: true, status: 'unsubscribed' };
    }

    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await nav.serviceWorker.getRegistration('/push-sw.js');
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        error: `Failed to query service worker registration: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!registration) {
      return { ok: true, status: 'unsubscribed' };
    }

    let subscription: PushSubscription | null = null;
    try {
      subscription = await registration.pushManager.getSubscription();
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        error: `Failed to query push subscription: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!subscription) {
      return { ok: true, status: 'unsubscribed' };
    }

    if (bounded.signal.aborted) {
      return { ok: false, status: 'error', error: 'Operation aborted' };
    }

    const fetchFn = env?.fetchFn ?? fetch;
    try {
      const res = await fetchFn('/api/push/subscriptions', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        signal: bounded.signal,
      });

      if (!res.ok) {
        return { ok: false, status: 'error', error: `Server failed to remove subscription: HTTP ${res.status}` };
      }
    } catch (err) {
      return { ok: false, status: 'error', error: `Server deletion failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      const unsubscribed = await subscription.unsubscribe();
      if (!unsubscribed) {
        return { ok: false, status: 'error', error: 'Browser failed to unsubscribe push subscription' };
      }
    } catch (err) {
      return { ok: false, status: 'error', error: `Browser unsubscribe failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { ok: true, status: 'unsubscribed' };
  } finally {
    bounded.cleanup();
  }
}

/**
 * Restores/syncs an existing push subscription on mount or auth-ready.
 * Never prompts for permission, and never creates a new browser subscription.
 */
export async function syncExistingSubscription(
  params: WebPushSyncParams,
  env?: WebPushEnvironment
): Promise<WebPushOperationResult> {
  if (!isWebPushSupported(env)) {
    return { ok: false, status: 'unsupported' };
  }

  const bounded = createBoundedSignal(params.signal, env?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  try {
    const win = env?.windowObj !== undefined ? env.windowObj : (typeof window !== 'undefined' ? window : null);
    if (win?.Notification?.permission !== 'granted') {
      return { ok: false, status: 'denied' };
    }

    const nav = env?.navigatorObj !== undefined ? env.navigatorObj : (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav?.serviceWorker) {
      return { ok: false, status: 'unsupported' };
    }

    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await nav.serviceWorker.getRegistration('/push-sw.js');
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        error: `Failed to query service worker registration: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!registration) {
      return { ok: false, status: 'unsubscribed' };
    }

    let subscription: PushSubscription | null = null;
    try {
      subscription = await registration.pushManager.getSubscription();
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        error: `Failed to query push subscription: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!subscription) {
      return { ok: false, status: 'unsubscribed' };
    }

    if (bounded.signal.aborted) {
      return { ok: false, status: 'error', error: 'Operation aborted' };
    }

    const fetchFn = env?.fetchFn ?? fetch;
    try {
      const payload = {
        subscription: subscription.toJSON(),
        preferences: params.preferences,
        language: params.language,
        projects: params.projects,
      };

      const res = await fetchFn('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: bounded.signal,
      });

      if (!res.ok) {
        return { ok: false, status: 'error', error: `Server failed to sync subscription: HTTP ${res.status}` };
      }
    } catch (err) {
      return { ok: false, status: 'error', error: `Server sync failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { ok: true, status: 'subscribed' };
  } finally {
    bounded.cleanup();
  }
}

/**
 * Logout helper: revokes server subscription before browser unsubscribe and auth revoke.
 * Protected by non-native web support check (safe no-op on Tauri).
 * Returns the operation result so callers can inspect cleanup success while allowing
 * parent logout logic to proceed via try/finally.
 */
export async function revokePushOnLogout(
  env?: WebPushEnvironment
): Promise<WebPushOperationResult> {
  if (!isWebPushSupported(env)) {
    return { ok: true, status: 'unsupported' };
  }
  return await unregisterWebPush(undefined, env);
}
