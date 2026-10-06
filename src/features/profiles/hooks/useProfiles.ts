import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSddProfilesPi,
  saveSddProfilePi,
  deleteSddProfilePi,
  setActiveSddProfilePi,
  getCustomProvidersPi,
  getAvailableModelsPi,
  getModelThinkingLevelsPi,
  MOCK_SDD_PROFILES_STORAGE_KEY,
} from '@infra/bridge';
import {
  sanitizeProfileName,
  type AgentCategory,
  type DiscoveredAgentMeta,
  type Profile,
  type ProfileScope,
  type ProfileSummary,
  type ReasoningEffort,
  type ModelProfileEntry,
  PROFILE_ACTIVATED_EVENT,
  PROFILE_CLEARED_EVENT,
  type ProfileActivationEventDetail,
  type ProfileClearActiveEventDetail,
} from '@core/types/profiles';
import {
  type ModelInfo,
  type ModelThinkingLevelsMap,
  type ThinkingLevel,
  getSupportedReasoningEffortsForModel,
  resolveModelDefaultThinkingLevel,
} from '@core/types/models';
import type { CustomProvidersMap } from '@core/types/providers';
import { extractApprovedProviderModels, isModelAllowed, qualifyModelId } from '../lib/approvedModels';
import { EMPTY_PROFILE_FORM, type ProfileFormData } from '../types';

export interface UseProfilesOptions {
  cwd?: string;
  availableModels?: ModelInfo[];
  onActivate?: (profile: ProfileSummary, scope: 'project' | 'global') => Promise<void> | void;
  onClearActive?: () => Promise<void> | void;
}

export interface UseProfilesResult {
  profiles: ProfileSummary[];
  projectActiveProfile: string | null;
  globalActiveProfile: string | null;
  effectiveActiveProfile: string | null;
  effectiveScope: 'project' | 'global' | null;
  categories: AgentCategory[];
  allAgents: string[];
  agentMeta: Record<string, DiscoveredAgentMeta>;
  availableModels: ModelInfo[];
  modelThinkingLevels: ModelThinkingLevelsMap;
  isLoading: boolean;
  error: string | null;
  successNotice: string | null;
  activatingName: string | null;
  deletingName: string | null;
  isDeleting: boolean;
  refreshProfiles: () => Promise<void>;
  handleActivateProfile: (profile: ProfileSummary, scope: 'project' | 'global') => Promise<void>;
  handleClearProjectActive: () => Promise<void>;
  handleDeleteProfile: (profile: ProfileSummary) => Promise<void>;
  clearNotices: () => void;
  // Modal state & handlers
  isModalOpen: boolean;
  isEditing: boolean;
  isSaving: boolean;
  modalError: string | null;
  formData: ProfileFormData;
  openCreateModal: () => void;
  openEditModal: (summary: ProfileSummary) => void;
  openDuplicateModal: (summary: ProfileSummary) => void;
  closeModal: () => void;
  updateFormField: <K extends keyof ProfileFormData>(field: K, value: ProfileFormData[K]) => void;
  updateAgentModel: (agentKey: string, model: string, effort?: ReasoningEffort | '') => void;
  removeAgentOverride: (agentKey: string) => void;
  handleSaveProfile: (e: React.FormEvent) => Promise<boolean>;
}

function findFullProfile(summary: ProfileSummary, cwd?: string): Profile | null {
  if (summary.model_profiles && Object.keys(summary.model_profiles).length > 0) {
    return {
      name: summary.name,
      description: summary.description,
      default_model: summary.default_model,
      default_effort: summary.default_effort,
      model_profiles: summary.model_profiles,
    };
  }



  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(MOCK_SDD_PROFILES_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        if (Array.isArray(stored)) {
          const found = stored.find(
            (p: Profile & { scope?: string; cwd?: string }) =>
              p.name === summary.name &&
              p.scope === summary.scope &&
              (p.scope !== 'project' || !cwd || p.cwd === cwd)
          );
          if (found) return found;
        }
      }
    } catch {
      // ignore preview storage read errors
    }
  }

  return null;
}

/**
 * Merges models defined in custom providers into a base list of models.
 * Updates matching models with provider, reasoning, reasoningEfforts, and thinkingLevelMap,
 * and appends custom models that do not exist yet in baseModels.
 */
export function mergeCustomProviderModels(
  baseModels: ModelInfo[],
  providersMap?: CustomProvidersMap | Record<string, unknown>
): ModelInfo[] {
  const result: ModelInfo[] = baseModels.map((m) => ({ ...m }));
  if (!providersMap || typeof providersMap !== 'object') {
    return result;
  }

  for (const [provKey, provVal] of Object.entries(providersMap)) {
    if (!provVal || typeof provVal !== 'object') continue;
    const providerConfig = provVal as { id?: string; name?: string; models?: Array<Record<string, unknown>> };
    const providerId = (providerConfig.id || provKey).trim();
    const models = providerConfig.models;
    if (!Array.isArray(models)) continue;

    for (const rawModel of models) {
      if (!rawModel || typeof rawModel !== 'object' || !rawModel.id || typeof rawModel.id !== 'string') {
        continue;
      }
      const modelId = rawModel.id.trim();
      const modelName = typeof rawModel.name === 'string' ? rawModel.name.trim() : modelId;
      const reasoning = typeof rawModel.reasoning === 'boolean'
        ? rawModel.reasoning
        : Array.isArray(rawModel.reasoningEfforts) && rawModel.reasoningEfforts.length > 0
          ? true
          : rawModel.thinkingLevelMap !== undefined
            ? true
            : undefined;

      const reasoningEfforts = Array.isArray(rawModel.reasoningEfforts)
        ? (rawModel.reasoningEfforts as string[])
        : undefined;

      const thinkingLevelMap = rawModel.thinkingLevelMap && typeof rawModel.thinkingLevelMap === 'object'
        ? (rawModel.thinkingLevelMap as Record<string, string | null>)
        : undefined;

      const thinkingLevel = typeof rawModel.thinkingLevel === 'string'
        ? (rawModel.thinkingLevel as ThinkingLevel)
        : undefined;

      const defaultThinkingLevel = typeof rawModel.defaultThinkingLevel === 'string'
        ? (rawModel.defaultThinkingLevel as ThinkingLevel)
        : undefined;

      // Check if this model already exists in result:
      const matchIndex = result.findIndex((m) => {
        if (!m.id) return false;
        if (m.id === modelId) return true;
        if (m.id === `${providerId}/${modelId}`) return true;
        if (modelId.startsWith(`${providerId}/`) && m.id === modelId.slice(providerId.length + 1)) return true;
        if (m.provider === providerId && (m.id === modelId || m.name === modelName)) return true;
        return false;
      });

      if (matchIndex >= 0) {
        const existing = result[matchIndex];
        result[matchIndex] = {
          ...existing,
          provider: existing.provider || providerId,
          name: existing.name || modelName,
          reasoning: reasoning !== undefined ? reasoning : existing.reasoning,
          reasoningEfforts: reasoningEfforts ?? existing.reasoningEfforts,
          thinkingLevelMap: thinkingLevelMap ?? existing.thinkingLevelMap,
          thinkingLevel: thinkingLevel ?? existing.thinkingLevel,
          defaultThinkingLevel: defaultThinkingLevel ?? existing.defaultThinkingLevel,
          contextWindow: typeof rawModel.contextWindow === 'number' ? rawModel.contextWindow : existing.contextWindow,
          maxTokens: typeof rawModel.maxTokens === 'number' ? rawModel.maxTokens : existing.maxTokens,
        };
      } else {
        result.push({
          id: modelId,
          name: modelName,
          provider: providerId,
          reasoning,
          reasoningEfforts,
          thinkingLevelMap,
          thinkingLevel,
          defaultThinkingLevel,
          contextWindow: typeof rawModel.contextWindow === 'number' ? rawModel.contextWindow : undefined,
          maxTokens: typeof rawModel.maxTokens === 'number' ? rawModel.maxTokens : undefined,
        });
      }
    }
  }

  return result;
}

// Pi's live RPC catalog includes built-in OAuth models, which are not in models.json.
// Keep custom policy authoritative and distinguish identical raw IDs by provider.
export function mergeProfileCatalog(
  approved: ModelInfo[],
  runtimeModels: ModelInfo[],
  providers: CustomProvidersMap
): ModelInfo[] {
  const result = enrichApprovedModelsWithPassed(approved, runtimeModels);
  const seen = new Set(result.map((model) => model.id));
  for (const model of runtimeModels) {
    if (!model.id || !model.provider) continue;
    const id = qualifyModelId(model.provider, model.id);
    const policy = providers[model.provider];
    if (policy && !isModelAllowed(model.id, policy)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ ...model, id });
  }
  return result;
}

function enrichApprovedModelsWithPassed(
  approved: ModelInfo[],
  passed?: ModelInfo[]
): ModelInfo[] {
  if (!passed || passed.length === 0) return approved;
  return approved.map((m) => {
    const matched = passed.find(
      (pm) =>
        pm.provider === m.provider && (
          pm.id === m.id ||
          (m.provider && `${m.provider}/${pm.id}` === m.id) ||
          pm.name === m.name
        )
    );
    if (!matched) return m;
    return {
      ...m,
      contextWindow: matched.contextWindow ?? m.contextWindow,
      maxTokens: matched.maxTokens ?? m.maxTokens,
      reasoning: m.reasoning !== undefined ? m.reasoning : matched.reasoning,
      reasoningEfforts: m.reasoningEfforts ?? matched.reasoningEfforts,
      thinkingLevelMap: m.thinkingLevelMap ?? matched.thinkingLevelMap,
      thinkingLevel: m.thinkingLevel ?? matched.thinkingLevel,
      defaultThinkingLevel: m.defaultThinkingLevel ?? matched.defaultThinkingLevel,
      input: m.input ?? matched.input,
      input_modalities: m.input_modalities ?? matched.input_modalities,
    };
  });
}

export function useProfiles(options?: UseProfilesOptions): UseProfilesResult {
  const cwd = options?.cwd;
  const passedModels = options?.availableModels;

  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [projectActiveProfile, setProjectActiveProfile] = useState<string | null>(null);
  const [globalActiveProfile, setGlobalActiveProfile] = useState<string | null>(null);
  const [effectiveActiveProfile, setEffectiveActiveProfile] = useState<string | null>(null);
  const [effectiveScope, setEffectiveScope] = useState<'project' | 'global' | null>(null);
  const [categories, setCategories] = useState<AgentCategory[]>([]);
  const [allAgents, setAllAgents] = useState<string[]>([]);
  const [agentMeta, setAgentMeta] = useState<Record<string, DiscoveredAgentMeta>>({});
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>(() => []);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<ModelThinkingLevelsMap>({});
  const customProvidersRef = useRef<CustomProvidersMap>({});

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [activatingName, setActivatingName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // Modal form state
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [editingOriginalScope, setEditingOriginalScope] = useState<ProfileScope | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [formData, setFormData] = useState<ProfileFormData>(EMPTY_PROFILE_FORM);

  const refreshProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [profilesData, customProvidersConfig, thinkingLevels, runtimeModels] = await Promise.all([
        getSddProfilesPi(cwd),
        getCustomProvidersPi().catch(() => ({ providers: {} })),
        getModelThinkingLevelsPi().catch(() => ({})),
        getAvailableModelsPi().catch(() => []),
      ]);

      const providers = customProvidersConfig?.providers || {};
      customProvidersRef.current = providers;
      setModelThinkingLevels(thinkingLevels || {});

      const approved = extractApprovedProviderModels(providers);
      const finalModels = mergeProfileCatalog(approved, runtimeModels, providers);
      // The app may already have a filtered live catalog; enrich known entries from it.
      const enrichedModels = enrichApprovedModelsWithPassed(finalModels, passedModels);

      setProfiles(profilesData.profiles || []);
      setProjectActiveProfile(profilesData.projectActiveProfile || null);
      setGlobalActiveProfile(profilesData.globalActiveProfile || null);
      setEffectiveActiveProfile(profilesData.effectiveActiveProfile || null);
      setEffectiveScope(profilesData.effectiveScope || null);
      setCategories(profilesData.categories || []);
      setAllAgents(profilesData.allAgents || []);
      setAgentMeta(profilesData.agentMeta || {});
      setAvailableModels(enrichedModels);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [cwd, passedModels]);

  useEffect(() => {
    if (passedModels && passedModels.length > 0) {
      setAvailableModels((current) => {
        const approved =
          current.length > 0
            ? current
            : extractApprovedProviderModels(customProvidersRef.current);
        return enrichApprovedModelsWithPassed(approved, passedModels);
      });
    }
  }, [passedModels]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const clearNotices = useCallback(() => {
    setError(null);
    setSuccessNotice(null);
  }, []);

  const handleActivateProfile = useCallback(
    async (profile: ProfileSummary, scope: 'project' | 'global') => {
      setActivatingName(profile.name);
      setError(null);
      setSuccessNotice(null);

      try {
        const payload = {
          cwd: scope === 'project' ? cwd : undefined,
          name: profile.name,
          scope,
        };

        const res = await setActiveSddProfilePi(payload);
        if (res.success) {
          const scopeLabel = scope === 'project' ? 'para el proyecto actual' : 'globalmente';
          setSuccessNotice(`Perfil "${profile.name}" activado ${scopeLabel}`);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent<ProfileActivationEventDetail>(PROFILE_ACTIVATED_EVENT, {
                detail: { profile, scope },
              })
            );
          }
          await options?.onActivate?.(profile, scope);
          await refreshProfiles();
        } else {
          setError(res.message || 'Error al activar el perfil');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setActivatingName(null);
      }
    },
    [cwd, refreshProfiles]
  );

  const handleClearProjectActive = useCallback(async () => {
    setError(null);
    setSuccessNotice(null);

    try {
      const res = await setActiveSddProfilePi({
        cwd,
        name: null,
        scope: 'project',
      });

      if (res.success) {
        setSuccessNotice('Perfil del proyecto restablecido. Ahora hereda el perfil global activo.');
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent<ProfileClearActiveEventDetail>(PROFILE_CLEARED_EVENT, {
              detail: { scope: 'project' },
            })
          );
        }
        await options?.onClearActive?.();
        await refreshProfiles();
      } else {
        setError(res.message || 'Error al restablecer el perfil del proyecto');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }, [cwd, refreshProfiles]);

  const handleDeleteProfile = useCallback(
    async (profile: ProfileSummary) => {
      setIsDeleting(true);
      setDeletingName(profile.name);
      setError(null);
      setSuccessNotice(null);

      try {
        const res = await deleteSddProfilePi({
          cwd: profile.scope === 'project' ? cwd : undefined,
          scope: profile.scope,
          name: profile.name,
        });

        if (res.success) {
          setSuccessNotice(`Perfil "${profile.name}" eliminado correctamente`);
          await refreshProfiles();
        } else {
          setError(res.message || 'Error al eliminar el perfil');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsDeleting(false);
        setDeletingName(null);
      }
    },
    [cwd, refreshProfiles]
  );

  // Modal actions
  const openCreateModal = useCallback(() => {
    const firstModel = availableModels[0] || null;
    const firstModelId = firstModel?.id || '';
    const supported = getSupportedReasoningEffortsForModel(firstModel);
    const defaultEffort = firstModelId
      ? resolveModelDefaultThinkingLevel(firstModel, modelThinkingLevels, supported)
      : '';

    setFormData({
      ...EMPTY_PROFILE_FORM,
      scope: cwd ? 'project' : 'global',
      default_model: firstModelId,
      default_effort: (defaultEffort as ReasoningEffort) || '',
    });
    setIsEditing(false);
    setEditingOriginalName(null);
    setEditingOriginalScope(null);
    setModalError(null);
    setIsModalOpen(true);
  }, [cwd, availableModels, modelThinkingLevels]);

  const openEditModal = useCallback(
    (summary: ProfileSummary) => {
      const full = findFullProfile(summary, cwd);

      setFormData({
        name: summary.name,
        description: summary.description || '',
        scope: summary.scope === 'project' ? 'project' : 'global',
        default_model: summary.default_model || full?.default_model || '',
        default_effort: summary.default_effort || full?.default_effort || '',
        model_profiles: full?.model_profiles || summary.model_profiles || {},
      });

      setIsEditing(true);
      setEditingOriginalName(summary.name);
      setEditingOriginalScope(summary.scope);
      setModalError(null);
      setIsModalOpen(true);
    },
    [cwd]
  );

  const openDuplicateModal = useCallback(
    (summary: ProfileSummary) => {
      const full = findFullProfile(summary, cwd);

      setFormData({
        name: `${summary.name}-copy`,
        description: summary.description ? `${summary.description} (copia)` : '',
        scope: summary.scope === 'project' ? 'project' : 'global',
        default_model: summary.default_model || full?.default_model || '',
        default_effort: summary.default_effort || full?.default_effort || '',
        model_profiles: { ...(full?.model_profiles || summary.model_profiles || {}) },
      });

      setIsEditing(false);
      setEditingOriginalName(null);
      setEditingOriginalScope(null);
      setModalError(null);
      setIsModalOpen(true);
    },
    [cwd]
  );

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    setModalError(null);
    setIsSaving(false);
  }, []);

  const updateFormField = useCallback(
    <K extends keyof ProfileFormData>(field: K, value: ProfileFormData[K]) => {
      setFormData((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    []
  );

  const updateAgentModel = useCallback(
    (agentKey: string, model: string, effort?: ReasoningEffort | '') => {
      setFormData((prev) => {
        const nextModelProfiles = { ...prev.model_profiles };
        const trimmedModel = model.trim();

        if (!trimmedModel) {
          delete nextModelProfiles[agentKey];
        } else {
          nextModelProfiles[agentKey] = {
            model: trimmedModel,
            ...(effort ? { effort } : {}),
          };
        }

        return {
          ...prev,
          model_profiles: nextModelProfiles,
        };
      });
    },
    []
  );

  const removeAgentOverride = useCallback((agentKey: string) => {
    setFormData((prev) => {
      const nextModelProfiles = { ...prev.model_profiles };
      delete nextModelProfiles[agentKey];
      return {
        ...prev,
        model_profiles: nextModelProfiles,
      };
    });
  }, []);

  const handleSaveProfile = useCallback(
    async (e: React.FormEvent): Promise<boolean> => {
      e.preventDefault();

      const rawName = formData.name.trim();
      if (!rawName) {
        setModalError('El nombre del perfil es obligatorio');
        return false;
      }

      const sanitized = sanitizeProfileName(rawName);
      if (!sanitized) {
        setModalError('El nombre del perfil contiene únicamente caracteres no válidos');
        return false;
      }

      setIsSaving(true);
      setModalError(null);

      try {
        const cleanedModelProfiles: Record<string, ModelProfileEntry> = {};
        for (const [key, entry] of Object.entries(formData.model_profiles)) {
          if (entry && entry.model && entry.model.trim()) {
            cleanedModelProfiles[key] = {
              model: entry.model.trim(),
              ...(entry.effort ? { effort: entry.effort } : {}),
            };
          }
        }

        const profilePayload: Profile = {
          name: rawName,
          description: formData.description.trim() || undefined,
          default_model: formData.default_model.trim() || undefined,
          default_effort: formData.default_effort ? formData.default_effort : undefined,
          model_profiles: cleanedModelProfiles,
        };

        // If editing a custom profile and name/scope changed, delete the old profile first
        if (
          isEditing &&
          editingOriginalName &&
          editingOriginalScope &&
          (editingOriginalName !== rawName || editingOriginalScope !== formData.scope)
        ) {
          try {
            await deleteSddProfilePi({
              cwd: editingOriginalScope === 'project' ? cwd : undefined,
              scope: editingOriginalScope,
              name: editingOriginalName,
            });
          } catch (err) {
            console.warn('Failed to remove original profile during rename:', err);
          }
        }

        const saveRes = await saveSddProfilePi({
          cwd: formData.scope === 'project' ? cwd : undefined,
          scope: formData.scope,
          profile: profilePayload,
        });

        if (!saveRes.success) {
          setModalError(saveRes.message || 'Error al guardar el perfil');
          return false;
        }

        setIsModalOpen(false);
        setSuccessNotice(`Perfil "${rawName}" guardado correctamente`);
        await refreshProfiles();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setModalError(msg);
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [formData, isEditing, editingOriginalName, editingOriginalScope, cwd, refreshProfiles]
  );

  return {
    profiles,
    projectActiveProfile,
    globalActiveProfile,
    effectiveActiveProfile,
    effectiveScope,
    categories,
    allAgents,
    agentMeta,
    availableModels,
    modelThinkingLevels,
    isLoading,
    error,
    successNotice,
    activatingName,
    deletingName,
    isDeleting,
    refreshProfiles,
    handleActivateProfile,
    handleClearProjectActive,
    handleDeleteProfile,
    clearNotices,
    isModalOpen,
    isEditing,
    isSaving,
    modalError,
    formData,
    openCreateModal,
    openEditModal,
    openDuplicateModal,
    closeModal,
    updateFormField,
    updateAgentModel,
    removeAgentOverride,
    handleSaveProfile,
  };
}
