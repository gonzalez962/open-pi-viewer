import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Terminal as XTermInstance } from '@xterm/xterm';
import {
  terminalOpen,
  terminalWrite,
  terminalResize,
  terminalClose,
  createTerminalPoller,
  type TerminalPoller,
} from '@infra/terminal';
import type { TerminalSessionDto } from '@core/terminal';
import {
  terminalReducer,
  createInitialTerminalState,
} from '../terminal-state';

export interface UseTerminalOptions {
  activeProjectCwd: string | null;
  activeProjectName: string;
}

export function useTerminal({ activeProjectCwd, activeProjectName }: UseTerminalOptions) {
  const [state, dispatch] = useReducer(terminalReducer, createInitialTerminalState());
  const [isTerminateConfirmOpen, setIsTerminateConfirmOpen] = useState(false);

  const activePollerRef = useRef<TerminalPoller | null>(null);
  const terminalInstanceRef = useRef<XTermInstance | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  const currentSession: TerminalSessionDto | null =
    activeProjectCwd && state.sessions[activeProjectCwd]
      ? state.sessions[activeProjectCwd]
      : null;

  activeSessionIdRef.current = currentSession?.id ?? null;

  // Cleanup polling loop on unmount or session transition (NEVER issues terminal_close)
  const stopCurrentPoller = useCallback(() => {
    if (activePollerRef.current) {
      activePollerRef.current.stop();
      activePollerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (session: TerminalSessionDto) => {
      stopCurrentPoller();

      const initialCursor =
        session.cursor ?? (session.replay ? session.replay.length : 0);

      const poller = createTerminalPoller({
        id: session.id,
        initialCursor,
        timeoutMs: 15000,
        onData: (data) => {
          terminalInstanceRef.current?.write(data);
        },
        onExit: (exitCode) => {
          dispatch({ type: 'PROCESS_EXITED', payload: { exitCode } });
          terminalInstanceRef.current?.write(
            `\r\n\x1b[33m[Process completed with exit code ${exitCode}]\x1b[0m\r\n`
          );
        },
        onError: (err) => {
          dispatch({
            type: 'SET_STATUS',
            payload: { status: 'error', error: err.message },
          });
        },
      });

      activePollerRef.current = poller;
      poller.start();
    },
    [stopCurrentPoller]
  );

  // Open or attach to active project terminal
  const openTerminal = useCallback(async () => {
    if (!activeProjectCwd) return;

    dispatch({ type: 'OPEN', payload: { cwd: activeProjectCwd } });

    // Check if session already exists in memory
    const existing = state.sessions[activeProjectCwd];
    if (existing) {
      startPolling(existing);
      return;
    }

    try {
      dispatch({ type: 'SET_STATUS', payload: { status: 'connecting' } });
      const session = await terminalOpen({ cwd: activeProjectCwd });
      dispatch({
        type: 'SESSION_OPENED',
        payload: { cwd: activeProjectCwd, session },
      });
      startPolling(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'SET_STATUS',
        payload: { status: 'error', error: message },
      });
    }
  }, [activeProjectCwd, state.sessions, startPolling]);

  // Minimize hides terminal overlay but preserves backend session and process
  const minimizeTerminal = useCallback(() => {
    stopCurrentPoller();
    dispatch({ type: 'MINIMIZE' });
  }, [stopCurrentPoller]);

  // Request termination confirmation
  const requestTerminate = useCallback(() => {
    setIsTerminateConfirmOpen(true);
  }, []);

  const cancelTerminate = useCallback(() => {
    setIsTerminateConfirmOpen(false);
  }, []);

  // Explicit confirmed termination kills backend process and cleans session
  const confirmTerminate = useCallback(async () => {
    setIsTerminateConfirmOpen(false);
    stopCurrentPoller();

    if (activeProjectCwd && currentSession) {
      try {
        await terminalClose({ id: currentSession.id });
      } catch (err) {
        console.warn('[Terminal] Failed to close session on backend:', err);
      }
      dispatch({ type: 'SESSION_TERMINATED', payload: { cwd: activeProjectCwd } });
    }
  }, [activeProjectCwd, currentSession, stopCurrentPoller]);

  // Terminal input & resize handlers
  const handleInput = useCallback((data: string) => {
    const id = activeSessionIdRef.current;
    if (id) {
      void terminalWrite({ id, data }).catch((err) => {
        console.warn('[Terminal] Write error:', err);
      });
    }
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    const id = activeSessionIdRef.current;
    if (id) {
      void terminalResize({ id, cols, rows }).catch((err) => {
        console.warn('[Terminal] Resize error:', err);
      });
    }
  }, []);

  // Project switch effect: preserve background sessions, cancel polling if minimized
  useEffect(() => {
    if (!activeProjectCwd) return;

    dispatch({ type: 'SWITCH_PROJECT', payload: { cwd: activeProjectCwd } });

    if (state.isOpen) {
      // Re-open in the newly selected project
      void openTerminal();
    } else {
      stopCurrentPoller();
    }
  }, [activeProjectCwd]);

  // Cleanup on unmount (cancels poller, NEVER closes backend terminal)
  useEffect(() => {
    return () => {
      stopCurrentPoller();
    };
  }, [stopCurrentPoller]);

  return {
    isOpen: state.isOpen,
    status: state.status,
    errorMessage: state.errorMessage,
    exitCode: state.exitCode,
    currentSession,
    isTerminateConfirmOpen,
    activeProjectCwd,
    activeProjectName,
    terminalInstanceRef,
    openTerminal,
    minimizeTerminal,
    requestTerminate,
    cancelTerminate,
    confirmTerminate,
    retryConnection: openTerminal,
    handleInput,
    handleResize,
  };
}
