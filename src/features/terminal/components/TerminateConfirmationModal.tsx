import React, { useEffect, useId, useRef } from 'react';
import { translate, type SupportedLocale } from '@shared/i18n';

export interface TerminateConfirmationModalProps {
  isOpen: boolean;
  projectName: string;
  locale?: SupportedLocale;
  onConfirm: () => void;
  onCancel: () => void;
}

export function TerminateConfirmationModal({
  isOpen,
  projectName,
  locale = 'en',
  onConfirm,
  onCancel,
}: TerminateConfirmationModalProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(locale, key, params);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const prevFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    cancelBtnRef.current?.focus();

    return () => {
      dialog.close();
      if (prevFocus?.isConnected) prevFocus.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-modal terminate-confirmation-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
          return;
        }
        if (e.key !== 'Tab') return;

        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        );
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first) return;

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <h2 id={titleId}>{t('terminal.terminate_confirm_title')}</h2>
      <div id={descId} className="confirmation-modal-message">
        <p>{t('terminal.terminate_confirm_message')}</p>
        {projectName && <p className="terminate-project-name"><strong>{projectName}</strong></p>}
      </div>
      <div className="confirmation-modal-actions">
        <button
          ref={cancelBtnRef}
          type="button"
          className="btn btn-secondary btn-terminate-cancel"
          onClick={onCancel}
        >
          {t('terminal.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-danger confirmation-modal-confirm btn-terminate-confirm"
          onClick={onConfirm}
        >
          {t('terminal.terminate_confirm_button')}
        </button>
      </div>
    </dialog>
  );
}
