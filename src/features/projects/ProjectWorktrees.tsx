import { useMemo, useReducer, useState } from 'react';
import type { ProjectWorktree } from '@core/types/workspace';
import { listProjectWorktreesPi, createProjectWorktreePi } from '@infra/bridge';
import { translate, type SupportedLocale } from '@shared/i18n';
import { createProjectWorktreesController } from './worktrees';

export function ProjectWorktrees({ projectPath, locale, onOpen, initialWorktrees, initialError }: {
  projectPath: string; locale: SupportedLocale; onOpen: (path: string) => void;
  initialWorktrees?: ProjectWorktree[]; initialError?: string | null;
}) {
  const [, redraw] = useReducer(n => n + 1, 0);
  const [branch, setBranch] = useState('');
  const [destination, setDestination] = useState('');
  const controller = useMemo(() => createProjectWorktreesController({ projectPath, onOpen, listWorktrees: listProjectWorktreesPi, createWorktree: createProjectWorktreePi, onChange: redraw, initialWorktrees, initialError }), [projectPath, onOpen]);
  const state = controller.getState();
  const t = (key: 'title' | 'refresh' | 'loading' | 'detached' | 'branch' | 'destination' | 'hint' | 'create') => translate(locale, `worktrees.${key}`);
  return <section className="project-worktrees" aria-label={t('title')}>
    <strong>{t('title')}</strong><span className="project-worktrees-path">{projectPath}</span>
    <button type="button" disabled={state.busy} onClick={() => void controller.load()}>{t('refresh')}</button>
    {state.busy && <span role="status">{t('loading')}</span>}
    {state.error && <div role="alert" className="project-worktrees-error">{state.error}</div>}
    {state.loaded && <ul>{state.worktrees.map(item => <li key={item.path}>
      <button type="button" disabled={state.busy} onClick={() => void controller.open(item.path)}>
        <strong>{item.branch || t('detached')}</strong><span className="project-worktrees-path">{item.path}</span>
      </button>
    </li>)}</ul>}
    <form onSubmit={e => { e.preventDefault(); void controller.create(branch, destination); }}>
      <label>{t('branch')}<input value={branch} onChange={e => setBranch(e.target.value)} disabled={state.busy} required /></label>
      <label>{t('destination')}<input value={destination} onChange={e => setDestination(e.target.value)} disabled={state.busy} required /></label>
      <small>{t('hint')}</small><button type="submit" disabled={state.busy}>{t('create')}</button>
    </form>
  </section>;
}
