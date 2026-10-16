import { useEffect, useMemo, useRef, useState } from 'react';
import type { WebPushStatus } from '@infra/web-push';
import { isWebShim } from '@infra/web-oauth-access';
import type { UseWebPushReturn } from './useWebPush';

export const WEB_PUSH_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
export const WEB_PUSH_PROMPT_COOLDOWN_KEY = 'pi_web_push_invitation_cooldown';

export interface WebPushPromptEligibilityOptions {
  isWeb: boolean;
  notificationsEnabled: boolean;
  isSupported: boolean;
  status: WebPushStatus;
  isSyncSettled: boolean;
  permission?: NotificationPermission | null;
  cooldownUntil: number | null;
  sessionDismissed: boolean;
  now?: number;
}

/**
 * Pure eligibility policy for the startup WebPush invitation prompt.
 */
export function shouldShowWebPushPrompt(options: WebPushPromptEligibilityOptions): boolean {
  // 1. Only in a web browser (not desktop Tauri)
  if (!options.isWeb) return false;

  // 2. Only when notifications are enabled in preferences
  if (!options.notificationsEnabled) return false;

  // 3. Only when Web Push is supported by the browser environment
  if (!options.isSupported) return false;

  // 4. Must wait until startup sync has settled (prevents transient prompts on enrolled devices)
  if (!options.isSyncSettled) return false;

  // 5. Genuinely unsubscribed (not subscribed, unsupported, unavailable, denied, or error)
  if (options.status !== 'unsubscribed') return false;

  // 6. Browser permission must not be blocked/denied
  if (options.permission === 'denied') return false;

  // 7. Not dismissed during this page session (avoids repeated prompts without polling)
  if (options.sessionDismissed) return false;

  // 8. 24-hour cooldown: boundary at exactly 24h eligible on next opening
  if (options.cooldownUntil !== null) {
    const currentTime = options.now ?? Date.now();
    if (currentTime < options.cooldownUntil) {
      return false;
    }
  }

  return true;
}

/**
 * Safely loads persisted 24h cooldown timestamp from browser storage.
 */
export function loadWebPushPromptCooldown(storage?: Storage): number | null {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (!store) return null;
    const raw = store.getItem(WEB_PUSH_PROMPT_COOLDOWN_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Safely persists 24h cooldown timestamp to browser storage.
 */
export function saveWebPushPromptCooldown(until: number, storage?: Storage): boolean {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (!store) return false;
    store.setItem(WEB_PUSH_PROMPT_COOLDOWN_KEY, String(until));
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely clears persisted cooldown timestamp once enrolled.
 */
export function clearWebPushPromptCooldown(storage?: Storage): void {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (!store) return;
    store.removeItem(WEB_PUSH_PROMPT_COOLDOWN_KEY);
  } catch {
    // Catch storage errors
  }
}

export interface WebPushPromptState {
  isOpen: boolean;
  isPending: boolean;
  error: string | null;
}

export interface WebPushPromptControllerOptions {
  webPush: UseWebPushReturn;
  notificationsEnabled: boolean;
  isWeb?: boolean;
  storage?: Storage;
  now?: () => number;
  onStateChange?: (state: WebPushPromptState) => void;
}

export interface WebPushPromptController {
  getState: () => WebPushPromptState;
  accept: () => Promise<void>;
  decline: () => void;
  dismiss: () => void;
  updateProps: (nextProps: Partial<WebPushPromptControllerOptions>) => void;
  subscribe: (listener: (state: WebPushPromptState) => void) => () => void;
}

/**
 * Headless controller managing the startup WebPush invitation lifecycle and state.
 */
export function createWebPushPromptController(
  initialOptions: WebPushPromptControllerOptions
): WebPushPromptController {
  let options = { ...initialOptions };
  let sessionDismissed = false;
  let accepted = false;
  let cooldownUntil: number | null = loadWebPushPromptCooldown(options.storage);
  let isPending = false;
  let error: string | null = null;
  let isAttempted = false;

  const listeners = new Set<(state: WebPushPromptState) => void>();

  const computeIsOpen = (): boolean => {
    if (sessionDismissed || accepted) return false;
    if (options.webPush.status === 'subscribed') return false;
    if (!options.notificationsEnabled) return false;

    const isWeb = options.isWeb ?? isWebShim();
    if (!isWeb) return false;
    if (!options.webPush.isSupported) return false;

    const currentPermission =
      typeof window !== 'undefined' ? window.Notification?.permission : null;
    if (currentPermission === 'denied') return false;

    const currentTime = options.now ? options.now() : Date.now();
    if (cooldownUntil !== null && currentTime < cooldownUntil) {
      return false;
    }

    const isEligible = shouldShowWebPushPrompt({
      isWeb,
      notificationsEnabled: options.notificationsEnabled,
      isSupported: options.webPush.isSupported,
      status: options.webPush.status,
      isSyncSettled: options.webPush.isSyncSettled,
      permission: currentPermission,
      cooldownUntil,
      sessionDismissed,
      now: currentTime,
    });

    return isEligible || (isAttempted && (isPending || error !== null));
  };

  let lastNotifiedState: WebPushPromptState = {
    isOpen: computeIsOpen(),
    isPending,
    error,
  };
  let currentState: WebPushPromptState = lastNotifiedState;

  const getState = (): WebPushPromptState => {
    const nextIsOpen = computeIsOpen();
    if (
      nextIsOpen === currentState.isOpen &&
      isPending === currentState.isPending &&
      error === currentState.error
    ) {
      return currentState;
    }
    currentState = {
      isOpen: nextIsOpen,
      isPending,
      error,
    };
    return currentState;
  };

  const notify = (): void => {
    const nextState = getState();
    if (
      nextState.isOpen === lastNotifiedState.isOpen &&
      nextState.isPending === lastNotifiedState.isPending &&
      nextState.error === lastNotifiedState.error
    ) {
      return;
    }

    lastNotifiedState = nextState;
    options.onStateChange?.(nextState);
    for (const listener of listeners) {
      listener(nextState);
    }
  };

  const accept = async (): Promise<void> => {
    isPending = true;
    error = null;
    isAttempted = true;
    notify();

    try {
      const result = await options.webPush.enable();
      if (result.ok && result.status === 'subscribed') {
        clearWebPushPromptCooldown(options.storage);
        error = null;
        isAttempted = false;
        accepted = true;
      } else {
        error = result.error || 'Failed to activate WebPush';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isPending = false;
      notify();
    }
  };

  const decline = (): void => {
    if (isPending) return;

    const current = options.now ? options.now() : Date.now();
    const until = current + WEB_PUSH_PROMPT_COOLDOWN_MS;

    saveWebPushPromptCooldown(until, options.storage);
    cooldownUntil = until;
    sessionDismissed = true;
    isAttempted = false;
    error = null;
    notify();
  };

  const dismiss = decline;

  const updateProps = (nextProps: Partial<WebPushPromptControllerOptions>): void => {
    if (nextProps.storage !== undefined && nextProps.storage !== options.storage) {
      cooldownUntil = loadWebPushPromptCooldown(nextProps.storage);
    }
    options = { ...options, ...nextProps };
    notify();
  };

  const subscribe = (listener: (state: WebPushPromptState) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getState,
    accept,
    decline,
    dismiss,
    updateProps,
    subscribe,
  };
}

export interface UseWebPushPromptOptions extends WebPushPromptControllerOptions {}

export interface UseWebPushPromptReturn {
  isOpen: boolean;
  isPending: boolean;
  error: string | null;
  accept: () => Promise<void>;
  decline: () => void;
  dismiss: () => void;
}

/**
 * React hook managing the startup WebPush cookie-style invitation banner.
 */
export function useWebPushPrompt(options: UseWebPushPromptOptions): UseWebPushPromptReturn {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controller = useMemo(
    () => createWebPushPromptController(options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [state, setState] = useState<WebPushPromptState>(() => controller.getState());

  useEffect(() => {
    // Synchronize to current controller snapshot on effect setup (StrictMode replay safe)
    const current = controller.getState();
    setState((prev) => {
      if (
        prev.isOpen === current.isOpen &&
        prev.isPending === current.isPending &&
        prev.error === current.error
      ) {
        return prev;
      }
      return current;
    });

    return controller.subscribe((next) => {
      setState((prev) => {
        if (
          prev.isOpen === next.isOpen &&
          prev.isPending === next.isPending &&
          prev.error === next.error
        ) {
          return prev;
        }
        return next;
      });
    });
  }, [controller]);

  // Extract consumed primitives and stable action callbacks from options to prevent
  // unstable object references (such as useWebPush return value) from re-triggering effects.
  const webPushStatus = options.webPush.status;
  const webPushIsSupported = options.webPush.isSupported;
  const webPushIsSyncSettled = options.webPush.isSyncSettled;
  const webPushError = options.webPush.error;
  const webPushEnable = options.webPush.enable;
  const notificationsEnabled = options.notificationsEnabled;
  const isWeb = options.isWeb;
  const storage = options.storage;
  const now = options.now;
  const onStateChange = options.onStateChange;

  useEffect(() => {
    controller.updateProps(optionsRef.current);
  }, [
    controller,
    webPushStatus,
    webPushIsSupported,
    webPushIsSyncSettled,
    webPushError,
    webPushEnable,
    notificationsEnabled,
    isWeb,
    storage,
    now,
    onStateChange,
  ]);

  return {
    isOpen: state.isOpen,
    isPending: state.isPending,
    error: state.error,
    accept: controller.accept,
    decline: controller.decline,
    dismiss: controller.dismiss,
  };
}
