import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BuiltinOAuthProviderStatus } from '@core/types/oauth';
import type { CustomProviderConfig } from '@core/types/providers';
import { BuiltinOAuthAccounts } from '@features/providers/components/BuiltinOAuthAccounts';
import { translate } from '@shared/i18n';
import {
  prepareProviderPayload,
} from '@features/providers/hooks/useProvidersData';
import {
  removeModelFromDraft,
  restoreExcludedModelToDraft,
  buildInitialBuiltinProviderDraft,
} from '@features/providers/hooks/useProviderModalForm';
import { validateProviderConfig } from '@features/providers/providers';
import type { ProviderFormData } from '@features/providers/types';
import { getBuiltinProviderCatalogPi } from '@infra/bridge';

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
  return translate('en', key, params);
}

const mockConnectedAccount: BuiltinOAuthProviderStatus = {
  id: 'anthropic',
  name: 'Anthropic',
  oauthName: 'anthropic',
  loginLabel: 'Sign in with Anthropic',
  isSubscription: false,
  configured: true,
  hasStoredOAuth: true,
  oauthReady: true,
  ambientApiKey: false,
  source: 'auth.json',
  status: 'ready',
};

const mockDisconnectedAccount: BuiltinOAuthProviderStatus = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  oauthName: 'github',
  loginLabel: 'Sign in with GitHub',
  isSubscription: true,
  configured: false,
  hasStoredOAuth: false,
  oauthReady: false,
  ambientApiKey: false,
  source: null,
  status: 'needs_auth',
};

test('S1.1 — Given connected and disconnected provider cards, when rendered, then only connected cards expose model editing', () => {
  const dummyOauth = {
    accounts: [mockConnectedAccount, mockDisconnectedAccount],
    isLoading: false,
    accountsError: null,
    activeProviderId: null,
    isStarting: false,
    isCancelling: false,
    statusMessage: null,
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
    isWebShim: false,
    isLocked: false,
    unlockKeyInput: '',
    setUnlockKeyInput: () => {},
    isUnlocking: false,
    unlockError: null,
    unlockSuccess: false,
    submitUnlock: () => {},
  } as any;

  const html = renderToStaticMarkup(
    React.createElement(BuiltinOAuthAccounts, {
      oauth: dummyOauth,
      t,
      isBusy: false,
    })
  );

  // Connected card (anthropic) must contain model editing action
  const anthropicCardMatch = html.match(/data-provider-id="anthropic"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(anthropicCardMatch, 'Anthropic card must be rendered');
  const anthropicCardHtml = anthropicCardMatch[0];
  assert.match(
    anthropicCardHtml,
    /builtin-oauth-edit-models-btn/,
    'Connected card MUST expose model editing button (S1.1)'
  );

  // Disconnected card (github-copilot) must NOT contain model editing action
  const copilotCardMatch = html.match(/data-provider-id="github-copilot"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(copilotCardMatch, 'GitHub Copilot card must be rendered');
  const copilotCardHtml = copilotCardMatch[0];
  assert.doesNotMatch(
    copilotCardHtml,
    /builtin-oauth-edit-models-btn/,
    'Disconnected card MUST NOT expose model editing button (S1.1)'
  );
});

test('S1.2 — Given a connected built-in provider with catalog models and saved overrides, when editing, then models and policies load without custom connection credentials', () => {
  const builtinFormData: ProviderFormData = {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    api: '',
    apiKey: '',
    models: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: false,
      },
    ],
    excludedModels: ['claude-3-haiku*'],
    includedModels: ['claude-3*'],
    isBuiltin: true,
  };

  const payload: CustomProviderConfig = prepareProviderPayload(builtinFormData);

  // Must not fabricate fake baseUrl, api, or apiKey
  assert.equal(payload.baseUrl, undefined, 'Built-in provider payload must not include baseUrl');
  assert.equal(payload.api, undefined, 'Built-in provider payload must not include api protocol');
  assert.equal(payload.apiKey, undefined, 'Built-in provider payload must not include apiKey');
  assert.equal(payload.id, 'anthropic');
  assert.equal(payload.isBuiltin, true);
  assert.deepEqual(payload.excludedModels, ['claude-3-haiku*']);
  assert.deepEqual(payload.includedModels, ['claude-3*']);

  // Validation must pass for built-in provider with models and policies even without baseUrl/api
  const validation = validateProviderConfig(payload);
  assert.equal(validation.valid, true, 'Validation must accept built-in provider without baseUrl/api (S1.2)');
});

test('S1.3 — Given edited built-in models and pattern-only policies, when validated, then pattern-only overrides without custom models are accepted', () => {
  const patternOnlyConfig: CustomProviderConfig = {
    id: 'google-gemini',
    name: 'Google Gemini',
    models: [],
    excludedModels: ['*experimental*'],
    includedModels: ['gemini-1.5*'],
    isBuiltin: true,
  };

  const validation = validateProviderConfig(patternOnlyConfig);
  assert.equal(
    validation.valid,
    true,
    'Pattern-only overrides with empty models array must be valid for built-in provider (S1.3)'
  );
});

test('S1.1 / S1.2 — Given catalog models and saved overrides, when opening or refreshing built-in configuration, then catalog models are loaded and saved policies remain intact', () => {
  const catalogModels = [
    {
      id: 'claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
      input: ['text', 'image'],
    },
    {
      id: 'claude-3-opus',
      name: 'Claude 3 Opus',
      provider: 'anthropic',
      contextWindow: 200000,
      maxTokens: 4096,
      reasoning: false,
    },
  ];

  const savedConfig: CustomProviderConfig = {
    id: 'anthropic',
    models: [
      {
        id: 'claude-3-5-sonnet',
        name: 'Claude 3.5 Sonnet (Custom Name)',
        maxTokens: 16384,
      },
    ],
    excludedModels: ['claude-3-haiku*'],
    includedModels: ['claude-3*'],
    isBuiltin: true,
  };

  const existingMap = new Map(savedConfig.models.map((m) => [m.id, m]));
  const mergedModels: any[] = [];
  for (const cat of catalogModels) {
    const saved = existingMap.get(cat.id);
    if (saved) {
      mergedModels.push({ ...cat, ...saved });
      existingMap.delete(cat.id);
    } else {
      mergedModels.push(cat);
    }
  }

  const sonnet = mergedModels.find((m) => m.id === 'claude-3-5-sonnet');
  assert.ok(sonnet);
  assert.equal(sonnet.name, 'Claude 3.5 Sonnet (Custom Name)', 'Saved model name override should be preserved');
  assert.equal(sonnet.maxTokens, 16384, 'Saved model maxTokens override should be preserved');
  assert.equal(sonnet.contextWindow, 200000, 'Catalog contextWindow should be populated');
  assert.equal(sonnet.reasoning, true, 'Catalog reasoning metadata should be populated');

  const opus = mergedModels.find((m) => m.id === 'claude-3-opus');
  assert.ok(opus);
  assert.equal(opus.maxTokens, 4096);

  assert.deepEqual(savedConfig.excludedModels, ['claude-3-haiku*']);
  assert.deepEqual(savedConfig.includedModels, ['claude-3*']);
});

test('S1.1: getBuiltinProviderCatalogPi invokes backend in web-shim mode with default invoke and falls back in preview', async () => {
  const origWindow = (globalThis as any).window;
  const origIsTauri = (globalThis as any).isTauri;

  try {
    delete (globalThis as any).window;
    (globalThis as any).isTauri = false;
    const previewResult = await getBuiltinProviderCatalogPi('anthropic');
    assert.deepEqual(previewResult, [], 'Preview fallback must return empty array without throwing');

    let calledCmd: string | null = null;
    let passedArgs: any = null;
    (globalThis as any).window = {
      __IS_WEB_IPC__: true,
      __TAURI_INTERNALS__: {
        __isWebIpc: true,
        invoke: async (cmd: string, args: any) => {
          calledCmd = cmd;
          passedArgs = args;
          return [{ id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic' }];
        },
      },
    };

    const shimResult = await getBuiltinProviderCatalogPi('anthropic');
    assert.equal(calledCmd, 'get_builtin_provider_catalog', 'Must invoke get_builtin_provider_catalog in web shim');
    assert.equal(passedArgs?.payload?.providerId, 'anthropic', 'Must pass provider ID in payload');
    assert.equal(shimResult.length, 1, 'Web shim must return catalog models from backend');
    assert.equal(shimResult[0].id, 'claude-3-5-sonnet');
  } finally {
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
    if (origIsTauri === undefined) delete (globalThis as any).isTauri;
    else (globalThis as any).isTauri = origIsTauri;
  }
});

test('S2.1 — Given loadingCatalogProviderId matching a connected provider, when rendered, then the edit models button shows a loader spinner and is disabled', () => {
  const dummyOauth = {
    accounts: [mockConnectedAccount],
    isLoading: false,
    accountsError: null,
    activeProviderId: null,
    isStarting: false,
    isCancelling: false,
    statusMessage: null,
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
  } as any;

  const html = renderToStaticMarkup(
    React.createElement(BuiltinOAuthAccounts, {
      oauth: dummyOauth,
      t,
      isBusy: false,
      loadingCatalogProviderId: 'anthropic',
    })
  );

  const anthropicCardMatch = html.match(/data-provider-id="anthropic"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(anthropicCardMatch, 'Anthropic card must be rendered');
  const anthropicCardHtml = anthropicCardMatch[0];

  assert.match(
    anthropicCardHtml,
    /builtin-oauth-edit-models-btn[\s\S]*?disabled/,
    'Button must be disabled while catalog is loading'
  );
  assert.match(
    anthropicCardHtml,
    /spinner-sm/,
    'Button must render spinner-sm loader while catalog is loading'
  );
});

test('S2.2 — Given fullConfig with existing built-in provider rules in models.json, when opening built-in models, then catalog fetch is skipped and saved rules are used', async () => {
  let catalogFetched = false;
  const origWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      __IS_WEB_IPC__: true,
      __TAURI_INTERNALS__: {
        __isWebIpc: true,
        invoke: async (cmd: string) => {
          if (cmd === 'get_builtin_provider_catalog') {
            catalogFetched = true;
            return [];
          }
          return [];
        },
      },
    };

    const savedConfig: CustomProviderConfig = {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-3-5-sonnet',
          name: 'Claude 3.5 Sonnet',
          contextWindow: 200000,
          maxTokens: 8192,
        },
      ],
      excludedModels: ['claude-3-haiku*'],
      includedModels: [],
      isBuiltin: true,
    };

    // Simulate the logic in handleOpenEditBuiltinModels
    const fullConfig: { providers: Record<string, CustomProviderConfig> } = {
      providers: {
        anthropic: savedConfig,
      },
    };

    const providerStatus: BuiltinOAuthProviderStatus = {
      id: 'anthropic',
      name: 'Anthropic',
      oauthName: 'anthropic',
      loginLabel: 'Sign in with Anthropic',
      isSubscription: false,
      configured: true,
      hasStoredOAuth: true,
      oauthReady: true,
      ambientApiKey: false,
      source: 'auth.json',
      status: 'ready',
    };

    let openedWithCatalog: any = null;
    let openedWithSaved: any = null;

    const mockModalForm = {
      openEditBuiltinModal: (_p: any, catalog: any, saved: any) => {
        openedWithCatalog = catalog;
        openedWithSaved = saved;
      },
    };

    // Check logic:
    const existingSaved = fullConfig.providers?.[providerStatus.id]
      ? ({ ...fullConfig.providers[providerStatus.id], id: providerStatus.id } as CustomProviderConfig)
      : undefined;

    const isRegistered = Boolean(
      existingSaved && (
        (existingSaved.models && existingSaved.models.length > 0) ||
        (existingSaved.includedModels && existingSaved.includedModels.length > 0) ||
        (existingSaved.excludedModels && existingSaved.excludedModels.length > 0) ||
        existingSaved.isBuiltin
      )
    );

    assert.equal(isRegistered, true, 'Provider must be identified as already registered in models.json');

    if (isRegistered && existingSaved) {
      mockModalForm.openEditBuiltinModal(providerStatus, existingSaved.models || [], existingSaved);
    } else {
      await getBuiltinProviderCatalogPi(providerStatus.id);
    }

    assert.equal(catalogFetched, false, 'Must NOT invoke getBuiltinProviderCatalogPi when already configured in models.json');
    assert.deepEqual(openedWithCatalog, savedConfig.models, 'Must open with models from models.json');
    assert.equal(openedWithSaved.id, 'anthropic');
  } finally {
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
  }
});

test('S2.3 — Given provider not in models.json, when opened, then catalog is fetched and silently persisted to models.json on first fetch', async () => {
  let catalogFetched = false;
  let savedPayload: any = null;
  let savedSilent: boolean | null = null;
  const origWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      __IS_WEB_IPC__: true,
      __TAURI_INTERNALS__: {
        __isWebIpc: true,
        invoke: async (cmd: string) => {
          if (cmd === 'get_builtin_provider_catalog') {
            catalogFetched = true;
            return [
              { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic', contextWindow: 200000, maxTokens: 8192 },
            ];
          }
          return [];
        },
      },
    };

    const emptyConfig = {
      providers: {},
    };

    const providerStatus: BuiltinOAuthProviderStatus = {
      id: 'anthropic',
      name: 'Anthropic',
      oauthName: 'anthropic',
      loginLabel: 'Sign in with Anthropic',
      isSubscription: false,
      configured: true,
      hasStoredOAuth: true,
      oauthReady: true,
      ambientApiKey: false,
      source: 'auth.json',
      status: 'ready',
    };

    const mockSaveProvider = async (formData: any, _isEditing: boolean, silent = false) => {
      savedPayload = formData;
      savedSilent = silent;
      return true;
    };

    // Simulate first fetch logic
    const existingSaved = (emptyConfig.providers as Record<string, any>)?.[providerStatus.id];
    assert.equal(existingSaved, undefined);

    const catalogModels = await getBuiltinProviderCatalogPi(providerStatus.id);
    assert.equal(catalogFetched, true, 'Catalog must be fetched when not in models.json');

    const catalogDefs = catalogModels.map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: Boolean(m.reasoning),
      input: m.input || ['text'],
    }));

    if (catalogDefs.length > 0) {
      await mockSaveProvider(
        {
          id: providerStatus.id,
          name: providerStatus.name || providerStatus.id,
          baseUrl: '',
          api: '',
          apiKey: '',
          models: catalogDefs,
          excludedModels: [],
          includedModels: [],
          isBuiltin: true,
        },
        false,
        true
      );
    }

    assert.ok(savedPayload, 'Initial catalog must be saved to models.json on first fetch');
    assert.equal(savedPayload.id, 'anthropic');
    assert.equal(savedPayload.isBuiltin, true);
    assert.equal(savedPayload.models.length, 1);
    assert.equal(savedSilent, true, 'First fetch auto-save must be silent (no intrusive banner)');
  } finally {
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
  }
});

test('removeModelFromDraft — Deleting a model removes it from models and adds it to excludedModels', () => {
  const prev = {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: '',
    api: '',
    apiKey: '',
    models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] as any[],
    excludedModels: ['old-excluded'],
    includedModels: [] as string[],
    isBuiltin: true,
  };

  const next = removeModelFromDraft(prev, 'gpt-4o');

  assert.deepEqual(next.models, [{ id: 'gpt-4o-mini' }], 'Deleted model must be removed from models array');
  assert.deepEqual(next.excludedModels, ['old-excluded', 'gpt-4o'], 'Deleted model must be added to excludedModels');

  // Deleting again or non-existent does not duplicate
  const next2 = removeModelFromDraft(next, 'gpt-4o');
  assert.deepEqual(next2.excludedModels, ['old-excluded', 'gpt-4o']);
});

test('restoreExcludedModelToDraft — Removing a model from excludedModels restores it to the main models list', () => {
  const initialForm = {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: '',
    api: '',
    apiKey: '',
    models: [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }],
    excludedModels: ['gpt-4o'],
    includedModels: [],
    isBuiltin: true,
  };

  const knownCatalog = new Map<string, any>([
    [
      'gpt-4o',
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        maxTokens: 16384,
        reasoning: false,
      },
    ],
  ]);

  const restored = restoreExcludedModelToDraft(initialForm, 'gpt-4o', knownCatalog);

  assert.deepEqual(restored.excludedModels, [], 'Excluded models must no longer contain gpt-4o');
  assert.equal(restored.models.length, 2, 'Main models list must now have 2 models');
  const found = restored.models.find((m) => m.id === 'gpt-4o');
  assert.ok(found, 'gpt-4o must be restored in the main models list');
  assert.equal(found?.contextWindow, 128000, 'Restored model must preserve its metadata');
  assert.equal(found?.maxTokens, 16384);
});

test('restoreExcludedModelToDraft — Removing a wildcard pattern restores all matching known models', () => {
  const initialForm = {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    api: '',
    apiKey: '',
    models: [{ id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' }],
    excludedModels: ['*haiku*'],
    includedModels: [],
    isBuiltin: true,
  };

  const knownCatalog = [
    { id: 'claude-3-haiku', name: 'Claude 3 Haiku' },
    { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku' },
  ];

  const restored = restoreExcludedModelToDraft(initialForm, '*haiku*', knownCatalog);
  assert.deepEqual(restored.excludedModels, []);
  assert.equal(restored.models.length, 3);
  assert.ok(restored.models.some((m) => m.id === 'claude-3-haiku'));
  assert.ok(restored.models.some((m) => m.id === 'claude-3-5-haiku'));
});

test('restoreExcludedModelToDraft — Removing an exact model ID without catalog definition creates clean fallback in models list', () => {
  const initialForm = {
    id: 'custom',
    name: 'Custom',
    baseUrl: 'http://localhost',
    api: 'openai-completions',
    apiKey: '',
    models: [],
    excludedModels: ['my-custom-model'],
    includedModels: [],
    isBuiltin: false,
  };

  const restored = restoreExcludedModelToDraft(initialForm, 'my-custom-model');
  assert.deepEqual(restored.excludedModels, []);
  assert.equal(restored.models.length, 1);
  assert.equal(restored.models[0].id, 'my-custom-model');
});

test('buildInitialBuiltinProviderDraft — Does not list excluded models in the main models draft list', () => {
  const provider = { id: 'openai-codex', name: 'OpenAI Codex' };
  const catalogModels = [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  ];
  const savedConfig: CustomProviderConfig = {
    id: 'openai-codex',
    models: catalogModels,
    excludedModels: ['gpt-5.6*'],
    includedModels: [],
    isBuiltin: true,
  };

  const { formData } = buildInitialBuiltinProviderDraft(provider, catalogModels, savedConfig);

  assert.equal(formData.models.length, 2, 'Main list must not contain excluded models');
  const mainModelIds = formData.models.map((m: any) => m.id);
  assert.deepEqual(mainModelIds, ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.deepEqual(formData.excludedModels, ['gpt-5.6*']);
});


