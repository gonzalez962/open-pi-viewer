import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPiAgentDir } from './state';

export interface CustomModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  input_modalities?: string[];
  [key: string]: unknown;
}

export interface CustomProviderConfig {
  id?: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: CustomModelDefinition[];
  excludedModels?: string[];
  includedModels?: string[];
  [key: string]: unknown;
}

export type CustomProvidersMap = Record<string, CustomProviderConfig>;

export interface ModelsConfigFile {
  providers?: CustomProvidersMap;
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasOwn(obj: object, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

/**
 * Validate that an object does not contain dangerous keys (__proto__, constructor, prototype)
 * as own properties at any nesting level, preventing prototype pollution or setter semantics.
 */
export function assertNoDangerousProperties(val: unknown, pathStr = 'payload'): void {
  if (!val || typeof val !== 'object') {
    return;
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      assertNoDangerousProperties(val[i], `${pathStr}[${i}]`);
    }
    return;
  }
  for (const key of Object.getOwnPropertyNames(val)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`Dangerous property '${key}' is not allowed at ${pathStr}`);
    }
    assertNoDangerousProperties((val as Record<string, unknown>)[key], `${pathStr}.${key}`);
  }
}

/**
 * Validate a provider ID string according to backend safety rules.
 * Allowed characters: alphanumeric, '-', '_', '.', '/'.
 * Rejects dangerous reserved keys (__proto__, constructor, prototype).
 */
export function validateProviderId(id: unknown): string {
  if (typeof id !== 'string') {
    throw new Error('Provider ID must not be empty');
  }
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error('Provider ID must not be empty');
  }
  if (DANGEROUS_KEYS.has(trimmed)) {
    throw new Error(`Provider ID '${trimmed}' is reserved and not allowed`);
  }
  if (!/^[a-zA-Z0-9_\-./]+$/.test(trimmed)) {
    throw new Error(
      `Provider ID '${trimmed}' contains invalid characters. Use letters, digits, '-', '_', '.', or '/'`
    );
  }
  return trimmed;
}

/**
 * Validate provider payload fields and extract sanitized provider object.
 */
export function validateProviderPayload(
  providerId: string,
  data: unknown
): { providerId: string; providerObj: CustomProviderConfig } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Provider payload must be a JSON object');
  }
  assertNoDangerousProperties(data, 'provider');

  const rawObj = data as Record<string, unknown>;
  const providerObj: Record<string, unknown> =
    rawObj.provider && typeof rawObj.provider === 'object' && !Array.isArray(rawObj.provider)
      ? (rawObj.provider as Record<string, unknown>)
      : rawObj;

  const rawBaseUrl = providerObj.baseUrl;
  const rawApi = providerObj.api;
  const hasNoBaseUrl = rawBaseUrl === undefined || (typeof rawBaseUrl === 'string' && !rawBaseUrl.trim());
  const hasNoApi = rawApi === undefined || (typeof rawApi === 'string' && !rawApi.trim());

  const hasModels = Array.isArray(providerObj.models) && providerObj.models.length > 0;
  const hasIncluded = Array.isArray(providerObj.includedModels) && providerObj.includedModels.length > 0;
  const hasExcluded = Array.isArray(providerObj.excludedModels) && providerObj.excludedModels.length > 0;
  const isOverrideOnly = Boolean(
    providerObj.isBuiltin ||
      ((hasModels || hasIncluded || hasExcluded || providerObj.models !== undefined) && hasNoBaseUrl && hasNoApi)
  );

  if (isOverrideOnly && hasNoBaseUrl && hasNoApi) {
    // Built-in models / pattern-only override:
    // Strip empty/undefined baseUrl, api, apiKey so they are never saved into models.json
    delete providerObj.baseUrl;
    delete providerObj.api;
    if (typeof providerObj.apiKey === 'string' && !providerObj.apiKey.trim()) {
      delete providerObj.apiKey;
    }
  } else {
    const baseUrl = providerObj.baseUrl;
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new Error(`Provider '${providerId}' missing required 'baseUrl'`);
    }
    const trimmedUrl = baseUrl.trim();
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      throw new Error(
        `Provider '${providerId}' baseUrl must start with http:// or https://, got '${trimmedUrl}'`
      );
    }
    try {
      new URL(trimmedUrl);
    } catch {
      throw new Error(`Provider '${providerId}' baseUrl '${trimmedUrl}' is not a valid URL`);
    }

    const api = providerObj.api;
    if (typeof api !== 'string' || !api.trim()) {
      throw new Error(`Provider '${providerId}' missing required 'api' field`);
    }
  }

  if (providerObj.models !== undefined) {
    if (!Array.isArray(providerObj.models)) {
      throw new Error(`Provider '${providerId}' 'models' field must be an array`);
    }
    for (let idx = 0; idx < providerObj.models.length; idx++) {
      const m = providerObj.models[idx];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        throw new Error(`Model at index ${idx} in provider '${providerId}' must be an object`);
      }
      if (typeof m.id !== 'string' || !m.id.trim()) {
        throw new Error(`Model at index ${idx} in provider '${providerId}' is missing required 'id'`);
      }
    }
  }

  if (providerObj.includedModels !== undefined) {
    if (!Array.isArray(providerObj.includedModels)) {
      throw new Error(`Provider '${providerId}' 'includedModels' field must be an array`);
    }
    for (let idx = 0; idx < providerObj.includedModels.length; idx++) {
      if (typeof providerObj.includedModels[idx] !== 'string') {
        throw new Error(`Included model at index ${idx} in provider '${providerId}' must be a string`);
      }
    }
  }

  if (providerObj.excludedModels !== undefined) {
    if (!Array.isArray(providerObj.excludedModels)) {
      throw new Error(`Provider '${providerId}' 'excludedModels' field must be an array`);
    }
    for (let idx = 0; idx < providerObj.excludedModels.length; idx++) {
      if (typeof providerObj.excludedModels[idx] !== 'string') {
        throw new Error(`Excluded model at index ${idx} in provider '${providerId}' must be a string`);
      }
    }
  }

  return { providerId, providerObj: providerObj as CustomProviderConfig };
}

/**
 * Read models.json failing closed on invalid JSON or non-object root.
 * If file does not exist, returns an empty root object.
 */
export function readModelsConfigFile(filePath: string): ModelsConfigFile {
  if (!fs.existsSync(filePath)) {
    return { providers: {} };
  }

  const contents = fs.readFileSync(filePath, 'utf8');
  if (!contents.trim()) {
    return { providers: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err: any) {
    throw new Error(`Failed to parse models.json at ${filePath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`models.json root at ${filePath} must be a JSON object`);
  }

  const root = parsed as ModelsConfigFile;
  if (root.providers !== undefined) {
    if (!root.providers || typeof root.providers !== 'object' || Array.isArray(root.providers)) {
      throw new Error(`'providers' field in models.json must be a JSON object`);
    }
    for (const key of Object.keys(root.providers)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new Error(`Dangerous property '${key}' in models.json is not allowed`);
      }
    }
  }

  return root;
}

/**
 * Atomically write config to destination path using exclusive temp creation and target permissions.
 * Mode 0600 for new files; preserves existing file permission bits on replacement.
 * Uses fchmodSync to overcome umask restrictions.
 */
export function writeModelsConfigFileAtomically(filePath: string, config: ModelsConfigFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let targetMode = 0o600;
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const existingBits = stat.mode & 0o777;
        if (existingBits !== 0) {
          targetMode = existingBits;
        }
      }
    }
  } catch {
    targetMode = 0o600;
  }

  const tempFile = path.join(dir, `models.json.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempFile, 'wx', targetMode);
    try {
      fs.fchmodSync(fd, targetMode);
    } catch {
      // Non-fatal if platform or filesystem doesn't support fchmod
    }

    const serialized = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempFile, filePath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {}
    }
  }
}

/**
 * Merge custom provider additively into root config map.
 * Preserves unrelated root keys and unrelated providers.
 * Preserves unknown provider metadata and merges models by id, preserving unmatched existing models.
 */
export function mergeCustomProviderAdditive(
  existingConfig: ModelsConfigFile,
  providerId: string,
  providerObj: CustomProviderConfig
): ModelsConfigFile {
  assertNoDangerousProperties(providerObj, 'providerObj');
  if (DANGEROUS_KEYS.has(providerId)) {
    throw new Error(`Provider ID '${providerId}' is reserved and not allowed`);
  }

  const root: ModelsConfigFile = { ...existingConfig };
  const existingProviders: Record<string, unknown> =
    root.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
      ? { ...root.providers }
      : {};

  const hasExisting = hasOwn(existingProviders, providerId);
  const existingEntry = hasExisting ? existingProviders[providerId] : undefined;

  if (hasExisting && existingEntry !== undefined) {
    if (typeof existingEntry !== 'object' || existingEntry === null || Array.isArray(existingEntry)) {
      throw new Error(`Existing provider '${providerId}' in models.json must be a JSON object`);
    }
    const ep = existingEntry as Record<string, unknown>;
    if (ep.models !== undefined && !Array.isArray(ep.models)) {
      throw new Error(`Existing 'models' field in provider '${providerId}' must be an array`);
    }
  }

  const existingProvider: Record<string, unknown> =
    hasExisting && existingEntry && typeof existingEntry === 'object' && !Array.isArray(existingEntry)
      ? { ...(existingEntry as Record<string, unknown>) }
      : {};

  const { id: _ignoredId, models: incModels, ...incomingProps } = providerObj;

  const mergedProvider: Record<string, unknown> = {
    ...existingProvider,
  };

  for (const key of Object.keys(incomingProps)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`Dangerous property '${key}' is not allowed in provider object`);
    }
    const val = (incomingProps as Record<string, unknown>)[key];
    if (val === null) {
      delete mergedProvider[key];
    } else {
      Object.defineProperty(mergedProvider, key, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  if (incModels && Array.isArray(incModels)) {
    const existingModels = Array.isArray(existingProvider.models)
      ? (existingProvider.models as Record<string, unknown>[])
      : [];

    const incomingIds = new Set(incModels.map((m) => m.id));
    const mergedModels: CustomModelDefinition[] = incModels.map((incM) => {
      const existingM = existingModels.find(
        (m) => m && (m as { id?: unknown }).id === incM.id
      );
      if (existingM) {
        const mergedM: Record<string, unknown> = { ...existingM, ...incM };
        for (const mk of Object.keys(incM)) {
          if (DANGEROUS_KEYS.has(mk)) {
            throw new Error(`Dangerous property '${mk}' is not allowed in model object`);
          }
          const mv = (incM as Record<string, unknown>)[mk];
          if (mv === null) {
            delete mergedM[mk];
          }
        }
        return mergedM as CustomModelDefinition;
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

  existingProviders[providerId] = mergedProvider as CustomProviderConfig;
  root.providers = existingProviders as CustomProvidersMap;
  return root;
}

/**
 * Remove a single custom provider from config map, preserving other keys.
 */
export function removeCustomProviderFromConfig(
  existingConfig: ModelsConfigFile,
  providerId: string
): ModelsConfigFile {
  if (DANGEROUS_KEYS.has(providerId)) {
    throw new Error(`Provider ID '${providerId}' is reserved and not allowed`);
  }
  const root: ModelsConfigFile = { ...existingConfig };
  const existingProviders: Record<string, unknown> =
    root.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
      ? { ...root.providers }
      : {};

  if (hasOwn(existingProviders, providerId)) {
    delete existingProviders[providerId];
  }
  root.providers = existingProviders as CustomProvidersMap;
  return root;
}

/**
 * Handler for public web IPC upsert_custom_provider.
 */
export function handleUpsertCustomProvider(args: any = {}): ModelsConfigFile {
  assertNoDangerousProperties(args, 'args');
  const payload =
    args && typeof args === 'object' && args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? args.payload
      : args;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Provider payload must be a JSON object');
  }

  if (payload.provider !== undefined) {
    if (!payload.provider || typeof payload.provider !== 'object' || Array.isArray(payload.provider)) {
      throw new Error('Provider payload must be a JSON object');
    }
  }

  if (payload.providerData !== undefined) {
    if (!payload.providerData || typeof payload.providerData !== 'object' || Array.isArray(payload.providerData)) {
      throw new Error('Provider payload must be a JSON object');
    }
  }

  const rawProvider =
    payload.provider && typeof payload.provider === 'object' && !Array.isArray(payload.provider)
      ? payload.provider
      : payload.providerData && typeof payload.providerData === 'object' && !Array.isArray(payload.providerData)
      ? payload.providerData
      : payload;

  const rawId = payload.providerId ?? payload.provider_id ?? payload.id ?? rawProvider.id ?? rawProvider.providerId;
  const validatedId = validateProviderId(rawId);
  const { providerObj } = validateProviderPayload(validatedId, rawProvider);

  const modelsPath = path.join(getPiAgentDir(), 'models.json');
  const currentConfig = readModelsConfigFile(modelsPath);

  const updatedConfig = mergeCustomProviderAdditive(currentConfig, validatedId, providerObj);
  writeModelsConfigFileAtomically(modelsPath, updatedConfig);
  return updatedConfig;
}

/**
 * Handler for public web IPC delete_custom_provider.
 */
export function handleDeleteCustomProvider(args: any = {}): ModelsConfigFile {
  assertNoDangerousProperties(args, 'args');
  const payload =
    args && typeof args === 'object' && args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? args.payload
      : args;

  const rawId =
    typeof args === 'string'
      ? args
      : payload?.providerId ?? payload?.provider_id ?? payload?.id ?? payload?.name;

  const validatedId = validateProviderId(rawId);

  const modelsPath = path.join(getPiAgentDir(), 'models.json');
  if (!fs.existsSync(modelsPath)) {
    return { providers: {} };
  }

  const currentConfig = readModelsConfigFile(modelsPath);
  const updatedConfig = removeCustomProviderFromConfig(currentConfig, validatedId);
  writeModelsConfigFileAtomically(modelsPath, updatedConfig);
  return updatedConfig;
}
