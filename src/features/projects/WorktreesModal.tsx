import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { translate, type SupportedLocale } from '@shared/i18n';
import { ProjectWorktrees } from './ProjectWorktrees';

export function WorktreesModal({ projectPath, locale, onClose, onOpen }: {
  projectPath: string; locale: SupportedLocale; onClose: () => void; onOpen: (path: string) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modalRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const controls = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modalRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modalRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, [onClose]);

  return createPortal(<div className="branch-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="worktrees-modal-title">
    <div className="branch-modal-container worktrees-modal" ref={modalRef}>
      <header className="branch-modal-header">
        <h2 className="branch-modal-title" id="worktrees-modal-title">{translate(locale, 'worktrees.title')}</h2>
        <button type="button" className="branch-modal-close" aria-label={translate(locale, 'worktrees.close')} onClick={onClose}>×</button>
      </header>
      <ProjectWorktrees projectPath={projectPath} locale={locale} onOpen={onOpen} />
    </div>
  </div>, document.body);
}
