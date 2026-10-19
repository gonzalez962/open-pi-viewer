import React, { useState, useEffect, useRef } from 'react';
import { pickDirectoryPi } from '@infra/bridge';
import { translate, type SupportedLocale } from '@shared/i18n';

export interface DefaultDirectorySetupModalProps {
  isOpen: boolean;
  initialPath?: string;
  onClose: () => void;
  onConfirm: (directory: string) => void;
  locale: SupportedLocale;
}

export const DefaultDirectorySetupModal: React.FC<DefaultDirectorySetupModalProps> = ({
  isOpen,
  initialPath = '',
  onClose,
  onConfirm,
  locale,
}) => {
  const [directoryPath, setDirectoryPath] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDirectoryPath(initialPath);
      setError(null);
    }
  }, [isOpen, initialPath]);

  useEffect(() => {
    if (!isOpen) return;

    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }

    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 30);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'Tab' && cardRef.current) {
        const focusables = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => {
          if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
          if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
          return true;
        });

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey) {
          if (active === first || !cardRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !cardRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
      const prevEl = previousFocusRef.current;
      if (
        prevEl &&
        typeof prevEl.focus === 'function' &&
        typeof document !== 'undefined' &&
        document.contains(prevEl)
      ) {
        prevEl.focus();
      }
    };
  }, [isOpen, onClose]);

  const handleBrowse = async () => {
    setIsBrowsing(true);
    setError(null);
    try {
      const picked = await pickDirectoryPi(directoryPath || undefined);
      if (picked) {
        setDirectoryPath(picked);
      }
    } catch (err) {
      console.warn('[DefaultDirectorySetupModal browse error]:', err);
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = directoryPath.trim();
    if (!trimmed) {
      setError(translate(locale, 'projects.default_directory_prompt'));
      return;
    }
    onConfirm(trimmed);
  };

  if (!isOpen) return null;

  return (
    <div
      className="folder-picker-overlay default-directory-setup-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className="folder-picker-card default-directory-setup-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="default-dir-setup-title"
        aria-describedby="default-dir-setup-prompt"
        style={{ maxWidth: '540px' }}
      >
        <div className="folder-picker-header">
          <div className="folder-picker-header-text">
            <h2 id="default-dir-setup-title" className="folder-picker-title">
              📁 {translate(locale, 'projects.default_directory_title')}
            </h2>
            <p id="default-dir-setup-prompt" className="folder-picker-subtitle">
              {translate(locale, 'projects.default_directory_prompt')}
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="folder-picker-close-btn"
            onClick={onClose}
            aria-label={translate(locale, 'projects.cancel')}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="default-directory-setup-form" style={{ padding: '16px 20px' }}>
          <div className="field-group" style={{ marginBottom: '16px' }}>
            <label htmlFor="default-directory-path-input" className="field-label" style={{ display: 'block', marginBottom: '8px' }}>
              {translate(locale, 'projects.default_directory_label')}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                ref={inputRef}
                id="default-directory-path-input"
                type="text"
                className="field-input"
                style={{ flex: 1 }}
                value={directoryPath}
                onChange={(e) => {
                  setDirectoryPath(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={translate(locale, 'projects.default_directory_placeholder')}
                aria-required="true"
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleBrowse}
                disabled={isBrowsing}
              >
                {translate(locale, 'projects.default_directory_browse')}
              </button>
            </div>
            <span className="field-subtext" style={{ display: 'block', marginTop: '6px' }}>
              {translate(locale, 'projects.default_directory_hint')}
            </span>
            {error && (
              <span className="field-subtext field-subtext-error" role="alert" style={{ display: 'block', marginTop: '6px', color: 'var(--color-danger, #ef4444)' }}>
                {error}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              {translate(locale, 'projects.default_directory_cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!directoryPath.trim()}
            >
              {translate(locale, 'projects.default_directory_save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
