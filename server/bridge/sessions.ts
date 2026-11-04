import { todoFromHistory } from '../../src/core/todo';
import fs from 'node:fs';
import path from 'node:path';
import { getBridgeConfig } from '../config';
import { resolveCrossPlatformCwd } from './paths';
import {
  HOME_DIR,
  getSessionsRootDir,
  sessionParseCache,
  getSessionStatus,
  setSessionStatus,
  getActiveCwd,
  setActiveCwd,
  setActiveSessionFile,
  setActiveSessionId,
  getActiveModel,
} from './state';
import { piRpc, getOrCreatePiRpc, sessionPool } from './rpc';

export function resolveSessionsDir(cwd: string): string {
  const resolved = resolveCrossPlatformCwd(cwd);
  const norm = path.resolve(resolved);
  const safe1 = '--' + norm.replace(/^\/+/, '').replace(/[\/\\:]/g, '-') + '--';
  const sessionsRoot = getSessionsRootDir();
  const dir1 = path.join(sessionsRoot, safe1);
  if (fs.existsSync(dir1)) {
    const files = fs.readdirSync(dir1).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) return dir1;
  }

  try {
    const real = fs.realpathSync(resolved);
    const safe2 = '--' + real.replace(/^\/+/, '').replace(/[\/\\:]/g, '-') + '--';
    const dir2 = path.join(sessionsRoot, safe2);
    if (fs.existsSync(dir2)) {
      const files2 = fs.readdirSync(dir2).filter((f) => f.endsWith('.jsonl'));
      if (files2.length > 0) return dir2;
    }
  } catch {}

  return dir1;
}

export function discoverAllProjectsWithSessions() {
  const sessionsRoot = getSessionsRootDir();
  if (!fs.existsSync(sessionsRoot)) return [];
  const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  const list: { id: string; path: string; customName: string; sessionCount: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!name.startsWith('--') || !name.endsWith('--')) continue;

    const fullDirPath = path.join(sessionsRoot, name);
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

  const currentCwd = getActiveCwd();
  list.sort((a, b) => {
    if (a.path === currentCwd) return -1;
    if (b.path === currentCwd) return 1;
    return b.sessionCount - a.sessionCount;
  });

  return list;
}

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
  const cwd = targetCwd || getActiveCwd();
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

export async function handleConnect(args: any = {}) {
  const payload = args.payload || {};
  const requestedCwd = payload.workingDirectory || getActiveCwd();
  const targetCwd = resolveCrossPlatformCwd(requestedCwd);
  if (payload.liveOnly) {
    const file = typeof payload.sessionFile === 'string' ? payload.sessionFile : '';
    const live = file ? sessionPool.get(path.resolve(file)) : undefined;
    if (!live?.isAlive() || path.resolve(live.cwd) !== path.resolve(targetCwd)) {
      return { unavailable: true, canonicalCwd: targetCwd, sessionFile: file, sessionId: live?.sessionId ?? null };
    }
    return { connected: true, canonicalCwd: targetCwd, sessionFile: file, sessionId: live.sessionId, model: live.modelInfo, ...(await live.snapshot()) };
  }
  const previousCwd = getActiveCwd();
  const projectChanged = path.resolve(targetCwd) !== path.resolve(previousCwd);
  setActiveCwd(targetCwd);

  if (projectChanged) {
    setActiveSessionFile(null);
    setActiveSessionId(null);
  }

  const sessions = listSessions(targetCwd);
  let targetFile = payload.sessionFile;
  if (!targetFile && sessions.length > 0) {
    targetFile = sessions[0].path;
  }

  if (!targetFile && sessions.length === 0) {
    const dir = resolveSessionsDir(targetCwd);
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
      cwd: targetCwd,
    };
    fs.writeFileSync(filePath, JSON.stringify(header) + '\n', 'utf8');
    targetFile = filePath;
  }

  let parsed: any = null;
  if (targetFile && fs.existsSync(targetFile)) {
    parsed = parseSessionFile(targetFile);
  }

  const resolvedSessionId = parsed?.id || piRpc.sessionId || `sess-${Date.now()}`;
  const resolvedSessionFile = targetFile || piRpc.sessionFile || null;

  piRpc.sessionFile = resolvedSessionFile;
  piRpc.sessionId = resolvedSessionId;
  const live = resolvedSessionFile ? sessionPool.get(path.resolve(resolvedSessionFile)) : null;
  const snapshot = live?.isAlive() ? await live.snapshot() : null;
  if (resolvedSessionFile && !snapshot) {
    setSessionStatus(resolvedSessionFile, 'completed', resolvedSessionId);
  }

  // Warm up RPC process in background without blocking fast connection
  void piRpc.ensureRunning(targetCwd, resolvedSessionFile).catch((err) => {
    console.warn('[Pi RPC ensureRunning error]:', err);
  });

  let initialMessages: any[] = [];
  let hasMore = false;
  const messages = snapshot?.messages ?? parsed?.messages;
  if (messages) {
    const loadAll = Boolean(payload.loadAll);
    const windowed = windowMessages(messages, loadAll, undefined, 80);
    initialMessages = windowed.messages;
    hasMore = windowed.hasMore;
  }

  const todo = todoFromHistory(messages ?? []);
  return {
    connected: true,
    model: piRpc.modelInfo || (getActiveCwd() === targetCwd ? getActiveModel() : null),
    sessionId: resolvedSessionId,
    sessionFile: resolvedSessionFile,
    messageCount: messages?.length || 0,
    canonicalCwd: targetCwd,
    activity: snapshot?.activity ?? 'idle',
    activeJobs: snapshot?.activeJobs ?? [],
    pendingExtensionPrompts: snapshot?.pendingExtensionPrompts ?? [],
    messages: initialMessages,
    ...(todo ? { todo } : {}),
    hasMore,
  };
}

function hasVisibleText(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        block &&
        typeof block === 'object' &&
        (block.type === 'text' || typeof block.text === 'string') &&
        typeof block.text === 'string' &&
        block.text.trim().length > 0
    );
  }
  return false;
}

export function isActivityMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const role = msg.role;
  if (role === 'toolResult') return true;
  if (role === 'assistant') {
    return !hasVisibleText(msg.content);
  }
  return false;
}

export function windowMessages<T extends Record<string, any>>(
  messages: T[],
  loadAll?: boolean,
  limit?: number,
  defaultLimit: number = 60
): { messages: T[]; hasMore: boolean } {
  if (loadAll || !messages || messages.length === 0) {
    return { messages: messages || [], hasMore: false };
  }

  const effectiveLimit = limit !== undefined && limit !== null ? limit : defaultLimit;
  if (effectiveLimit <= 0) {
    return { messages: [], hasMore: messages.length > 0 };
  }

  let conversationalCount = 0;
  let splitIndex = 0;
  let hitLimit = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isActivityMessage(msg)) {
      conversationalCount++;
      if (conversationalCount >= effectiveLimit) {
        splitIndex = i;
        hitLimit = true;
        break;
      }
    }
  }

  if (!hitLimit) {
    return { messages, hasMore: false };
  }

  // Turn boundary adjustment: if splitIndex lands on an assistant or toolResult,
  // expand backwards to include the preceding user prompt so turns remain intact.
  while (splitIndex > 0) {
    const role = messages[splitIndex]?.role;
    if (role === 'assistant' || role === 'toolResult') {
      splitIndex--;
    } else {
      break;
    }
  }

  if (splitIndex === 0) {
    return { messages, hasMore: false };
  }

  return {
    messages: messages.slice(splitIndex),
    hasMore: true,
  };
}

export function handleListSessions(args: any = {}) {
  const payload = args.payload || {};
  const targetCwd = payload.workingDirectory || getActiveCwd();
  return listSessions(targetCwd);
}

export async function handleSwitchSession(args: any = {}) {
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

  setActiveSessionFile(sessionPath);
  setActiveSessionId(parsed.id);

  const live = sessionPool.get(path.resolve(sessionPath));
  const snapshot = live?.isAlive() ? await live.snapshot() : null;
  // Warm target session process in pool without killing or aborting other sessions!
  void getOrCreatePiRpc(getActiveCwd(), sessionPath).catch(() => {});

  const totalCount = parsed.messageCount;
  const allMsgs = snapshot?.messages ?? parsed.messages ?? [];
  const windowed = windowMessages(allMsgs, loadAll, limit, 60);
  const messagesToSend = windowed.messages;
  const hasMore = windowed.hasMore;
  const todo = todoFromHistory(allMsgs);

  return {
    cancelled: false,
    sessionId: parsed.id,
    sessionFile: parsed.path,
    messageCount: totalCount,
    messages: messagesToSend,
    ...(todo ? { todo } : {}),
    hasMore,
    status: getSessionStatus(sessionPath),
    activity: snapshot?.activity,
    activeJobs: snapshot?.activeJobs,
    pendingExtensionPrompts: snapshot?.pendingExtensionPrompts,
    error: null,
  };
}

export function handleGetMessages() {
  if (piRpc.sessionFile && fs.existsSync(piRpc.sessionFile)) {
    const parsed = parseSessionFile(piRpc.sessionFile);
    return parsed?.messages || [];
  }
  return [];
}

export function handleNewSession(args: any = {}) {
  const requestedCwd = args.payload?.workingDirectory;
  if (requestedCwd !== undefined && (typeof requestedCwd !== 'string' || !requestedCwd.trim())) {
    throw new Error('Invalid project directory');
  }
  const activeCwd = resolveCrossPlatformCwd(requestedCwd ?? getActiveCwd());
  try {
    if (!fs.statSync(activeCwd).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('Invalid project directory');
  }
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

  if (path.resolve(activeCwd) === path.resolve(getActiveCwd())) {
    piRpc.sessionId = id;
    piRpc.sessionFile = filePath;
  }
  setSessionStatus(filePath, 'completed', id);

  // Calentamiento en segundo plano sin bloquear la respuesta de la UI
  void piRpc.ensureRunning(activeCwd, filePath).catch((err) => {
    console.warn('[Pi RPC new_session warmup error]:', err);
  });

  return {
    cancelled: false,
    sessionId: id,
    sessionFile: filePath,
    canonicalCwd: activeCwd,
  };
}

export function isSessionPathAllowed(sessionPath: unknown): boolean {
  if (!sessionPath || typeof sessionPath !== 'string') {
    return false;
  }
  if (!sessionPath.endsWith('.jsonl')) {
    return false;
  }
  try {
    if (!fs.existsSync(sessionPath)) {
      return false;
    }
    const sessionsRoot = getSessionsRootDir();
    if (!sessionsRoot || !fs.existsSync(sessionsRoot)) {
      return false;
    }
    const canonicalSessionsRoot = fs.realpathSync(path.resolve(sessionsRoot));
    const canonicalSessionPath = fs.realpathSync(path.resolve(sessionPath));

    if (!canonicalSessionPath.endsWith('.jsonl')) {
      return false;
    }

    const stat = fs.statSync(canonicalSessionPath);
    if (stat.isDirectory()) {
      return false;
    }

    const rootPrefix = canonicalSessionsRoot.endsWith(path.sep)
      ? canonicalSessionsRoot
      : canonicalSessionsRoot + path.sep;

    return (
      canonicalSessionPath.startsWith(rootPrefix) ||
      (process.platform === 'win32' &&
        canonicalSessionPath.toLowerCase().startsWith(rootPrefix.toLowerCase()))
    );
  } catch {
    return false;
  }
}

export function handleDeleteSession(args: any = {}) {
  const sessionPath = args.payload?.sessionPath || args.sessionPath;
  if (!isSessionPathAllowed(sessionPath)) {
    return { success: false, wasActive: false };
  }

  let wasActive = false;
  if (
    sessionPath === piRpc.sessionFile ||
    (piRpc.sessionFile && path.resolve(sessionPath) === path.resolve(piRpc.sessionFile))
  ) {
    wasActive = true;
    piRpc.kill();
  }
  try {
    fs.unlinkSync(sessionPath);
  } catch {
    return { success: false, wasActive };
  }
  return { success: true, wasActive };
}

export async function handleRenameSession(args: any = {}) {
  const sessionPath = args.payload?.sessionPath || args.sessionPath;
  const newTitle = (args.payload?.newTitle || args.newTitle || args.payload?.name || args.name || '').trim();
  if (!sessionPath || !newTitle || !isSessionPathAllowed(sessionPath)) {
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

export async function handleGetSessionStats() {
  if (piRpc.isAlive()) {
    try {
      const statsRes = await piRpc.sendCommand({ id: `stats-${Date.now()}`, type: 'get_session_stats' }, 3000);
      if (statsRes?.data?.tokens && statsRes.data.contextUsage) {
        return statsRes.data;
      }
    } catch {}
  }

  const currentFile = piRpc.sessionFile || (listSessions(getActiveCwd())[0]?.path);
  if (currentFile && fs.existsSync(currentFile)) {
    const stats = calculateSessionStats(currentFile, (getActiveModel() as any).contextWindow || 1048576);
    if (stats) return stats;
  }

  return {
    sessionId: piRpc.sessionId || undefined,
    sessionFile: piRpc.sessionFile || undefined,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextUsage: { tokens: 0, contextWindow: (getActiveModel() as any).contextWindow || 1048576, percent: 0 },
  };
}

export function handleGetSessionPersistenceStatus() {
  return {
    sessionId: piRpc.sessionId || 'default-session',
    sessionFile: piRpc.sessionFile || '',
    canonicalCwd: getActiveCwd(),
    generation: 1,
    messageCount: 1,
    fileExists: Boolean(piRpc.sessionFile && fs.existsSync(piRpc.sessionFile)),
  };
}

export function handleDiscoverAllProjects() {
  return discoverAllProjectsWithSessions();
}
