import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KANBAN_COLUMNS, type KanbanBoard, type KanbanCard, type KanbanColumnId } from '@core/types/kanban';
import { getProjectKanbanPi, saveProjectKanbanPi } from '@infra/bridge';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import './kanban.css';

interface Props { workingDirectory: string; locale: SupportedLocale; onClose: () => void }

/** Mount with a project key: draft state and requests never migrate to another project. */
export function KanbanModal({ workingDirectory, locale, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const [board, setBoard] = useState<KanbanBoard>({ cards: [] });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<KanbanCard | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const t = (key: TranslationKey) => translate(locale, key);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    let active = true;
    getProjectKanbanPi(workingDirectory).then((value) => {
      if (active) { setBoard(value); setReady(true); }
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; previous?.focus(); };
  }, [workingDirectory]);

  async function persist(next: KanbanBoard): Promise<boolean> {
    if (saving.current || !ready) return false;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      // Capture this component's project, not a mutable global active-project value.
      setBoard(await saveProjectKanbanPi(workingDirectory, next));
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally { saving.current = false; setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const card: KanbanCard = {
      id: editing?.id ?? crypto.randomUUID(), title: title.trim(), description,
      columnId: editing?.columnId ?? 'pending',
    };
    const cards = editing ? board.cards.map((item) => item.id === editing.id ? card : item) : [...board.cards, card];
    if (await persist({ cards })) resetDraft();
  }
  function resetDraft() { setEditing(null); setTitle(''); setDescription(''); }
  function edit(card: KanbanCard) {
    setEditing(card); setTitle(card.title); setDescription(card.description);
    dialog.current?.querySelector<HTMLInputElement>('#kanban-card-title')?.focus();
  }
  async function remove(card: KanbanCard) {
    if (!window.confirm(t('kanban.delete_confirm'))) return;
    if (await persist({ cards: board.cards.filter((item) => item.id !== card.id) }) && editing?.id === card.id) resetDraft();
  }
  const columnLabel = (column: KanbanColumnId) => t(`kanban.${column}`);

  return createPortal(
    <dialog className="kanban-dialog" ref={dialog} aria-labelledby="kanban-heading"
      onCancel={(event) => { event.preventDefault(); if (!saving.current) onClose(); }}>
      <header className="kanban-heading">
        <div><h2 id="kanban-heading">{t('kanban.title')}</h2><small>{workingDirectory}</small></div>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('kanban.close')}</button>
      </header>
      {error && <p role="alert" className="kanban-error">{error}</p>}
      {!ready && !error && <p role="status">{t('kanban.loading')}</p>}
      <form onSubmit={submit} className="kanban-form">
        <fieldset disabled={!ready || busy}>
          <label htmlFor="kanban-card-title">{t('kanban.card_title')}</label>
          <input id="kanban-card-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="kanban-card-description">{t('kanban.description')}</label>
          <textarea id="kanban-card-description" maxLength={10000} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="kanban-actions">
            <button type="submit" className="btn btn-primary" disabled={!title.trim()}>{editing ? t('kanban.save') : t('kanban.add')}</button>
            {editing && <button type="button" className="btn" onClick={resetDraft}>{t('kanban.cancel')}</button>}
            {busy && <span role="status">{t('kanban.saving')}</span>}
          </div>
        </fieldset>
      </form>
      <div className="kanban-columns">
        {KANBAN_COLUMNS.map((column) => (
          <section key={column} className="kanban-column" aria-label={columnLabel(column)} data-column={column}>
            <h3>{columnLabel(column)} <span>({board.cards.filter((card) => card.columnId === column).length})</span></h3>
            {board.cards.filter((card) => card.columnId === column).map((card) => (
              <article key={card.id} className="kanban-card" aria-label={card.title}>
                <h4>{card.title}</h4><p>{card.description}</p>
                <label>{t('kanban.move')}
                  <select value={card.columnId} disabled={busy || !ready} aria-label={`${t('kanban.move')}: ${card.title}`}
                    onChange={(e) => void persist({ cards: board.cards.map((item) => item.id === card.id ? { ...item, columnId: e.target.value as KanbanColumnId } : item) })}>
                    {KANBAN_COLUMNS.map((id) => <option key={id} value={id}>{columnLabel(id)}</option>)}
                  </select>
                </label>
                <div className="kanban-actions">
                  <button type="button" className="btn" disabled={busy || !ready} onClick={() => edit(card)}>{t('kanban.edit')}</button>
                  <button type="button" className="btn" disabled={busy || !ready} onClick={() => void remove(card)}>{t('kanban.delete')}</button>
                </div>
              </article>
            ))}
            {board.cards.every((card) => card.columnId !== column) && <p className="kanban-empty">{t('kanban.empty')}</p>}
          </section>
        ))}
      </div>
    </dialog>, document.body,
  );
}
