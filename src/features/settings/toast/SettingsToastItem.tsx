import React from 'react';
import type { SettingsToastItem as ToastItemType } from './types';

export interface SettingsToastItemProps {
  toast: ToastItemType;
  onDismiss: (id: string) => void;
  closeAriaLabel?: string;
}

export const SettingsToastItem: React.FC<SettingsToastItemProps> = ({
  toast,
  onDismiss,
  closeAriaLabel = 'Close notification',
}) => {
  const isError = toast.type === 'error';
  const role = isError ? 'alert' : 'status';

  return (
    <div
      className={`settings-toast settings-toast-${toast.type}`}
      role={role}
      data-toast-id={toast.id}
    >
      <span className={`settings-toast-icon is-${toast.type}`} aria-hidden="true">
        {toast.type === 'success' && (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {toast.type === 'error' && (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        )}
        {toast.type === 'warning' && (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        )}
        {toast.type === 'info' && (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        )}
      </span>

      <div className="settings-toast-content">
        {toast.title && <strong className="settings-toast-title">{toast.title}</strong>}
        <span className="settings-toast-message">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            className="settings-toast-action-btn"
            onClick={toast.action.onClick}
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        type="button"
        className="settings-toast-dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label={closeAriaLabel}
        title={closeAriaLabel}
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
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};
