import fs from 'node:fs';
import {
  type TerminalOpenArgs,
  type TerminalWriteArgs,
  type TerminalResizeArgs,
  type TerminalCloseArgs,
  type TerminalPollArgs,
  type TerminalPollResult,
  type TerminalSessionDto,
} from '../../src/core/terminal';
import { TerminalSession } from './terminal-session';
import {
  resolveCanonicalCwd,
  toCanonicalKey,
  type TerminalManagerOptions,
} from './types';

export class TerminalManager {
  private readonly sessionsById = new Map<string, TerminalSession>();
  private readonly sessionsByCwd = new Map<string, Set<TerminalSession>>();
  private readonly options: TerminalManagerOptions;

  constructor(options: TerminalManagerOptions = {}) {
    this.options = options;
  }

  async openSession(args: TerminalOpenArgs, _owner?: string): Promise<TerminalSessionDto> {
    if (!args || typeof args.cwd !== 'string' || !args.cwd.trim()) {
      throw new Error('Working directory (cwd) is required to open a terminal session');
    }

    const canonicalCwd = resolveCanonicalCwd(args.cwd);
    if (!fs.existsSync(canonicalCwd) || !fs.statSync(canonicalCwd).isDirectory()) {
      throw new Error(`Target directory does not exist or is not a directory: ${args.cwd}`);
    }

    const cwdKey = toCanonicalKey(canonicalCwd);
    const sessions = this.sessionsByCwd.get(cwdKey) ?? new Set<TerminalSession>();

    for (const existing of sessions) {
      if (existing.running) {
        if (!args.createNew) return existing.toDto(true);
        continue;
      }
      // Dead process; clean up before respawning
      this.sessionsById.delete(existing.id);
      sessions.delete(existing);
      // An exited PTY already owns its cleanup; no asynchronous gap before spawn.
    }

    const session = new TerminalSession({
      cwd: args.cwd,
      canonicalCwd,
      cols: args.cols,
      rows: args.rows,
      shell: this.options.defaultShell,
      maxReplayBytes: this.options.maxReplayBytes,
      owner: _owner,
    });

    this.sessionsById.set(session.id, session);
    sessions.add(session);
    this.sessionsByCwd.set(cwdKey, sessions);

    return session.toDto(true);
  }

  writeSession(args: TerminalWriteArgs, _owner?: string): void {
    if (!args || typeof args.id !== 'string' || !args.id.trim()) {
      throw new Error('Terminal session ID is required for write');
    }
    if (typeof args.data !== 'string') {
      throw new Error('Data string is required for write');
    }
    const session = this.sessionsById.get(args.id);
    if (!session) {
      throw new Error(`Terminal session not found: ${args.id}`);
    }
    session.write(args.data);
  }

  resizeSession(args: TerminalResizeArgs, _owner?: string): void {
    if (!args || typeof args.id !== 'string' || !args.id.trim()) {
      throw new Error('Terminal session ID is required for resize');
    }
    const session = this.sessionsById.get(args.id);
    if (!session) {
      throw new Error(`Terminal session not found: ${args.id}`);
    }
    if (
      typeof args.cols !== 'number' ||
      typeof args.rows !== 'number' ||
      !Number.isFinite(args.cols) ||
      !Number.isFinite(args.rows) ||
      args.cols <= 0 ||
      args.rows <= 0
    ) {
      throw new Error('Valid positive cols and rows are required for resize');
    }
    session.resize(args.cols, args.rows);
  }

  async closeSession(args: TerminalCloseArgs, _owner?: string): Promise<void> {
    if (!args || typeof args.id !== 'string' || !args.id.trim()) {
      throw new Error('Terminal session ID is required for close');
    }
    const session = this.sessionsById.get(args.id);
    if (!session) {
      throw new Error(`Terminal session not found: ${args.id}`);
    }
    this.sessionsById.delete(session.id);
    const cwdKey = toCanonicalKey(session.canonicalCwd);
    const sessions = this.sessionsByCwd.get(cwdKey);
    sessions?.delete(session);
    if (sessions?.size === 0) this.sessionsByCwd.delete(cwdKey);
    await session.kill();
  }

  async pollSession(args: TerminalPollArgs, _owner?: string, signal?: AbortSignal): Promise<TerminalPollResult> {
    if (!args || typeof args.id !== 'string' || !args.id.trim()) {
      throw new Error('Terminal session ID is required for poll');
    }
    const session = this.sessionsById.get(args.id);
    if (!session) {
      throw new Error(`Terminal session not found: ${args.id}`);
    }

    const cursor = typeof args.cursor === 'number' && Number.isFinite(args.cursor) && args.cursor >= 0 ? args.cursor : 0;
    const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, 30000)
      : 0;

    const { data, nextCursor } = await session.waitForOutput(cursor, timeoutMs, signal);

    return {
      id: session.id,
      data,
      cursor: nextCursor,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.exitSignal,
    };
  }

  getSession(id: string, _owner?: string): TerminalSessionDto | null {
    if (!id || typeof id !== 'string') return null;
    const session = this.sessionsById.get(id);
    if (!session) return null;
    return session.toDto(true);
  }

  getSessionByCwd(cwd: string, _owner?: string): TerminalSessionDto | null {
    if (!cwd || typeof cwd !== 'string') return null;
    const canonical = resolveCanonicalCwd(cwd);
    const session = this.sessionsByCwd.get(toCanonicalKey(canonical))?.values().next().value;
    if (!session) return null;
    return session.toDto(true);
  }

  listSessions(_owner?: string): TerminalSessionDto[] {
    const list: TerminalSessionDto[] = [];
    for (const s of this.sessionsById.values()) {
      list.push(s.toDto(false));
    }
    return list;
  }

  onSessionData(id: string, listener: (data: string) => void): () => void {
    const session = this.sessionsById.get(id);
    if (!session) {
      throw new Error(`Terminal session not found: ${id}`);
    }
    return session.onData(listener);
  }

  async dispose(): Promise<void> {
    const sessions = Array.from(this.sessionsById.values());
    this.sessionsById.clear();
    this.sessionsByCwd.clear();
    await Promise.allSettled(sessions.map((s) => s.kill()));
  }
}

let defaultManager: TerminalManager | null = null;

export function createTerminalManager(options?: TerminalManagerOptions): TerminalManager {
  return new TerminalManager(options);
}

export function getTerminalManager(): TerminalManager {
  if (!defaultManager) {
    defaultManager = new TerminalManager();
  }
  return defaultManager;
}

export async function resetTerminalManagerForTest(): Promise<void> {
  if (defaultManager) {
    const mgr = defaultManager;
    defaultManager = null;
    await mgr.dispose();
  }
}
