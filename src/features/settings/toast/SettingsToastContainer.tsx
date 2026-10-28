import React from 'react';
import { useSettingsToast } from './SettingsToastContext';
import { SettingsToastItem } from './SettingsToastItem';

export interface SettingsToastContainerProps {
  closeAriaLabel?: string;
  className?: string;
}

export const SettingsToastContainer: React.FC<SettingsToastContainerProps> = ({
  closeAriaLabel = 'Close notification',
  className = '',
}) => {
  const { toasts, dismissToast } = useSettingsToast();

  if (toasts.length === 0) {
    return null;
  }

  // If any toast is an error, prioritize assertive aria-live
  const hasError = toasts.some((t) => t.type === 'error');
  const ariaLive = hasError ? 'assertive' : 'polite';

  return (
    <div
      className={`settings-toast-container ${className}`.trim()}
      aria-live={ariaLive}
      role="region"
      aria-label="Settings Notifications"
    >
      {toasts.map((toast) => (
        <SettingsToastItem
          key={toast.id}
          toast={toast}
          onDismiss={dismissToast}
          closeAriaLabel={closeAriaLabel}
        />
      ))}
    </div>
  );
};
