import { useCallback, useEffect, useState } from 'react';
import {
  getCustomProvidersPi,
  upsertCustomProviderPi,
  deleteCustomProviderPi,
  getModelThinkingLevelsPi,
  saveModelThinkingLevelsPi,
} from '@infra/bridge';
import { copyText } from '@shared/clipboard';
import type { TranslationKey } from '@shared/i18n';
import type { CustomProviderConfig, ModelsConfigFile } from '@core/types/providers';
import type { ModelThinkingLevelsMap, ThinkingLevel } from '@core/types/models';
import {
  isPiBuiltinProvider,
  mapProvidersToArray,
  validateProviderConfig,
} from '../providers';
import type { ProviderFormData } from '../types';

export interface UseProvidersDataOptions {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  onRefreshModels?: () => Promise<void>;
  cwd?: string | null;
}

export function prepareProviderPayload(formData: ProviderFormData): CustomProviderConfig {
  const isBuiltin = Boolean(formData.isBuiltin);
  const baseUrlTrimmed = formData.baseUrl ? formData.baseUrl.trim() : '';
  const apiTrimmed = formData.api ? formData.api.trim() : '';
  const apiKeyTrimmed = formData.apiKey ? formData.apiKey.trim() : '';

  return {
    id: formData.id.trim(),
    name: formData.name.trim() || undefined,
    baseUrl: baseUrlTrimmed ? baseUrlTrimmed : (isBuiltin ? undefined : ''),
    api: apiTrimmed ? apiTrimmed : (isBuiltin ? undefined : ''),
    apiKey: apiKeyTrimmed || undefined,
    models: formData.models,
    excludedModels: Array.isArray(formData.excludedModels) ? formData.excludedModels : [],
    includedModels: Array.isArray(formData.includedModels) ? formData.includedModels : [],
    isBuiltin: isBuiltin ? true : undefined,
  };
}

export function useProvidersData({ t, onRefreshModels, cwd }: UseProvidersDataOptions) {
  const [providers, setProviders] = useState<CustomProviderConfig[]>([]);
  const [fullConfig, setFullConfig] = useState<ModelsConfigFile>({});
  const [modelThinkingLevels, setModelThinkingLevels] = useState<ModelThinkingLevelsMap>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState<boolean>(false);
  const [copiedRawJson, setCopiedRawJson] = useState<boolean>(false);

  const resolveActiveCwd = useCallback((): string | null => {
    if (cwd && cwd.trim()) return cwd.trim();
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = window.localStorage.getItem('pi_viewer_projects');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === 'object' && parsed.activeProjectId && Array.isArray(parsed.projects)) {
            const active = parsed.projects.find(
              (p: unknown) => p && typeof p === 'object' && (p as { id: string }).id === parsed.activeProjectId
            );
            if (active && typeof active.path === 'string' && active.path.trim()) {
              return active.path.trim();
            }
          }
        }
      }
    } catch {
      // fallback safely
    }
    return null;
  }, [cwd]);

  const loadProviders = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [config, thinkingLevels] = await Promise.all([
        getCustomProvidersPi(),
        getModelThinkingLevelsPi().catch(() => ({})),
      ]);
      setFullConfig(config);
      const list = mapProvidersToArray(config.providers || {});
      setProviders(list.filter((p) => !isPiBuiltinProvider(p)));
      setModelThinkingLevels(thinkingLevels);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const saveProvider = useCallback(
    async (formData: ProviderFormData, isEditing: boolean): Promise<boolean> => {
      const providerToValidate = prepareProviderPayload(formData);

      const validation = validateProviderConfig(providerToValidate);
      if (!validation.valid) {
        throw new Error(validation.error || 'Validation failed');
      }

      setIsSaving(true);
      try {
        if (!isEditing && providers.some((p) => p.id === providerToValidate.id)) {
          throw new Error(t('providers.id_already_exists', { id: providerToValidate.id }));
        }

        const activeCwd = resolveActiveCwd();
        const savedConfig = await upsertCustomProviderPi(providerToValidate, activeCwd);
        setFullConfig(savedConfig);
        setProviders(mapProvidersToArray(savedConfig.providers || {}).filter((p) => !isPiBuiltinProvider(p)));

        const levelUpdates: Record<string, ThinkingLevel | null> = {};
        for (const m of formData.models) {
          const key = `${formData.id}/${m.id}`;
          if (m.reasoning && (m.thinkingLevel || m.defaultThinkingLevel)) {
            levelUpdates[key] = (m.thinkingLevel || m.defaultThinkingLevel) as ThinkingLevel;
          }
        }
        if (Object.keys(levelUpdates).length > 0) {
          void saveModelThinkingLevelsPi(levelUpdates).then((updated) => {
            setModelThinkingLevels(updated);
          }).catch(() => {});
        }

        setSuccessNotice(
          isEditing
            ? t('providers.notice_updated', { id: providerToValidate.id })
            : t('providers.notice_added', { id: providerToValidate.id })
        );

        if (onRefreshModels) {
          onRefreshModels().catch(() => {});
        }
        return true;
      } finally {
        setIsSaving(false);
      }
    },
    [providers, t, onRefreshModels, resolveActiveCwd]
  );

  const handleDeleteProvider = useCallback(
    async (idToDelete: string) => {
      setIsSaving(true);
      setError(null);
      try {
        const savedConfig = await deleteCustomProviderPi(idToDelete);
        setFullConfig(savedConfig);
        setProviders(mapProvidersToArray(savedConfig.providers || {}).filter((p) => !isPiBuiltinProvider(p)));

        const prefix = `${idToDelete}/`;
        const levelUpdates: Record<string, ThinkingLevel | null> = {};
        for (const key of Object.keys(modelThinkingLevels)) {
          if (key.startsWith(prefix)) {
            levelUpdates[key] = null;
          }
        }
        if (Object.keys(levelUpdates).length > 0) {
          setModelThinkingLevels((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(levelUpdates)) {
              delete next[key];
            }
            return next;
          });
          void saveModelThinkingLevelsPi(levelUpdates).then((updated) => {
            setModelThinkingLevels(updated);
          }).catch(() => {});
        }

        setSuccessNotice(t('providers.notice_deleted', { id: idToDelete }));
        setDeletingId(null);

        if (onRefreshModels) {
          onRefreshModels().catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsSaving(false);
      }
    },
    [providers, modelThinkingLevels, t, onRefreshModels]
  );

  const updateModelThinkingLevelsMap = useCallback((levelUpdates: Record<string, ThinkingLevel | null>) => {
    setModelThinkingLevels((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(levelUpdates)) {
        if (v === null) {
          delete next[k];
        } else {
          next[k] = v;
        }
      }
      return next;
    });
    void saveModelThinkingLevelsPi(levelUpdates).then((updated) => {
      setModelThinkingLevels(updated);
    }).catch((err) => {
      console.warn('Failed to save modelThinkingLevels:', err);
    });
  }, []);

  const handleCopyRawJson = useCallback(async () => {
    const jsonStr = JSON.stringify(fullConfig, null, 2);
    const success = await copyText(jsonStr);
    if (success) {
      setCopiedRawJson(true);
      setTimeout(() => setCopiedRawJson(false), 2000);
    }
  }, [fullConfig]);

  return {
    providers,
    fullConfig,
    modelThinkingLevels,
    setModelThinkingLevels,
    updateModelThinkingLevelsMap,
    isLoading,
    isSaving,
    error,
    setError,
    successNotice,
    setSuccessNotice,
    deletingId,
    setDeletingId,
    showRawJson,
    setShowRawJson,
    copiedRawJson,
    handleCopyRawJson,
    loadProviders,
    saveProvider,
    handleDeleteProvider,
  };
}
