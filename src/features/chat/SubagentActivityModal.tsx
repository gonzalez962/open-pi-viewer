import { useCallback } from 'react';
import type { SubagentTask } from '@core/types/agent-activity';
import type { TranslationKey } from '@shared/i18n';

export function SubagentActivityModal({ tasks, selectedId, onSelect, onClose, t }: {
  tasks: SubagentTask[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const focusDialog = useCallback((element: HTMLElement | null) => {
    element?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.style.display !== 'none' && element.style.visibility !== 'hidden');
    if (!elements.length) { event.preventDefault(); return; }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = event.target;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active as Node))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active as Node))) { event.preventDefault(); first.focus(); }
  };
  const selected = tasks.find(task => task.id === selectedId) ?? tasks[0];
  if (!selected) return null;
  return <div className="modal-overlay subagent-overlay">
    <section ref={focusDialog} onKeyDown={onKeyDown} className="subagent-modal" role="dialog" aria-modal="true" aria-label={t('subagent.title')}>
      <header><h2>{t('subagent.title')}</h2><button type="button" onClick={onClose} aria-label={t('subagent.close')}>×</button></header>
      <div className="subagent-body">
        <nav aria-label={t('subagent.tasks')}>{tasks.map(task => <button type="button" key={task.id} aria-pressed={task.id === selected.id} onClick={() => onSelect(task.id)}>{task.label || task.agent} · {task.status}</button>)}</nav>
        <div className="subagent-thread">
          <h3>{selected.label || selected.agent}</h3>
          {selected.lastStep && <p>{selected.lastStep}</p>}
          <p>{t('subagent.bounded')}</p>
          {tasks.some(task => task.viewerTruncated || task.thread?.viewerTruncated) && <p>{t('subagent.viewer_truncated')}</p>}
          {selected.thread?.dropped ? <p>{t('subagent.partial')}</p> : null}
          {!selected.thread?.items.length ? <p>{t('subagent.unavailable')}</p> : selected.thread.items.map((item, index) => <div key={index}>
            <strong>{item.kind === 'tool' ? item.name : item.kind}</strong>
            {item.kind === 'tool' ? <><pre>{item.args}</pre><pre>{item.output}</pre></> : <pre>{item.text}</pre>}
          </div>)}
        </div>
      </div>
    </section>
  </div>;
}
