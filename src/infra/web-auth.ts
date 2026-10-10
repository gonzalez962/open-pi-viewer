/**
 * Web Authentication Client Infrastructure.
 *
 * Provides status checking, credential-based login, logout, and
 * event signaling for the optional web access gate.
 * All functions are dependency-injectable for testability and
 * treat credentials as ephemeral input without persistence or logging.
 */

export interface WebAuthStatus {
  required: boolean;
  authenticated: boolean;
  turnstileSiteKey?: string;
}

export interface WebAuthLoginResponse {
  ok: boolean;
  error?: string;
}

export const WEB_AUTH_READY_EVENT = 'pi:web-auth-ready';
export const WEB_AUTH_REQUIRED_EVENT = 'pi:web-auth-required';

export interface WebAuthClientOptions {
  fetchFn?: typeof fetch;
  eventTarget?: EventTarget;
}

export interface WebAuthLoginOptions extends WebAuthClientOptions {
  turnstileToken?: string;
}

/**
 * Checks authentication status from the web backend.
 * Fails closed on network error or unexpected payload structure.
 */
export async function checkAuthStatus(
  options?: WebAuthClientOptions
): Promise<WebAuthStatus> {
  const fetchFn = options?.fetchFn ?? fetch;
  const res = await fetchFn('/api/auth/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to check auth status: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof data.required !== 'boolean' ||
    typeof data.authenticated !== 'boolean'
  ) {
    throw new Error('Malformed auth status response');
  }

  const status: WebAuthStatus = {
    required: data.required,
    authenticated: data.authenticated,
  };

  if ('turnstileSiteKey' in data && data.turnstileSiteKey !== undefined) {
    if (
      typeof data.turnstileSiteKey !== 'string' ||
      !data.turnstileSiteKey.trim()
    ) {
      throw new Error('Malformed auth status response');
    }
    status.turnstileSiteKey = data.turnstileSiteKey;
  }

  return status;
}

/**
 * Submits an authentication key to the server.
 * Never persists or logs credentials.
 */
export async function loginWithKey(
  key: string,
  options?: WebAuthLoginOptions
): Promise<WebAuthLoginResponse> {
  const fetchFn = options?.fetchFn ?? fetch;
  const payload: { key: string; turnstileToken?: string } = { key };
  if (typeof options?.turnstileToken === 'string' && options.turnstileToken.length > 0) {
    payload.turnstileToken = options.turnstileToken;
  }

  const res = await fetchFn('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    return { ok: true };
  }

  let errorMessage: string | undefined;
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') {
      errorMessage = data.error;
    }
  } catch {
    // Non-JSON error body fallback
  }

  return {
    ok: false,
    error: errorMessage ?? `Login failed: HTTP ${res.status}`,
  };
}

/**
 * Revokes current authenticated session.
 */
export async function logout(options?: WebAuthClientOptions): Promise<void> {
  const fetchFn = options?.fetchFn ?? fetch;
  const res = await fetchFn('/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    // HTTP 401 indicates the session is already revoked or expired on the server
    if (res.status === 401) {
      return;
    }
    throw new Error(`Logout failed: HTTP ${res.status}`);
  }
}

/**
 * Emits the readiness event signaling that authentication is either disabled
 * or successfully verified, allowing EventSource and App mounting.
 */
export function emitWebAuthReady(options?: { eventTarget?: EventTarget }): void {
  const target =
    options?.eventTarget ??
    (typeof window !== 'undefined' ? window : undefined);
  if (target && typeof target.dispatchEvent === 'function') {
    const event =
      typeof CustomEvent !== 'undefined'
        ? new CustomEvent(WEB_AUTH_READY_EVENT)
        : new Event(WEB_AUTH_READY_EVENT);
    target.dispatchEvent(event);
  }
}

/**
 * Emits the event signaling that valid authentication is required
 * (e.g. on 401 response or explicit logout).
 */
export function emitWebAuthRequired(options?: {
  eventTarget?: EventTarget;
}): void {
  const target =
    options?.eventTarget ??
    (typeof window !== 'undefined' ? window : undefined);
  if (target && typeof target.dispatchEvent === 'function') {
    const event =
      typeof CustomEvent !== 'undefined'
        ? new CustomEvent(WEB_AUTH_REQUIRED_EVENT)
        : new Event(WEB_AUTH_REQUIRED_EVENT);
    target.dispatchEvent(event);
  }
}

/** Confirm before revoking browser access; never stops Pi processes. */
export async function confirmWebLogout(message: string, confirmFn: (message: string) => boolean = message => window.confirm(message), revoke: () => Promise<void> = () => logout()): Promise<boolean> {
  if (!confirmFn(message)) return false;
  await revoke();
  return true;
}
