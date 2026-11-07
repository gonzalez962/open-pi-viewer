import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ProjectWorktree } from '@core/types/workspace';
import { listProjectWorktreesPi, createProjectWorktreePi } from '@infra/bridge';
import { translate, type SupportedLocale } from '@shared/i18n';
import { createProjectWorktreesController } from './worktrees';
import { isSameProjectPath } from './projects';
import { worktreeCache } from './worktree-cache';
import { getWorktreeRepositoryColor } from './worktree-colors';
import type { CSSProperties } from 'react';

export function ProjectWorktrees({ projectPath, locale, onOpen, initialWorktrees, initialError, getPrimaryPath = worktreeCache.getPrimaryPath }: {
  projectPath: string; locale: SupportedLocale; onOpen: (path: string) => void;
  initialWorktrees?: ProjectWorktree[]; initialError?: string | null;
  getPrimaryPath?: (path: string) => string | undefined;
}) {
  const [, redraw] = useReducer(n => n + 1, 0);
  const [branch, setBranch] = useState('');
  const [destination, setDestination] = useState('');
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const instance = useMemo(() => {
    const lifecycle = { active: true };
    const controller = createProjectWorktreesController({ projectPath, onOpen: path => { if (lifecycle.active) onOpenRef.current(path); }, listWorktrees: listProjectWorktreesPi, createWorktree: createProjectWorktreePi, onChange: () => { if (lifecycle.active) redraw(); }, initialWorktrees, initialError });
    return { controller, lifecycle };
  }, [projectPath]);
  const { controller, lifecycle } = instance;
  useEffect(() => {
    lifecycle.active = true;
    void controller.load();
    return () => { lifecycle.active = false; controller.dispose(); };
  }, [controller, lifecycle]);
  const state = controller.getState();
  const t = (key: 'title' | 'refresh' | 'loading' | 'detached' | 'branch' | 'destination' | 'hint' | 'create') => translate(locale, `worktrees.${key}`);
  return <section className="project-worktrees" aria-label={t('title')}>
    <div className="project-worktrees-toolbar"><span className="project-worktrees-path" title={projectPath}>{projectPath}</span>
    <button className="github-clone-browse-btn" type="button" disabled={state.busy} onClick={() => void controller.refresh()}>{t('refresh')}</button></div>
    {state.busy && <span role="status">{t('loading')}</span>}
    {state.error && <div role="alert" className="project-worktrees-error">{state.error}</div>}
    {state.loaded && <ul>{state.worktrees.map(item => <li key={item.path}>
      <button style={getPrimaryPath(item.path) ? { '--repository-color': getWorktreeRepositoryColor(getPrimaryPath(item.path)!) } as CSSProperties : undefined} className={`project-worktree-row${isSameProjectPath(item.path, projectPath) ? ' is-current' : ''}`} type="button" aria-current={isSameProjectPath(item.path, projectPath) ? 'true' : undefined} disabled={state.busy} onClick={() => void controller.open(item.path)}>
        <strong>{item.branch || t('detached')}</strong><span className="project-worktrees-path" title={item.path}>{item.path}</span>
      </button>
    </li>)}</ul>}
    <form onSubmit={e => { e.preventDefault(); void controller.create(branch, destination); }}>
      <strong>{t('create')}</strong>
      <label className="github-clone-label">{t('branch')}<input className="github-clone-input" value={branch} onChange={e => setBranch(e.target.value)} disabled={state.busy} required /></label>
      <label className="github-clone-label">{t('destination')}<input className="github-clone-input" value={destination} onChange={e => setDestination(e.target.value)} disabled={state.busy} /></label>
      <small className="github-clone-hint">{t('hint')}</small><button className="github-clone-btn-submit" type="submit" disabled={state.busy}>{t('create')}</button>
    </form>
  </section>;
}
