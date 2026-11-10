import React, { useEffect } from 'react';

export interface ResourceModalLayoutProps {
  titleId: string;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  error?: string | null;
  className?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export const ResourceModalLayout: React.FC<ResourceModalLayoutProps> = ({
  titleId,
  title,
  isOpen,
  onClose,
  onSubmit,
  error,
  className = '',
  footer,
  children,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={`modal-container ext-modal ${className}`.trim()}>
        <header className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <form onSubmit={onSubmit} className="modal-form">
          <div className="modal-scrollable-body">
            {error && (
              <div className="validation-error-banner" role="alert">
                <span>{error}</span>
              </div>
            )}
            {children}
          </div>

          {footer && <footer className="modal-footer">{footer}</footer>}
        </form>
      </div>
    </div>
  );
};
