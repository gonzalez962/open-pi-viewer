import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  BuiltinOAuthProviderStatus,
  OAuthEventEnvelope,
  OAuthSafePrompt,
} from '@core/types/oauth';
import {
  getBuiltinOAuthProvidersPi,
  startOAuthLoginPi,
  cancelOAuthLoginPi,
  sendOAuthPromptResponsePi,
  logoutOAuthProviderPi,
  listenOAuthEventsPi,
} from '@infra/bridge';
import {
  isSafeVerificationUri,
  decideStartLoginAllowed,
  shouldProcessOAuthEvent,
  executeOAuthCancel,
  executeOAuthPromptResponse,
  executeUnmountOAuthCleanup,
  useBuiltinOAuthAccounts,
} from '@features/providers/hooks/useBuiltinOAuthAccounts';
import {
  authorizeWebOAuth,
  ensureWebOAuthSession,
  resetWebOAuthSessionForTest,
  isOAuthUnauthorizedError,
} from '@infra/web-oauth-access';
import { BuiltinOAuthAccounts } from '@features/providers/components/BuiltinOAuthAccounts';
import { ProvidersView } from '@features/providers/ProvidersView';
import { translate } from '@shared/i18n';

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
  return translate('en', key, params);
}

const mockBuiltinProviders: BuiltinOAuthProviderStatus[] = [
  {
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
  },
  {
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
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    oauthName: 'google',
    loginLabel: 'Sign in with Google',
    isSubscription: false,
    configured: false,
    hasStoredOAuth: false,
    oauthReady: false,
    ambientApiKey: true,
    source: null,
    status: 'ambient_key',
  },
];

// ============================================================================
// Bridge Method Tests
// ============================================================================

test('oauth bridge: getBuiltinOAuthProvidersPi invokes get_builtin_oauth_providers via custom invokeFn', async () => {
  const calls: string[] = [];
  const mockInvoke = async <T>(cmd: string): Promise<T> => {
    calls.push(cmd);
    return mockBuiltinProviders as unknown as T;
  };

  const res = await getBuiltinOAuthProvidersPi(mockInvoke);
  assert.deepEqual(calls, ['get_builtin_oauth_providers']);
  assert.equal(res.length, 3);
  assert.equal(res[0].id, 'anthropic');
  assert.equal(res[1].id, 'github-copilot');
  assert.equal(res[1].isSubscription, true);
});

test('oauth bridge: startOAuthLoginPi passes providerId payload correctly', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return { started: true, providerId: 'anthropic' } as unknown as T;
  };

  const res = await startOAuthLoginPi({ providerId: 'anthropic' }, mockInvoke);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'start_oauth_login');
  assert.deepEqual(calls[0].args, { payload: { providerId: 'anthropic' } });
  assert.equal(res.started, true);
  assert.equal(res.providerId, 'anthropic');
});

test('oauth bridge: cancelOAuthLoginPi passes optional providerId correctly', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return { cancelled: true } as unknown as T;
  };

  const res = await cancelOAuthLoginPi({ providerId: 'github-copilot' }, mockInvoke);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cancel_oauth_login');
  assert.deepEqual(calls[0].args, { payload: { providerId: 'github-copilot' } });
  assert.equal(res.cancelled, true);

  const resNoArgs = await cancelOAuthLoginPi(undefined, mockInvoke);
  assert.equal(calls.length, 2);
  assert.equal(resNoArgs.cancelled, true);
});

test('oauth bridge: sendOAuthPromptResponsePi forwards promptId and user response', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return { sent: true } as unknown as T;
  };

  const res = await sendOAuthPromptResponsePi(
    { promptId: 'prompt-1', response: 'auth-code-value' },
    mockInvoke
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'send_oauth_prompt_response');
  assert.deepEqual(calls[0].args, {
    payload: { promptId: 'prompt-1', response: 'auth-code-value' },
  });
  assert.equal(res.sent, true);
});

test('oauth bridge: logoutOAuthProviderPi passes providerId to remove credentials', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return { success: true, providerId: 'anthropic' } as unknown as T;
  };

  const res = await logoutOAuthProviderPi({ providerId: 'anthropic' }, mockInvoke);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'logout_oauth_provider');
  assert.deepEqual(calls[0].args, { payload: { providerId: 'anthropic' } });
  assert.equal(res.success, true);
});

test('oauth bridge: listenOAuthEventsPi registers on pi://oauth-event and receives envelopes', async () => {
  let registeredEvent = '';
  let listenerHandler: any = null;
  let unlistenCalled = false;

  const mockListen = async (
    event: string,
    handler: any
  ) => {
    registeredEvent = event;
    listenerHandler = handler;
    return () => {
      unlistenCalled = true;
    };
  };

  const received: OAuthEventEnvelope[] = [];
  const unlisten = await listenOAuthEventsPi((env) => {
    received.push(env);
  }, mockListen as any);

  assert.equal(registeredEvent, 'pi://oauth-event');
  assert.ok(listenerHandler !== null);

  // Dispatch mock event
  if (typeof listenerHandler === 'function') {
    listenerHandler({
      payload: {
        providerId: 'anthropic',
        kind: 'event',
        data: { type: 'progress', message: 'Connecting to auth server...' },
      },
    });
  }

  assert.equal(received.length, 1);
  assert.equal(received[0].providerId, 'anthropic');
  assert.equal((received[0].data as any).message, 'Connecting to auth server...');

  unlisten();
  assert.equal(unlistenCalled, true);
});

// ============================================================================
// Contract: Subscribe BEFORE invoke start
// ============================================================================

test('oauth contract: subscription to pi://oauth-event happens strictly BEFORE start_oauth_login invocation', async () => {
  const timeline: string[] = [];

  const mockListen = async (event: string, _handler: any) => {
    timeline.push(`listen:${event}`);
    return () => {
      timeline.push('unlisten');
    };
  };

  const mockInvoke = async (cmd: string, _args?: any) => {
    timeline.push(`invoke:${cmd}`);
    return { started: true, providerId: 'anthropic' };
  };

  // Simulating the start login sequence from useBuiltinOAuthAccounts
  const unlisten = await listenOAuthEventsPi((_e) => {}, mockListen as any);
  await startOAuthLoginPi({ providerId: 'anthropic' }, mockInvoke as any);

  assert.deepEqual(timeline, [
    'listen:pi://oauth-event',
    'invoke:start_oauth_login',
  ]);

  unlisten();
  assert.equal(timeline[2], 'unlisten');
});

// ============================================================================
// Markup and Component Tests
// ============================================================================

function createMockOAuthState(overrides: Partial<Parameters<typeof BuiltinOAuthAccounts>[0]['oauth']> = {}) {
  const defaultState: Parameters<typeof BuiltinOAuthAccounts>[0]['oauth'] = {
    accounts: mockBuiltinProviders,
    isLoading: false,
    accountsError: null,
    activeProviderId: null,
    isStarting: false,
    isCancelling: false,
    statusMessage: null,
    authUrl: null,
    authorizationUrl: null,
    deviceCodeInfo: null,
    pendingPrompt: null,
    activeError: null,
    successNotice: null,
    confirmLogoutId: null,
    isLoggingOut: false,
    refreshAccounts: async () => {},
    startLogin: async () => {},
    cancelLogin: async () => {},
    respondToPrompt: async () => {},
    confirmLogout: () => {},
    cancelConfirmLogout: () => {},
    logoutProvider: async () => {},
    setSuccessNotice: () => {},
    setActiveError: () => {},
    setAccountsError: () => {},
    dismissAccountsError: () => {},
    isLocked: false,
    isWebShim: false,
    isUnlocking: false,
    unlockError: null,
    unlockSuccess: false,
    unlockKeyInput: '',
    setUnlockKeyInput: () => {},
    submitUnlock: async () => true,
    resetUnlock: () => {},
  };

  return { ...defaultState, ...overrides };
}

test('BuiltinOAuthAccounts markup: renders section header, provider cards, and compact actions', () => {
  const oauth = createMockOAuthState();
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('Built-in Provider Accounts'));
  assert.ok(html.includes('Anthropic'));
  assert.ok(html.includes('GitHub Copilot'));
  assert.ok(html.includes('Google Gemini'));
  assert.ok(html.includes('Subscription / Pro'));
  assert.ok(html.includes('OAuth'));
  assert.ok(html.includes('Disconnect'));
  assert.ok(html.includes('Connect'));
});

test('BuiltinOAuthAccounts markup: renders empty state when accounts list is empty', () => {
  const oauth = createMockOAuthState({ accounts: [] });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('No Built-in OAuth Providers Available'));
  assert.ok(!html.includes('Anthropic'));
});

test('BuiltinOAuthAccounts markup: renders active sign-in panel with cancel button', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'github-copilot',
    statusMessage: 'Browser opened for authentication.',
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('is-active'));
  assert.ok(html.includes('Browser opened for authentication.'));
  assert.ok(html.includes('Cancel'));
});

test('BuiltinOAuthAccounts markup: renders device code block with user code and copy button', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'github-copilot',
    deviceCodeInfo: {
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresInSeconds: 900,
    },
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('ABCD-1234'));
  assert.ok(html.includes('https://github.com/login/device'));
  assert.ok(html.includes('Copy Code'));
  assert.ok(html.includes('Enter this code at the verification page:'));
});

test('BuiltinOAuthAccounts markup: renders interactive select prompt with options', () => {
  const selectPrompt: OAuthSafePrompt = {
    promptId: 'prompt-select-1',
    promptType: 'select',
    message: 'Select an organization or account:',
    options: [
      { id: 'org-a', label: 'Organization Alpha', description: 'Enterprise workspace' },
      { id: 'org-b', label: 'Organization Beta', description: 'Personal workspace' },
    ],
  };

  const oauth = createMockOAuthState({
    activeProviderId: 'anthropic',
    pendingPrompt: selectPrompt,
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('Select an organization or account:'));
  assert.ok(html.includes('Organization Alpha'));
  assert.ok(html.includes('Enterprise workspace'));
  assert.ok(html.includes('Organization Beta'));
});

test('BuiltinOAuthAccounts markup: renders manual_code prompt input', () => {
  const manualPrompt: OAuthSafePrompt = {
    promptId: 'prompt-code-1',
    promptType: 'manual_code',
    message: 'Paste the authorization code from your browser:',
    placeholder: 'Code from callback URL',
  };

  const oauth = createMockOAuthState({
    activeProviderId: 'anthropic',
    pendingPrompt: manualPrompt,
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('Paste the authorization code from your browser:'));
  assert.ok(html.includes('Code from callback URL'));
  assert.ok(html.includes('Submit'));
});

test('BuiltinOAuthAccounts markup: renders secret password prompt input', () => {
  const secretPrompt: OAuthSafePrompt = {
    promptId: 'prompt-secret-1',
    promptType: 'secret',
    message: 'Enter token passphrase:',
    placeholder: 'Passphrase',
  };

  const oauth = createMockOAuthState({
    activeProviderId: 'anthropic',
    pendingPrompt: secretPrompt,
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('Enter token passphrase:'));
});

test('BuiltinOAuthAccounts markup: renders disconnect confirmation dialog on logout confirm', () => {
  const oauth = createMockOAuthState({
    confirmLogoutId: 'anthropic',
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('Disconnect Anthropic?'));
  assert.ok(html.includes('Log Out'));
  assert.ok(html.includes('Cancel'));
});

test('BuiltinOAuthAccounts markup: renders error and success banners', () => {
  const oauth = createMockOAuthState({
    activeError: 'OAuth login cancelled by user',
    successNotice: 'Successfully signed in to Anthropic',
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('OAuth login cancelled by user'));
  assert.ok(html.includes('Successfully signed in to Anthropic'));
});

// ============================================================================
// ProvidersView Integration: Empty custom list does NOT hide OAuth section
// ============================================================================

test('ProvidersView integration: empty custom providers list displays both OAuth section and custom empty state without hiding OAuth', () => {
  const oauth = createMockOAuthState();

  // Rendering ProvidersView with oauthOverride and providersDataOverride to inspect structural layout
  const html = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      t,
      language: 'en',
      oauthOverride: oauth,
      providersDataOverride: {
        isLoading: false,
        providers: [],
      },
    })
  );

  // 1. Built-in OAuth section is fully rendered
  assert.ok(html.includes('builtin-oauth-section'), 'OAuth section must be rendered');
  assert.ok(html.includes('Built-in Provider Accounts'), 'OAuth section title must be visible');
  assert.ok(html.includes('Anthropic'), 'OAuth provider cards must be visible');

  // 2. Custom providers section is also rendered
  assert.ok(html.includes('custom-providers-section'), 'Custom providers section must be rendered');
  assert.ok(html.includes('Custom Providers (models.json)'), 'Custom providers heading must be visible');

  // 3. The empty state for custom providers exists INSIDE custom-providers-section
  assert.ok(html.includes('No Custom Providers Configured'), 'Custom empty state is shown');
  assert.ok(html.includes('Add external AI endpoints'), 'Custom empty state description is shown');
});

test('BuiltinOAuthAccounts markup: renders Spanish localized text accurately without English leaks', () => {
  const tEs = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string => {
    return translate('es', key, params);
  };

  const oauth = createMockOAuthState({
    confirmLogoutId: 'anthropic',
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t: tEs }));

  assert.ok(html.includes('Cuentas de proveedores integrados'));
  assert.ok(html.includes('Inicie sesión directamente en proveedores OAuth'));
  assert.ok(html.includes('¿Desconectar Anthropic?'));
  assert.ok(html.includes('Cerrar sesión'));
  assert.ok(html.includes('Cancelar'));
});

test('ProvidersView integration: renders both OAuth section and custom provider cards when custom providers exist', () => {
  const oauth = createMockOAuthState();
  const mockCustomProvider = {
    id: 'local-ollama',
    name: 'Ollama Local',
    baseUrl: 'http://localhost:11434',
    api: 'openai' as const,
    models: [
      {
        id: 'llama3:8b',
        name: 'Llama 3 8B',
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      t,
      language: 'en',
      oauthOverride: oauth,
      providersDataOverride: {
        isLoading: false,
        providers: [mockCustomProvider],
        modelThinkingLevels: {},
      },
    })
  );

  // Both sections present
  assert.ok(html.includes('builtin-oauth-section'));
  assert.ok(html.includes('Anthropic'));
  assert.ok(html.includes('custom-providers-section'));
  assert.ok(html.includes('local-ollama'));
  assert.ok(html.includes('Ollama Local'));
  // Empty state is NOT rendered
  assert.ok(!html.includes('No Custom Providers Configured'));
});

test('oauth bridge fallback: bridge methods handle browser preview environment fail-safely', async () => {
  // In node test environment isTauri() is false and default invoke is not available
  const providers = await getBuiltinOAuthProvidersPi();
  assert.deepEqual(providers, []);

  const loginRes = await startOAuthLoginPi({ providerId: 'anthropic' });
  assert.equal(loginRes.started, false);
  assert.ok(loginRes.message?.includes('Desktop runtime unavailable'));

  const cancelRes = await cancelOAuthLoginPi();
  assert.equal(cancelRes.cancelled, false);

  const promptRes = await sendOAuthPromptResponsePi({ promptId: 'p1', response: 'val' });
  assert.equal(promptRes.sent, false);

  const logoutRes = await logoutOAuthProviderPi({ providerId: 'anthropic' });
  assert.equal(logoutRes.success, false);

  let called = false;
  const unlisten = await listenOAuthEventsPi(() => {
    called = true;
  });
  assert.equal(typeof unlisten, 'function');
  unlisten();
  assert.equal(called, false);
});

// ============================================================================
// Functional Behavior & Edge Cases Tests (Confirmed T2 Requirements)
// ============================================================================

test('oauth cancel: executeOAuthCancel resets session only after successful IPC acknowledgment', async () => {
  let cancelCalledWith: any = null;
  const mockCancelFn = async (payload: { providerId?: string | null }) => {
    cancelCalledWith = payload;
    return { cancelled: true };
  };

  const outcome = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: mockCancelFn,
  });

  assert.deepEqual(cancelCalledWith, { providerId: 'anthropic' });
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.error, null);
  assert.equal(outcome.shouldResetSession, true);
});

test('oauth cancel: executeOAuthCancel preserves cancellation failure when IPC returns cancelled: false and does NOT reset session', async () => {
  const mockCancelFn = async () => {
    return { cancelled: false, message: 'Backend worker refused abort' };
  };

  const outcome = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: mockCancelFn,
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.error, 'Backend worker refused abort');
  assert.equal(outcome.shouldResetSession, false, 'Session must not be reset on cancellation failure');
});

test('oauth cancel: executeOAuthCancel preserves cancellation failure when IPC throws and does NOT reset session', async () => {
  const mockCancelFn = async () => {
    throw new Error('IPC channel connection reset');
  };

  const outcome = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: mockCancelFn,
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.error, 'IPC channel connection reset');
  assert.equal(outcome.shouldResetSession, false, 'Session must not be reset when cancellation throws');
});

test('oauth cancel: executeOAuthCancel safely handles missing providerId', async () => {
  const outcome = await executeOAuthCancel({
    providerId: null,
    cancelFn: async () => ({ cancelled: true }),
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.shouldResetSession, false);
});

test('oauth concurrency: decideStartLoginAllowed holds start disabled when cancelling or active', () => {
  // 1. Idle: start is allowed
  assert.equal(decideStartLoginAllowed(null, false), true);

  // 2. Active login in flight: start is blocked
  assert.equal(decideStartLoginAllowed('anthropic', false), false);

  // 3. Complete cancellation in-flight (backend events only have providerId so must hold disabled): blocked
  assert.equal(decideStartLoginAllowed(null, true), false);

  // 4. Both active and cancelling: blocked
  assert.equal(decideStartLoginAllowed('anthropic', true), false);
});

test('oauth prompt: executeOAuthPromptResponse preserves pending prompt on send IPC failure (sent: false)', async () => {
  const mockSendFn = async () => {
    return { sent: false, message: 'OAuth helper child process disconnected' };
  };

  const outcome = await executeOAuthPromptResponse({
    promptId: 'p-auth-1',
    response: 'secret-code',
    sendFn: mockSendFn,
  });

  assert.equal(outcome.sent, false);
  assert.equal(outcome.error, 'OAuth helper child process disconnected');
  assert.equal(outcome.shouldClearPrompt, false, 'Prompt must stay on send IPC failure');
});

test('oauth prompt: executeOAuthPromptResponse preserves pending prompt when sendFn throws', async () => {
  const mockSendFn = async () => {
    throw new Error('IPC timeout waiting for response ACK');
  };

  const outcome = await executeOAuthPromptResponse({
    promptId: 'p-auth-2',
    response: 'my-token',
    sendFn: mockSendFn,
  });

  assert.equal(outcome.sent, false);
  assert.equal(outcome.error, 'IPC timeout waiting for response ACK');
  assert.equal(outcome.shouldClearPrompt, false, 'Prompt must stay when send throws');
});

test('oauth prompt: executeOAuthPromptResponse clears prompt only on successful send acknowledgment', async () => {
  let capturedPayload: any = null;
  const mockSendFn = async (payload: any) => {
    capturedPayload = payload;
    return { sent: true };
  };

  const outcome = await executeOAuthPromptResponse({
    promptId: 'p-auth-3',
    response: 'org-beta',
    sendFn: mockSendFn,
  });

  assert.deepEqual(capturedPayload, { promptId: 'p-auth-3', response: 'org-beta' });
  assert.equal(outcome.sent, true);
  assert.equal(outcome.error, null);
  assert.equal(outcome.shouldClearPrompt, true);
});

test('oauth unmount: executeUnmountOAuthCleanup cancels active in-flight provider and unlistens', () => {
  let unlistenCalled = false;
  let cancelledProvider: string | null = null;

  const mockCancelFn = async (payload: { providerId: string }) => {
    cancelledProvider = payload.providerId;
    return { cancelled: true };
  };

  const outcome = executeUnmountOAuthCleanup({
    activeProviderId: 'github-copilot',
    cancelFn: mockCancelFn,
    unlisten: () => {
      unlistenCalled = true;
    },
  });

  assert.equal(unlistenCalled, true);
  assert.equal(cancelledProvider, 'github-copilot');
  assert.equal(outcome.cancelledProviderId, 'github-copilot');
});

test('oauth unmount: executeUnmountOAuthCleanup does NOT cancel when no login in flight, protecting new flows', () => {
  let cancelCalled = false;
  let unlistenCalled = false;

  const outcome = executeUnmountOAuthCleanup({
    activeProviderId: null,
    cancelFn: async () => {
      cancelCalled = true;
      return { cancelled: true };
    },
    unlisten: () => {
      unlistenCalled = true;
    },
  });

  assert.equal(unlistenCalled, true);
  assert.equal(cancelCalled, false, 'Must not send cancel without an active provider in-flight');
  assert.equal(outcome.cancelledProviderId, null);
});

test('oauth events: shouldProcessOAuthEvent accepts events matching expected provider and rejects stale events', () => {
  const activeProvider = 'anthropic';

  // Matching event
  const matchingEvent: OAuthEventEnvelope = {
    providerId: 'anthropic',
    kind: 'status',
    data: { state: 'completed' },
  };
  assert.equal(shouldProcessOAuthEvent(matchingEvent, activeProvider), true);

  // Stale / mismatched event from another provider
  const staleEvent: OAuthEventEnvelope = {
    providerId: 'google-gemini',
    kind: 'status',
    data: { state: 'failed' },
  };
  assert.equal(shouldProcessOAuthEvent(staleEvent, activeProvider), false);
});

test('oauth URI safety: isSafeVerificationUri accepts valid http/https URLs and rejects unsafe schemes', () => {
  // Safe URLs
  assert.equal(isSafeVerificationUri('https://github.com/login/device'), true);
  assert.equal(isSafeVerificationUri('http://localhost:8080/device'), true);
  assert.equal(isSafeVerificationUri('https://accounts.google.com/o/oauth2/device/user'), true);

  // Unsafe injection / XSS schemes
  assert.equal(isSafeVerificationUri('javascript:alert(document.cookie)'), false);
  assert.equal(isSafeVerificationUri('javascript://github.com/login/device'), false);
  assert.equal(isSafeVerificationUri('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeVerificationUri('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isSafeVerificationUri('vbscript:run()'), false);

  // Malformed / empty / invalid
  assert.equal(isSafeVerificationUri(''), false);
  assert.equal(isSafeVerificationUri(null), false);
  assert.equal(isSafeVerificationUri(undefined), false);
  assert.equal(isSafeVerificationUri('   '), false);
  assert.equal(isSafeVerificationUri('not-a-valid-url'), false);
});

test('BuiltinOAuthAccounts markup: renders safe actionable device URI with Open Verification Page and Copy buttons', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'github-copilot',
    deviceCodeInfo: {
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    },
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Both actions rendered
  assert.ok(html.includes('Open Verification Page'), 'Open verification link button must be rendered');
  assert.ok(html.includes('builtin-oauth-open-link-btn'));
  assert.ok(html.includes('builtin-oauth-copy-uri-btn'));
});

test('BuiltinOAuthAccounts markup: does NOT render open link button when verificationUri is an unsafe scheme', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'github-copilot',
    deviceCodeInfo: {
      userCode: 'ABCD-1234',
      verificationUri: 'javascript:alert(1)',
    },
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Unsafe URL must NOT have an open link button
  assert.ok(!html.includes('builtin-oauth-open-link-btn'), 'Open link button must not be rendered for unsafe schemes');
  assert.ok(!html.includes('Open Verification Page'));
  // Plain URI text is shown for reference, copy button still available
  assert.ok(html.includes('builtin-oauth-copy-uri-btn'));
});

test('BuiltinOAuthAccounts markup: renders error alert and cancel button when select prompt has empty or null options', () => {
  const emptySelectPrompt: OAuthSafePrompt = {
    promptId: 'prompt-empty-1',
    promptType: 'select',
    message: 'Choose an organization:',
    options: [],
  };

  const oauth = createMockOAuthState({
    activeProviderId: 'anthropic',
    pendingPrompt: emptySelectPrompt,
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('builtin-oauth-prompt-empty-select'));
  assert.ok(html.includes('No options available to select.'));
  assert.ok(html.includes('Cancel'));
});

test('BuiltinOAuthAccounts markup: renders localized logging out text when isLoggingOut is true instead of signing in', () => {
  const tEs = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string => {
    return translate('es', key, params);
  };

  // English
  const oauthEn = createMockOAuthState({
    confirmLogoutId: 'anthropic',
    isLoggingOut: true,
  });
  const htmlEn = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthEn, t }));
  assert.ok(htmlEn.includes('Logging out...'), 'Must render "Logging out..." when isLoggingOut is true');
  assert.ok(!htmlEn.includes('Signing in...'), 'Must NOT render "Signing in..." when isLoggingOut is true');

  // Spanish
  const oauthEs = createMockOAuthState({
    confirmLogoutId: 'anthropic',
    isLoggingOut: true,
  });
  const htmlEs = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthEs, t: tEs }));
  assert.ok(htmlEs.includes('Cerrando sesión...'), 'Must render "Cerrando sesión..." in Spanish');
  assert.ok(!htmlEs.includes('Iniciando sesión...'), 'Must NOT render "Iniciando sesión..." when isLoggingOut is true');
});

test('BuiltinOAuthAccounts markup: renders prompt title and confirm disconnect message using previously dead translations', () => {
  // Confirm prompt title is rendered
  const manualPrompt: OAuthSafePrompt = {
    promptId: 'prompt-code-1',
    promptType: 'manual_code',
    message: 'Paste authorization code:',
  };
  const oauthPrompt = createMockOAuthState({
    activeProviderId: 'anthropic',
    pendingPrompt: manualPrompt,
  });
  const htmlPrompt = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthPrompt, t }));
  assert.ok(htmlPrompt.includes('Provider Sign-In Required'), 'Prompt title translation must be rendered');

  // Confirm disconnect message is rendered in confirmation dialog
  const oauthDisconnect = createMockOAuthState({
    confirmLogoutId: 'anthropic',
  });
  const htmlDisconnect = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthDisconnect, t }));
  assert.ok(
    htmlDisconnect.includes('Are you sure you want to log out of Anthropic? Stored OAuth credentials will be removed.'),
    'Confirm disconnect message must be rendered'
  );
});

test('BuiltinOAuthAccounts markup: renders accounts error banner and dismiss button', () => {
  let dismissed = false;
  const oauth = createMockOAuthState({
    accountsError: 'Failed to discover Pi built-in providers',
    dismissAccountsError: () => {
      dismissed = true;
    },
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  assert.ok(html.includes('Failed to discover Pi built-in providers'));
  assert.ok(html.includes('Dismiss'));
  assert.equal(dismissed, false);
});

test('BuiltinOAuthAccounts markup: disables start and action buttons while isCancelling is true', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'anthropic',
    isCancelling: true,
  });
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Status message renders cancelling text or indicator
  assert.ok(html.includes('Cancelling...') || html.includes('Signing in...'));
  // Cancel button is disabled while cancelling is in progress
  assert.ok(html.includes('disabled=""') || html.includes('disabled'));
});

test('BuiltinOAuthAccounts markup: disables active cancel button while isStarting is true to prevent start/cancel race', () => {
  const oauthStarting = createMockOAuthState({
    activeProviderId: 'anthropic',
    isStarting: true,
    isCancelling: false,
  });
  const htmlStarting = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthStarting, t }));

  // Active actions container must render a disabled Cancel button
  assert.match(
    htmlStarting,
    /<div class="builtin-oauth-active-actions">\s*<button[^>]*disabled[^>]*>.*?Cancel.*?<\/button>\s*<\/div>/s,
    'Cancel button must be disabled while isStarting is true'
  );

  // When isStarting is false, Cancel button is enabled
  const oauthActive = createMockOAuthState({
    activeProviderId: 'anthropic',
    isStarting: false,
    isCancelling: false,
  });
  const htmlActive = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthActive, t }));

  assert.match(
    htmlActive,
    /<div class="builtin-oauth-active-actions">\s*<button(?![^>]*disabled)[^>]*>.*?Cancel.*?<\/button>\s*<\/div>/s,
    'Cancel button must be enabled once start completes'
  );
});

// ============================================================================
// Null Handling Hardening Regression Tests (S2, S3)
// ============================================================================

test('oauth null hardening: executeOAuthCancel treats null or non-true response as failure and preserves session', async () => {
  // cancelFn returns null (as unhandled web IPC dispatcher would)
  const resNull = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: async () => null as any,
  });
  assert.equal(resNull.cancelled, false);
  assert.equal(resNull.shouldResetSession, false);
  assert.ok(resNull.error);

  // cancelFn returns empty object
  const resEmpty = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: async () => ({} as any),
  });
  assert.equal(resEmpty.cancelled, false);
  assert.equal(resEmpty.shouldResetSession, false);

  // cancelFn returns cancelled: null
  const resNullProp = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: async () => ({ cancelled: null } as any),
  });
  assert.equal(resNullProp.cancelled, false);
  assert.equal(resNullProp.shouldResetSession, false);

  // Only explicit cancelled: true is considered successful
  const resTrue = await executeOAuthCancel({
    providerId: 'anthropic',
    cancelFn: async () => ({ cancelled: true }),
  });
  assert.equal(resTrue.cancelled, true);
  assert.equal(resTrue.shouldResetSession, true);
  assert.equal(resTrue.error, null);
});

test('oauth null hardening: executeOAuthPromptResponse treats null or non-true response as failure and preserves prompt', async () => {
  // sendFn returns null
  const resNull = await executeOAuthPromptResponse({
    promptId: 'prompt-1',
    response: 'auth-code-123',
    sendFn: async () => null as any,
  });
  assert.equal(resNull.sent, false);
  assert.equal(resNull.shouldClearPrompt, false);
  assert.ok(resNull.error);

  // sendFn returns empty object
  const resEmpty = await executeOAuthPromptResponse({
    promptId: 'prompt-1',
    response: 'auth-code-123',
    sendFn: async () => ({} as any),
  });
  assert.equal(resEmpty.sent, false);
  assert.equal(resEmpty.shouldClearPrompt, false);

  // sendFn returns sent: null
  const resNullProp = await executeOAuthPromptResponse({
    promptId: 'prompt-1',
    response: 'auth-code-123',
    sendFn: async () => ({ sent: null } as any),
  });
  assert.equal(resNullProp.sent, false);
  assert.equal(resNullProp.shouldClearPrompt, false);

  // Only explicit sent: true clears prompt
  const resTrue = await executeOAuthPromptResponse({
    promptId: 'prompt-1',
    response: 'auth-code-123',
    sendFn: async () => ({ sent: true }),
  });
  assert.equal(resTrue.sent, true);
  assert.equal(resTrue.shouldClearPrompt, true);
  assert.equal(resTrue.error, null);
});

test('oauth error detection: isOAuthUnauthorizedError identifies remote access unauthorized marker', () => {
  assert.equal(isOAuthUnauthorizedError('OAUTH_UNAUTHORIZED'), true);
  assert.equal(isOAuthUnauthorizedError('Error: OAUTH_UNAUTHORIZED: Access key required'), true);
  assert.equal(isOAuthUnauthorizedError(new Error('OAUTH_UNAUTHORIZED')), true);
  assert.equal(isOAuthUnauthorizedError('OAUTH_KEY_UNCONFIGURED'), true);
  assert.equal(isOAuthUnauthorizedError('NetworkError'), false);
  assert.equal(isOAuthUnauthorizedError(null), false);
  assert.equal(isOAuthUnauthorizedError(undefined), false);
});

test('web oauth client: authorizeWebOAuth sends JSON POST to /api/oauth/authorize with credentials same-origin and handles SSE ready event', async () => {
  let fetchUrl = '';
  let fetchOptions: RequestInit | undefined;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchUrl = String(input);
    fetchOptions = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, owner: 'owner_test123' }),
    } as unknown as Response;
  }) as typeof fetch;

  let eventFired = false;
  // Mock window and dispatchEvent
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    dispatchEvent: (ev: any) => {
      if (ev.type === 'pi:oauth-authorized') {
        eventFired = true;
        // Parent SSE reconnect callback:
        if (ev.detail && typeof ev.detail.ready === 'function') {
          ev.detail.ready();
        }
      }
      return true;
    },
  };

  try {
    const res = await authorizeWebOAuth('my-secret-key-xyz', {
      fetchFn: mockFetch,
      timeoutMs: 1000,
    });

    assert.equal(res.ok, true);
    assert.equal(fetchUrl, '/api/oauth/authorize');
    assert.equal(fetchOptions?.method, 'POST');
    assert.equal((fetchOptions?.headers as any)?.['Content-Type'], 'application/json');
    assert.equal(fetchOptions?.credentials, 'same-origin');
    assert.equal(fetchOptions?.body, JSON.stringify({ key: 'my-secret-key-xyz' }));
    assert.equal(eventFired, true);

    // Verify key was NEVER placed in URL query
    assert.ok(!fetchUrl.includes('my-secret-key-xyz'));
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('web oauth client: fails with bounded timeout error when SSE ready callback is not invoked', async () => {
  const mockFetch = (async (): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, owner: 'owner_timeout' }),
    } as unknown as Response;
  }) as typeof fetch;

  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    dispatchEvent: (_ev: any) => {
      // Intentionally do NOT invoke ev.detail.ready() to simulate dead or hanging SSE stream
      return true;
    },
  };

  try {
    const res = await authorizeWebOAuth('key-xyz', {
      fetchFn: mockFetch,
      timeoutMs: 50,
    });
    assert.equal(res.ok, false);
    assert.ok(res.error?.toLowerCase().includes('timed out'));
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('web oauth client: returns actionable failure on 401, 403, and 503 server errors', async () => {
  const mockFetch401 = (async (): Promise<Response> => ({
    ok: false,
    status: 401,
    json: async () => ({ ok: false, error: 'Invalid access key' }),
  } as unknown as Response)) as unknown as typeof fetch;

  const res401 = await authorizeWebOAuth('wrong-key', { fetchFn: mockFetch401 });
  assert.equal(res401.ok, false);
  assert.equal(res401.error, 'Invalid access key');

  const mockFetch503 = (async (): Promise<Response> => ({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, error: 'PI_VIEWER_OAUTH_ACCESS_KEY is not configured on the server' }),
  } as unknown as Response)) as unknown as typeof fetch;

  const res503 = await authorizeWebOAuth('any-key', { fetchFn: mockFetch503 });
  assert.equal(res503.ok, false);
  assert.ok(res503.error?.includes('PI_VIEWER_OAUTH_ACCESS_KEY'));
});

test('BuiltinOAuthAccounts markup: does NOT render unlock section in desktop mode (isWebShim=false)', () => {
  const oauthDesktop = createMockOAuthState({
    isWebShim: false,
    isLocked: false,
    accountsError: 'OAUTH_UNAUTHORIZED: Access key required',
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthDesktop, t }));
  assert.ok(!html.includes('Remote Access Authorization'));
  assert.ok(!html.includes('builtin-oauth-unlock-card'));
});

test('BuiltinOAuthAccounts markup: renders unlock section in web shim mode (isWebShim=true) when unauthorized', () => {
  const oauthWeb = createMockOAuthState({
    isWebShim: true,
    isLocked: true,
    accountsError: 'OAUTH_UNAUTHORIZED: Remote access key required for built-in OAuth management.',
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthWeb, t }));
  assert.ok(html.includes('Remote Access Authorization'));
  assert.ok(html.includes('builtin-oauth-unlock-card'));
  assert.ok(html.includes('Unlock Remote OAuth'));
  assert.ok(html.includes('Enter server access key...'));
});

test('BuiltinOAuthAccounts markup: renders Spanish localized unlock section without English leaks', () => {
  function tEs(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
    return translate('es', key, params);
  }

  const oauthWebEs = createMockOAuthState({
    isWebShim: true,
    isLocked: true,
    accountsError: 'OAUTH_UNAUTHORIZED: Remote access key required',
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthWebEs, t: tEs }));
  assert.ok(html.includes('Autorización de acceso remoto'));
  assert.ok(html.includes('Desbloquear OAuth remoto'));
  assert.ok(html.includes('Introduzca la clave de acceso del servidor...'));
  assert.ok(!html.includes('Remote Access Authorization'));
  assert.ok(!html.includes('Unlock Remote OAuth'));
});

// ============================================================================
// Development Keyless / Anonymous Session Tests (S2, S3 Scope Change)
// ============================================================================

test('web oauth client: authorizeWebOAuth sends empty JSON body without key in development anonymous mode', async () => {
  let fetchUrl = '';
  let fetchOptions: RequestInit | undefined;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchUrl = String(input);
    fetchOptions = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, owner: 'owner_dev_anon_123' }),
    } as unknown as Response;
  }) as typeof fetch;

  let eventFired = false;
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    dispatchEvent: (ev: any) => {
      if (ev.type === 'pi:oauth-authorized') {
        eventFired = true;
        if (ev.detail && typeof ev.detail.ready === 'function') {
          ev.detail.ready();
        }
      }
      return true;
    },
  };

  try {
    // Calling authorizeWebOAuth with NO key
    const res = await authorizeWebOAuth(undefined, {
      fetchFn: mockFetch,
      timeoutMs: 1000,
    });

    assert.equal(res.ok, true);
    assert.equal(res.owner, 'owner_dev_anon_123');
    assert.equal(fetchUrl, '/api/oauth/authorize');
    assert.equal(fetchOptions?.method, 'POST');
    assert.equal((fetchOptions?.headers as any)?.['Content-Type'], 'application/json');
    assert.equal(fetchOptions?.credentials, 'same-origin');
    assert.equal(fetchOptions?.body, '{}');
    assert.equal(eventFired, true);
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('web oauth client: ensureWebOAuthSession automatically initializes session in web shim mode', async () => {
  resetWebOAuthSessionForTest();
  let calls = 0;
  const mockFetch = (async (): Promise<Response> => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, owner: 'owner_auto_dev' }),
    } as unknown as Response;
  }) as typeof fetch;

  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    __IS_WEB_IPC__: true,
    dispatchEvent: (ev: any) => {
      if (ev.type === 'pi:oauth-authorized' && ev.detail?.ready) {
        ev.detail.ready();
      }
      return true;
    },
  };

  try {
    const res1 = await ensureWebOAuthSession({ fetchFn: mockFetch });
    assert.equal(res1.ok, true);
    assert.equal(res1.owner, 'owner_auto_dev');

    // Repeated call reuses active session initialization
    const res2 = await ensureWebOAuthSession({ fetchFn: mockFetch });
    assert.equal(res2.ok, true);
    assert.equal(calls, 1);
  } finally {
    (globalThis as any).window = originalWindow;
    resetWebOAuthSessionForTest();
  }
});

test('BuiltinOAuthAccounts markup: does NOT render unlock section in web shim mode when authorized in dev mode', () => {
  const oauthDev = createMockOAuthState({
    isWebShim: true,
    isLocked: false,
    accountsError: null,
    activeError: null,
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: oauthDev, t }));
  assert.ok(!html.includes('Remote Access Authorization'));
  assert.ok(!html.includes('builtin-oauth-unlock-card'));
  assert.ok(!html.includes('Unlock Remote OAuth'));
});

// ============================================================================
// Authorization URL Retention, Actions, and Lifecycle Tests
// ============================================================================

test('useBuiltinOAuthAccounts public interface: exposes authUrl initialized to null', () => {
  let hookValue: any = null;
  function HookInspector() {
    hookValue = useBuiltinOAuthAccounts({ t });
    return null;
  }
  renderToStaticMarkup(React.createElement(HookInspector));
  assert.ok(hookValue !== null);
  assert.equal('authUrl' in hookValue, true, 'authUrl property must exist on useBuiltinOAuthAccounts return object');
  assert.equal(hookValue.authUrl, null, 'authUrl must initialize to null');
});

test('BuiltinOAuthAccounts markup: renders authorization URL, open link button, and copy button alongside manual callback prompt', () => {
  const manualPrompt: OAuthSafePrompt = {
    promptId: 'prompt-openai-1',
    promptType: 'manual_code',
    message: 'Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.',
    placeholder: 'Paste redirect URL here...',
  };

  const oauth = createMockOAuthState({
    activeProviderId: 'openai-codex',
    authUrl: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=pi-client&state=abc123xyz',
    pendingPrompt: manualPrompt,
  } as any);

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // 1. Authorization URL is rendered in the active modal body
  assert.ok(
    html.includes('https://auth.openai.com/oauth/authorize?response_type=code&amp;client_id=pi-client&amp;state=abc123xyz') ||
    html.includes('https://auth.openai.com/oauth/authorize?response_type=code&client_id=pi-client&state=abc123xyz'),
    'Authorization URL must be displayed in modal'
  );

  // 2. Open link button is rendered with safe user action
  assert.ok(html.includes('builtin-oauth-open-link-btn'), 'Open link button must be rendered');
  assert.ok(html.includes('Open Sign-In Page'), 'Open Sign-In Page text must be rendered');

  // 3. Copy button is rendered
  assert.ok(html.includes('builtin-oauth-copy-uri-btn'), 'Copy URI button must be rendered');
  assert.ok(html.includes('Copy'), 'Copy text must be rendered');

  // 4. Manual callback prompt form is rendered alongside URL actions
  assert.ok(
    html.includes('Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.'),
    'Manual callback prompt message must be rendered'
  );
  assert.ok(html.includes('Paste redirect URL here...'), 'Prompt input placeholder must be rendered');
  assert.ok(html.includes('Submit'), 'Prompt submit button must be rendered');
});

test('BuiltinOAuthAccounts markup: does NOT render open link button when authUrl uses an unsafe scheme', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'openai-codex',
    authUrl: 'javascript:alert(document.cookie)',
    pendingPrompt: {
      promptId: 'prompt-1',
      promptType: 'manual_code',
      message: 'Paste callback URL',
    },
  } as any);

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Must NOT render open link button for unsafe scheme
  assert.ok(!html.includes('builtin-oauth-open-link-btn'), 'Open link button must not be rendered for unsafe schemes');
  assert.ok(!html.includes('Open Sign-In Page'), 'Open Sign-In Page text must not be rendered for unsafe schemes');
});

test('BuiltinOAuthAccounts markup: Spanish localization translates open auth URL button without English leaks', () => {
  const tEs = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string => {
    return translate('es', key, params);
  };

  const oauth = createMockOAuthState({
    activeProviderId: 'openai-codex',
    authUrl: 'https://auth.openai.com/oauth/authorize',
  } as any);

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t: tEs }));

  assert.ok(html.includes('Abrir página de inicio de sesión'), 'Must render Spanish "Abrir página de inicio de sesión"');
  assert.ok(!html.includes('Open Sign-In Page'), 'Must not leak English "Open Sign-In Page"');
});

test('oauth event-to-state-to-render: auth_url event retains URL, renders actionable modal alongside manual callback, and resets on lifecycle boundaries', async () => {
  const mod = await import('@features/providers/hooks/useBuiltinOAuthAccounts');
  assert.equal(typeof (mod as any).handleOAuthEventPayload, 'function', 'handleOAuthEventPayload must be exported');

  const { handleOAuthEventPayload } = mod as any;

  // 1. Inbound auth_url event for active provider retains authUrl
  const authUrlResult = handleOAuthEventPayload({
    envelope: {
      providerId: 'openai-codex',
      kind: 'event',
      data: {
        type: 'auth_url',
        url: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=pi',
        instructions: 'Complete sign-in in your browser.',
      },
    },
    expectedProviderId: 'openai-codex',
    t,
  });

  assert.equal(authUrlResult.handled, true);
  assert.equal(authUrlResult.authUrl, 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=pi');
  assert.equal(authUrlResult.statusMessage, 'Complete sign-in in your browser.');
  assert.equal(authUrlResult.shouldResetSession, false);

  // 2. Render state with authUrl + manual callback prompt
  const activeState = createMockOAuthState({
    activeProviderId: 'openai-codex',
    authUrl: authUrlResult.authUrl,
    statusMessage: authUrlResult.statusMessage,
    pendingPrompt: {
      promptId: 'prompt-callback-1',
      promptType: 'manual_code',
      message: 'If the callback does not complete, paste the final redirect URL here.',
    },
  } as any);

  const activeHtml = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: activeState, t }));
  assert.ok(activeHtml.includes('https://auth.openai.com/oauth/authorize'), 'Rendered modal must contain authorization URL');
  assert.ok(activeHtml.includes('Open Sign-In Page'), 'Rendered modal must contain Open Sign-In Page action');
  assert.ok(activeHtml.includes('If the callback does not complete, paste the final redirect URL here.'), 'Rendered modal must contain manual callback prompt');

  // 3. Lifecycle boundary: cancel or terminal status clears session and URL
  const cancelStatusResult = handleOAuthEventPayload({
    envelope: {
      providerId: 'openai-codex',
      kind: 'status',
      data: { state: 'cancelled' },
    },
    expectedProviderId: 'openai-codex',
    t,
  });
  assert.equal(cancelStatusResult.handled, true);
  assert.equal(cancelStatusResult.shouldResetSession, true);
  assert.equal(cancelStatusResult.terminalState, 'cancelled');

  // Reset state: session cleared (authUrl null, activeProviderId null)
  const resetState = createMockOAuthState({
    activeProviderId: null,
    authUrl: null,
    pendingPrompt: null,
  } as any);

  const resetHtml = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth: resetState, t }));
  assert.ok(!resetHtml.includes('https://auth.openai.com/oauth/authorize'), 'Reset view must not contain stale auth URL');
  assert.ok(!resetHtml.includes('Open Sign-In Page'), 'Reset view must not contain stale open button');
});

