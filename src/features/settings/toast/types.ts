export type SettingsToastType = 'success' | 'error' | 'warning' | 'info';

export interface SettingsToastOptions {
  /** Optional bold title displayed above the message */
  title?: string;
  /**
   * Auto-dismiss duration in milliseconds.
   * If set to 0, the toast remains open until manually dismissed.
   * Defaults: success/info = 3500ms, warning = 5000ms, error = 7000ms.
   */
  durationMs?: number;
  /** Optional interactive action inside the toast */
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface SettingsToastItem extends SettingsToastOptions {
  id: string;
  type: SettingsToastType;
  message: string;
  createdAt: number;
}

export type SettingsToastData = SettingsToastItem;

export interface SettingsToastContextValue {
  toasts: readonly SettingsToastItem[];
  showToast: (type: SettingsToastType, message: string, options?: SettingsToastOptions) => string;
  dismissToast: (id: string) => void;
  clearAll: () => void;
  success: (message: string, options?: SettingsToastOptions) => string;
  error: (message: string, options?: SettingsToastOptions) => string;
  warning: (message: string, options?: SettingsToastOptions) => string;
  info: (message: string, options?: SettingsToastOptions) => string;
}

export const DEFAULT_TOAST_DURATIONS: Record<SettingsToastType, number> = {
  success: 3500,
  info: 3500,
  warning: 5000,
  error: 7000,
};

export const MAX_VISIBLE_TOASTS = 4;
