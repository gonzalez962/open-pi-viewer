import type { ChatMessage } from '../types/messages';
import type { ChatSessionState } from '../types/chat-state';
import type { SessionSummary, SessionRuntimeStatus } from '../types/sessions';
import type { ChatAction } from './index';

export type SessionsAction =
  | { type: 'NEW_CONVERSATION_START' }
  | {
      type: 'NEW_CONVERSATION_SUCCESS' | 'NEW_SESSION_SUCCESS';
      payload?: { sessionId?: string | null; sessionFile?: string | null };
    }
  | { type: 'NEW_CONVERSATION_CANCELLED' }
  | { type: 'NEW_CONVERSATION_FAIL'; payload: { error: string } }
  | { type: 'LOAD_SESSIONS_START' }
  | {
      type: 'LOAD_SESSIONS_SUCCESS';
      payload: { sessions: SessionSummary[] };
    }
  | { type: 'LOAD_SESSIONS_ERROR'; payload: { error: string } }
  | { type: 'SWITCH_SESSION_START'; payload: { sessionPath: string } }
  | {
      type: 'SWITCH_SESSION_SUCCESS';
      payload: {
        sessionId: string;
        sessionFile: string;
        messages: ChatMessage[];
        hasMore?: boolean;
      };
    }
  | { type: 'SWITCH_SESSION_CANCELLED' }
  | { type: 'SWITCH_SESSION_ERROR'; payload: { error: string } }
  | { type: 'LOAD_OLDER_MESSAGES_START' }
  | {
      type: 'LOAD_OLDER_MESSAGES_SUCCESS';
      payload: {
        messages: ChatMessage[];
        hasMore?: boolean;
      };
    }
  | { type: 'LOAD_OLDER_MESSAGES_ERROR'; payload: { error: string } }
  | {
      type: 'UPDATE_SESSION_STATUS';
      payload: {
        sessionPath?: string;
        sessionId?: string;
        status: SessionRuntimeStatus;
      };
    }
  | { type: 'TOGGLE_SIDEBAR'; payload?: { isOpen?: boolean } };

/**
 * Session lifecycle slice: new conversation, session list loading, session switching, sidebar toggle.
 */
export function sessionsReducer(
  state: ChatSessionState,
  action: ChatAction
): ChatSessionState | undefined {
  switch (action.type) {
    case 'NEW_CONVERSATION_START': {
      return {
        ...state,
        isResetting: true,
        statusDetail: 'Resetting conversation context...',
        lastError: null,
      };
    }

    case 'NEW_SESSION_SUCCESS':
    case 'NEW_CONVERSATION_SUCCESS': {
      const nextSessionId = action.payload?.sessionId ?? null;
      const nextSessionFile = action.payload?.sessionFile ?? null;
      return {
        ...state,
        isResetting: false,
        isHydrated: true,
        sessionId: nextSessionId,
        sessionFile: nextSessionFile,
        messages: [],
        hasMoreMessages: false,
        isLoadingOlderMessages: false,
        pendingApprovals: [],
        activeAssistantMessageId: null,
        pendingPromptId: null,
        lastError: null,
        sessionStats: null,
        modelStats: {},
        statusLabel: 'Connected',
        statusDetail: 'New conversation ready',
        sessions: state.sessions.map((s) => ({
          ...s,
          isActive: Boolean(
            nextSessionId && (s.id === nextSessionId || s.path === nextSessionFile)
          ),
        })),
      };
    }

    case 'NEW_CONVERSATION_CANCELLED': {
      // Confirmed cancellation before reset: preserve existing messages and context
      return {
        ...state,
        isResetting: false,
        statusDetail: 'New conversation was cancelled by agent extension',
      };
    }

    case 'NEW_CONVERSATION_FAIL': {
      // Fail closed: if reset failed or timed out, session state is uncertain or partially reset.
      // Invalidate hydration/readiness to block prompt submission until explicit reconnect/reconciliation.
      return {
        ...state,
        isResetting: false,
        isHydrated: false,
        connectionStatus: 'error',
        statusLabel: 'Reset Failed',
        statusDetail: `Session reset error (${action.payload.error}); reconnect to reconcile state`,
        lastError: action.payload.error,
      };
    }

    case 'LOAD_SESSIONS_START': {
      return {
        ...state,
        isSessionsLoading: true,
        sessionsError: null,
      };
    }

    case 'LOAD_SESSIONS_SUCCESS': {
      return {
        ...state,
        isSessionsLoading: false,
        sessions: action.payload.sessions,
        sessionsError: null,
      };
    }

    case 'LOAD_SESSIONS_ERROR': {
      return {
        ...state,
        isSessionsLoading: false,
        sessionsError: action.payload.error,
      };
    }

    case 'SWITCH_SESSION_START': {
      return {
        ...state,
        isSwitchingSession: true,
        statusDetail: 'Switching session...',
        lastError: null,
      };
    }

    case 'SWITCH_SESSION_SUCCESS': {
      const nextSessionId = action.payload.sessionId;
      const nextSessionFile = action.payload.sessionFile;
      return {
        ...state,
        isSwitchingSession: false,
        isHydrated: true,
        sessionId: nextSessionId,
        sessionFile: nextSessionFile,
        messages: action.payload.messages,
        hasMoreMessages: action.payload.hasMore ?? false,
        isLoadingOlderMessages: false,
        pendingApprovals: [],
        activeAssistantMessageId: null,
        pendingPromptId: null,
        lastError: null,
        sessionStats: null,
        modelStats: {},
        statusLabel: 'Connected',
        statusDetail: 'Session ready',
        sessions: state.sessions.map((s) => ({
          ...s,
          isActive: s.id === nextSessionId || s.path === nextSessionFile,
        })),
      };
    }

    case 'SWITCH_SESSION_CANCELLED': {
      return {
        ...state,
        isSwitchingSession: false,
        statusDetail: 'Session switch was cancelled by agent extension',
      };
    }

    case 'SWITCH_SESSION_ERROR': {
      return {
        ...state,
        isSwitchingSession: false,
        lastError: action.payload.error,
        statusDetail: `Session switch error: ${action.payload.error}`,
      };
    }

    case 'LOAD_OLDER_MESSAGES_START': {
      return {
        ...state,
        isLoadingOlderMessages: true,
      };
    }

    case 'LOAD_OLDER_MESSAGES_SUCCESS': {
      const existingIds = new Set(state.messages.map((m) => m.id));
      const older = action.payload.messages.filter((m) => !existingIds.has(m.id));
      return {
        ...state,
        isLoadingOlderMessages: false,
        messages: [...older, ...state.messages],
        hasMoreMessages: action.payload.hasMore ?? false,
      };
    }

    case 'LOAD_OLDER_MESSAGES_ERROR': {
      return {
        ...state,
        isLoadingOlderMessages: false,
        statusDetail: `Error loading older messages: ${action.payload.error}`,
      };
    }

    case 'UPDATE_SESSION_STATUS': {
      const { sessionPath, sessionId, status } = action.payload;
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if ((sessionPath && s.path === sessionPath) || (sessionId && s.id === sessionId)) {
            return { ...s, status };
          }
          return s;
        }),
      };
    }

    case 'TOGGLE_SIDEBAR': {
      const nextOpen =
        action.payload?.isOpen !== undefined
          ? action.payload.isOpen
          : !state.isSidebarOpen;
      return {
        ...state,
        isSidebarOpen: nextOpen,
      };
    }

    default:
      return undefined;
  }
}
