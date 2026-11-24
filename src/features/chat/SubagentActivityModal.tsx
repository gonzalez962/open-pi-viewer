import { Component, createRef, useCallback, type ReactNode } from 'react';
import type { SubagentDetail } from '@core/types/agent-activity';
import type { TranslationKey } from '@shared/i18n';
import { isNearBottom, scrollToBottom } from '@shared/scroll';
import { ThinkingCard, ToolCard } from './ActivityBlocks';

function toolArgs(args: string): Record<string, unknown> | string {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : args;
  } catch {
    return args;
  }
}

type ThreadProps = { taskId: string; children: ReactNode };
type ThreadScrollSnapshot = { atBottom: boolean; scrollTop: number };

class SubagentThread extends Component<ThreadProps> {
  private readonly viewport = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: ThreadProps): ThreadScrollSnapshot | null {
    const el = this.viewport.current;
    if (!el || previous.taskId !== this.props.taskId) return null;
    // Read the old DOM at commit time: new snapshots can change any part of the history.
    return { atBottom: isNearBottom(el, 1), scrollTop: el.scrollTop };
  }

  componentDidUpdate(_previous: ThreadProps, _state: unknown, snapshot: ThreadScrollSnapshot | null) {
    const el = this.viewport.current;
    if (!el || !snapshot) return;
    if (snapshot.atBottom) scrollToBottom(el);
    else if (el.scrollTop !== snapshot.scrollTop) el.scrollTop = snapshot.scrollTop;
  }

  render() {
    // The browser's scroll anchoring must not move a paused viewport during a replacement.
    return <div ref={this.viewport} className="subagent-thread" style={{ overflowAnchor: 'none' }}>{this.props.children}</div>;
  }
}

export function SubagentActivityModal({ tasks, selectedId, onSelect, onClose, t }: {
  tasks: SubagentDetail[];
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
      <header className="modal-header"><h2 className="modal-title">{t('subagent.title')}</h2><button type="button" className="modal-close-btn" onClick={onClose} aria-label={t('subagent.close')} title={t('subagent.close')}>✕</button></header>
      <div className="subagent-body">
        <nav aria-label={t('subagent.tasks')}>{tasks.map(task => <button className="subagent-selector" type="button" key={task.id} aria-pressed={task.id === selected.id} onClick={() => onSelect(task.id)}><span className="subagent-selector-name">{task.label || task.agent}</span><span className={`subagent-selector-status status-${task.status}`}>{task.status}</span></button>)}</nav>
        <SubagentThread taskId={selected.id}>
          <h3>{selected.label || selected.agent}</h3>
          {selected.reportedModel && <p>{t('subagent.reported_model', { model: selected.reportedModel })}</p>}
          {selected.lastStep && <p>{selected.lastStep}</p>}
          <p>{t('subagent.bounded')}</p>
          {tasks.some(task => task.viewerTruncated || task.thread?.viewerTruncated) && <p>{t('subagent.viewer_truncated')}</p>}
          {selected.thread?.dropped ? <p>{t('subagent.partial')}</p> : null}
          {!selected.thread?.items.length ? <p>{t('subagent.unavailable')}</p> : <div className="subagent-events" key={selected.id}>{selected.thread.items.map((item, index) => {
            if (item.kind === 'tool') return <ToolCard key={index} t={t} block={{ type: 'tool_call', id: String(index), name: item.name, args: toolArgs(item.args), status: item.running ? 'running' : item.isError ? 'error' : 'completed', output: item.output, isError: item.isError }} />;
            if (item.kind === 'thinking') return <ThinkingCard key={index} t={t} block={{ type: 'thinking', thinking: item.text }} />;
            return <div className="subagent-message message-content message-literal" key={index}><strong>{item.kind}</strong><div>{item.text}</div></div>;
          })}</div>}
        </SubagentThread>
      </div>
    </section>
  </div>;
}
