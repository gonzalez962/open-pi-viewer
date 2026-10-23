import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAvailableModelsPi,
  getAvailableThinkingLevelsPi,
  getCustomProvidersPi,
  getEnabledModelsPi,
  saveEnabledModelsPi,
  getModelThinkingLevelsPi,
  getSessionStatsPi,
  setThinkingLevelPi,
} from '@infra/bridge';
import {
  enrichAvailableModelsWithConfig,
  filterByEnabledModels,
  filterExcludedModels,
  resolveModelDefaultThinkingLevel,
  syncEnabledModelsWithConfiguredBuiltins,
  extractApprovedProviderModels,
  mergeProfileCatalog,
} from '../providers';
import { executeModelSelection } from '../lib/modelSelection';
import type { ModelInfo, ModelThinkingLevelsMap, ThinkingLevel } from '@core/types/models';
import type { ConnectionState } from '@core/types/connection';
import type { ChatAction } from '@core/reducer';

export interface UseModelsOptions {
  connectionStatus: ConnectionState;
  sessionId: string | null;
  projectId?: string;
  cwd?: string;
  /** Read via closure inside the connect-time effect, exactly like `state.modelInfo` was in App.tsx. */
  modelInfo: ModelInfo | null | undefined;
  availableModels: ModelInfo[];
  dispatch: React.Dispatch<ChatAction & { targetProjectId?: string }>;
  resolveSessionSnapshot?: (
    cwd: string,
    sessionId: string
  ) => { modelId?: string | null; provider?: string | null } | null;
}

export interface UseModelsResult {
  modelThinkingLevels: ModelThinkingLevelsMap;
  handleSelectModel: (provider: string, modelId: string) => Promise<void>;
  handleSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  handleRefreshModels: () => Promise<void>;
  isSessionInitialized: boolean;
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
  projectId,
  cwd,
  modelInfo,
  availableModels,
  dispatch,
  resolveSessionSnapshot,
}: UseModelsOptions): UseModelsResult {
  const [modelThinkingLevels, setModelThinkingLevels] = useState<ModelThinkingLevelsMap>({});
  const [initializedSessionId, setInitializedSessionId] = useState<string | null>(null);
  const [initializedCwd, setInitializedCwd] = useState<string | undefined>(undefined);
  const [initializedProjectId, setInitializedProjectId] = useState<string | undefined>(undefined);
  const enabledModelsRef = useRef<string[] | undefined>(undefined);

  const isSessionInitialized =
    connectionStatus === 'connected' &&
    sessionId !== null &&
    initializedSessionId === sessionId &&
    (cwd === undefined || initializedCwd === cwd) &&
    (projectId === undefined || initializedProjectId === projectId);

  const handleSelectModel = useCallback(
    async (provider: string, modelId: string) => {
      await executeModelSelection({
        provider,
        modelId,
        targetProjectId: projectId,
        availableModels,
        modelThinkingLevels,
        dispatch,
        onThinkingLevelsFetched: setModelThinkingLevels,
      });
    },
    [availableModels, modelThinkingLevels, projectId, dispatch]
  );

  const handleSelectThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      try {
        await setThinkingLevelPi(level);
        dispatch({
          type: 'SET_THINKING_LEVEL',
          targetProjectId: projectId,
          payload: { level },
        });
      } catch (err) {
        console.warn('Failed to set thinking level:', err);
      }
    },
    [projectId, dispatch]
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

      if (currentEnabled && currentEnabled.length > 0 && customProvidersConfig?.providers) {
        const syncResult = syncEnabledModelsWithConfiguredBuiltins(currentEnabled, customProvidersConfig.providers);
        if (syncResult.hasChanges && syncResult.nextEnabled) {
          currentEnabled = syncResult.nextEnabled;
          enabledModelsRef.current = currentEnabled;
          void saveEnabledModelsPi(currentEnabled).catch((err) => {
            console.warn('Failed to auto-sync enabledModels:', err);
          });
        }
      }

      const approved = extractApprovedProviderModels(customProvidersConfig?.providers);
      const allModels = mergeProfileCatalog(approved, models || [], customProvidersConfig?.providers || {});
      if (allModels && allModels.length > 0) {
        const enriched = enrichAvailableModelsWithConfig(allModels, customProvidersConfig?.providers);
        const providerFiltered = filterExcludedModels(enriched, customProvidersConfig?.providers);
        const activeModels = filterByEnabledModels(providerFiltered, currentEnabled);
        dispatch({
          type: 'SET_AVAILABLE_MODELS',
          targetProjectId: projectId,
          payload: { models: activeModels },
        });
      }
    } catch (err) {
      console.warn('Failed to refresh models:', err);
    }
  }, [connectionStatus, projectId, dispatch]);

  // Fetch available models, thinking levels, and session stats when connected.
  useEffect(() => {
    if (connectionStatus !== 'connected' || !sessionId) {
      setInitializedSessionId(null);
      setInitializedCwd(undefined);
      setInitializedProjectId(undefined);
      return;
    }

    const currentSessionId = sessionId;
    const currentCwd = cwd;
    const currentProjectId = projectId;
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

        if (currentEnabled && currentEnabled.length > 0 && customProvidersConfig?.providers) {
          const syncResult = syncEnabledModelsWithConfiguredBuiltins(currentEnabled, customProvidersConfig.providers);
          if (syncResult.hasChanges && syncResult.nextEnabled) {
            currentEnabled = syncResult.nextEnabled;
            if (isSubscribed) {
              enabledModelsRef.current = currentEnabled;
            }
            void saveEnabledModelsPi(currentEnabled).catch((err) => {
              console.warn('Failed to auto-sync enabledModels:', err);
            });
          }
        }

        const approved = extractApprovedProviderModels(customProvidersConfig?.providers);
        const allModels = mergeProfileCatalog(approved, models || [], customProvidersConfig?.providers || {});
        let activeModels: ModelInfo[] = [];
        if (allModels && allModels.length > 0) {
          const enriched = enrichAvailableModelsWithConfig(allModels, customProvidersConfig?.providers);
          const providerFiltered = filterExcludedModels(enriched, customProvidersConfig?.providers);
          activeModels = filterByEnabledModels(providerFiltered, currentEnabled);
          dispatch({
            type: 'SET_AVAILABLE_MODELS',
            targetProjectId: currentProjectId,
            payload: { models: activeModels },
          });
        }
        if (levels && levels.length > 0) {
          dispatch({
            type: 'SET_AVAILABLE_THINKING_LEVELS',
            targetProjectId: currentProjectId,
            payload: { levels },
          });
        }
        if (stats) {
          dispatch({
            type: 'SET_SESSION_STATS',
            targetProjectId: currentProjectId,
            payload: { stats },
          });
        }

        const snapshot =
          currentCwd && currentSessionId && resolveSessionSnapshot
            ? resolveSessionSnapshot(currentCwd, currentSessionId)
            : null;

        let baseModel = modelInfo;
        if (!baseModel && snapshot?.modelId) {
          const snapshotMatched = activeModels.find(
            (m) =>
              (m.id === snapshot.modelId ||
                (snapshot.provider && `${snapshot.provider}/${m.id}` === snapshot.modelId) ||
                (snapshot.provider && m.id === `${snapshot.provider}/${snapshot.modelId}`)) &&
              (!snapshot.provider || m.provider === snapshot.provider || !m.provider)
          );
          if (snapshotMatched) {
            baseModel = snapshotMatched;
          } else {
            baseModel = {
              id: snapshot.modelId,
              provider: snapshot.provider || '',
              name: snapshot.modelId,
            };
          }
        }

        const matched = activeModels.find(
          (m) => m.id === baseModel?.id && (m.provider === baseModel?.provider || !baseModel?.provider)
        );
        const currentModel = matched
          ? {
              ...matched,
              ...baseModel,
              input_modalities: matched.input_modalities ?? baseModel?.input_modalities,
            }
          : baseModel || activeModels[0];

        if (currentModel && (!modelInfo || !modelInfo.input_modalities)) {
          dispatch({
            type: 'MODEL_CHANGE_SUCCESS',
            targetProjectId: currentProjectId,
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
          dispatch({
            type: 'SET_THINKING_LEVEL',
            targetProjectId: currentProjectId,
            payload: { level: defaultEffort },
          });
        }

        if (isSubscribed && sessionId === currentSessionId) {
          setInitializedSessionId(currentSessionId);
          setInitializedCwd(currentCwd);
          setInitializedProjectId(currentProjectId);
        }
      } catch (err) {
        console.warn('Failed to load session parameters:', err);
      }
    };

    void loadSessionParams();

    return () => {
      isSubscribed = false;
    };
  }, [connectionStatus, sessionId, cwd, projectId]);

  return {
    modelThinkingLevels,
    handleSelectModel,
    handleSelectThinkingLevel,
    handleRefreshModels,
    isSessionInitialized,
  };
}
