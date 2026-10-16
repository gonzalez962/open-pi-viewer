// ---------------------------------------------------------------------------
// Error Detection & Environment
// ---------------------------------------------------------------------------

export const OAUTH_UNAUTHORIZED_CODE = 'OAUTH_UNAUTHORIZED';
export const OAUTH_UNCONFIGURED_CODE = 'OAUTH_KEY_UNCONFIGURED';

/**
 * Detects whether the application is running inside the browser shim (Web IPC Bridge)
 * rather than native desktop Tauri.
 */
export function isWebShim(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as any;
  return Boolean(win.__IS_WEB_IPC__ || win.__TAURI_INTERNALS__?.__isWebIpc);
}

/**
 * Checks whether an error or string indicates an unauthorized or unconfigured OAuth access error.
 */
export function isOAuthUnauthorizedError(err: unknown): boolean {
  if (!err) return false;
  const str = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  return (
    str.includes(OAUTH_UNAUTHORIZED_CODE) ||
    str.includes(OAUTH_UNCONFIGURED_CODE) ||
    str.toLowerCase().includes('remote access key required') ||
    str.toLowerCase().includes('oauth access is disabled')
  );
}

// ---------------------------------------------------------------------------
// Browser Client Authorization
// ---------------------------------------------------------------------------

export interface AuthorizeWebOAuthOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
}

export interface AuthorizeWebOAuthResult {
  ok: boolean;
  error?: string | null;
  owner?: string | null;
}

/**
 * Authorizes a browser session with the server.
 *
 * In development anonymous mode, no key is required (sends `{}`).
 * In keyed mode, sends the access key via POST /api/oauth/authorize.
 *
 * Rules:
 * - Sends key via POST /api/oauth/authorize with JSON body and credentials: 'same-origin'.
 * - Never includes key in URL query params.
 * - Never logs key or persists key to local/session storage.
 * - Dispatches 'pi:oauth-authorized' CustomEvent with detail { ready: Function } so the parent
 *   web-ipc-client can reconnect private SSE with the new cookie.
 * - Awaits SSE ready callback before resolving, with a bounded timeout.
 */
export async function authorizeWebOAuth(
  key?: string,
  options: AuthorizeWebOAuthOptions = {}
): Promise<AuthorizeWebOAuthResult> {
  const trimmedKey = (key || '').trim();
  const bodyPayload = trimmedKey ? { key: trimmedKey } : {};

  const fetcher = options.fetchFn ?? fetch;
  const endpoint = options.endpoint || '/api/oauth/authorize';
  const timeoutMs = options.timeoutMs ?? 5000;

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(bodyPayload),
    });
  } catch (networkErr) {
    return {
      ok: false,
      error: networkErr instanceof Error ? networkErr.message : 'Network error during authorization',
    };
  }

  if (!response.ok) {
    let errorMsg = `Authorization failed (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error) {
        errorMsg = data.error;
      }
    } catch {
      // Non-JSON error response
    }
    return { ok: false, error: errorMsg };
  }

  let owner: string | null = null;
  try {
    const data = await response.json();
    owner = data?.owner || null;
  } catch {
    // Response had no JSON body, but status was 200
  }

  // Await private SSE reconnection via parent event contract
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Timed out waiting for private SSE connection'));
          }
        }, timeoutMs);

        const onReady = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        };

        const event = new CustomEvent('pi:oauth-authorized', {
          detail: { ready: onReady },
        });
        window.dispatchEvent(event);
      });
    } catch (sseErr) {
      return {
        ok: false,
        error: sseErr instanceof Error ? sseErr.message : 'SSE stream reconnection failed',
      };
    }
  }

  return { ok: true, owner };
}

let activeSessionInit: Promise<AuthorizeWebOAuthResult> | null = null;

/**
 * Ensures an active web OAuth session cookie exists before issuing OAuth IPC commands or listeners.
 * In desktop mode (isWebShim() === false), resolves immediately as a no-op.
 * In web shim mode, requests an anonymous or existing session from /api/oauth/authorize and waits
 * for SSE reconnection before allowing OAuth operations to proceed.
 */
export async function ensureWebOAuthSession(
  options: AuthorizeWebOAuthOptions = {}
): Promise<AuthorizeWebOAuthResult> {
  if (!isWebShim()) {
    return { ok: true };
  }

  if (activeSessionInit) {
    return activeSessionInit;
  }

  activeSessionInit = authorizeWebOAuth(undefined, options)
    .then((res) => {
      if (!res.ok) {
        activeSessionInit = null; // allow retry on failure
      }
      return res;
    })
    .catch((err) => {
      activeSessionInit = null;
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    });

  return activeSessionInit;
}

export function resetWebOAuthSessionForTest(): void {
  activeSessionInit = null;
}

