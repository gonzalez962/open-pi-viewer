import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Terminal as XTermInstance } from '@xterm/xterm';
import { terminalOpen, terminalGet, terminalList, terminalWrite, terminalResize, terminalClose, createTerminalPoller, type TerminalPoller } from '@infra/terminal';
import { terminalReducer, createInitialTerminalState } from '../terminal-state';

export interface UseTerminalOptions { activeProjectCwd: string | null; activeProjectName: string }

export function useTerminal({ activeProjectCwd, activeProjectName }: UseTerminalOptions) {
  const [state, dispatch] = useReducer(terminalReducer, createInitialTerminalState());
  const [terminateTarget, setTerminateTarget] = useState<{ cwd: string; id: string } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const terminalInstanceRef = useRef<XTermInstance | null>(null);
  const poller = useRef<TerminalPoller | null>(null);
  const generation = useRef(0);
  const closedIds = useRef(new Set<string>());
  const projectRef = useRef(activeProjectCwd);
  projectRef.current = activeProjectCwd;
  const selectedId = activeProjectCwd ? state.selected[activeProjectCwd] : undefined;
  const currentSession = Object.values(state.sessions).find((s) => s.id === selectedId) ?? null;
  const currentId = useRef<string | null>(null);
  currentId.current = currentSession?.id ?? null;
  const tabs = Object.values(state.sessions).filter((s) => s.cwd === activeProjectCwd);

  const stop = useCallback(() => { generation.current++; poller.current?.stop(); poller.current = null; }, []);
  const activate = useCallback(async (cwd: string, id: string) => {
    stop();
    const token = generation.current;
    dispatch({ type: 'SELECT_TAB', payload: { cwd, id } });
    try {
      const session = await terminalGet({ id });
      if (token !== generation.current || projectRef.current !== cwd || !session || closedIds.current.has(id)) return;
      dispatch({ type: 'SESSION_OPENED', payload: { cwd, session } });
      const stream = createTerminalPoller({ id, initialCursor: session.cursor ?? session.replay?.length ?? 0,
        onData: (data) => { if (generation.current === token) terminalInstanceRef.current?.write(data); },
        onExit: (exitCode) => { if (generation.current === token) dispatch({ type: 'PROCESS_EXITED', payload: { exitCode } }); },
        onError: (error) => { if (generation.current === token) dispatch({ type: 'SET_STATUS', payload: { status: 'error', error: error.message } }); },
      });
      poller.current = stream;
      stream.start();
    } catch (err) {
      if (token === generation.current) dispatch({ type: 'SET_STATUS', payload: { status: 'error', error: String(err) } });
    }
  }, [stop]);

  const openTerminal = useCallback(async () => {
    const cwd = activeProjectCwd;
    if (!cwd) return;
    stop();
    const token = generation.current;
    dispatch({ type: 'OPEN', payload: { cwd } });
    try {
      const existing = state.selected[cwd];
      if (existing) { await activate(cwd, existing); return; }
      const session = await terminalOpen({ cwd });
      const listed = await terminalList();
      if (token !== generation.current || projectRef.current !== cwd) return;
      for (const item of listed.filter((s) => s.canonicalCwd === session.canonicalCwd && s.id !== session.id && !closedIds.current.has(s.id))) {
        dispatch({ type: 'SESSION_OPENED', payload: { cwd, session: item } });
      }
      await activate(cwd, session.id);
    } catch (err) {
      if (token === generation.current) dispatch({ type: 'SET_STATUS', payload: { status: 'error', error: String(err) } });
    }
  }, [activeProjectCwd, state.selected, stop, activate]);

  const createTab = useCallback(async () => {
    const cwd = activeProjectCwd;
    if (!cwd) return;
    stop();
    const token = generation.current;
    try {
      const session = await terminalOpen({ cwd, createNew: true });
      if (token !== generation.current || projectRef.current !== cwd) return;
      await activate(cwd, session.id);
    } catch (err) {
      if (token === generation.current) dispatch({ type: 'SET_STATUS', payload: { status: 'error', error: String(err) } });
    }
  }, [activeProjectCwd, stop, activate]);
  const selectTab = useCallback((id: string) => { if (activeProjectCwd) void activate(activeProjectCwd, id); }, [activeProjectCwd, activate]);
  const minimizeTerminal = useCallback(() => { stop(); dispatch({ type: 'MINIMIZE' }); }, [stop]);
  const confirmTerminate = useCallback(async () => {
    setTerminateTarget(null);
    if (!terminateTarget) return;
    const { cwd, id } = terminateTarget;
    try { await terminalClose({ id }); } catch (err) { console.warn('[Terminal] Failed to close session:', err); return; }
    closedIds.current.add(id);
    const current = stateRef.current;
    const isActive = projectRef.current === cwd && current.selected[cwd] === id && current.isOpen;
    const sibling = Object.values(current.sessions).find((s) => s.cwd === cwd && s.id !== id);
    dispatch({ type: 'SESSION_TERMINATED', payload: { cwd, id } });
    if (isActive) {
      if (sibling) await activate(cwd, sibling.id); else stop();
    }
  }, [terminateTarget, stop, activate]);
  const handleInput = useCallback((data: string) => { if (currentId.current) void terminalWrite({ id: currentId.current, data }); }, []);
  const handleResize = useCallback((cols: number, rows: number) => { if (currentId.current) void terminalResize({ id: currentId.current, cols, rows }); }, []);
  useEffect(() => {
    stop();
    if (!activeProjectCwd) return;
    dispatch({ type: 'SWITCH_PROJECT', payload: { cwd: activeProjectCwd } });
    if (state.isOpen) void openTerminal();
  }, [activeProjectCwd]);
  useEffect(() => () => stop(), [stop]);
  return { isOpen: state.isOpen, status: state.status, errorMessage: state.errorMessage, exitCode: state.exitCode,
    currentSession, tabs, createTab, selectTab, isTerminateConfirmOpen: terminateTarget !== null, activeProjectCwd, activeProjectName,
    terminalInstanceRef, openTerminal, minimizeTerminal, requestTerminate: (id?: string) => {
      const targetId = id ?? currentSession?.id;
      if (activeProjectCwd && targetId) setTerminateTarget({ cwd: activeProjectCwd, id: targetId });
    },
    cancelTerminate: () => setTerminateTarget(null), confirmTerminate, retryConnection: openTerminal, handleInput, handleResize };
}
