import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { CustomModelDefinition, CustomProviderConfig } from '@core/types/providers';
import type { ModelInfo, ModelThinkingLevelsMap, ThinkingLevel } from '@core/types/models';
import { getBuiltinProviderCatalogPi } from '@infra/bridge';
import {
  clampThinkingLevelToSupported,
  fetchProviderModels,
  getSupportedThinkingLevelsForModel,
  isModelAllowed,
  validateBaseUrl,
  validateModelDefinition,
} from '../providers';
import {
  buildDraftModel,
  EMPTY_FORM,
  mergeDiscoveredModels,
  type ProviderFormData,
} from '../types';

export interface UseProviderModalFormOptions {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  modelThinkingLevels: ModelThinkingLevelsMap;
  updateModelThinkingLevelsMap: (levelUpdates: Record<string, ThinkingLevel | null>) => void;
  saveProvider: (formData: ProviderFormData, isEditing: boolean) => Promise<boolean>;
}

/**
 * Removes a model from the provider draft models list and adds its ID to excludedModels.
 */
export function removeModelFromDraft(
  prev: ProviderFormData,
  modelIdToRemove: string
): ProviderFormData {
  const trimmedId = modelIdToRemove.trim();
  if (!trimmedId) return prev;
  return {
    ...prev,
    models: prev.models.filter((m) => m.id !== trimmedId),
    excludedModels: prev.excludedModels.includes(trimmedId)
      ? prev.excludedModels
      : [...prev.excludedModels, trimmedId],
  };
}

/**
 * Restores an excluded model pattern to the provider draft models list when removed from excludedModels.
 * Matches against known catalog models preserving full metadata, or creates clean fallback entry if exact ID.
 */
export function restoreExcludedModelToDraft(
  prev: ProviderFormData,
  patternToRemove: string,
  knownCatalogModels?: Map<string, CustomModelDefinition> | CustomModelDefinition[]
): ProviderFormData {
  const cleanPattern = patternToRemove.trim();
  if (!cleanPattern) return prev;

  const nextExcluded = prev.excludedModels.filter((p) => p !== cleanPattern);
  const nextPolicy = {
    includedModels: prev.includedModels,
    excludedModels: nextExcluded,
  };

  const nextModels = [...prev.models];
  const existingIds = new Set(nextModels.map((m) => m.id.toLowerCase()));

  // 1. Check known catalog models map / array
  const candidates: CustomModelDefinition[] = [];
  if (knownCatalogModels) {
    const list =
      knownCatalogModels instanceof Map
        ? Array.from(knownCatalogModels.values())
        : knownCatalogModels;
    for (const m of list) {
      if (m && m.id && !existingIds.has(m.id.toLowerCase())) {
        candidates.push(m);
      }
    }
  }

  for (const m of candidates) {
    const wasBlocked = !isModelAllowed(m.id, {
      includedModels: prev.includedModels,
      excludedModels: prev.excludedModels,
    });
    const nowAllowed = isModelAllowed(m.id, nextPolicy);

    if (wasBlocked && nowAllowed) {
      nextModels.push(m);
      existingIds.add(m.id.toLowerCase());
    }
  }

  // 2. If it was a literal model ID (no wildcards) and was not restored from candidates
  if (!cleanPattern.includes('*') && !cleanPattern.includes('?') && !cleanPattern.includes('[')) {
    if (!existingIds.has(cleanPattern.toLowerCase()) && isModelAllowed(cleanPattern, nextPolicy)) {
      nextModels.push({
        id: cleanPattern,
        name: cleanPattern,
      });
    }
  }

  return {
    ...prev,
    models: nextModels,
    excludedModels: nextExcluded,
  };
}

/**
 * Builds the initial draft form state and known catalog models for editing a built-in provider.
 * Excludes any models that match the provider's excludedModels policy from the initial models list.
 */
export function buildInitialBuiltinProviderDraft(
  provider: { id: string; name?: string },
  catalogModels: (ModelInfo | CustomModelDefinition)[] = [],
  savedConfig?: CustomProviderConfig
): {
  formData: ProviderFormData;
  knownModels: Map<string, CustomModelDefinition>;
} {
  const providerId = provider.id;
  const catalogDefs: CustomModelDefinition[] = catalogModels
    .filter(
      (m) =>
        typeof m.id === 'string' &&
        m.id.trim() !== '' &&
        (!('provider' in m) || !m.provider || m.provider.toLowerCase() === providerId.toLowerCase())
    )
    .map((m) => ({
      id: (m.id || '').trim(),
      name: m.name || m.id,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      reasoningEfforts: (m as any).reasoningEfforts,
      input: m.input || (m as any).input_modalities || ['text'],
      thinkingLevel: m.thinkingLevel,
      defaultThinkingLevel: m.defaultThinkingLevel,
    }));

  const savedModels = savedConfig?.models || [];
  const existingMap = new Map(savedModels.map((m) => [m.id, m]));
  const mergedModels: CustomModelDefinition[] = [];

  for (const cat of catalogDefs) {
    const saved = existingMap.get(cat.id);
    if (saved) {
      mergedModels.push({
        ...cat,
        ...saved,
      });
      existingMap.delete(cat.id);
    } else {
      mergedModels.push(cat);
    }
  }
  for (const extra of existingMap.values()) {
    mergedModels.push(extra);
  }

  const knownModels = new Map<string, CustomModelDefinition>();
  for (const cat of catalogDefs) knownModels.set(cat.id, cat);
  for (const saved of savedModels) knownModels.set(saved.id, saved);
  for (const m of mergedModels) knownModels.set(m.id, m);

  const excludedModels = savedConfig?.excludedModels ? [...savedConfig.excludedModels] : [];
  const includedModels = savedConfig?.includedModels ? [...savedConfig.includedModels] : [];
  const policy = { includedModels, excludedModels };

  // Main models draft list must only show models allowed by policy
  const allowedModels = mergedModels.filter((m) => isModelAllowed(m.id, policy));

  const formData: ProviderFormData = {
    id: providerId,
    name: provider.name || providerId,
    baseUrl: '',
    api: '',
    apiKey: '',
    models: allowedModels,
    excludedModels,
    includedModels,
    isBuiltin: true,
  };

  return { formData, knownModels };
}

/**
 * Builds the initial draft form state and known catalog models for editing a custom provider.
 * Excludes any models that match the provider's excludedModels policy from the initial models list.
 */
export function buildInitialCustomProviderDraft(
  provider: CustomProviderConfig
): {
  formData: ProviderFormData;
  knownModels: Map<string, CustomModelDefinition>;
} {
  const excludedModels = provider.excludedModels ? [...provider.excludedModels] : [];
  const includedModels = provider.includedModels ? [...provider.includedModels] : [];
  const policy = { includedModels, excludedModels };

  const knownModels = new Map<string, CustomModelDefinition>();
  for (const m of provider.models || []) knownModels.set(m.id, m);

  // Main models draft list must only show models allowed by policy
  const allowedModels = (provider.models || []).filter((m) => isModelAllowed(m.id, policy));

  const formData: ProviderFormData = {
    id: provider.id,
    name: provider.name || '',
    baseUrl: provider.baseUrl || '',
    api: provider.api || '',
    apiKey: provider.apiKey || '',
    models: allowedModels,
    excludedModels,
    includedModels,
    isBuiltin: false,
  };

  return { formData, knownModels };
}

export function useProviderModalForm({
  t,
  modelThinkingLevels,
  updateModelThinkingLevelsMap,
  saveProvider,
}: UseProviderModalFormOptions) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<ProviderFormData>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const [isFetchingModelsInModal, setIsFetchingModelsInModal] = useState(false);
  const [isAutoDiscovering, setIsAutoDiscovering] = useState(false);
  const [autoDiscoveryNotice, setAutoDiscoveryNotice] = useState<string | null>(null);
  const [autoDiscoveredEndpoint, setAutoDiscoveredEndpoint] = useState<string | null>(null);

  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelContext, setNewModelContext] = useState('');
  const [newModelMaxTokens, setNewModelMaxTokens] = useState('');
  const [newModelReasoning, setNewModelReasoning] = useState(false);
  const [newModelThinkingLevel, setNewModelThinkingLevel] = useState<ThinkingLevel>('medium');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [newExcludedInput, setNewExcludedInput] = useState('');
  const [newIncludedInput, setNewIncludedInput] = useState('');
  const knownCatalogModelsRef = useRef<Map<string, CustomModelDefinition>>(new Map());

  const [isAddModelOpen, setIsAddModelOpen] = useState(false);
  const [isExcludedOpen, setIsExcludedOpen] = useState(false);
  const [isIncludedOpen, setIsIncludedOpen] = useState(false);
  const excludedSectionRef = useRef<HTMLDivElement>(null);
  const includedSectionRef = useRef<HTMLDivElement>(null);

  const activeEditingModel = editingModelId ? formData.models.find((m) => m.id === editingModelId) : undefined;
  const supportedThinkingLevels = useMemo(() => getSupportedThinkingLevelsForModel(activeEditingModel), [activeEditingModel]);

  useEffect(() => {
    if (newModelReasoning && supportedThinkingLevels.length > 0) {
      if (!supportedThinkingLevels.includes(newModelThinkingLevel)) {
        setNewModelThinkingLevel((prev) => clampThinkingLevelToSupported(prev, supportedThinkingLevels));
      }
    }
  }, [newModelReasoning, supportedThinkingLevels, newModelThinkingLevel]);

  useEffect(() => {
    if (isExcludedOpen && excludedSectionRef.current) {
      requestAnimationFrame(() => {
        excludedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  }, [isExcludedOpen]);

  useEffect(() => {
    if (isIncludedOpen && includedSectionRef.current) {
      requestAnimationFrame(() => {
        includedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  }, [isIncludedOpen]);

  const resetNewModelInputs = () => {
    setNewModelId(''); setNewModelName(''); setNewModelContext('');
    setNewModelMaxTokens(''); setNewModelReasoning(false);
    setNewModelThinkingLevel('medium'); setNewModelSupportsImage(false);
    setModelError(null);
  };

  const resetModalState = () => {
    setEditingModelId(null); setIsAddModelOpen(false); setIsExcludedOpen(false);
    setIsIncludedOpen(false);
    setNewExcludedInput(''); setNewIncludedInput(''); setFormError(null); setAutoDiscoveryNotice(null);
    resetNewModelInputs();
  };

  const populateModelInputs = (providerId: string, m: CustomModelDefinition) => {
    setEditingModelId(m.id); setNewModelId(m.id); setNewModelName(m.name || '');
    setNewModelContext(m.contextWindow ? String(m.contextWindow) : '');
    setNewModelMaxTokens(m.maxTokens ? String(m.maxTokens) : '');
    setNewModelReasoning(Boolean(m.reasoning));
    const activeLevel =
      modelThinkingLevels[`${providerId}/${m.id}`] ||
      m.thinkingLevel ||
      m.defaultThinkingLevel ||
      'medium';
    setNewModelThinkingLevel(clampThinkingLevelToSupported(activeLevel, getSupportedThinkingLevelsForModel(m)));
    setNewModelSupportsImage(Boolean(m.input?.includes('image')));
  };

  const openAddModal = () => {
    knownCatalogModelsRef.current.clear();
    setFormData(EMPTY_FORM); setIsEditing(false); setShowApiKey(false);
    setAutoDiscoveredEndpoint(null); resetModalState(); setIsModalOpen(true);
  };

  const openEditBuiltinModal = (
    provider: { id: string; name?: string },
    catalogModels: (ModelInfo | CustomModelDefinition)[] = [],
    savedConfig?: CustomProviderConfig
  ) => {
    const { formData: initialForm, knownModels } = buildInitialBuiltinProviderDraft(
      provider,
      catalogModels,
      savedConfig
    );
    knownCatalogModelsRef.current = knownModels;
    setFormData(initialForm);
    setIsEditing(true);
    setShowApiKey(false);
    setAutoDiscoveredEndpoint(null);
    resetModalState();
    setIsModalOpen(true);
  };

  const openEditModal = (provider: CustomProviderConfig, initialEditModelId?: string) => {
    if (provider.isBuiltin) {
      openEditBuiltinModal(provider, provider.models || [], provider);
      return;
    }
    const { formData: initialForm, knownModels } = buildInitialCustomProviderDraft(provider);
    knownCatalogModelsRef.current = knownModels;

    setFormData(initialForm);
    setIsEditing(true); setShowApiKey(false);
    setAutoDiscoveredEndpoint(`${provider.baseUrl || ''}::${provider.api || ''}::${provider.apiKey || ''}`);
    resetModalState();

    if (initialEditModelId) {
      const targetModel = initialForm.models.find((m) => m.id === initialEditModelId);
      if (targetModel) populateModelInputs(provider.id, targetModel);
      setIsAddModelOpen(true);
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false); resetModalState();
  };

  useEffect(() => {
    if (!isModalOpen || isEditing || formData.isBuiltin) return;
    const trimmedUrl = formData.baseUrl.trim();
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) return;
    try {
      new URL(trimmedUrl);
    } catch {
      return;
    }

    const isLocal = ['localhost', '127.0.0.1', ':11434', ':1234', ':8000', ':8080'].some((h) => trimmedUrl.includes(h));
    const hasKey = formData.apiKey.trim().length > 0;
    if (!isLocal && !hasKey) return;

    const endpointKey = `${trimmedUrl}::${formData.api}::${formData.apiKey.trim()}`;
    if (autoDiscoveredEndpoint === endpointKey) return;

    const timer = setTimeout(async () => {
      setIsAutoDiscovering(true);
      setAutoDiscoveryNotice(null);
      try {
        const fetched = await fetchProviderModels(trimmedUrl, formData.api, formData.apiKey);
        const allowed = fetched.filter((m) =>
          isModelAllowed(m.id, {
            includedModels: formData.includedModels,
            excludedModels: formData.excludedModels,
          })
        );
        if (allowed.length > 0) {
          setFormData((prev) => ({ ...prev, models: allowed }));
          setAutoDiscoveredEndpoint(endpointKey);
          setAutoDiscoveryNotice(t('providers.auto_discovered_notice', { count: allowed.length }));
        }
      } catch {
        // Quiet background auto-discovery
      } finally {
        setIsAutoDiscovering(false);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [isModalOpen, isEditing, formData.baseUrl, formData.api, formData.apiKey, formData.excludedModels, formData.includedModels, autoDiscoveredEndpoint, t]);

  const handleFetchModelsInModal = async () => {
    if (formData.isBuiltin) {
      setIsFetchingModelsInModal(true);
      setModelError(null);
      setAutoDiscoveryNotice(null);

      try {
        const providerCatalog = await getBuiltinProviderCatalogPi(formData.id);
        const catalogDefs: CustomModelDefinition[] = providerCatalog
          .filter((m) => typeof m.id === 'string' && m.id.trim() !== '')
          .map((m) => ({
            id: (m.id || '').trim(),
            name: m.name || m.id,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: m.reasoning,
            reasoningEfforts: m.reasoningEfforts,
            input: m.input || m.input_modalities || ['text'],
          }));

        const excludedList = formData.excludedModels || [];
        const includedList = formData.includedModels || [];
        const allowedFetched = catalogDefs.filter((m) =>
          isModelAllowed(m.id, {
            includedModels: includedList,
            excludedModels: excludedList,
          })
        );

        for (const cat of catalogDefs) knownCatalogModelsRef.current.set(cat.id, cat);
        setFormData((prev) => ({
          ...prev,
          models:
            prev.models.length === 0
              ? allowedFetched
              : mergeDiscoveredModels(prev.models, allowedFetched, excludedList, includedList),
        }));

        setAutoDiscoveryNotice(t('providers.models_discovered', { count: allowedFetched.length }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setModelError(t('providers.fetch_models_error', { error: msg }));
      } finally {
        setIsFetchingModelsInModal(false);
      }
      return;
    }

    const trimmedUrl = formData.baseUrl.trim();
    const urlValidation = validateBaseUrl(trimmedUrl);
    if (!urlValidation.valid) {
      setModelError(urlValidation.error || t('providers.field_base_url_subtext'));
      return;
    }

    setIsFetchingModelsInModal(true);
    setModelError(null);
    setAutoDiscoveryNotice(null);

    try {
      const fetched = await fetchProviderModels(trimmedUrl, formData.api, formData.apiKey);
      const excludedList = formData.excludedModels || [];
      const includedList = formData.includedModels || [];
      const allowedFetched = fetched.filter((m) =>
        isModelAllowed(m.id, {
          includedModels: includedList,
          excludedModels: excludedList,
        })
      );

      for (const m of allowedFetched) knownCatalogModelsRef.current.set(m.id, m);
      setFormData((prev) => ({
        ...prev,
        models: prev.models.length === 0
          ? allowedFetched
          : mergeDiscoveredModels(prev.models, allowedFetched, excludedList, includedList),
      }));

      setAutoDiscoveryNotice(t('providers.models_discovered', { count: allowedFetched.length }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setModelError(t('providers.fetch_models_error', { error: msg }));
    } finally {
      setIsFetchingModelsInModal(false);
    }
  };

  const handleModelIdChange = (val: string) => {
    setNewModelId(val);
    if (!editingModelId) {
      const lower = val.toLowerCase();
      if (['thinking', 'o1', 'o3', 'gpt-5', 'gpt-6-astra', 'astra', 'r1', 'reason'].some((k) => lower.includes(k))) {
        setNewModelReasoning(true);
        setNewModelThinkingLevel('medium');
      }
      if (['vision', 'image', 'gemini', 'claude', 'gpt', 'vl'].some((k) => lower.includes(k))) {
        setNewModelSupportsImage(true);
      }
    }
  };

  const handleStartEditModel = (m: CustomModelDefinition) => {
    populateModelInputs(formData.id, m);
    setModelError(null);
    setIsAddModelOpen(true);
  };

  const handleCancelEditModel = () => {
    setEditingModelId(null);
    setIsAddModelOpen(false);
    resetNewModelInputs();
  };

  const handleSaveEditedModel = (e: React.FormEvent) => {
    e.preventDefault();
    setModelError(null);
    const trimmedId = newModelId.trim();
    if (!trimmedId) {
      setModelError(t('providers.model_id_required'));
      return;
    }
    if (trimmedId !== editingModelId && formData.models.some((m) => m.id === trimmedId)) {
      setModelError(t('providers.model_id_duplicate'));
      return;
    }

    const existingModel = formData.models.find((m) => m.id === editingModelId);
    const updatedModel = buildDraftModel(
      trimmedId,
      newModelName,
      newModelContext,
      newModelMaxTokens,
      newModelReasoning,
      newModelSupportsImage,
      newModelThinkingLevel,
      existingModel
    );

    const valResult = validateModelDefinition(updatedModel);
    if (!valResult.valid) {
      setModelError(valResult.error || 'Invalid model definition');
      return;
    }

    knownCatalogModelsRef.current.set(trimmedId, updatedModel);
    setFormData((prev) => ({
      ...prev,
      models: prev.models.map((m) => (m.id === editingModelId ? updatedModel : m)),
    }));

    const key = `${formData.id}/${trimmedId}`;
    const levelUpdate: Record<string, ThinkingLevel | null> = {
      [key]: newModelReasoning ? newModelThinkingLevel : null,
    };
    if (editingModelId && editingModelId !== trimmedId) {
      levelUpdate[`${formData.id}/${editingModelId}`] = null;
    }
    updateModelThinkingLevelsMap(levelUpdate);
    handleCancelEditModel();
  };

  const handleExcludeModel = (modelId: string) => {
    const trimmedId = modelId.trim();
    const modelToExclude = formData.models.find((m) => m.id === trimmedId);
    if (modelToExclude) {
      knownCatalogModelsRef.current.set(trimmedId, modelToExclude);
    }
    setFormData((prev) => removeModelFromDraft(prev, trimmedId));

    if (editingModelId === trimmedId) {
      handleCancelEditModel();
    }

    updateModelThinkingLevelsMap({ [`${formData.id}/${trimmedId}`]: null });
    setAutoDiscoveryNotice(t('providers.model_excluded_notice', { id: trimmedId }));
  };

  const handleRemoveExcludedModel = (patternToRemove: string) => {
    setFormData((prev) =>
      restoreExcludedModelToDraft(prev, patternToRemove, knownCatalogModelsRef.current)
    );
  };

  const handleRemoveIncludedModel = (patternToRemove: string) => {
    setFormData((prev) => {
      const nextIncluded = prev.includedModels.filter((p) => p !== patternToRemove);
      return {
        ...prev,
        includedModels: nextIncluded,
        models: prev.models.filter((m) =>
          isModelAllowed(m.id, {
            includedModels: nextIncluded,
            excludedModels: prev.excludedModels,
          })
        ),
      };
    });
  };

  const handleAddIncludedPattern = () => {
    const raw = newIncludedInput.trim();
    if (!raw) return;

    const patterns = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (patterns.length === 0) return;

    setFormData((prev) => {
      const addedPatterns: string[] = [];
      for (const p of patterns) {
        if (!prev.includedModels.includes(p) && !addedPatterns.includes(p)) {
          addedPatterns.push(p);
        }
      }
      if (addedPatterns.length === 0) return prev;

      const nextIncluded = [...prev.includedModels, ...addedPatterns];
      return {
        ...prev,
        models: prev.models.filter((m) =>
          isModelAllowed(m.id, {
            includedModels: nextIncluded,
            excludedModels: prev.excludedModels,
          })
        ),
        includedModels: nextIncluded,
      };
    });
    setNewIncludedInput('');
  };

  const handleAddExcludedPattern = () => {
    const raw = newExcludedInput.trim();
    if (!raw) return;

    const patterns = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (patterns.length === 0) return;

    setFormData((prev) => {
      const addedPatterns: string[] = [];
      for (const p of patterns) {
        if (!prev.excludedModels.includes(p) && !addedPatterns.includes(p)) {
          addedPatterns.push(p);
        }
      }
      if (addedPatterns.length === 0) return prev;

      const nextExcluded = [...prev.excludedModels, ...addedPatterns];
      return {
        ...prev,
        models: prev.models.filter((m) =>
          isModelAllowed(m.id, {
            includedModels: prev.includedModels,
            excludedModels: nextExcluded,
          })
        ),
        excludedModels: nextExcluded,
      };
    });
    setNewExcludedInput('');
  };

  const handleAddModelToDraft = (e: React.FormEvent) => {
    e.preventDefault();
    setModelError(null);
    const trimmedId = newModelId.trim();
    if (!trimmedId) {
      setModelError(t('providers.model_id_required'));
      return;
    }
    if (formData.models.some((m) => m.id === trimmedId)) {
      setModelError(t('providers.model_id_duplicate'));
      return;
    }

    const newModel = buildDraftModel(
      trimmedId,
      newModelName,
      newModelContext,
      newModelMaxTokens,
      newModelReasoning,
      newModelSupportsImage,
      newModelThinkingLevel
    );

    const valResult = validateModelDefinition(newModel);
    if (!valResult.valid) {
      setModelError(valResult.error || 'Invalid model definition');
      return;
    }

    knownCatalogModelsRef.current.set(newModel.id, newModel);
    setFormData((prev) => ({ ...prev, models: [...prev.models, newModel] }));
    resetNewModelInputs();
  };

  const handleRemoveModelFromDraft = (modelIdToRemove: string) => {
    const trimmedId = modelIdToRemove.trim();
    const modelToRemove = formData.models.find((m) => m.id === trimmedId);
    if (modelToRemove) {
      knownCatalogModelsRef.current.set(trimmedId, modelToRemove);
    }
    setFormData((prev) => removeModelFromDraft(prev, trimmedId));
    if (editingModelId === trimmedId) {
      setEditingModelId(null);
      resetNewModelInputs();
    }
    updateModelThinkingLevelsMap({ [`${formData.id}/${trimmedId}`]: null });
  };

  const handleSaveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      if (await saveProvider(formData, isEditing)) closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    isModalOpen, isEditing, formData, setFormData, formError, setFormError,
    showApiKey, setShowApiKey, isFetchingModelsInModal, isAutoDiscovering,
    autoDiscoveryNotice, editingModelId, newModelId, newModelName, setNewModelName,
    newModelContext, setNewModelContext, newModelMaxTokens, setNewModelMaxTokens,
    newModelReasoning, setNewModelReasoning, newModelThinkingLevel, setNewModelThinkingLevel,
    newModelSupportsImage, setNewModelSupportsImage, modelError, newExcludedInput,
    setNewExcludedInput, newIncludedInput, setNewIncludedInput, isAddModelOpen,
    setIsAddModelOpen, isExcludedOpen, setIsExcludedOpen, isIncludedOpen,
    setIsIncludedOpen, excludedSectionRef, includedSectionRef, supportedThinkingLevels,
    handleModelIdChange, handleStartEditModel, handleCancelEditModel,
    handleSaveEditedModel, handleAddModelToDraft, handleRemoveModelFromDraft,
    handleExcludeModel, handleRemoveExcludedModel, handleAddExcludedPattern,
    handleRemoveIncludedModel, handleAddIncludedPattern,
    handleFetchModelsInModal, handleSaveProvider, openAddModal, openEditModal, openEditBuiltinModal, closeModal,
    handleOpenAddModal: openAddModal, handleOpenEditModal: openEditModal, handleOpenEditBuiltinModal: openEditBuiltinModal, handleCloseModal: closeModal,
  };
}
