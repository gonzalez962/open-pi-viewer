import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, execSync, execFileSync } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import {
  getHomeDir,
  getBridgeConfig,
  getAgnosticExecEnv,
} from './config';

const HOME_DIR = getHomeDir();
const PI_AGENT_DIR = path.join(HOME_DIR, '.pi', 'agent');
const SESSIONS_ROOT = path.join(PI_AGENT_DIR, 'sessions');

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) Client Manager
// ---------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>();

export function addSseClient(res: ServerResponse) {
  sseClients.add(res);
}

export function removeSseClient(res: ServerResponse) {
  sseClients.delete(res);
}

export function broadcastSse(event: string, payload: any) {
  const data = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Pi CLI RPC Subprocess Manager
// ---------------------------------------------------------------------------

export function resolveCrossPlatformCwd(cwd?: string | null): string {
  const cfg = getBridgeConfig();
  if (!cwd || !cwd.trim()) {
    return cfg.baseWorkspace || process.cwd();
  }
  let trimmed = cwd.trim();

  // Expand ~ or ~/ or ~\
  const home = getHomeDir();
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    trimmed = path.join(home, trimmed.slice(2));
  }

  // Windows Git Bash / MSYS format: /c/Users/... -> C:\Users\...
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(trimmed)) {
    const drive = trimmed[1].toUpperCase();
    const rest = trimmed.slice(2).replace(/\//g, '\\');
    trimmed = `${drive}:${rest}`;
  }

  // If path is a Windows-style path on POSIX host (e.g. C:\... or Z:\...)
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\\/]?/i.test(trimmed)) {
    const drive = trimmed[0].toUpperCase();
    const relPart = trimmed.slice(2).replace(/^[\\\/]+/, '').replace(/\\/g, '/');

    if (cfg.driveMappings && cfg.driveMappings[drive]) {
      const mapped = relPart ? path.join(cfg.driveMappings[drive], relPart) : cfg.driveMappings[drive];
      if (fs.existsSync(mapped)) return mapped;
    }
    // Fallback: check under home directory if folder exists
    const homeCandidate = relPart ? path.join(home, relPart) : home;
    if (fs.existsSync(homeCandidate)) return homeCandidate;
  }

  // UNC path check on POSIX host
  if (process.platform !== 'win32' && /^([\\\/]{2})[^\/\\\s]+[\\\/]([^\\\/]+)[\\\/]?(.*)/.test(trimmed)) {
    const m = trimmed.match(/^([\\\/]{2})[^\/\\\s]+[\\\/]([^\\\/]+)[\\\/]?(.*)/);
    if (m && cfg.uncMappings) {
      const shareName = m[2].toLowerCase();
      if (cfg.uncMappings[shareName]) {
        const subPath = m[3] ? m[3].replace(/\\/g, '/') : '';
        const mapped = subPath ? path.join(cfg.uncMappings[shareName], subPath) : cfg.uncMappings[shareName];
        if (fs.existsSync(mapped)) return mapped;
      }
    }
  }

  try {
    return path.resolve(trimmed);
  } catch {
    return trimmed;
  }
}

export function getAvailableDrives(): Array<{ name: string; path: string }> {
  if (process.platform !== 'win32') return [];
  const drives: Array<{ name: string; path: string }> = [];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB';
  for (const l of letters) {
    const root = `${l}:\\`;
    try {
      if (fs.existsSync(root)) {
        drives.push({ name: `Drive (${root})`, path: root });
      }
    } catch {}
  }
  return drives;
}

export function getFilesystemShortcuts(baseWorkspace: string): Array<{ name: string; path: string; windowsPath?: string }> {
  const shortcuts: Array<{ name: string; path: string; windowsPath?: string }> = [];
  const home = getHomeDir();
  const cfg = getBridgeConfig();

  // 1. Custom shortcuts from config
  if (cfg.customShortcuts && Array.isArray(cfg.customShortcuts)) {
    for (const sc of cfg.customShortcuts) {
      if (sc.name && sc.path && fs.existsSync(sc.path)) {
        shortcuts.push({
          name: sc.name,
          path: path.resolve(sc.path),
          ...(process.platform === 'win32' ? { windowsPath: path.resolve(sc.path) } : {}),
        });
      }
    }
  }

  // 2. Base workspace
  if (baseWorkspace && fs.existsSync(baseWorkspace)) {
    const baseName = path.basename(baseWorkspace) || 'Workspace';
    shortcuts.push({
      name: `Workspace (${baseName})`,
      path: path.resolve(baseWorkspace),
      ...(process.platform === 'win32' ? { windowsPath: path.resolve(baseWorkspace) } : {}),
    });
  }

  // 3. User Home
  if (fs.existsSync(home)) {
    shortcuts.push({
      name: `Home (${path.basename(home) || '~'})`,
      path: home,
      ...(process.platform === 'win32' ? { windowsPath: home } : {}),
    });
  }

  // 4. Platform specific: Drives on Windows, Root and standard dirs on POSIX
  if (process.platform === 'win32') {
    const drives = getAvailableDrives();
    for (const d of drives) {
      shortcuts.push({
        name: d.name,
        path: d.path,
        windowsPath: d.path,
      });
    }
  } else {
    shortcuts.push({
      name: 'Root (/)',
      path: '/',
    });
    const commonDirs = ['Projects', 'Development', 'Documents', 'workspace'];
    for (const dirName of commonDirs) {
      const p = path.join(home, dirName);
      if (fs.existsSync(p)) {
        shortcuts.push({
          name: dirName,
          path: p,
        });
      }
    }
  }

  return shortcuts;
}

class PiRpcSession {
  private child: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timer: any }>();
  private stdoutBuffer = '';
  public cwd: string = getBridgeConfig().baseWorkspace || process.cwd();
  public sessionFile: string | null = null;
  public sessionId: string | null = null;
  public modelInfo: any = null;

  public isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  public kill() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`Subprocess terminated for request ${id}`));
    }
    this.pending.clear();
  }

  public async ensureRunning(cwd: string, sessionFile?: string | null): Promise<void> {
    const resolvedCwd = resolveCrossPlatformCwd(cwd);
    if (this.isAlive() && this.cwd === resolvedCwd && (sessionFile ? this.sessionFile === sessionFile : true)) {
      return;
    }

    this.kill();
    this.cwd = resolvedCwd;
    this.sessionFile = sessionFile || null;

    const cfg = getBridgeConfig();
    const nodePath = cfg.nodeExecutable;
    const entrypoint = cfg.piCliPath;

    let childProc: ChildProcess | null = null;
    const env = getAgnosticExecEnv();

    if (entrypoint && fs.existsSync(entrypoint)) {
      const args = [entrypoint, '--mode', 'rpc', '--approve'];
      if (this.sessionFile && fs.existsSync(this.sessionFile)) {
        args.push('--session', this.sessionFile);
      }
      try {
        childProc = spawn(nodePath, args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } catch (err) {
        console.warn('[Pi RPC spawn error]:', err);
        childProc = null;
      }
    } else {
      const args = ['--mode', 'rpc', '--approve'];
      if (this.sessionFile && fs.existsSync(this.sessionFile)) {
        args.push('--session', this.sessionFile);
      }
      try {
        childProc = spawn('pi', args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          env,
        });
      } catch (err) {
        console.warn('[Pi RPC spawn error]:', err);
        childProc = null;
      }
    }

    if (!childProc) {
      this.child = null;
      return;
    }
    this.child = childProc;

    this.child.stdout?.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          this.handleStdoutLine(parsed);
        } catch {
          // Ignore non-JSON line
        }
      }
    });

    this.child.stderr?.on('data', (chunk) => {
      // Strip terminal OSC title and control codes that Pi CLI emits for terminal window title
      const cleaned = chunk.toString().replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '').trim();
      if (cleaned) {
        console.warn('[Pi CLI stderr]:', cleaned);
      }
    });

    this.child.on('exit', (code, signal) => {
      console.log(`[Pi CLI exit] code: ${code}, signal: ${signal}`);
      if (this.sessionFile) {
        const norm = path.resolve(this.sessionFile);
        const currentStat = sessionStatusMap.get(norm);
        if (currentStat === 'working' || currentStat === 'waiting') {
          setSessionStatus(this.sessionFile, 'completed', this.sessionId);
        }
      }
      this.child = null;
    });

    // Initial get_state handshake with 25s timeout (allows extension loading on cold start)
    const reqId = `init-${Date.now()}`;
    try {
      const stateRes = await this.sendCommand({ id: reqId, type: 'get_state' }, 25000);
      if (stateRes?.data) {
        this.sessionId = stateRes.data.sessionId || null;
        this.sessionFile = stateRes.data.sessionFile || null;
        this.modelInfo = stateRes.data.model || null;
      }
    } catch (e) {
      console.warn('[Pi CLI get_state handshake warning]:', e);
    }
  }

  public async sendCommand(cmd: any, timeoutMs = 15000): Promise<any> {
    if (!this.isAlive() || !this.child?.stdin) {
      throw new Error('Pi CLI subprocess is not running');
    }

    const id = cmd.id || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    cmd.id = id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${cmd.type || id} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify(cmd) + '\n');
    });
  }

  public sendRaw(obj: any): boolean {
    if (!this.isAlive() || !this.child?.stdin) {
      return false;
    }
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private handleStdoutLine(data: any) {
    // 1. If it has an id matching pending request, resolve it
    if (data.id && this.pending.has(data.id)) {
      const p = this.pending.get(data.id)!;
      clearTimeout(p.timer);
      this.pending.delete(data.id);
      p.resolve(data);
      return;
    }

    // 2. If it's an event (type: message_start, message_update, tool_*, agent_*, etc.), broadcast to SSE!
    if (data.type) {
      if (!data.cwd) {
        data.cwd = this.cwd;
      }
      data.sessionFile = this.sessionFile;
      data.sessionId = this.sessionId;

      if (data.type === 'message_start') {
        if (this.sessionFile) {
          setSessionStatus(this.sessionFile, 'working', this.sessionId);
        }
      } else if (data.type === 'extension_ui_request') {
        const method = data.method;
        if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
          if (this.sessionFile) {
            setSessionStatus(this.sessionFile, 'waiting', this.sessionId);
          }
        }
      } else if (data.type === 'extension_ui_response') {
        if (this.sessionFile) {
          setSessionStatus(this.sessionFile, 'working', this.sessionId);
        }
      }

      broadcastSse('pi://event', data);

      // When Pi CLI finishes a turn (agent_end without willRetry), also emit agent_settled
      // so the frontend reducer transitions agentActivity from 'busy' back to 'idle'.
      if (data.type === 'agent_end' && !data.willRetry) {
        if (this.sessionFile) {
          setSessionStatus(this.sessionFile, 'completed', this.sessionId);
          sessionParseCache.delete(this.sessionFile);
        }
        broadcastSse('pi://event', {
          type: 'agent_settled',
          cwd: this.cwd,
          sessionFile: this.sessionFile,
          sessionId: this.sessionId,
        });
      }
    }
  }
}

const sessionPool = new Map<string, PiRpcSession>();
const sessionStatusMap = new Map<string, 'working' | 'completed' | 'waiting' | 'unloaded'>();

let activeSessionFile: string | null = null;
let activeSessionId: string | null = null;
let activeCwd: string = getBridgeConfig().baseWorkspace || process.cwd();
let activeModel = {
  provider: 'antigravity-cpa',
  id: 'Gem/gemini-3.8-flash-high',
  name: 'CPAMC Active · Gemini 3.8 Flash High',
};
let activeThinkingLevel: string = 'high';

export function getSessionStatus(sessionPath: string): 'working' | 'completed' | 'waiting' | 'unloaded' {
  const norm = sessionPath ? path.resolve(sessionPath) : '';
  if (!norm) return 'unloaded';

  const rpc = sessionPool.get(norm);
  const isAlive = rpc ? rpc.isAlive() : false;

  if (sessionStatusMap.has(norm)) {
    const recorded = sessionStatusMap.get(norm)!;
    // A dead process can never remain in 'working' or 'waiting' state
    if ((recorded === 'working' || recorded === 'waiting') && !isAlive) {
      sessionStatusMap.set(norm, 'completed');
      return 'completed';
    }
    return recorded;
  }
  if (isAlive) {
    return 'completed';
  }
  return 'unloaded';
}

export function setSessionStatus(
  sessionPath: string,
  status: 'working' | 'completed' | 'waiting' | 'unloaded',
  sessionId?: string | null
) {
  const norm = sessionPath ? path.resolve(sessionPath) : '';
  if (!norm) return;
  sessionStatusMap.set(norm, status);
  broadcastSse('pi://event', {
    type: 'session_status_changed',
    sessionPath: norm,
    sessionId: sessionId || null,
    status,
  });
}

export async function getOrCreatePiRpc(cwd: string, sessionFile?: string | null): Promise<PiRpcSession> {
  const normFile = sessionFile ? path.resolve(sessionFile) : null;
  if (normFile) {
    const existing = sessionPool.get(normFile);
    if (existing && existing.isAlive()) {
      return existing;
    }
  }

  // Pool management: prune dead or completed idle processes if pool size >= 4
  if (sessionPool.size >= 4) {
    for (const [sFile, rpc] of sessionPool.entries()) {
      if (sFile !== normFile && sessionStatusMap.get(sFile) !== 'working') {
        rpc.kill();
        sessionPool.delete(sFile);
        if (sessionStatusMap.get(sFile) !== 'waiting') {
          sessionStatusMap.set(sFile, 'unloaded');
        }
        break;
      }
    }
  }

  const rpc = new PiRpcSession();
  await rpc.ensureRunning(resolveCrossPlatformCwd(cwd), normFile);
  if (normFile) {
    sessionPool.set(normFile, rpc);
  }
  return rpc;
}

function getActiveRpc(): PiRpcSession | null {
  if (!activeSessionFile) {
    return null;
  }
  const norm = path.resolve(activeSessionFile);
  const rpc = sessionPool.get(norm);
  return rpc && rpc.isAlive() ? rpc : null;
}

const piRpc = {
  get sessionFile() {
    return activeSessionFile;
  },
  set sessionFile(v: string | null) {
    activeSessionFile = v;
  },
  get sessionId() {
    return activeSessionId;
  },
  set sessionId(v: string | null) {
    activeSessionId = v;
  },
  isAlive() {
    return getActiveRpc()?.isAlive() ?? false;
  },
  get modelInfo() {
    return getActiveRpc()?.modelInfo ?? null;
  },
  kill() {
    for (const rpc of sessionPool.values()) {
      rpc.kill();
    }
    sessionPool.clear();
  },
  async sendCommand(cmd: any, timeoutMs?: number) {
    const rpc = await getOrCreatePiRpc(activeCwd, activeSessionFile);
    return rpc.sendCommand(cmd, timeoutMs);
  },
  async ensureRunning(cwd: string, sessionFile?: string | null) {
    await getOrCreatePiRpc(cwd, sessionFile);
  },
};

export function getActiveThinkingLevel() {
  return activeThinkingLevel;
}

export function resolveSessionsDir(cwd: string): string {
  const resolved = resolveCrossPlatformCwd(cwd);
  const norm = path.resolve(resolved);
  const safe1 = '--' + norm.replace(/^\/+/, '').replace(/[\/\\:]/g, '-') + '--';
  const dir1 = path.join(SESSIONS_ROOT, safe1);
  if (fs.existsSync(dir1)) {
    const files = fs.readdirSync(dir1).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) return dir1;
  }

  try {
    const real = fs.realpathSync(resolved);
    const safe2 = '--' + real.replace(/^\/+/, '').replace(/[\/\\:]/g, '-') + '--';
    const dir2 = path.join(SESSIONS_ROOT, safe2);
    if (fs.existsSync(dir2)) {
      const files2 = fs.readdirSync(dir2).filter((f) => f.endsWith('.jsonl'));
      if (files2.length > 0) return dir2;
    }
  } catch {}

  const base = path.basename(norm);
  if (fs.existsSync(SESSIONS_ROOT)) {
    const all = fs.readdirSync(SESSIONS_ROOT);
    for (const d of all) {
      if (d.toLowerCase().includes(base.toLowerCase())) {
        const dPath = path.join(SESSIONS_ROOT, d);
        if (fs.existsSync(dPath) && fs.readdirSync(dPath).some((f) => f.endsWith('.jsonl'))) {
          return dPath;
        }
      }
    }
  }

  return dir1;
}

export function discoverAllProjectsWithSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const entries = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
  const list: { id: string; path: string; customName: string; sessionCount: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!name.startsWith('--') || !name.endsWith('--')) continue;

    const fullDirPath = path.join(SESSIONS_ROOT, name);
    const files = fs.readdirSync(fullDirPath).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) continue;

    let realCwd: string | null = null;
    for (const f of files) {
      try {
        const line = fs.readFileSync(path.join(fullDirPath, f), 'utf8').split('\n')[0];
        const h = JSON.parse(line);
        if (h.cwd) {
          realCwd = h.cwd;
          break;
        }
      } catch {}
    }

    if (!realCwd) {
      const trimmed = name.slice(2, -2);
      if (process.platform === 'win32') {
        const parts = trimmed.split('-');
        if (parts.length > 0 && parts[0].length === 1) {
          realCwd = `${parts[0].toUpperCase()}:\\${parts.slice(1).join('\\')}`;
        } else {
          realCwd = path.join(HOME_DIR, trimmed);
        }
      } else {
        realCwd = '/' + trimmed.replace(/-/g, '/');
      }
    }

    if (!fs.existsSync(realCwd)) continue;

    const baseName = path.basename(realCwd) || 'Home';
    const isHome = path.resolve(realCwd) === path.resolve(HOME_DIR);
    list.push({
      id: `proj-${name.slice(2, -2).toLowerCase()}`,
      path: realCwd,
      customName: isHome ? `${baseName} (Home)` : baseName,
      sessionCount: files.length,
    });
  }

  list.sort((a, b) => {
    if (a.path === activeCwd) return -1;
    if (b.path === activeCwd) return 1;
    return b.sessionCount - a.sessionCount;
  });

  return list;
}

const sessionParseCache = new Map<string, { mtimeMs: number; size: number; parsed: any }>();

export function parseSessionFile(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cached = sessionParseCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return {
      ...cached.parsed,
      isActive: cached.parsed.id === piRpc.sessionId || filePath === piRpc.sessionFile,
    };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  if (header.type !== 'session' || !header.id) return null;

  const id = header.id;
  const createdAt = header.timestamp;
  let customTitle: string | undefined = undefined;
  let messageCount = 0;
  let firstMessage = '';
  const messages: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'session_info' && entry.name) {
        customTitle = String(entry.name).trim() || undefined;
      }
      if (entry.type === 'custom' && entry.customType === 'pi-viewer.session-title/v1' && entry.data?.title) {
        customTitle = String(entry.data.title).trim() || undefined;
      }
      if (entry.type === 'message' && entry.message) {
        messageCount++;
        const msg = entry.message;
        const msgId = msg.id || entry.id || `msg-${i}`;
        const msgTimestamp = msg.timestamp || entry.timestamp;
        messages.push({
          ...msg,
          id: msgId,
          timestamp: msgTimestamp,
        });

        if (!firstMessage && msg.role === 'user') {
          const c = msg.content;
          if (typeof c === 'string') {
            firstMessage = c.slice(0, 100);
          } else if (Array.isArray(c)) {
            let extracted = '';
            for (const part of c) {
              if (part.type === 'text' && typeof part.text === 'string') {
                extracted += part.text;
              }
            }
            firstMessage = extracted.slice(0, 100);
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  const modifiedAt = stat.mtime.toISOString();

  const parsed = {
    id,
    path: filePath,
    createdAt,
    modifiedAt,
    firstMessage: firstMessage || '(no messages)',
    customTitle,
    messageCount,
    isActive: id === piRpc.sessionId || filePath === piRpc.sessionFile,
    messages,
  };

  sessionParseCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    parsed,
  });

  return parsed;
}

export function listSessions(targetCwd?: string) {
  const cwd = targetCwd || activeCwd;
  const dir = resolveSessionsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const results: any[] = [];

  for (const f of files) {
    const filePath = path.join(dir, f);
    const parsed = parseSessionFile(filePath);
    if (parsed) {
      const { messages, ...summary } = parsed;
      results.push({
        ...summary,
        status: getSessionStatus(filePath),
      });
    }
  }

  results.sort((a, b) => {
    const tA = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
    const tB = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
    return tB - tA;
  });

  return results;
}

export function calculateSessionStats(filePath: string, activeModelContextWindow = 1048576) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let lastContextTokens = 0;
  let sessionId = '';

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session' && entry.id) {
        sessionId = entry.id;
      }
      if (entry.type === 'message' && entry.message) {
        const m = entry.message;
        if (m.role === 'user') userMessages++;
        else if (m.role === 'assistant') {
          assistantMessages++;
          if (m.usage) {
            totalInput += m.usage.input || 0;
            totalOutput += m.usage.output || 0;
            totalCacheRead += m.usage.cacheRead || 0;
            totalCacheWrite += m.usage.cacheWrite || 0;
            totalCost += m.usage.cost?.total || 0;
            lastContextTokens = (m.usage.input || 0) + (m.usage.cacheRead || 0);
          }
          if (Array.isArray(m.content)) {
            for (const c of m.content) {
              if (c.type === 'toolCall') toolCalls++;
            }
          }
        } else if (m.role === 'toolResult') {
          toolResults++;
        }
      }
    } catch {}
  }

  const contextWindow = activeModelContextWindow || 1048576;
  const percent = contextWindow > 0 ? (lastContextTokens / contextWindow) * 100 : 0;

  return {
    sessionId: sessionId || piRpc.sessionId || undefined,
    sessionFile: filePath,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages + toolResults,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalInput + totalOutput + totalCacheRead,
    },
    cost: totalCost,
    contextUsage: {
      tokens: lastContextTokens,
      contextWindow,
      percent: Math.round(percent * 10) / 10,
    },
  };
}

// ---------------------------------------------------------------------------
// SDD Profiles & Subagents Discovery (Opción 3)
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}

/**
 * Scan all markdown agent definitions from ~/.pi/agent/agents and gentle-pi assets
 */
export function discoverAgentDefinitions(): Record<string, { id: string; name: string; description: string; tools: string[]; category?: string }> {
  const agentMap: Record<string, { id: string; name: string; description: string; tools: string[]; category?: string }> = {};

  const dirsToScan = [
    path.join(PI_AGENT_DIR, 'agents'),
    path.join(PI_AGENT_DIR, 'npm', 'node_modules', 'gentle-pi', 'assets', 'agents'),
    path.join(activeCwd, '.pi', 'agents'),
    path.join(activeCwd, 'agents'),
  ];

  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of entries) {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const trimmed = content.trim();
        let frontmatter = '';
        if (trimmed.startsWith('---')) {
          const after = trimmed.slice(3);
          const endIdx = after.indexOf('\n---');
          if (endIdx !== -1) {
            frontmatter = after.slice(0, endIdx);
          }
        }

        const agentId = f.replace(/\.md$/, '');
        let name = agentId;
        let description = '';
        let tools: string[] = [];

        if (frontmatter) {
          const nameMatch = frontmatter.match(/name:\s*([^\n\r]+)/);
          if (nameMatch) name = nameMatch[1].trim();

          const descMatch = frontmatter.match(/description:\s*([^\n\r]+)/);
          if (descMatch) description = descMatch[1].trim();

          const toolsMatch = frontmatter.match(/tools:\s*([^\n\r]+)/);
          if (toolsMatch) {
            tools = toolsMatch[1].split(',').map((t) => t.trim().replace(/^['"\s]+|['"\s]+$/g, '')).filter(Boolean);
          } else {
            // Check list format
            const listMatch = frontmatter.match(/tools:\s*\n((?:\s*-\s*[^\n\r]+\n?)+)/);
            if (listMatch) {
              tools = listMatch[1]
                .split('\n')
                .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
            }
          }
        }

        if (!description) {
          description = `Subagente ${name}`;
        }

        agentMap[agentId] = {
          id: agentId,
          name,
          description,
          tools,
        };
      } catch {}
    }
  }

  return agentMap;
}

export function getSddProfilesImpl(cwd?: string) {
  const profilesDir = path.join(PI_AGENT_DIR, 'profiles');
  const projectProfilesDir = cwd ? path.join(cwd, '.pi', 'profiles') : null;

  const rawProfiles: { profile: any; scope: 'global' | 'project'; filePath: string }[] = [];

  if (fs.existsSync(profilesDir)) {
    const files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    for (const f of files) {
      try {
        const fullPath = path.join(profilesDir, f);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (data && data.name) {
          rawProfiles.push({ profile: data, scope: 'global', filePath: fullPath });
        }
      } catch {}
    }
  }

  if (projectProfilesDir && fs.existsSync(projectProfilesDir)) {
    const files = fs.readdirSync(projectProfilesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    for (const f of files) {
      try {
        const fullPath = path.join(projectProfilesDir, f);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (data && data.name) {
          rawProfiles.push({ profile: data, scope: 'project', filePath: fullPath });
        }
      } catch {}
    }
  }

  let globalActive: string | null = null;
  const activeFile = path.join(profilesDir, '.active');
  if (fs.existsSync(activeFile)) {
    const txt = fs.readFileSync(activeFile, 'utf8').trim();
    if (txt) globalActive = txt;
  }

  let projectActive: string | null = null;
  if (projectProfilesDir) {
    const pActiveFile = path.join(projectProfilesDir, '.active');
    if (fs.existsSync(pActiveFile)) {
      const txt = fs.readFileSync(pActiveFile, 'utf8').trim();
      if (txt) projectActive = txt;
    }
  }

  const effectiveActive = projectActive || globalActive;
  const effectiveScope = projectActive ? 'project' : globalActive ? 'global' : null;

  const profiles = rawProfiles.map(({ profile, scope, filePath }) => {
    const isAct = effectiveActive && profile.name.toLowerCase() === effectiveActive.toLowerCase();
    const modelProfiles = profile.model_profiles || {};
    const agentCount = Object.keys(modelProfiles).length;

    return {
      name: profile.name,
      description: profile.description || '',
      default_model: profile.default_model || '',
      default_effort: profile.default_effort || 'high',
      agent_count: agentCount,
      scope,
      is_active: Boolean(isAct),
      active_scope: isAct ? effectiveScope : undefined,
      path: filePath,
      model_profiles: modelProfiles,
    };
  });

  const agentMeta = discoverAgentDefinitions();
  const agentSet = new Set<string>(Object.keys(agentMeta));

  const subagentsFile = path.join(PI_AGENT_DIR, 'subagents.json');
  if (fs.existsSync(subagentsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(subagentsFile, 'utf8'));
      if (parsed.model_profiles) {
        for (const k of Object.keys(parsed.model_profiles)) {
          agentSet.add(k);
        }
      }
    } catch {}
  }

  for (const { profile } of rawProfiles) {
    if (profile.model_profiles) {
      for (const k of Object.keys(profile.model_profiles)) {
        agentSet.add(k);
      }
    }
  }

  const allAgents = Array.from(agentSet).sort();

  const catMap = new Map<string, { id: string; name: string; description: string; priority: number; agents: string[] }>();

  function getBucket(id: string, name: string, description: string, priority: number) {
    if (!catMap.has(id)) {
      catMap.set(id, { id, name, description, priority, agents: [] });
    }
    return catMap.get(id)!;
  }

  for (const agentId of allAgents) {
    if (agentId.startsWith('sdd-')) {
      getBucket('sdd-core', 'Spec-Driven Development', 'SDD phase executor agents', 10).agents.push(agentId);
    } else if (agentId.startsWith('jd-')) {
      getBucket('judgment-day', 'Judgment Day', 'Blind dual review judges and fix agent', 20).agents.push(agentId);
    } else if (agentId.startsWith('review-') || agentId.endsWith('-auditor')) {
      getBucket('reviewers', 'Reviewers & Auditors', 'Quality, security, and architectural review lenses', 30).agents.push(agentId);
    } else if (agentId.startsWith('gentle-ai-') || agentId.startsWith('gentle-')) {
      getBucket('gentle-ai', 'Gentle AI', 'Gentle AI harness and execution agents', 40).agents.push(agentId);
    } else {
      getBucket('general', 'General Harness', 'Subagents for general workflows and tasks', 90).agents.push(agentId);
    }
  }

  const categories = Array.from(catMap.values())
    .sort((a, b) => a.priority - b.priority)
    .map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      agents: b.agents.sort(),
    }));

  return {
    profiles,
    projectActiveProfile: projectActive,
    globalActiveProfile: globalActive,
    effectiveActiveProfile: effectiveActive,
    effectiveScope: effectiveScope,
    categories,
    allAgents,
    agentMeta,
  };
}

export function setActiveSddProfileImpl(name: string | null, scope: 'project' | 'global' = 'global', cwd?: string) {
  const dir = scope === 'project' && cwd ? path.join(cwd, '.pi', 'profiles') : path.join(PI_AGENT_DIR, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const activeFile = path.join(dir, '.active');

  if (!name) {
    if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
    return { success: true, message: 'Active profile cleared' };
  }

  fs.writeFileSync(activeFile, name.trim() + '\n', 'utf8');

  const profileFile = path.join(dir, `${slugify(name)}.json`);
  let profileData: any = null;
  if (fs.existsSync(profileFile)) {
    profileData = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  } else {
    const gFile = path.join(PI_AGENT_DIR, 'profiles', `${slugify(name)}.json`);
    if (fs.existsSync(gFile)) {
      profileData = JSON.parse(fs.readFileSync(gFile, 'utf8'));
    }
  }

  if (profileData && profileData.model_profiles) {
    const subagentsPath = scope === 'project' && cwd ? path.join(cwd, '.pi', 'subagents.json') : path.join(PI_AGENT_DIR, 'subagents.json');
    let subagentsObj: any = {};
    if (fs.existsSync(subagentsPath)) {
      try {
        subagentsObj = JSON.parse(fs.readFileSync(subagentsPath, 'utf8'));
      } catch {}
    }
    subagentsObj.model_profiles = profileData.model_profiles;
    fs.writeFileSync(subagentsPath, JSON.stringify(subagentsObj, null, 2) + '\n', 'utf8');
  }

  return { success: true, message: `Profile '${name}' activated successfully` };
}

// ---------------------------------------------------------------------------
// Chains / Cadenas de Ejecución (Opción 5)
// ---------------------------------------------------------------------------

export interface PiChainStep {
  name: string;
  output?: string;
  reads?: string;
  description?: string;
}

export interface PiChain {
  name: string;
  description: string;
  path: string;
  steps: PiChainStep[];
}

export function discoverPiChains(): PiChain[] {
  const chains: PiChain[] = [];
  const dirs = [
    path.join(PI_AGENT_DIR, 'chains'),
    path.join(PI_AGENT_DIR, 'npm', 'node_modules', 'gentle-pi', 'assets', 'chains'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.chain.md'));
    for (const f of entries) {
      try {
        const fullPath = path.join(dir, f);
        const content = fs.readFileSync(fullPath, 'utf8');
        const trimmed = content.trim();

        let frontmatter = '';
        if (trimmed.startsWith('---')) {
          const after = trimmed.slice(3);
          const endIdx = after.indexOf('\n---');
          if (endIdx !== -1) {
            frontmatter = after.slice(0, endIdx);
          }
        }

        let name = f.replace(/\.chain\.md$/, '');
        let description = '';

        if (frontmatter) {
          const nameMatch = frontmatter.match(/name:\s*([^\n\r]+)/);
          if (nameMatch) name = nameMatch[1].trim();

          const descMatch = frontmatter.match(/description:\s*([^\n\r]+)/);
          if (descMatch) description = descMatch[1].trim();
        }

        // Parse steps (## <step>)
        const steps: PiChainStep[] = [];
        const sections = content.split(/\n##\s+/);
        for (let i = 1; i < sections.length; i++) {
          const sec = sections[i];
          const lines = sec.split('\n');
          const stepName = lines[0].trim();
          if (stepName.toLowerCase().includes('guard') || stepName.toLowerCase().includes('transport')) {
            continue; // Skip guards
          }
          const outputMatch = sec.match(/output:\s*([^\n\r]+)/);
          const readsMatch = sec.match(/reads:\s*([^\n\r]+)/);
          const stepDesc = lines.slice(1).filter((l) => !l.includes(':')).join(' ').trim();

          steps.push({
            name: stepName,
            output: outputMatch ? outputMatch[1].trim() : undefined,
            reads: readsMatch ? readsMatch[1].trim() : undefined,
            description: stepDesc.slice(0, 140),
          });
        }

        // Avoid duplicate by name
        if (!chains.some((c) => c.name === name)) {
          chains.push({
            name,
            description,
            path: fullPath,
            steps,
          });
        }
      } catch {}
    }
  }

  return chains;
}

// ---------------------------------------------------------------------------
// Engram Real Memory & Observations (Opción 2)
// ---------------------------------------------------------------------------

function getEngramBin(): string {
  return getBridgeConfig().engramBinary;
}

const engramProjectCache = new Map<string, { project: string | null; expires: number }>();

export function getEngramProjectImpl(cwd?: string): string | null {
  const targetDir = cwd || activeCwd;
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

// ---------------------------------------------------------------------------
// MCP & Extensions
// ---------------------------------------------------------------------------

function readMcpServersFromFile(filePath: string, scope: 'global' | 'project'): any[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sMap = data.mcpServers || data.servers || {};
    return Object.entries<any>(sMap).map(([name, cfg]) => ({
      name,
      command: cfg.command || '',
      args: cfg.args || [],
      url: cfg.url || undefined,
      serverType: cfg.url ? 'sse' : 'stdio',
      envKeys: cfg.env ? Object.keys(cfg.env) : [],
      disabled: Boolean(cfg.disabled),
      enabled: !cfg.disabled,
      scope,
      configPath: filePath,
      env: cfg.env || {},
      headers: cfg.headers || {},
    }));
  } catch {
    return [];
  }
}

export function getMcpServersImpl(cwd?: string) {
  const mcpGlobalFile = path.join(PI_AGENT_DIR, 'mcp.json');
  const servers: any[] = [];
  const seen = new Set<string>();

  const globalServers = readMcpServersFromFile(mcpGlobalFile, 'global');
  for (const s of globalServers) {
    servers.push(s);
    seen.add(s.name);
  }

  if (cwd) {
    const projectCandidates = [
      path.join(cwd, '.pi', 'mcp.json'),
      path.join(cwd, '.mcp.json'),
      path.join(cwd, 'mcp-adapter.json'),
    ];
    for (const pFile of projectCandidates) {
      const pServers = readMcpServersFromFile(pFile, 'project');
      for (const s of pServers) {
        if (!seen.has(s.name)) {
          servers.push(s);
          seen.add(s.name);
        }
      }
    }
  }

  return { servers };
}

export function getPiResourcesImpl(_cwd?: string) {
  const resources: any[] = [];
  const settingsFile = path.join(PI_AGENT_DIR, 'settings.json');

  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (Array.isArray(settings.packages)) {
        for (const pkg of settings.packages) {
          const pkgStr = typeof pkg === 'string' ? pkg : pkg.source || String(pkg);
          let cleanName = pkgStr.replace(/^(npm:|https:\/\/github\.com\/)/, '');
          const lastAt = cleanName.lastIndexOf('@');
          if (lastAt > 0) {
            cleanName = cleanName.slice(0, lastAt);
          }
          const safeId = `pkg-${cleanName.replace(/[\/@:]/g, '-')}`;
          resources.push({
            id: safeId,
            name: cleanName,
            kind: 'package',
            source: pkgStr,
            scope: 'global',
            enabled: true,
            configPath: settingsFile,
          });
        }
      }
    } catch {}
  }

  const extensionsDir = path.join(PI_AGENT_DIR, 'extensions');
  if (fs.existsSync(extensionsDir)) {
    const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const cleanName = e.name.replace(/\.(ts|js|mjs)$/, '');
      resources.push({
        id: `ext-${cleanName}`,
        name: cleanName,
        kind: 'extension',
        source: e.name,
        scope: 'global',
        enabled: true,
        configPath: path.join(extensionsDir, e.name),
        autoload: true,
      });
    }
  }

  return { resources };
}

export function getAvailableModelsImpl() {
  const modelsFile = path.join(PI_AGENT_DIR, 'models.json');
  const list: any[] = [];

  if (fs.existsSync(modelsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
      if (parsed.providers) {
        for (const [providerId, p] of Object.entries<any>(parsed.providers)) {
          if (Array.isArray(p.models)) {
            for (const m of p.models) {
              list.push({
                id: m.id,
                name: m.name || m.id,
                provider: providerId,
                contextWindow: m.contextWindow || 1048576,
                maxTokens: m.maxTokens || 65536,
                reasoning: m.reasoning !== false,
                reasoningEfforts: ['off', 'low', 'medium', 'high'],
                input: m.input || ['text', 'image'],
                input_modalities: m.input || ['text', 'image'],
              });
            }
          }
        }
      }
    } catch {}
  }

  list.push(
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      provider: 'openai-codex',
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      input: ['text', 'image'],
      input_modalities: ['text', 'image'],
    },
    {
      id: 'gpt-5',
      name: 'GPT-5',
      provider: 'openai-codex',
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      input: ['text', 'image'],
      input_modalities: ['text', 'image'],
    }
  );

  return list;
}

// ---------------------------------------------------------------------------
// IPC Command Dispatcher
// ---------------------------------------------------------------------------

export async function handleIpcCommand(cmd: string, args: any = {}) {
  switch (cmd) {
    case 'discover_environment': {
      const cfg = getBridgeConfig();
      const nodePath = cfg.nodeExecutable;
      const piCli = cfg.piCliPath;
      const isDiscovered = Boolean(piCli && fs.existsSync(piCli));

      return {
        status: isDiscovered ? 'ready' : 'missing',
        entrypoint: {
          status: isDiscovered ? 'discovered' : 'missing',
          path: piCli,
          candidates: piCli ? [piCli] : [],
          message: isDiscovered ? null : 'Pi CLI entrypoint not detected. Configure piCliPath in server/config.json or install globally.',
        },
        initialDirectory: {
          status: 'discovered',
          path: activeCwd,
          message: null,
        },
        nodePath,
        issues: isDiscovered ? [] : ['missing_entrypoint'],
      };
    }

    case 'detect_gentle_shell': {
      return {
        status: 'missing',
        path: null,
        entrypoint: null,
        candidates: [],
        message: null,
      };
    }

    case 'connect': {
      const payload = args.payload || {};
      const requestedCwd = payload.workingDirectory || activeCwd;
      const targetCwd = resolveCrossPlatformCwd(requestedCwd);
      const previousCwd = activeCwd;
      const projectChanged = path.resolve(targetCwd) !== path.resolve(previousCwd);
      activeCwd = targetCwd;

      if (projectChanged) {
        activeSessionFile = null;
        activeSessionId = null;
      }

      const sessions = listSessions(targetCwd);
      let targetFile = payload.sessionFile;
      if (!targetFile && sessions.length > 0) {
        targetFile = sessions[0].path;
      }

      let parsed: any = null;
      if (targetFile && fs.existsSync(targetFile)) {
        parsed = parseSessionFile(targetFile);
      }

      const resolvedSessionId = parsed?.id || piRpc.sessionId || `sess-${Date.now()}`;
      const resolvedSessionFile = targetFile || piRpc.sessionFile || null;

      piRpc.sessionFile = resolvedSessionFile;
      piRpc.sessionId = resolvedSessionId;

      // Warm up RPC process in background without blocking fast connection
      void piRpc.ensureRunning(targetCwd, resolvedSessionFile).catch((err) => {
        console.warn('[Pi RPC ensureRunning error]:', err);
      });

      let initialMessages: any[] = [];
      if (parsed?.messages) {
        const total = parsed.messages.length;
        const loadAll = Boolean(payload.loadAll);
        // Window messages to recent 80 on connect for instantaneous load across network
        initialMessages = loadAll || total <= 80 ? parsed.messages : parsed.messages.slice(-80);
      }

      return {
        connected: true,
        model: piRpc.modelInfo || activeModel,
        sessionId: resolvedSessionId,
        sessionFile: resolvedSessionFile,
        messageCount: parsed?.messageCount || 0,
        canonicalCwd: activeCwd,
        messages: initialMessages,
      };
    }

    case 'send_prompt': {
      const payload = args.payload || {};
      const id = payload.id;
      const message = payload.message;
      const images = payload.images;
      const streamingBehavior = payload.streamingBehavior || 'followUp';
      const targetSessionFile = payload.sessionFile || activeSessionFile;

      if (!id || !message) {
        throw new Error('Prompt ID and message are required');
      }

      const rpc = await getOrCreatePiRpc(activeCwd, targetSessionFile);
      if (rpc.sessionFile) {
        setSessionStatus(rpc.sessionFile, 'working', rpc.sessionId);
      }

      const res = await rpc.sendCommand({
        id,
        type: 'prompt',
        message,
        images,
        streamingBehavior,
      });

      if (res && res.success === false && res.error) {
        if (rpc.sessionFile) {
          setSessionStatus(rpc.sessionFile, 'completed', rpc.sessionId);
        }
        throw new Error(res.error);
      }

      return { id };
    }

    case 'send_extension_ui_response': {
      const payload = args.payload || {};
      const id = payload.id;
      if (!id) {
        throw new Error('Extension UI response missing required request ID');
      }

      const responseObj: any = {
        type: 'extension_ui_response',
        id,
      };

      if (payload.cancelled) {
        responseObj.cancelled = true;
      } else if (typeof payload.confirmed === 'boolean') {
        responseObj.confirmed = payload.confirmed;
      } else if (payload.value !== undefined) {
        responseObj.value = payload.value;
      } else {
        responseObj.cancelled = true;
      }

      const targetCwd = payload.cwd ? resolveCrossPlatformCwd(payload.cwd) : activeCwd;
      const targetSessionFile = payload.sessionFile || activeSessionFile;
      const rpc = await getOrCreatePiRpc(targetCwd, targetSessionFile);

      if (!rpc || !rpc.isAlive()) {
        throw new Error('Pi RPC session is not active');
      }

      const written = rpc.sendRaw(responseObj);
      if (!written) {
        throw new Error('Failed to write extension UI response to Pi CLI stdin');
      }

      if (rpc.sessionFile) {
        setSessionStatus(rpc.sessionFile, 'working', rpc.sessionId);
      }

      return {
        id,
        success: true,
      };
    }

    case 'abort': {
      if (piRpc.isAlive()) {
        await piRpc.sendCommand({ id: `abort-${Date.now()}`, type: 'abort' }, 5000);
      }
      return null;
    }

    case 'disconnect': {
      piRpc.kill();
      return null;
    }

    case 'list_sessions': {
      const payload = args.payload || {};
      const targetCwd = payload.workingDirectory || activeCwd;
      return listSessions(targetCwd);
    }

    case 'switch_session': {
      const sessionPath = args.payload?.sessionPath || args.sessionPath;
      const loadAll = Boolean(args.payload?.loadAll ?? args.loadAll);
      const limit = args.payload?.limit ?? args.limit ?? (loadAll ? undefined : 60);

      if (!sessionPath || !fs.existsSync(sessionPath)) {
        return {
          cancelled: false,
          error: `Session file not found: ${sessionPath}`,
          messages: [],
          messageCount: 0,
        };
      }

      const parsed = parseSessionFile(sessionPath);
      if (!parsed) {
        return {
          cancelled: false,
          error: 'Failed to parse session file',
          messages: [],
          messageCount: 0,
        };
      }

      activeSessionFile = sessionPath;
      activeSessionId = parsed.id;

      // Warm target session process in pool without killing or aborting other sessions!
      void getOrCreatePiRpc(activeCwd, sessionPath).catch(() => {});

      const totalCount = parsed.messageCount;
      const allMsgs = parsed.messages || [];
      const messagesToSend = limit && limit < allMsgs.length ? allMsgs.slice(-limit) : allMsgs;

      return {
        cancelled: false,
        sessionId: parsed.id,
        sessionFile: parsed.path,
        messageCount: totalCount,
        messages: messagesToSend,
        hasMore: allMsgs.length > messagesToSend.length,
        status: getSessionStatus(sessionPath),
        error: null,
      };
    }

    case 'get_messages': {
      if (piRpc.sessionFile && fs.existsSync(piRpc.sessionFile)) {
        const parsed = parseSessionFile(piRpc.sessionFile);
        return parsed?.messages || [];
      }
      return [];
    }

    case 'new_session': {
      const dir = resolveSessionsDir(activeCwd);
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      const iso = now.toISOString();
      const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `${iso.replace(/[:.]/g, '-')}_${id}.jsonl`;
      const filePath = path.join(dir, fileName);

      const header = {
        type: 'session',
        version: 3,
        id,
        timestamp: iso,
        cwd: activeCwd,
      };
      fs.writeFileSync(filePath, JSON.stringify(header) + '\n', 'utf8');

      piRpc.sessionId = id;
      piRpc.sessionFile = filePath;
      setSessionStatus(filePath, 'completed', id);

      // Calentamiento en segundo plano sin bloquear la respuesta de la UI
      void piRpc.ensureRunning(activeCwd, filePath).catch((err) => {
        console.warn('[Pi RPC new_session warmup error]:', err);
      });

      return {
        cancelled: false,
        sessionId: id,
        sessionFile: filePath,
      };
    }

    case 'delete_session': {
      const sessionPath = args.payload?.sessionPath || args.sessionPath;
      let wasActive = false;
      if (sessionPath && fs.existsSync(sessionPath)) {
        if (sessionPath === piRpc.sessionFile) {
          wasActive = true;
          piRpc.kill();
        }
        try {
          fs.unlinkSync(sessionPath);
        } catch {
          return { success: false, wasActive };
        }
      }
      return { success: true, wasActive };
    }

    case 'rename_session': {
      const sessionPath = args.payload?.sessionPath || args.sessionPath;
      const newTitle = (args.payload?.newTitle || args.newTitle || '').trim();
      if (!sessionPath || !fs.existsSync(sessionPath) || !newTitle) {
        return { success: false };
      }

      try {
        // 1. If active in running Pi RPC session, notify active Pi process
        if (piRpc.isAlive()) {
          try {
            await piRpc.sendCommand(
              {
                id: `rename-${Date.now()}`,
                type: 'set_session_name',
                name: newTitle,
              },
              3000
            );
          } catch (e) {
            console.warn('[Pi RPC set_session_name warning]:', e);
          }
        }

        // 2. Append standard Pi session_info entry via Pi SessionManager
        try {
          const cfg = getBridgeConfig();
          let sessionManagerModule: any = null;
          if (cfg.piCliPath) {
            const cliDir = path.dirname(cfg.piCliPath);
            const candidates = [
              path.join(cliDir, '..', 'core', 'session-manager.js'),
              path.join(cliDir, '..', '..', 'core', 'session-manager.js'),
            ];
            for (const cand of candidates) {
              if (fs.existsSync(cand)) {
                sessionManagerModule = require(cand);
                break;
              }
            }
          }
          if (sessionManagerModule?.SessionManager) {
            const mgr = sessionManagerModule.SessionManager.open(sessionPath);
            mgr.appendSessionInfo(newTitle);
          } else {
            throw new Error('SessionManager not found');
          }
        } catch {
          // Fallback: manually append Pi-compatible session_info entry
          const content = fs.readFileSync(sessionPath, 'utf8');
          const lines = content.split('\n').filter((l: string) => l.trim().length > 0);
          let parentId = null;
          if (lines.length > 0) {
            try {
              const last = JSON.parse(lines[lines.length - 1]);
              parentId = last.id || null;
            } catch {}
          }
          const shortId = Math.random().toString(16).slice(2, 10);
          const entry = {
            type: 'session_info',
            id: shortId,
            parentId,
            timestamp: new Date().toISOString(),
            name: newTitle,
          };
          fs.appendFileSync(sessionPath, JSON.stringify(entry) + '\n', 'utf8');
        }

        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'get_sdd_profiles': {
      const cwd = args.cwd || activeCwd;
      return getSddProfilesImpl(cwd);
    }

    case 'set_active_sdd_profile': {
      return setActiveSddProfileImpl(args.name, args.scope || 'global', args.cwd || activeCwd);
    }

    case 'save_sdd_profile': {
      const profile = args.profile;
      if (!profile || !profile.name) {
        throw new Error('Profile name is required');
      }
      const dir = args.scope === 'project' ? path.join(args.cwd || activeCwd, '.pi', 'profiles') : path.join(PI_AGENT_DIR, 'profiles');
      fs.mkdirSync(dir, { recursive: true });
      const profilePath = path.join(dir, `${slugify(profile.name)}.json`);
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf8');
      return { success: true, profile, path: profilePath, message: `Profile '${profile.name}' saved` };
    }

    case 'delete_sdd_profile': {
      const name = args.name;
      const dir = args.scope === 'project' ? path.join(args.cwd || activeCwd, '.pi', 'profiles') : path.join(PI_AGENT_DIR, 'profiles');
      const profilePath = path.join(dir, `${slugify(name)}.json`);
      if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
      const actFile = path.join(dir, '.active');
      if (fs.existsSync(actFile) && fs.readFileSync(actFile, 'utf8').trim() === name) {
        fs.unlinkSync(actFile);
      }
      return { success: true, message: `Profile '${name}' deleted` };
    }

    case 'get_pi_chains': {
      return discoverPiChains();
    }

    case 'get_available_models': {
      return getAvailableModelsImpl();
    }

    case 'set_model': {
      const { provider, modelId } = args;
      const all = getAvailableModelsImpl();
      const found = all.find((m) => m.provider === provider && m.id === modelId);
      if (found) {
        activeModel = found;
      } else {
        activeModel = { provider, id: modelId, name: modelId };
      }
      if (piRpc.isAlive()) {
        try {
          await piRpc.sendCommand({ id: `model-${Date.now()}`, type: 'set_model', provider, modelId });
        } catch {}
      }
      return activeModel;
    }

    case 'get_available_thinking_levels': {
      return ['off', 'low', 'medium', 'high', 'max'];
    }

    case 'set_thinking_level': {
      activeThinkingLevel = args.level || 'high';
      if (piRpc.isAlive()) {
        try {
          await piRpc.sendCommand({ id: `thinking-${Date.now()}`, type: 'set_thinking_level', level: activeThinkingLevel });
        } catch {}
      }
      return null;
    }

    case 'get_custom_providers': {
      const modelsFile = path.join(PI_AGENT_DIR, 'models.json');
      if (fs.existsSync(modelsFile)) {
        try {
          return JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
        } catch {}
      }
      return { providers: {} };
    }

    case 'save_custom_providers': {
      const modelsFile = path.join(PI_AGENT_DIR, 'models.json');
      let rootObj: any = {};
      if (fs.existsSync(modelsFile)) {
        try {
          rootObj = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
        } catch {}
      }
      rootObj.providers = args.providers;
      fs.writeFileSync(modelsFile, JSON.stringify(rootObj, null, 2) + '\n', 'utf8');
      return rootObj;
    }

    case 'get_model_thinking_levels': {
      const settingsFile = path.join(PI_AGENT_DIR, 'settings.json');
      if (fs.existsSync(settingsFile)) {
        try {
          const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
          return s.modelThinkingLevels || {};
        } catch {}
      }
      return {};
    }

    case 'save_model_thinking_levels': {
      const settingsFile = path.join(PI_AGENT_DIR, 'settings.json');
      let settings: any = {};
      if (fs.existsSync(settingsFile)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        } catch {}
      }
      settings.modelThinkingLevels = args.levels;
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      return settings.modelThinkingLevels;
    }

    case 'get_mcp_servers': {
      return getMcpServersImpl(args.cwd || activeCwd);
    }

    case 'toggle_mcp_server': {
      const { name, enabled, cwd, configPath } = args;
      let mcpFile = configPath;
      if (!mcpFile || !fs.existsSync(mcpFile)) {
        if (cwd) {
          const candidates = [
            path.join(cwd, '.pi', 'mcp.json'),
            path.join(cwd, '.mcp.json'),
            path.join(cwd, 'mcp-adapter.json'),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) {
              try {
                const d = JSON.parse(fs.readFileSync(c, 'utf8'));
                if (d.mcpServers?.[name] || d.servers?.[name]) {
                  mcpFile = c;
                  break;
                }
              } catch {}
            }
          }
          if (!mcpFile) mcpFile = path.join(cwd, '.pi', 'mcp.json');
        } else {
          mcpFile = path.join(PI_AGENT_DIR, 'mcp.json');
        }
      }
      if (mcpFile && fs.existsSync(mcpFile)) {
        const data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        const targetMap = data.mcpServers || data.servers;
        if (targetMap && targetMap[name]) {
          targetMap[name].disabled = !enabled;
          fs.writeFileSync(mcpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
        }
      }
      return { success: true, name, enabled, path: mcpFile };
    }

    case 'get_pi_resources': {
      return getPiResourcesImpl(args.cwd || activeCwd);
    }

    case 'get_builtin_oauth_providers': {
      return [
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          status: 'authenticated',
          isLoggedIn: true,
        },
      ];
    }

    case 'get_engram_project': {
      return getEngramProjectImpl(args.cwd);
    }

    case 'get_engram_cloud_status': {
      return await getEngramCloudStatusImpl(args.project, args.cwd);
    }

    case 'enroll_engram_project': {
      return enrollEngramProjectImpl(args.project);
    }

    case 'get_engram_observations': {
      return getEngramObservationsImpl(args.project, args.limit || 20);
    }

    case 'list_workspace_dir': {
      const payload = args.payload || {};
      const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || activeCwd);
      const rel = payload.relativePath || '';
      const fullDir = path.join(targetCwd, rel);

      if (!fs.existsSync(fullDir)) return [];

      const entries = fs.readdirSync(fullDir, { withFileTypes: true });
      const results: any[] = [];

      for (const e of entries) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target' || e.name === 'dist') {
          continue;
        }
        const isDir = e.isDirectory();
        const eRel = rel ? path.join(rel, e.name) : e.name;
        let size: number | null = null;
        let ext: string | null = null;

        if (!isDir) {
          try {
            const st = fs.statSync(path.join(fullDir, e.name));
            size = st.size;
            ext = path.extname(e.name).slice(1) || null;
          } catch {}
        }

        results.push({
          name: e.name,
          relativePath: eRel,
          isDir,
          size,
          extension: ext,
        });
      }

      results.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return results;
    }

    case 'read_workspace_file': {
      const payload = args.payload || {};
      const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || activeCwd);
      const rel = payload.relativePath;
      const fullPath = path.join(targetCwd, rel);

      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${rel}`);
      }

      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');

      return {
        relativePath: rel,
        name: path.basename(rel),
        content,
        size: stat.size,
        isBinary: false,
        extension: path.extname(rel).slice(1) || null,
      };
    }

    case 'get_workspace_git_status': {
      const payload = args.payload || {};
      const targetCwd = resolveCrossPlatformCwd(payload.workingDirectory || activeCwd);
      try {
        if (!fs.existsSync(targetCwd)) {
          return { isRepo: false, modifiedFiles: [], addedFiles: [], untrackedFiles: [] };
        }

        const toplevel = execSync('git rev-parse --show-toplevel', {
          cwd: targetCwd,
          encoding: 'utf8',
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        // Avoid treating the entire user HOME folder as a git repository for sub-projects
        if (toplevel === HOME_DIR && targetCwd !== HOME_DIR) {
          return {
            isRepo: false,
            repoName: path.basename(targetCwd),
            branch: 'main',
            modifiedFiles: [],
            addedFiles: [],
            untrackedFiles: [],
          };
        }

        const out = execSync('git status --porcelain', {
          cwd: targetCwd,
          encoding: 'utf8',
          timeout: 2500,
          stdio: ['ignore', 'pipe', 'ignore'],
        });

        let branchOut = 'main';
        try {
          branchOut = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: targetCwd,
            encoding: 'utf8',
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {}

        const modifiedFiles: string[] = [];
        const addedFiles: string[] = [];
        const untrackedFiles: string[] = [];

        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          const status = line.slice(0, 2);
          const file = line.slice(3).trim();
          if (status.includes('M')) modifiedFiles.push(file);
          else if (status.includes('A')) addedFiles.push(file);
          else if (status.includes('?')) untrackedFiles.push(file);
          else modifiedFiles.push(file);
        }

        return {
          isRepo: true,
          repoName: path.basename(toplevel || targetCwd),
          branch: branchOut || 'main',
          modifiedFiles,
          addedFiles,
          untrackedFiles,
        };
      } catch {
        return {
          isRepo: false,
          modifiedFiles: [],
          addedFiles: [],
          untrackedFiles: [],
        };
      }
    }

    case 'get_session_stats': {
      if (piRpc.isAlive()) {
        try {
          const statsRes = await piRpc.sendCommand({ id: `stats-${Date.now()}`, type: 'get_session_stats' }, 3000);
          if (statsRes?.data?.tokens && statsRes.data.contextUsage) {
            return statsRes.data;
          }
        } catch {}
      }

      const currentFile = piRpc.sessionFile || (listSessions(activeCwd)[0]?.path);
      if (currentFile && fs.existsSync(currentFile)) {
        const stats = calculateSessionStats(currentFile, (activeModel as any).contextWindow || 1048576);
        if (stats) return stats;
      }

      return {
        sessionId: piRpc.sessionId || undefined,
        sessionFile: piRpc.sessionFile || undefined,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage: { tokens: 0, contextWindow: (activeModel as any).contextWindow || 1048576, percent: 0 },
      };
    }

    case 'get_session_persistence_status': {
      return {
        sessionId: piRpc.sessionId || 'default-session',
        sessionFile: piRpc.sessionFile || '',
        canonicalCwd: activeCwd,
        generation: 1,
        messageCount: 1,
        fileExists: Boolean(piRpc.sessionFile && fs.existsSync(piRpc.sessionFile)),
      };
    }

    case 'discover_all_projects': {
      return discoverAllProjectsWithSessions();
    }

    case 'pick_directory': {
      const cfg = getBridgeConfig();
      return args.defaultPath || activeCwd || cfg.baseWorkspace || getHomeDir();
    }

    case 'get_bridge_state': {
      return {
        connected: true,
        cwd: activeCwd,
        sessionId: piRpc.sessionId,
      };
    }

    case 'browse_filesystem': {
      const payload = args.payload || args || {};
      const cfg = getBridgeConfig();
      let requestedDir = payload.path ? resolveCrossPlatformCwd(payload.path) : (activeCwd || cfg.baseWorkspace || getHomeDir());
      if (!fs.existsSync(requestedDir)) {
        requestedDir = fs.existsSync(cfg.baseWorkspace) ? cfg.baseWorkspace : getHomeDir();
      }

      try {
        const st = fs.statSync(requestedDir);
        if (!st.isDirectory()) {
          requestedDir = path.dirname(requestedDir);
        }
      } catch {
        requestedDir = getHomeDir();
      }

      const canonicalDir = path.resolve(requestedDir);
      const parentDir = path.dirname(canonicalDir) !== canonicalDir ? path.dirname(canonicalDir) : null;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(canonicalDir, { withFileTypes: true });
      } catch {}

      const folders: { name: string; fullPath: string; windowsPath?: string }[] = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name.startsWith('.') && e.name !== '.gentle-ai') continue;
          if (e.name === 'node_modules' || e.name === 'target' || e.name === 'dist' || e.name === '.git') continue;
          const full = path.join(canonicalDir, e.name);
          folders.push({
            name: e.name,
            fullPath: full,
            ...(process.platform === 'win32' ? { windowsPath: full } : {}),
          });
        }
      }

      folders.sort((a, b) => a.name.localeCompare(b.name));

      const windowsPath = process.platform === 'win32' ? canonicalDir : null;

      return {
        currentPath: canonicalDir,
        windowsPath,
        parentPath: parentDir,
        folders,
        shortcuts: getFilesystemShortcuts(cfg.baseWorkspace),
      };
    }

    default: {
      return null;
    }
  }
}
