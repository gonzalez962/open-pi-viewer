import React from 'react';

export type ExportToastType = 'loading' | 'success' | 'error' | 'info';

export interface ExportToastState {
  type: ExportToastType;
  message: string;
}

export interface ExportToastProps {
  toast: ExportToastState | null;
  onDismiss: () => void;
  closeAriaLabel?: string;
}

export const ExportToast: React.FC<ExportToastProps> = ({
  toast,
  onDismiss,
  closeAriaLabel = 'Close notification',
}) => {
  if (!toast) {
    return null;
  }

  const isError = toast.type === 'error';
  const role = isError ? 'alert' : 'status';
  const ariaLive = isError ? 'assertive' : 'polite';

  return (
    <div className="export-toast-container" aria-live={ariaLive}>
      <div
        className={`export-toast export-toast-${toast.type}`}
        role={role}
      >
        <span className={`export-toast-icon is-${toast.type}`} aria-hidden="true">
          {toast.type === 'loading' && (
            <svg
              className="export-toast-spinner"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeOpacity="0.25"
              />
              <path d="M12 3a9 9 0 0 1 9 9" />
            </svg>
          )}
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
        <span className="export-toast-message">{toast.message}</span>
        <button
          type="button"
          className="export-toast-dismiss"
          onClick={onDismiss}
          aria-label={closeAriaLabel}
        >
          ×
        </button>
      </div>
    </div>
  );
};
