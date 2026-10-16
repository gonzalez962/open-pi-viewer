import { useState, useEffect, useRef, useCallback } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type {
  BuiltinOAuthProviderStatus,
  OAuthEventEnvelope,
  OAuthPromptCancelledEvent,
  OAuthSafeEvent,
  OAuthSafePrompt,
  OAuthStatusEvent,
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
  isWebShim,
  isOAuthUnauthorizedError,
  ensureWebOAuthSession,
} from '@infra/web-oauth-access';
import { useWebOAuthUnlock } from './useWebOAuthUnlock';
import type { UnlistenFn } from '@tauri-apps/api/event';

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number | null;
}

/**
 * Validates that a device verification URI is safe to open in an external browser.
 * Only http and https protocols are permitted; all injection schemes (javascript:, data:, file:)
 * are rejected.
 */
export function isSafeVerificationUri(url?: string | null): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Pure decision helper: starting a login is allowed only when no provider is active
 * and no cancellation is in-flight.
 */
export function decideStartLoginAllowed(
  activeProviderId: string | null,
  isCancelling: boolean
): boolean {
  return !activeProviderId && !isCancelling;
}

/**
 * Filter ensuring backend events are only processed if they match the expected provider ID.
 * Isolates stale events from previous providers or cancellation processes.
 */
export function shouldProcessOAuthEvent(
  envelope: OAuthEventEnvelope,
  expectedProviderId: string
): boolean {
  return Boolean(envelope && envelope.providerId === expectedProviderId);
}

export interface ExecuteOAuthCancelOptions {
  providerId?: string | null;
  cancelFn: (payload: { providerId?: string | null }) => Promise<{ cancelled: boolean; message?: string | null }>;
}

export interface ExecuteOAuthCancelResult {
  cancelled: boolean;
  error?: string | null;
  shouldResetSession: boolean;
}

/**
 * Executes OAuth cancellation via IPC:
 * - Resets session ONLY after IPC acknowledgment.
 * - If cancellation fails (IPC returns cancelled: false or throws), preserves failure without resetting session.
 */
export async function executeOAuthCancel({
  providerId,
  cancelFn,
}: ExecuteOAuthCancelOptions): Promise<ExecuteOAuthCancelResult> {
  if (!providerId) {
    return { cancelled: false, error: 'No active provider to cancel', shouldResetSession: false };
  }
  try {
    const result = await cancelFn({ providerId });
    if (!result || result.cancelled !== true) {
      return {
        cancelled: false,
        error: result?.message || 'Failed to cancel sign-in.',
        shouldResetSession: false,
      };
    }
    return {
      cancelled: true,
      error: null,
      shouldResetSession: true,
    };
  } catch (err) {
    return {
      cancelled: false,
      error: err instanceof Error ? err.message : String(err),
      shouldResetSession: false,
    };
  }
}

export interface ExecuteOAuthPromptResponseOptions {
  promptId: string;
  response: string;
  sendFn: (payload: { promptId: string; response: string }) => Promise<{ sent: boolean; message?: string | null }>;
}

export interface ExecuteOAuthPromptResponseResult {
  sent: boolean;
  error?: string | null;
  shouldClearPrompt: boolean;
}

/**
 * Sends response to an interactive OAuth prompt:
 * - If IPC fails (returns sent: false or throws), the prompt stays visible so the user can retry.
 * - Only clears prompt on successful send.
 */
export async function executeOAuthPromptResponse({
  promptId,
  response,
  sendFn,
}: ExecuteOAuthPromptResponseOptions): Promise<ExecuteOAuthPromptResponseResult> {
  try {
    const result = await sendFn({ promptId, response });
    if (!result || result.sent !== true) {
      return {
        sent: false,
        error: result?.message || 'Failed to submit response. Please try again.',
        shouldClearPrompt: false,
      };
    }
    return {
      sent: true,
      error: null,
      shouldClearPrompt: true,
    };
  } catch (err) {
    return {
      sent: false,
      error: err instanceof Error ? err.message : String(err),
      shouldClearPrompt: false,
    };
  }
}

export interface ExecuteUnmountOAuthCleanupOptions {
  activeProviderId: string | null;
  cancelFn: (payload: { providerId: string }) => Promise<unknown>;
  unlisten?: (() => void) | null;
}

/**
 * Cleans up on unmount:
 * - Unlistens event channel.
 * - If an in-flight login exists, cancels specifically for that providerId.
 * - Avoids cancelling if no flow was in flight, preventing cancellation of new/separate flows.
 */
export function executeUnmountOAuthCleanup({
  activeProviderId,
  cancelFn,
  unlisten,
}: ExecuteUnmountOAuthCleanupOptions): { cancelledProviderId: string | null } {
  if (unlisten) {
    try {
      unlisten();
    } catch (e) {
      console.error('Error during unlisten on unmount:', e);
    }
  }
  if (activeProviderId) {
    cancelFn({ providerId: activeProviderId }).catch((err) => {
      console.error('Failed to cancel in-flight OAuth login on unmount:', err);
    });
    return { cancelledProviderId: activeProviderId };
  }
  return { cancelledProviderId: null };
}

export interface UseBuiltinOAuthAccountsOptions {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  onRefreshModels?: () => Promise<void>;
  bridge?: {
    getBuiltinOAuthProviders?: typeof getBuiltinOAuthProvidersPi;
    startOAuthLogin?: typeof startOAuthLoginPi;
    cancelOAuthLogin?: typeof cancelOAuthLoginPi;
    sendOAuthPromptResponse?: typeof sendOAuthPromptResponsePi;
    logoutOAuthProvider?: typeof logoutOAuthProviderPi;
    listenOAuthEvents?: typeof listenOAuthEventsPi;
  };
}

export function useBuiltinOAuthAccounts({
  t,
  onRefreshModels,
  bridge = {},
}: UseBuiltinOAuthAccountsOptions) {
  const getBuiltinOAuthProviders = bridge.getBuiltinOAuthProviders ?? getBuiltinOAuthProvidersPi;
  const startOAuthLogin = bridge.startOAuthLogin ?? startOAuthLoginPi;
  const cancelOAuthLogin = bridge.cancelOAuthLogin ?? cancelOAuthLoginPi;
  const sendOAuthPromptResponse = bridge.sendOAuthPromptResponse ?? sendOAuthPromptResponsePi;
  const logoutOAuthProvider = bridge.logoutOAuthProvider ?? logoutOAuthProviderPi;
  const listenOAuthEvents = bridge.listenOAuthEvents ?? listenOAuthEventsPi;

  const [accounts, setAccounts] = useState<BuiltinOAuthProviderStatus[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<DeviceCodeInfo | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<OAuthSafePrompt | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const [confirmLogoutId, setConfirmLogoutId] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeProviderIdRef = useRef<string | null>(null);
  activeProviderIdRef.current = activeProviderId;
  const isCancellingRef = useRef<boolean>(false);
  isCancellingRef.current = isCancelling;
  const pendingPromptRef = useRef<OAuthSafePrompt | null>(null);
  pendingPromptRef.current = pendingPrompt;

  const cleanupSession = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setActiveProviderId(null);
    activeProviderIdRef.current = null;
    setIsStarting(false);
    setIsCancelling(false);
    isCancellingRef.current = false;
    setStatusMessage(null);
    setDeviceCodeInfo(null);
    setPendingPrompt(null);
    pendingPromptRef.current = null;
  }, []);

  const dismissAccountsError = useCallback(() => {
    setAccountsError(null);
  }, []);

  const refreshAccounts = useCallback(async () => {
    setIsLoading(true);
    setAccountsError(null);
    try {
      if (isWebShim()) {
        const sessionRes = await ensureWebOAuthSession();
        if (!sessionRes.ok && sessionRes.error && isOAuthUnauthorizedError(sessionRes.error)) {
          setAccountsError(sessionRes.error);
          setIsLoading(false);
          return;
        }
      }
      const result = await getBuiltinOAuthProviders();
      setAccounts(Array.isArray(result) ? result : []);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [getBuiltinOAuthProviders]);

  useEffect(() => {
    refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    return () => {
      executeUnmountOAuthCleanup({
        activeProviderId: activeProviderIdRef.current,
        cancelFn: cancelOAuthLogin,
        unlisten: unlistenRef.current,
      });
      unlistenRef.current = null;
      activeProviderIdRef.current = null;
    };
  }, [cancelOAuthLogin]);

  const handleOAuthEvent = useCallback(
    (envelope: OAuthEventEnvelope, expectedProviderId: string) => {
      if (!shouldProcessOAuthEvent(envelope, expectedProviderId)) {
        return;
      }

      switch (envelope.kind) {
        case 'event': {
          const event = envelope.data as OAuthSafeEvent;
          if (event.type === 'auth_url') {
            // Note: Rust supervisor already opened the URL in the system browser via tauri-plugin-opener.
            // Do NOT open browser twice in React.
            setStatusMessage(event.instructions || t('providers.oauth.browser_opened'));
          } else if (event.type === 'device_code') {
            setDeviceCodeInfo({
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresInSeconds: event.expiresInSeconds ?? null,
            });
            setStatusMessage(t('providers.oauth.device_code_title'));
          } else if (event.type === 'progress') {
            setStatusMessage(event.message);
          } else if (event.type === 'info') {
            setStatusMessage(event.message);
          }
          break;
        }

        case 'prompt': {
          const prompt = envelope.data as OAuthSafePrompt;
          setPendingPrompt(prompt);
          break;
        }

        case 'prompt_cancelled': {
          const cancelled = envelope.data as OAuthPromptCancelledEvent;
          setPendingPrompt((prev) => (prev?.promptId === cancelled.promptId ? null : prev));
          break;
        }

        case 'status': {
          const status = envelope.data as OAuthStatusEvent;
          if (status.state === 'completed') {
            cleanupSession();
            setSuccessNotice(t('providers.oauth.success_notice', { provider: expectedProviderId }));
            refreshAccounts();
            if (onRefreshModels) {
              onRefreshModels().catch((e) => console.error('Failed to refresh models:', e));
            }
          } else if (status.state === 'cancelled') {
            cleanupSession();
          } else if (status.state === 'failed') {
            cleanupSession();
            setActiveError(status.error || status.message || t('providers.oauth.error_title'));
          }
          break;
        }

        default:
          break;
      }
    },
    [t, cleanupSession, refreshAccounts, onRefreshModels]
  );

  const startLogin = useCallback(
    async (providerId: string) => {
      // Hold start disabled until complete cancellation or while active
      if (!decideStartLoginAllowed(activeProviderIdRef.current, isCancellingRef.current)) {
        return;
      }

      setActiveProviderId(providerId);
      activeProviderIdRef.current = providerId;
      setIsStarting(true);
      setStatusMessage(t('providers.oauth.signing_in'));
      setActiveError(null);
      setSuccessNotice(null);
      setDeviceCodeInfo(null);
      setPendingPrompt(null);
      pendingPromptRef.current = null;

      try {
        if (isWebShim()) {
          const sessionRes = await ensureWebOAuthSession();
          if (!sessionRes.ok && sessionRes.error && isOAuthUnauthorizedError(sessionRes.error)) {
            setActiveError(sessionRes.error);
            setIsStarting(false);
            return;
          }
        }

        // Contract requirement: event listener pi://oauth-event, subscribe BEFORE invoking start
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }

        const unlisten = await listenOAuthEvents((envelope) => {
          handleOAuthEvent(envelope, providerId);
        });
        unlistenRef.current = unlisten;

        // Subscribe confirmed; now initiate login process in backend
        const result = await startOAuthLogin({ providerId });
        setIsStarting(false);

        if (!result || result.started !== true) {
          setActiveError(result?.message || 'Failed to start OAuth login');
          cleanupSession();
        }
      } catch (err) {
        setIsStarting(false);
        setActiveError(err instanceof Error ? err.message : String(err));
        cleanupSession();
      }
    },
    [t, listenOAuthEvents, startOAuthLogin, handleOAuthEvent, cleanupSession]
  );

  const cancelLogin = useCallback(
    async (providerId?: string) => {
      const targetProviderId = providerId || activeProviderIdRef.current;
      if (!targetProviderId || isCancellingRef.current) {
        return;
      }

      setIsCancelling(true);
      isCancellingRef.current = true;
      setStatusMessage(t('providers.oauth.cancelling'));
      setActiveError(null);

      const result = await executeOAuthCancel({
        providerId: targetProviderId,
        cancelFn: cancelOAuthLogin,
      });

      if (result.shouldResetSession) {
        cleanupSession();
      } else {
        setIsCancelling(false);
        isCancellingRef.current = false;
        if (result.error) {
          setActiveError(result.error);
        }
      }
    },
    [t, cancelOAuthLogin, cleanupSession]
  );

  const respondToPrompt = useCallback(
    async (response: string) => {
      const currentPrompt = pendingPromptRef.current;
      if (!currentPrompt) {
        return;
      }
      const promptId = currentPrompt.promptId;
      setActiveError(null);

      const result = await executeOAuthPromptResponse({
        promptId,
        response,
        sendFn: sendOAuthPromptResponse,
      });

      if (result.shouldClearPrompt) {
        setPendingPrompt(null);
        pendingPromptRef.current = null;
      } else if (result.error) {
        setActiveError(result.error);
      }
    },
    [sendOAuthPromptResponse]
  );

  const confirmLogout = useCallback((providerId: string) => {
    setConfirmLogoutId(providerId);
  }, []);

  const cancelConfirmLogout = useCallback(() => {
    setConfirmLogoutId(null);
  }, []);

  const logoutProvider = useCallback(
    async (providerId: string) => {
      setIsLoggingOut(true);
      setConfirmLogoutId(null);
      setActiveError(null);
      try {
        const result = await logoutOAuthProvider({ providerId });
        if (result && result.success === true) {
          setSuccessNotice(t('providers.oauth.logout_success_notice', { provider: providerId }));
          await refreshAccounts();
          if (onRefreshModels) {
            await onRefreshModels();
          }
        } else {
          setActiveError(result?.message || 'Logout failed');
        }
      } catch (err) {
        setActiveError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoggingOut(false);
      }
    },
    [logoutOAuthProvider, t, refreshAccounts, onRefreshModels]
  );

  const webUnlock = useWebOAuthUnlock({
    onUnlocked: async () => {
      setAccountsError(null);
      setActiveError(null);
      await refreshAccounts();
    },
  });

  const isShim = isWebShim();
  const isLocked = isShim && Boolean(
    isOAuthUnauthorizedError(accountsError) || isOAuthUnauthorizedError(activeError)
  );

  return {
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
    isLocked,
    isWebShim: isShim,
    isUnlocking: webUnlock.isAuthorizing,
    unlockError: webUnlock.unlockError,
    unlockSuccess: webUnlock.unlockSuccess,
    unlockKeyInput: webUnlock.keyInput,
    setUnlockKeyInput: webUnlock.setKeyInput,
    submitUnlock: webUnlock.submitUnlock,
    resetUnlock: webUnlock.resetUnlock,
  };
}
