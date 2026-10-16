import React, { useState, useEffect } from 'react';
import type { TranslationKey } from '@shared/i18n';
import { openExternalUrl } from '@infra/opener';
import { isOAuthUnauthorizedError } from '@infra/web-oauth-access';
import { isSafeVerificationUri } from '../hooks/useBuiltinOAuthAccounts';
import type { useBuiltinOAuthAccounts } from '../hooks/useBuiltinOAuthAccounts';

export interface BuiltinOAuthAccountsProps {
  oauth: ReturnType<typeof useBuiltinOAuthAccounts>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isBusy?: boolean;
}

export const BuiltinOAuthAccounts: React.FC<BuiltinOAuthAccountsProps> = ({
  oauth,
  t,
  isBusy = false,
}) => {
  const {
    accounts,
    isLoading,
    accountsError,
    activeProviderId,
    isStarting,
    isCancelling,
    statusMessage,
    deviceCodeInfo,
    pendingPrompt,
    activeError,
    successNotice,
    confirmLogoutId,
    isLoggingOut,
    refreshAccounts,
    startLogin,
    cancelLogin,
    respondToPrompt,
    confirmLogout,
    cancelConfirmLogout,
    logoutProvider,
    setSuccessNotice,
    setActiveError,
    setAccountsError,
    dismissAccountsError,
  } = oauth;

  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedUri, setCopiedUri] = useState<boolean>(false);
  const [promptInputValue, setPromptInputValue] = useState<string>('');

  // Clear secret / manual code React input on cancel, dismiss, or completion
  useEffect(() => {
    setPromptInputValue('');
  }, [pendingPrompt?.promptId, activeProviderId]);

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // Fallback if clipboard API unavailable
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const handleCopyUri = async (uri: string) => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    }
  };

  const handleOpenUri = (e: React.MouseEvent, uri: string) => {
    e.preventDefault();
    if (isSafeVerificationUri(uri)) {
      void openExternalUrl(uri);
    }
  };

  const handlePromptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInputValue.trim()) return;
    respondToPrompt(promptInputValue.trim());
  };

  const handleSelectOption = (optionId: string) => {
    respondToPrompt(optionId);
  };

  const handleCancelLogin = (providerId?: string) => {
    if (isStarting) {
      return;
    }
    setPromptInputValue('');
    cancelLogin(providerId);
  };

  return (
    <section className="builtin-oauth-section" aria-labelledby="builtin-oauth-heading">
      <div className="builtin-oauth-header">
        <div className="builtin-oauth-header-text">
          <div className="builtin-oauth-title-row">
            <h2 id="builtin-oauth-heading" className="builtin-oauth-title">
              {t('providers.oauth.section_title')}
            </h2>
            <span className="badge badge-subtle">{accounts.length}</span>
          </div>
          <p className="builtin-oauth-subtitle">
            {t('providers.oauth.section_subtitle')}
          </p>
        </div>
        <div className="builtin-oauth-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={refreshAccounts}
            disabled={isLoading || Boolean(activeProviderId) || isCancelling || isLoggingOut || isBusy}
            title={t('providers.oauth.reload')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>{t('providers.oauth.reload')}</span>
          </button>
        </div>
      </div>

      {accountsError && (
        <div className="validation-error-banner" role="alert">
          <span>{accountsError}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              if (dismissAccountsError) {
                dismissAccountsError();
              } else if (setAccountsError) {
                setAccountsError(null);
              }
            }}
          >
            {t('action.dismiss_error')}
          </button>
        </div>
      )}

      {/* Remote Web Access Unlock Section (Web Shim Mode only) */}
      {oauth.isWebShim && (oauth.isLocked || isOAuthUnauthorizedError(accountsError) || isOAuthUnauthorizedError(activeError)) && (
        <div className="builtin-oauth-unlock-card storage-warning-banner" role="region" aria-labelledby="oauth-unlock-title" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <strong id="oauth-unlock-title" style={{ display: 'block', marginBottom: '4px' }}>
                {t('providers.oauth.unlock_title')}
              </strong>
              <span style={{ fontSize: '12px', opacity: 0.9 }}>
                {t('providers.oauth.unlock_description')}
              </span>
            </div>
          </div>
          <form
            className="builtin-oauth-unlock-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (oauth.submitUnlock) {
                oauth.submitUnlock();
              }
            }}
            style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}
          >
            <input
              type="password"
              className="builtin-oauth-prompt-input"
              placeholder={t('providers.oauth.access_key_placeholder')}
              value={oauth.unlockKeyInput || ''}
              onChange={(e) => {
                if (oauth.setUnlockKeyInput) {
                  oauth.setUnlockKeyInput(e.target.value);
                }
              }}
              disabled={oauth.isUnlocking}
              autoComplete="off"
              spellCheck={false}
              style={{ flex: 1, padding: '6px 10px', fontSize: '13px' }}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm btn-unlock"
              disabled={oauth.isUnlocking || !oauth.unlockKeyInput?.trim()}
            >
              {oauth.isUnlocking ? t('providers.oauth.unlocking') : t('providers.oauth.btn_unlock')}
            </button>
          </form>
          {oauth.unlockError && (
            <div className="validation-error-banner" role="alert" style={{ marginTop: '4px', padding: '6px 8px' }}>
              <span>{oauth.unlockError}</span>
            </div>
          )}
          {oauth.unlockSuccess && (
            <div className="providers-success-banner" role="status" style={{ marginTop: '4px', padding: '6px 8px' }}>
              <span>{t('providers.oauth.unlock_success')}</span>
            </div>
          )}
        </div>
      )}

      {activeError && (
        <div className="validation-error-banner" role="alert">
          <span>{activeError}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setActiveError(null)}
          >
            {t('action.dismiss_error')}
          </button>
        </div>
      )}

      {successNotice && (
        <div className="storage-warning-banner providers-success-banner" role="status">
          <span>{successNotice}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setSuccessNotice(null)}
          >
            {t('action.dismiss_warning')}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="providers-loading-state builtin-oauth-loading">
          <div className="spinner" />
          <span>{t('providers.oauth.loading')}</span>
        </div>
      ) : accounts.length === 0 ? (
        <div className="builtin-oauth-empty-state">
          <p className="builtin-oauth-empty-title">{t('providers.oauth.empty_title')}</p>
          <p className="builtin-oauth-empty-text">{t('providers.oauth.empty_text')}</p>
        </div>
      ) : (
        <div className="builtin-oauth-grid">
          {accounts.map((provider) => {
            const isActive = activeProviderId === provider.id;
            const isConfirmedLogout = confirmLogoutId === provider.id;
            const isConnected = provider.oauthReady || provider.hasStoredOAuth;

            return (
              <div
                key={provider.id}
                className={`builtin-oauth-card ${isActive ? 'is-active' : ''} ${
                  isConnected ? 'is-connected' : ''
                }`}
                data-provider-id={provider.id}
              >
                <div className="builtin-oauth-card-header">
                  <div className="builtin-oauth-provider-info">
                    <span className="builtin-oauth-provider-name">{provider.name}</span>
                    <span className="builtin-oauth-provider-id">({provider.id})</span>
                    {provider.isSubscription && (
                      <span className="badge badge-primary builtin-oauth-badge-sub">
                        {t('providers.oauth.status_subscription')}
                      </span>
                    )}
                  </div>

                  <div className="builtin-oauth-card-status">
                    {isConnected ? (
                      <span className="status-badge connected">
                        <span className="status-dot green" />
                        {t('providers.oauth.status_connected')}
                      </span>
                    ) : (
                      <span className="status-badge disconnected">
                        <span className="status-dot gray" />
                        {t('providers.oauth.status_not_connected')}
                      </span>
                    )}
                  </div>
                </div>

                {provider.ambientApiKey && (
                  <div className="builtin-oauth-ambient-notice">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    <span>{t('providers.oauth.status_ambient_key')}</span>
                  </div>
                )}

                {/* Active In-Flight Flow */}
                {isActive && (
                  <div className="builtin-oauth-active-panel" role="region" aria-live="polite">
                    <div className="builtin-oauth-active-header">
                      <div className="spinner-sm" />
                      <span className="builtin-oauth-status-text">
                        {statusMessage || t('providers.oauth.signing_in')}
                      </span>
                    </div>

                    {/* Device Code Flow */}
                    {deviceCodeInfo && (
                      <div className="builtin-oauth-device-code-block">
                        <p className="builtin-oauth-device-code-instructions">
                          {t('providers.oauth.device_code_prompt')}
                        </p>
                        <div className="builtin-oauth-code-row">
                          <code className="builtin-oauth-user-code">
                            {deviceCodeInfo.userCode}
                          </code>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleCopyCode(deviceCodeInfo.userCode)}
                          >
                            {copiedCode
                              ? t('providers.oauth.device_code_copied')
                              : t('providers.oauth.device_code_copy')}
                          </button>
                        </div>
                        {deviceCodeInfo.verificationUri && (
                          <div className="builtin-oauth-verify-link">
                            <span className="builtin-oauth-verify-uri">
                              {deviceCodeInfo.verificationUri}
                            </span>
                            <div className="builtin-oauth-verify-actions">
                              {isSafeVerificationUri(deviceCodeInfo.verificationUri) && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm builtin-oauth-open-link-btn"
                                  onClick={(e) => handleOpenUri(e, deviceCodeInfo.verificationUri)}
                                  title={t('providers.oauth.device_code_open_link')}
                                >
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                  >
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                  </svg>
                                  <span>{t('providers.oauth.device_code_open_link')}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm builtin-oauth-copy-uri-btn"
                                onClick={() => handleCopyUri(deviceCodeInfo.verificationUri)}
                                title={t('action.copy')}
                              >
                                <span>
                                  {copiedUri
                                    ? t('providers.oauth.device_code_copied')
                                    : t('action.copy')}
                                </span>
                              </button>
                            </div>
                          </div>
                        )}
                        {Boolean(deviceCodeInfo.expiresInSeconds) && (
                          <span className="builtin-oauth-expires-text">
                            {t('providers.oauth.device_code_expires', {
                              seconds: deviceCodeInfo.expiresInSeconds ?? 0,
                            })}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Interactive Prompt Flow */}
                    {pendingPrompt && (
                      <div className="builtin-oauth-prompt-block">
                        <h4 className="builtin-oauth-prompt-title">
                          {t('providers.oauth.prompt_title')}
                        </h4>
                        <p className="builtin-oauth-prompt-message">{pendingPrompt.message}</p>

                        {pendingPrompt.promptType === 'select' && (
                          (!pendingPrompt.options || pendingPrompt.options.length === 0) ? (
                            <div className="builtin-oauth-prompt-empty-select" role="alert">
                              <p className="builtin-oauth-prompt-empty-error">
                                {t('providers.oauth.select_no_options')}
                              </p>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleCancelLogin(provider.id)}
                                disabled={isStarting || isCancelling}
                              >
                                {t('providers.oauth.btn_cancel')}
                              </button>
                            </div>
                          ) : (
                            <div className="builtin-oauth-select-options">
                              {pendingPrompt.options.map((opt) => (
                                <button
                                  key={opt.id}
                                  type="button"
                                  className="btn btn-secondary btn-sm builtin-oauth-option-btn"
                                  onClick={() => handleSelectOption(opt.id)}
                                >
                                  <span className="builtin-oauth-option-label">{opt.label}</span>
                                  {opt.description && (
                                    <span className="builtin-oauth-option-desc">
                                      {opt.description}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          )
                        )}

                        {pendingPrompt.promptType === 'manual_code' && (
                          <form onSubmit={handlePromptSubmit} className="builtin-oauth-prompt-form">
                            <input
                              type="text"
                              className="input-sm builtin-oauth-prompt-input"
                              placeholder={
                                pendingPrompt.placeholder ||
                                t('providers.oauth.manual_code_placeholder')
                              }
                              value={promptInputValue}
                              onChange={(e) => setPromptInputValue(e.target.value)}
                              autoFocus
                            />
                            <button
                              type="submit"
                              className="btn btn-primary btn-sm"
                              disabled={!promptInputValue.trim()}
                            >
                              {t('providers.oauth.prompt_submit')}
                            </button>
                          </form>
                        )}

                        {pendingPrompt.promptType === 'secret' && (
                          <form onSubmit={handlePromptSubmit} className="builtin-oauth-prompt-form">
                            <input
                              type="password"
                              className="input-sm builtin-oauth-prompt-input"
                              placeholder={
                                pendingPrompt.placeholder || t('providers.oauth.text_placeholder')
                              }
                              value={promptInputValue}
                              onChange={(e) => setPromptInputValue(e.target.value)}
                              autoFocus
                            />
                            <button
                              type="submit"
                              className="btn btn-primary btn-sm"
                              disabled={!promptInputValue.trim()}
                            >
                              {t('providers.oauth.prompt_submit')}
                            </button>
                          </form>
                        )}

                        {pendingPrompt.promptType !== 'select' &&
                          pendingPrompt.promptType !== 'manual_code' &&
                          pendingPrompt.promptType !== 'secret' && (
                            <form onSubmit={handlePromptSubmit} className="builtin-oauth-prompt-form">
                              <input
                                type="text"
                                className="input-sm builtin-oauth-prompt-input"
                                placeholder={
                                  pendingPrompt.placeholder ||
                                  t('providers.oauth.text_placeholder')
                                }
                                value={promptInputValue}
                                onChange={(e) => setPromptInputValue(e.target.value)}
                                autoFocus
                              />
                              <button
                                type="submit"
                                className="btn btn-primary btn-sm"
                                disabled={!promptInputValue.trim()}
                              >
                                {t('providers.oauth.prompt_submit')}
                              </button>
                            </form>
                          )}
                      </div>
                    )}

                    <div className="builtin-oauth-active-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleCancelLogin(provider.id)}
                        disabled={isStarting || isCancelling}
                      >
                        {isCancelling
                          ? t('providers.oauth.cancelling')
                          : t('providers.oauth.btn_cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Normal Actions / Confirmation */}
                {!isActive && (
                  <div className="builtin-oauth-card-actions">
                    {isConfirmedLogout ? (
                      <div className="builtin-oauth-confirm-box" role="alertdialog">
                        <div className="builtin-oauth-confirm-content">
                          <span className="builtin-oauth-confirm-text">
                            {t('providers.oauth.confirm_disconnect_title', {
                              provider: provider.name,
                            })}
                          </span>
                          <p className="builtin-oauth-confirm-message">
                            {t('providers.oauth.confirm_disconnect_message', {
                              provider: provider.name,
                            })}
                          </p>
                        </div>
                        <div className="builtin-oauth-confirm-buttons">
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => logoutProvider(provider.id)}
                            disabled={isLoggingOut || isBusy}
                          >
                            {isLoggingOut
                              ? t('providers.oauth.logging_out')
                              : t('providers.oauth.btn_confirm_disconnect')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={cancelConfirmLogout}
                            disabled={isLoggingOut}
                          >
                            {t('providers.oauth.btn_cancel')}
                          </button>
                        </div>
                      </div>
                    ) : isConnected ? (
                      <div className="builtin-oauth-action-row">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => confirmLogout(provider.id)}
                          disabled={Boolean(activeProviderId) || isCancelling || isLoggingOut || isBusy}
                        >
                          {t('providers.oauth.btn_disconnect')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => startLogin(provider.id)}
                          disabled={Boolean(activeProviderId) || isCancelling || isLoggingOut || isBusy}
                        >
                          {t('providers.oauth.btn_reconnect')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm builtin-oauth-connect-btn"
                        onClick={() => startLogin(provider.id)}
                        disabled={Boolean(activeProviderId) || isStarting || isCancelling || isBusy}
                      >
                        {provider.loginLabel || t('providers.oauth.btn_connect')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
