import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createOAuthAccess, DEFAULT_RATE_LIMIT_ATTEMPTS, DEFAULT_RATE_LIMIT_WINDOW_MS, type OAuthAccessInstance } from './oauth-access';
import { verifyTurnstile } from './turnstile';

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

export const DEFAULT_WEB_AUTH_COOKIE_NAME = 'pi_viewer_auth_session';
export const DEFAULT_WEB_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_LOGIN_BODY_BYTES = 8192;

export interface WebAuthConfig {
  enabled: boolean;
  key?: string;
  secureCookie?: boolean;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
}

export interface WebAuthOptions {
  enabled?: boolean;
  key?: string;
  secureCookie?: boolean;
  cookieName?: string;
  sessionTtlMs?: number;
  maxSessions?: number;
  rateLimitMaxAttempts?: number;
  rateLimitWindowMs?: number;
  now?: () => number;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  turnstileFetch?: typeof fetch;
}

export interface WebAuthSession {
  owner: string;
  expiresAt: number;
}

export interface SseClientRecord {
  res: ServerResponse | any;
  req: IncomingMessage | any;
  timer: NodeJS.Timeout | null;
}

export interface WebAuthInstance {
  isEnabled: () => boolean;
  authenticate: (req: IncomingMessage | any) => string | null;
  handleStatus: (req: IncomingMessage | any, res: ServerResponse | any) => void;
  handleLogin: (req: IncomingMessage | any, res: ServerResponse | any, directBody?: any) => Promise<void>;
  handleLogout: (req: IncomingMessage | any, res: ServerResponse | any) => void;
  middleware: (
    req: IncomingMessage | any,
    res: ServerResponse | any,
    next: (err?: any) => void
  ) => void | Promise<void>;
  registerSseStream: (owner: string, req: IncomingMessage | any, res: ServerResponse | any) => void;
  terminateSseForOwner: (owner: string) => number;
  pruneExpired: (timestamp?: number) => number;
  dispose: () => void;
  getActiveSseCount: () => number;
  getSessionsCount: () => number;
}

// ---------------------------------------------------------------------------
// Configuration Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves and strictly validates environment variables for web authentication:
 * - PI_VIEWER_AUTH_ENABLED: strict "true" or "false" (defaults to false).
 * - PI_VIEWER_AUTH_KEY: required and non-blank when auth is enabled; fails startup otherwise.
 * - PI_VIEWER_AUTH_SECURE_COOKIE: explicit "true" enables Secure cookie attribute.
 */
export function resolveWebAuthConfig(
  env: Record<string, string | undefined> = process.env
): WebAuthConfig {
  const rawEnabled = env.PI_VIEWER_AUTH_ENABLED;
  let enabled = false;

  if (rawEnabled !== undefined && rawEnabled !== '') {
    const trimmed = rawEnabled.trim();
    if (trimmed === 'true') {
      enabled = true;
    } else if (trimmed === 'false') {
      enabled = false;
    } else {
      throw new Error(
        `Invalid PI_VIEWER_AUTH_ENABLED value "${rawEnabled}". Expected strictly "true" or "false".`
      );
    }
  }

  const rawKey = env.PI_VIEWER_AUTH_KEY;
  if (enabled) {
    if (!rawKey || rawKey.trim().length === 0) {
      throw new Error(
        'PI_VIEWER_AUTH_KEY must be configured and non-blank when PI_VIEWER_AUTH_ENABLED is "true".'
      );
    }
  }

  const rawSecure = env.PI_VIEWER_AUTH_SECURE_COOKIE;
  let secureCookie = false;
  if (rawSecure !== undefined && rawSecure !== '') {
    secureCookie = rawSecure.trim() === 'true';
  }

  const turnstileSiteKey = env.PI_VIEWER_TURNSTILE_SITE_KEY?.trim() || undefined;
  const turnstileSecretKey = env.PI_VIEWER_TURNSTILE_SECRET_KEY?.trim() || undefined;
  validateTurnstileConfig(enabled, turnstileSiteKey, turnstileSecretKey);
  return {
    enabled,
    key: enabled ? rawKey : undefined,
    secureCookie,
    ...(turnstileSiteKey ? { turnstileSiteKey, turnstileSecretKey } : {}),
  };
}

function validateTurnstileConfig(enabled: boolean, siteKey?: string, secretKey?: string): void {
  if (Boolean(siteKey) !== Boolean(secretKey)) {
    throw new Error('Turnstile requires both PI_VIEWER_TURNSTILE_SITE_KEY and PI_VIEWER_TURNSTILE_SECRET_KEY.');
  }
  if (siteKey && !enabled) {
    throw new Error('Turnstile requires PI_VIEWER_AUTH_ENABLED="true".');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates same-origin request integrity:
 * - Origin header matching Host
 * - Referer header matching Host
 * - Sec-Fetch-Site: same-origin
 * Rejects cross-origin requests and never trusts forwarded headers.
 */
export function validateSameOrigin(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
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

  const secFetchSite =
    typeof req.headers['sec-fetch-site'] === 'string'
      ? req.headers['sec-fetch-site']
      : undefined;
  if (secFetchSite === 'same-origin') {
    return true;
  }

  return false;
}

export function normalizeApiPath(urlStr: string): string {
  try {
    const parsed = new URL(urlStr, 'http://localhost');
    let norm = path.posix.normalize(parsed.pathname);
    norm = norm.replace(/\/+$/, '') || '/';
    return norm;
  } catch {
    return urlStr.split('?')[0].replace(/\/+$/, '') || '/';
  }
}

function sendJsonResponse(res: any, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function readBody(req: any, maxBytes: number = MAX_LOGIN_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof req.body === 'string') return resolve(req.body);
    if (req.body && typeof req.body === 'object') return resolve(JSON.stringify(req.body));

    let data = '';
    let tooLarge = false;

    req.on('data', (chunk: any) => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) {
        tooLarge = true;
        reject(new Error('PAYLOAD_TOO_LARGE'));
      }
    });

    req.on('end', () => {
      if (!tooLarge) resolve(data);
    });

    req.on('error', (err: any) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebAuth(options: WebAuthOptions = {}): WebAuthInstance {
  const isEnabled = options.enabled ?? false;
  const configuredKey = options.key ?? '';
  const cookieName = options.cookieName || DEFAULT_WEB_AUTH_COOKIE_NAME;
  const sessionTtlMs = options.sessionTtlMs || DEFAULT_WEB_AUTH_SESSION_TTL_MS;
  const nowFn = options.now || (() => Date.now());
  const turnstileSiteKey = options.turnstileSiteKey?.trim() || undefined;
  const turnstileSecretKey = options.turnstileSecretKey?.trim() || undefined;
  validateTurnstileConfig(isEnabled, turnstileSiteKey, turnstileSecretKey);
  const attemptLimit = options.rateLimitMaxAttempts || DEFAULT_RATE_LIMIT_ATTEMPTS;
  const attemptWindow = options.rateLimitWindowMs || DEFAULT_RATE_LIMIT_WINDOW_MS;
  const attempts = new Map<string, { count: number; resetAt: number }>();
  let disposed = false;

  // Reserve before awaiting Siteverify: concurrent requests cannot race admission.
  const admitTurnstileAttempt = (req: any): boolean => {
    const now = nowFn();
    for (const [ip, entry] of attempts) if (now >= entry.resetAt) attempts.delete(ip);
    const ip = req.socket?.remoteAddress || 'unknown';
    const entry = attempts.get(ip);
    if (entry) {
      if (entry.count >= attemptLimit) return false;
      entry.count++;
    } else {
      // Never clear active counters on pressure: reject new addresses fail-closed.
      if (attempts.size >= 4096) return false;
      attempts.set(ip, { count: 1, resetAt: now + attemptWindow });
    }
    return true;
  };

  if (isEnabled && (!configuredKey || configuredKey.trim().length === 0)) {
    throw new Error(
      'PI_VIEWER_AUTH_KEY must be configured and non-blank when PI_VIEWER_AUTH_ENABLED is "true".'
    );
  }

  // Explicit PI_VIEWER_AUTH_SECURE_COOKIE or options.secureCookie
  const isSecure =
    options.secureCookie !== undefined
      ? options.secureCookie
      : process.env.PI_VIEWER_AUTH_SECURE_COOKIE === 'true';

  // Instantiate distinct OAuth access instance for web auth session & rate limit management
  const oauthAccess: OAuthAccessInstance = createOAuthAccess({
    key: configuredKey,
    cookieName,
    developmentAnonymous: !isEnabled,
    secure: isSecure,
    sessionTtlMs,
    maxSessions: options.maxSessions,
    rateLimitMaxAttempts: options.rateLimitMaxAttempts,
    rateLimitWindowMs: options.rateLimitWindowMs,
    now: nowFn,
  });

  // Track active SSE streams per session owner for expiration / logout lease cleanup
  const activeSseClients = new Map<string, Set<SseClientRecord>>();
  const ownerExpiresAt = new Map<string, number>();

  const isEnabledFn = (): boolean => isEnabled;

  const authenticate = (req: any): string | null => {
    return oauthAccess.authenticate(req);
  };

  const terminateStreamRecord = (record: SseClientRecord, owner?: string): void => {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    try {
      if (!record.res.writableEnded && !record.res.destroyed) {
        record.res.end();
      }
    } catch {
      // Stream write may fail if client already severed connection
    }
    if (owner) {
      const set = activeSseClients.get(owner);
      if (set) {
        set.delete(record);
        if (set.size === 0) activeSseClients.delete(owner);
      }
    }
  };

  const registerSseStream = (owner: string, req: any, res: any): void => {
    let set = activeSseClients.get(owner);
    if (!set) {
      set = new Set();
      activeSseClients.set(owner, set);
    }

    const now = nowFn();
    const expiresAt = ownerExpiresAt.get(owner) ?? now + sessionTtlMs;
    const delay = Math.max(0, expiresAt - now);

    const record: SseClientRecord = {
      res,
      req,
      timer: null,
    };

    record.timer = setTimeout(() => {
      terminateStreamRecord(record, owner);
      oauthAccess.pruneExpired(nowFn());
    }, delay);

    req.on('close', () => {
      if (record.timer) {
        clearTimeout(record.timer);
        record.timer = null;
      }
      set?.delete(record);
      if (set && set.size === 0) {
        activeSseClients.delete(owner);
      }
    });

    set.add(record);
  };

  const terminateSseForOwner = (owner: string): number => {
    const set = activeSseClients.get(owner);
    if (!set) return 0;
    let count = 0;
    for (const record of set) {
      terminateStreamRecord(record);
      count++;
    }
    activeSseClients.delete(owner);
    ownerExpiresAt.delete(owner);
    return count;
  };

  const pruneExpired = (timestamp?: number): number => {
    const now = timestamp ?? nowFn();
    const pruned = oauthAccess.pruneExpired(now);
    for (const owner of ownerExpiresAt.keys()) {
      if (!oauthAccess.validateOwnerLease(owner)) {
        terminateSseForOwner(owner);
        ownerExpiresAt.delete(owner);
      }
    }
    for (const [owner, set] of Array.from(activeSseClients.entries())) {
      if (!oauthAccess.validateOwnerLease(owner)) {
        for (const record of set) {
          terminateStreamRecord(record);
        }
        activeSseClients.delete(owner);
        ownerExpiresAt.delete(owner);
      }
    }
    return pruned;
  };

  const handleStatus = (req: any, res: any): void => {
    if (req.method !== 'GET') {
      sendJsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!isEnabled) {
      sendJsonResponse(res, 200, { required: false, authenticated: true });
      return;
    }

    const owner = authenticate(req);
    const authenticated = owner !== null;
    sendJsonResponse(res, 200, { required: true, authenticated, ...(turnstileSiteKey ? { turnstileSiteKey } : {}) });
  };

  const handleLogin = async (req: any, res: any, directBody?: any): Promise<void> => {
    if (req.method !== 'POST') {
      sendJsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
      sendJsonResponse(res, 400, { error: 'JSON POST required' });
      return;
    }

    let bodyStr: string;
    if (directBody !== undefined) {
      bodyStr = typeof directBody === 'string' ? directBody : JSON.stringify(directBody);
      if (Buffer.byteLength(bodyStr) > MAX_LOGIN_BODY_BYTES) {
        sendJsonResponse(res, 413, { error: 'Request body too large' });
        return;
      }
    } else {
      try {
        bodyStr = await readBody(req, MAX_LOGIN_BODY_BYTES);
      } catch (err: any) {
        if (err?.message === 'PAYLOAD_TOO_LARGE') {
          sendJsonResponse(res, 413, { error: 'Request body too large' });
          return;
        }
        sendJsonResponse(res, 400, { error: 'Invalid request body' });
        return;
      }
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyStr || '{}');
    } catch {
      sendJsonResponse(res, 400, { error: 'Invalid JSON request body' });
      return;
    }

    if (!isEnabled) {
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (turnstileSecretKey) {
      if (!validateSameOrigin(req)) {
        sendJsonResponse(res, 403, { error: 'Origin validation failed: access denied' });
        return;
      }
      if (disposed) {
        sendJsonResponse(res, 503, { error: 'Web authentication unavailable' });
        return;
      }
      if (!admitTurnstileAttempt(req)) {
        sendJsonResponse(res, 429, { error: 'Too many login attempts. Please try again later.' });
        return;
      }
      const token = parsed?.turnstileToken;
      if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
        sendJsonResponse(res, 400, { error: 'Missing or invalid Turnstile token' });
        return;
      }
      const verification = await verifyTurnstile(turnstileSecretKey, token, req.headers.host, options.turnstileFetch);
      if (verification !== 'valid' || disposed) {
        const unavailable = verification === 'unavailable' || disposed;
        sendJsonResponse(res, unavailable ? 503 : 403, {
          error: unavailable ? 'Turnstile verification unavailable. Please try again.' : 'Turnstile verification failed. Please try again.',
        });
        return;
      }
    }

    const candidateKey = parsed?.key;
    if (typeof candidateKey !== 'string' || candidateKey.trim().length === 0) {
      sendJsonResponse(res, 400, { error: 'Missing or invalid access key in request' });
      return;
    }

    const result = await oauthAccess.authorize(req, res, parsed);
    if (result.ok) {
      pruneExpired();
      ownerExpiresAt.set(result.owner, result.expiresAt);
      sendJsonResponse(res, 200, { ok: true });
    } else {
      sendJsonResponse(res, result.status, { error: result.error });
    }
  };

  const handleLogout = (req: any, res: any): void => {
    if (req.method !== 'POST') {
      sendJsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (isEnabled && !validateSameOrigin(req)) {
      sendJsonResponse(res, 403, { error: 'Origin validation failed: access denied' });
      return;
    }

    if (!isEnabled) {
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    const owner = authenticate(req);
    oauthAccess.revoke(req, res);
    if (owner) {
      terminateSseForOwner(owner);
    }

    sendJsonResponse(res, 200, { ok: true });
  };

  const middleware = (
    req: any,
    res: any,
    next: (err?: any) => void
  ): void | Promise<void> => {
    const rawUrl = req.originalUrl || req.url || '/';
    const pathname = normalizeApiPath(rawUrl);
    const routePath = pathname.toLowerCase();

    // Connect mounts routes case-insensitively; guard the same perimeter.
    if (!routePath.startsWith('/api')) {
      next();
      return;
    }

    // Reject case aliases and SSE mount suffixes so no stream escapes its lease.
    if (isEnabled && (pathname !== routePath ||
      (routePath.startsWith('/api/events') && routePath !== '/api/events'))) {
      sendJsonResponse(res, 404, { error: 'Unknown API route' });
      return;
    }

    // Bootstrap routes (exact match on normalized path)
    if (pathname === '/api/auth/status') {
      handleStatus(req, res);
      return;
    }

    if (pathname === '/api/auth/login') {
      return handleLogin(req, res);
    }

    if (pathname === '/api/auth/logout') {
      handleLogout(req, res);
      return;
    }

    // Auth disabled: allow all privileged routes
    if (!isEnabled) {
      next();
      return;
    }

    // Privileged routes in enabled mode:
    // 1. Same-Origin Check
    if (!validateSameOrigin(req)) {
      sendJsonResponse(res, 403, { error: 'Origin validation failed: access denied' });
      return;
    }

    // 2. Authentication Check
    const owner = authenticate(req);
    if (!owner) {
      sendJsonResponse(res, 401, { error: 'Unauthorized: Web login session required' });
      return;
    }

    // 3. Register SSE stream lease for /api/events
    if (pathname === '/api/events') {
      pruneExpired();
      if (getActiveSseCount() >= 256 || (activeSseClients.get(owner)?.size ?? 0) >= 8) {
        sendJsonResponse(res, 429, { error: 'Too many active event streams' });
        return;
      }
      registerSseStream(owner, req, res);
    }

    next();
  };

  const dispose = (): void => {
    disposed = true;
    attempts.clear();
    for (const [, set] of activeSseClients) {
      for (const record of set) {
        terminateStreamRecord(record);
      }
    }
    activeSseClients.clear();
    ownerExpiresAt.clear();
  };

  const getActiveSseCount = (): number => {
    let count = 0;
    for (const set of activeSseClients.values()) {
      count += set.size;
    }
    return count;
  };

  const getSessionsCount = (): number => {
    return oauthAccess.getSessionsCount();
  };

  return {
    isEnabled: isEnabledFn,
    authenticate,
    handleStatus,
    handleLogin,
    handleLogout,
    middleware,
    registerSseStream,
    terminateSseForOwner,
    pruneExpired,
    dispose,
    getActiveSseCount,
    getSessionsCount,
  };
}
