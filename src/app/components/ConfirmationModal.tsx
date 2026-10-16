import React, { useEffect, useId, useRef } from 'react';

export interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
}

/** Native dialog provides modal focus containment, inert background and focus restoration. */
export function ConfirmationModal({ isOpen, title, message, confirmLabel, cancelLabel, onConfirm, onCancel, pending = false }: ConfirmationModalProps): React.ReactElement | null {
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
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;
  return (
    <dialog ref={dialogRef} className="confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}
      onClick={event => { if (event.target === event.currentTarget && !pending) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onCancel();
      } }}>
      <h2 id={titleId}>{title}</h2>
      <div id={messageId} className="confirmation-modal-message">{message}</div>
      <div className="confirmation-modal-actions" aria-busy={pending}>
        <button ref={cancelRef} type="button" disabled={pending} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className="confirmation-modal-confirm" disabled={pending} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
