import type { NotificationMessage } from './notification-delivery';

/** Standalone browser implementation: no native runtime or plugin dependency. */
export function createWebNotificationProvider() {
  if (typeof window === 'undefined' || window.isSecureContext === false || typeof Notification === 'undefined') {
    return undefined;
  }
  return {
    permission: () => Notification.permission,
    request: () => Notification.requestPermission(),
    send: (message: NotificationMessage) => {
      const notification = new Notification(message.title, { body: message.body, silent: true });
      notification.onclick = () => {
        try { window.focus(); } catch { /* Browser may reject programmatic focus. */ }
        message.onClick?.();
        notification.close();
      };
    },
  };
}
