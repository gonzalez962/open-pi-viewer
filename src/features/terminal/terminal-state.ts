import type { TerminalState, TerminalAction } from './types';

export type { TerminalState, TerminalAction };

export function createInitialTerminalState(): TerminalState {
  return {
    isOpen: false,
    activeCwd: null,
    sessions: {},
    cursors: {},
    status: 'idle',
    errorMessage: null,
    exitCode: null,
  };
}

export function terminalReducer(
  state: TerminalState,
  action: TerminalAction
): TerminalState {
  switch (action.type) {
    case 'OPEN':
      return {
        ...state,
        isOpen: true,
        activeCwd: action.payload.cwd,
        status: state.sessions[action.payload.cwd] ? 'connected' : 'connecting',
        errorMessage: null,
      };

    case 'MINIMIZE':
      return {
        ...state,
        isOpen: false,
        // Sessions and processes remain strictly preserved
      };

    case 'SESSION_OPENED': {
      const { cwd, session } = action.payload;
      const initialCursor = session.cursor ?? (session.replay ? session.replay.length : 0);
      return {
        ...state,
        isOpen: true,
        activeCwd: cwd,
        status: session.running ? 'connected' : 'exited',
        errorMessage: null,
        sessions: {
          ...state.sessions,
          [cwd]: session,
        },
        cursors: {
          ...state.cursors,
          [cwd]: initialCursor,
        },
      };
    }

    case 'SESSION_TERMINATED': {
      const { cwd } = action.payload;
      const updatedSessions = { ...state.sessions };
      delete updatedSessions[cwd];
      const updatedCursors = { ...state.cursors };
      delete updatedCursors[cwd];

      return {
        ...state,
        isOpen: false,
        status: 'idle',
        sessions: updatedSessions,
        cursors: updatedCursors,
      };
    }

    case 'SWITCH_PROJECT': {
      const { cwd } = action.payload;
      return {
        ...state,
        activeCwd: cwd,
        status: state.sessions[cwd] ? 'connected' : 'idle',
      };
    }

    case 'SET_STATUS':
      return {
        ...state,
        status: action.payload.status,
        errorMessage: action.payload.error ?? null,
      };

    case 'PROCESS_EXITED':
      return {
        ...state,
        status: 'exited',
        exitCode: action.payload.exitCode,
      };

    default:
      return state;
  }
}
