import { getModelStatsKey } from '../prompt-controls-utils';
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
  | { type: 'DISCONNECT'; payload?: { detail?: string } }
  | {
      type: 'SESSION_READY';
      payload: {
        sessionId?: string | null;
        sessionFile?: string | null;
        messages: ChatMessage[];
        model?: ModelInfo | null;
        hasMore?: boolean;
        detail?: string;
      };
    }
  | { type: 'PROCESS_EXIT'; payload: { error?: string } }
  | { type: 'CLEAR_ERROR' };

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
          : key !== prevKey
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
        statusLabel: 'Connection Failed',
        statusDetail: action.payload.error,
        lastError: action.payload.error,
        agentActivity: 'idle',
        activeAssistantMessageId: null,
        pendingPromptId: null,
        isHydrated: false,
        isResetting: false,
        messages: finalizeStreamingMessages(state.messages),
      };
    }

    case 'DISCONNECT': {
      return {
        ...state,
        connectionStatus: 'disconnected',
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
        messages: finalizeStreamingMessages(state.messages),
      };
    }

    case 'SESSION_READY': {
      return {
        ...state,
        connectionStatus: 'connected',
        isHydrated: true,
        isResetting: false,
        agentActivity: 'idle',
        sessionId: action.payload.sessionId ?? state.sessionId,
        sessionFile: action.payload.sessionFile ?? state.sessionFile,
        messages: action.payload.messages,
        hasMoreMessages: action.payload.hasMore ?? false,
        isLoadingOlderMessages: false,
        modelInfo: action.payload.model ?? state.modelInfo,
        statusLabel: 'Connected',
        statusDetail: action.payload.detail || 'Conversation ready',
        lastError: null,
      };
    }

    case 'PROCESS_EXIT': {
      return {
        ...state,
        connectionStatus: action.payload?.error ? 'error' : 'disconnected',
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
        messages: finalizeStreamingMessages(state.messages),
      };
    }

    case 'CLEAR_ERROR': {
      return {
        ...state,
        lastError: null,
      };
    }

    default:
      return undefined;
  }
}
