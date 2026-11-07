import { useEffect, useState } from 'react';
import { worktreeCache } from '../worktree-cache';
import type { ProjectWorktree } from '@core/types/workspace';
import { isSameProjectPath, type ProjectItem } from '../projects';

export function isSecondaryWorktree(path: string, lists: ProjectWorktree[][]): boolean {
  return lists.some(list => list.length > 1 &&
    list.slice(1).some(item => isSameProjectPath(item.path, path)) &&
    !isSameProjectPath(list[0].path, path));
}

export function classifyProjectWorktree(path: string, cache: Pick<typeof worktreeCache, 'classify'> = worktreeCache) {
  return cache.classify(path);
}

export function useProjectWorktrees(projects: ProjectItem[], enabled: boolean, revision: number) {
  const paths = JSON.stringify(projects.map(project => project.path));
  const [result, setResult] = useState<{ paths: string; revision: number; lists: ProjectWorktree[][] }>({ paths: '', revision: -1, lists: [] });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const projectPaths: string[] = JSON.parse(paths);
    const sync = () => { if (current) setResult({ paths, revision, lists: projectPaths.map(path => worktreeCache.get(path)).filter((list): list is ProjectWorktree[] => Boolean(list)) }); };
    const unsubscribe = worktreeCache.subscribe(sync);
    sync();
    void Promise.all(projectPaths.map(path => worktreeCache.read(path).catch(() => undefined))).then(sync);
    const refresh = () => {
      const primaries = projectPaths.map(path => classifyProjectWorktree(path)).filter(result => result.kind !== 'unknown').map(result => result.primaryPath);
      const unique = primaries.filter((path, index) => primaries.findIndex(other => isSameProjectPath(path, other)) === index);
      void Promise.all(unique.map(path => worktreeCache.read(path, true).catch(() => undefined)));
    };
    window.addEventListener('focus', refresh);
    return () => { current = false; unsubscribe(); window.removeEventListener('focus', refresh); };
  }, [paths, enabled, revision]);

  const lists = enabled && result.paths === paths && result.revision === revision ? result.lists : [];
  const classify = (path: string) => enabled && result.paths === paths && result.revision === revision ? classifyProjectWorktree(path) : { kind: 'unknown' as const };
  const isSecondary = (path: string) => classify(path).kind === 'linked' || isSecondaryWorktree(path, lists) && classify(path).kind !== 'missing';
  const getPrimaryPath = (path: string) => enabled && result.paths === paths && result.revision === revision ? worktreeCache.getPrimaryPath(path) : undefined;
  return { isSecondary, classify, getPrimaryPath };
}
