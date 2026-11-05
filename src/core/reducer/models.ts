import { getModelStatsKey } from '../prompt-controls-utils';
import type { ChatSessionState } from '../types/chat-state';
import type { ModelInfo, ThinkingLevel, SessionStats } from '../types/models';
import type { ChatAction } from './index';

export type ModelsAction =
  | { type: 'SET_AVAILABLE_MODELS'; payload: { models: ModelInfo[] } }
  | { type: 'MODEL_CHANGE_START' }
  | {
      type: 'MODEL_CHANGE_SUCCESS';
      payload: {
        model: ModelInfo;
        thinkingLevel?: ThinkingLevel | null;
        availableThinkingLevels?: ThinkingLevel[];
      };
    }
  | { type: 'MODEL_CHANGE_FAIL'; payload: { error: string } }
  | { type: 'SET_THINKING_LEVEL'; payload: { level: ThinkingLevel } }
  | { type: 'SET_AVAILABLE_THINKING_LEVELS'; payload: { levels: ThinkingLevel[] } }
  | { type: 'SET_SESSION_STATS'; payload: { stats: SessionStats | null; expectedSessionId?: string } };

/**
 * Model slice: available models, model switching, thinking levels, session stats.
 */
export function modelsReducer(
  state: ChatSessionState,
  action: ChatAction
): ChatSessionState | undefined {
  switch (action.type) {
    case 'SET_AVAILABLE_MODELS': {
      return {
        ...state,
        availableModels: action.payload.models,
        isModelsLoading: false,
      };
    }

    case 'MODEL_CHANGE_START': {
      return {
        ...state,
        isChangingModel: true,
        lastError: null,
      };
    }

    case 'MODEL_CHANGE_SUCCESS': {
      const key = getModelStatsKey(action.payload.model);
      return {
        ...state,
        isChangingModel: false,
        modelInfo: action.payload.model,
        sessionStats: key && state.modelStats[key] ? state.modelStats[key] : !getModelStatsKey(state.modelInfo) ? state.sessionStats : null,
        thinkingLevel:
          action.payload.thinkingLevel !== undefined
            ? action.payload.thinkingLevel
            : state.thinkingLevel,
        availableThinkingLevels:
          action.payload.availableThinkingLevels ?? state.availableThinkingLevels,
        lastError: null,
      };
    }

    case 'MODEL_CHANGE_FAIL': {
      return {
        ...state,
        isChangingModel: false,
        lastError: action.payload.error,
      };
    }

    case 'SET_THINKING_LEVEL': {
      return {
        ...state,
        thinkingLevel: action.payload.level,
      };
    }

    case 'SET_AVAILABLE_THINKING_LEVELS': {
      return {
        ...state,
        availableThinkingLevels: action.payload.levels,
      };
    }

    case 'SET_SESSION_STATS': {
      if (action.payload.expectedSessionId && action.payload.expectedSessionId !== state.sessionId) return state;
      const stats = action.payload.stats;
      const key = state.modelInfo ? getModelStatsKey(state.modelInfo) : '';
      return {
        ...state,
        sessionStats: stats,
        modelStats:
          key && stats
            ? { ...state.modelStats, [key]: stats }
            : state.modelStats,
      };
    }

    default:
      return undefined;
  }
}
