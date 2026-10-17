import React, { useState, useEffect, useRef } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type { BuiltinOAuthProviderStatus, OAuthSafePrompt } from '@core/types/oauth';
import { openExternalUrl } from '@infra/opener';
import { isSafeVerificationUri } from '../hooks/useBuiltinOAuthAccounts';
import type { DeviceCodeInfo } from '../hooks/useBuiltinOAuthAccounts';

export interface BuiltinOAuthModalProps {
  isOpen: boolean;
  mode: 'login' | 'disconnect' | null;
  provider: BuiltinOAuthProviderStatus | null;
  statusMessage?: string | null;
  deviceCodeInfo?: DeviceCodeInfo | null;
  pendingPrompt?: OAuthSafePrompt | null;
  isStarting?: boolean;
  isCancelling?: boolean;
  isLoggingOut?: boolean;
  isBusy?: boolean;
  onCancelLogin: (providerId?: string) => void;
  onCancelConfirmLogout: () => void;
  onConfirmLogout: (providerId: string) => void;
  onRespondToPrompt: (response: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const BuiltinOAuthModal: React.FC<BuiltinOAuthModalProps> = ({
  isOpen,
  mode,
  provider,
  statusMessage,
  deviceCodeInfo,
  pendingPrompt,
  isStarting = false,
  isCancelling = false,
  isLoggingOut = false,
  isBusy = false,
  onCancelLogin,
  onCancelConfirmLogout,
  onConfirmLogout,
  onRespondToPrompt,
  t,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedUri, setCopiedUri] = useState<boolean>(false);
  const [promptInputValue, setPromptInputValue] = useState<string>('');

  // Clear prompt input on prompt change or modal close
  useEffect(() => {
    setPromptInputValue('');
  }, [pendingPrompt?.promptId, provider?.id, isOpen]);

  // Focus entry and restoration
  useEffect(() => {
    if (!isOpen) return;

    if (typeof document !== 'undefined') {
      previousFocusRef.current = document.activeElement as HTMLElement | null;

      // Focus entry: find first suitable focusable element or modal container
      const timer = setTimeout(() => {
        if (!modalRef.current) return;
        const input = modalRef.current.querySelector<HTMLElement>('input:not([disabled])');
        if (input) {
          input.focus();
        } else {
          const focusable = modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          if (focusable.length > 0) {
            focusable[0].focus();
          } else {
            modalRef.current.focus();
          }
        }
      }, 0);

      return () => {
        clearTimeout(timer);
        if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
          previousFocusRef.current.focus();
        }
      };
    }
  }, [isOpen]);

  // Focus trap (keyboard containment) and safe Escape key handling
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Do not close during starting/cancelling/logout unsafe transitions
        if (isStarting || isCancelling || isLoggingOut) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        if (mode === 'disconnect') {
          onCancelConfirmLogout();
        } else if (mode === 'login') {
          onCancelLogin(provider?.id);
        }
        return;
      }

      if (e.key === 'Tab') {
        if (!modalRef.current) return;
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, mode, isStarting, isCancelling, isLoggingOut, onCancelConfirmLogout, onCancelLogin, provider?.id]);

  if (!isOpen || !mode) return null;

  const isUnsafeTransition = isStarting || isCancelling || isLoggingOut;

  const handleSafeClose = () => {
    if (isUnsafeTransition) return;
    if (mode === 'disconnect') {
      onCancelConfirmLogout();
    } else {
      onCancelLogin(provider?.id);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isUnsafeTransition) {
      handleSafeClose();
    }
  };

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
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
    onRespondToPrompt(promptInputValue.trim());
  };

  const handleSelectOption = (optionId: string) => {
    onRespondToPrompt(optionId);
  };

  const modalTitle =
    mode === 'disconnect'
      ? t('providers.oauth.confirm_disconnect_title', { provider: provider?.name || '' })
      : provider?.name || t('providers.oauth.prompt_title');

  return (
    <div
      className="modal-overlay"
      role={mode === 'disconnect' ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby="builtin-oauth-modal-title"
      onClick={handleOverlayClick}
    >
      <div
        className="modal-container builtin-oauth-modal"
        ref={modalRef}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id="builtin-oauth-modal-title" className="modal-title">
            {modalTitle}
          </h2>
          <button
            type="button"
            className="btn-icon-subtle modal-close-btn"
            onClick={handleSafeClose}
            disabled={isUnsafeTransition}
            title={t('providers.oauth.btn_cancel')}
            aria-label={t('providers.oauth.btn_cancel')}
          >
            ✕
          </button>
        </header>

        <div className="modal-scrollable-body builtin-oauth-modal-body">
          {mode === 'disconnect' && provider && (
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
                  onClick={() => onConfirmLogout(provider.id)}
                  disabled={isLoggingOut || isBusy}
                >
                  {isLoggingOut
                    ? t('providers.oauth.logging_out')
                    : t('providers.oauth.btn_confirm_disconnect')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={onCancelConfirmLogout}
                  disabled={isLoggingOut}
                >
                  {t('providers.oauth.btn_cancel')}
                </button>
              </div>
            </div>
          )}

          {mode === 'login' && (
            <div className="builtin-oauth-active-panel" role="region" aria-live="polite">
              <div className="builtin-oauth-active-header">
                <div className="spinner-sm" />
                <span className="builtin-oauth-status-text">
                  {isLoggingOut
                    ? t('providers.oauth.logging_out')
                    : statusMessage || t('providers.oauth.signing_in')}
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
                            onClick={(e) => handleOpenUri(e, deviceCodeInfo.verificationUri!)}
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
                          onClick={() => handleCopyUri(deviceCodeInfo.verificationUri!)}
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
                          onClick={() => onCancelLogin(provider?.id)}
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
                  onClick={() => onCancelLogin(provider?.id)}
                  disabled={isStarting || isCancelling}
                >
                  {isCancelling
                    ? t('providers.oauth.cancelling')
                    : t('providers.oauth.btn_cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
