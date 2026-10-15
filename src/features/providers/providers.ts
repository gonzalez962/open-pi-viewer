import type { CustomModelDefinition, CustomProviderConfig, CustomProvidersMap, ModelsConfigFile } from '@core/types/providers';
import {
  type ModelInfo,
  type ModelThinkingLevelsMap,
  type ThinkingLevel,
  EXTENDED_THINKING_LEVELS,
  DEFAULT_REASONING_LEVELS,
  getSupportedReasoningEffortsForModel as coreGetSupportedReasoningEffortsForModel,
  clampThinkingLevelToSupported,
  resolveModelDefaultThinkingLevel,
} from '@core/types/models';

export {
  EXTENDED_THINKING_LEVELS,
  DEFAULT_REASONING_LEVELS,
  clampThinkingLevelToSupported,
  resolveModelDefaultThinkingLevel,
};

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = EXTENDED_THINKING_LEVELS;

/**
 * Extract bare model ID without any provider prefix (e.g. 'anthropic/claude-3.5-sonnet' -> 'claude-3.5-sonnet').
 * Strips any leading 'models/' and any 'provider/' namespace prefix.
 */
export function extractModelBaseId(id: string): string {
  if (!id || typeof id !== 'string') return '';
  let clean = id.trim();
  if (clean.startsWith('models/')) {
    clean = clean.slice(7);
  }
  const slashIdx = clean.lastIndexOf('/');
  if (slashIdx !== -1) {
    clean = clean.slice(slashIdx + 1);
  }
  return clean;
}

/**
 * Determine supported reasoning effort / thinking levels for a model definition or ModelInfo.
 * Aligned with core getSupportedReasoningEffortsForModel.
 */
export function getSupportedReasoningEffortsForModel(
  model: CustomModelDefinition | ModelInfo | null | undefined
): ThinkingLevel[] {
  return coreGetSupportedReasoningEffortsForModel(model as ModelInfo);
}

export const getSupportedThinkingLevelsForModel = getSupportedReasoningEffortsForModel;



/**
 * Outcome of switching the active model: the merged model record plus whether it supports
 * reasoning and, if so, the thinking level it should default to.
 */
export type ModelSelectionOutcome =
  | { fullModel: ModelInfo; supportsReasoning: true; defaultThinkingLevel: ThinkingLevel }
  | { fullModel: ModelInfo; supportsReasoning: false; defaultThinkingLevel: null };

/**
 * Decision logic for `handleSelectModel`: merges the model record known from the
 * available-models list (`matched`) with the fresh record returned by the backend
 * (`updatedModel`), then decides whether the resulting model supports reasoning and, if it
 * does, what thinking level it should default to.
 *
 * A model "supports reasoning" when either its own `reasoning` flag is set, or the backend
 * reports available thinking levels that are not just `['off']`.
 */
export function resolveModelSelectionOutcome(
  matched: ModelInfo | undefined,
  updatedModel: ModelInfo | undefined,
  modelId: string,
  provider: string,
  availableThinkingLevels: ThinkingLevel[] | undefined,
  modelThinkingLevels: ModelThinkingLevelsMap
): ModelSelectionOutcome {
  const fullModel: ModelInfo = {
    ...matched,
    ...updatedModel,
    id: modelId,
    provider,
    contextWindow: updatedModel?.contextWindow ?? matched?.contextWindow,
    input_modalities: matched?.input_modalities ?? updatedModel?.input_modalities,
  } as ModelInfo;

  const supportsReasoning = Boolean(
    fullModel.reasoning ||
      (availableThinkingLevels &&
        availableThinkingLevels.length > 0 &&
        !(availableThinkingLevels.length === 1 && availableThinkingLevels[0] === 'off'))
  );

  if (!supportsReasoning) {
    return { fullModel, supportsReasoning: false, defaultThinkingLevel: null };
  }

  const defaultThinkingLevel = resolveModelDefaultThinkingLevel(
    fullModel,
    modelThinkingLevels,
    availableThinkingLevels
  );

  return { fullModel, supportsReasoning: true, defaultThinkingLevel };
}

export const SUPPORTED_API_PROTOCOLS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions (openai-completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses API (openai-responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages API (anthropic-messages)' },
  { value: 'google-generative-ai', label: 'Google Generative AI (google-generative-ai)' },
] as const;

export type SupportedApiProtocol = typeof SUPPORTED_API_PROTOCOLS[number]['value'];

/**
 * Validate provider identifier slug.
 * Must be non-empty and contain only letters, digits, '-', '_', '.', or '/'.
 */
export function validateProviderId(id: string): { valid: boolean; error?: string } {
  const trimmed = id.trim();
  if (!trimmed) {
    return { valid: false, error: 'Provider ID cannot be empty' };
  }
  if (!/^[a-zA-Z0-9_\-./]+$/.test(trimmed)) {
    return {
      valid: false,
      error: `Provider ID '${trimmed}' contains invalid characters. Use letters, digits, '-', '_', '.', or '/'`,
    };
  }
  return { valid: true };
}

/**
 * Validate Base URL for provider endpoint.
 * Must be a non-empty string starting with http:// or https://.
 */
export function validateBaseUrl(url: string): { valid: boolean; error?: string } {
  const trimmed = url.trim();
  if (!trimmed) {
    return { valid: false, error: 'Base URL cannot be empty' };
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return { valid: false, error: "Base URL must start with 'http://' or 'https://'" };
  }
  try {
    new URL(trimmed);
  } catch {
    return { valid: false, error: `Base URL '${trimmed}' is not a valid URL` };
  }
  return { valid: true };
}

/**
 * Validate model definition.
 * ID is required and non-empty.
 */
export function validateModelDefinition(model: CustomModelDefinition): { valid: boolean; error?: string } {
  if (!model || typeof model !== 'object') {
    return { valid: false, error: 'Model definition must be an object' };
  }
  const id = model.id?.trim();
  if (!id) {
    return { valid: false, error: 'Model ID cannot be empty' };
  }
  if (model.contextWindow !== undefined) {
    if (typeof model.contextWindow !== 'number' || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      return { valid: false, error: 'Context window must be a positive number' };
    }
  }
  if (model.maxTokens !== undefined) {
    if (typeof model.maxTokens !== 'number' || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
      return { valid: false, error: 'Max tokens must be a positive number' };
    }
  }
  if (model.thinkingLevel !== undefined) {
    if (!VALID_THINKING_LEVELS.includes(model.thinkingLevel)) {
      return {
        valid: false,
        error: `Invalid thinkingLevel: must be one of ${VALID_THINKING_LEVELS.map((l) => `'${l}'`).join(' | ')}`,
      };
    }
  }
  if (model.defaultThinkingLevel !== undefined) {
    if (!VALID_THINKING_LEVELS.includes(model.defaultThinkingLevel)) {
      return {
        valid: false,
        error: `Invalid defaultThinkingLevel: must be one of ${VALID_THINKING_LEVELS.map((l) => `'${l}'`).join(' | ')}`,
      };
    }
  }
  return { valid: true };
}

/**
 * Validate full provider configuration before saving.
 */
export function validateProviderConfig(provider: CustomProviderConfig): { valid: boolean; error?: string } {
  if (!provider || typeof provider !== 'object') {
    return { valid: false, error: 'Provider configuration must be an object' };
  }

  const idCheck = validateProviderId(provider.id);
  if (!idCheck.valid) {
    return idCheck;
  }

  const hasModels = Array.isArray(provider.models) && provider.models.length > 0;
  const hasIncluded = Array.isArray(provider.includedModels) && provider.includedModels.length > 0;
  const hasExcluded = Array.isArray(provider.excludedModels) && provider.excludedModels.length > 0;
  const isOverrideOnly = Boolean(
    provider.isBuiltin ||
      ((hasModels || hasIncluded || hasExcluded) && !provider.baseUrl && !provider.api)
  );

  if (!isOverrideOnly) {
    const urlCheck = validateBaseUrl(provider.baseUrl || '');
    if (!urlCheck.valid) {
      return urlCheck;
    }

    const api = provider.api?.trim();
    if (!api) {
      return { valid: false, error: "API protocol type ('api') is required" };
    }
  } else if (provider.baseUrl && provider.baseUrl.trim()) {
    const urlCheck = validateBaseUrl(provider.baseUrl);
    if (!urlCheck.valid) {
      return urlCheck;
    }
  }

  if (provider.models !== undefined && !Array.isArray(provider.models)) {
    return { valid: false, error: 'Provider models must be an array' };
  }

  const modelsList = Array.isArray(provider.models) ? provider.models : [];
  if (!isOverrideOnly && modelsList.length === 0) {
    return { valid: false, error: 'At least one model must be configured for this provider' };
  }
  if (isOverrideOnly && modelsList.length === 0 && !hasIncluded && !hasExcluded) {
    return {
      valid: false,
      error: 'At least one model or model pattern rule must be configured for this provider',
    };
  }

  for (let i = 0; i < modelsList.length; i++) {
    const modelCheck = validateModelDefinition(modelsList[i]);
    if (!modelCheck.valid) {
      return {
        valid: false,
        error: `Model #${i + 1} (${modelsList[i]?.id || 'unnamed'}): ${modelCheck.error}`,
      };
    }
  }

  if (provider.includedModels !== undefined) {
    if (!Array.isArray(provider.includedModels)) {
      return { valid: false, error: 'Provider includedModels must be an array of strings' };
    }
    for (let i = 0; i < provider.includedModels.length; i++) {
      if (typeof provider.includedModels[i] !== 'string') {
        return { valid: false, error: `Included model #${i + 1} must be a string` };
      }
    }
  }

  if (provider.excludedModels !== undefined) {
    if (!Array.isArray(provider.excludedModels)) {
      return { valid: false, error: 'Provider excludedModels must be an array of strings' };
    }
    for (let i = 0; i < provider.excludedModels.length; i++) {
      if (typeof provider.excludedModels[i] !== 'string') {
        return { valid: false, error: `Excluded model #${i + 1} must be a string` };
      }
    }
  }

  return { valid: true };
}

/**
 * Convert `CustomProvidersMap` from `models.json` into an array of `CustomProviderConfig` with IDs included.
 */
export function mapProvidersToArray(providersMap: CustomProvidersMap = {}): CustomProviderConfig[] {
  if (!providersMap || typeof providersMap !== 'object') {
    return [];
  }

  return Object.entries(providersMap).map(([id, config]) => {
    const raw = config as Record<string, unknown>;
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      api: typeof raw.api === 'string' ? raw.api : 'openai-completions',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
      authHeader: typeof raw.authHeader === 'boolean' ? raw.authHeader : undefined,
      headers: raw.headers && typeof raw.headers === 'object' ? (raw.headers as Record<string, string>) : undefined,
      models: Array.isArray(raw.models)
        ? (raw.models as Record<string, unknown>[]).map((rawM) => ({
            ...(rawM as unknown as CustomModelDefinition),
            thinkingLevel:
              typeof rawM.thinkingLevel === 'string' ? (rawM.thinkingLevel as ThinkingLevel) : undefined,
            defaultThinkingLevel:
              typeof rawM.defaultThinkingLevel === 'string'
                ? (rawM.defaultThinkingLevel as ThinkingLevel)
                : undefined,
          }))
        : [],
      excludedModels: Array.isArray(raw.excludedModels)
        ? (raw.excludedModels as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      includedModels: Array.isArray(raw.includedModels)
        ? (raw.includedModels as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    };
  });
}

/**
 * Convert an array of `CustomProviderConfig` back to `CustomProvidersMap` for saving to `models.json`.
 */
export function arrayToProvidersMap(providers: CustomProviderConfig[]): CustomProvidersMap {
  const map: CustomProvidersMap = {};
  for (const p of providers) {
    const { id, name, baseUrl, api, apiKey, authHeader, headers, models, excludedModels, includedModels, ...extra } = p;
    const entry: Omit<CustomProviderConfig, 'id'> = {
      ...(baseUrl ? { baseUrl: baseUrl.trim() } : {}),
      ...(api ? { api: api.trim() } : {}),
      models: (models || []).map((m) => {
        const modelEntry: CustomModelDefinition = {
          id: m.id.trim(),
        };
        if (m.name !== undefined && m.name.trim() !== '') modelEntry.name = m.name.trim();
        if (m.contextWindow !== undefined) modelEntry.contextWindow = m.contextWindow;
        if (m.maxTokens !== undefined) modelEntry.maxTokens = m.maxTokens;
        if (m.reasoning !== undefined) modelEntry.reasoning = m.reasoning;
        if (m.input !== undefined) modelEntry.input = m.input;
        if (m.input_modalities !== undefined) modelEntry.input_modalities = m.input_modalities;
        if (m.cost !== undefined) modelEntry.cost = m.cost;
        if (m.compat !== undefined) modelEntry.compat = m.compat;
        if (m.thinkingLevelMap !== undefined) modelEntry.thinkingLevelMap = m.thinkingLevelMap;
        if (m.reasoningEfforts !== undefined) modelEntry.reasoningEfforts = m.reasoningEfforts;
        if (m.thinkingLevel !== undefined) modelEntry.thinkingLevel = m.thinkingLevel;
        if (m.defaultThinkingLevel !== undefined) modelEntry.defaultThinkingLevel = m.defaultThinkingLevel;
        return modelEntry;
      }),
      ...extra,
    };

    if (name !== undefined && name.trim() !== '') entry.name = name.trim();
    if (apiKey !== undefined && apiKey.trim() !== '') entry.apiKey = apiKey.trim();
    if (authHeader !== undefined) entry.authHeader = authHeader;
    if (headers !== undefined) entry.headers = headers;
    if (includedModels && Array.isArray(includedModels) && includedModels.length > 0) {
      entry.includedModels = includedModels
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (excludedModels && Array.isArray(excludedModels) && excludedModels.length > 0) {
      entry.excludedModels = excludedModels
        .map((s) => s.trim())
        .filter(Boolean);
    }

    map[id.trim()] = entry;
  }
  return map;
}

/**
 * Additively merge a single custom provider into a ModelsConfigFile,
 * preserving existing root keys, unrelated providers, unknown fields on the provider,
 * and unknown fields on existing models by merging keyed on model id.
 */
export function mergeCustomProviderAdditive(
  existingConfig: ModelsConfigFile,
  provider: CustomProviderConfig
): ModelsConfigFile {
  const root = { ...existingConfig };
  const existingProviders =
    root.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};

  const existingProvider =
    existingProviders[provider.id] && typeof existingProviders[provider.id] === 'object'
      ? { ...(existingProviders[provider.id] as Record<string, unknown>) }
      : {};

  const { id, models, ...incomingProps } = provider;

  const mergedProvider: Record<string, unknown> = {
    ...existingProvider,
    ...incomingProps,
  };

  if (models && Array.isArray(models)) {
    const existingModels = Array.isArray(existingProvider.models)
      ? (existingProvider.models as Record<string, unknown>[])
      : [];

    const incomingIds = new Set(models.map((m) => m.id));
    const mergedModels: CustomModelDefinition[] = models.map((incM) => {
      const existingM = existingModels.find(
        (m) => m && (m as { id?: unknown }).id === incM.id
      );
      if (existingM) {
        return {
          ...existingM,
          ...incM,
        } as CustomModelDefinition;
      }
      return { ...incM };
    });

    for (const extM of existingModels) {
      const extId =
        extM && typeof (extM as { id?: unknown }).id === 'string'
          ? (extM as { id: string }).id
          : undefined;
      if (extId && !incomingIds.has(extId)) {
        mergedModels.push({ ...extM, id: extId } as CustomModelDefinition);
      }
    }

    mergedProvider.models = mergedModels;
  }

  existingProviders[id] = mergedProvider;
  root.providers = existingProviders as CustomProvidersMap;
  return root;
}

/**
 * Remove a single custom provider from a ModelsConfigFile,
 * preserving existing root keys and unrelated providers.
 */
export function removeCustomProviderFromConfig(
  existingConfig: ModelsConfigFile,
  providerId: string
): ModelsConfigFile {
  const root = { ...existingConfig };
  const existingProviders =
    root.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};

  delete existingProviders[providerId];
  root.providers = existingProviders as CustomProvidersMap;
  return root;
}

function matchSinglePattern(targetId: string, rawPattern: string): boolean {
  const pattern = rawPattern.trim();
  if (!pattern) return false;

  // 1. Delimited regex: /pattern/flags
  const slashMatch = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (slashMatch) {
    try {
      const flags = slashMatch[2] ? slashMatch[2] : 'i';
      const regex = new RegExp(slashMatch[1], flags);
      return regex.test(targetId);
    } catch {
      // Ignore invalid regex and continue
    }
  }

  // 2. Unslashed regex: explicit anchors or alternations
  if (/[\^$|()]/.test(pattern) && !pattern.startsWith('*') && !pattern.endsWith('*')) {
    try {
      const regex = new RegExp(pattern, 'i');
      return regex.test(targetId);
    } catch {
      // Ignore invalid regex and continue
    }
  }

  // 3. Case-insensitive wildcard or exact comparison
  const cleanPattern = pattern.toLowerCase();
  const lowerId = targetId.toLowerCase();

  if (cleanPattern === lowerId) return true;

  if (cleanPattern.startsWith('*') && !cleanPattern.slice(1).includes('*')) {
    return lowerId.endsWith(cleanPattern.slice(1));
  }
  if (cleanPattern.endsWith('*') && !cleanPattern.slice(0, -1).includes('*')) {
    return lowerId.startsWith(cleanPattern.slice(0, -1));
  }
  if (cleanPattern.includes('*')) {
    const escaped = cleanPattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    try {
      return new RegExp(`^${escaped}$`, 'i').test(lowerId);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Checks if a model ID matches any excluded model rule (exact match, wildcard, or regex pattern).
 */
export function isModelExcluded(modelId: string, excludedList?: string[]): boolean {
  if (!modelId || !Array.isArray(excludedList) || excludedList.length === 0) {
    return false;
  }
  const cleanId = modelId.trim();
  if (!cleanId) return false;
  const baseId = extractModelBaseId(cleanId);

  return excludedList.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    return (
      matchSinglePattern(cleanId, pattern) ||
      (baseId && baseId !== cleanId && matchSinglePattern(baseId, pattern))
    );
  });
}

/**
 * Checks if a model ID matches any included model rule (exact match, wildcard, or regex pattern).
 */
export function isModelIncluded(modelId: string, includedList?: string[]): boolean {
  if (!modelId || !Array.isArray(includedList) || includedList.length === 0) {
    return false;
  }
  const cleanId = modelId.trim();
  if (!cleanId) return false;
  const baseId = extractModelBaseId(cleanId);

  return includedList.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    return (
      matchSinglePattern(cleanId, pattern) ||
      (baseId && baseId !== cleanId && matchSinglePattern(baseId, pattern))
    );
  });
}

/**
 * Checks if a model ID is allowed by provider policy.
 * Included models filter (if non-empty) takes absolute precedence over excluded models.
 */
export function isModelAllowed(
  modelId: string,
  policy?: { includedModels?: string[]; excludedModels?: string[] }
): boolean {
  if (!modelId) return false;
  if (!policy) return true;

  if (Array.isArray(policy.includedModels) && policy.includedModels.length > 0) {
    return isModelIncluded(modelId, policy.includedModels);
  }

  if (Array.isArray(policy.excludedModels) && policy.excludedModels.length > 0) {
    return !isModelExcluded(modelId, policy.excludedModels);
  }

  return true;
}

/**
 * Filters out models that match excluded patterns or are not permitted by included patterns
 * defined for their respective provider.
 */
export function filterExcludedModels(
  models: ModelInfo[],
  providersMap?: CustomProvidersMap | CustomProviderConfig[]
): ModelInfo[] {
  if (!models || models.length === 0) return [];
  if (!providersMap) return models;

  const providers = Array.isArray(providersMap)
    ? providersMap
    : mapProvidersToArray(providersMap);

  const policyMap = new Map<string, { includedModels?: string[]; excludedModels?: string[] }>();
  for (const p of providers) {
    const hasIncluded = Array.isArray(p.includedModels) && p.includedModels.length > 0;
    const hasExcluded = Array.isArray(p.excludedModels) && p.excludedModels.length > 0;
    if (hasIncluded || hasExcluded) {
      policyMap.set(p.id.toLowerCase(), {
        includedModels: p.includedModels,
        excludedModels: p.excludedModels,
      });
    }
  }

  if (policyMap.size === 0) return models;

  return models.filter((m) => {
    if (!m.id) return true;
    const providerKey = (m.provider || '').toLowerCase();
    const policy = policyMap.get(providerKey);
    if (!policy) return true;
    return isModelAllowed(m.id, policy);
  });
}

/**
 * Strip thinking level suffix from an enabledModels pattern (e.g. 'anthropic/*:high' -> 'anthropic/*').
 */
export function stripThinkingLevelFromPattern(rawPattern: string): string {
  const pattern = rawPattern.trim();
  const colonIdx = pattern.lastIndexOf(':');
  if (colonIdx === -1) return pattern;
  const suffix = pattern.substring(colonIdx + 1).toLowerCase();
  const knownLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  if (knownLevels.has(suffix)) {
    return pattern.substring(0, colonIdx).trim();
  }
  return pattern;
}

/**
 * Checks if a model matches a single enabledModels pattern following Pi's pattern semantics.
 */
export function matchEnabledModelPattern(
  fullId: string,
  bareId: string,
  modelName: string | undefined,
  pattern: string
): boolean {
  const clean = stripThinkingLevelFromPattern(pattern);
  if (!clean) return false;

  // Wildcard / glob check
  if (clean.includes('*') || clean.includes('?') || clean.includes('[')) {
    return (
      matchSinglePattern(fullId, clean) ||
      matchSinglePattern(bareId, clean)
    );
  }

  // Exact reference check (provider/modelId or bareId)
  const normPattern = clean.toLowerCase();
  const normFull = fullId.toLowerCase();
  const normBare = bareId.toLowerCase();

  if (normPattern === normFull || normPattern === normBare) {
    return true;
  }

  // If pattern has a slash, it's a provider-scoped reference
  if (clean.includes('/')) {
    return normPattern === normFull;
  }

  // Fallback to substring matching on ID or Name (matching Pi's tryMatchModel)
  if (normBare.includes(normPattern) || (modelName && modelName.toLowerCase().includes(normPattern))) {
    return true;
  }

  return false;
}

/**
 * Checks whether a given model is allowed by Pi's enabledModels restrictions.
 * Missing or empty enabledModels preserves unrestricted behavior.
 */
export function isModelAllowedByEnabledModels(
  model: ModelInfo,
  enabledModels?: string[]
): boolean {
  if (!model || !model.id) return false;
  if (!enabledModels || enabledModels.length === 0) return true;

  const fullId = `${model.provider || ''}/${model.id}`;
  const bareId = model.id;
  const name = model.name;

  return enabledModels.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    return matchEnabledModelPattern(fullId, bareId, name, pattern);
  });
}

/**
 * Filters models according to Pi's enabledModels restriction list.
 * Missing or empty enabledModels returns models unchanged.
 */
export function filterByEnabledModels(
  models: ModelInfo[],
  enabledModels?: string[]
): ModelInfo[] {
  if (!models || models.length === 0) return [];
  if (!enabledModels || enabledModels.length === 0) return models;

  return models.filter((m) => isModelAllowedByEnabledModels(m, enabledModels));
}

export interface FetchModelsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export const DEFAULT_MAX_TOKENS = 16_384;
export const MAX_SAFE_OUTPUT_TOKENS = 65_536;

export type CPAModel = {
  slug?: string;
  id?: string;
  display_name?: string;
  owned_by?: string;
  context_window?: number;
  max_tokens?: number;
  input_modalities?: string[];
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
};

export type FallbackOpenAIModel = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  owned_by?: unknown;
  owner?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  capabilities?: {
    reasoning?: unknown;
    thinking?: unknown;
    vision?: unknown;
    image?: unknown;
    images?: unknown;
  };
  reasoning?: unknown;
  input?: unknown;
  modalities?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
    modality?: unknown;
  };
  input_modalities?: unknown;
};

/**
 * Strict thinking level map based on supported reasoning efforts.
 * Maps standard thinking levels to effort strings or null.
 */
export function buildStrictThinkingLevelMap(levels: string[]): Record<string, string | null> {
  if (!levels || levels.length === 0) {
    return {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    };
  }

  const set = new Set(levels.map((lvl) => lvl.toLowerCase()));

  return {
    off: null,
    minimal: set.has('minimal') ? 'minimal' : null,
    low: set.has('low') ? 'low' : null,
    medium: set.has('medium') ? 'medium' : null,
    high: set.has('high') ? 'high' : null,
    xhigh: set.has('xhigh') ? 'xhigh' : null,
    max: set.has('max') ? 'max' : null,
  };
}

/**
 * Resolve recommended context window with per-family bounds.
 * gpt/codex/openai: 272,000; claude: 200,000; gemini: 370,000; default: 128,000.
 */
export function resolveRecommendedContextWindow(modelId: string, reportedContext?: number): number {
  const id = modelId.toLowerCase();
  let recommendedCap = 128_000;

  if (id.includes('gpt') || id.includes('codex') || id.includes('openai') || id.includes('astra')) {
    recommendedCap = 272_000;
  } else if (id.includes('claude')) {
    recommendedCap = 200_000;
  } else if (id.includes('gemini')) {
    recommendedCap = 370_000;
  }

  if (typeof reportedContext === 'number' && Number.isFinite(reportedContext) && reportedContext > 0) {
    return Math.min(Math.floor(reportedContext), recommendedCap);
  }
  return recommendedCap;
}

/**
 * Transform CPA (CLIProxyAPI) model definition to Pi CustomModelDefinition.
 */
export function toPiModelFromCPA(
  model: CPAModel,
  defaultOwner = 'CLIProxyAPI'
): CustomModelDefinition | undefined {
  const rawId = typeof model.slug === 'string' && model.slug.trim()
    ? model.slug.trim()
    : (typeof model.id === 'string' ? model.id.trim() : '');
  if (!rawId) return undefined;

  const id = rawId.startsWith('models/') ? rawId.slice(7) : rawId;
  const lowerId = id.toLowerCase();
  const contextWindow = resolveRecommendedContextWindow(id, model.context_window);
  const maxTokens = Math.min(
    typeof model.max_tokens === 'number' && Number.isFinite(model.max_tokens) && model.max_tokens > 0
      ? Math.floor(model.max_tokens)
      : DEFAULT_MAX_TOKENS,
    MAX_SAFE_OUTPUT_TOKENS
  );

  const levels = (model.supported_reasoning_levels || [])
    .map((lvl) => (typeof lvl?.effort === 'string' ? lvl.effort.trim().toLowerCase() : ''))
    .filter((effort): effort is string => Boolean(effort));

  const isReasoning = levels.length > 0 ||
    Boolean(model.default_reasoning_level) ||
    lowerId.includes('thinking') ||
    lowerId.includes('gpt-6-astra') ||
    lowerId.includes('astra') ||
    (model.display_name?.toLowerCase().includes('thinking') ?? false) ||
    (model.display_name?.toLowerCase().includes('gpt-6-astra') ?? false) ||
    (model.display_name?.toLowerCase().includes('astra') ?? false);

  const reasoningLevels = levels.length > 0
    ? levels
    : (isReasoning ? ['low', 'medium', 'high'] : []);

  const thinkingLevelMap = isReasoning
    ? buildStrictThinkingLevelMap(reasoningLevels)
    : undefined;

  const supportsImages = (model.input_modalities?.includes('image') ?? false) ||
    lowerId.includes('vision') ||
    lowerId.includes('image') ||
    lowerId.includes('gemini') ||
    lowerId.includes('claude') ||
    lowerId.includes('gpt') ||
    lowerId.includes('vl');

  const owner = typeof model.owned_by === 'string' && model.owned_by.trim()
    ? model.owned_by.trim()
    : defaultOwner;
  const displayName = typeof model.display_name === 'string' && model.display_name.trim()
    ? model.display_name.trim()
    : id;

  const name = displayName !== id
    ? `${displayName} (${id})`
    : (owner ? `${id} (${owner})` : undefined);

  const cpaDefaultThinking: ThinkingLevel = (
    typeof model.default_reasoning_level === 'string' &&
    VALID_THINKING_LEVELS.includes(model.default_reasoning_level.trim().toLowerCase() as ThinkingLevel)
      ? (model.default_reasoning_level.trim().toLowerCase() as ThinkingLevel)
      : 'medium'
  );

  return {
    id,
    ...(name ? { name } : {}),
    ...(isReasoning
      ? {
          reasoning: true,
          thinkingLevel: cpaDefaultThinking,
          defaultThinkingLevel: cpaDefaultThinking,
        }
      : {}),
    input: supportsImages ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(reasoningLevels.length > 0 ? { reasoningEfforts: reasoningLevels } : {}),
    ...(Array.isArray(model.input_modalities) && model.input_modalities.length > 0
      ? { input_modalities: model.input_modalities }
      : {}),
  };
}

/**
 * Transform standard OpenAI or fallback model definition to Pi CustomModelDefinition.
 */
export function toPiModelFromOpenAI(
  model: FallbackOpenAIModel,
  defaultOwner?: string
): CustomModelDefinition | undefined {
  const rawId = typeof model.id === 'string' && model.id.trim()
    ? model.id.trim()
    : (typeof model.name === 'string' && model.name.trim() ? model.name.trim() : '');
  if (!rawId) return undefined;

  let id = rawId;
  if (id.startsWith('models/')) {
    id = id.slice(7);
  }

  const capabilities = model.capabilities ?? {};
  const lowerId = id.toLowerCase();

  const reportedContext = typeof model.context_length === 'number'
    ? model.context_length
    : typeof model.context_window === 'number'
      ? model.context_window
      : typeof model.max_input_tokens === 'number'
        ? model.max_input_tokens
        : typeof model.inputTokenLimit === 'number'
          ? model.inputTokenLimit
          : undefined;

  const contextWindow = resolveRecommendedContextWindow(id, reportedContext);

  const reportedMax = typeof model.max_output_tokens === 'number' && model.max_output_tokens > 0
    ? model.max_output_tokens
    : typeof model.outputTokenLimit === 'number' && model.outputTokenLimit > 0
      ? model.outputTokenLimit
      : undefined;

  const maxTokens = Math.min(
    typeof reportedMax === 'number' && Number.isFinite(reportedMax)
      ? Math.floor(reportedMax)
      : DEFAULT_MAX_TOKENS,
    MAX_SAFE_OUTPUT_TOKENS
  );

  const owner = typeof model.owned_by === 'string' && model.owned_by.trim()
    ? model.owned_by.trim()
    : (typeof model.owner === 'string' && model.owner.trim() ? model.owner.trim() : defaultOwner);

  const rawInput = Array.isArray(model.input)
    ? model.input
    : (Array.isArray(model.modalities) ? model.modalities : []);

  const rawModalities = Array.isArray(model.architecture?.input_modalities)
    ? model.architecture!.input_modalities
    : (Array.isArray(model.input_modalities) ? model.input_modalities : undefined);

  const input_modalities = Array.isArray(rawModalities)
    ? rawModalities.filter((m): m is string => typeof m === 'string')
    : undefined;

  const supportsImages = Boolean(
    capabilities.vision ||
    capabilities.image ||
    capabilities.images ||
    rawInput.includes('image') ||
    (input_modalities && input_modalities.includes('image')) ||
    lowerId.includes('image') ||
    lowerId.includes('vision') ||
    lowerId.includes('gemini') ||
    lowerId.includes('claude') ||
    lowerId.includes('gpt') ||
    lowerId.includes('vl')
  );

  const displayNameStr = typeof model.displayName === 'string' && model.displayName.trim()
    ? model.displayName.trim()
    : (typeof model.name === 'string' && model.name.trim() !== id ? model.name.trim() : undefined);

  const isReasoning = Boolean(
    capabilities.reasoning ||
    capabilities.thinking ||
    Boolean(model.reasoning) ||
    lowerId.includes('thinking') ||
    lowerId.includes('high') ||
    lowerId.includes('pro') ||
    lowerId.includes('sol') ||
    lowerId.includes('luna') ||
    lowerId.includes('terra') ||
    lowerId.includes('o1') ||
    lowerId.includes('o3') ||
    lowerId.includes('gpt-5') ||
    lowerId.includes('gpt-6-astra') ||
    lowerId.includes('astra') ||
    lowerId.includes('r1') ||
    lowerId.includes('reason') ||
    (displayNameStr ? (
      displayNameStr.toLowerCase().includes('thinking') ||
      displayNameStr.toLowerCase().includes('gpt-6-astra') ||
      displayNameStr.toLowerCase().includes('astra')
    ) : false)
  );

  const openAiEfforts = isReasoning ? ['low', 'medium', 'high'] : [];
  const thinkingLevelMap = isReasoning ? buildStrictThinkingLevelMap(openAiEfforts) : undefined;

  const name = displayNameStr && displayNameStr !== id
    ? displayNameStr
    : (owner ? `${id} (${owner})` : undefined);

  return {
    id,
    ...(name ? { name } : {}),
    ...(isReasoning
      ? {
          reasoning: true,
          thinkingLevel: 'medium',
          defaultThinkingLevel: 'medium',
        }
      : {}),
    input: supportsImages ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(openAiEfforts.length > 0 ? { reasoningEfforts: openAiEfforts } : {}),
    ...(input_modalities && input_modalities.length > 0 ? { input_modalities } : {}),
  };
}

/**
 * Parse standard OpenAI, Ollama, Anthropic, Google, or CPA model listings into typed CustomModelDefinition[].
 */
export function parseModelsFromApiResponse(
  payload: unknown,
  fallbackOwner?: string
): CustomModelDefinition[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const raw = payload as Record<string, unknown>;
  let list: unknown[] = [];

  if (Array.isArray(raw.data)) {
    list = raw.data;
  } else if (Array.isArray(raw.models)) {
    list = raw.models;
  } else if (Array.isArray(payload)) {
    list = payload as unknown[];
  }

  const result: CustomModelDefinition[] = [];
  const seenIds = new Set<string>();

  for (const item of list) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed || seenIds.has(trimmed)) continue;
      seenIds.add(trimmed);
      const parsed = toPiModelFromOpenAI({ id: trimmed }, fallbackOwner);
      if (parsed) result.push(parsed);
      continue;
    }

    if (!item || typeof item !== 'object') continue;

    const obj = item as Record<string, unknown>;
    const isCpa = 'slug' in obj ||
      'supported_reasoning_levels' in obj ||
      'default_reasoning_level' in obj ||
      'display_name' in obj;

    const parsed = isCpa
      ? toPiModelFromCPA(obj as CPAModel, fallbackOwner)
      : toPiModelFromOpenAI(obj as FallbackOpenAIModel, fallbackOwner);

    if (parsed && !seenIds.has(parsed.id)) {
      seenIds.add(parsed.id);
      result.push(parsed);
    }
  }

  return result;
}

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface OpenRouterModelEntry {
  id: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  [key: string]: unknown;
}

let cachedOpenRouterCatalog: OpenRouterModelEntry[] | null = null;
let cachedOpenRouterPromise: Promise<OpenRouterModelEntry[]> | null = null;

export function clearOpenRouterCatalogCache(): void {
  cachedOpenRouterCatalog = null;
  cachedOpenRouterPromise = null;
}

export async function fetchOpenRouterModelsCatalog(
  fetchFn?: typeof fetch,
  timeoutMs = 8000
): Promise<OpenRouterModelEntry[]> {
  if (cachedOpenRouterCatalog) {
    return cachedOpenRouterCatalog;
  }
  if (cachedOpenRouterPromise) {
    return cachedOpenRouterPromise;
  }
  const effectiveFetch = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!effectiveFetch) {
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  cachedOpenRouterPromise = (async () => {
    try {
      const res = await effectiveFetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: OpenRouterModelEntry[] };
      const list = Array.isArray(json?.data) ? json.data : [];
      cachedOpenRouterCatalog = list;
      return list;
    } catch {
      clearTimeout(timeoutId);
      return [];
    } finally {
      cachedOpenRouterPromise = null;
    }
  })();

  return cachedOpenRouterPromise;
}

/**
 * Normalizes a model ID or slug by stripping reasoning effort suffixes (-high, -medium, -low, -thinking, etc.)
 * and variant tags (:free, :batch, @version) to allow matching proxy models with catalog models.
 * e.g. 'gemini-3.8-flash-high' -> 'gemini-3.8-flash'
 *      'google/gemini-3.8-flash:batch' -> 'gemini-3.8-flash'
 */
export function normalizeModelSlug(id: string): string {
  const base = extractModelBaseId(id).toLowerCase();
  if (!base) return '';
  const withoutColon = base.split(':')[0].split('@')[0];
  return withoutColon.replace(/-(high|medium|low|thinking|minimal|max|xhigh)$/i, '');
}

/**
 * Infer default input modalities for known multi-modal model families when catalog data is not available.
 */
export function inferHeuristicModalities(id: string): string[] | undefined {
  if (!id) return undefined;
  const lower = id.toLowerCase();
  if (lower.includes('gemini')) {
    return ['text', 'image', 'video', 'file', 'audio'];
  }
  if (
    lower.includes('claude') &&
    (lower.includes('3') || lower.includes('4') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku'))
  ) {
    return ['text', 'image', 'file'];
  }
  if (lower.includes('gpt-4o') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) {
    return ['text', 'image', 'file'];
  }
  if (lower.includes('vision') || lower.includes('vl')) {
    return ['text', 'image'];
  }
  return undefined;
}

export function enrichModelsWithModalities(
  models: CustomModelDefinition[],
  catalog: OpenRouterModelEntry[]
): CustomModelDefinition[] {
  if (!models || models.length === 0) {
    return [];
  }

  // Exact baseId map and normalizedSlug map
  const exactMap = new Map<string, string[]>();
  const normalizedMap = new Map<string, string[]>();

  if (catalog && catalog.length > 0) {
    for (const item of catalog) {
      if (!item?.id) continue;
      const baseId = extractModelBaseId(item.id).toLowerCase();
      const normSlug = normalizeModelSlug(item.id);
      const modalities = Array.isArray(item.architecture?.input_modalities)
        ? item.architecture!.input_modalities.filter((m): m is string => typeof m === 'string')
        : undefined;

      if (modalities && modalities.length > 0) {
        if (baseId && !exactMap.has(baseId)) {
          exactMap.set(baseId, modalities);
        }
        if (normSlug && !normalizedMap.has(normSlug)) {
          normalizedMap.set(normSlug, modalities);
        }
      }
    }
  }

  return models.map((model) => {
    let modalities = model.input_modalities;

    if (!modalities || modalities.length === 0) {
      const baseId = extractModelBaseId(model.id).toLowerCase();
      const normSlug = normalizeModelSlug(model.id);

      // 1. Try exact baseId match (e.g. 'gemini-3.8-flash')
      let found = exactMap.get(baseId);
      // 2. Try normalized slug match (e.g. 'gemini-3.8-flash-high' -> 'gemini-3.8-flash')
      if (!found && normSlug) {
        found = normalizedMap.get(normSlug);
      }

      if (found && found.length > 0) {
        modalities = found;
      }
    }

    // 3. Fallback to heuristic modalities if still not found
    if (!modalities || modalities.length === 0) {
      const heuristic = inferHeuristicModalities(model.id);
      if (heuristic && heuristic.length > 0) {
        modalities = heuristic;
      }
    }

    if (!modalities || modalities.length === 0) {
      return model;
    }

    const supportsImages = modalities.includes('image') || (model.input?.includes('image') ?? false);
    const updatedInput = supportsImages
      ? Array.from(new Set([...(model.input || ['text']), 'image']))
      : (model.input || ['text']);

    return {
      ...model,
      input_modalities: modalities,
      input: updatedInput,
    };
  });
}

/**
 * Enrich available models with input_modalities from custom provider configurations or heuristics.
 */
export function enrichAvailableModelsWithConfig(
  models: ModelInfo[],
  providersMap?: CustomProvidersMap | CustomProviderConfig[]
): ModelInfo[] {
  if (!models || models.length === 0) {
    return [];
  }

  const providers = !providersMap
    ? []
    : Array.isArray(providersMap)
      ? providersMap
      : mapProvidersToArray(providersMap);

  const configMap = new Map<string, string[]>();
  for (const provider of providers) {
    if (!provider?.models || !Array.isArray(provider.models)) continue;
    const provId = (provider.id || '').toLowerCase();
    for (const model of provider.models) {
      if (!model?.id) continue;
      if (Array.isArray(model.input_modalities) && model.input_modalities.length > 0) {
        const mId = model.id.toLowerCase();
        const baseId = extractModelBaseId(model.id).toLowerCase();
        configMap.set(`${provId}/${mId}`, model.input_modalities);
        if (!configMap.has(mId)) {
          configMap.set(mId, model.input_modalities);
        }
        if (baseId && !configMap.has(baseId)) {
          configMap.set(baseId, model.input_modalities);
        }
      }
    }
  }

  return models.map((model) => {
    let modalities =
      Array.isArray(model.input_modalities) && model.input_modalities.length > 0
        ? model.input_modalities
        : undefined;

    if (!modalities && model.id) {
      const provId = (model.provider || '').toLowerCase();
      const mId = model.id.toLowerCase();
      const baseId = extractModelBaseId(model.id).toLowerCase();
      modalities =
        configMap.get(`${provId}/${mId}`) ??
        configMap.get(mId) ??
        configMap.get(baseId) ??
        inferHeuristicModalities(model.id);
    }

    if (modalities && modalities.length > 0) {
      return { ...model, input_modalities: modalities };
    }

    return model;
  });
}

/**
 * Check if a model supports sending images or files based on input_modalities or input array.
 */
export function modelSupportsFiles(model?: ModelInfo | CustomModelDefinition | null): boolean {
  if (!model) return false;
  const modalities = Array.isArray(model.input_modalities)
    ? model.input_modalities
    : Array.isArray(model.input)
      ? model.input
      : null;

  if (modalities) {
    return modalities.some((m) => {
      const lower = typeof m === 'string' ? m.toLowerCase() : '';
      return lower === 'image' || lower === 'video' || lower === 'audio' || lower === 'file';
    });
  }
  return false;
}

/**
 * Check if a model supports a specific input modality (e.g. 'image', 'audio', 'file').
 */
export function modelSupportsInputModality(
  model: ModelInfo | CustomModelDefinition | null | undefined,
  modality: string
): boolean {
  if (!model || !modality) return false;
  const target = modality.toLowerCase();
  if (Array.isArray(model.input_modalities)) {
    return model.input_modalities.some((m) => m.toLowerCase() === target);
  }
  if (Array.isArray(model.input)) {
    return model.input.some((m) => m.toLowerCase() === target);
  }
  return false;
}

/**
 * Fetch models list directly from provider API endpoint.
 * Supports OpenAI-compatible (/v1/models), Ollama (/api/tags or /v1/models),
 * Anthropic (/v1/models), and Google Generative AI (/v1beta/models).
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiProtocol: string,
  apiKey?: string,
  options?: FetchModelsOptions
): Promise<CustomModelDefinition[]> {
  const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
  if (!cleanUrl) {
    throw new Error('Base URL is required');
  }

  const effectiveFetch = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!effectiveFetch) {
    throw new Error('Fetch API is not available');
  }

  const timeoutMs = options?.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options?.signal ?? controller.signal;

  try {
    let targetUrl: string;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    const hasRealKey = Boolean(apiKey && apiKey.trim() && !apiKey.trim().startsWith('$'));

    if (apiProtocol === 'google-generative-ai') {
      targetUrl = hasRealKey
        ? `${cleanUrl}/models?key=${encodeURIComponent(apiKey!.trim())}`
        : `${cleanUrl}/models`;
    } else if (apiProtocol === 'anthropic-messages') {
      targetUrl = cleanUrl.endsWith('/models') ? cleanUrl : `${cleanUrl}/models`;
      headers['anthropic-version'] = '2023-06-01';
      if (hasRealKey) {
        headers['x-api-key'] = apiKey!.trim();
      }
    } else {
      // Default: openai-completions, openai-responses, and OpenAI-compatible
      if (cleanUrl.endsWith('/models') || cleanUrl.endsWith('/tags')) {
        targetUrl = cleanUrl;
      } else if (cleanUrl.includes(':11434') && !cleanUrl.includes('/v1')) {
        targetUrl = `${cleanUrl}/v1/models`;
      } else {
        targetUrl = `${cleanUrl}/models`;
      }

      if (hasRealKey) {
        headers['Authorization'] = `Bearer ${apiKey!.trim()}`;
      }
    }

    let res: Response;
    const isCliProxy = cleanUrl.includes(':8317') || cleanUrl.toLowerCase().includes('cliproxy');

    if (isCliProxy && !targetUrl.includes('?')) {
      // Try enriched CLIProxyAPI endpoint with client_version=1 first
      try {
        const enrichedRes = await effectiveFetch(`${targetUrl}?client_version=1`, { headers, signal });
        if (enrichedRes.ok) {
          res = enrichedRes;
        } else {
          res = await effectiveFetch(targetUrl, { headers, signal });
        }
      } catch {
        res = await effectiveFetch(targetUrl, { headers, signal });
      }
    } else {
      try {
        res = await effectiveFetch(targetUrl, { headers, signal });
      } catch (fetchErr) {
        if (cleanUrl.includes(':11434') && targetUrl.endsWith('/v1/models')) {
          targetUrl = `${cleanUrl}/api/tags`;
          res = await effectiveFetch(targetUrl, { headers, signal });
        } else {
          throw fetchErr;
        }
      }
    }

    if (!res.ok) {
      if (res.status === 404 && cleanUrl.includes(':11434')) {
        const fallbackUrl = `${cleanUrl}/api/tags`;
        const fbRes = await effectiveFetch(fallbackUrl, { headers, signal });
        if (fbRes.ok) {
          res = fbRes;
        } else {
          throw new Error(`API returned HTTP ${res.status}: ${res.statusText}`);
        }
      } else {
        throw new Error(`API returned HTTP ${res.status}: ${res.statusText}`);
      }
    }

    const payload = await res.json();
    clearTimeout(timeoutId);

    const parsed = parseModelsFromApiResponse(payload);
    if (parsed.length === 0) {
      throw new Error('No models found in the API response');
    }

    try {
      const catalog = await fetchOpenRouterModelsCatalog(effectiveFetch);
      return enrichModelsWithModalities(parsed, catalog);
    } catch {
      return parsed;
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out while connecting to ${cleanUrl}`);
      }
      throw err;
    }
    throw new Error(String(err));
  }
}

