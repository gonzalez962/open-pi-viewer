import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import webpush from 'web-push';
import { validateSameOrigin, type WebAuthInstance } from './web-auth';

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

export const MAX_PUSH_BODY_BYTES = 32768; // 32KB
export const DEFAULT_MAX_SUBSCRIPTIONS = 256;
export const DEFAULT_MAX_IN_FLIGHT = 8;
export const DEFAULT_SEND_TIMEOUT_MS = 5000;
export const MAX_PROJECTS_PER_SUB = 100;

export const LEGITIMATE_PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
]);

export interface WebPushConfig {
  available: boolean;
  publicKey?: string;
  privateKey?: string;
  subject?: string;
}

export interface SyncedProject {
  path: string;
  customName?: string;
}

export interface NotificationPreferences {
  enabled: boolean;
  sound?: boolean;
  suppressWhenFocused?: boolean;
  onTaskComplete?: boolean;
  onWaitingInput?: boolean;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface PushSubscriptionRecord {
  subscription: PushSubscriptionData;
  preferences: NotificationPreferences;
  language: 'en' | 'es';
  projects: SyncedProject[];
  owner: string;
  createdAt: number;
}

export interface WebPushOptions {
  webAuth?: WebAuthInstance;
  config?: WebPushConfig;
  env?: Record<string, string | undefined>;
  sendNotification?: (sub: PushSubscriptionData, payload: string, options?: any) => Promise<any>;
  gitResolver?: (cwd: string) => string | null;
  allowedHosts?: string[];
  maxSubscriptions?: number;
  maxInFlight?: number;
  sendTimeoutMs?: number;
  now?: () => number;
  isOwnerConnected?: (owner: string) => boolean;
}

export interface WebPushService {
  getRequestOwner: (req: any) => string | null;
  isOwnerAuthorized: (owner: string) => boolean;
  isConfigured: () => boolean;
  getPublicKey: () => string | undefined;
  handleConfig: (req: IncomingMessage | any, res: ServerResponse | any) => Promise<void>;
  handleSubscriptions: (
    req: IncomingMessage | any,
    res: ServerResponse | any
  ) => Promise<void>;
  dispatchPushEvent: (event: {
    type: string;
    cwd?: string;
    [key: string]: any;
  }) => Promise<void>;
  getSubscriptionsCount: () => number;
  getSubscription: (endpoint: string) => PushSubscriptionRecord | undefined;
  clearSubscriptions: () => void;
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Config Resolver
// ---------------------------------------------------------------------------

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export function validateVapidKeys(
  subject?: string,
  publicKey?: string,
  privateKey?: string
): boolean {
  if (!subject || !publicKey || !privateKey) return false;
  if (/[\r\n]/.test(subject) || /[\r\n]/.test(publicKey) || /[\r\n]/.test(privateKey)) return false;
  if (!subject.startsWith('mailto:') && !subject.startsWith('https:')) return false;

  // Public key: uncompressed P-256 point (65 bytes -> 87 chars URL-safe base64 without padding)
  if (!BASE64URL_REGEX.test(publicKey) || publicKey.length !== 87) return false;

  // Private key: P-256 scalar (32 bytes -> 43 chars URL-safe base64 without padding)
  if (!BASE64URL_REGEX.test(privateKey) || privateKey.length !== 43) return false;

  return true;
}

export function resolveWebPushConfig(
  env: Record<string, string | undefined> = process.env
): WebPushConfig {
  const publicKey = env.PI_VIEWER_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.PI_VIEWER_VAPID_PRIVATE_KEY?.trim();
  const subject = env.PI_VIEWER_VAPID_SUBJECT?.trim();

  if (publicKey && privateKey && subject && validateVapidKeys(subject, publicKey, privateKey)) {
    return {
      available: true,
      publicKey,
      privateKey,
      subject,
    };
  }

  return {
    available: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJsonResponse(res: any, statusCode: number, data: any): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function normalizePath(urlStr: string): string {
  try {
    const parsed = new URL(urlStr, 'http://localhost');
    let norm = path.posix.normalize(parsed.pathname);
    norm = norm.replace(/\/+$/, '') || '/';
    return norm;
  } catch {
    return urlStr.split('?')[0].replace(/\/+$/, '') || '/';
  }
}

function readBody(req: any, maxBytes: number = MAX_PUSH_BODY_BYTES): Promise<string> {
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

const BASE64_REGEX = /^[A-Za-z0-9_-]+=*$/;

export function validateEndpointUrl(endpoint: string, allowedHosts: Set<string>): boolean {
  if (typeof endpoint !== 'string' || endpoint.length < 10 || endpoint.length > 2048) {
    return false;
  }
  // No CRLF or control characters
  if (/[\r\n\0]/.test(endpoint) || /%0[ad]/i.test(endpoint)) {
    return false;
  }

  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.port !== '') return false; // Block arbitrary ports
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith('.')) return false; // Block trailing dot DNS bypass
    if (!allowedHosts.has(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function validatePushKeys(keys: any): boolean {
  if (!keys || typeof keys !== 'object') return false;
  const { p256dh, auth } = keys;

  if (typeof p256dh !== 'string' || p256dh.length < 64 || p256dh.length > 256) {
    return false;
  }
  if (!BASE64_REGEX.test(p256dh) || /[\r\n]/.test(p256dh)) {
    return false;
  }

  if (typeof auth !== 'string' || auth.length < 16 || auth.length > 64) {
    return false;
  }
  if (!BASE64_REGEX.test(auth) || /[\r\n]/.test(auth)) {
    return false;
  }

  return true;
}

export function validateProjects(projects: any): SyncedProject[] | null {
  if (projects === undefined || projects === null) return [];
  if (!Array.isArray(projects)) return null;
  if (projects.length > MAX_PROJECTS_PER_SUB) return null;

  const valid: SyncedProject[] = [];
  for (const item of projects) {
    if (!item || typeof item !== 'object') return null;
    const p = item.path;
    if (typeof p !== 'string' || !p.trim() || p.length > 1024 || /[\r\n]/.test(p)) {
      return null;
    }
    const c = item.customName;
    if (c !== undefined && c !== null) {
      if (typeof c !== 'string' || c.length > 128 || /[\r\n]/.test(c)) {
        return null;
      }
    }
    valid.push({ path: p.trim(), customName: typeof c === 'string' ? c.trim() : undefined });
  }

  return valid;
}

function resolveGitBasename(targetDir: string): string | null {
  try {
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!toplevel) return null;
    const norm = toplevel.replace(/\\/g, '/').replace(/\/+$/, '');
    return norm.split('/').pop() || null;
  } catch {
    return null;
  }
}

function normalizeFsPath(p: string): string {
  try {
    return path.resolve(p).toLowerCase();
  } catch {
    return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  }
}

export function resolveOriginName(
  cwd: string | undefined,
  projects: SyncedProject[],
  customGitResolver?: (dir: string) => string | null
): string | null {
  if (!cwd || !cwd.trim()) return null;
  const trimmed = cwd.trim();

  // 1. Check customName in projects
  const normCwd = normalizeFsPath(trimmed);
  const match = projects.find((p) => normalizeFsPath(p.path) === normCwd);
  if (match?.customName && match.customName.trim()) {
    return match.customName.trim();
  }

  // 2. Check Git repository root basename
  if (customGitResolver) {
    const gitName = customGitResolver(trimmed);
    if (gitName && gitName.trim()) return gitName.trim();
  } else {
    const gitName = resolveGitBasename(trimmed);
    if (gitName && gitName.trim()) return gitName.trim();
  }

  // 3. Fallback to folder basename
  const folder = trimmed.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  return folder && folder.trim() ? folder.trim() : null;
}

// ---------------------------------------------------------------------------
// Service Factory
// ---------------------------------------------------------------------------

export function createWebPush(options: WebPushOptions = {}): WebPushService {
  const webAuth = options.webAuth;
  const config = options.config || resolveWebPushConfig(options.env);
  const allowedHosts = new Set(
    (options.allowedHosts || Array.from(LEGITIMATE_PUSH_HOSTS)).map((h) => h.toLowerCase())
  );
  const maxSubscriptions = options.maxSubscriptions || DEFAULT_MAX_SUBSCRIPTIONS;
  const maxInFlight = options.maxInFlight || DEFAULT_MAX_IN_FLIGHT;
  const sendTimeoutMs = options.sendTimeoutMs || DEFAULT_SEND_TIMEOUT_MS;
  const nowFn = options.now || (() => Date.now());
  const isOwnerConnected = options.isOwnerConnected || (() => false);

  // In-memory subscriptions store: endpoint -> PushSubscriptionRecord
  const subscriptions = new Map<string, PushSubscriptionRecord>();

  const localOwners = new Map<string, number>();
  const cookieName = 'pi_viewer_push_device';
  const isLocal = (req: any): boolean => {
    const peer = req.socket?.remoteAddress || '';
    const loopback = peer === '::1' || /^(?:127\.|::ffff:127\.)/.test(peer);
    try {
      const host = new URL(`http://${req.headers.host}`).hostname.toLowerCase();
      return loopback && ['localhost', '127.0.0.1', '[::1]'].includes(host);
    } catch { return false; }
  };
  const isOwnerAuthorized = (owner: string): boolean => {
    if (webAuth?.isEnabled()) return webAuth.validateOwnerLease(owner);
    const expires = localOwners.get(owner);
    if (expires === undefined || expires <= nowFn()) { localOwners.delete(owner); return false; }
    return true;
  };
  const getRequestOwner = (req: any): string | null => {
    if (webAuth?.isEnabled()) return webAuth.authenticate(req);
    if (!isLocal(req) || !validateSameOrigin(req)) return null;
    const token = typeof req.headers.cookie === 'string'
      ? req.headers.cookie.match(/(?:^|;\s*)pi_viewer_push_device=([a-f0-9]{64})(?:;|$)/)?.[1] : undefined;
    return token && isOwnerAuthorized(token) ? token : null;
  };
  const isConfigured = (): boolean => config.available;
  const getPublicKey = (): string | undefined => config.publicKey;

  // -------------------------------------------------------------------------
  // Route Handler: GET /api/push/config
  // -------------------------------------------------------------------------
  const handleConfig = async (req: any, res: any): Promise<void> => {
    const normUrl = normalizePath(req.originalUrl || req.url || '/');

    // Reject suffix aliases (/api/push/config/suffix)
    if (normUrl !== '/api/push/config') {
      sendJsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method !== 'GET') {
      sendJsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!validateSameOrigin(req)) {
      sendJsonResponse(res, 403, { error: 'Origin validation failed: access denied' });
      return;
    }

    // Anonymous access is limited to actual loopback requests and localhost origins.
    if (!webAuth?.isEnabled() && !isLocal(req)) {
      sendJsonResponse(res, 200, { available: false });
      return;
    }

    if (!config.available || !config.publicKey) {
      sendJsonResponse(res, 200, { available: false });
      return;
    }

    if (!webAuth?.isEnabled() && !getRequestOwner(req)) {
      for (const [token, expires] of localOwners) if (expires <= nowFn()) localOwners.delete(token);
      if (localOwners.size >= maxSubscriptions) { sendJsonResponse(res, 429, { error: 'Too many local devices' }); return; }
      const token = randomBytes(32).toString('hex');
      localOwners.set(token, nowFn() + 24 * 60 * 60 * 1000);
      res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=86400${req.socket?.encrypted ? '; Secure' : ''}`);
    }
    sendJsonResponse(res, 200, {
      available: true,
      publicKey: config.publicKey,
    });
  };

  // -------------------------------------------------------------------------
  // Route Handler: POST / DELETE /api/push/subscriptions
  // -------------------------------------------------------------------------
  const handleSubscriptions = async (
    req: any,
    res: any
  ): Promise<void> => {
    const normUrl = normalizePath(req.originalUrl || req.url || '/');

    // Reject suffix aliases
    if (normUrl !== '/api/push/subscriptions') {
      sendJsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') {
      sendJsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!validateSameOrigin(req)) {
      sendJsonResponse(res, 403, { error: 'Origin validation failed: access denied' });
      return;
    }

    if (!webAuth?.isEnabled() && !isLocal(req)) {
      sendJsonResponse(res, 403, { error: 'Local browser access required' }); return;
    }
    const owner = getRequestOwner(req);
    if (!owner) {
      sendJsonResponse(res, 401, { error: 'Unauthorized: Web login session required' });
      return;
    }

    const effectiveOwner = owner;

    // -----------------------------------------------------------------------
    // DELETE: Unregister subscription
    // -----------------------------------------------------------------------
    if (req.method === 'DELETE') {
      let bodyStr: string;
      try {
        bodyStr = await readBody(req, MAX_PUSH_BODY_BYTES);
      } catch (err: any) {
        if (err?.message === 'PAYLOAD_TOO_LARGE') {
          sendJsonResponse(res, 413, { error: 'Request body too large' });
          return;
        }
        sendJsonResponse(res, 400, { error: 'Invalid request body' });
        return;
      }

      let endpoint: string | undefined;
      if (bodyStr.trim()) {
        try {
          const parsed = JSON.parse(bodyStr);
          endpoint = parsed.endpoint;
        } catch {
          sendJsonResponse(res, 400, { error: 'Invalid JSON body' });
          return;
        }
      }

      if (!endpoint) {
        try {
          const parsedUrl = new URL(req.url, 'http://localhost');
          endpoint = parsedUrl.searchParams.get('endpoint') || undefined;
        } catch {}
      }

      if (!endpoint || typeof endpoint !== 'string') {
        sendJsonResponse(res, 400, { error: 'Endpoint is required' });
        return;
      }

      const existing = subscriptions.get(endpoint);
      if (existing) {
        // Allow deletion if caller is the owner or prior owner lease is no longer valid
        if (
          existing.owner === effectiveOwner ||
          !isOwnerAuthorized(existing.owner)
        ) {
          subscriptions.delete(endpoint);
        }
      }

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    // -----------------------------------------------------------------------
    // POST: Register or update subscription
    // -----------------------------------------------------------------------
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
      sendJsonResponse(res, 400, { error: 'JSON request required' });
      return;
    }

    let bodyStr: string;
    try {
      bodyStr = await readBody(req, MAX_PUSH_BODY_BYTES);
    } catch (err: any) {
      if (err?.message === 'PAYLOAD_TOO_LARGE') {
        sendJsonResponse(res, 413, { error: 'Request body too large' });
        return;
      }
      sendJsonResponse(res, 400, { error: 'Invalid request body' });
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyStr || '{}');
    } catch {
      sendJsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // 1. Validate subscription object
    const sub = parsed.subscription;
    if (!sub || typeof sub !== 'object') {
      sendJsonResponse(res, 400, { error: 'subscription object is required' });
      return;
    }

    if (!validateEndpointUrl(sub.endpoint, allowedHosts)) {
      sendJsonResponse(res, 400, { error: 'Invalid or disallowed push endpoint URL' });
      return;
    }

    if (!validatePushKeys(sub.keys)) {
      sendJsonResponse(res, 400, { error: 'Invalid push keys: p256dh and auth must be valid base64' });
      return;
    }

    // 2. Validate language
    const lang = parsed.language;
    let language: 'en' | 'es' = 'en';
    if (lang !== undefined) {
      if (lang !== 'en' && lang !== 'es') {
        sendJsonResponse(res, 400, { error: 'Invalid language: expected "en" or "es"' });
        return;
      }
      language = lang;
    }

    // 3. Validate preferences
    const rawPrefs = parsed.preferences;
    let preferences: NotificationPreferences = {
      enabled: true,
      sound: true,
      suppressWhenFocused: true,
      onTaskComplete: true,
      onWaitingInput: true,
    };
    if (rawPrefs !== undefined) {
      if (typeof rawPrefs !== 'object' || rawPrefs === null) {
        sendJsonResponse(res, 400, { error: 'Invalid preferences format' });
        return;
      }
      for (const [key, val] of Object.entries(rawPrefs)) {
        if (typeof val !== 'boolean') {
          sendJsonResponse(res, 400, { error: `Preference "${key}" must be boolean` });
          return;
        }
      }
      preferences = {
        enabled: rawPrefs.enabled !== false,
        sound: rawPrefs.sound !== false,
        suppressWhenFocused: rawPrefs.suppressWhenFocused !== false,
        onTaskComplete: rawPrefs.onTaskComplete !== false,
        onWaitingInput: rawPrefs.onWaitingInput !== false,
      };
    }

    // 4. Validate projects
    const validProjects = validateProjects(parsed.projects);
    if (validProjects === null) {
      sendJsonResponse(res, 400, { error: 'Invalid projects array or excessive projects count' });
      return;
    }

    // 5. Ownership & Lease check
    const existing = subscriptions.get(sub.endpoint);
    if (existing) {
      if (existing.owner !== effectiveOwner) {
        // Cross-owner update attempt: check if prior owner lease is still active
        const priorActive = isOwnerAuthorized(existing.owner);
        if (priorActive) {
          sendJsonResponse(res, 403, {
            error: 'Forbidden: Subscription belongs to another active session',
          });
          return;
        }
        // Prior lease expired / invalid: allow takeover!
      }
    } else {
      // New subscription: check bounded capacity
      if (subscriptions.size >= maxSubscriptions) {
        sendJsonResponse(res, 429, { error: 'Subscription store capacity reached' });
        return;
      }
    }

    // Store mutation occurs only after complete finite validation
    subscriptions.set(sub.endpoint, {
      subscription: {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
      },
      preferences,
      language,
      projects: validProjects,
      owner: effectiveOwner,
      createdAt: nowFn(),
    });

    sendJsonResponse(res, 200, { ok: true });
  };

  // -------------------------------------------------------------------------
  // Push Dispatcher: Handles RPC Waiting and Settled Events
  // -------------------------------------------------------------------------
  const dispatchPushEvent = async (event: {
    type: string;
    cwd?: string;
    [key: string]: any;
  }): Promise<void> => {
    const isSettled = event.type === 'agent_settled';
    const isWaiting = event.type === 'extension_ui_request';

    if (!isSettled && !isWaiting) return;
    if (subscriptions.size === 0) return;

    const eventType = isSettled ? 'task_complete' : 'waiting_input';

    const sendFn = options.sendNotification || (async (subData, payloadStr, sendOpts) => {
      const vapidDetails =
        config.subject && config.publicKey && config.privateKey
          ? {
              subject: config.subject,
              publicKey: config.publicKey,
              privateKey: config.privateKey,
            }
          : undefined;

      return webpush.sendNotification(
        {
          endpoint: subData.endpoint,
          keys: subData.keys,
        },
        payloadStr,
        {
          TTL: 60,
          timeout: sendOpts?.timeout || sendTimeoutMs,
          ...(vapidDetails ? { vapidDetails } : {}),
        }
      );
    });

    const candidateEntries = Array.from(subscriptions.entries());
    let nextIdx = 0;
    const workerCount = Math.min(candidateEntries.length, maxInFlight);

    const runWorker = async () => {
      while (nextIdx < candidateEntries.length) {
        const item = candidateEntries[nextIdx++];
        if (!item) break;
        const [endpoint, record] = item;

        // 1. Check device preference
        if (!record.preferences.enabled) continue;
        if (isSettled && record.preferences.onTaskComplete === false) continue;
        if (isWaiting && record.preferences.onWaitingInput === false) continue;

        // 2. Lease check for authenticated owner
        if (!isOwnerAuthorized(record.owner)) continue;

        // 3. Resolve origin name according to hierarchy
        const origin = resolveOriginName(event.cwd, record.projects, options.gitResolver);

        // 4. Construct title and body based on language and origin
        const isEs = record.language === 'es';
        let baseTitle: string;
        let body: string;

        if (isSettled) {
          baseTitle = isEs ? 'Tarea finalizada' : 'Task finished';
          body = isEs
            ? 'La tarea ha finalizado'
            : 'The task has finished';
        } else {
          baseTitle = isEs ? 'Esperando tu respuesta' : 'Waiting for your answer';
          body = isEs
            ? 'Pi requiere tu aprobación o respuesta para continuar'
            : 'Pi is blocked waiting for your input or approval';
        }

        const title = origin ? `${baseTitle} — ${origin}` : baseTitle;

        // No file paths or conversation content in payload
        const payloadObj = {
          title,
          body,
          eventType,
          tag: eventType,
        };
        const payloadStr = JSON.stringify(payloadObj);

        // 5. Send with bounded timeout; recheck lease immediately before send
        if (!record.preferences.enabled) continue;
        if (!isOwnerAuthorized(record.owner)) {
          continue;
        }
        if (isOwnerConnected(record.owner)) {
          continue;
        }

        let timer: any = null;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Push delivery timeout')), sendTimeoutMs);
          });
          await Promise.race([
            sendFn(record.subscription, payloadStr, { timeout: sendTimeoutMs }),
            timeoutPromise,
          ]);
        } catch (err: any) {
          const status = err?.statusCode || err?.status;
          // Prune expired or invalidated subscriptions on 404 or 410 Gone
          if (status === 404 || status === 410) {
            subscriptions.delete(endpoint);
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    };

    const workers = Array.from({ length: workerCount }, () => runWorker());
    void Promise.allSettled(workers);
  };

  const getSubscriptionsCount = (): number => subscriptions.size;
  const getSubscription = (endpoint: string): PushSubscriptionRecord | undefined =>
    subscriptions.get(endpoint);
  const clearSubscriptions = (): void => subscriptions.clear();
  const dispose = (): void => {
    localOwners.clear();
    subscriptions.clear();
  };

  return {
    getRequestOwner,
    isOwnerAuthorized,
    isConfigured,
    getPublicKey,
    handleConfig,
    handleSubscriptions,
    dispatchPushEvent,
    getSubscriptionsCount,
    getSubscription,
    clearSubscriptions,
    dispose,
  };
}
