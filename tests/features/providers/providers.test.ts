import assert from 'node:assert';
import test from 'node:test';
import { invoke } from '@tauri-apps/api/core';

import {
  arrayToProvidersMap,
  buildStrictThinkingLevelMap,
  clampThinkingLevelToSupported,
  clearOpenRouterCatalogCache,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REASONING_LEVELS,
  enrichAvailableModelsWithConfig,
  enrichModelsWithModalities,
  EXTENDED_THINKING_LEVELS,
  extractModelBaseId,
  fetchOpenRouterModelsCatalog,
  fetchProviderModels,
  filterExcludedModels,
  getSupportedThinkingLevelsForModel,
  inferHeuristicModalities,
  isModelAllowed,
  isModelExcluded,
  isModelIncluded,
  mapProvidersToArray,
  mergeCustomProviderAdditive,
  removeCustomProviderFromConfig,
  MAX_SAFE_OUTPUT_TOKENS,
  modelSupportsFiles,
  modelSupportsInputModality,
  normalizeModelSlug,
  OPENROUTER_MODELS_URL,
  parseModelsFromApiResponse,
  resolveModelDefaultThinkingLevel,
  resolveModelSelectionOutcome,
  resolveRecommendedContextWindow,
  SUPPORTED_API_PROTOCOLS,
  toPiModelFromCPA,
  toPiModelFromOpenAI,
  validateBaseUrl,
  validateModelDefinition,
  validateProviderConfig,
  validateProviderId,
} from '@features/providers/providers';
import {
  getCustomProvidersPi,
  getModelThinkingLevelsPi,
  MOCK_MODEL_THINKING_LEVELS_STORAGE_KEY,
  saveCustomProvidersPi,
  saveModelThinkingLevelsPi,
  upsertCustomProviderPi,
  deleteCustomProviderPi,
} from '@infra/bridge';
import type { CustomModelDefinition, CustomProviderConfig, CustomProvidersMap } from '@core/types/providers';
import type { ModelInfo, ModelThinkingLevelsMap, ThinkingLevel } from '@core/types/models';
import { mergeDiscoveredModels } from '@features/providers/types';

test('providers: validateProviderId accepts valid identifiers and rejects invalid ones', () => {
  // Valid IDs
  assert.strictEqual(validateProviderId('ollama').valid, true);
  assert.strictEqual(validateProviderId('openrouter').valid, true);
  assert.strictEqual(validateProviderId('my-custom_provider.v1').valid, true);
  assert.strictEqual(validateProviderId('proxy/local').valid, true);

  // Invalid IDs
  assert.strictEqual(validateProviderId('').valid, false);
  assert.strictEqual(validateProviderId('   ').valid, false);
  assert.strictEqual(validateProviderId('id with spaces').valid, false);
  assert.strictEqual(validateProviderId('id@invalid!').valid, false);
  assert.strictEqual(validateProviderId('id#test').valid, false);
});

test('providers: validateBaseUrl accepts http and https URLs and rejects invalid ones', () => {
  // Valid URLs
  assert.strictEqual(validateBaseUrl('http://localhost:11434/v1').valid, true);
  assert.strictEqual(validateBaseUrl('https://api.openai.com/v1').valid, true);
  assert.strictEqual(validateBaseUrl('http://127.0.0.1:8080').valid, true);

  // Invalid URLs
  assert.strictEqual(validateBaseUrl('').valid, false);
  assert.strictEqual(validateBaseUrl('   ').valid, false);
  assert.strictEqual(validateBaseUrl('ftp://localhost:11434').valid, false);
  assert.strictEqual(validateBaseUrl('file:///path/to/server').valid, false);
  assert.strictEqual(validateBaseUrl('localhost:11434').valid, false);
  assert.strictEqual(validateBaseUrl('http://').valid, false);
});

test('providers: validateModelDefinition validates id and numeric bounds', () => {
  // Valid models
  assert.strictEqual(validateModelDefinition({ id: 'llama3.1:8b' }).valid, true);
  assert.strictEqual(
    validateModelDefinition({
      id: 'gpt-4o',
      name: 'GPT-4o',
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: true,
    }).valid,
    true
  );

  // Missing or empty id
  assert.strictEqual(validateModelDefinition({ id: '' }).valid, false);
  assert.strictEqual(validateModelDefinition({ id: '   ' }).valid, false);

  // Invalid numeric bounds
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', contextWindow: -100 }).valid,
    false
  );
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', maxTokens: 0 }).valid,
    false
  );

  // Thinking level validation
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', thinkingLevel: 'medium' }).valid,
    true
  );
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', thinkingLevel: 'off' }).valid,
    true
  );
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', thinkingLevel: 'invalid' as any }).valid,
    false
  );
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', defaultThinkingLevel: 'high' }).valid,
    true
  );
  assert.strictEqual(
    validateModelDefinition({ id: 'model-1', defaultThinkingLevel: 'unknown' as any }).valid,
    false
  );
});

test('providers: validateProviderConfig verifies all required fields and models', () => {
  const validProvider: CustomProviderConfig = {
    id: 'ollama',
    name: 'Ollama Local',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    models: [
      { id: 'llama3.1:8b', name: 'Llama 3.1 8B', contextWindow: 128000 },
    ],
  };

  assert.strictEqual(validateProviderConfig(validProvider).valid, true);

  // Missing ID
  assert.strictEqual(
    validateProviderConfig({ ...validProvider, id: '' }).valid,
    false
  );

  // Invalid Base URL
  assert.strictEqual(
    validateProviderConfig({ ...validProvider, baseUrl: 'ftp://bad' }).valid,
    false
  );

  // Missing API
  assert.strictEqual(
    validateProviderConfig({ ...validProvider, api: '' }).valid,
    false
  );

  // Empty models array
  assert.strictEqual(
    validateProviderConfig({ ...validProvider, models: [] }).valid,
    false
  );

  // Model with empty ID inside models array
  assert.strictEqual(
    validateProviderConfig({
      ...validProvider,
      models: [{ id: '' }],
    }).valid,
    false
  );
});

test('providers: mapProvidersToArray and arrayToProvidersMap roundtrip cleanly', () => {
  const providersMap: CustomProvidersMap = {
    ollama: {
      name: 'Ollama Local',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [
        { id: 'llama3.1:8b', name: 'Llama 3.1' },
        { id: 'qwen2.5:7b', reasoning: true },
      ],
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKey: '$OPENROUTER_API_KEY',
      models: [{ id: 'anthropic/claude-3.5-sonnet' }],
    },
  };

  const list = mapProvidersToArray(providersMap);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 'ollama');
  assert.strictEqual(list[0].models.length, 2);
  assert.strictEqual(list[1].id, 'openrouter');
  assert.strictEqual(list[1].apiKey, '$OPENROUTER_API_KEY');

  const roundtrip = arrayToProvidersMap(list);
  assert.deepStrictEqual(roundtrip, {
    ollama: {
      name: 'Ollama Local',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [
        { id: 'llama3.1:8b', name: 'Llama 3.1' },
        { id: 'qwen2.5:7b', reasoning: true },
      ],
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKey: '$OPENROUTER_API_KEY',
      models: [{ id: 'anthropic/claude-3.5-sonnet' }],
    },
  });
});

test('providers: supported API protocols list is populated and valid', () => {
  assert.strictEqual(SUPPORTED_API_PROTOCOLS.length >= 4, true);
  const values = SUPPORTED_API_PROTOCOLS.map((p) => p.value);
  assert.strictEqual(values.includes('openai-completions'), true);
  assert.strictEqual(values.includes('openai-responses'), true);
  assert.strictEqual(values.includes('anthropic-messages'), true);
  assert.strictEqual(values.includes('google-generative-ai'), true);
});

test('bridge: getCustomProvidersPi and saveCustomProvidersPi roundtrip in preview / mock invoke', async () => {
  const mockStorage = new Map<string, string>();
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === 'get_custom_providers') {
      const stored = mockStorage.get('test_providers');
      return (stored ? JSON.parse(stored) : { providers: {} }) as T;
    }
    if (cmd === 'save_custom_providers') {
      const payload = { providers: args?.providers };
      mockStorage.set('test_providers', JSON.stringify(payload));
      return payload as T;
    }
    throw new Error(`Unknown mock command: ${cmd}`);
  };

  // Initial read is empty
  const initial = await getCustomProvidersPi(mockInvoke);
  assert.deepStrictEqual(initial, { providers: {} });

  // Save new provider
  const toSave: CustomProvidersMap = {
    testprov: {
      baseUrl: 'http://localhost:8000/v1',
      api: 'openai-completions',
      models: [{ id: 'test-model' }],
    },
  };

  const saved = await saveCustomProvidersPi(toSave, mockInvoke);
  assert.strictEqual(saved.providers?.testprov?.baseUrl, 'http://localhost:8000/v1');

  // Read back
  const reloaded = await getCustomProvidersPi(mockInvoke);
  const provMap = reloaded.providers as CustomProvidersMap;
  assert.strictEqual(provMap?.testprov?.baseUrl, 'http://localhost:8000/v1');
  assert.strictEqual(provMap?.testprov?.models[0].id, 'test-model');
});

test('bridge: saveCustomProvidersPi persists both includedModels and excludedModels and roundtrips through getCustomProvidersPi and mapProvidersToArray', async () => {
  const mockStorage = new Map<string, string>();
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === 'get_custom_providers') {
      const stored = mockStorage.get('test_providers');
      return (stored ? JSON.parse(stored) : { providers: {} }) as T;
    }
    if (cmd === 'save_custom_providers') {
      const payload = { providers: args?.providers };
      mockStorage.set('test_providers', JSON.stringify(payload));
      return payload as T;
    }
    throw new Error(`Unknown mock command: ${cmd}`);
  };

  const toSave: CustomProvidersMap = {
    testprov: {
      baseUrl: 'http://localhost:8000/v1',
      api: 'openai-completions',
      models: [{ id: 'test-model' }],
      includedModels: ['claude-3-5*', 'gpt-4o'],
      excludedModels: ['dall-e*', 'whisper-1'],
    },
  };

  const saved = await saveCustomProvidersPi(toSave, mockInvoke);
  assert.deepStrictEqual(saved.providers?.testprov?.includedModels, ['claude-3-5*', 'gpt-4o']);
  assert.deepStrictEqual(saved.providers?.testprov?.excludedModels, ['dall-e*', 'whisper-1']);

  const reloaded = await getCustomProvidersPi(mockInvoke);
  const provMap = reloaded.providers as CustomProvidersMap;
  assert.deepStrictEqual(provMap?.testprov?.includedModels, ['claude-3-5*', 'gpt-4o']);
  assert.deepStrictEqual(provMap?.testprov?.excludedModels, ['dall-e*', 'whisper-1']);

  const providersArray = mapProvidersToArray(provMap);
  assert.strictEqual(providersArray.length, 1);
  assert.strictEqual(providersArray[0].id, 'testprov');
  assert.deepStrictEqual(providersArray[0].includedModels, ['claude-3-5*', 'gpt-4o']);
  assert.deepStrictEqual(providersArray[0].excludedModels, ['dall-e*', 'whisper-1']);
});

test('bridge: getModelThinkingLevelsPi and saveModelThinkingLevelsPi roundtrip via mock invoke', async () => {
  let mockLevels: Record<string, ThinkingLevel> = {};
  const mockInvoke: typeof invoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
    if (cmd === 'get_model_thinking_levels') {
      return { ...mockLevels } as T;
    }
    if (cmd === 'save_model_thinking_levels') {
      const payload = args as { levels?: Record<string, ThinkingLevel | null> } | undefined;
      const levels = payload?.levels || {};
      for (const [k, v] of Object.entries(levels)) {
        if (v === null) {
          delete mockLevels[k];
        } else {
          mockLevels[k] = v;
        }
      }
      return { ...mockLevels } as T;
    }
    throw new Error(`Unknown mock command: ${cmd}`);
  };

  // 1. Initial read should be empty
  const initial = await getModelThinkingLevelsPi(mockInvoke);
  assert.deepStrictEqual(initial, {});

  // 2. Save new thinking levels
  const saved = await saveModelThinkingLevelsPi(
    {
      'provider1/model-a': 'high',
      'provider1/model-b': 'low',
    },
    mockInvoke
  );
  assert.deepStrictEqual(saved, {
    'provider1/model-a': 'high',
    'provider1/model-b': 'low',
  });

  // 3. Read back via getModelThinkingLevelsPi
  const readBack = await getModelThinkingLevelsPi(mockInvoke);
  assert.deepStrictEqual(readBack, {
    'provider1/model-a': 'high',
    'provider1/model-b': 'low',
  });

  // 4. Update an existing key and remove another key using null
  const updated = await saveModelThinkingLevelsPi(
    {
      'provider1/model-a': 'medium',
      'provider1/model-b': null,
      'provider2/model-c': 'minimal',
    },
    mockInvoke
  );
  assert.deepStrictEqual(updated, {
    'provider1/model-a': 'medium',
    'provider2/model-c': 'minimal',
  });

  // 5. Verify removal persisted on subsequent read
  const afterRemoval = await getModelThinkingLevelsPi(mockInvoke);
  assert.deepStrictEqual(afterRemoval, {
    'provider1/model-a': 'medium',
    'provider2/model-c': 'minimal',
  });
});

test('bridge: getModelThinkingLevelsPi and saveModelThinkingLevelsPi roundtrip via preview localStorage mock', async () => {
  const originalLocalStorage = (globalThis as unknown as { localStorage: unknown }).localStorage;
  const storageMap = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  try {
    // 1. Initial read is empty
    const initial = await getModelThinkingLevelsPi();
    assert.deepStrictEqual(initial, {});

    // 2. Save new thinking levels
    const saved = await saveModelThinkingLevelsPi({
      'provider-x/model-1': 'xhigh',
      'provider-x/model-2': 'off',
    });
    assert.deepStrictEqual(saved, {
      'provider-x/model-1': 'xhigh',
      'provider-x/model-2': 'off',
    });
    assert.ok(storageMap.has(MOCK_MODEL_THINKING_LEVELS_STORAGE_KEY));

    // 3. Read back
    const readBack = await getModelThinkingLevelsPi();
    assert.deepStrictEqual(readBack, {
      'provider-x/model-1': 'xhigh',
      'provider-x/model-2': 'off',
    });

    // 4. Update and remove with null
    const updated = await saveModelThinkingLevelsPi({
      'provider-x/model-1': 'max',
      'provider-x/model-2': null,
      'provider-y/model-3': 'low',
    });
    assert.deepStrictEqual(updated, {
      'provider-x/model-1': 'max',
      'provider-y/model-3': 'low',
    });

    // 5. Confirm subsequent read reflects removal
    const finalRead = await getModelThinkingLevelsPi();
    assert.deepStrictEqual(finalRead, {
      'provider-x/model-1': 'max',
      'provider-y/model-3': 'low',
    });
  } finally {
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('providers: parseModelsFromApiResponse parses OpenAI, Ollama, and Google formats', () => {
  // OpenAI data format
  const openaiPayload = {
    data: [
      { id: 'gpt-4o', context_length: 128000, max_tokens: 4096 },
      { id: 'o3-mini', reasoning: true },
    ],
  };
  const openaiModels = parseModelsFromApiResponse(openaiPayload);
  assert.strictEqual(openaiModels.length, 2);
  assert.strictEqual(openaiModels[0].id, 'gpt-4o');
  assert.strictEqual(openaiModels[0].contextWindow, 128000);
  assert.strictEqual(openaiModels[1].id, 'o3-mini');
  assert.strictEqual(openaiModels[1].reasoning, true);

  // Ollama models format
  const ollamaPayload = {
    models: [
      { name: 'llama3.1:8b', size: 4000000 },
      { name: 'deepseek-r1:7b' },
    ],
  };
  const ollamaModels = parseModelsFromApiResponse(ollamaPayload);
  assert.strictEqual(ollamaModels.length, 2);
  assert.strictEqual(ollamaModels[0].id, 'llama3.1:8b');
  assert.strictEqual(ollamaModels[1].id, 'deepseek-r1:7b');
  assert.strictEqual(ollamaModels[1].reasoning, true);

  // Google Generative AI format (with models/ prefix)
  const googlePayload = {
    models: [
      {
        name: 'models/gemini-1.5-pro',
        displayName: 'Gemini 1.5 Pro',
        inputTokenLimit: 2000000,
        outputTokenLimit: 8192,
      },
    ],
  };
  const googleModels = parseModelsFromApiResponse(googlePayload);
  assert.strictEqual(googleModels.length, 1);
  assert.strictEqual(googleModels[0].id, 'gemini-1.5-pro');
  assert.strictEqual(googleModels[0].name, 'Gemini 1.5 Pro');
  assert.strictEqual(googleModels[0].contextWindow, 370000); // Capped by resolveRecommendedContextWindow (Gemini cap: 370,000)

  // Empty or malformed
  assert.deepStrictEqual(parseModelsFromApiResponse(null), []);
  assert.deepStrictEqual(parseModelsFromApiResponse({}), []);
});

test('providers: fetchProviderModels performs authenticated and unauthenticated queries', async () => {
  clearOpenRouterCatalogCache();
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === OPENROUTER_MODELS_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response;
    }

    capturedUrl = url;
    capturedHeaders = (init?.headers || {}) as Record<string, string>;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'qwen2.5-coder:7b', context_length: 32000 },
        ],
      }),
    } as unknown as Response;
  };

  // 1. OpenAI-compatible with apiKey
  const models = await fetchProviderModels(
    'https://api.openai.com/v1',
    'openai-completions',
    'sk-secret-key',
    { fetchFn: mockFetch }
  );
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, 'qwen2.5-coder:7b');
  assert.strictEqual(capturedUrl, 'https://api.openai.com/v1/models');
  assert.strictEqual(capturedHeaders['Authorization'], 'Bearer sk-secret-key');

  // 2. Ollama localhost without /v1
  await fetchProviderModels(
    'http://localhost:11434',
    'openai-completions',
    undefined,
    { fetchFn: mockFetch }
  );
  assert.strictEqual(capturedUrl, 'http://localhost:11434/v1/models');
  assert.strictEqual(capturedHeaders['Authorization'], undefined);

  // 3. Error handling on 500
  const failingFetch: typeof fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
  } as unknown as Response);

  await assert.rejects(
    () =>
      fetchProviderModels('http://localhost:8080/v1', 'openai-completions', undefined, {
        fetchFn: failingFetch,
      }),
    /API returned HTTP 500/
  );
});

test('providers: buildStrictThinkingLevelMap handles empty and custom levels', () => {
  // Empty or undefined levels default to low, medium, high
  const defaultMap = buildStrictThinkingLevelMap([]);
  assert.strictEqual(defaultMap.off, null);
  assert.strictEqual(defaultMap.minimal, null);
  assert.strictEqual(defaultMap.low, 'low');
  assert.strictEqual(defaultMap.medium, 'medium');
  assert.strictEqual(defaultMap.high, 'high');
  assert.strictEqual(defaultMap.xhigh, null);
  assert.strictEqual(defaultMap.max, null);

  // Custom levels map specified efforts
  const customMap = buildStrictThinkingLevelMap(['Minimal', 'HIGH', 'MAX']);
  assert.strictEqual(customMap.off, null);
  assert.strictEqual(customMap.minimal, 'minimal');
  assert.strictEqual(customMap.low, null);
  assert.strictEqual(customMap.medium, null);
  assert.strictEqual(customMap.high, 'high');
  assert.strictEqual(customMap.xhigh, null);
  assert.strictEqual(customMap.max, 'max');
});

test('providers: resolveRecommendedContextWindow applies family-specific caps and preserves smaller bounds', () => {
  // GPT / Codex / OpenAI cap: 272,000
  assert.strictEqual(resolveRecommendedContextWindow('gpt-4o'), 272000);
  assert.strictEqual(resolveRecommendedContextWindow('gpt-4o', 1000000), 272000);
  assert.strictEqual(resolveRecommendedContextWindow('openai/chatgpt-4o-latest', 128000), 128000);
  assert.strictEqual(resolveRecommendedContextWindow('codex-mini', 500000), 272000);

  // Claude cap: 200,000
  assert.strictEqual(resolveRecommendedContextWindow('claude-3-5-sonnet-20241022'), 200000);
  assert.strictEqual(resolveRecommendedContextWindow('claude-3-opus', 300000), 200000);
  assert.strictEqual(resolveRecommendedContextWindow('claude-instant', 50000), 50000);

  // Gemini cap: 370,000
  assert.strictEqual(resolveRecommendedContextWindow('gemini-1.5-pro'), 370000);
  assert.strictEqual(resolveRecommendedContextWindow('gemini-2.0-flash', 1000000), 370000);
  assert.strictEqual(resolveRecommendedContextWindow('gemini-1.0', 32000), 32000);

  // General default cap: 128,000
  assert.strictEqual(resolveRecommendedContextWindow('llama3.3:70b'), 128000);
  assert.strictEqual(resolveRecommendedContextWindow('deepseek-r1:32b', 65536), 65536);
  assert.strictEqual(resolveRecommendedContextWindow('mistral-large', 500000), 128000);
});

test('providers: toPiModelFromCPA maps CPA model fields, reasoning, thinkingLevelMap, vision and caps', () => {
  const cpaModel = {
    slug: 'cpa-claude-3-7-sonnet',
    display_name: 'Claude 3.7 Sonnet (Thinking)',
    owned_by: 'Anthropic',
    context_window: 250000,
    max_tokens: 128000,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'high',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Low thinking' },
      { effort: 'medium', description: 'Medium thinking' },
      { effort: 'high', description: 'High thinking' },
    ],
  };

  const parsed = toPiModelFromCPA(cpaModel);
  assert.ok(parsed);
  assert.strictEqual(parsed.id, 'cpa-claude-3-7-sonnet');
  assert.deepStrictEqual(parsed.input_modalities, ['text', 'image']);
  assert.strictEqual(parsed.name, 'Claude 3.7 Sonnet (Thinking) (cpa-claude-3-7-sonnet)');
  assert.strictEqual(parsed.reasoning, true);
  assert.deepStrictEqual(parsed.input, ['text', 'image']);
  assert.strictEqual(parsed.contextWindow, 200000); // Claude cap 200,000
  assert.strictEqual(parsed.maxTokens, MAX_SAFE_OUTPUT_TOKENS); // Capped at MAX_SAFE_OUTPUT_TOKENS (65,536)
  assert.deepStrictEqual(parsed.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepStrictEqual(parsed.reasoningEfforts, ['low', 'medium', 'high']);
  assert.ok(parsed.thinkingLevelMap);
  assert.strictEqual(parsed.thinkingLevelMap.low, 'low');
  assert.strictEqual(parsed.thinkingLevelMap.medium, 'medium');
  assert.strictEqual(parsed.thinkingLevelMap.high, 'high');
  assert.strictEqual(parsed.thinkingLevelMap.minimal, null);
  assert.strictEqual(parsed.thinkingLevel, 'high');
  assert.strictEqual(parsed.defaultThinkingLevel, 'high');
});

test('providers: toPiModelFromOpenAI classifies reasoning and vision via capabilities and naming', () => {
  // Reasoning model with capabilities and vision
  const openAiModel = {
    id: 'o1-preview',
    owned_by: 'system',
    context_length: 128000,
    max_output_tokens: 32768,
    capabilities: {
      reasoning: true,
      vision: true,
    },
  };

  const parsed = toPiModelFromOpenAI(openAiModel);
  assert.ok(parsed);
  assert.strictEqual(parsed.id, 'o1-preview');
  assert.strictEqual(parsed.reasoning, true);
  assert.deepStrictEqual(parsed.input, ['text', 'image']);
  assert.strictEqual(parsed.contextWindow, 128000);
  assert.strictEqual(parsed.maxTokens, 32768);
  assert.deepStrictEqual(parsed.reasoningEfforts, ['low', 'medium', 'high']);
  assert.ok(parsed.thinkingLevelMap);
  assert.strictEqual(parsed.thinkingLevelMap.low, 'low');
  assert.strictEqual(parsed.thinkingLevel, 'medium');
  assert.strictEqual(parsed.defaultThinkingLevel, 'medium');

  // Plain non-reasoning text-only model
  const plainModel = {
    id: 'deepseek-coder:6.7b',
    owned_by: 'ollama',
  };
  const parsedPlain = toPiModelFromOpenAI(plainModel);
  assert.ok(parsedPlain);
  assert.strictEqual(parsedPlain.id, 'deepseek-coder:6.7b');
  assert.strictEqual(parsedPlain.reasoning, undefined);
  assert.strictEqual(parsedPlain.thinkingLevel, undefined);
  assert.strictEqual(parsedPlain.defaultThinkingLevel, undefined);
  assert.deepStrictEqual(parsedPlain.input, ['text']);
  assert.strictEqual(parsedPlain.contextWindow, 128000);
  assert.strictEqual(parsedPlain.maxTokens, DEFAULT_MAX_TOKENS);
  assert.strictEqual(parsedPlain.thinkingLevelMap, undefined);
  assert.strictEqual(parsedPlain.reasoningEfforts, undefined);
});

test('providers: arrayToProvidersMap preserves thinkingLevelMap, reasoningEfforts, and cost', () => {
  const providerWithEnrichedModel: CustomProviderConfig = {
    id: 'test-cpa',
    baseUrl: 'http://127.0.0.1:8317/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'cpa-o3-mini',
        name: 'O3 Mini',
        contextWindow: 200000,
        maxTokens: 65536,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
  };

  const map = arrayToProvidersMap([providerWithEnrichedModel]);
  const modelEntry = map['test-cpa'].models[0];
  assert.strictEqual(modelEntry.id, 'cpa-o3-mini');
  assert.strictEqual(modelEntry.reasoning, true);
  assert.deepStrictEqual(modelEntry.input, ['text', 'image']);
  assert.deepStrictEqual(modelEntry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepStrictEqual(modelEntry.thinkingLevelMap, { off: null, low: 'low', medium: 'medium', high: 'high' });
  assert.deepStrictEqual(modelEntry.reasoningEfforts, ['low', 'medium', 'high']);
});

test('providers: fetchProviderModels queries client_version=1 first when targeting CLIProxyAPI', async () => {
  const requestedUrls: string[] = [];

  const mockFetch: typeof fetch = async (input: RequestInfo | URL) => {
    requestedUrls.push(input.toString());
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { slug: 'cpa-gpt-4o', display_name: 'GPT-4o (CLIProxy)', context_window: 128000 },
        ],
      }),
    } as unknown as Response;
  };

  const models = await fetchProviderModels(
    'http://127.0.0.1:8317/v1',
    'openai-completions',
    'test-key',
    { fetchFn: mockFetch }
  );

  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, 'cpa-gpt-4o');
  // First request should be with ?client_version=1
  assert.ok(requestedUrls.some((u) => u.includes('client_version=1')));
});

test('providers: gpt-6-astra and astra are classified as reasoning models with 272k context cap', () => {
  // 1. OpenAI format with gpt-6-astra
  const openaiAstra = toPiModelFromOpenAI({
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
  });
  assert.ok(openaiAstra);
  assert.strictEqual(openaiAstra.id, 'gpt-6-astra');
  assert.strictEqual(openaiAstra.reasoning, true);
  assert.deepStrictEqual(openaiAstra.reasoningEfforts, ['low', 'medium', 'high']);
  assert.ok(openaiAstra.thinkingLevelMap);
  assert.strictEqual(openaiAstra.thinkingLevelMap.low, 'low');
  assert.strictEqual(openaiAstra.contextWindow, 272000);

  // 2. CPA format with astra in slug
  const cpaAstra = toPiModelFromCPA({
    slug: 'astra-preview-2025',
    display_name: 'Astra Preview',
  });
  assert.ok(cpaAstra);
  assert.strictEqual(cpaAstra.id, 'astra-preview-2025');
  assert.strictEqual(cpaAstra.reasoning, true);
  assert.deepStrictEqual(cpaAstra.reasoningEfforts, ['low', 'medium', 'high']);
  assert.ok(cpaAstra.thinkingLevelMap);
  assert.strictEqual(cpaAstra.contextWindow, 272000);

  // 3. resolveRecommendedContextWindow directly
  assert.strictEqual(resolveRecommendedContextWindow('gpt-6-astra'), 272000);
  assert.strictEqual(resolveRecommendedContextWindow('astra-exp'), 272000);
});

test('providers: isModelExcluded correctly matches exact IDs and wildcards', () => {
  const excludedList = ['dall-e*', 'tts-*', 'babbage-002', '*deprecated'];

  assert.strictEqual(isModelExcluded('dall-e-3', excludedList), true);
  assert.strictEqual(isModelExcluded('DALL-E-2', excludedList), true);
  assert.strictEqual(isModelExcluded('tts-1', excludedList), true);
  assert.strictEqual(isModelExcluded('tts-1-hd', excludedList), true);
  assert.strictEqual(isModelExcluded('babbage-002', excludedList), true);
  assert.strictEqual(isModelExcluded('model-v1-deprecated', excludedList), true);

  // Non-excluded
  assert.strictEqual(isModelExcluded('gpt-4o', excludedList), false);
  assert.strictEqual(isModelExcluded('gpt-6-astra', excludedList), false);
  assert.strictEqual(isModelExcluded('llama3:8b', excludedList), false);
  assert.strictEqual(isModelExcluded('', excludedList), false);
  assert.strictEqual(isModelExcluded('gpt-4o', []), false);
  assert.strictEqual(isModelExcluded('gpt-4o', undefined), false);
});

test('providers: isModelExcluded supports delimited and unslashed regex patterns', () => {
  // Delimited regex patterns
  const delimitedList = ['/^gpt-[34]/i', '/dall-e|tts/', '/^audio/'];
  assert.strictEqual(isModelExcluded('gpt-3.5-turbo', delimitedList), true);
  assert.strictEqual(isModelExcluded('GPT-4O', delimitedList), true);
  assert.strictEqual(isModelExcluded('gpt-5', delimitedList), false);
  assert.strictEqual(isModelExcluded('chat-gpt-4', delimitedList), false);

  assert.strictEqual(isModelExcluded('dall-e-3', delimitedList), true);
  assert.strictEqual(isModelExcluded('TTS-1', delimitedList), true);
  assert.strictEqual(isModelExcluded('whisper-1', delimitedList), false);

  assert.strictEqual(isModelExcluded('audio-preview', delimitedList), true);
  assert.strictEqual(isModelExcluded('custom-audio', delimitedList), false);

  // Unslashed regex patterns
  const unslashedList = ['^gpt-[34]', '(tts|audio)'];
  assert.strictEqual(isModelExcluded('gpt-3.5-turbo', unslashedList), true);
  assert.strictEqual(isModelExcluded('gpt-4o', unslashedList), true);
  assert.strictEqual(isModelExcluded('gpt-5', unslashedList), false);
  assert.strictEqual(isModelExcluded('prefix-gpt-4', unslashedList), false);

  assert.strictEqual(isModelExcluded('tts-1', unslashedList), true);
  assert.strictEqual(isModelExcluded('my-audio-model', unslashedList), true);
  assert.strictEqual(isModelExcluded('text-model', unslashedList), false);
});

test('providers: isModelExcluded supports in-between wildcards and multi-wildcard patterns', () => {
  const wildcardList = ['*davinci*', 'gpt-*-turbo'];
  assert.strictEqual(isModelExcluded('text-davinci-003', wildcardList), true);
  assert.strictEqual(isModelExcluded('DAVINCI-instruct', wildcardList), true);
  assert.strictEqual(isModelExcluded('text-curie-001', wildcardList), false);

  assert.strictEqual(isModelExcluded('gpt-3.5-turbo', wildcardList), true);
  assert.strictEqual(isModelExcluded('gpt-4-turbo', wildcardList), true);
  assert.strictEqual(isModelExcluded('gpt-4o', wildcardList), false);
});

test('providers: isModelExcluded matches provider-prefixed IDs against base patterns and raw IDs', () => {
  // Matching baseId stripped of namespace prefix
  assert.strictEqual(isModelExcluded('openai/dall-e-3', ['dall-e*']), true);
  assert.strictEqual(isModelExcluded('openai/gpt-4o', ['^gpt-[34]']), true);
  assert.strictEqual(isModelExcluded('anthropic/claude-3-opus', ['/^claude-/']), true);
  assert.strictEqual(isModelExcluded('models/gemini-1.5-pro', ['gemini*']), true);
  assert.strictEqual(isModelExcluded('provider/babbage-002', ['babbage-002']), true);

  // Matching raw ID directly with provider namespace pattern
  assert.strictEqual(isModelExcluded('openai/gpt-4o', ['openai/*']), true);
  assert.strictEqual(isModelExcluded('anthropic/claude-3-opus', ['anthropic/*']), true);
  assert.strictEqual(isModelExcluded('google/gemini-pro', ['openai/*']), false);
});

test('providers: isModelExcluded handles invalid regex without throwing', () => {
  const invalidDelimited = ['/(unclosed/'];
  const invalidUnslashed = ['^gpt-[34', '(unclosed|test'];

  assert.doesNotThrow(() => {
    assert.strictEqual(isModelExcluded('gpt-4', invalidDelimited), false);
  });
  assert.doesNotThrow(() => {
    assert.strictEqual(isModelExcluded('gpt-4', invalidUnslashed), false);
  });
  // Fallback to literal exact match if raw pattern happens to match
  assert.strictEqual(isModelExcluded('(unclosed|test', invalidUnslashed), true);
});

test('providers: comma-separated pattern parsing and exclusion behavior', () => {
  const rawInput = ' dall-e* ,  tts-*,  /^gpt-[34]/ , dall-e* ';
  const patterns = rawInput
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  // Deduplication check
  const deduped: string[] = [];
  for (const p of patterns) {
    if (!deduped.includes(p)) {
      deduped.push(p);
    }
  }
  assert.deepStrictEqual(deduped, ['dall-e*', 'tts-*', '/^gpt-[34]/']);

  // Exclusion evaluation with deduped patterns
  assert.strictEqual(isModelExcluded('dall-e-3', deduped), true);
  assert.strictEqual(isModelExcluded('tts-1', deduped), true);
  assert.strictEqual(isModelExcluded('gpt-4o', deduped), true);
  assert.strictEqual(isModelExcluded('claude-3.5-sonnet', deduped), false);
});

test('providers: validateProviderConfig validates excludedModels', () => {
  const baseValid: CustomProviderConfig = {
    id: 'valid-id',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [{ id: 'm1' }],
  };

  assert.strictEqual(validateProviderConfig({ ...baseValid, excludedModels: ['dall-e*'] }).valid, true);
  assert.strictEqual(
    validateProviderConfig({ ...baseValid, excludedModels: 'not-array' as unknown as string[] }).valid,
    false
  );
  assert.strictEqual(
    validateProviderConfig({ ...baseValid, excludedModels: [123 as unknown as string] }).valid,
    false
  );
});

test('providers: arrayToProvidersMap and mapProvidersToArray roundtrip excludedModels', () => {
  const configWithExcluded: CustomProviderConfig = {
    id: 'prov-with-excluded',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    models: [{ id: 'm1' }],
    excludedModels: ['dall-e-3', 'whisper-*'],
  };

  const map = arrayToProvidersMap([configWithExcluded]);
  assert.deepStrictEqual(map['prov-with-excluded'].excludedModels, ['dall-e-3', 'whisper-*']);

  const arr = mapProvidersToArray(map);
  assert.strictEqual(arr.length, 1);
  assert.deepStrictEqual(arr[0].excludedModels, ['dall-e-3', 'whisper-*']);
});

test('providers: isModelIncluded correctly matches exact IDs, wildcards, and regex patterns', () => {
  const includedList = ['gpt-4*', 'claude-3-5-sonnet', '/^gemini-2/i', 'o1'];

  // Exact matches
  assert.strictEqual(isModelIncluded('claude-3-5-sonnet', includedList), true);
  assert.strictEqual(isModelIncluded('o1', includedList), true);

  // Wildcard matches
  assert.strictEqual(isModelIncluded('gpt-4o', includedList), true);
  assert.strictEqual(isModelIncluded('gpt-4-turbo', includedList), true);

  // Regex matches
  assert.strictEqual(isModelIncluded('gemini-2.0-flash', includedList), true);
  assert.strictEqual(isModelIncluded('gemini-1.5-pro', includedList), false);

  // Base ID stripping (provider prefixed)
  assert.strictEqual(isModelIncluded('openai/gpt-4o', includedList), true);
  assert.strictEqual(isModelIncluded('anthropic/claude-3-5-sonnet', includedList), true);
  assert.strictEqual(isModelIncluded('google/gemini-2.0-flash', includedList), true);

  // Non-included
  assert.strictEqual(isModelIncluded('gpt-3.5-turbo', includedList), false);
  assert.strictEqual(isModelIncluded('claude-3-haiku', includedList), false);
  assert.strictEqual(isModelIncluded('llama3:8b', includedList), false);
  assert.strictEqual(isModelIncluded('', includedList), false);
  assert.strictEqual(isModelIncluded('gpt-4o', []), false);
  assert.strictEqual(isModelIncluded('gpt-4o', undefined), false);
});

test('providers: isModelAllowed gives absolute precedence to includedModels over excludedModels', () => {
  // 1. When includedModels is non-empty, it overrides excludedModels
  const policyWithBoth = {
    includedModels: ['gpt-4*', 'claude-*'],
    excludedModels: ['gpt-4o', 'dall-e*'], // Notice gpt-4o is excluded here, BUT includedModels takes precedence!
  };

  // Model matches included AND excluded -> ALLOWED (because includedModels takes precedence)
  assert.strictEqual(isModelAllowed('gpt-4o', policyWithBoth), true);

  // Model matches included and not excluded -> ALLOWED
  assert.strictEqual(isModelAllowed('claude-3-5-sonnet', policyWithBoth), true);

  // Model does NOT match included, even though it's NOT in excludedModels -> NOT ALLOWED (only included allowed)
  assert.strictEqual(isModelAllowed('llama3:8b', policyWithBoth), false);
  assert.strictEqual(isModelAllowed('gpt-3.5-turbo', policyWithBoth), false);

  // Model does NOT match included and is in excludedModels -> NOT ALLOWED
  assert.strictEqual(isModelAllowed('dall-e-3', policyWithBoth), false);

  // 2. When includedModels is empty or undefined, excludedModels rules apply
  const policyExcludedOnly = {
    includedModels: [],
    excludedModels: ['gpt-3.5-turbo', 'dall-e*'],
  };
  assert.strictEqual(isModelAllowed('gpt-4o', policyExcludedOnly), true);
  assert.strictEqual(isModelAllowed('gpt-3.5-turbo', policyExcludedOnly), false);
  assert.strictEqual(isModelAllowed('dall-e-3', policyExcludedOnly), false);

  const policyExcludedOnlyNoInc = {
    excludedModels: ['dall-e*'],
  };
  assert.strictEqual(isModelAllowed('gpt-4o', policyExcludedOnlyNoInc), true);
  assert.strictEqual(isModelAllowed('dall-e-3', policyExcludedOnlyNoInc), false);

  // 3. When both are empty or undefined, all models are allowed
  assert.strictEqual(isModelAllowed('gpt-4o', { includedModels: [], excludedModels: [] }), true);
  assert.strictEqual(isModelAllowed('any-model', {}), true);
  assert.strictEqual(isModelAllowed('any-model', undefined), true);

  // 4. Empty or invalid modelId
  assert.strictEqual(isModelAllowed('', policyWithBoth), false);
});

test('providers: filterExcludedModels respects includedModels with precedence over excludedModels', () => {
  const models: ModelInfo[] = [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'gpt-4-turbo', provider: 'openai' },
    { id: 'gpt-3.5-turbo', provider: 'openai' },
    { id: 'dall-e-3', provider: 'openai' },
    { id: 'claude-3-5-sonnet', provider: 'anthropic' },
  ];

  const providersMap: CustomProvidersMap = {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [],
      includedModels: ['gpt-4*'],
      excludedModels: ['gpt-4-turbo', 'dall-e*'],
    },
  };

  const filtered = filterExcludedModels(models, providersMap);
  // openai: gpt-4o (allowed), gpt-4-turbo (allowed by include precedence), gpt-3.5-turbo (filtered), dall-e-3 (filtered)
  // anthropic: claude-3-5-sonnet (no policy -> kept)
  assert.strictEqual(filtered.length, 3);
  assert.deepStrictEqual(filtered.map((m) => m.id), ['gpt-4o', 'gpt-4-turbo', 'claude-3-5-sonnet']);

  // Array form
  const providersArray: CustomProviderConfig[] = [
    {
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [],
      includedModels: ['gpt-4o'],
    },
  ];
  const arrayFiltered = filterExcludedModels(models, providersArray);
  assert.strictEqual(arrayFiltered.some((m) => m.id === 'gpt-4o' && m.provider === 'openai'), true);
  assert.strictEqual(arrayFiltered.some((m) => m.id === 'gpt-4-turbo' && m.provider === 'openai'), false);
  assert.strictEqual(arrayFiltered.some((m) => m.id === 'claude-3-5-sonnet' && m.provider === 'anthropic'), true);
});

test('providers: validateProviderConfig validates includedModels', () => {
  const baseValid: CustomProviderConfig = {
    id: 'valid-id',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [{ id: 'm1' }],
  };

  assert.strictEqual(validateProviderConfig({ ...baseValid, includedModels: ['gpt-4*'] }).valid, true);
  assert.strictEqual(
    validateProviderConfig({ ...baseValid, includedModels: 'not-array' as unknown as string[] }).valid,
    false
  );
  assert.strictEqual(
    validateProviderConfig({ ...baseValid, includedModels: [123 as unknown as string] }).valid,
    false
  );
});

test('providers: arrayToProvidersMap and mapProvidersToArray roundtrip includedModels', () => {
  const configWithIncluded: CustomProviderConfig = {
    id: 'prov-with-included',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    models: [{ id: 'm1' }],
    includedModels: ['gpt-4*', 'claude-*'],
    excludedModels: ['deprecated-*'],
  };

  const map = arrayToProvidersMap([configWithIncluded]);
  assert.deepStrictEqual(map['prov-with-included'].includedModels, ['gpt-4*', 'claude-*']);
  assert.deepStrictEqual(map['prov-with-included'].excludedModels, ['deprecated-*']);

  const arr = mapProvidersToArray(map);
  assert.strictEqual(arr.length, 1);
  assert.deepStrictEqual(arr[0].includedModels, ['gpt-4*', 'claude-*']);
  assert.deepStrictEqual(arr[0].excludedModels, ['deprecated-*']);
});

test('providers: mergeDiscoveredModels filters existing models using isModelAllowed with includedList', () => {
  const existing: CustomModelDefinition[] = [
    { id: 'gpt-4o', name: 'Existing 4o' },
    { id: 'gpt-3.5-turbo', name: 'Existing 3.5' },
  ];
  const discovered: CustomModelDefinition[] = [
    { id: 'gpt-4o', name: 'Discovered 4o', contextWindow: 128000 },
    { id: 'claude-3-5-sonnet', name: 'Discovered Claude' },
  ];

  // With includedList taking precedence
  const merged = mergeDiscoveredModels(existing, discovered, ['gpt-4o'], ['gpt-4*']);
  assert.strictEqual(merged.some((m) => m.id === 'gpt-4o'), true);
  assert.strictEqual(merged.some((m) => m.id === 'gpt-3.5-turbo'), false);
  assert.strictEqual(merged.some((m) => m.id === 'claude-3-5-sonnet'), true);
});

test('providers: thinkingLevel and defaultThinkingLevel validate and roundtrip in arrayToProvidersMap and mapProvidersToArray', () => {
  const modelWithThinking: CustomModelDefinition = {
    id: 'deepseek-r1:32b',
    name: 'DeepSeek R1',
    reasoning: true,
    thinkingLevel: 'high',
    defaultThinkingLevel: 'high',
  };

  const validation = validateModelDefinition(modelWithThinking);
  assert.strictEqual(validation.valid, true);

  const providerConfig: CustomProviderConfig = {
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    models: [modelWithThinking],
  };

  const providersMap = arrayToProvidersMap([providerConfig]);
  assert.strictEqual(providersMap['ollama'].models[0].thinkingLevel, 'high');
  assert.strictEqual(providersMap['ollama'].models[0].defaultThinkingLevel, 'high');

  const remappedArray = mapProvidersToArray(providersMap);
  assert.strictEqual(remappedArray[0].models[0].thinkingLevel, 'high');
  assert.strictEqual(remappedArray[0].models[0].defaultThinkingLevel, 'high');

  const secondRoundtrip = arrayToProvidersMap(remappedArray);
  assert.deepStrictEqual(secondRoundtrip, providersMap);
});

test('providers: excluding models filters them from discovery and prevents re-addition', () => {
  const apiPayload = {
    data: [
      { id: 'gpt-4o' },
      { id: 'dall-e-3' },
      { id: 'tts-1' },
      { id: 'gpt-6-astra' },
    ],
  };

  const allModels = parseModelsFromApiResponse(apiPayload);
  assert.strictEqual(allModels.length, 4);

  const excluded = ['dall-e*', 'tts-*'];
  const filtered = allModels.filter((m) => !isModelExcluded(m.id, excluded));

  assert.strictEqual(filtered.length, 2);
  assert.strictEqual(filtered[0].id, 'gpt-4o');
  assert.strictEqual(filtered[1].id, 'gpt-6-astra');
  assert.strictEqual(filtered[1].reasoning, true);
});

test('providers: model editing updates properties and thinkingLevelMap', () => {
  const original: CustomModelDefinition = {
    id: 'my-model',
    name: 'Original Name',
    contextWindow: 32000,
    maxTokens: 4096,
    reasoning: false,
    input: ['text'],
  };

  const updatedWithReasoning: CustomModelDefinition = {
    ...original,
    name: 'Updated Astra Model',
    contextWindow: 272000,
    maxTokens: 16384,
    reasoning: true,
    input: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high'],
    thinkingLevelMap: buildStrictThinkingLevelMap(['low', 'medium', 'high']),
    thinkingLevel: 'low',
    defaultThinkingLevel: 'low',
  };

  const validation = validateModelDefinition(updatedWithReasoning);
  assert.strictEqual(validation.valid, true);
  assert.strictEqual(updatedWithReasoning.name, 'Updated Astra Model');
  assert.strictEqual(updatedWithReasoning.contextWindow, 272000);
  assert.strictEqual(updatedWithReasoning.reasoning, true);
  assert.strictEqual(updatedWithReasoning.thinkingLevel, 'low');
  assert.strictEqual(updatedWithReasoning.defaultThinkingLevel, 'low');
  assert.ok(updatedWithReasoning.thinkingLevelMap);
  assert.strictEqual(updatedWithReasoning.thinkingLevelMap.medium, 'medium');
  assert.deepStrictEqual(updatedWithReasoning.input, ['text', 'image']);
});

test('providers: filterExcludedModels returns models intact when providers map has no excludedModels', () => {
  const models: ModelInfo[] = [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'claude-3-5-sonnet', provider: 'anthropic' },
  ];

  // undefined/null providersMap
  assert.deepStrictEqual(filterExcludedModels(models, undefined), models);

  // Providers map without excludedModels
  const providersMap: CustomProvidersMap = {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [{ id: 'gpt-4o' }],
    },
  };
  assert.deepStrictEqual(filterExcludedModels(models, providersMap), models);

  // Empty models array
  assert.deepStrictEqual(filterExcludedModels([], providersMap), []);
});

test('providers: filterExcludedModels correctly filters out exact matches and wildcard matches for a specific provider', () => {
  const models: ModelInfo[] = [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'gpt-3.5-turbo', provider: 'openai' },
    { id: 'dall-e-3', provider: 'openai' },
    { id: 'tts-1', provider: 'openai' },
    { id: 'whisper-1', provider: 'openai' },
  ];

  const providersMap: CustomProvidersMap = {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [],
      excludedModels: ['gpt-3.5-turbo', 'dall-e*', '*1'],
    },
  };

  const filtered = filterExcludedModels(models, providersMap);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 'gpt-4o');

  // Array form
  const providersArray: CustomProviderConfig[] = [
    {
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [],
      excludedModels: ['gpt-3.5-turbo'],
    },
  ];
  const arrayFiltered = filterExcludedModels(models, providersArray);
  assert.strictEqual(arrayFiltered.some((m) => m.id === 'gpt-3.5-turbo'), false);
  assert.strictEqual(arrayFiltered.some((m) => m.id === 'gpt-4o'), true);
});

test('providers: filterExcludedModels leaves models from other providers untouched even if matching pattern', () => {
  const models: ModelInfo[] = [
    { id: 'dall-e-3', provider: 'openai' },
    { id: 'dall-e-3', provider: 'openrouter' },
    { id: 'claude-3-haiku', provider: 'anthropic' },
    { id: 'claude-3-haiku', provider: 'openrouter' },
  ];

  const providersMap: CustomProvidersMap = {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [],
      excludedModels: ['dall-e*'],
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      api: 'anthropic-messages',
      models: [],
      excludedModels: ['claude-3-haiku'],
    },
  };

  const filtered = filterExcludedModels(models, providersMap);
  assert.strictEqual(filtered.length, 2);
  // openai dall-e-3 filtered, openrouter dall-e-3 preserved
  // anthropic claude-3-haiku filtered, openrouter claude-3-haiku preserved
  assert.strictEqual(filtered[0].id, 'dall-e-3');
  assert.strictEqual(filtered[0].provider, 'openrouter');
  assert.strictEqual(filtered[1].id, 'claude-3-haiku');
  assert.strictEqual(filtered[1].provider, 'openrouter');
});

test('providers: resolveModelDefaultThinkingLevel priority and clamping logic', () => {
  // 1. Resolves from compound key provider/modelId in modelThinkingLevels
  const model1: ModelInfo = { id: 'claude-3-7-sonnet', provider: 'anthropic' };
  const levelsMap1: ModelThinkingLevelsMap = {
    'anthropic/claude-3-7-sonnet': 'high',
    'claude-3-7-sonnet': 'low',
  };
  assert.strictEqual(resolveModelDefaultThinkingLevel(model1, levelsMap1), 'high');

  // 2. Resolves from modelId key in modelThinkingLevels
  const model2: ModelInfo = { id: 'gpt-4o', provider: 'openai' };
  const levelsMap2: ModelThinkingLevelsMap = {
    'gpt-4o': 'low',
  };
  assert.strictEqual(resolveModelDefaultThinkingLevel(model2, levelsMap2), 'low');

  // 3. Resolves from model.thinkingLevel
  const model3 = { id: 'o3-mini', provider: 'openai', thinkingLevel: 'xhigh' as ThinkingLevel };
  assert.strictEqual(resolveModelDefaultThinkingLevel(model3, {}), 'xhigh');

  // 4. Resolves from model.defaultThinkingLevel
  const model4 = { id: 'deepseek-r1', provider: 'deepseek', defaultThinkingLevel: 'max' as ThinkingLevel };
  assert.strictEqual(resolveModelDefaultThinkingLevel(model4, {}), 'max');

  // 5. Falls back to 'medium'
  const model5: ModelInfo = { id: 'plain-model', provider: 'custom' };
  assert.strictEqual(resolveModelDefaultThinkingLevel(model5, {}), 'medium');
  assert.strictEqual(resolveModelDefaultThinkingLevel(null), 'medium');
  assert.strictEqual(resolveModelDefaultThinkingLevel(undefined), 'medium');
  assert.strictEqual(resolveModelDefaultThinkingLevel({ id: '' }), 'medium');

  // 6. Clamps to valid option in availableLevels
  // When availableLevels contains medium and resolved is not in availableLevels -> returns 'medium'
  const model6: ModelInfo = { id: 'o1', provider: 'openai' };
  const levelsMap6: ModelThinkingLevelsMap = { 'openai/o1': 'max' };
  const availableLevels1: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
  assert.strictEqual(resolveModelDefaultThinkingLevel(model6, levelsMap6, availableLevels1), 'medium');

  // When availableLevels does not contain medium and resolved is not in availableLevels -> returns availableLevels[0]
  const availableLevels2: ThinkingLevel[] = ['low', 'high'];
  assert.strictEqual(resolveModelDefaultThinkingLevel(model6, levelsMap6, availableLevels2), 'low');

  // When resolved IS in availableLevels -> returns resolved
  const availableLevels3: ThinkingLevel[] = ['low', 'high', 'max'];
  assert.strictEqual(resolveModelDefaultThinkingLevel(model6, levelsMap6, availableLevels3), 'max');
});

test('providers: EXTENDED_THINKING_LEVELS and DEFAULT_REASONING_LEVELS contain expected levels', () => {
  assert.deepStrictEqual([...EXTENDED_THINKING_LEVELS], [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepStrictEqual([...DEFAULT_REASONING_LEVELS], ['low', 'medium', 'high']);
});

test('providers: getSupportedThinkingLevelsForModel returns supported levels from thinkingLevelMap (omitting null levels)', () => {
  const modelWithMap: CustomModelDefinition = {
    id: 'test-model',
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
  };
  const supported = getSupportedThinkingLevelsForModel(modelWithMap);
  assert.deepStrictEqual(supported, ['off', 'low', 'medium', 'high', 'xhigh']);

  const modelStandardMap: CustomModelDefinition = {
    id: 'test-standard',
    thinkingLevelMap: {
      off: 'off',
      low: 'low',
      medium: 'medium',
      high: 'high',
    },
  };
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel(modelStandardMap),
    ['off', 'minimal', 'low', 'medium', 'high']
  );
});

test('providers: getSupportedThinkingLevelsForModel returns supported levels from reasoningEfforts', () => {
  const modelWithEfforts: CustomModelDefinition = {
    id: 'test-efforts',
    reasoningEfforts: ['LOW', 'HIGH', 'max'],
  };
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel(modelWithEfforts),
    ['low', 'high', 'max']
  );

  const modelWithSingleEffort: CustomModelDefinition = {
    id: 'test-single',
    reasoningEfforts: ['medium'],
  };
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel(modelWithSingleEffort),
    ['medium']
  );
});

test('providers: getSupportedThinkingLevelsForModel returns ["off"] when reasoning is false', () => {
  const modelNoReasoning: CustomModelDefinition = {
    id: 'no-reasoning',
    reasoning: false,
  };
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel(modelNoReasoning),
    ['off']
  );
});

test('providers: getSupportedThinkingLevelsForModel defaults to ["low", "medium", "high"] for new/undefined models', () => {
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel(null),
    [...DEFAULT_REASONING_LEVELS]
  );
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel(undefined),
    [...DEFAULT_REASONING_LEVELS]
  );
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel({ id: 'new-model' }),
    ['low', 'medium', 'high']
  );
  assert.deepStrictEqual(
    getSupportedThinkingLevelsForModel({ id: 'reasoning-empty', reasoning: true }),
    ['low', 'medium', 'high']
  );
});

test('providers: clampThinkingLevelToSupported preserves already supported level', () => {
  const levels: ThinkingLevel[] = ['low', 'medium', 'high'];
  assert.strictEqual(clampThinkingLevelToSupported('low', levels), 'low');
  assert.strictEqual(clampThinkingLevelToSupported('medium', levels), 'medium');
  assert.strictEqual(clampThinkingLevelToSupported('high', levels), 'high');

  const levelsWithOff: ThinkingLevel[] = ['off', 'low'];
  assert.strictEqual(clampThinkingLevelToSupported('off', levelsWithOff), 'off');
  assert.strictEqual(clampThinkingLevelToSupported('low', levelsWithOff), 'low');
});

test('providers: resolveModelSelectionOutcome merges matched/updated model and resolves reasoning', () => {
  // 1. Model with its own reasoning flag set supports reasoning regardless of levels.
  const matched1: ModelInfo = { id: 'claude-3-7-sonnet', provider: 'anthropic', contextWindow: 150000 };
  const updated1: ModelInfo = { id: 'claude-3-7-sonnet', provider: 'anthropic', reasoning: true };
  const outcome1 = resolveModelSelectionOutcome(
    matched1,
    updated1,
    'claude-3-7-sonnet',
    'anthropic',
    [],
    {}
  );
  assert.strictEqual(outcome1.supportsReasoning, true);
  assert.strictEqual(outcome1.fullModel.contextWindow, 150000);
  assert.strictEqual(outcome1.defaultThinkingLevel, 'medium');

  // 2. No reasoning flag, but backend reports levels beyond just ['off'] -> supports reasoning.
  const outcome2 = resolveModelSelectionOutcome(
    undefined,
    { id: 'gpt-4o', provider: 'openai' },
    'gpt-4o',
    'openai',
    ['off', 'low', 'medium', 'high'],
    { 'openai/gpt-4o': 'high' }
  );
  assert.strictEqual(outcome2.supportsReasoning, true);
  assert.strictEqual(outcome2.defaultThinkingLevel, 'high');

  // 3. Backend reports only ['off'] -> does not support reasoning.
  const outcome3 = resolveModelSelectionOutcome(
    undefined,
    { id: 'plain-model', provider: 'custom' },
    'plain-model',
    'custom',
    ['off'],
    {}
  );
  assert.strictEqual(outcome3.supportsReasoning, false);
  assert.strictEqual(outcome3.defaultThinkingLevel, null);

  // 4. No levels reported at all and no reasoning flag -> does not support reasoning.
  const outcome4 = resolveModelSelectionOutcome(
    undefined,
    { id: 'plain-model-2', provider: 'custom' },
    'plain-model-2',
    'custom',
    [],
    {}
  );
  assert.strictEqual(outcome4.supportsReasoning, false);
  assert.strictEqual(outcome4.defaultThinkingLevel, null);

  // 5. `updatedModel` fields win over `matched`, and id/provider are always the requested ones.
  const matched5: ModelInfo = { id: 'old-id', provider: 'old-provider', contextWindow: 1000 };
  const updated5: ModelInfo = { id: 'ignored', provider: 'ignored', contextWindow: 2000 };
  const outcome5 = resolveModelSelectionOutcome(
    matched5,
    updated5,
    'new-id',
    'new-provider',
    [],
    {}
  );
  assert.strictEqual(outcome5.fullModel.id, 'new-id');
  assert.strictEqual(outcome5.fullModel.provider, 'new-provider');
  assert.strictEqual(outcome5.fullModel.contextWindow, 2000);

  // 6. `updatedModel.contextWindow` missing falls back to `matched.contextWindow`.
  const outcome6 = resolveModelSelectionOutcome(
    matched5,
    { id: 'new-id', provider: 'new-provider' },
    'new-id',
    'new-provider',
    [],
    {}
  );
  assert.strictEqual(outcome6.fullModel.contextWindow, 1000);

  // 7. `fullModel.input_modalities` retains `matched.input_modalities` when `updatedModel` omits `input_modalities`.
  const matchedWithModalities: ModelInfo = {
    id: 'modal-model',
    provider: 'custom',
    input_modalities: ['text', 'image', 'video', 'file', 'audio'],
  };
  const outcome7 = resolveModelSelectionOutcome(
    matchedWithModalities,
    { id: 'modal-model', provider: 'custom' },
    'modal-model',
    'custom',
    [],
    {}
  );
  assert.deepStrictEqual(
    outcome7.fullModel.input_modalities,
    ['text', 'image', 'video', 'file', 'audio']
  );
});

test('providers: clampThinkingLevelToSupported clamps to nearest supported level if unsupported', () => {
  const levels: ThinkingLevel[] = ['low', 'medium', 'high'];

  // 'minimal' -> forward search finds 'low'
  assert.strictEqual(clampThinkingLevelToSupported('minimal', levels), 'low');

  // 'off' -> forward search finds 'low'
  assert.strictEqual(clampThinkingLevelToSupported('off', levels), 'low');

  // 'max' -> forward search finishes, backward search finds 'high'
  assert.strictEqual(clampThinkingLevelToSupported('max', levels), 'high');

  // 'xhigh' -> forward search finishes, backward search finds 'high'
  assert.strictEqual(clampThinkingLevelToSupported('xhigh', levels), 'high');

  // Disjoint sets
  const highOnly: ThinkingLevel[] = ['high', 'max'];
  assert.strictEqual(clampThinkingLevelToSupported('off', highOnly), 'high');

  const lowOnly: ThinkingLevel[] = ['off', 'minimal'];
  assert.strictEqual(clampThinkingLevelToSupported('high', lowOnly), 'minimal');

  // Empty or fallback handling
  assert.strictEqual(clampThinkingLevelToSupported('high', []), 'medium');
  assert.strictEqual(clampThinkingLevelToSupported('high', ['medium']), 'medium');
});

test('providers: extractModelBaseId strips namespaces and prefixes accurately', () => {
  // Strips provider prefix
  assert.strictEqual(extractModelBaseId('anthropic/claude-3.5-sonnet'), 'claude-3.5-sonnet');
  assert.strictEqual(extractModelBaseId('openai/gpt-4o'), 'gpt-4o');
  assert.strictEqual(extractModelBaseId('google/gemini-2.0-flash-001'), 'gemini-2.0-flash-001');

  // Strips models/ prefix
  assert.strictEqual(extractModelBaseId('models/gemini-1.5-pro'), 'gemini-1.5-pro');
  assert.strictEqual(extractModelBaseId('models/google/gemini-1.5-pro'), 'gemini-1.5-pro');

  // Preserves bare model IDs
  assert.strictEqual(extractModelBaseId('claude-3.5-sonnet'), 'claude-3.5-sonnet');
  assert.strictEqual(extractModelBaseId('gpt-4o'), 'gpt-4o');
  assert.strictEqual(extractModelBaseId('deepseek-r1:7b'), 'deepseek-r1:7b');

  // Safe with empty, whitespace, or invalid types
  assert.strictEqual(extractModelBaseId(''), '');
  assert.strictEqual(extractModelBaseId('   '), '');
  assert.strictEqual(extractModelBaseId(null as unknown as string), '');
  assert.strictEqual(extractModelBaseId(undefined as unknown as string), '');
});

test('providers: enrichModelsWithModalities matches baseId and updates modalities and vision inputs', () => {
  const models: CustomModelDefinition[] = [
    { id: 'claude-3.5-sonnet', input: ['text'] },
    { id: 'custom-text-model', input: ['text'] },
    { id: 'already-enriched', input: ['text'], input_modalities: ['text', 'audio'] },
  ];

  const catalog = [
    {
      id: 'anthropic/claude-3.5-sonnet',
      architecture: {
        input_modalities: ['text', 'image'],
      },
    },
    {
      id: 'google/gemini-2.5-pro',
      architecture: {
        input_modalities: ['text', 'image', 'audio', 'file'],
      },
    },
  ];

  const enriched = enrichModelsWithModalities(models, catalog);
  assert.strictEqual(enriched.length, 3);

  // claude-3.5-sonnet matched against anthropic/claude-3.5-sonnet
  assert.strictEqual(enriched[0].id, 'claude-3.5-sonnet');
  assert.deepStrictEqual(enriched[0].input_modalities, ['text', 'image']);
  assert.deepStrictEqual(enriched[0].input, ['text', 'image']);

  // custom-text-model not in catalog, preserved intact
  assert.strictEqual(enriched[1].id, 'custom-text-model');
  assert.strictEqual(enriched[1].input_modalities, undefined);
  assert.deepStrictEqual(enriched[1].input, ['text']);

  // already-enriched model preserves its existing input_modalities
  assert.strictEqual(enriched[2].id, 'already-enriched');
  assert.deepStrictEqual(enriched[2].input_modalities, ['text', 'audio']);

  // Handles empty or null catalog / models gracefully
  assert.deepStrictEqual(enrichModelsWithModalities([], catalog), []);
  const unheuristicModels: CustomModelDefinition[] = [{ id: 'custom-text-model', input: ['text'] }];
  assert.deepStrictEqual(enrichModelsWithModalities(unheuristicModels, []), unheuristicModels);
});

test('providers: normalizeModelSlug strips suffixes and variant tags', () => {
  assert.strictEqual(normalizeModelSlug('agy_p1/gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.strictEqual(normalizeModelSlug('google/gemini-3.8-flash:batch'), 'gemini-3.8-flash');
  assert.strictEqual(normalizeModelSlug('cpa/claude-3-7-sonnet-thinking'), 'claude-3-7-sonnet');
  assert.strictEqual(normalizeModelSlug('deepseek-r1-high'), 'deepseek-r1');
  assert.strictEqual(normalizeModelSlug(''), '');
});

test('providers: inferHeuristicModalities detects multi-modal families', () => {
  assert.deepStrictEqual(inferHeuristicModalities('gemini-2.5-pro'), ['text', 'image', 'video', 'file', 'audio']);
  assert.deepStrictEqual(inferHeuristicModalities('claude-3-5-sonnet'), ['text', 'image', 'file']);
  assert.deepStrictEqual(inferHeuristicModalities('gpt-4o'), ['text', 'image', 'file']);
  assert.deepStrictEqual(inferHeuristicModalities('o1-preview'), ['text', 'image', 'file']);
  assert.deepStrictEqual(inferHeuristicModalities('o3-mini'), ['text', 'image', 'file']);
  assert.deepStrictEqual(inferHeuristicModalities('qwen-vl'), ['text', 'image']);
  assert.deepStrictEqual(inferHeuristicModalities('llama-3-8b'), undefined);
  assert.deepStrictEqual(inferHeuristicModalities(''), undefined);
});

test('providers: enrichModelsWithModalities supports two-tier catalog matching and heuristic fallback', () => {
  const models: CustomModelDefinition[] = [
    { id: 'agy_p1/gemini-3.8-flash-high', input: ['text'] },
  ];

  const catalog = [
    {
      id: 'google/gemini-3.8-flash',
      architecture: {
        input_modalities: ['text', 'image', 'video', 'file', 'audio'],
      },
    },
  ];

  const enriched = enrichModelsWithModalities(models, catalog);
  assert.strictEqual(enriched.length, 1);
  assert.strictEqual(enriched[0].id, 'agy_p1/gemini-3.8-flash-high');
  assert.deepStrictEqual(enriched[0].input_modalities, ['text', 'image', 'video', 'file', 'audio']);
  assert.deepStrictEqual(enriched[0].input, ['text', 'image']);
  assert.strictEqual(modelSupportsFiles(enriched[0]), true);

  // Heuristic fallback when catalog is empty
  const emptyCatalogEnriched = enrichModelsWithModalities(models, []);
  assert.strictEqual(emptyCatalogEnriched.length, 1);
  assert.deepStrictEqual(emptyCatalogEnriched[0].input_modalities, ['text', 'image', 'video', 'file', 'audio']);
  assert.deepStrictEqual(emptyCatalogEnriched[0].input, ['text', 'image']);
  assert.strictEqual(modelSupportsFiles(emptyCatalogEnriched[0]), true);

  // Model not in catalog falling back to heuristic
  const o3Model: CustomModelDefinition[] = [
    { id: 'custom-proxy/o3-mini-high', input: ['text'] },
  ];
  const o3Enriched = enrichModelsWithModalities(o3Model, catalog);
  assert.deepStrictEqual(o3Enriched[0].input_modalities, ['text', 'image', 'file']);

  // Model without catalog match and without heuristic remains intact
  const unknownModel: CustomModelDefinition[] = [
    { id: 'my-custom-model', input: ['text'] },
  ];
  const unknownEnriched = enrichModelsWithModalities(unknownModel, []);
  assert.strictEqual(unknownEnriched[0].input_modalities, undefined);
  assert.deepStrictEqual(unknownEnriched[0].input, ['text']);

  // Verify modelSupportsFiles directly with the exact object from acceptance criteria
  assert.strictEqual(
    modelSupportsFiles({ id: 'agy_p1/gemini-3.8-flash-high', input_modalities: ['text', 'image', 'video', 'file', 'audio'] }),
    true
  );
});

test('providers: enrichAvailableModelsWithConfig enriches models from custom providers and heuristic fallbacks', () => {
  const customProviders: CustomProvidersMap = {
    cpam: {
      baseUrl: 'https://api.cpam.test/v1',
      api: 'openai-completions',
      name: 'CPAM Provider',
      models: [
        {
          id: 'agy_p1/gemini-3.8-flash-high',
          name: 'Gemini 3.8 Flash High',
          input_modalities: ['text', 'image', 'video', 'file', 'audio'],
        },
      ],
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      api: 'anthropic-messages',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-3-7-sonnet',
          name: 'Claude 3.7 Sonnet',
          input_modalities: ['text', 'image', 'file'],
        },
      ],
    },
    local: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      name: 'Local Models',
      models: [
        {
          id: 'prefix/unique-base-model',
          name: 'Unique Base Model',
          input_modalities: ['text', 'image'],
        },
      ],
    },
  };

  // 1. Matching by provider/model id (e.g. provider 'cpam' and model 'agy_p1/gemini-3.8-flash-high' with input_modalities ['text', 'image', 'video', 'file', 'audio'])
  const modelsWithProvider: ModelInfo[] = [
    { id: 'agy_p1/gemini-3.8-flash-high', provider: 'cpam', name: 'Gemini 3.8 Flash High' },
  ];
  const enrichedByProvModel = enrichAvailableModelsWithConfig(modelsWithProvider, customProviders);
  assert.strictEqual(enrichedByProvModel.length, 1);
  assert.deepStrictEqual(
    enrichedByProvModel[0].input_modalities,
    ['text', 'image', 'video', 'file', 'audio']
  );

  // 2. Matching by bare id or baseId
  // Matching by bare id: model has different provider, but id matches 'claude-3-7-sonnet' from anthropic config
  const modelsBareId: ModelInfo[] = [
    { id: 'claude-3-7-sonnet', provider: 'other-provider', name: 'Claude Bare Match' },
  ];
  const enrichedBare = enrichAvailableModelsWithConfig(modelsBareId, customProviders);
  assert.deepStrictEqual(enrichedBare[0].input_modalities, ['text', 'image', 'file']);

  // Matching by baseId: config has 'prefix/unique-base-model', model has 'unique-base-model'
  const modelsBaseId: ModelInfo[] = [
    { id: 'unique-base-model', provider: 'custom', name: 'BaseId Match' },
  ];
  const enrichedBase = enrichAvailableModelsWithConfig(modelsBaseId, customProviders);
  assert.deepStrictEqual(enrichedBase[0].input_modalities, ['text', 'image']);

  // 3. Heuristic fallback (e.g. model 'google/gemini-pro' not in custom config gets ['text', 'image', 'video', 'file', 'audio'] from inferHeuristicModalities)
  const modelsHeuristic: ModelInfo[] = [
    { id: 'google/gemini-pro', provider: 'google', name: 'Gemini Pro' },
  ];
  const enrichedHeuristic = enrichAvailableModelsWithConfig(modelsHeuristic, customProviders);
  assert.deepStrictEqual(
    enrichedHeuristic[0].input_modalities,
    ['text', 'image', 'video', 'file', 'audio']
  );

  // 4. Test that already-present input_modalities on a model is preserved
  const modelsAlreadyPresent: ModelInfo[] = [
    {
      id: 'agy_p1/gemini-3.8-flash-high',
      provider: 'cpam',
      name: 'Gemini Preserved',
      input_modalities: ['text'],
    },
  ];
  const enrichedPreserved = enrichAvailableModelsWithConfig(modelsAlreadyPresent, customProviders);
  assert.deepStrictEqual(enrichedPreserved[0].input_modalities, ['text']);

  // 5. Test empty/null models and undefined providersMap handling safely
  assert.deepStrictEqual(enrichAvailableModelsWithConfig([], customProviders), []);
  assert.deepStrictEqual(enrichAvailableModelsWithConfig(null as unknown as ModelInfo[], customProviders), []);
  assert.deepStrictEqual(enrichAvailableModelsWithConfig(undefined as unknown as ModelInfo[], customProviders), []);

  const modelsWithUndefinedConfig: ModelInfo[] = [
    { id: 'non-heuristic-plain-model', provider: 'unknown', name: 'Plain' },
  ];
  const enrichedUndefinedConfig = enrichAvailableModelsWithConfig(modelsWithUndefinedConfig, undefined);
  assert.strictEqual(enrichedUndefinedConfig.length, 1);
  assert.strictEqual(enrichedUndefinedConfig[0].input_modalities, undefined);

  // Heuristic fallback works when providersMap is undefined
  const enrichedUndefinedWithHeuristic = enrichAvailableModelsWithConfig(modelsHeuristic, undefined);
  assert.deepStrictEqual(
    enrichedUndefinedWithHeuristic[0].input_modalities,
    ['text', 'image', 'video', 'file', 'audio']
  );
});

test('providers: modelSupportsFiles and modelSupportsInputModality check capabilities correctly', () => {
  // modelSupportsFiles via input_modalities
  assert.strictEqual(modelSupportsFiles({ id: 'm1', input_modalities: ['text', 'image'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm2', input_modalities: ['text', 'file'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm_video', input_modalities: ['text', 'video'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm_audio', input_modalities: ['text', 'audio'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm3', input_modalities: ['text'] }), false);

  // modelSupportsFiles fallback via input
  assert.strictEqual(modelSupportsFiles({ id: 'm4', input: ['text', 'image'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm5', input: ['text', 'file'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm_video_fallback', input: ['text', 'video'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm_audio_fallback', input: ['text', 'audio'] }), true);
  assert.strictEqual(modelSupportsFiles({ id: 'm6', input: ['text'] }), false);

  // modelSupportsFiles falsy handling
  assert.strictEqual(modelSupportsFiles(null), false);
  assert.strictEqual(modelSupportsFiles(undefined), false);
  assert.strictEqual(modelSupportsFiles({ id: 'm7' }), false);

  // modelSupportsInputModality case-insensitive checks
  const multiModal = {
    id: 'gemini-exp',
    input_modalities: ['text', 'image', 'audio', 'video', 'file'],
  };
  assert.strictEqual(modelSupportsInputModality(multiModal, 'image'), true);
  assert.strictEqual(modelSupportsInputModality(multiModal, 'IMAGE'), true);
  assert.strictEqual(modelSupportsInputModality(multiModal, 'audio'), true);
  assert.strictEqual(modelSupportsInputModality(multiModal, 'video'), true);
  assert.strictEqual(modelSupportsInputModality(multiModal, 'file'), true);
  assert.strictEqual(modelSupportsInputModality(multiModal, 'unknown'), false);

  // modelSupportsInputModality fallback via input
  const inputOnly = { id: 'model-x', input: ['text', 'image'] };
  assert.strictEqual(modelSupportsInputModality(inputOnly, 'image'), true);
  assert.strictEqual(modelSupportsInputModality(inputOnly, 'audio'), false);

  // modelSupportsInputModality edge cases
  assert.strictEqual(modelSupportsInputModality(null, 'image'), false);
  assert.strictEqual(modelSupportsInputModality(multiModal, ''), false);
});

test('providers: parseModelsFromApiResponse directly parses architecture and input_modalities', () => {
  // 1. OpenAI format with architecture.input_modalities (OpenRouter style)
  const openRouterPayload = {
    data: [
      {
        id: 'meta-llama/llama-3.2-11b-vision-instruct',
        name: 'Meta: Llama 3.2 11B Vision',
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
      },
    ],
  };
  const parsedOpenRouter = parseModelsFromApiResponse(openRouterPayload);
  assert.strictEqual(parsedOpenRouter.length, 1);
  assert.strictEqual(parsedOpenRouter[0].id, 'meta-llama/llama-3.2-11b-vision-instruct');
  assert.deepStrictEqual(parsedOpenRouter[0].input_modalities, ['text', 'image']);
  assert.deepStrictEqual(parsedOpenRouter[0].input, ['text', 'image']);

  // 2. Direct input_modalities on OpenAI format
  const directModalitiesPayload = {
    data: [
      {
        id: 'some-multimodal-model',
        input_modalities: ['text', 'image', 'audio'],
      },
    ],
  };
  const parsedDirect = parseModelsFromApiResponse(directModalitiesPayload);
  assert.strictEqual(parsedDirect.length, 1);
  assert.strictEqual(parsedDirect[0].id, 'some-multimodal-model');
  assert.deepStrictEqual(parsedDirect[0].input_modalities, ['text', 'image', 'audio']);
  assert.deepStrictEqual(parsedDirect[0].input, ['text', 'image']);

  // 3. CPA format with input_modalities
  const cpaPayload = {
    models: [
      {
        slug: 'cpa-gemini-2.0-flash',
        display_name: 'Gemini 2.0 Flash',
        input_modalities: ['text', 'image', 'file'],
      },
    ],
  };
  const parsedCpa = parseModelsFromApiResponse(cpaPayload);
  assert.strictEqual(parsedCpa.length, 1);
  assert.strictEqual(parsedCpa[0].id, 'cpa-gemini-2.0-flash');
  assert.deepStrictEqual(parsedCpa[0].input_modalities, ['text', 'image', 'file']);
  assert.deepStrictEqual(parsedCpa[0].input, ['text', 'image']);
});

test('providers: fetchOpenRouterModelsCatalog fetches, caches, and handles errors', async () => {
  clearOpenRouterCatalogCache();

  let fetchCalls = 0;
  const mockFetch: typeof fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-3.5-sonnet',
            architecture: { input_modalities: ['text', 'image'] },
          },
        ],
      }),
    } as unknown as Response;
  };

  // First fetch calls network
  const cat1 = await fetchOpenRouterModelsCatalog(mockFetch);
  assert.strictEqual(cat1.length, 1);
  assert.strictEqual(fetchCalls, 1);

  // Second fetch hits cache
  const cat2 = await fetchOpenRouterModelsCatalog(mockFetch);
  assert.strictEqual(cat2.length, 1);
  assert.strictEqual(fetchCalls, 1);

  // Clear cache and fetch again
  clearOpenRouterCatalogCache();
  const cat3 = await fetchOpenRouterModelsCatalog(mockFetch);
  assert.strictEqual(cat3.length, 1);
  assert.strictEqual(fetchCalls, 2);

  // Error handling returns empty array
  clearOpenRouterCatalogCache();
  const failingFetch: typeof fetch = async () => {
    throw new Error('Network offline');
  };
  const catError = await fetchOpenRouterModelsCatalog(failingFetch);
  assert.deepStrictEqual(catError, []);

  clearOpenRouterCatalogCache();
});

test('providers: arrayToProvidersMap preserves input_modalities', () => {
  const providers: CustomProviderConfig[] = [
    {
      id: 'custom-ai',
      baseUrl: 'https://api.custom.ai/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'custom-vision',
          name: 'Custom Vision',
          input: ['text', 'image'],
          input_modalities: ['text', 'image', 'file'],
        },
      ],
    },
  ];

  const map = arrayToProvidersMap(providers);
  assert.deepStrictEqual(map['custom-ai'].models[0].input_modalities, ['text', 'image', 'file']);

  const backToArray = mapProvidersToArray(map);
  assert.deepStrictEqual(backToArray[0].models[0].input_modalities, ['text', 'image', 'file']);
});

test('providers: fetchProviderModels enriches models with OpenRouter catalog when matching base ID', async () => {
  clearOpenRouterCatalogCache();

  const mockFetch: typeof fetch = async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === OPENROUTER_MODELS_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'anthropic/claude-3.5-sonnet',
              architecture: { input_modalities: ['text', 'image'] },
            },
          ],
        }),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'claude-3.5-sonnet' },
        ],
      }),
    } as unknown as Response;
  };

  const models = await fetchProviderModels(
    'https://api.anthropic.com/v1',
    'anthropic-messages',
    'test-key',
    { fetchFn: mockFetch }
  );

  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, 'claude-3.5-sonnet');
  assert.deepStrictEqual(models[0].input_modalities, ['text', 'image']);
  assert.deepStrictEqual(models[0].input, ['text', 'image']);

  clearOpenRouterCatalogCache();
});

test('providers: mergeCustomProviderAdditive preserves unrelated root keys, other providers, and merges model unknown fields', () => {
  const existingConfig = {
    customRootProperty: 'do-not-delete',
    providers: {
      unrelatedProv: {
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        models: [{ id: 'llama3:8b' }],
      },
      targetProv: {
        baseUrl: 'https://api.old.com/v1',
        api: 'openai-completions',
        unknownProviderProp: 'keep-me',
        models: [
          {
            id: 'model-a',
            name: 'Old Model A',
            contextWindow: 32000,
            unknownModelProp: 'preserve-model-prop',
          },
          {
            id: 'unmatched-model',
            name: 'Preserved Unmatched Model',
          },
        ],
      },
    },
  };

  const updatedTargetProv: CustomProviderConfig = {
    id: 'targetProv',
    baseUrl: 'https://api.new.com/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'model-a',
        name: 'New Model A',
        maxTokens: 4096,
      },
      {
        id: 'model-b',
        name: 'Model B',
      },
    ],
  };

  const merged = mergeCustomProviderAdditive(existingConfig, updatedTargetProv);

  // Root keys preserved
  assert.strictEqual((merged as Record<string, unknown>).customRootProperty, 'do-not-delete');

  // Unrelated provider preserved
  assert.strictEqual(merged.providers?.unrelatedProv?.baseUrl, 'http://localhost:11434/v1');

  // Target provider updated baseUrl and preserved unknown provider property
  const targetObj = merged.providers?.targetProv as Record<string, unknown>;
  assert.strictEqual(targetObj.baseUrl, 'https://api.new.com/v1');
  assert.strictEqual(targetObj.unknownProviderProp, 'keep-me');

  // Target models merged keyed on id: unknownModelProp preserved on model-a, unmatched-model preserved
  const models = targetObj.models as Record<string, unknown>[];
  assert.strictEqual(models.length, 3);
  assert.strictEqual(models[0].id, 'model-a');
  assert.strictEqual(models[0].name, 'New Model A');
  assert.strictEqual(models[0].maxTokens, 4096);
  assert.strictEqual(models[0].contextWindow, 32000);
  assert.strictEqual(models[0].unknownModelProp, 'preserve-model-prop');

  assert.strictEqual(models[1].id, 'model-b');
  assert.strictEqual(models[1].name, 'Model B');

  assert.strictEqual(models[2].id, 'unmatched-model');
  assert.strictEqual(models[2].name, 'Preserved Unmatched Model');
});

test('providers: removeCustomProviderFromConfig removes target and preserves other keys', () => {
  const existingConfig = {
    rootMeta: 42,
    providers: {
      keepProv: { baseUrl: 'http://localhost:8000', api: 'openai-completions', models: [] },
      deleteProv: { baseUrl: 'http://localhost:9000', api: 'openai-completions', models: [] },
    },
  };

  const result = removeCustomProviderFromConfig(existingConfig, 'deleteProv');
  assert.strictEqual((result as Record<string, unknown>).rootMeta, 42);
  assert.strictEqual(result.providers?.keepProv?.baseUrl, 'http://localhost:8000');
  assert.strictEqual(result.providers?.deleteProv, undefined);
});

test('bridge: upsertCustomProviderPi and deleteCustomProviderPi operate targetedly in preview / mock invoke', async () => {
  const mockStorage = new Map<string, string>();
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === 'get_custom_providers') {
      const stored = mockStorage.get('test_providers');
      return (stored ? JSON.parse(stored) : { providers: {} }) as T;
    }
    if (cmd === 'upsert_custom_provider') {
      const currentText = mockStorage.get('test_providers');
      const current = currentText ? JSON.parse(currentText) : { providers: {} };
      const prov = args?.provider as CustomProviderConfig;
      const provId = (args?.providerId as string) || prov.id;
      current.providers = current.providers || {};
      current.providers[provId] = prov;
      mockStorage.set('test_providers', JSON.stringify(current));
      return current as T;
    }
    if (cmd === 'delete_custom_provider') {
      const currentText = mockStorage.get('test_providers');
      const current = currentText ? JSON.parse(currentText) : { providers: {} };
      const provId = (args?.providerId as string) || (args?.id as string);
      if (current.providers) {
        delete current.providers[provId];
      }
      mockStorage.set('test_providers', JSON.stringify(current));
      return current as T;
    }
    throw new Error(`Unknown mock command: ${cmd}`);
  };

  // Upsert provider 1
  const prov1: CustomProviderConfig = {
    id: 'prov-one',
    baseUrl: 'https://api.one.com/v1',
    api: 'openai-completions',
    models: [{ id: 'model-1' }],
  };
  await upsertCustomProviderPi(prov1, null, mockInvoke);

  // Upsert provider 2
  const prov2: CustomProviderConfig = {
    id: 'prov-two',
    baseUrl: 'https://api.two.com/v1',
    api: 'openai-completions',
    models: [{ id: 'model-2' }],
  };
  const afterTwo = await upsertCustomProviderPi(prov2, null, mockInvoke);
  assert.strictEqual(afterTwo.providers?.['prov-one']?.baseUrl, 'https://api.one.com/v1');
  assert.strictEqual(afterTwo.providers?.['prov-two']?.baseUrl, 'https://api.two.com/v1');

  // Delete provider 1: provider 2 remains
  const afterDelete = await deleteCustomProviderPi('prov-one', mockInvoke);
  assert.strictEqual(afterDelete.providers?.['prov-one'], undefined);
  assert.strictEqual(afterDelete.providers?.['prov-two']?.baseUrl, 'https://api.two.com/v1');
});

test('ProviderCard preview: renders provider info and model count heading but does NOT list individual model chips', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ProviderCard } = await import('@features/providers/components/ProviderCard');
  const { translate } = await import('@shared/i18n');

  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params);

  const mockProvider: CustomProviderConfig = {
    id: 'test-custom-provider',
    name: 'My Custom Provider',
    baseUrl: 'https://api.custom.com/v1',
    api: 'openai',
    models: [
      { id: 'custom-model-alpha', name: 'Alpha Model' },
      { id: 'custom-model-beta', name: 'Beta Model' },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(ProviderCard, {
      provider: mockProvider,
      deletingId: null,
      isSaving: false,
      isBusy: false,
      onOpenEditModal: () => {},
      onSetDeletingId: () => {},
      onDeleteProvider: () => {},
      t,
    })
  );

  assert.ok(html.includes('My Custom Provider'));
  assert.ok(html.includes('Models (2)'));
  assert.ok(!html.includes('provider-models-chips'), 'should not contain model chips container');
  assert.ok(!html.includes('custom-model-alpha'), 'should not list individual model alpha');
  assert.ok(!html.includes('custom-model-beta'), 'should not list individual model beta');
  assert.ok(html.includes('btn-edit-provider'), 'should have edit button');
  assert.ok(html.includes('btn-delete-provider'), 'should have delete button');
  assert.ok(!html.includes('provider-card-meta'), 'should not render base_url or api_key meta box');
  assert.ok(!html.includes('provider-id-badge'), 'should not render id badge');
  assert.ok(!html.includes('provider-protocol-badge'), 'should not render protocol badge');
});

test('providers: isPiBuiltinProvider identifies Pi built-in providers and retains real custom providers', async () => {
  const { isPiBuiltinProvider } = await import('@features/providers/providers');

  // Real custom providers with baseUrl and api protocol
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'my-ollama', baseUrl: 'http://localhost:11434', api: 'openai' }),
    false
  );
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'custom-proxy', baseUrl: 'https://proxy.local', api: 'anthropic' }),
    false
  );

  // Marked explicitly as isBuiltin
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'any-provider', isBuiltin: true }),
    true
  );

  // Known Pi built-in provider IDs
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'openai', baseUrl: 'https://api.openai.com/v1', api: 'openai' }),
    true
  );
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic' }),
    true
  );
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', api: 'openai' }),
    true
  );
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'google', baseUrl: 'https://generativelanguage.googleapis.com', api: 'google' }),
    true
  );

  // Built-in override without baseUrl and api protocol
  assert.strictEqual(
    isPiBuiltinProvider({ id: 'some-override-id' }),
    true
  );
});

test('ProvidersView: does NOT render Pi built-in providers in the Custom Providers section', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ProvidersView } = await import('@features/providers/ProvidersView');
  const { translate } = await import('@shared/i18n');

  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params);

  const mockCustomProvider: CustomProviderConfig = {
    id: 'local-ollama',
    name: 'Ollama Local',
    baseUrl: 'http://localhost:11434',
    api: 'openai',
    models: [{ id: 'llama3:8b', name: 'Llama 3 8B' }],
  };

  const mockBuiltinProvider1: CustomProviderConfig = {
    id: 'openai',
    name: 'OpenAI Override',
    models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    isBuiltin: true,
  };

  const mockBuiltinProvider2: CustomProviderConfig = {
    id: 'anthropic',
    name: 'Anthropic Override',
    models: [{ id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' }],
  };

  const html = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      t,
      language: 'en',
      providersDataOverride: {
        isLoading: false,
        providers: [mockCustomProvider, mockBuiltinProvider1, mockBuiltinProvider2],
        modelThinkingLevels: {},
      },
      oauthOverride: {
        accounts: [],
        isLoading: false,
        accountsError: null,
        activeProviderId: null,
        isStarting: false,
        isCancelling: false,
        statusMessage: null,
        authUrl: null,
        deviceCodeInfo: null,
        pendingPrompt: null,
        activeError: null,
        successNotice: null,
        confirmLogoutId: null,
        isLoggingOut: false,
        refreshAccounts: () => {},
        startLogin: () => {},
        cancelLogin: () => {},
        respondToPrompt: () => {},
        confirmLogout: () => {},
        cancelConfirmLogout: () => {},
        logoutProvider: () => {},
        setSuccessNotice: () => {},
        setActiveError: () => {},
        setAccountsError: () => {},
        dismissAccountsError: () => {},
      } as any,
    })
  );

  // Custom provider section exists and renders only the real custom provider
  assert.ok(html.includes('Ollama Local'), 'should render custom provider Ollama Local');
  assert.ok(html.includes('local-ollama'), 'should contain custom provider ID local-ollama');

  // Built-in providers MUST NOT be rendered in Custom Providers section
  assert.ok(!html.includes('OpenAI Override'), 'should NOT render OpenAI built-in provider in custom section');
  assert.ok(!html.includes('Anthropic Override'), 'should NOT render Anthropic built-in provider in custom section');

  // Badge count should be 1 (only Ollama Local), not 3
  assert.ok(html.includes('<span class="badge badge-subtle">1</span>'), 'custom providers count badge should be 1');
});





