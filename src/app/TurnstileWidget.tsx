import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadTurnstileScript,
  renderTurnstileWidget,
  resetTurnstileWidget,
  removeTurnstileWidget,
} from '@infra/turnstile';
import { translate, type SupportedLocale } from '@shared/i18n';

export interface TurnstileWidgetProps {
  siteKey: string;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  locale?: SupportedLocale;
  onTokenChange?: (token: string | null) => void;
  onToken?: (token: string) => void;
  onExpire?: () => void;
  onError?: (errorCode?: string | number) => void;
  onTimeout?: () => void;
  resetTrigger?: number;
}

type WidgetStatus = 'loading' | 'ready' | 'error' | 'expired' | 'timeout';

/**
 * Cloudflare Turnstile CAPTCHA widget for WebAuthGate.
 *
 * Explicitly renders via official Cloudflare script:
 * https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit
 *
 * Characteristics:
 * - Single-use token: token is cleared on error, expiration, timeout, or reset.
 * - StrictMode safe: cleans up previous widget ID on unmount/remount.
 * - Stale callback safe: sequence/generation tracking ignores callbacks from obsolete widgets.
 * - Ephemeral: never persists or logs tokens; uses 'response-field': false to prevent DOM storage.
 * - Accessible localized UI with retry support on script or challenge errors.
 */
export function TurnstileWidget({
  siteKey,
  action = 'login',
  theme = 'auto',
  locale = 'en',
  onTokenChange,
  onToken,
  onExpire,
  onError,
  onTimeout,
  resetTrigger,
}: TurnstileWidgetProps): React.ReactElement {
  const [status, setStatus] = useState<WidgetStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const activeGenRef = useRef(0);
  const isMountedRef = useRef(true);
  const prevResetTriggerRef = useRef(resetTrigger);

  // Store callbacks and locale in refs to guarantee stable initWidget across re-renders
  const callbacksRef = useRef({
    onTokenChange,
    onToken,
    onExpire,
    onError,
    onTimeout,
    locale,
  });

  useEffect(() => {
    callbacksRef.current = {
      onTokenChange,
      onToken,
      onExpire,
      onError,
      onTimeout,
      locale,
    };
  }, [onTokenChange, onToken, onExpire, onError, onTimeout, locale]);

  const notifyToken = useCallback((token: string | null) => {
    callbacksRef.current.onTokenChange?.(token);
    if (token && callbacksRef.current.onToken) {
      callbacksRef.current.onToken(token);
    }
  }, []);

  const initWidget = useCallback(async () => {
    isMountedRef.current = true;
    const currentGen = ++activeGenRef.current;

    // Clean up previous widget instance if present
    if (widgetIdRef.current) {
      removeTurnstileWidget(widgetIdRef.current);
      widgetIdRef.current = null;
    }

    notifyToken(null);
    setStatus('loading');
    setErrorMessage(null);

    try {
      const api = await loadTurnstileScript({ timeoutMs: 15000 });
      if (!isMountedRef.current || currentGen !== activeGenRef.current) {
        return;
      }

      if (!containerRef.current) {
        return;
      }

      const id = renderTurnstileWidget(
        containerRef.current,
        {
          sitekey: siteKey,
          action,
          theme,
          'response-field': false,
          callback: (token: string) => {
            if (!isMountedRef.current || currentGen !== activeGenRef.current) return;
            setStatus('ready');
            setErrorMessage(null);
            notifyToken(token);
          },
          'error-callback': (code?: string | number) => {
            if (!isMountedRef.current || currentGen !== activeGenRef.current) return;
            setStatus('error');
            setErrorMessage(
              translate(callbacksRef.current.locale, 'web_auth.turnstile_error')
            );
            notifyToken(null);
            callbacksRef.current.onError?.(code);
          },
          'expired-callback': () => {
            if (!isMountedRef.current || currentGen !== activeGenRef.current) return;
            setStatus('expired');
            setErrorMessage(
              translate(callbacksRef.current.locale, 'web_auth.turnstile_expired')
            );
            notifyToken(null);
            callbacksRef.current.onExpire?.();
            if (widgetIdRef.current) {
              resetTurnstileWidget(widgetIdRef.current);
            }
          },
          'timeout-callback': () => {
            if (!isMountedRef.current || currentGen !== activeGenRef.current) return;
            setStatus('timeout');
            setErrorMessage(
              translate(callbacksRef.current.locale, 'web_auth.turnstile_timeout')
            );
            notifyToken(null);
            callbacksRef.current.onTimeout?.();
            if (widgetIdRef.current) {
              resetTurnstileWidget(widgetIdRef.current);
            }
          },
        },
        api
      );

      if (isMountedRef.current && currentGen === activeGenRef.current) {
        widgetIdRef.current = id;
        setStatus('ready');
      } else {
        removeTurnstileWidget(id, api);
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || currentGen !== activeGenRef.current) {
        return;
      }
      setStatus('error');
      setErrorMessage(
        translate(callbacksRef.current.locale, 'web_auth.turnstile_load_error')
      );
      notifyToken(null);
    }
  }, [siteKey, action, theme, notifyToken]);

  // Handle initial mount and re-init when siteKey or action changes
  useEffect(() => {
    isMountedRef.current = true;
    void initWidget();

    return () => {
      isMountedRef.current = false;
      activeGenRef.current++;
      if (widgetIdRef.current) {
        removeTurnstileWidget(widgetIdRef.current);
        widgetIdRef.current = null;
      }
      notifyToken(null);
    };
  }, [initWidget, notifyToken]);

  // Handle resetTrigger updates
  useEffect(() => {
    if (
      resetTrigger !== undefined &&
      resetTrigger > 0 &&
      resetTrigger !== prevResetTriggerRef.current
    ) {
      prevResetTriggerRef.current = resetTrigger;
      if (widgetIdRef.current) {
        resetTurnstileWidget(widgetIdRef.current);
        notifyToken(null);
        setStatus('ready');
        setErrorMessage(null);
      } else {
        void initWidget();
      }
    }
  }, [resetTrigger, initWidget, notifyToken]);

  const handleRetry = () => {
    void initWidget();
  };

  return (
    <div
      className="web-auth-turnstile-container"
      aria-label={translate(locale, 'web_auth.turnstile_label')}
    >
      <div ref={containerRef} className="web-auth-turnstile-slot" />

      {status === 'loading' && (
        <div className="web-auth-turnstile-status" role="status" aria-live="polite">
          <span>{translate(locale, 'web_auth.turnstile_loading')}</span>
        </div>
      )}

      {errorMessage && (
        <>
          <div className="web-auth-turnstile-error" role="alert">
            {errorMessage}
          </div>
          <button
            type="button"
            className="web-auth-turnstile-retry-btn"
            onClick={handleRetry}
            aria-label={translate(locale, 'web_auth.turnstile_retry')}
          >
            {translate(locale, 'web_auth.turnstile_retry')}
          </button>
        </>
      )}
    </div>
  );
}
