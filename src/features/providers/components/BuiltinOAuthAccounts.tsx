import React from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { BuiltinOAuthProviderStatus } from '@core/types/oauth';
import { isOAuthUnauthorizedError } from '@infra/web-oauth-access';
import type { useBuiltinOAuthAccounts } from '../hooks/useBuiltinOAuthAccounts';
import { BuiltinOAuthModal } from './BuiltinOAuthModal';

export interface BuiltinOAuthAccountsProps {
  oauth: ReturnType<typeof useBuiltinOAuthAccounts>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isBusy?: boolean;
  onOpenEditModels?: (provider: BuiltinOAuthProviderStatus) => void;
  loadingCatalogProviderId?: string | null;
}

export const BuiltinOAuthAccounts: React.FC<BuiltinOAuthAccountsProps> = ({
  oauth,
  t,
  isBusy = false,
  onOpenEditModels,
  loadingCatalogProviderId,
}) => {
  const {
    accounts,
    isLoading,
    accountsError,
    activeProviderId,
    isStarting,
    isCancelling,
    statusMessage,
    authUrl,
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

  const handleCancelLogin = (providerId?: string) => {
    if (isStarting) {
      return;
    }
    cancelLogin(providerId);
  };

  const activeProvider =
    accounts.find((p) => p.id === activeProviderId) ||
    (activeProviderId ? ({ id: activeProviderId, name: activeProviderId } as any) : null);

  const confirmLogoutProvider =
    accounts.find((p) => p.id === confirmLogoutId) ||
    (confirmLogoutId ? ({ id: confirmLogoutId, name: confirmLogoutId } as any) : null);

  const modalProvider = activeProviderId ? activeProvider : confirmLogoutProvider;
  const modalMode = activeProviderId ? 'login' : confirmLogoutId ? 'disconnect' : null;
  const isModalOpen = Boolean(modalMode);

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
            disabled={isLoading || Boolean(activeProviderId) || Boolean(confirmLogoutId) || isCancelling || isLoggingOut || isBusy}
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
            const isConnected = provider.oauthReady || provider.hasStoredOAuth;
            const isCatalogLoading = loadingCatalogProviderId === provider.id;
            const typeLabel = provider.isSubscription
              ? t('providers.oauth.status_subscription')
              : 'OAuth';

            return (
              <div
                key={provider.id}
                className={`builtin-oauth-card ${isActive ? 'is-active' : ''} ${
                  isConnected ? 'is-connected' : ''
                }`}
                data-provider-id={provider.id}
              >
                <div className="builtin-oauth-card-header">
                  <span className="builtin-oauth-provider-name">{provider.name}</span>
                  <span className="builtin-oauth-provider-type">{typeLabel}</span>
                </div>

                <div className="builtin-oauth-card-actions">
                  {isConnected ? (
                    <>
                      <button
                        type="button"
                        className={`btn-icon-subtle builtin-oauth-edit-models-btn ${isCatalogLoading ? 'is-loading' : ''}`}
                        onClick={() => onOpenEditModels?.(provider)}
                        disabled={
                          Boolean(activeProviderId) ||
                          Boolean(confirmLogoutId) ||
                          isCancelling ||
                          isLoggingOut ||
                          isBusy ||
                          isCatalogLoading ||
                          Boolean(loadingCatalogProviderId)
                        }
                        title={isCatalogLoading ? t('providers.oauth.loading_catalog') : t('providers.oauth.btn_edit_models')}
                        aria-label={isCatalogLoading ? t('providers.oauth.loading_catalog') : t('providers.oauth.btn_edit_models')}
                      >
                        {isCatalogLoading ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
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
                            <path d="M9.17 4.14 9.6 2h4.8l.43 2.14 1.43.83 2.07-.7 2.4 4.16-1.64 1.44v1.66l1.64 1.44-2.4 4.16-2.07-.7-1.43.83-.43 2.14H9.6l-.43-2.14-1.43-.83-2.07.7-2.4-4.16 1.64-1.44V9.97L3.27 8.53l2.4-4.16 2.07.7z" transform="translate(0 1)" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm builtin-oauth-action-btn builtin-oauth-disconnect-btn"
                        onClick={() => confirmLogout(provider.id)}
                        disabled={
                          Boolean(activeProviderId) ||
                          Boolean(confirmLogoutId) ||
                          isCancelling ||
                          isLoggingOut ||
                          isBusy ||
                          Boolean(loadingCatalogProviderId)
                        }
                      >
                        {t('providers.oauth.btn_disconnect')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm builtin-oauth-action-btn builtin-oauth-connect-btn"
                      onClick={() => startLogin(provider.id)}
                      disabled={
                        Boolean(activeProviderId) ||
                        Boolean(confirmLogoutId) ||
                        isStarting ||
                        isCancelling ||
                        isBusy ||
                        Boolean(loadingCatalogProviderId)
                      }
                    >
                      {t('providers.oauth.btn_connect')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Accessible modal outside the grid for active sign-in flow and disconnect confirmation */}
      <BuiltinOAuthModal
        isOpen={isModalOpen}
        mode={modalMode}
        provider={modalProvider}
        statusMessage={statusMessage}
        authUrl={authUrl ?? (oauth as any)?.authorizationUrl}
        deviceCodeInfo={deviceCodeInfo}
        pendingPrompt={pendingPrompt}
        isStarting={isStarting}
        isCancelling={isCancelling}
        isLoggingOut={isLoggingOut}
        isBusy={isBusy}
        onCancelLogin={handleCancelLogin}
        onCancelConfirmLogout={cancelConfirmLogout}
        onConfirmLogout={logoutProvider}
        onRespondToPrompt={respondToPrompt}
        t={t}
      />
    </section>
  );
};
