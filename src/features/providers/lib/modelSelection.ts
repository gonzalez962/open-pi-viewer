import type { ModelInfo, ModelThinkingLevelsMap, ThinkingLevel } from '@core/types/models';
import type { ChatAction } from '@core/reducer';
import {
  getModelThinkingLevelsPi,
  setModelPi,
  getAvailableThinkingLevelsPi,
  setThinkingLevelPi,
} from '@infra/bridge';
import { resolveModelSelectionOutcome } from '../providers';

export interface ExecuteModelSelectionParams {
  provider: string;
  modelId: string;
  targetProjectId?: string;
  availableModels: ModelInfo[];
  modelThinkingLevels?: ModelThinkingLevelsMap;
  dispatch: React.Dispatch<ChatAction & { targetProjectId?: string }>;
  setModelFn?: (provider: string, modelId: string) => Promise<ModelInfo>;
  getAvailableThinkingLevelsFn?: () => Promise<ThinkingLevel[]>;
  getModelThinkingLevelsFn?: () => Promise<ModelThinkingLevelsMap>;
  setThinkingLevelFn?: (level: ThinkingLevel) => Promise<void>;
  onThinkingLevelsFetched?: (levels: ModelThinkingLevelsMap) => void;
}

/**
 * Production selection helper: executes the model change RPC sequence,
 * coordinates thinking levels, routes dispatches scoped to targetProjectId,
 * and notifies callers on failure rather than latching false success.
 */
export async function executeModelSelection(
  params: ExecuteModelSelectionParams
): Promise<ModelInfo> {
  const {
    provider,
    modelId,
    targetProjectId,
    availableModels,
    modelThinkingLevels = {},
    dispatch,
    setModelFn = setModelPi,
    getAvailableThinkingLevelsFn = getAvailableThinkingLevelsPi,
    getModelThinkingLevelsFn = getModelThinkingLevelsPi,
    setThinkingLevelFn = setThinkingLevelPi,
    onThinkingLevelsFetched,
  } = params;

  try {
    dispatch({ type: 'MODEL_CHANGE_START', targetProjectId });

    const thinkingLevels = await getModelThinkingLevelsFn().catch(() => modelThinkingLevels);
    onThinkingLevelsFetched?.(thinkingLevels);

    const updatedModel = await setModelFn(provider, modelId);
    const levels = await getAvailableThinkingLevelsFn();

    // Match in availableModels: match exact id & provider, or match raw vs qualified
    const matched =
      availableModels.find(
        (m) =>
          (m.id === modelId || (m.provider && `${m.provider}/${m.id}` === modelId)) &&
          (m.provider === provider || !m.provider || !provider)
      ) || availableModels.find((m) => m.id === modelId);

    const outcome = resolveModelSelectionOutcome(
      matched,
      updatedModel,
      modelId,
      provider,
      levels,
      thinkingLevels
    );

    if (outcome.supportsReasoning) {
      try {
        await setThinkingLevelFn(outcome.defaultThinkingLevel);
      } catch (err) {
        console.warn('Failed to set thinking level for selected model:', err);
      }
      dispatch({
        type: 'MODEL_CHANGE_SUCCESS',
        targetProjectId,
        payload: {
          model: outcome.fullModel,
          thinkingLevel: outcome.defaultThinkingLevel,
          availableThinkingLevels: levels,
        },
      });
    } else {
      dispatch({
        type: 'MODEL_CHANGE_SUCCESS',
        targetProjectId,
        payload: {
          model: outcome.fullModel,
          thinkingLevel: null,
          availableThinkingLevels: levels,
        },
      });
    }

    return outcome.fullModel;
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Failed to switch model';
    dispatch({
      type: 'MODEL_CHANGE_FAIL',
      targetProjectId,
      payload: { error: errorMsg },
    });
    throw err;
  }
}
