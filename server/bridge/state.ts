import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getHomeDir, getBridgeConfig } from '../config';
import { broadcastSse } from './sse';

export const HOME_DIR = getHomeDir();
export const PI_AGENT_DIR = path.join(HOME_DIR, '.pi', 'agent');
export const DEFAULT_SESSIONS_ROOT = path.join(PI_AGENT_DIR, 'sessions');

let customSessionsRoot: string | null = null;

export function setSessionsRootDirForTest(dir: string | null): void {
  customSessionsRoot = dir;
}

export function getSessionsRootDir(): string {
  return customSessionsRoot || DEFAULT_SESSIONS_ROOT;
}

export type SubprocessSpawner = (
  command: string,
  args: string[],
  options: any
) => ChildProcess | null;

let customSubprocessSpawner: SubprocessSpawner | null = null;

export function setSubprocessSpawnerForTest(spawner: SubprocessSpawner | null): void {
  customSubprocessSpawner = spawner;
}

export function getSubprocessSpawner(): SubprocessSpawner | null {
  return customSubprocessSpawner;
}

export type SessionStatus = 'working' | 'completed' | 'waiting';

export const sessionStatusMap = new Map<string, SessionStatus>();

let sessionAliveChecker: (norm: string) => boolean = () => false;

export function setSessionAliveChecker(checker: (norm: string) => boolean): void {
  sessionAliveChecker = checker;
}

export function getSessionStatus(sessionPath: string): SessionStatus | undefined {
  const norm = sessionPath ? path.resolve(sessionPath) : '';
  if (!norm) return undefined;

  const isAlive = sessionAliveChecker(norm);

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
  return undefined;
}

export function setSessionStatus(
  sessionPath: string,
  status: SessionStatus,
  sessionId?: string | null
): void {
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

export const sessionParseCache = new Map<string, { mtimeMs: number; size: number; parsed: any }>();

export function invalidateSessionParseCache(filePath: string): void {
  sessionParseCache.delete(filePath);
}

let activeSessionFile: string | null = null;
let activeSessionId: string | null = null;
let activeCwd: string = getBridgeConfig().baseWorkspace || process.cwd();
let activeModel = {
  provider: 'antigravity-cpa',
  id: 'Gem/gemini-3.8-flash-high',
  name: 'CPAMC Active · Gemini 3.8 Flash High',
};
let activeThinkingLevel: string = 'high';

export function getActiveCwd(): string {
  return activeCwd;
}

export function setActiveCwd(cwd: string): void {
  activeCwd = cwd;
}

export function getActiveSessionFile(): string | null {
  return activeSessionFile;
}

export function setActiveSessionFile(file: string | null): void {
  activeSessionFile = file;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id;
}

export function getActiveModel(): any {
  return activeModel;
}

export function setActiveModel(model: any): void {
  activeModel = model;
}

export function getActiveThinkingLevel(): string {
  return activeThinkingLevel;
}

export function setActiveThinkingLevel(level: string): void {
  activeThinkingLevel = level;
}
