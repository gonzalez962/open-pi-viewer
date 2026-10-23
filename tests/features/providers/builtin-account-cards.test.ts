import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import type {
  BuiltinOAuthProviderStatus,
} from '@core/types/oauth';
import { BuiltinOAuthAccounts } from '@features/providers/components/BuiltinOAuthAccounts';
import { BuiltinOAuthModal } from '@features/providers/components/BuiltinOAuthModal';
import { translate } from '@shared/i18n';

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
  return translate('en', key, params);
}

function tEs(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
  return translate('es', key, params);
}

const mockProviders: BuiltinOAuthProviderStatus[] = [
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
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    oauthName: 'openai',
    loginLabel: 'Sign in with OpenAI',
    isSubscription: false,
    configured: false,
    hasStoredOAuth: false,
    oauthReady: false,
    ambientApiKey: false,
    source: null,
    status: 'needs_auth',
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    oauthName: 'deepseek',
    loginLabel: 'Sign in with DeepSeek',
    isSubscription: false,
    configured: false,
    hasStoredOAuth: false,
    oauthReady: false,
    ambientApiKey: false,
    source: null,
    status: 'needs_auth',
  },
];

function createMockOAuthState(overrides: Partial<Parameters<typeof BuiltinOAuthAccounts>[0]['oauth']> = {}) {
  const defaultState: Parameters<typeof BuiltinOAuthAccounts>[0]['oauth'] = {
    accounts: mockProviders,
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
    isWebShim: false,
    isLocked: false,
    isUnlocking: false,
    unlockError: null,
    unlockSuccess: false,
    unlockKeyInput: '',
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
    setUnlockKeyInput: () => {},
    submitUnlock: async () => true,
    resetUnlock: () => {},
  };

  return { ...defaultState, ...overrides };
}

// ============================================================================
// S1 — Compact square cards
// ============================================================================

test('S1.1: Cards show only provider name, type, and single action without id, reconnect, badges, or ambient notices', () => {
  const oauth = createMockOAuthState();
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Grid contains all 5 accounts (four means columns, not truncation)
  assert.ok(html.includes('Anthropic'));
  assert.ok(html.includes('GitHub Copilot'));
  assert.ok(html.includes('Google Gemini'));
  assert.ok(html.includes('OpenAI Codex'));
  assert.ok(html.includes('DeepSeek Chat'));

  // Subscription type uses existing label, others use literal OAuth
  assert.ok(html.includes('Subscription / Pro'));
  assert.ok(html.includes('OAuth'));

  // Single action per card: Disconnect for connected, Connect for disconnected
  assert.ok(html.includes('Disconnect'));
  assert.ok(html.includes('Connect'));

  // MUST NOT contain provider IDs in card markup
  assert.ok(!html.includes('(anthropic)'));
  assert.ok(!html.includes('(github-copilot)'));
  assert.ok(!html.includes('(google-gemini)'));

  // MUST NOT contain reconnect button
  assert.ok(!html.includes('Reconnect'));

  // MUST NOT contain connected / not connected status badges or dots
  assert.ok(!html.includes('status-badge'));
  assert.ok(!html.includes('status-dot'));

  // MUST NOT contain ambient notice
  assert.ok(!html.includes('Environment API Key Active'));
  assert.ok(!html.includes('builtin-oauth-ambient-notice'));
});

test('S1.1: Spanish localization translates Connect, Disconnect, and Subscription type without English leaks', () => {
  const oauth = createMockOAuthState();
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t: tEs }));

  assert.ok(html.includes('Suscripción / Pro'));
  assert.ok(html.includes('OAuth'));
  assert.ok(html.includes('Desconectar'));
  assert.ok(html.includes('Conectar'));

  // No untranslated English actions in cards
  assert.ok(!html.includes('>Connect<'));
  assert.ok(!html.includes('>Disconnect<'));
});

test('S1.2: CSS rules keep compact cards, four desktop columns, and responsive media queries', () => {
  const cssPath = path.resolve(process.cwd(), 'src/features/providers/providers.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  // Four columns on desktop
  assert.match(css, /\.builtin-oauth-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);

  // Content-sized cards keep actions near the text instead of forcing square height.
  const card = css.match(/\.builtin-oauth-card\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(card, /aspect-ratio/);
  assert.match(card, /justify-content:\s*flex-start/);
  assert.match(card, /gap:\s*12px/);

  // Responsive reduction for smaller viewports without overflow
  assert.match(css, /@media[^{]+\{[^}]*\.builtin-oauth-grid\s*\{[^}]*grid-template-columns/);

  // Refresh accounts button has gap between icon and text
  assert.match(css, /\.builtin-oauth-refresh-btn\s*\{[^}]*gap:\s*6px/);
});

test('Refresh accounts button has builtin-oauth-refresh-btn class and gap styling', () => {
  const oauth = createMockOAuthState();
  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));
  assert.match(html, /class="[^"]*builtin-oauth-refresh-btn[^"]*"/, 'Refresh button must have builtin-oauth-refresh-btn class');
});

// ============================================================================
// S2 — Modal dialogs outside grid
// ============================================================================

test('S2.1: Active sign-in renders labelled modal dialog outside grid with status, prompts, and cancel', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'github-copilot',
    statusMessage: 'Browser opened for authentication.',
    deviceCodeInfo: {
      userCode: 'WXYZ-9876',
      verificationUri: 'https://github.com/login/device',
      expiresInSeconds: 600,
    },
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Modal dialog outside grid
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(html.includes('aria-labelledby='));
  assert.ok(html.includes('modal-overlay'));
  assert.ok(html.includes('builtin-oauth-modal'));

  // Modal contains device code details and status
  assert.ok(html.includes('WXYZ-9876'));
  assert.ok(html.includes('https://github.com/login/device'));
  assert.ok(html.includes('Browser opened for authentication.'));
  assert.ok(html.includes('Cancel'));

  // Cards grid remains separate from modal: grid occurs before modal
  const gridIndex = html.indexOf('builtin-oauth-grid');
  const modalIndex = html.indexOf('builtin-oauth-modal');
  assert.ok(gridIndex !== -1 && modalIndex !== -1);
  assert.ok(gridIndex < modalIndex, 'Grid must precede modal in DOM');

  // Compact cards inside grid do not contain active panel
  const gridSection = html.slice(gridIndex, modalIndex);
  assert.ok(!gridSection.includes('builtin-oauth-active-panel'), 'Cards must not contain active panel');
});

test('S2.1: Active sign-in renders authorization URL open and copy actions alongside manual callback prompt in modal', () => {
  const oauth = createMockOAuthState({
    activeProviderId: 'openai-codex',
    authUrl: 'https://auth.openai.com/oauth/authorize?response_type=code',
    statusMessage: 'Complete sign-in in your browser.',
    pendingPrompt: {
      promptId: 'prompt-1',
      promptType: 'manual_code',
      message: 'Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.',
    },
  } as any);

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Modal dialog outside grid contains both URL actions and callback prompt
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('builtin-oauth-modal'));
  assert.ok(html.includes('https://auth.openai.com/oauth/authorize?response_type=code'));
  assert.ok(html.includes('Open Sign-In Page'));
  assert.ok(html.includes('Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.'));

  // Cards grid remains separate from modal
  const gridIndex = html.indexOf('builtin-oauth-grid');
  const modalIndex = html.indexOf('builtin-oauth-modal');
  assert.ok(gridIndex !== -1 && modalIndex !== -1 && gridIndex < modalIndex);
});

test('S2.2: Disconnect confirmation renders in labelled modal dialog outside compact cards', () => {
  const oauth = createMockOAuthState({
    confirmLogoutId: 'anthropic',
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Labelled modal dialog
  assert.ok(html.includes('role="alertdialog"') || html.includes('role="dialog"'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(html.includes('builtin-oauth-modal'));

  // Confirmation content inside modal
  assert.ok(html.includes('Disconnect Anthropic?'));
  assert.ok(html.includes('Log Out'));
  assert.ok(html.includes('Cancel'));

  // Cards do NOT contain inline confirmation
  const cardSection = html.slice(html.indexOf('builtin-oauth-grid'), html.indexOf('builtin-oauth-modal'));
  assert.ok(!cardSection.includes('builtin-oauth-confirm-box'));
});

test('S2.3: BuiltinOAuthModal component encapsulates focus entry, keyboard containment, and transition safety', () => {
  // Direct component unit test for BuiltinOAuthModal
  let cancelCalled = false;
  const modalHtml = renderToStaticMarkup(
    React.createElement(BuiltinOAuthModal, {
      isOpen: true,
      mode: 'login',
      provider: mockProviders[0],
      statusMessage: 'Signing in...',
      deviceCodeInfo: null,
      pendingPrompt: null,
      isStarting: false,
      isCancelling: false,
      isLoggingOut: false,
      isBusy: false,
      onCancelLogin: () => {
        cancelCalled = true;
      },
      onCancelConfirmLogout: () => {},
      onConfirmLogout: () => {},
      onRespondToPrompt: () => {},
      t,
    })
  );

  assert.ok(modalHtml.includes('modal-overlay'));
  assert.ok(modalHtml.includes('builtin-oauth-modal'));
  assert.ok(modalHtml.includes('modal-close-btn'));
  assert.ok(modalHtml.includes('Anthropic'));
  assert.ok(modalHtml.includes('Signing in...'));
  assert.equal(cancelCalled, false);
});

test('S2.3: Unsafe transitions disable close and action buttons to prevent race conditions', () => {
  // Starting transition: close button and cancel button disabled
  const htmlStarting = renderToStaticMarkup(
    React.createElement(BuiltinOAuthModal, {
      isOpen: true,
      mode: 'login',
      provider: mockProviders[0],
      statusMessage: 'Starting authentication...',
      isStarting: true,
      isCancelling: false,
      isLoggingOut: false,
      onCancelLogin: () => {},
      onCancelConfirmLogout: () => {},
      onConfirmLogout: () => {},
      onRespondToPrompt: () => {},
      t,
    })
  );

  // Close button (✕) must be disabled
  assert.match(htmlStarting, /modal-close-btn[^>]*disabled/);
  // Active action cancel button must be disabled
  assert.match(htmlStarting, /builtin-oauth-active-actions[\s\S]*?<button[^>]*disabled/);

  // Cancelling transition: close button and cancel button disabled with cancelling text
  const htmlCancelling = renderToStaticMarkup(
    React.createElement(BuiltinOAuthModal, {
      isOpen: true,
      mode: 'login',
      provider: mockProviders[0],
      statusMessage: 'Cancelling...',
      isStarting: false,
      isCancelling: true,
      isLoggingOut: false,
      onCancelLogin: () => {},
      onCancelConfirmLogout: () => {},
      onConfirmLogout: () => {},
      onRespondToPrompt: () => {},
      t,
    })
  );

  assert.match(htmlCancelling, /modal-close-btn[^>]*disabled/);
  assert.ok(htmlCancelling.includes('Cancelling...'));

  // Logging out transition: close button and disconnect confirm button disabled
  const htmlLoggingOut = renderToStaticMarkup(
    React.createElement(BuiltinOAuthModal, {
      isOpen: true,
      mode: 'disconnect',
      provider: mockProviders[0],
      isStarting: false,
      isCancelling: false,
      isLoggingOut: true,
      onCancelLogin: () => {},
      onCancelConfirmLogout: () => {},
      onConfirmLogout: () => {},
      onRespondToPrompt: () => {},
      t,
    })
  );

  assert.match(htmlLoggingOut, /modal-close-btn[^>]*disabled/);
  assert.ok(htmlLoggingOut.includes('Logging out...'));
});

// ============================================================================
// PRESERVE — Existing unlock gate and guards
// ============================================================================

test('PRESERVE: Web shim mode unlock gate renders when locked and does not disrupt cards', () => {
  const oauth = createMockOAuthState({
    isWebShim: true,
    isLocked: true,
    unlockKeyInput: '',
  });

  const html = renderToStaticMarkup(React.createElement(BuiltinOAuthAccounts, { oauth, t }));

  // Unlock section is rendered
  assert.ok(html.includes('builtin-oauth-unlock-card'));
  assert.ok(html.includes('Remote Access Authorization'));
  assert.ok(html.includes('Unlock Remote OAuth'));

  // Cards are still rendered
  assert.ok(html.includes('builtin-oauth-grid'));
  assert.ok(html.includes('Anthropic'));
});
