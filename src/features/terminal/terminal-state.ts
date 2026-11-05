import type { TerminalState, TerminalAction } from './types';
export type { TerminalState, TerminalAction };

export function createInitialTerminalState(): TerminalState {
  return { isOpen: false, activeCwd: null, sessions: {}, cursors: {}, selected: {}, status: 'idle', errorMessage: null, exitCode: null };
}

export function terminalReducer(state: TerminalState, action: TerminalAction): TerminalState {
  switch (action.type) {
    case 'OPEN':
      return { ...state, isOpen: true, activeCwd: action.payload.cwd, status: state.selected[action.payload.cwd] ? 'connected' : 'connecting', errorMessage: null };
    case 'MINIMIZE':
      return { ...state, isOpen: false };
    case 'SESSION_OPENED': {
      const { cwd, session } = action.payload;
      const current = state.activeCwd === cwd || state.activeCwd === null || state.status === 'connected';
      return {
        ...state,
        isOpen: state.activeCwd === null ? true : state.isOpen,
        activeCwd: current ? cwd : state.activeCwd,
        status: current ? (session.running ? 'connected' : 'exited') : state.status,
        errorMessage: current ? null : state.errorMessage,
        sessions: { ...state.sessions, [session.id]: session },
        selected: current ? { ...state.selected, [cwd]: session.id } : state.selected,
        cursors: { ...state.cursors, [session.id]: session.cursor ?? session.replay?.length ?? 0 },
      };
    }
    case 'SELECT_TAB':
      return { ...state, selected: { ...state.selected, [action.payload.cwd]: action.payload.id }, status: 'connecting', errorMessage: null };
    case 'SESSION_TERMINATED': {
      const { cwd } = action.payload;
      const id = action.payload.id ?? state.selected[cwd];
      const sessions = { ...state.sessions };
      for (const key of Object.keys(sessions)) if (sessions[key].id === id) delete sessions[key];
      const sibling = Object.values(sessions).find((session) => session.cwd === cwd);
      const selected = { ...state.selected };
      const wasSelected = selected[cwd] === id;
      if (wasSelected) {
        if (sibling) selected[cwd] = sibling.id; else delete selected[cwd];
      }
      const cursors = { ...state.cursors }; delete cursors[id];
      const affectsActive = state.activeCwd === cwd && wasSelected;
      return { ...state, sessions, selected, cursors, isOpen: affectsActive && !sibling ? false : state.isOpen, status: affectsActive ? (sibling ? 'connecting' : 'idle') : state.status };
    }
    case 'SWITCH_PROJECT':
      return { ...state, activeCwd: action.payload.cwd, status: state.selected[action.payload.cwd] ? 'connected' : 'idle' };
    case 'SET_STATUS':
      return { ...state, status: action.payload.status, errorMessage: action.payload.error ?? null };
    case 'PROCESS_EXITED':
      return { ...state, status: 'exited', exitCode: action.payload.exitCode };
    default: return state;
  }
}
