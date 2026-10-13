import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotificationPreferences } from '@core/notifications';
import {
  isWebPushSupported,
  registerWebPush,
  unregisterWebPush,
  syncExistingSubscription,
  getWebPushConfig,
  type WebPushEnvironment,
  type WebPushOperationResult,
  type WebPushProject,
  type WebPushStatus,
} from '@infra/web-push';
import { WEB_AUTH_READY_EVENT } from '@infra/web-auth';

export interface WebPushControllerOptions {
  preferences: NotificationPreferences;
  language: string;
  projects: WebPushProject[];
  dependencies?: WebPushEnvironment;
  eventTarget?: EventTarget;
  onStatusChange?: (status: WebPushStatus) => void;
  onError?: (error: string | null) => void;
  onSettled?: () => void;
}

export interface UseWebPushOptions extends WebPushControllerOptions {}

export interface UseWebPushReturn {
  isSupported: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  isSyncSettled: boolean;
  status: WebPushStatus;
  error: string | null;
  enable: () => Promise<WebPushOperationResult>;
  disable: () => Promise<WebPushOperationResult>;
  sync: () => Promise<WebPushOperationResult>;
}

/**
 * Headless controller for Web Push lifecycle, state management, and testability.
 */
export function createWebPushController(options: WebPushControllerOptions) {
  let currentPreferences = options.preferences;
  let currentLanguage = options.language;
  let currentProjects = options.projects;
  let currentStatus: WebPushStatus = 'unsubscribed';
  let activeAbortController: AbortController | null = null;
  let inFlightOp: 'enable' | 'disable' | 'sync' | null = null;
  let settled = false;
  let disposed = false;

  const updateStatus = (next: WebPushStatus) => {
    currentStatus = next;
    options.onStatusChange?.(next);
  };

  const updateError = (err: string | null) => {
    options.onError?.(err);
  };

  const abortPreviousAndCreateSignal = () => {
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();
    return activeAbortController.signal;
  };

  let authListener: (() => void) | null = null;
  const target = options.eventTarget ?? (typeof window !== 'undefined' ? window : null);

  const controller = {
    getStatus: () => currentStatus,
    isSettled: () => settled,
    isDisposed: () => disposed,

    async init(): Promise<void> {
      if (disposed) return;
      try {
        if (!isWebPushSupported(options.dependencies)) {
          updateStatus('unsupported');
          return;
        }

        // Check existing subscription passively without prompting
        const signal = abortPreviousAndCreateSignal();
        inFlightOp = 'sync';
        try {
          const syncResult = await syncExistingSubscription(
            {
              preferences: currentPreferences,
              language: currentLanguage,
              projects: currentProjects,
              signal,
            },
            options.dependencies
          );
          if (disposed || signal.aborted) return;

          if (syncResult.ok) {
            updateStatus('subscribed');
            updateError(null);
          } else {
            const win =
              options.dependencies?.windowObj !== undefined
                ? options.dependencies.windowObj
                : typeof window !== 'undefined'
                  ? window
                  : null;
            const isPermissionDenied = win?.Notification?.permission === 'denied';

            if (syncResult.status === 'error') {
              updateStatus('error');
              updateError(syncResult.error ?? 'Failed to synchronize push subscription');
            } else if (syncResult.status === 'unsupported') {
              updateStatus('unsupported');
              updateError(syncResult.error ?? null);
            } else if (syncResult.status === 'unavailable') {
              updateStatus('unavailable');
              updateError(syncResult.error ?? null);
            } else if (syncResult.status === 'denied' && isPermissionDenied) {
              updateStatus('denied');
              updateError(syncResult.error ?? null);
            } else {
              // Genuinely unsubscribed (e.g. status === 'unsubscribed' or permission is default)
              // Perform fallback config discovery to check server VAPID availability
              const config = await getWebPushConfig({
                fetchFn: options.dependencies?.fetchFn,
                signal,
              });
              if (disposed || signal.aborted) return;

              if (!config.available || !config.publicKey) {
                updateStatus('unavailable');
                updateError(null);
              } else if (isPermissionDenied) {
                updateStatus('denied');
                updateError(null);
              } else {
                updateStatus('unsubscribed');
                updateError(null);
              }
            }
          }
        } finally {
          if (inFlightOp === 'sync') inFlightOp = null;
        }

        // Listen for web-auth-ready event to re-sync expired leases after re-login
        if (target && !authListener) {
          authListener = () => {
            if (!disposed && currentStatus === 'subscribed') {
              void controller.sync();
            }
          };
          target.addEventListener(WEB_AUTH_READY_EVENT, authListener as EventListener);
        }
      } catch (err) {
        if (disposed || activeAbortController?.signal.aborted) return;
        updateStatus('error');
        updateError(err instanceof Error ? err.message : String(err));
      } finally {
        settled = true;
        if (!disposed) {
          options.onSettled?.();
        }
      }
    },

    async enable(): Promise<WebPushOperationResult> {
      if (disposed) return { ok: false, status: 'error', error: 'Controller disposed' };

      const signal = abortPreviousAndCreateSignal();
      inFlightOp = 'enable';

      // Explicit enable snapshot: guarantee enabled: true even if React props have not re-rendered yet
      const enabledPreferences: NotificationPreferences = {
        ...currentPreferences,
        enabled: true,
      };

      try {
        const result = await registerWebPush(
          {
            preferences: enabledPreferences,
            language: currentLanguage,
            projects: currentProjects,
            signal,
          },
          options.dependencies
        );
        if (disposed) return result;

        updateStatus(result.status);
        updateError(result.error ?? null);
        return result;
      } finally {
        if (inFlightOp === 'enable') inFlightOp = null;
      }
    },

    async disable(): Promise<WebPushOperationResult> {
      if (disposed) return { ok: false, status: 'error', error: 'Controller disposed' };

      const signal = abortPreviousAndCreateSignal();
      inFlightOp = 'disable';

      try {
        const result = await unregisterWebPush({ signal }, options.dependencies);
        if (disposed) return result;

        if (result.ok) {
          updateStatus('unsubscribed');
          updateError(null);
        } else {
          updateStatus('error');
          updateError(result.error ?? null);
        }
        return result;
      } finally {
        if (inFlightOp === 'disable') inFlightOp = null;
      }
    },

    async sync(): Promise<WebPushOperationResult> {
      if (disposed) return { ok: false, status: 'error', error: 'Controller disposed' };

      const signal = abortPreviousAndCreateSignal();
      inFlightOp = 'sync';

      try {
        const result = await syncExistingSubscription(
          {
            preferences: currentPreferences,
            language: currentLanguage,
            projects: currentProjects,
            signal,
          },
          options.dependencies
        );
        if (disposed) return result;

        if (result.ok) {
          updateStatus('subscribed');
          updateError(null);
        } else {
          if (result.status === 'unsupported') {
            updateStatus('unsupported');
          }
          updateError(result.error ?? null);
        }
        return result;
      } finally {
        if (inFlightOp === 'sync') inFlightOp = null;
      }
    },

    async updateProps(props: {
      preferences: NotificationPreferences;
      language: string;
      projects: WebPushProject[];
    }): Promise<void> {
      currentPreferences = props.preferences;
      currentLanguage = props.language;
      currentProjects = props.projects;

      // Do not abort or interrupt an active enable or disable operation
      if (inFlightOp === 'enable' || inFlightOp === 'disable') {
        return;
      }

      // Only re-sync to server if currently subscribed and idle
      if (currentStatus === 'subscribed' && !disposed) {
        await controller.sync();
      }
    },

    dispose(): void {
      disposed = true;
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      if (target && authListener) {
        target.removeEventListener(WEB_AUTH_READY_EVENT, authListener as EventListener);
        authListener = null;
      }
    },
  };

  return controller;
}

/**
 * React hook for Web Push notifications in Settings / App.
 * StrictMode safe: recreates the controller on effect setup and cleans it up on disposal.
 */
export function useWebPush(options: UseWebPushOptions): UseWebPushReturn {
  const [status, setStatus] = useState<WebPushStatus>('unsubscribed');
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncSettled, setIsSyncSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onStatusChangeRef = useRef(setStatus);
  onStatusChangeRef.current = setStatus;

  const onErrorRef = useRef(setError);
  onErrorRef.current = setError;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controllerRef = useRef<ReturnType<typeof createWebPushController> | null>(null);

  const isSupported = useMemo(
    () => isWebPushSupported(options.dependencies),
    [options.dependencies]
  );

  useEffect(() => {
    // Recreate controller on effect setup (StrictMode safe)
    setIsSyncSettled(false);
    const ctrl = createWebPushController({
      preferences: optionsRef.current.preferences,
      language: optionsRef.current.language,
      projects: optionsRef.current.projects,
      dependencies: optionsRef.current.dependencies,
      eventTarget: optionsRef.current.eventTarget,
      onStatusChange: (s) => onStatusChangeRef.current(s),
      onError: (e) => onErrorRef.current(e),
      onSettled: () => setIsSyncSettled(true),
    });
    controllerRef.current = ctrl;

    void ctrl.init();

    return () => {
      ctrl.dispose();
      controllerRef.current = null;
    };
  }, [options.dependencies, options.eventTarget]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (ctrl) {
      void ctrl.updateProps({
        preferences: options.preferences,
        language: options.language,
        projects: options.projects,
      });
    }
  }, [options.preferences, options.language, options.projects]);

  const enable = useCallback(async (): Promise<WebPushOperationResult> => {
    const ctrl = controllerRef.current;
    if (!ctrl) {
      return { ok: false, status: 'error', error: 'Web Push is not mounted' };
    }
    setIsLoading(true);
    try {
      return await ctrl.enable();
    } finally {
      setIsLoading(false);
    }
  }, []);

  const disable = useCallback(async (): Promise<WebPushOperationResult> => {
    const ctrl = controllerRef.current;
    if (!ctrl) {
      return { ok: false, status: 'error', error: 'Web Push is not mounted' };
    }
    setIsLoading(true);
    try {
      return await ctrl.disable();
    } finally {
      setIsLoading(false);
    }
  }, []);

  const sync = useCallback(async (): Promise<WebPushOperationResult> => {
    const ctrl = controllerRef.current;
    if (!ctrl) {
      return { ok: false, status: 'error', error: 'Web Push is not mounted' };
    }
    setIsLoading(true);
    try {
      return await ctrl.sync();
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    isSupported,
    isSubscribed: status === 'subscribed',
    isLoading,
    isSyncSettled,
    status,
    error,
    enable,
    disable,
    sync,
  };
}
