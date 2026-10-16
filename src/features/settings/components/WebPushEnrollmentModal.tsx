import { useEffect, useId, useRef } from 'react';
import type { TranslationKey } from '@shared/i18n';

interface WebPushEnrollmentModalProps {
  isOpen: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  t: (key: TranslationKey) => string;
}

/** Native dialog contains focus and keeps enrollment behind an explicit gesture. */
export function WebPushEnrollmentModal({ isOpen, pending, error, onConfirm, onCancel, t }: WebPushEnrollmentModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [isOpen]);
  if (!isOpen) return null;
  return <dialog ref={dialogRef} className="confirmation-modal" role="alertdialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={messageId}
    onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <h2 id={titleId}>{t('settings.web_push_enroll_title')}</h2>
    <div id={messageId} className="confirmation-modal-message">
      <p>{t('settings.web_push_enroll_message')}</p>
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="confirmation-modal-actions" aria-busy={pending}>
      <button ref={cancelRef} type="button" disabled={pending} onClick={onCancel}>{t('action.cancel')}</button>
      <button type="button" className="confirmation-modal-confirm" disabled={pending} onClick={onConfirm}>
        {t(pending ? 'settings.web_push_enrolling' : 'settings.web_push_enroll_confirm')}
      </button>
    </div>
  </dialog>;
}
