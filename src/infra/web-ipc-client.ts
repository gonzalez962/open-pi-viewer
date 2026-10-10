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
  const attachedSessions = new Map<string, Record<string, unknown>>();
  const publish = (event: string, payload: any) => {
    eventListeners.get(event)?.forEach((id) => callbacks.get(id)?.({ event, id, payload }));
  };

  // Reconnect after authorization so the stream adopts the new HttpOnly session.
  let sse: EventSource | null = null;
  const closeEvents = (): void => {
    if (sse) {
      sse.close();
      sse = null;
    }
  };

  const connectEvents = (ready?: () => void): void => {
    sse?.close();
    sse = new EventSource('/api/events');
    sse.onopen = () => {
      ready?.();
      // Reconcile missed output and dialogs whenever EventSource reconnects.
      for (const args of attachedSessions.values()) {
        void win.__TAURI_INTERNALS__.invoke('connect', { ...args, __reattach: true }).then((snapshot: any) => {
          const current = attachedSessions.get(snapshot.canonicalCwd);
          if ((current?.payload as any)?.sessionFile !== snapshot.sessionFile) return;
          publish('pi://event', { type: 'runtime_snapshot', cwd: snapshot.canonicalCwd, ...snapshot });
        }).catch((error: unknown) => console.warn('[Web IPC reattach]', error));
      }
    };
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
      // EventSource automatically retries connection, but if the session
      // expired on the server, probe /api/auth/status so idle clients
      // return to the login gate immediately rather than waiting for user IPC.
      void fetch('/api/auth/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
        .then((res) => {
          if (!res.ok) return null;
          return res.json();
        })
        .then((status) => {
          if (status && status.required === true && status.authenticated === false) {
            closeEvents();
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              const event =
                typeof CustomEvent !== 'undefined'
                  ? new CustomEvent('pi:web-auth-required')
                  : new Event('pi:web-auth-required');
              window.dispatchEvent(event);
            }
          }
        })
        .catch(() => {
          // Transient network error; EventSource handles reconnection
        });
    };
  };

  window.addEventListener('pi:web-auth-ready', () => {
    connectEvents();
  });

  window.addEventListener('pi:web-auth-required', () => {
    closeEvents();
  });

  window.addEventListener('pi:oauth-authorized', (event) => {
    const ready = (event as CustomEvent<{ ready?: () => void }>).detail?.ready;
    connectEvents(ready);
  });

  win.isTauri = true;
  win.__IS_WEB_IPC__ = true;
  win.__TAURI_INTERNALS__ = {
    __isWebIpc: true,
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
        if (res.status === 401) {
          closeEvents();
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            const authRequiredEvent =
              typeof CustomEvent !== 'undefined'
                ? new CustomEvent('pi:web-auth-required')
                : new Event('pi:web-auth-required');
            window.dispatchEvent(authRequiredEvent);
          }
        }
        throw new Error(`Web IPC HTTP error ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      if (cmd === 'connect' && !(args as any)?.__reattach && data.result?.sessionFile) {
        attachedSessions.set(data.result.canonicalCwd, {
          payload: { ...(args as any)?.payload, sessionFile: data.result.sessionFile, workingDirectory: data.result.canonicalCwd },
        });
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
