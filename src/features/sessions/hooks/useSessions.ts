import { useCallback, useEffect, useRef } from 'react';
import {
  deleteSessionPi,
  getSessionStatsPi,
  listSessionsPi,
  newSessionPi,
  renameSessionPi,
  switchSessionPi,
} from '@infra/bridge';
import { parseTodo, todoFromHistory } from '@core/todo';
import { hydrateChatMessages, recordSessionSwitched, saveSessionRecord } from '@core/session';
import type { ChatAction } from '@core/reducer';
import type { ConnectConfig, ConnectionState } from '@core/types/connection';
import type { SessionSummary } from '@core/types/sessions';
import type { TranslationKey } from '@shared/i18n';
import {
  canStartNewConversation,
  decideDeleteOutcome,
  decideNewConversationOutcome,
  decideSelectSession,
  fetchSwitchedSessionStats,
  shouldReloadSessionsOnIdle,
} from '@features/sessions/session-actions';

export interface UseSessionsOptions {
  activeProjectId?: string | null;
  connectionStatus: ConnectionState;
  config: ConnectConfig;
  isBusy: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isResetting: boolean;
  isSwitchingSession: boolean;
  sessionId: string | null;
  sessionFile: string | null;
  /** Settings-panel state (settings cluster); read and written here as a cross-feature need. */
  showSettings: boolean;
  setShowSettings: (value: boolean) => void;
  dispatch: (action: ChatAction & { targetProjectId?: string }) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  /** Workspace cluster callback; this hook never imports the workspace feature. */
  requestFileTreeRefresh: () => void;
  restoreExtensionPrompts?: (requests: import('@core/types/events').ExtensionUiRequest[]) => void;
  /** Chat cluster callbacks (T5a's useChatScroll primitives); injected, not imported. */
  pinAndHide: () => void;
  scrollToBottomNextFrame: () => void;
  /** Connection cluster primitive, used only by handleNewConversation's offline branch. */
  startConnection: (
    config: ConnectConfig,
    options?: { force?: boolean; freshSession?: boolean }
  ) => Promise<void>;
}

export interface UseSessionsResult {
  loadSessions: (cwd?: string) => Promise<void>;
  handleSelectSession: (session: SessionSummary) => Promise<void>;
  handleDeleteSession: (session: SessionSummary) => Promise<void>;
  handleRenameSession: (sessionPath: string, name: string) => Promise<void>;
  handleNewConversation: () => Promise<void>;
  handleLoadOlderMessages: () => Promise<void>;
}

/**
 * Owns the sessions-list cluster: loading the list, the two effects that trigger a
 * reload (on connect, and on the busy -> idle transition), and the three session
 * handlers. Real decision logic (the active-session early return, the busy/switching
 * guards, and what happens when a delete or a reset targets the active session) lives in
 * the pure, tested functions in session-actions.ts; this hook is thin glue between those,
 * the bridge calls, and cross-feature callbacks injected by App.tsx.
 */
export function useSessions({
  activeProjectId,
  config,
  isBusy,
  isConnected,
  isConnecting,
  isResetting,
  isSwitchingSession,
  sessionId,
  sessionFile,
  showSettings,
  setShowSettings,
  dispatch,
  t,
  requestFileTreeRefresh,
  restoreExtensionPrompts,
  pinAndHide,
  scrollToBottomNextFrame,
  startConnection,
}: UseSessionsOptions): UseSessionsResult {
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const configWorkingDirRef = useRef(config.workingDirectory);
  configWorkingDirRef.current = config.workingDirectory;

  const loadSessions = useCallback(
    async (cwd?: string, projectId?: string | null) => {
      const targetCwd = cwd || configWorkingDirRef.current;
      const targetPid = projectId === undefined ? activeProjectIdRef.current ?? undefined : projectId ?? undefined;
      try {
        dispatch({ type: 'LOAD_SESSIONS_START', targetProjectId: targetPid });
        const list = await listSessionsPi(targetCwd);
        dispatch({
          type: 'LOAD_SESSIONS_SUCCESS',
          targetProjectId: targetPid,
          payload: { sessions: list },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({
          type: 'LOAD_SESSIONS_ERROR',
          targetProjectId: targetPid,
          payload: { error: msg },
        });
      }
    },
    [dispatch]
  );

  useEffect(() => {
    if (isConnected) {
      void loadSessions();
    }
  }, [isConnected, activeProjectId, config.workingDirectory, loadSessions]);

  // Refresh sessions when an assistant response completes (e.g. first turn in a new
  // session or updated message count).
  const prevBusyRef = useRef(isBusy);
  useEffect(() => {
    if (shouldReloadSessionsOnIdle(prevBusyRef.current, isBusy, isConnected)) {
      void loadSessions();
    }
    prevBusyRef.current = isBusy;
  }, [isBusy, isConnected, loadSessions]);

  const handleSelectSession = async (session: SessionSummary) => {
    const decision = decideSelectSession(
      session,
      { isSwitchingSession, sessionId, sessionFile },
      isBusy,
      showSettings
    );

    if (decision.action === 'blocked') {
      return;
    }

    if (decision.action === 'already-current') {
      dispatch({
        type: 'UPDATE_SESSION_STATUS',
        payload: { sessionId: session.id, sessionPath: session.path, status: undefined },
      });
      if (decision.closeSettings) {
        setShowSettings(false);
      }
      return;
    }

    setShowSettings(false);
    const targetProjectId = activeProjectIdRef.current ?? undefined;

    try {
      pinAndHide();
      dispatch({ type: 'SWITCH_SESSION_START', targetProjectId, payload: { sessionPath: session.path } });
      const result = await switchSessionPi(session.path);

      if (result.cancelled) {
        dispatch({ type: 'SWITCH_SESSION_CANCELLED', targetProjectId });
        return;
      }

      if (result.error || !result.sessionId || !result.sessionFile) {
        dispatch({
          type: 'SWITCH_SESSION_ERROR',
          targetProjectId,
          payload: { error: result.error || 'Unknown error switching session' },
        });
        return;
      }

      const hydrated = hydrateChatMessages(result.messages || []);
      pinAndHide();
      dispatch({
        type: 'SWITCH_SESSION_SUCCESS',
        targetProjectId,
        payload: {
          sessionId: result.sessionId,
          sessionFile: result.sessionFile,
          messages: hydrated,
          todo: parseTodo((result as typeof result & { todo?: unknown }).todo) ?? todoFromHistory(result.messages || []),
          hasMore: result.hasMore,
        },
      });

      if (result.activity !== undefined || result.activeJobs !== undefined) {
        dispatch({
          type: 'SESSION_READY', targetProjectId,
          payload: { sessionId: result.sessionId, sessionFile: result.sessionFile, messages: hydrated, activity: result.activity, activeJobs: result.activeJobs, hasMore: result.hasMore, todo: parseTodo((result as typeof result & { todo?: unknown }).todo) ?? todoFromHistory(result.messages || []) },
        });
        restoreExtensionPrompts?.(result.pendingExtensionPrompts ?? []);
      }

      // Synchronize persistence record
      recordSessionSwitched(
        config.workingDirectory,
        result.sessionId,
        result.sessionFile,
        hydrated.length > 0
      );

      // Refresh session list
      void loadSessions();
      requestFileTreeRefresh();

      scrollToBottomNextFrame();

      // SWITCH_SESSION_SUCCESS clears sessionStats; re-fetch them for the switched session.
      const stats = await fetchSwitchedSessionStats(() => getSessionStatsPi({ workingDirectory: config.workingDirectory, sessionId: result.sessionId, sessionFile: result.sessionFile }), result.sessionId);
      if (stats) {
        dispatch({ type: 'SET_SESSION_STATS', targetProjectId, payload: { stats, expectedSessionId: result.sessionId } });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'SWITCH_SESSION_ERROR',
        targetProjectId,
        payload: { error: msg },
      });
    }
  };

  const handleDeleteSession = async (session: SessionSummary) => {
    if (isBusy || isSwitchingSession) return;

    try {
      const res = await deleteSessionPi(session.path);
      const outcome = decideDeleteOutcome(res);

      if (outcome.kind === 'failed') {
        dispatch({
          type: 'LOAD_SESSIONS_ERROR',
          payload: { error: t('sidebar.delete_failed') },
        });
        return;
      }

      if (outcome.kind === 'active-replaced') {
        if (outcome.shouldSaveRecord && outcome.sessionId && outcome.sessionFile) {
          saveSessionRecord({
            sessionId: outcome.sessionId,
            sessionFile: outcome.sessionFile,
            cwd: config.workingDirectory,
            hasMessages: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        dispatch({
          type: 'NEW_CONVERSATION_SUCCESS',
          payload: {
            sessionId: outcome.sessionId,
            sessionFile: outcome.sessionFile,
          },
        });
      }

      void loadSessions();
      requestFileTreeRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'LOAD_SESSIONS_ERROR',
        payload: { error: `${t('sidebar.delete_failed')}: ${msg}` },
      });
    }
  };

  const handleRenameSession = async (sessionPath: string, name: string) => {
    if (isBusy || isSwitchingSession) return;

    try {
      await renameSessionPi(sessionPath, name);
      void loadSessions();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'LOAD_SESSIONS_ERROR',
        payload: { error: `${t('sidebar.rename_failed')}: ${msg}` },
      });
    }
  };

  // Reset conversation context atomically in Pi RPC and UI.
  const handleNewConversation = async () => {
    if (!canStartNewConversation(isBusy, isConnecting, isResetting)) return;
    if (showSettings) setShowSettings(false);
    pinAndHide();

    if (isConnected) {
      const originProjectId = activeProjectIdRef.current ?? undefined;
      const originCwd = configWorkingDirRef.current;
      dispatch({ type: 'NEW_CONVERSATION_START', targetProjectId: originProjectId });
      try {
        const res = await newSessionPi(originCwd);
        const outcome = decideNewConversationOutcome(res);

        if (outcome.kind === 'cancelled') {
          dispatch({ type: 'NEW_CONVERSATION_CANCELLED', targetProjectId: originProjectId });
        } else if (outcome.kind === 'partial-reset') {
          // Fail closed: Pi session was reset but state reconciliation failed
          dispatch({
            type: 'NEW_CONVERSATION_FAIL',
            targetProjectId: originProjectId,
            payload: { error: outcome.error },
          });
        } else {
          if (outcome.shouldSaveRecord && outcome.sessionId && outcome.sessionFile) {
            saveSessionRecord({
              sessionId: outcome.sessionId,
              sessionFile: outcome.sessionFile,
              cwd: originCwd,
              hasMessages: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          dispatch({
            type: 'NEW_CONVERSATION_SUCCESS',
            targetProjectId: originProjectId,
            payload: { sessionId: outcome.sessionId, sessionFile: outcome.sessionFile },
          });
          void loadSessions(originCwd, originProjectId ?? null);
          if (activeProjectIdRef.current === originProjectId && configWorkingDirRef.current === originCwd) {
            requestFileTreeRefresh();
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail closed: initial RPC failed or timed out; mutation status is uncertain
        dispatch({
          type: 'NEW_CONVERSATION_FAIL',
          targetProjectId: originProjectId,
          payload: { error: msg },
        });
      }
    } else {
      // Offline / missing file recovery: explicitly start fresh without overwriting reference before success
      dispatch({ type: 'NEW_CONVERSATION_START' });
      dispatch({ type: 'CLEAR_ERROR' });
      void startConnection(config, {
        freshSession: true,
        force: true,
      });
    }
  };

  // Load all earlier messages when the session was windowed
  const handleLoadOlderMessages = async () => {
    if (!sessionFile) return;
    dispatch({ type: 'LOAD_OLDER_MESSAGES_START' });
    try {
      const result = await switchSessionPi(sessionFile, { loadAll: true });
      if (result.error) {
        dispatch({
          type: 'LOAD_OLDER_MESSAGES_ERROR',
          payload: { error: result.error },
        });
        return;
      }
      const hydrated = hydrateChatMessages(result.messages || []);
      dispatch({
        type: 'LOAD_OLDER_MESSAGES_SUCCESS',
        payload: {
          messages: hydrated,
          hasMore: false,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'LOAD_OLDER_MESSAGES_ERROR',
        payload: { error: msg },
      });
    }
  };

  return {
    loadSessions,
    handleSelectSession,
    handleDeleteSession,
    handleRenameSession,
    handleNewConversation,
    handleLoadOlderMessages,
  };
}
