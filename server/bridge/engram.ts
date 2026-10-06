import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { getBridgeConfig, getAgnosticExecEnv } from '../config';
import { HOME_DIR, getActiveCwd } from './state';

export interface EngramCloudStatus {
  configured: boolean;
  serverUrl?: string | null;
  authReady: boolean;
  enrolled?: boolean | null;
  daemonRunning: boolean;
  daemonPort?: number | null;
  phase?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  reasonCode?: string | null;
  rawDetails?: string | null;
  cloudPermitted?: boolean | null;
  cloudPermissionMessage?: string | null;
}

export function getEngramBin(): string {
  return getBridgeConfig().engramBinary;
}

const engramProjectCache = new Map<string, { project: string | null; expires: number }>();

export function clearEngramCacheForTest(): void {
  engramProjectCache.clear();
  cloudStatusCache = null;
}

export function parseEngramProjectFromStats(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    let val: string | null = null;
    if (trimmed.startsWith('Projects:')) {
      val = trimmed.slice('Projects:'.length).trim();
    } else if (trimmed.startsWith('Project:')) {
      val = trimmed.slice('Project:'.length).trim();
    }
    if (val) {
      if (val.toLowerCase() === 'none yet' || val.length === 0) {
        return null;
      }
      return val;
    }
  }
  return null;
}

export function getEngramProjectImpl(cwd?: string): string | null {
  const targetDir = cwd || getActiveCwd();
  const now = Date.now();
  const cached = engramProjectCache.get(targetDir);
  if (cached && cached.expires > now) {
    return cached.project;
  }

  let detected: string | null = null;

  // 1. Fast path: check local .engram/config.json
  const configPath = path.join(targetDir, '.engram', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.name || cfg.project) {
        const val = String(cfg.name || cfg.project).trim();
        if (val && val.toLowerCase() !== 'none yet') {
          detected = val;
        }
      }
    } catch {}
  }

  // 2. CLI execution path: `engram stats`
  if (!detected) {
    try {
      const out = execFileSync(getEngramBin(), ['stats'], {
        cwd: fs.existsSync(targetDir) ? targetDir : undefined,
        encoding: 'utf8',
        timeout: 2500,
        env: getAgnosticExecEnv(),
      });
      detected = parseEngramProjectFromStats(out);
    } catch {}
  }

  engramProjectCache.set(targetDir, { project: detected, expires: now + 60000 });
  return detected;
}

export function parseEngramCloudStatus(stdout: string): EngramCloudStatus {
  let configured = false;
  let serverUrl: string | null = null;
  let authReady = false;
  let enrolled: boolean | null = null;
  let daemonRunning = false;
  let daemonPort: number | null = null;
  let reasonCode: string | null = null;
  let lastError: string | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith('cloud status:')) {
      configured = lower.includes('configured') && !lower.includes('not configured');
    } else if (trimmed.startsWith('Server:')) {
      const rest = trimmed.slice('Server:'.length).trim();
      if (rest) serverUrl = rest;
    } else if (lower.startsWith('auth status:')) {
      authReady = lower.includes('ready') && !lower.includes('not ready');
    } else if (lower.startsWith('project enrollment:')) {
      if (lower.includes('not enrolled')) {
        enrolled = false;
      } else if (lower.includes('enrolled (')) {
        enrolled = true;
      }
    } else if (lower.startsWith('local daemon:')) {
      daemonRunning = lower.includes('running') && !lower.includes('not running');
      const portIdx = lower.indexOf('port ');
      if (portIdx !== -1) {
        const portDigits = lower.slice(portIdx + 5).match(/^\d+/);
        if (portDigits) daemonPort = parseInt(portDigits[0], 10);
      }
    } else if (lower.startsWith('reason_code:')) {
      const rest = trimmed.slice('reason_code:'.length).trim();
      if (rest) reasonCode = rest;
    } else if (lower.startsWith('reason_message:')) {
      const rest = trimmed.slice('reason_message:'.length).trim();
      if (rest) lastError = rest;
    }
  }

  return {
    configured,
    serverUrl,
    authReady,
    enrolled,
    daemonRunning,
    daemonPort,
    phase: null,
    lastSyncAt: null,
    lastError,
    reasonCode,
    rawDetails: stdout.trim() || null,
    cloudPermitted: null,
    cloudPermissionMessage: null,
  };
}

export function applyCloudSyncPermissionResult(
  status: EngramCloudStatus,
  success: boolean,
  stdout: string,
  stderr: string
): void {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (
    combined.includes('403') ||
    combined.includes('forbidden') ||
    combined.includes('not allowed') ||
    combined.includes('policy_forbidden')
  ) {
    status.cloudPermitted = false;
    status.reasonCode = 'policy_forbidden';
    status.cloudPermissionMessage =
      'Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.';
    if (!status.lastError) {
      const desc = stderr.trim() || stdout.trim();
      if (desc) status.lastError = desc;
    }
  } else if (combined.includes('401') || combined.includes('auth_required')) {
    status.cloudPermitted = false;
    status.cloudPermissionMessage = 'Autenticación requerida por el servidor (401)';
  } else if (success || combined.includes('cloud sync status')) {
    status.cloudPermitted = true;
    status.cloudPermissionMessage = 'Sincronización permitida en el servidor';
  } else {
    status.cloudPermitted = null;
    status.cloudPermissionMessage =
      'No se pudo verificar permisos en el servidor Cloud (tiempo de espera agotado)';
  }
}

let cloudStatusCache: { key: string; expires: number; data: any } | null = null;

export async function getEngramCloudStatusImpl(project?: string, cwd?: string) {
  const targetDir = cwd || getActiveCwd();
  const p = project || getEngramProjectImpl(targetDir);
  const cacheKey = `${p || ''}_${targetDir || ''}`;
  const now = Date.now();
  if (cloudStatusCache && cloudStatusCache.key === cacheKey && cloudStatusCache.expires > now) {
    return cloudStatusCache.data;
  }

  const bin = getEngramBin();
  let status: EngramCloudStatus | null = null;

  // 1. Primary path: query CLI for authoritative cloud status
  try {
    const args = ['cloud', 'status'];
    if (p) {
      args.push('--project', p);
    }
    const out = execFileSync(bin, args, {
      cwd: fs.existsSync(targetDir) ? targetDir : undefined,
      encoding: 'utf8',
      timeout: 3500,
      env: getAgnosticExecEnv(),
    });

    if (out && out.trim().length > 0) {
      status = parseEngramCloudStatus(out);
    }
  } catch {}

  // 2. When project is enrolled, check cloud sync permissions
  if (status && status.configured && status.enrolled === true && p) {
    try {
      const syncArgs = ['sync', '--cloud', '--status', '--project', p];
      const res = spawnSync(bin, syncArgs, {
        cwd: fs.existsSync(targetDir) ? targetDir : undefined,
        encoding: 'utf8',
        timeout: 4000,
        env: getAgnosticExecEnv(),
      });
      applyCloudSyncPermissionResult(
        status,
        res.status === 0,
        res.stdout || '',
        res.stderr || ''
      );
    } catch {
      status.cloudPermitted = null;
      status.cloudPermissionMessage =
        'No se pudo verificar permisos en el servidor Cloud (tiempo de espera agotado)';
    }
  }

  // 3. Fallback: inspect ~/.engram/cloud.json directly if CLI execution failed
  if (!status) {
    const cloudJsonPath = path.join(HOME_DIR, '.engram', 'cloud.json');
    if (fs.existsSync(cloudJsonPath)) {
      try {
        const cloudData = JSON.parse(fs.readFileSync(cloudJsonPath, 'utf8'));
        const projOverride = p && cloudData.projects && cloudData.projects[p];
        const serverUrl = projOverride?.server_url || cloudData.server_url || getBridgeConfig().engramServerUrl;
        const isAuthReady = Boolean(projOverride?.token || cloudData.token);
        const isEnrolled = Boolean(projOverride && projOverride.token);

        status = {
          configured: true,
          serverUrl,
          authReady: isAuthReady,
          enrolled: isEnrolled,
          daemonRunning: false,
          daemonPort: null,
          phase: null,
          lastSyncAt: null,
          lastError: null,
          reasonCode: null,
          rawDetails: null,
          cloudPermitted: null,
          cloudPermissionMessage: null,
        };
      } catch {}
    }
  }

  // 4. Actively verify local daemon and merge live telemetry
  const port = status?.daemonPort || 7437;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600);
    const projectParam = p ? `?project=${encodeURIComponent(p)}` : '';
    const daemonRes = await fetch(`http://127.0.0.1:${port}/sync/status${projectParam}`, {
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeoutId);

    if (daemonRes && daemonRes.ok) {
      const daemonData: any = await daemonRes.json();
      if (!status) {
        status = {
          configured: false,
          serverUrl: getBridgeConfig().engramServerUrl,
          authReady: false,
          enrolled: null,
          daemonRunning: true,
          daemonPort: port,
          phase: null,
          lastSyncAt: null,
          lastError: null,
          reasonCode: null,
          rawDetails: null,
          cloudPermitted: null,
          cloudPermissionMessage: null,
        };
      }
      status.daemonRunning = true;
      status.daemonPort = port;

      // Only merge sync phase/telemetry if the project is actually enrolled in cloud sync
      if (status.enrolled === true && daemonData && typeof daemonData === 'object') {
        const daemonErr = daemonData.last_error || daemonData.reason_message;
        // Only attribute daemon error if it specifically names this project
        const isProjectError = Boolean(p && typeof daemonErr === 'string' && daemonErr.includes(p));

        if (isProjectError) {
          status.phase = daemonData.phase || status.phase;
          if (!status.lastError) {
            status.lastError = daemonErr;
          }
          if (!status.reasonCode) {
            status.reasonCode = daemonData.reason_code || null;
          }
        } else {
          // If daemon error is from other projects, do not contaminate this project
          status.phase = status.phase || 'synced';
        }
        status.lastSyncAt = daemonData.last_sync_at || status.lastSyncAt;
      }
    }
  } catch {}

  const ttl = status ? 20000 : 10000;
  cloudStatusCache = { key: cacheKey, expires: now + ttl, data: status };
  return status;
}

export function enrollEngramProjectImpl(project?: string) {
  if (!project) return false;
  try {
    execFileSync(getEngramBin(), ['cloud', 'enroll', '--project', project], {
      encoding: 'utf8',
      timeout: 5000,
      env: getAgnosticExecEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

export function getEngramObservationsImpl(project?: string, limit = 20) {
  const dbPath = path.join(HOME_DIR, '.engram', 'engram.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const pClause = project ? `AND project = '${project.replace(/'/g, "''")}'` : '';
    const sql = `SELECT json_group_array(json_object('id', id, 'title', title, 'type', type, 'content', content, 'project', project, 'scope', scope, 'created_at', created_at)) FROM (SELECT * FROM observations WHERE deleted_at IS NULL ${pClause} ORDER BY id DESC LIMIT ${limit});`;
    const out = execFileSync('sqlite3', [dbPath, sql], {
      encoding: 'utf8',
      timeout: 2000,
      env: getAgnosticExecEnv(),
    }).trim();
    if (out) return JSON.parse(out);
  } catch {}
  return [];
}

export function handleGetEngramProject(args: any = {}) {
  const cwd = args.payload?.cwd ?? args.cwd;
  return getEngramProjectImpl(cwd);
}

export async function handleGetEngramCloudStatus(args: any = {}) {
  const project = args.payload?.project ?? args.project;
  const cwd = args.payload?.cwd ?? args.cwd;
  return await getEngramCloudStatusImpl(project, cwd);
}

export function handleEnrollEngramProject(args: any = {}) {
  const project = args.payload?.project ?? args.project;
  return enrollEngramProjectImpl(project);
}

export function handleGetEngramObservations(args: any = {}) {
  const project = args.payload?.project ?? args.project;
  const limit = args.payload?.limit ?? args.limit ?? 20;
  return getEngramObservationsImpl(project, limit);
}
