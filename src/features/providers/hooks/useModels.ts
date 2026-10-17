import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAvailableModelsPi,
  getAvailableThinkingLevelsPi,
  getCustomProvidersPi,
  getEnabledModelsPi,
  getModelThinkingLevelsPi,
  getSessionStatsPi,
  setModelPi,
  setThinkingLevelPi,
} from '@infra/bridge';
import {
  enrichAvailableModelsWithConfig,
  filterByEnabledModels,
  filterExcludedModels,
  resolveModelDefaultThinkingLevel,
  resolveModelSelectionOutcome,
} from '../providers';
import type { ModelInfo, ModelThinkingLevelsMap, ThinkingLevel } from '@core/types/models';
import type { ConnectionState } from '@core/types/connection';
import type { ChatAction } from '@core/reducer';

export interface UseModelsOptions {
  connectionStatus: ConnectionState;
  sessionId: string | null;
  /** Read via closure inside the connect-time effect, exactly like `state.modelInfo` was in App.tsx. */
  modelInfo: ModelInfo | null | undefined;
  availableModels: ModelInfo[];
  dispatch: React.Dispatch<ChatAction>;
}

export interface UseModelsResult {
  modelThinkingLevels: ModelThinkingLevelsMap;
  handleSelectModel: (provider: string, modelId: string) => Promise<void>;
  handleSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  handleRefreshModels: () => Promise<void>;
}

/**
 * Models cluster: the settings.json thinking-level overrides map, model/thinking-level
 * selection handlers, a manual refresh, and the effect that straddles connection, sessions
 * and models on every connect (available models, thinking levels, session stats, custom
 * providers and the thinking-level overrides map). `connectionStatus` and `sessionId` are
 * inputs; the hook dispatches through the injected `dispatch` and never owns the reducer.
 */
export function useModels({
  connectionStatus,
  sessionId,
  modelInfo,
  availableModels,
  dispatch,
}: UseModelsOptions): UseModelsResult {
  const [modelThinkingLevels, setModelThinkingLevels] = useState<ModelThinkingLevelsMap>({});
  const enabledModelsRef = useRef<string[] | undefined>(undefined);

  const handleSelectModel = useCallback(
    async (provider: string, modelId: string) => {
      try {
        dispatch({ type: 'MODEL_CHANGE_START' });
        const thinkingLevels = await getModelThinkingLevelsPi().catch(() => modelThinkingLevels);
        setModelThinkingLevels(thinkingLevels);
        const updatedModel = await setModelPi(provider, modelId);
        const levels = await getAvailableThinkingLevelsPi();
        const matched = availableModels.find(
          (m) => m.provider === provider && m.id === modelId
        );
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
            await setThinkingLevelPi(outcome.defaultThinkingLevel);
          } catch (err) {
            console.warn('Failed to set thinking level for selected model:', err);
          }
          dispatch({
            type: 'MODEL_CHANGE_SUCCESS',
            payload: {
              model: outcome.fullModel,
              thinkingLevel: outcome.defaultThinkingLevel,
              availableThinkingLevels: levels,
            },
          });
        } else {
          dispatch({
            type: 'MODEL_CHANGE_SUCCESS',
            payload: {
              model: outcome.fullModel,
              thinkingLevel: null,
              availableThinkingLevels: levels,
            },
          });
        }
      } catch (err: unknown) {
        const errorMsg =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'Failed to switch model';
        dispatch({
          type: 'MODEL_CHANGE_FAIL',
          payload: { error: errorMsg },
        });
      }
    },
    [availableModels, modelThinkingLevels]
  );

  const handleSelectThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      try {
        await setThinkingLevelPi(level);
        dispatch({
          type: 'SET_THINKING_LEVEL',
          payload: { level },
        });
      } catch (err) {
        console.warn('Failed to set thinking level:', err);
      }
    },
    []
  );

  const handleRefreshModels = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      let currentEnabled = enabledModelsRef.current;
      try {
        const fetched = await getEnabledModelsPi();
        currentEnabled = fetched;
        enabledModelsRef.current = fetched;
      } catch (err) {
        console.warn('Failed to read enabledModels from settings.json:', err);
      }

      const [models, customProvidersConfig] = await Promise.all([
        getAvailableModelsPi(),
        getCustomProvidersPi().catch(() => ({ providers: {} })),
      ]);
      if (models && models.length > 0) {
        const enriched = enrichAvailableModelsWithConfig(models, customProvidersConfig?.providers);
        const providerFiltered = filterExcludedModels(enriched, customProvidersConfig?.providers);
        const activeModels = filterByEnabledModels(providerFiltered, currentEnabled);
        dispatch({ type: 'SET_AVAILABLE_MODELS', payload: { models: activeModels } });
      }
    } catch (err) {
      console.warn('Failed to refresh models:', err);
    }
  }, [connectionStatus]);

  // Fetch available models, thinking levels, and session stats when connected.
  useEffect(() => {
    if (connectionStatus !== 'connected') return;

    let isSubscribed = true;

    const loadSessionParams = async () => {
      try {
        let currentEnabled = enabledModelsRef.current;
        try {
          const fetched = await getEnabledModelsPi();
          currentEnabled = fetched;
          if (isSubscribed) {
            enabledModelsRef.current = fetched;
          }
        } catch (err) {
          console.warn('Failed to read enabledModels from settings.json:', err);
        }

        const [models, levels, stats, customProvidersConfig, thinkingLevels] = await Promise.all([
          getAvailableModelsPi(),
          getAvailableThinkingLevelsPi(),
          getSessionStatsPi(),
          getCustomProvidersPi().catch(() => ({ providers: {} })),
          getModelThinkingLevelsPi().catch(() => ({})),
        ]);
        if (!isSubscribed) return;

        setModelThinkingLevels(thinkingLevels);

        let activeModels: ModelInfo[] = [];
        if (models && models.length > 0) {
          const enriched = enrichAvailableModelsWithConfig(models, customProvidersConfig?.providers);
          const providerFiltered = filterExcludedModels(enriched, customProvidersConfig?.providers);
          activeModels = filterByEnabledModels(providerFiltered, currentEnabled);
          dispatch({ type: 'SET_AVAILABLE_MODELS', payload: { models: activeModels } });
        }
        if (levels && levels.length > 0) {
          dispatch({ type: 'SET_AVAILABLE_THINKING_LEVELS', payload: { levels } });
        }
        if (stats) {
          dispatch({ type: 'SET_SESSION_STATS', payload: { stats } });
        }

        const matched = activeModels.find(
          (m) => m.id === modelInfo?.id && (m.provider === modelInfo?.provider || !modelInfo?.provider)
        );
        const currentModel = matched
          ? {
              ...matched,
              ...modelInfo,
              input_modalities: matched.input_modalities ?? modelInfo?.input_modalities,
            }
          : modelInfo || activeModels[0];

        if (currentModel && (!modelInfo || !modelInfo.input_modalities)) {
          dispatch({
            type: 'MODEL_CHANGE_SUCCESS',
            payload: {
              model: currentModel,
              thinkingLevel: (currentModel.defaultThinkingLevel as ThinkingLevel) ?? null,
              availableThinkingLevels: levels,
            },
          });
        }

        const supportsReasoning = Boolean(
          currentModel?.reasoning ||
          (levels && levels.length > 0 && !(levels.length === 1 && levels[0] === 'off'))
        );

        if (supportsReasoning && currentModel) {
          const defaultEffort = resolveModelDefaultThinkingLevel(currentModel, thinkingLevels, levels);
          try {
            await setThinkingLevelPi(defaultEffort);
          } catch (err) {
            console.warn('Failed to set initial thinking level:', err);
          }
          if (!isSubscribed) return;
          dispatch({ type: 'SET_THINKING_LEVEL', payload: { level: defaultEffort } });
        }
      } catch (err) {
        console.warn('Failed to load session parameters:', err);
      }
    };

    void loadSessionParams();

    return () => {
      isSubscribed = false;
    };
  }, [connectionStatus, sessionId]);

  return {
    modelThinkingLevels,
    handleSelectModel,
    handleSelectThinkingLevel,
    handleRefreshModels,
  };
}
