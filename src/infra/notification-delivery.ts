import { createWebNotificationProvider } from './notifications-web';

/** Detect native host without importing Tauri; the browser IPC shim is not native. */
export function isNativeNotificationHost(host: unknown): boolean {
  if (!host || typeof host !== 'object') return false;
  const value = host as { __TAURI_INTERNALS__?: { __isWebIpc?: boolean }; __IS_WEB_IPC__?: boolean };
  return Boolean(value.__TAURI_INTERNALS__ && !value.__IS_WEB_IPC__ && !value.__TAURI_INTERNALS__.__isWebIpc);
}

export type NotificationPermissionStatus = NotificationPermission | 'unavailable';
export interface NotificationMessage {
  title: string;
  body: string;
  onClick?: () => void;
}
interface NativeNotificationApi {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body: string }): void;
}
interface DeliveryOptions {
  native: boolean;
  browser?: {
    permission(): NotificationPermission;
    request(): Promise<NotificationPermission>;
    send(options: NotificationMessage): void;
  };
  loadNative?: () => Promise<NativeNotificationApi>;
}

/** Permission is queried passively. Only requestPermission may prompt the user. */
export function createNotificationDelivery(options: DeliveryOptions) {
  let nativePermission: NotificationPermission = 'default';
  const load = options.loadNative ?? (async () => (await import('./notifications-tauri')).loadNativeNotifications());
  const permission = async (): Promise<NotificationPermissionStatus> => {
    try {
      if (options.native) {
        return await (await load()).isPermissionGranted() ? 'granted' : nativePermission;
      }
      return options.browser?.permission() ?? 'unavailable';
    } catch { return 'unavailable'; }
  };
  return {
    platform: options.native ? 'tauri' as const : 'web' as const,
    permission,
    async requestPermission(): Promise<NotificationPermissionStatus> {
      try {
        const status = await permission();
        if (status === 'granted' || status === 'unavailable' || status === 'denied') return status;
        if (options.native) {
          const result = await (await load()).requestPermission();
          nativePermission = result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
          return nativePermission;
        }
        return await options.browser!.request();
      } catch { return 'unavailable'; }
    },
    async send(message: NotificationMessage): Promise<boolean> {
      try {
        if (await permission() !== 'granted') return false;
        if (options.native) {
          // Native desktop click callbacks are not portable; do not register mobile-only actions.
          (await load()).sendNotification({ title: message.title, body: message.body });
        } else {
          options.browser!.send(message);
        }
        return true;
      } catch { return false; }
    },
  };
}

let hostDelivery: ReturnType<typeof createNotificationDelivery> | undefined;
export function getNotificationDelivery() {
  if (hostDelivery) return hostDelivery;
  const native = typeof window !== 'undefined' && isNativeNotificationHost(window);
  const browser = native ? undefined : createWebNotificationProvider();
  hostDelivery = createNotificationDelivery({ native, browser });
  return hostDelivery;
}
