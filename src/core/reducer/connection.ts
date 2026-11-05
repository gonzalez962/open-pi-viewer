import type { TodoSnapshot } from '../types/todo';
import { applyJobChange, type JobChange } from '../job-activity';
import { getModelStatsKey } from '../prompt-controls-utils';
import type { SubagentTask } from '../types/agent-activity';
import type { ChatMessage } from '../types/messages';
import type { ChatSessionState } from '../types/chat-state';
import type { ModelInfo } from '../types/models';
import type { ChatAction } from './index';

export type ConnectionAction =
  | { type: 'CONNECT_START'; payload?: { detail?: string } }
  | {
      type: 'CONNECT_SUCCESS';
      payload: { model?: ModelInfo | null; detail?: string };
    }
  | { type: 'CONNECT_FAIL'; payload: { error: string } }
  | { type: 'DISCONNECT'; payload?: { detail?: string; sessionId?: string } }
  | {
      type: 'SESSION_READY';
      payload: {
        sessionId?: string | null;
        sessionFile?: string | null;
        messages: ChatMessage[];
        activity?: 'idle' | 'busy' | 'waiting';
        model?: ModelInfo | null;
        hasMore?: boolean;
        detail?: string;
        todo?: TodoSnapshot | null;
        activeJobs?: string[];
      };
    }
  | { type: 'SESSION_FILE_EXIT'; payload: { sessionFile: string; error?: string; detail?: string } }
  | { type: 'JOB_SNAPSHOT'; payload: { sessionId: string; jobs: string[] } }
  | { type: 'JOB_CHANGE'; payload: { sessionId: string; change: JobChange } }
  | { type: 'CLEAR_SESSION_JOBS'; payload: { sessionId: string } }
  | { type: 'UPDATE_TODO'; payload: { todo: TodoSnapshot } }
  | { type: 'PROCESS_EXIT'; payload: { error?: string; sessionId?: string } }
  | { type: 'CLEAR_ERROR' }
  | { type: 'UPDATE_SUBAGENT_ACTIVITY'; payload: { tasks: SubagentTask[] } };

/**
 * Finalize any in-flight streaming messages by clearing their isStreaming flag.
 */
function finalizeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const updated = messages.map((m) => {
    const hasStreamingThinking = m.blocks?.some(
      (b) => b.type === 'thinking' && b.isStreaming
    );
    if (m.isStreaming || hasStreamingThinking) {
      changed = true;
      const updatedBlocks = m.blocks?.map((b) =>
        b.type === 'thinking' && b.isStreaming ? { ...b, isStreaming: false } : b
      );
      return { ...m, isStreaming: false, blocks: updatedBlocks };
    }
    return m;
  });
  return changed ? updated : messages;
}

/**
 * Connection lifecycle slice: connect/disconnect, session readiness, process exit, error clearing.
 */
export function connectionReducer(
  state: ChatSessionState,
  action: ChatAction
): ChatSessionState | undefined {
  switch (action.type) {
    case 'CONNECT_START': {
      return {
        ...state,
        connectionStatus: 'connecting',
        statusLabel: 'Connecting',
        statusDetail: action.payload?.detail || 'Spawning Pi RPC subprocess...',
        lastError: null,
        isHydrated: false,
      };
    }

    case 'CONNECT_SUCCESS': {
      const model = action.payload.model || null;
      const key = getModelStatsKey(model);
      const prevKey = getModelStatsKey(state.modelInfo);
      const sessionStats =
        key && state.modelStats[key]
          ? state.modelStats[key]
          : prevKey && key !== prevKey
            ? null
            : state.sessionStats;
      return {
        ...state,
        connectionStatus: 'connected',
        statusLabel: 'Connected',
        statusDetail:
          action.payload.detail ||
          'Pi RPC bridge connected (persisted chat mode, isolated runtime)',
        modelInfo: model,
        sessionStats,
        agentActivity: 'idle',
        lastError: null,
        // Notice: isHydrated remains false until SESSION_READY dispatches with
        // reconciled session messages, preventing prompt submission during race.
      };
    }

    case 'CONNECT_FAIL': {
      return {
        ...state,
        connectionStatus: 'error',
        jobsBySession: {},
        statusLabel: 'Connection Failed',
        statusDetail: action.payload.error,
        lastError: action.payload.error,
        agentActivity: 'idle',
        activeAssistantMessageId: null,
        pendingPromptId: null,
        isHydrated: false,
        isResetting: false,
        todo: null,
        messages: finalizeStreamingMessages(state.messages),
      };
    }

    case 'DISCONNECT': {
      return {
        ...state,
        connectionStatus: 'disconnected',
        jobsBySession: action.payload?.sessionId ? Object.fromEntries(Object.entries(state.jobsBySession ?? {}).filter(([id]) => id !== action.payload?.sessionId)) : {},
        statusLabel: 'Disconnected',
        statusDetail:
          action.payload?.detail || 'Pi RPC process offline — disconnected',
        agentActivity: 'idle',
        activeAssistantMessageId: null,
        pendingPromptId: null,
        isHydrated: false,
        isResetting: false,
        pendingApprovals: [],
        availableModels: [],
        sessionStats: null,
        modelStats: {},
        subagents: [],
        todo: null,
        messages: finalizeStreamingMessages(state.messages),
      };
    }

    case 'SESSION_READY': {
      const isNewSession = Boolean(
        action.payload.sessionId && state.sessionId && action.payload.sessionId !== state.sessionId
      );
      return {
        ...state,
        connectionStatus: 'connected',
        jobsBySession: action.payload.activeJobs && action.payload.sessionId
          ? { ...state.jobsBySession, [action.payload.sessionId]: action.payload.activeJobs.filter(id => typeof id === 'string' && Boolean(id.trim())) }
          : state.jobsBySession,
        isHydrated: true,
        isResetting: false,
        agentActivity: action.payload.activity === 'busy' || action.payload.activity === 'waiting' ? 'busy' : 'idle',
        sessionId: action.payload.sessionId ?? state.sessionId,
        sessionFile: action.payload.sessionFile ?? state.sessionFile,
        messages: action.payload.messages,
        hasMoreMessages: action.payload.hasMore ?? false,
        isLoadingOlderMessages: false,
        modelInfo: action.payload.model ?? state.modelInfo,
        statusLabel: 'Connected',
        statusDetail: action.payload.detail || 'Conversation ready',
        lastError: null,
        subagents: isNewSession ? [] : (state.subagents ?? []),
        todo: action.payload.todo ?? null,
      };
    }

    case 'PROCESS_EXIT': {
      return {
        ...state,
        connectionStatus: action.payload?.error ? 'error' : 'disconnected',
        jobsBySession: action.payload?.sessionId ? Object.fromEntries(Object.entries(state.jobsBySession ?? {}).filter(([id]) => id !== action.payload.sessionId)) : {},
        agentActivity: 'idle',
        statusLabel: action.payload?.error ? 'Process Error' : 'Disconnected',
        statusDetail:
          action.payload?.error || 'Pi RPC process exited or terminated',
        lastError: action.payload?.error || null,
        activeAssistantMessageId: null,
        pendingPromptId: null,
        isHydrated: false,
        isResetting: false,
        pendingApprovals: [],
        availableModels: [],
        sessionStats: null,
        subagents: [],
        todo: null,
        messages: finalizeStreamingMessages(state.messages),
      };
    }

    case 'SESSION_FILE_EXIT': {
      const { sessionFile, error, detail } = action.payload;
      const selected = state.sessionFile === sessionFile;
      const sessionId = selected ? state.sessionId : state.sessions.find(session => session.path === sessionFile)?.id;
      if (!sessionId) return state;
      if (selected) return connectionReducer(state, error
        ? { type: 'PROCESS_EXIT', payload: { error, sessionId } }
        : { type: 'DISCONNECT', payload: { detail, sessionId } });
      return connectionReducer(state, { type: 'CLEAR_SESSION_JOBS', payload: { sessionId } });
    }

    case 'JOB_SNAPSHOT': {
      return { ...state, jobsBySession: { ...state.jobsBySession, [action.payload.sessionId]: action.payload.jobs.filter(id => typeof id === 'string' && Boolean(id.trim())) } };
    }

    case 'JOB_CHANGE': {
      const { sessionId, change } = action.payload;
      return { ...state, jobsBySession: { ...state.jobsBySession, [sessionId]: applyJobChange(state.jobsBySession?.[sessionId] ?? [], change) } };
    }

    case 'CLEAR_SESSION_JOBS': {
      const jobsBySession = { ...state.jobsBySession };
      delete jobsBySession[action.payload.sessionId];
      return { ...state, jobsBySession };
    }

    case 'CLEAR_ERROR': {
      return {
        ...state,
        lastError: null,
      };
    }

    case 'UPDATE_TODO': {
      return state.connectionStatus === 'connected' ? { ...state, todo: action.payload.todo } : state;
    }

    case 'UPDATE_SUBAGENT_ACTIVITY': {
      return {
        ...state,
        subagents: action.payload.tasks,
      };
    }

    default:
      return undefined;
  }
}
