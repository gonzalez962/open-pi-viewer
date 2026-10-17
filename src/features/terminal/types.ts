import type { TerminalSessionDto } from '@core/terminal';

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'exited';

export interface TerminalState {
  isOpen: boolean;
  activeCwd: string | null;
  sessions: Record<string, TerminalSessionDto>;
  cursors: Record<string, number>;
  status: TerminalStatus;
  errorMessage: string | null;
  exitCode: number | null;
}

export type TerminalAction =
  | { type: 'OPEN'; payload: { cwd: string } }
  | { type: 'MINIMIZE' }
  | { type: 'SESSION_OPENED'; payload: { cwd: string; session: TerminalSessionDto } }
  | { type: 'SESSION_TERMINATED'; payload: { cwd: string } }
  | { type: 'SWITCH_PROJECT'; payload: { cwd: string } }
  | { type: 'SET_STATUS'; payload: { status: TerminalStatus; error?: string | null } }
  | { type: 'PROCESS_EXITED'; payload: { exitCode: number | null } };
