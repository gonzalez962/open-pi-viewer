import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getBridgeConfig, getAgnosticExecEnv } from '../config';
import { HOME_DIR, getActiveCwd } from './state';

export function getEngramBin(): string {
  return getBridgeConfig().engramBinary;
}

const engramProjectCache = new Map<string, { project: string | null; expires: number }>();

export function getEngramProjectImpl(cwd?: string): string | null {
  const targetDir = cwd || getActiveCwd();
  const now = Date.now();
  const cached = engramProjectCache.get(targetDir);
  if (cached && cached.expires > now) {
    return cached.project;
  }

  let detected: string | null = null;
  const configPath = path.join(targetDir, '.engram', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.name || cfg.project) {
        detected = cfg.name || cfg.project;
      }
    } catch {}
  }

  if (!detected) {
    try {
      const out = execFileSync(getEngramBin(), ['stats'], {
        cwd: targetDir,
        encoding: 'utf8',
        timeout: 1500,
        env: getAgnosticExecEnv(),
      });
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Projects:')) {
          detected = trimmed.replace('Projects:', '').trim();
          break;
        }
        if (trimmed.startsWith('Project:')) {
          detected = trimmed.replace('Project:', '').trim();
          break;
        }
      }
    } catch {}
  }

  if (!detected) {
    const base = path.basename(targetDir);
    detected = base || 'open-pi-viewer';
  }

  engramProjectCache.set(targetDir, { project: detected, expires: now + 60000 });
  return detected;
}

let cloudStatusCache: { key: string; expires: number; data: any } | null = null;

export async function getEngramCloudStatusImpl(project?: string, cwd?: string) {
  const p = project || getEngramProjectImpl(cwd);
  const cacheKey = `${p || ''}_${cwd || ''}`;
  const now = Date.now();
  if (cloudStatusCache && cloudStatusCache.key === cacheKey && cloudStatusCache.expires > now) {
    return cloudStatusCache.data;
  }

  const cfg = getBridgeConfig();
  const defaultUrl = cfg.engramServerUrl || 'https://engram.example.com';

  // 1. Try local daemon API directly in < 5ms if available
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 250);
    const daemonRes = await fetch(
      `http://127.0.0.1:7437/sync/status${p ? `?project=${encodeURIComponent(p)}` : ''}`,
      { signal: controller.signal }
    ).catch(() => null);
    clearTimeout(timeoutId);

    if (daemonRes && daemonRes.ok) {
      const daemonData: any = await daemonRes.json();
      const isEnrolled = daemonData?.reason_code !== 'blocked_unenrolled';
      const result = {
        configured: true,
        serverUrl: defaultUrl,
        authReady: true,
        enrolled: isEnrolled,
        daemonRunning: true,
        daemonPort: 7437,
        phase: daemonData?.phase || (isEnrolled ? 'synced' : 'idle'),
        lastSyncAt: daemonData?.last_sync_at || new Date().toLocaleTimeString(),
      };
      cloudStatusCache = { key: cacheKey, expires: now + 20000, data: result };
      return result;
    }
  } catch {}

  // 2. Fallback to CLI command with cached result (using execFileSync, no shell interpolation)
  try {
    const args = p ? ['cloud', 'status', '--project', p] : ['cloud', 'status'];
    const out = execFileSync(getEngramBin(), args, {
      encoding: 'utf8',
      timeout: 1500,
      env: getAgnosticExecEnv(),
    });

    const serverMatch = out.match(/Server:\s*(https?:\/\/[^\s]+)/i);
    const serverUrl = serverMatch ? serverMatch[1] : defaultUrl;
    const isConfigured = out.includes('Cloud status: configured');
    const isEnrolled = out.includes('project is enrolled') || out.includes('Project enrollment: enrolled');
    const isDaemon = out.includes('Local daemon: running');

    const result = {
      configured: isConfigured,
      serverUrl,
      authReady: true,
      enrolled: isEnrolled,
      daemonRunning: isDaemon,
      daemonPort: 7437,
      phase: isEnrolled ? 'synced' : 'idle',
      lastSyncAt: new Date().toLocaleTimeString(),
    };
    cloudStatusCache = { key: cacheKey, expires: now + 20000, data: result };
    return result;
  } catch {
    const fallback = {
      configured: true,
      serverUrl: defaultUrl,
      authReady: true,
      enrolled: false,
      daemonRunning: true,
      daemonPort: 7437,
      phase: 'idle',
    };
    cloudStatusCache = { key: cacheKey, expires: now + 10000, data: fallback };
    return fallback;
  }
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
  return getEngramProjectImpl(args.cwd);
}

export async function handleGetEngramCloudStatus(args: any = {}) {
  return await getEngramCloudStatusImpl(args.project, args.cwd);
}

export function handleEnrollEngramProject(args: any = {}) {
  return enrollEngramProjectImpl(args.project);
}

export function handleGetEngramObservations(args: any = {}) {
  return getEngramObservationsImpl(args.project, args.limit || 20);
}
