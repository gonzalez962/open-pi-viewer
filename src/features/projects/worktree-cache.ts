import type { ProjectWorktree } from '@core/types/workspace';
import { listProjectWorktreesPi } from '@infra/bridge';
import { isSameProjectPath } from './projects';

type List = (payload: { projectPath: string }) => Promise<ProjectWorktree[]>;
type Entry = { aliases: string[]; data?: ProjectWorktree[]; pending?: Promise<ProjectWorktree[]>; version: number; parent?: Entry };

export function createWorktreeCache(list: List) {
  const entries: Entry[] = [];
  const listeners = new Set<() => void>();
  let clock = 0;
  const relations: Array<{ path: string; primaryPath: string; missing: boolean }> = [];
  const confirmed: Array<{ path: string; primaryPath: string }> = [];
  const owner = (e: Entry): Entry => e.parent ? owner(e.parent) : e;
  const entry = (path: string) => {
    let found = entries.find(e => !e.parent && e.aliases.some(alias => isSameProjectPath(alias, path)));
    if (!found) { found = { aliases: [path], version: 0 }; entries.push(found); }
    return found;
  };
  const notify = () => listeners.forEach(listener => listener());
  const merge = (original: Entry, data: ProjectWorktree[]) => {
    let e = owner(original);
    const paths = [...e.aliases, ...data.map(item => item.path)];
    for (const candidate of entries) {
      if (candidate === e || candidate.parent || !candidate.aliases.some(alias => paths.some(path => isSameProjectPath(alias, path)))) continue;
      if (candidate.version > e.version) {
        const previous = e;
        e = candidate;
        candidate.data ??= previous.data;
        previous.parent = candidate;
        candidate.aliases.push(...previous.aliases);
        candidate.pending ??= previous.pending;
      } else {
        e.data ??= candidate.data;
        candidate.parent = e;
        e.aliases.push(...candidate.aliases);
        e.pending ??= candidate.pending;
      }
      paths.push(...e.aliases);
    }
    for (const path of paths) if (!e.aliases.some(alias => isSameProjectPath(alias, path))) e.aliases.push(path);
    return e;
  };
  return {
    get: (path: string) => entry(path).data,
    getPrimaryPath: (path: string) => confirmed.find(item => isSameProjectPath(item.path, path))?.primaryPath,
    classify(path: string) {
      const relation = relations.find(item => isSameProjectPath(item.path, path));
      return relation ? { kind: relation.missing ? 'missing' as const : 'linked' as const, primaryPath: relation.primaryPath } : { kind: 'unknown' as const };
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async read(path: string, fresh = false): Promise<ProjectWorktree[]> {
      const e = entry(path);
      if (!fresh && e.data) return e.data;
      if (!fresh && e.pending) return e.pending;
      const version = ++clock;
      e.version = version;
      const known = relations.find(item => isSameProjectPath(item.path, path));
      const queryPath = fresh && known ? known.primaryPath : path;
      const pending = list({ projectPath: queryPath }).then(data => {
        const current = merge(e, data);
        if (version === current.version || !current.data) {
          current.data = data;
          if (version === current.version && data.length) {
            const primaryPath = data[0].path;
            for (const item of data) {
              const known = confirmed.find(value => isSameProjectPath(value.path, item.path));
              if (known) known.primaryPath = primaryPath;
              else confirmed.push({ path: item.path, primaryPath });
            }
            for (const item of data.slice(1)) {
              let relation = relations.find(value => isSameProjectPath(value.path, item.path));
              if (!relation) { relation = { path: item.path, primaryPath, missing: false }; relations.push(relation); }
              relation.primaryPath = primaryPath;
              relation.missing = false;
            }
            if (isSameProjectPath(queryPath, primaryPath)) {
              for (const relation of relations) {
                if (isSameProjectPath(relation.primaryPath, primaryPath)) relation.missing = !data.some(item => isSameProjectPath(item.path, relation.path));
              }
            }
          }
          notify();
        }
        return current.data ?? data;
      }).finally(() => { const current = owner(e); if (current.pending === pending) current.pending = undefined; });
      e.pending = pending;
      return pending;
    },
    add(path: string, item: ProjectWorktree) {
      const e = entry(path);
      e.version = ++clock;
      const data = [...(e.data ?? []).filter(old => !isSameProjectPath(old.path, item.path)), item];
      const current = merge(e, data);
      current.data = data;
      const confirmedPrimary = confirmed.find(value => isSameProjectPath(value.path, path))?.primaryPath;
      if (confirmedPrimary && !confirmed.some(value => isSameProjectPath(value.path, item.path))) confirmed.push({ path: item.path, primaryPath: confirmedPrimary });
      const primaryPath = relations.find(value => isSameProjectPath(value.path, path))?.primaryPath ?? (data.length > 1 ? data[0].path : undefined);
      if (primaryPath && !isSameProjectPath(primaryPath, item.path)) {
        let relation = relations.find(value => isSameProjectPath(value.path, item.path));
        if (!relation) { relation = { path: item.path, primaryPath, missing: false }; relations.push(relation); }
        relation.missing = false;
      }
      notify();
    },
  };
}

export const worktreeCache = createWorktreeCache(listProjectWorktreesPi);
const injected = new WeakMap<List, ReturnType<typeof createWorktreeCache>>();
export function cacheForList(list: List) {
  if (list === listProjectWorktreesPi) return worktreeCache;
  let cache = injected.get(list);
  if (!cache) { cache = createWorktreeCache(list); injected.set(list, cache); }
  return cache;
}
