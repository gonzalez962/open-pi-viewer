import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Constants & Error Markers
// ---------------------------------------------------------------------------

export const OAUTH_UNAUTHORIZED_CODE = 'OAUTH_UNAUTHORIZED';
export const OAUTH_UNCONFIGURED_CODE = 'OAUTH_KEY_UNCONFIGURED';

export const OAUTH_UNAUTHORIZED_MESSAGE =
  'OAUTH_UNAUTHORIZED: Remote access key required for built-in OAuth management.';

export const OAUTH_UNCONFIGURED_MESSAGE =
  'OAUTH_KEY_UNCONFIGURED: PI_VIEWER_OAUTH_ACCESS_KEY environment variable is not configured on the server. Remote OAuth access is disabled.';

export const DEFAULT_COOKIE_NAME = 'pi_oauth_session';
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_MAX_SESSIONS = 1000;
export const DEFAULT_RATE_LIMIT_ATTEMPTS = 5;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const MAX_RATE_LIMIT_ENTRIES = 500;

export const PROTECTED_OAUTH_COMMANDS = new Set([
  'get_builtin_oauth_providers',
  'start_oauth_login',
  'cancel_oauth_login',
  'send_oauth_prompt_response',
  'logout_oauth_provider',
]);

/**
 * Checks whether an IPC command is part of the protected OAuth security perimeter.
 */
export function isOAuthCommand(cmd: string): boolean {
  return PROTECTED_OAUTH_COMMANDS.has(cmd);
}

/**
 * Tests whether an error or string represents an unauthorized or unconfigured OAuth access error.
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison using fixed-length SHA-256 digests.
 * Completely eliminates string length timing leaks.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed URI encoding fails closed
    return null;
  }
}

function isRequestTls(req: any): boolean {
  if (req?.socket?.encrypted || req?.connection?.encrypted) return true;
  return false;
}

/**
 * Validates same-origin request integrity:
 * - Checks Origin header matching Host
 * - Checks Referer header matching Host
 * - Checks Sec-Fetch-Site: same-origin for SSE / fetch requests that lack Origin
 * Strictly rejects cross-origin and arbitrary forwarded header spoofing.
 */
function validateSameOrigin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (!hostHeader) return false;

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (originHeader) {
    try {
      const parsed = new URL(originHeader);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return parsed.host.toLowerCase() === hostHeader.toLowerCase();
    } catch {
      return false;
    }
  }

  const refererHeader = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
  if (refererHeader) {
    try {
      const parsed = new URL(refererHeader);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return parsed.host.toLowerCase() === hostHeader.toLowerCase();
    } catch {
      return false;
    }
  }

  const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined;
  if (secFetchSite === 'same-origin') {
    return true;
  }

  return false;
}

function getClientIdentifier(req: any): string {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'default_client';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthRequest = IncomingMessage | {
  headers: Record<string, string | string[] | undefined>;
  socket?: any;
  connection?: any;
  url?: string;
  method?: string;
};

export type OAuthResponse = ServerResponse | {
  setHeader: (name: string, value: any) => void;
};

export interface OAuthSession {
  owner: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthAccessOptions {
  key?: string;
  cookieName?: string;
  sessionTtlMs?: number;
  maxSessions?: number;
  rateLimitMaxAttempts?: number;
  rateLimitWindowMs?: number;
  secure?: boolean;
  now?: () => number;
  developmentAnonymous?: boolean;
  localDevelopment?: boolean;
}

export interface OAuthAuthorizeSuccess {
  ok: true;
  status: 200;
  owner: string;
  expiresAt: number;
}

export interface OAuthAuthorizeFailure {
  ok: false;
  status: number;
  error: string;
}

export type OAuthAuthorizeResult = OAuthAuthorizeSuccess | OAuthAuthorizeFailure;

export interface OAuthAccessInstance {
  isConfigured: () => boolean;
  isDevelopmentAnonymous: () => boolean;
  authenticate: (req: OAuthRequest) => string | null;
  authorize: (
    req: OAuthRequest,
    res: OAuthResponse,
    body?: { key?: string } | string
  ) => Promise<OAuthAuthorizeResult> | OAuthAuthorizeResult;
  revoke: (
    req: OAuthRequest,
    res?: OAuthResponse
  ) => boolean;
  revokeByOwner: (owner: string) => number;
  requireOAuthOwner: (
    cmd: string,
    req: OAuthRequest
  ) => { ok: true; owner: string } | { ok: false; status: number; error: string };
  isOAuthCommand: (cmd: string) => boolean;
  getSessionsCount: () => number;
  pruneExpired: (timestamp?: number) => number;
  validateOwnerLease: (owner: string) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOAuthAccess(options: OAuthAccessOptions = {}): OAuthAccessInstance {
  const configuredKey = options.key ?? process.env.PI_VIEWER_OAUTH_ACCESS_KEY ?? '';
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;
  const sessionTtlMs = options.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  const maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
  const rateLimitMaxAttempts = options.rateLimitMaxAttempts || DEFAULT_RATE_LIMIT_ATTEMPTS;
  const rateLimitWindowMs = options.rateLimitWindowMs || DEFAULT_RATE_LIMIT_WINDOW_MS;
  const nowFn = options.now || (() => Date.now());

  // Determine if developmentAnonymous mode is active:
  // Explicit option takes precedence; otherwise defaults to true when no key is set.
  const isDevAnon =
    options.developmentAnonymous !== undefined
      ? options.developmentAnonymous
      : options.localDevelopment !== undefined
      ? options.localDevelopment
      : options.key !== undefined
      ? false
      : !configuredKey || configuredKey.trim().length === 0;

  // In-memory token -> session mapping
  const sessions = new Map<string, OAuthSession>();

  // Rate limit tracking: clientId -> { count, resetAt }
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  const isConfigured = (): boolean => {
    return isDevAnon || Boolean(configuredKey && configuredKey.trim().length > 0);
  };

  const isDevelopmentAnonymous = (): boolean => {
    return isDevAnon;
  };

  const pruneExpired = (timestamp?: number): number => {
    const now = timestamp ?? nowFn();
    let pruned = 0;
    for (const [token, session] of sessions.entries()) {
      if (now >= session.expiresAt) {
        sessions.delete(token);
        pruned++;
      }
    }
    return pruned;
  };

  const pruneRateLimits = (now: number): void => {
    for (const [ip, entry] of rateLimits.entries()) {
      if (now >= entry.resetAt) {
        rateLimits.delete(ip);
      }
    }
  };

  const authenticate = (req: OAuthRequest): string | null => {
    if (!isConfigured()) {
      return null;
    }

    const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined;
    const token = parseCookie(cookieHeader, cookieName);
    if (!token) {
      return null;
    }

    const session = sessions.get(token);
    if (!session) {
      return null;
    }

    const now = nowFn();
    if (now >= session.expiresAt) {
      sessions.delete(token);
      return null;
    }

    return session.owner;
  };

  const validateOwnerLease = (owner: string): boolean => {
    if (!owner) return false;
    const now = nowFn();
    for (const [, session] of sessions.entries()) {
      if (session.owner === owner && session.expiresAt > now) {
        return true;
      }
    }
    return false;
  };

  const authorize = (
    req: OAuthRequest,
    res: OAuthResponse,
    body?: { key?: string } | string
  ): OAuthAuthorizeResult => {
    const now = nowFn();

    if (!isConfigured()) {
      return {
        ok: false,
        status: 503,
        error: OAUTH_UNCONFIGURED_MESSAGE,
      };
    }

    if (!validateSameOrigin(req)) {
      return {
        ok: false,
        status: 403,
        error: 'Origin validation failed: access denied',
      };
    }

    // In keyed mode, validate server access key
    if (!isDevAnon) {
      const clientId = getClientIdentifier(req);
      pruneRateLimits(now);
      const rlEntry = rateLimits.get(clientId);
      if (rlEntry && rlEntry.count >= rateLimitMaxAttempts && now < rlEntry.resetAt) {
        return {
          ok: false,
          status: 429,
          error: 'Too many failed authorization attempts. Please try again later.',
        };
      }

      let parsedBody: any = body;
      if (typeof body === 'string') {
        try {
          parsedBody = JSON.parse(body || '{}');
        } catch {
          return {
            ok: false,
            status: 400,
            error: 'Invalid JSON request body',
          };
        }
      }

      const candidateKey = parsedBody?.key;
      if (typeof candidateKey !== 'string' || candidateKey.trim().length === 0) {
        return {
          ok: false,
          status: 400,
          error: 'Missing access key in request',
        };
      }

      if (!timingSafeCompare(candidateKey, configuredKey)) {
        // Record failed attempt
        const entry = rateLimits.get(clientId);
        if (!entry || now >= entry.resetAt) {
          if (rateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
            rateLimits.clear();
          }
          rateLimits.set(clientId, { count: 1, resetAt: now + rateLimitWindowMs });
        } else {
          entry.count++;
        }

        return {
          ok: false,
          status: 401,
          error: 'Invalid access key',
        };
      }

      // Reset rate limit on success
      rateLimits.delete(clientId);
    }

    // Reuse existing owner if caller already holds a valid session (rotate token)
    const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined;
    const existingToken = parseCookie(cookieHeader, cookieName);
    let owner: string;

    if (existingToken && sessions.has(existingToken)) {
      const existingSession = sessions.get(existingToken)!;
      if (now < existingSession.expiresAt) {
        owner = existingSession.owner;
      } else {
        owner = `owner_${crypto.randomBytes(8).toString('hex')}`;
      }
      sessions.delete(existingToken); // rotate old token
    } else {
      owner = `owner_${crypto.randomBytes(8).toString('hex')}`;
    }

    // High entropy token (32 bytes hex = 256 bits of entropy)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + sessionTtlMs;

    // Prune expired sessions to bound memory
    pruneExpired(now);

    // If still at capacity, evict oldest session
    if (sessions.size >= maxSessions) {
      let oldestToken: string | null = null;
      let oldestTime = Infinity;
      for (const [t, s] of sessions.entries()) {
        if (s.createdAt < oldestTime) {
          oldestTime = s.createdAt;
          oldestToken = t;
        }
      }
      if (oldestToken) {
        sessions.delete(oldestToken);
      }
    }

    sessions.set(token, {
      owner,
      createdAt: now,
      expiresAt,
    });

    const isSecure = options.secure ?? isRequestTls(req);
    const maxAgeSeconds = Math.floor(sessionTtlMs / 1000);
    const cookieHeaderValue = `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${
      isSecure ? '; Secure' : ''
    }`;

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Set-Cookie', cookieHeaderValue);
    }

    return {
      ok: true,
      status: 200,
      owner,
      expiresAt,
    };
  };

  const revoke = (
    req: OAuthRequest,
    res?: OAuthResponse
  ): boolean => {
    const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined;
    const token = parseCookie(cookieHeader, cookieName);
    let removed = false;
    if (token && sessions.has(token)) {
      sessions.delete(token);
      removed = true;
    }

    if (res && typeof res.setHeader === 'function') {
      const isSecure = options.secure ?? isRequestTls(req);
      const clearCookie = `${cookieName}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${
        isSecure ? '; Secure' : ''
      }`;
      res.setHeader('Set-Cookie', clearCookie);
    }

    return removed;
  };

  const revokeByOwner = (owner: string): number => {
    let count = 0;
    for (const [token, session] of sessions.entries()) {
      if (session.owner === owner) {
        sessions.delete(token);
        count++;
      }
    }
    return count;
  };

  const requireOAuthOwner = (
    cmd: string,
    req: OAuthRequest
  ): { ok: true; owner: string } | { ok: false; status: number; error: string } => {
    if (!isOAuthCommand(cmd)) {
      return { ok: true, owner: '' };
    }

    if (!isConfigured()) {
      return {
        ok: false,
        status: 503,
        error: OAUTH_UNCONFIGURED_MESSAGE,
      };
    }

    if (!validateSameOrigin(req)) {
      return {
        ok: false,
        status: 403,
        error: 'Origin validation failed: access denied',
      };
    }

    const owner = authenticate(req);
    if (!owner) {
      return {
        ok: false,
        status: 401,
        error: OAUTH_UNAUTHORIZED_MESSAGE,
      };
    }

    return { ok: true, owner };
  };

  const getSessionsCount = (): number => {
    return sessions.size;
  };

  return {
    isConfigured,
    isDevelopmentAnonymous,
    authenticate,
    authorize,
    revoke,
    revokeByOwner,
    requireOAuthOwner,
    isOAuthCommand,
    getSessionsCount,
    pruneExpired,
    validateOwnerLease,
  };
}
