/**
 * Service Worker for PWA lifecycle and Web Push notifications.
 *
 * Responsibilities:
 * - Manage standard PWA lifecycle (install, activate, client claiming).
 * - Display desktop notifications when the app page is closed.
 * - Always display valid received pushes (userVisibleOnly contract).
 *   The server suppresses sends to devices with an active viewer connection.
 * - Validate and clamp finite title/body/tag; reject arbitrary URLs/paths.
 * - On click: focus existing viewer client or open same-origin root.
 */

self.addEventListener('install', () => {
  if (typeof self.skipWaiting === 'function') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  if (self.clients && typeof self.clients.claim === 'function') {
    event.waitUntil(self.clients.claim());
  }
});


self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    if (!event.data) return;

    let payload;
    try {
      payload = event.data.json();
    } catch {
      // Malformed JSON payload: safely ignore
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    // Clamp title, body, and tag to finite boundaries; reject arbitrary navigation URLs/paths
    const rawTitle = typeof payload.title === 'string' ? payload.title.trim() : '';
    const rawBody = typeof payload.body === 'string' ? payload.body.trim() : '';
    const rawTag = typeof payload.tag === 'string' ? payload.tag.trim() : undefined;

    const title = rawTitle.slice(0, 200);
    const body = rawBody.slice(0, 500);
    const tag = rawTag ? rawTag.slice(0, 100) : undefined;

    if (!title && !body) return;

    // Never silently consume a valid push, even if a window opens after send.
    // Connection-based duplicate prevention belongs on the server.
    // Display only title, body, and tag; never accept navigation targets.
    await self.registration.showNotification(title, {
      body,
      tag,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  if (event.notification && typeof event.notification.close === 'function') {
    event.notification.close();
  }

  event.waitUntil((async () => {
    try {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Focus existing viewer window if found
      for (const client of windowClients) {
        if ('focus' in client && typeof client.focus === 'function') {
          return await client.focus();
        }
      }

      // No open viewer window: open same origin root
      if (self.clients && typeof self.clients.openWindow === 'function') {
        return await self.clients.openWindow('/');
      }
    } catch {
      // Safe fallback
    }
  })());
});
