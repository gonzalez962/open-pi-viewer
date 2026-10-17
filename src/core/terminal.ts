/**
 * Shared Terminal DTO, command, and event contract for Web (T1), Tauri (T2), and UI (T3).
 */

export const TERMINAL_COMMANDS = {
  OPEN: 'terminal_open',
  WRITE: 'terminal_write',
  RESIZE: 'terminal_resize',
  CLOSE: 'terminal_close',
  POLL: 'terminal_poll',
  GET: 'terminal_get',
  LIST: 'terminal_list',
} as const;

export type TerminalCommandName = typeof TERMINAL_COMMANDS[keyof typeof TERMINAL_COMMANDS];

export const TERMINAL_EVENTS = {
  DATA: 'pi://terminal-data',
  EXIT: 'pi://terminal-exit',
} as const;

export type TerminalEventName = typeof TERMINAL_EVENTS[keyof typeof TERMINAL_EVENTS];

export interface TerminalOpenArgs {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface TerminalWriteArgs {
  id: string;
  data: string;
}

export interface TerminalResizeArgs {
  id: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseArgs {
  id: string;
}

export interface TerminalPollArgs {
  id: string;
  cursor?: number;
  timeoutMs?: number;
}

export interface TerminalPollResult {
  id: string;
  data: string;
  cursor: number;
  running: boolean;
  exitCode?: number | null;
  signal?: number;
}

export interface TerminalGetArgs {
  id?: string;
  cwd?: string;
}

export interface TerminalSessionDto {
  id: string;
  cwd: string;
  canonicalCwd: string;
  cols: number;
  rows: number;
  pid: number;
  running: boolean;
  createdAt: number;
  replay?: string;
  cursor?: number;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number | null;
  signal?: number;
}
