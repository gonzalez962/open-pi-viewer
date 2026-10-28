import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TOAST_DURATIONS,
  MAX_VISIBLE_TOASTS,
  type SettingsToastContextValue,
  type SettingsToastItem,
  type SettingsToastOptions,
  type SettingsToastType,
} from './types';

export const SettingsToastContext = createContext<SettingsToastContextValue | null>(null);

let toastCounter = 0;
function generateToastId(): string {
  toastCounter += 1;
  return `settings-toast-${Date.now()}-${toastCounter}`;
}

export function useToastManager(maxVisible = MAX_VISIBLE_TOASTS): SettingsToastContextValue {
  const [toasts, setToasts] = useState<SettingsToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const existingTimer = timersRef.current.get(id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (type: SettingsToastType, message: string, options?: SettingsToastOptions): string => {
      if (!message || !message.trim()) {
        return '';
      }

      const id = generateToastId();
      const duration =
        options?.durationMs !== undefined
          ? options.durationMs
          : DEFAULT_TOAST_DURATIONS[type];

      const newItem: SettingsToastItem = {
        id,
        type,
        message,
        title: options?.title,
        durationMs: duration,
        action: options?.action,
        createdAt: Date.now(),
      };

      setToasts((prev) => {
        const next = [...prev, newItem];
        if (next.length > maxVisible) {
          const removed = next.slice(0, next.length - maxVisible);
          removed.forEach((item) => {
            const timer = timersRef.current.get(item.id);
            if (timer) {
              clearTimeout(timer);
              timersRef.current.delete(item.id);
            }
          });
          return next.slice(next.length - maxVisible);
        }
        return next;
      });

      if (duration > 0) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismissToast, maxVisible]
  );

  const success = useCallback(
    (message: string, options?: SettingsToastOptions) => showToast('success', message, options),
    [showToast]
  );

  const error = useCallback(
    (message: string, options?: SettingsToastOptions) => showToast('error', message, options),
    [showToast]
  );

  const warning = useCallback(
    (message: string, options?: SettingsToastOptions) => showToast('warning', message, options),
    [showToast]
  );

  const info = useCallback(
    (message: string, options?: SettingsToastOptions) => showToast('info', message, options),
    [showToast]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return useMemo<SettingsToastContextValue>(
    () => ({
      toasts,
      showToast,
      dismissToast,
      clearAll,
      success,
      error,
      warning,
      info,
    }),
    [toasts, showToast, dismissToast, clearAll, success, error, warning, info]
  );
}

export interface SettingsToastProviderProps {
  children: React.ReactNode;
  maxVisible?: number;
}

export const SettingsToastProvider: React.FC<SettingsToastProviderProps> = ({
  children,
  maxVisible = MAX_VISIBLE_TOASTS,
}) => {
  const value = useToastManager(maxVisible);
  return <SettingsToastContext.Provider value={value}>{children}</SettingsToastContext.Provider>;
};

const NOOP_TOAST_CONTEXT: SettingsToastContextValue = {
  toasts: [],
  showToast: () => '',
  dismissToast: () => {},
  clearAll: () => {},
  success: () => '',
  error: () => '',
  warning: () => '',
  info: () => '',
};

export function useSettingsToast(): SettingsToastContextValue {
  try {
    const context = useContext(SettingsToastContext);
    if (!context) {
      return NOOP_TOAST_CONTEXT;
    }
    return context;
  } catch {
    return NOOP_TOAST_CONTEXT;
  }
}
