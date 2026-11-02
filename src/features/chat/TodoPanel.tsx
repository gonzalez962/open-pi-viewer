import { parseTodo } from '@core/todo';
import type { TranslationKey } from '@shared/i18n';

export function TodoPanel({ todo, expanded, onToggle, t }: {
  todo: unknown;
  expanded: boolean;
  onToggle: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const snapshot = parseTodo(todo);
  if (!snapshot || snapshot.tasks.length === 0) return null;
  const done = snapshot.tasks.filter(task => task.status === 'done').length;
  const total = snapshot.tasks.filter(task => task.status !== 'dropped').length;
  return <section className="todo-panel" aria-label={t('todo.title')}>
    <button type="button" className="todo-toggle" onClick={onToggle} aria-expanded={expanded}>
      <span>{expanded ? '▾' : '▸'} {t('todo.title')}</span><span>{done}/{total}</span>
    </button>
    {expanded && <ul className="todo-list">{snapshot.tasks.map(task => <li key={task.id} className={`todo-task todo-${task.status}`}>
      <span aria-label={t(`todo.${task.status}`)}>{({ pending: '○', in_progress: '◐', blocked: '⊘', done: '✓', dropped: '✕' })[task.status]}</span>
      <span>{task.title}{task.note && <small> · {task.note}</small>}</span>
    </li>)}</ul>}
  </section>;
}
