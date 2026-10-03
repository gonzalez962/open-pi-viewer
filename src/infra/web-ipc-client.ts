/**
 * Web IPC Client Shim for Browser Preview & Remote VPN / Mesh Network Access.
 *
 * When running inside native desktop Tauri, Tauri automatically provides
 * `window.__TAURI_INTERNALS__` and `window.isTauri`, so this shim remains inert.
 *
 * When loaded in a standard browser (e.g. mobile or laptop over Tailscale),
 * this shim intercepts Tauri IPC `invoke` and event `listen` calls and proxies
 * them to the Vite dev server's Web IPC Bridge (`/api/ipc` and `/api/events`).
 */

export function initWebIpcClient(): void {
  if (typeof window === 'undefined') return;

  const win = window as any;
  if (win.__TAURI_INTERNALS__) {
    // Native Tauri environment detected; do not override
    return;
  }

  let nextCallbackId = 1;
  const callbacks = new Map<number, (payload: any) => void>();
  const eventListeners = new Map<string, Set<number>>();

  // Connect SSE stream for real-time tokens, thinking blocks, and tool executions
  try {
    const sse = new EventSource('/api/events');
    sse.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (!msg || !msg.event) return;
        const set = eventListeners.get(msg.event);
        if (set && set.size > 0) {
          set.forEach((handlerId) => {
            const cb = callbacks.get(handlerId);
            if (cb) {
              cb({ event: msg.event, id: handlerId, payload: msg.payload });
            }
          });
        }
      } catch {}
    };
    sse.onerror = () => {
      // EventSource automatically retries connection
    };
  } catch (err) {
    console.warn('[Web IPC SSE] EventSource init failed:', err);
  }

  win.isTauri = true;
  win.__TAURI_INTERNALS__ = {
    callbacks,
    transformCallback(callback: (payload: any) => void, once?: boolean): number {
      const id = nextCallbackId++;
      callbacks.set(id, (arg: any) => {
        callback(arg);
        if (once) {
          callbacks.delete(id);
        }
      });
      return id;
    },
    unregisterCallback(id: number): void {
      callbacks.delete(id);
    },
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
      if (cmd === 'open_external_url') {
        const url = (args as any)?.url;
        if (url) {
          window.open(url, '_blank');
        }
        return true;
      }

      if (cmd === 'plugin:event|listen') {
        const ev = (args as any)?.event;
        const handler = (args as any)?.handler;
        if (ev && typeof handler === 'number') {
          if (!eventListeners.has(ev)) {
            eventListeners.set(ev, new Set());
          }
          eventListeners.get(ev)!.add(handler);
        }
        return handler;
      }

      if (cmd === 'plugin:event|unlisten') {
        const ev = (args as any)?.event;
        const eventId = (args as any)?.eventId;
        if (ev && typeof eventId === 'number' && eventListeners.has(ev)) {
          eventListeners.get(ev)!.delete(eventId);
        }
        return null;
      }

      const res = await fetch('/api/ipc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, args: args || {} }),
      });

      if (!res.ok) {
        throw new Error(`Web IPC HTTP error ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      return data.result;
    },
  };

  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(ev: string, id: number): void {
      if (ev && typeof id === 'number' && eventListeners.has(ev)) {
        eventListeners.get(ev)!.delete(id);
      }
    },
  };
}

// Auto-initialize when imported in browser context
initWebIpcClient();
