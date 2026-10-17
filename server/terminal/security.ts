import type { IncomingMessage } from 'node:http';
import { validateSameOrigin, type WebAuthInstance } from '../bridge/web-auth';

export interface TerminalAccessResult {
  ok: boolean;
  status: number;
  error?: string;
  owner?: string;
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (cleanIp === '::1' || cleanIp === '127.0.0.1') return true;
  // 127.0.0.0/8 range
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/.test(cleanIp)) {
    return true;
  }
  return false;
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname = host;
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    if (end !== -1) {
      hostname = hostname.slice(1, end);
    }
  } else {
    hostname = hostname.split(':')[0];
  }
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower.endsWith('.localhost');
}

export function validateTerminalAccess(
  req: IncomingMessage,
  webAuth?: WebAuthInstance
): TerminalAccessResult {
  // 1. Same-Origin integrity check
  if (!validateSameOrigin(req)) {
    return {
      ok: false,
      status: 403,
      error: 'Origin validation failed: access denied',
    };
  }

  // 2. Authentication check
  const owner = webAuth?.authenticate(req);
  if (owner) {
    return {
      ok: true,
      status: 200,
      owner,
    };
  }

  // 3. Unauthenticated access check
  if (webAuth?.isEnabled()) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized: Web login session required',
    };
  }

  // Auth disabled: unauthenticated shell access is strictly restricted to verified loopback
  const remoteIp = req.socket?.remoteAddress;
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;

  if (isLoopbackAddress(remoteIp) && isLoopbackHost(host)) {
    return {
      ok: true,
      status: 200,
      owner: 'local',
    };
  }

  return {
    ok: false,
    status: 403,
    error: 'Access denied: remote shell execution requires authentication',
  };
}
