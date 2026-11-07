import type { ProjectWorktree } from '@core/types/workspace';

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
  let state = { worktrees: options.initialWorktrees ?? [], error: options.initialError ?? null as string | null, busy: false, loaded: Boolean(options.initialWorktrees) };
  const update = (next: Partial<typeof state>) => { state = { ...state, ...next }; options.onChange?.(); };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  return {
    getState: () => state,
    async load() {
      if (state.busy) return;
      update({ busy: true, error: null });
      try {
        const worktrees = await options.listWorktrees({ projectPath: options.projectPath });
        update({ worktrees, loaded: true });
      } catch (error) {
        update({ error: message(error), loaded: false });
      } finally { update({ busy: false }); }
    },
    async create(branch: string, destinationPath: string) {
      if (state.busy) return;
      update({ busy: true, error: null });
      try {
        const result = await options.createWorktree({ projectPath: options.projectPath, branch, destinationPath });
        update({ worktrees: [...state.worktrees.filter(item => item.path !== result.path), result], loaded: true });
      } catch (error) { update({ error: message(error) }); }
      finally { update({ busy: false }); }
    },
    async open(path: string) {
      if (state.busy || !state.loaded || !state.worktrees.some(item => item.path === path)) return;
      update({ busy: true, error: null });
      try {
        const worktrees = await options.listWorktrees({ projectPath: options.projectPath });
        if (!worktrees.some(item => item.path === path)) {
          update({ worktrees, loaded: false, error: 'Worktree is no longer listed. Refresh and try again.' });
          return;
        }
        update({ worktrees });
        options.onOpen(path);
      } catch (error) { update({ error: message(error), loaded: false }); }
      finally { update({ busy: false }); }
    },
  };
}
