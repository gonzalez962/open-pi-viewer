import fs from 'node:fs';
import path from 'node:path';
import type { TerminalSessionDto } from '../../src/core/terminal';

export const DEFAULT_MAX_REPLAY_BYTES = 256 * 1024; // 256 KB bounded history
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export function resolveDefaultShell(): string {
  if (process.platform === 'win32') {
    // Windows default shell must not prefer POSIX SHELL (e.g. MSYS/Git Bash/Cygwin)
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

export function resolveCanonicalCwd(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

export function toCanonicalKey(canonicalPath: string): string {
  const normalized = path.normalize(canonicalPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export interface TerminalManagerOptions {
  maxReplayBytes?: number;
  defaultShell?: string;
}

export interface TerminalSessionInternal extends TerminalSessionDto {
  getReplay(): string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
