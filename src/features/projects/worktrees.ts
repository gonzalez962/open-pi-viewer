import type { ProjectWorktree } from '@core/types/workspace';
import { cacheForList } from './worktree-cache';

interface Options {
  projectPath: string;
  listWorktrees: (payload: { projectPath: string }) => Promise<ProjectWorktree[]>;
  createWorktree: (payload: { projectPath: string; branch: string; destinationPath: string }) => Promise<ProjectWorktree>;
  onOpen: (path: string) => void;
  onChange?: () => void;
  initialWorktrees?: ProjectWorktree[];
  initialError?: string | null;
}

export function createProjectWorktreesController(options: Options) {
  const cache = cacheForList(options.listWorktrees);
  let state = { worktrees: options.initialWorktrees ?? cache.get(options.projectPath) ?? [], error: options.initialError ?? null as string | null, busy: false, loaded: Boolean(options.initialWorktrees ?? cache.get(options.projectPath)) };
  const update = (next: Partial<typeof state>) => { state = { ...state, ...next }; options.onChange?.(); };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  let unsubscribe: (() => void) | undefined;
  const subscribe = () => {
    if (unsubscribe) return;
    unsubscribe = cache.subscribe(() => {
      const worktrees = cache.get(options.projectPath);
      if (worktrees && worktrees !== state.worktrees) update({ worktrees, loaded: true });
    });
  };
  async function read(fresh: boolean) {
    if (state.busy) return;
    const cached = !fresh && cache.get(options.projectPath);
    if (cached) {
      if (cached !== state.worktrees || !state.loaded) update({ worktrees: cached, loaded: true });
      return;
    }
    update({ busy: true, error: null });
    try { const worktrees = await cache.read(options.projectPath, fresh); update({ worktrees, loaded: true }); }
    catch (error) { update({ error: message(error) }); }
    finally { update({ busy: false }); }
  }
  return {
    getState: () => state,
    dispose: () => { unsubscribe?.(); unsubscribe = undefined; },
    load: () => { subscribe(); return read(false); },
    refresh: () => read(true),
    async create(branch: string, destinationPath: string) {
      if (state.busy) return;
      update({ busy: true, error: null });
      try {
        const result = await options.createWorktree({ projectPath: options.projectPath, branch, destinationPath });
        cache.add(options.projectPath, result);
      } catch (error) { update({ error: message(error) }); }
      finally { update({ busy: false }); }
    },
    async open(path: string) {
      if (state.busy || !state.loaded || !state.worktrees.some(item => item.path === path)) return;
      update({ busy: true, error: null });
      try {
        const worktrees = await cache.read(options.projectPath, true);
        if (!worktrees.some(item => item.path === path)) {
          update({ worktrees, loaded: true, error: 'Worktree is no longer listed. Refresh and try again.' });
          return;
        }
        update({ worktrees }); options.onOpen(path);
      } catch (error) { update({ error: message(error) }); }
      finally { update({ busy: false }); }
    },
  };
}
