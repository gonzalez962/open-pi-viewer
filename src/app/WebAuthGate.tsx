import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkAuthStatus,
  loginWithKey,
  logout,
  emitWebAuthReady,
  emitWebAuthRequired,
  WEB_AUTH_REQUIRED_EVENT,
} from '@infra/web-auth';
import { TurnstileWidget } from './TurnstileWidget';
import { revokePushOnLogout } from '@infra/web-push';
import { loadUiPreferences } from '@infra/preferences';
import { translate, type SupportedLocale } from '@shared/i18n';
import './web-auth.css';
import { WebLogoutContext } from './WebLogoutContext';
import { ConfirmationModal } from '@app/components/ConfirmationModal';

export interface WebAuthGateProps {
  children: React.ReactNode;
}

type GateStatus = 'checking' | 'unauthenticated' | 'authenticated' | 'error';

/**
 * Access gate wrapper for the web browser preview & remote VPN/Tailscale access.
 *
 * When loaded in native desktop Tauri, this gate remains completely inert
 * and renders children directly without network calls.
 *
 * When loaded in a standard browser environment (window.__IS_WEB_IPC__):
 * - Checks GET /api/auth/status before mounting App or connecting SSE.
 * - If auth is disabled, emits readiness and mounts App.
 * - If auth is required, displays an accessible login form (password input).
 * - Fails closed on network error with a retry option.
 * - On 401 signals or successful logout, unmounts App and returns to the login gate.
 * - Provides logout UI for enabled, logged-in browser sessions.
 * - Guards against async race conditions and React StrictMode double-mounting.
 */
export function WebAuthGate({ children }: WebAuthGateProps): React.ReactElement {
  const isWeb = typeof window !== 'undefined' && Boolean((window as any).__IS_WEB_IPC__);

  // If not web IPC (i.e. native Tauri desktop), skip auth gate entirely
  if (!isWeb) {
    return <>{children}</>;
  }

  const [status, setStatus] = useState<GateStatus>('checking');
  const [authRequired, setAuthRequired] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);
  const [key, setKey] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // Sequence and cancellation refs to prevent async status races and StrictMode re-entry issues
  const activeCheckSeq = useRef(0);
  const isAuthRequiredRef = useRef(false);

  const [locale] = useState<SupportedLocale>(() => {
    try {
      return loadUiPreferences().preferences.language;
    } catch {
      return 'en';
    }
  });

  const checkStatus = useCallback(async () => {
    const seq = ++activeCheckSeq.current;
    setStatus('checking');
    setStatusError(null);
    try {
      const res = await checkAuthStatus();
      if (seq !== activeCheckSeq.current || isAuthRequiredRef.current) return;
      setAuthRequired(res.required);
      setTurnstileSiteKey(res.turnstileSiteKey ?? null);
      if (!res.required || res.authenticated) {
        emitWebAuthReady();
        setStatus('authenticated');
      } else {
        setStatus('unauthenticated');
      }
    } catch (err: unknown) {
      if (seq !== activeCheckSeq.current || isAuthRequiredRef.current) return;
      setStatus('error');
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    isAuthRequiredRef.current = false;
    void checkStatus();

    const handleWebAuthRequired = () => {
      // Invalidate any in-flight checkStatus or login responses
      activeCheckSeq.current++;
      isAuthRequiredRef.current = true;
      setKey('');
      setTurnstileToken(null);
      setTurnstileAttempt((prev) => prev + 1);
      setLoginError(null);
      setStatus('unauthenticated');
    };

    window.addEventListener(WEB_AUTH_REQUIRED_EVENT, handleWebAuthRequired);
    return () => {
      activeCheckSeq.current++;
      window.removeEventListener(WEB_AUTH_REQUIRED_EVENT, handleWebAuthRequired);
    };
  }, [checkStatus]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const isTurnstileRequired = Boolean(turnstileSiteKey);
    // Trim only to decide blankness; preserve exact raw input bytes for server validation
    if (!key.trim() || loginPending || (isTurnstileRequired && !turnstileToken)) {
      return;
    }

    const rawKey = key;
    const currentToken = turnstileToken;
    const seq = ++activeCheckSeq.current;
    setLoginPending(true);
    setLoginError(null);
    // Ephemeral credential and single-use token cleared immediately after attempt
    setKey('');
    setTurnstileToken(null);
    setTurnstileAttempt((prev) => prev + 1);
    isAuthRequiredRef.current = false;

    try {
      const result = await loginWithKey(rawKey, {
        turnstileToken: currentToken ?? undefined,
      });
      if (seq !== activeCheckSeq.current) return;
      if (result.ok) {
        setAuthRequired(true);
        emitWebAuthReady();
        setStatus('authenticated');
      } else {
        setLoginError(result.error ?? translate(locale, 'web_auth.invalid_key'));
      }
    } catch (err: unknown) {
      if (seq !== activeCheckSeq.current) return;
      setLoginError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginPending(false);
    }
  };

  const handleLogout = async () => {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError(null);
    try {
      try {
        await revokePushOnLogout();
      } finally {
        // Revoking authentication must not depend on browser push cleanup.
        await logout();
      }
      setLogoutConfirmOpen(false);
      // Only signal auth-required and unmount when server revoke succeeded (or was already invalid)
      activeCheckSeq.current++;
      isAuthRequiredRef.current = true;
      emitWebAuthRequired();
      setKey('');
      setTurnstileToken(null);
      setTurnstileAttempt((prev) => prev + 1);
      setLoginError(null);
      setStatus('unauthenticated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLogoutError(msg || translate(locale, 'web_auth.logout_failed'));
    } finally {
      setLogoutPending(false);
    }
  };

  if (status === 'authenticated') {
    return (
      <div className="web-auth-gate-wrapper">
        <WebLogoutContext.Provider value={authRequired ? (
          <div className="web-auth-logout-control">
            {logoutError && (
              <div className="web-auth-logout-error" role="alert">
                <span>{logoutError}</span>
                <button
                  type="button"
                  className="web-auth-logout-error-dismiss"
                  onClick={() => setLogoutError(null)}
                  aria-label={translate(locale, 'action.dismiss_error')}
                >
                  ×
                </button>
              </div>
            )}
            <button
              type="button"
              className="project-footer-row web-auth-logout-btn"
              onClick={() => { setLogoutError(null); setLogoutConfirmOpen(true); }}
              disabled={logoutPending}
              title={translate(locale, 'web_auth.logout')}
              aria-label={translate(locale, 'web_auth.logout')}
            >
              <div className="project-tile project-tile-settings" aria-hidden="true"><svg
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
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg></div>
              <span className="project-settings-label">
                {logoutPending
                  ? translate(locale, 'web_auth.logging_out')
                  : translate(locale, 'web_auth.logout')}
              </span>
            </button>
          </div>
        ) : null}>
          {children}
          <ConfirmationModal
            isOpen={logoutConfirmOpen}
            title={translate(locale, 'web_auth.logout')}
            message={<>
              {translate(locale, 'web_auth.logout_confirm')}
              {logoutError && <p className="web-auth-error" role="alert">{logoutError}</p>}
            </>}
            confirmLabel={translate(locale, logoutPending ? 'web_auth.logging_out' : 'web_auth.logout')}
            cancelLabel={translate(locale, 'action.cancel')}
            pending={logoutPending}
            onConfirm={() => { void handleLogout(); }}
            onCancel={() => setLogoutConfirmOpen(false)}
          />
        </WebLogoutContext.Provider>
      </div>
    );
  }

  if (status === 'checking') {
    return (
      <div className="web-auth-gate-container">
        <div className="web-auth-card">
          <div className="web-auth-header">
            <div className="web-auth-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h1 className="web-auth-title">{translate(locale, 'web_auth.title')}</h1>
          </div>
          <div className="web-auth-status-checking" role="status" aria-live="polite">
            <div className="web-auth-spinner" aria-hidden="true" />
            <span>{translate(locale, 'web_auth.checking_status')}</span>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="web-auth-gate-container">
        <div className="web-auth-card">
          <div className="web-auth-header">
            <div className="web-auth-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h1 className="web-auth-title">{translate(locale, 'web_auth.title')}</h1>
            <p className="web-auth-description">
              {translate(locale, 'web_auth.status_error')}
            </p>
          </div>
          {statusError && (
            <div
              className="web-auth-error"
              role="alert"
              style={{ marginBottom: '1.25rem' }}
            >
              {statusError}
            </div>
          )}
          <button
            type="button"
            className="web-auth-retry-btn"
            onClick={() => {
              isAuthRequiredRef.current = false;
              void checkStatus();
            }}
          >
            {translate(locale, 'web_auth.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="web-auth-gate-container">
      <div className="web-auth-card">
        <div className="web-auth-header">
          <div className="web-auth-icon">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className="web-auth-title">{translate(locale, 'web_auth.title')}</h1>
          <p className="web-auth-description">
            {translate(locale, 'web_auth.description')}
          </p>
        </div>
        <form onSubmit={handleLogin} className="web-auth-form">
          {loginError && (
            <div className="web-auth-error" role="alert">
              {loginError}
            </div>
          )}
          <div className="web-auth-field">
            <label htmlFor="web-auth-key-input" className="web-auth-label">
              {translate(locale, 'web_auth.key_label')}
            </label>
            <input
              id="web-auth-key-input"
              type="password"
              autoComplete="current-password"
              className="web-auth-input"
              placeholder={translate(locale, 'web_auth.key_placeholder')}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={loginPending}
              required
              autoFocus
            />
          </div>
          {turnstileSiteKey && (
            <div className="web-auth-turnstile-wrapper">
              <TurnstileWidget
                key={turnstileAttempt}
                siteKey={turnstileSiteKey}
                action="login"
                locale={locale}
                onTokenChange={setTurnstileToken}
              />
            </div>
          )}
          <button
            type="submit"
            className="web-auth-submit-btn"
            disabled={
              loginPending ||
              !key.trim() ||
              (Boolean(turnstileSiteKey) && !turnstileToken)
            }
            aria-busy={loginPending}
          >
            {loginPending
              ? translate(locale, 'web_auth.logging_in')
              : translate(locale, 'web_auth.login_button')}
          </button>
        </form>
      </div>
    </div>
  );
}
