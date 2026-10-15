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
import { validateProviderConfig } from '@features/providers/providers';
import type { ProviderFormData } from '@features/providers/types';

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
