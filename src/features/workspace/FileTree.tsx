import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { translate, type SupportedLocale, type TranslationKey } from '@shared/i18n';
import { listWorkspaceDirPi, readWorkspaceFilePi, createWorkspaceDirPi } from '@infra/bridge';
import type { WorkspaceEntry, WorkspaceFileContent, WorkspaceGitStatus } from '@core/types/workspace';
import { formatFileSize } from '@shared/format';
import {
  getWorkspaceSnapshot,
  updateWorkspaceSnapshot,
  subscribeWorkspaceCache,
  refreshWorkspaceCache,
  updateDirChildrenOnRefresh,
  pruneExpandedDirsOnRefresh,
} from './workspace-cache';
import { FileSearchBar } from './components/FileSearchBar';
import { CreateFolderForm } from './components/CreateFolderForm';

export {
  updateDirChildrenOnRefresh,
  pruneExpandedDirsOnRefresh,
};

export interface FileTreeProps {
  workingDirectory?: string;
  locale: SupportedLocale;
  onOpenFile: (file: WorkspaceFileContent) => void;
  onError?: (err: string) => void;
  refreshInterval?: number;
  refreshTrigger?: number;
  onGitStatusChange?: (status: WorkspaceGitStatus | null) => void;
}



/**
 * Normalizes a relative path for consistent lookups across Windows/POSIX and Git output.
 */
export function normalizeTreePath(p: string | null | undefined): string {
  if (!p) return '';
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Computes a map of directory relative paths to the count of changed files nested within them.
 */
export function computeDirChangesMap(gitStatus: WorkspaceGitStatus | null): Record<string, number> {
  const map: Record<string, number> = {};
  if (!gitStatus?.isRepo) return map;

  const allChangedFiles = [
    ...(gitStatus.modifiedFiles || []),
    ...(gitStatus.addedFiles || []),
    ...(gitStatus.untrackedFiles || []),
  ];

  for (const rawPath of allChangedFiles) {
    const normalized = normalizeTreePath(rawPath);
    if (!normalized) continue;
    const parts = normalized.split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      map[cur] = (map[cur] || 0) + 1;
    }
  }

  return map;
}

/**
 * Computes the total count of modified, added, and untracked files from git status.
 */
export function computeTotalGitChanges(gitStatus: WorkspaceGitStatus | null): number {
  if (!gitStatus?.isRepo) return 0;
  return (
    (gitStatus.modifiedFiles?.length || 0) +
    (gitStatus.addedFiles?.length || 0) +
    (gitStatus.untrackedFiles?.length || 0)
  );
}

/**
 * Returns an SVG icon suited for the file type or extension.
 */
function renderFileIcon(entry: WorkspaceEntry, isExpanded = false) {
  if (entry.isDir) {
    if (isExpanded) {
      return (
        <svg className="tree-icon folder-icon expanded" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <polyline points="2 10 22 10" />
        </svg>
      );
    }
    return (
      <svg className="tree-icon folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    );
  }

  const ext = entry.extension?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return (
      <svg className="tree-icon code-icon js-ts" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    );
  }

  if (ext === 'rs') {
    return (
      <svg className="tree-icon code-icon rust" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    );
  }

  if (ext === 'json') {
    return (
      <svg className="tree-icon code-icon json" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
        <path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
      </svg>
    );
  }

  if (['md', 'txt', 'markdown'].includes(ext)) {
    return (
      <svg className="tree-icon doc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    );
  }

  if (['css', 'scss', 'html', 'svg'].includes(ext)) {
    return (
      <svg className="tree-icon style-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    );
  }

  if (['toml', 'yaml', 'yml', 'env', 'config'].includes(ext) || entry.name.startsWith('.')) {
    return (
      <svg className="tree-icon config-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    );
  }

  return (
    <svg className="tree-icon file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}

interface TreeNodeItemProps {
  entry: WorkspaceEntry;
  depth: number;
  expandedDirs: Set<string>;
  dirChildren: Record<string, WorkspaceEntry[]>;
  loadingDirs: Set<string>;
  loadingFile: string | null;
  gitModifiedSet: Set<string>;
  gitAddedSet: Set<string>;
  gitUntrackedSet: Set<string>;
  dirChangesMap: Record<string, number>;
  onToggleDir: (path: string) => void;
  onSelectFile: (entry: WorkspaceEntry) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const TreeNodeItem: React.FC<TreeNodeItemProps> = ({
  entry,
  depth,
  expandedDirs,
  dirChildren,
  loadingDirs,
  loadingFile,
  gitModifiedSet,
  gitAddedSet,
  gitUntrackedSet,
  dirChangesMap,
  onToggleDir,
  onSelectFile,
  t,
}) => {
  const isExpanded = expandedDirs.has(entry.relativePath);
  const isLoadingChildren = loadingDirs.has(entry.relativePath);
  const isLoadingThisFile = loadingFile === entry.relativePath;
  const children = dirChildren[entry.relativePath] || [];

  const normalizedRel = normalizeTreePath(entry.relativePath);
  const isGitModified = !entry.isDir && gitModifiedSet.has(normalizedRel);
  const isGitAdded = !entry.isDir && gitAddedSet.has(normalizedRel);
  const isGitUntracked = !entry.isDir && gitUntrackedSet.has(normalizedRel);
  const dirChangesCount = entry.isDir ? dirChangesMap[normalizedRel] || 0 : 0;

  const handleClick = () => {
    if (entry.isDir) {
      onToggleDir(entry.relativePath);
    } else {
      onSelectFile(entry);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div className="tree-node-wrapper" role="none">
      <div
        className={`tree-node-row ${entry.isDir ? 'is-directory' : 'is-file'}`}
        style={{ paddingLeft: `${depth * 14 + 10}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="treeitem"
        aria-expanded={entry.isDir ? isExpanded : undefined}
        tabIndex={0}
      >
        <span className="tree-node-arrow" aria-hidden="true">
          {entry.isDir && (
            <svg
              className={`arrow-icon ${isExpanded ? 'open' : ''}`}
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}
        </span>

        <span className="tree-node-icon-wrapper" aria-hidden="true">
          {isLoadingChildren || isLoadingThisFile ? (
            <div className="mini-spinner" />
          ) : (
            renderFileIcon(entry, isExpanded)
          )}
        </span>

        <span className="tree-node-name" title={entry.relativePath}>
          {entry.name}
        </span>

        {/* Directory changed files indicator */}
        {entry.isDir && dirChangesCount > 0 && (
          <span
            className="git-dir-changes-badge"
            title={t('file_tree.git_dir_changes', { count: dirChangesCount })}
          >
            <span className="git-dir-dot" aria-hidden="true" />
            <span className="git-dir-count">{dirChangesCount}</span>
          </span>
        )}

        {/* File Git status badges */}
        {isGitModified && (
          <span className="git-badge git-badge-m" title={t('file_tree.git_modified')}>
            M
          </span>
        )}
        {isGitAdded && (
          <span className="git-badge git-badge-a" title={t('file_tree.git_added')}>
            A
          </span>
        )}
        {isGitUntracked && (
          <span className="git-badge git-badge-u" title={t('file_tree.git_untracked')}>
            U
          </span>
        )}

        {!entry.isDir && entry.size != null && (
          <span className="tree-node-size" aria-hidden="true">
            {formatFileSize(entry.size)}
          </span>
        )}
      </div>

      {entry.isDir && isExpanded && (
        <div className="tree-children-container" role="group">
          {children.map((child) => (
            <TreeNodeItem
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              dirChildren={dirChildren}
              loadingDirs={loadingDirs}
              loadingFile={loadingFile}
              gitModifiedSet={gitModifiedSet}
              gitAddedSet={gitAddedSet}
              gitUntrackedSet={gitUntrackedSet}
              dirChangesMap={dirChangesMap}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              t={t}
            />
          ))}
          {children.length === 0 && !isLoadingChildren && (
            <div
              className="tree-empty-folder"
              style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
            >
              (empty)
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({
  workingDirectory,
  locale,
  onOpenFile,
  onError,
  refreshInterval: _refreshInterval,
  refreshTrigger,
  onGitStatusChange,
}) => {
  const initialSnapshot = getWorkspaceSnapshot(workingDirectory);
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[]>(
    () => initialSnapshot?.rootEntries ?? []
  );
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(
    () => initialSnapshot?.gitStatus ?? null
  );
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => (initialSnapshot?.expandedDirs ? new Set(initialSnapshot.expandedDirs) : new Set())
  );
  const [dirChildren, setDirChildren] = useState<Record<string, WorkspaceEntry[]>>(
    () => initialSnapshot?.dirChildren ?? {}
  );
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [isLoadingRoot, setIsLoadingRoot] = useState<boolean>(
    () => !initialSnapshot?.loaded
  );
  const [isSoftRefreshing, setIsSoftRefreshing] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [isSubmittingFolder, setIsSubmittingFolder] = useState<boolean>(false);
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);

  // Synchronous state adjustment when workingDirectory changes without remount
  const [prevCwd, setPrevCwd] = useState(workingDirectory);
  if (workingDirectory !== prevCwd) {
    setPrevCwd(workingDirectory);
    setIsCreatingFolder(false);
    setIsSubmittingFolder(false);
    setCreateFolderError(null);
    const cached = getWorkspaceSnapshot(workingDirectory);
    if (cached && cached.loaded) {
      setRootEntries(cached.rootEntries);
      setGitStatus(cached.gitStatus);
      setExpandedDirs(new Set(cached.expandedDirs));
      setDirChildren(cached.dirChildren);
      setIsLoadingRoot(false);
      setError(null);
    } else {
      setRootEntries([]);
      setGitStatus(null);
      setExpandedDirs(new Set());
      setDirChildren({});
      setIsLoadingRoot(true);
      setError(null);
    }
  }

  const activeCwdRef = useRef(workingDirectory);
  activeCwdRef.current = workingDirectory;
  const inFlightRefreshRef = useRef<Promise<void> | null>(null);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  // Fast lookup sets for git status
  const gitModifiedSet = useMemo(
    () => new Set((gitStatus?.modifiedFiles || []).map(normalizeTreePath)),
    [gitStatus]
  );
  const gitAddedSet = useMemo(
    () => new Set((gitStatus?.addedFiles || []).map(normalizeTreePath)),
    [gitStatus]
  );
  const gitUntrackedSet = useMemo(
    () => new Set((gitStatus?.untrackedFiles || []).map(normalizeTreePath)),
    [gitStatus]
  );

  // Map of directory path to number of changed files nested inside
  const dirChangesMap = useMemo(
    () => computeDirChangesMap(gitStatus),
    [gitStatus]
  );

  const totalGitChanges = useMemo(
    () => computeTotalGitChanges(gitStatus),
    [gitStatus]
  );

  // Synchronize state with per-cwd cache and subscribe to cache updates
  useEffect(() => {
    setIsCreatingFolder(false);
    setIsSubmittingFolder(false);
    setCreateFolderError(null);

    const cached = getWorkspaceSnapshot(workingDirectory);
    if (cached && cached.loaded) {
      setRootEntries(cached.rootEntries);
      setGitStatus(cached.gitStatus);
      setExpandedDirs(new Set(cached.expandedDirs));
      setDirChildren(cached.dirChildren);
      setIsLoadingRoot(false);
      setError(null);
      onGitStatusChange?.(cached.gitStatus);
    } else {
      setRootEntries([]);
      setGitStatus(null);
      setExpandedDirs(new Set());
      setDirChildren({});
      setIsLoadingRoot(true);
      setError(null);
    }

    if (!workingDirectory) return;

    const unsubscribe = subscribeWorkspaceCache(workingDirectory, (snapshot) => {
      if (activeCwdRef.current !== workingDirectory) return;
      setRootEntries(snapshot.rootEntries);
      setGitStatus(snapshot.gitStatus);
      setExpandedDirs(new Set(snapshot.expandedDirs));
      setDirChildren(snapshot.dirChildren);
      setIsLoadingRoot(false);
      onGitStatusChange?.(snapshot.gitStatus);
    });

    return () => {
      unsubscribe();
    };
  }, [workingDirectory, onGitStatusChange]);

  // Load root directory entries, git status, and revalidate expanded directories
  const refreshAll = useCallback(
    async (isInitial = false) => {
      if (!workingDirectory) return;
      if (inFlightRefreshRef.current) {
        return inFlightRefreshRef.current;
      }

      const run = async () => {
        const cached = getWorkspaceSnapshot(workingDirectory);
        if (isInitial && (!cached || !cached.loaded)) {
          setIsLoadingRoot(true);
          onGitStatusChange?.(null);
        } else {
          setIsSoftRefreshing(true);
        }
        setError(null);

        try {
          const snapshot = await refreshWorkspaceCache(workingDirectory, {
            revalidateExpanded: true,
          });

          if (activeCwdRef.current === workingDirectory) {
            setRootEntries(snapshot.rootEntries);
            setGitStatus(snapshot.gitStatus);
            setExpandedDirs(new Set(snapshot.expandedDirs));
            setDirChildren(snapshot.dirChildren);
            onGitStatusChange?.(snapshot.gitStatus);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isInitial && (!cached || !cached.loaded)) {
            setError(msg);
          }
          onError?.(msg);
        } finally {
          if (activeCwdRef.current === workingDirectory) {
            setIsLoadingRoot(false);
            setIsSoftRefreshing(false);
          }
        }
      };

      const promise = run().finally(() => {
        if (inFlightRefreshRef.current === promise) {
          inFlightRefreshRef.current = null;
        }
      });
      inFlightRefreshRef.current = promise;
      return promise;
    },
    [workingDirectory, onError, onGitStatusChange]
  );

  // Initial load
  useEffect(() => {
    void refreshAll(true);
  }, [refreshAll]);

  // Reactive refresh trigger
  const prevTriggerRef = useRef<number | undefined>(refreshTrigger);
  useEffect(() => {
    if (
      refreshTrigger !== undefined &&
      refreshTrigger !== prevTriggerRef.current
    ) {
      prevTriggerRef.current = refreshTrigger;
      void refreshAll(false);
    }
  }, [refreshTrigger, refreshAll]);

  // Create new folder directly in active workspace root
  const handleCreateFolder = useCallback(
    async (folderName: string) => {
      const targetCwd = workingDirectory;
      const trimmed = folderName.trim();
      if (!trimmed) {
        setCreateFolderError(t('file_tree.folder_name_required'));
        return;
      }
      setIsSubmittingFolder(true);
      setCreateFolderError(null);
      try {
        await createWorkspaceDirPi({
          workingDirectory: targetCwd,
          name: trimmed,
        });

        // Abort state updates if active workspace changed while creating folder
        if (activeCwdRef.current !== targetCwd) {
          return;
        }

        setIsCreatingFolder(false);
        setCreateFolderError(null);

        // Await any existing in-flight scan so pre-mutation cache read finishes and clears
        if (inFlightRefreshRef.current) {
          try {
            await inFlightRefreshRef.current;
          } catch {}
        }

        if (activeCwdRef.current !== targetCwd) {
          return;
        }

        // Fresh post-mutation scan guarantees new folder appears in the explorer
        await refreshAll(false);
      } catch (err) {
        if (activeCwdRef.current !== targetCwd) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setCreateFolderError(msg);
      } finally {
        if (activeCwdRef.current === targetCwd) {
          setIsSubmittingFolder(false);
        }
      }
    },
    [workingDirectory, refreshAll, t]
  );

  const handleToggleDir = useCallback(
    async (relativePath: string) => {
      if (expandedDirs.has(relativePath)) {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.delete(relativePath);
          if (workingDirectory) {
            updateWorkspaceSnapshot(workingDirectory, { expandedDirs: next });
          }
          return next;
        });
        return;
      }

      // If not yet loaded, load children
      if (!dirChildren[relativePath]) {
        setLoadingDirs((prev) => new Set(prev).add(relativePath));
        try {
          const children = await listWorkspaceDirPi({
            workingDirectory,
            relativePath,
          });
          setDirChildren((prev) => {
            const next = { ...prev, [relativePath]: children };
            if (workingDirectory) {
              updateWorkspaceSnapshot(workingDirectory, { dirChildren: next });
            }
            return next;
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onError?.(msg);
        } finally {
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(relativePath);
            return next;
          });
        }
      }

      setExpandedDirs((prev) => {
        const next = new Set(prev).add(relativePath);
        if (workingDirectory) {
          updateWorkspaceSnapshot(workingDirectory, { expandedDirs: next });
        }
        return next;
      });
    },
    [expandedDirs, dirChildren, workingDirectory, onError]
  );

  // Read and open file
  const handleSelectFile = useCallback(
    async (entry: WorkspaceEntry) => {
      setLoadingFile(entry.relativePath);
      try {
        const fileContent = await readWorkspaceFilePi(
          entry.relativePath,
          workingDirectory
        );
        onOpenFile(fileContent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onError?.(msg);
      } finally {
        setLoadingFile(null);
      }
    },
    [workingDirectory, onOpenFile, onError]
  );

  // Flatten all loaded entries for search filtering
  const allLoadedEntries = useMemo(() => {
    const list: WorkspaceEntry[] = [...rootEntries];
    for (const children of Object.values(dirChildren)) {
      list.push(...children);
    }
    return list;
  }, [rootEntries, dirChildren]);

  // Search filtered results
  const searchResults = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return null;
    return allLoadedEntries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.relativePath.toLowerCase().includes(q)
    );
  }, [searchTerm, allLoadedEntries]);

  return (
    <div className="file-tree-root" role="region" aria-label={t('file_tree.title')}>
      {/* Git Repository & Branch Bar */}
      {gitStatus?.isRepo && (
        <div className="workspace-git-bar">
          <div className="git-bar-left">
            <svg
              className="git-icon-repo"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="git-repo-name" title={gitStatus.repoName || ''}>
              {gitStatus.repoName}
            </span>

            {gitStatus.branch && (
              <span className="git-branch-badge" title={gitStatus.branch}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span className="git-branch-name">{gitStatus.branch}</span>
              </span>
            )}
          </div>

          {totalGitChanges > 0 && (
            <span
              className="git-changes-badge"
              title={t('file_tree.git_changed_count', { count: totalGitChanges })}
            >
              {totalGitChanges}
            </span>
          )}
        </div>
      )}

      {/* File Tree Controls */}
      <div className="file-tree-controls">
        <FileSearchBar
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder={t('file_tree.search_placeholder')}
          clearAriaLabel={t('sidebar.clear_search')}
        />

        <button
          type="button"
          className="btn-tree-create-folder"
          onClick={() => {
            setIsCreatingFolder((prev) => !prev);
            setCreateFolderError(null);
          }}
          title={t('file_tree.create_folder')}
          aria-label={t('file_tree.create_folder')}
        >
          {t('file_tree.create_folder')}
        </button>

        <button
          type="button"
          className="btn-tree-refresh"
          onClick={() => void refreshAll(false)}
          disabled={isLoadingRoot || isSoftRefreshing}
          title={t('file_tree.refresh')}
          aria-label={t('file_tree.refresh')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isLoadingRoot || isSoftRefreshing ? 'spin' : ''}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Inline Create Folder Form */}
      {isCreatingFolder && (
        <CreateFolderForm
          onSubmit={handleCreateFolder}
          onCancel={() => {
            setIsCreatingFolder(false);
            setCreateFolderError(null);
          }}
          isLoading={isSubmittingFolder}
          error={createFolderError}
          t={t}
        />
      )}

      {/* Body / Tree View */}
      <div className="file-tree-body">
        {isLoadingRoot && rootEntries.length === 0 ? (
          <div className="sidebar-loading" role="status" aria-live="polite">
            <div className="sidebar-spinner" />
            <span>{t('file_tree.loading')}</span>
          </div>
        ) : error ? (
          <div className="sidebar-error" role="alert">
            <p className="sidebar-error-msg">{error}</p>
            <button type="button" className="btn-retry-session" onClick={() => void refreshAll(true)}>
              {t('action.retry')}
            </button>
          </div>
        ) : searchResults !== null ? (
          /* Search mode: Flat list of matching files */
          <div className="file-tree-search-results" role="list">
            <div className="search-results-header">
              {t('file_tree.search_matches', { count: searchResults.length })}
            </div>
            {searchResults.length === 0 ? (
              <div className="sidebar-empty">
                <p className="sidebar-empty-title">{t('file_tree.no_results')}</p>
              </div>
            ) : (
              searchResults.map((entry) => {
                const normRel = normalizeTreePath(entry.relativePath);
                const isMod = !entry.isDir && gitModifiedSet.has(normRel);
                const isAdd = !entry.isDir && gitAddedSet.has(normRel);
                const isUntracked = !entry.isDir && gitUntrackedSet.has(normRel);
                const dirChanges = entry.isDir ? dirChangesMap[normRel] || 0 : 0;

                return (
                  <div
                    key={entry.relativePath}
                    className={`search-result-item ${entry.isDir ? 'is-dir' : 'is-file'}`}
                    onClick={() => {
                      if (entry.isDir) {
                        setSearchTerm('');
                        handleToggleDir(entry.relativePath);
                      } else {
                        handleSelectFile(entry);
                      }
                    }}
                    role="listitem"
                    tabIndex={0}
                  >
                    <span className="result-icon-wrapper" aria-hidden="true">
                      {renderFileIcon(entry, false)}
                    </span>
                    <div className="result-details">
                      <span className="result-name">{entry.name}</span>
                      <span className="result-path">{entry.relativePath}</span>
                    </div>

                    {entry.isDir && dirChanges > 0 && (
                      <span
                        className="git-dir-changes-badge"
                        title={t('file_tree.git_dir_changes', { count: dirChanges })}
                      >
                        <span className="git-dir-dot" aria-hidden="true" />
                        <span className="git-dir-count">{dirChanges}</span>
                      </span>
                    )}

                    {isMod && (
                      <span className="git-badge git-badge-m" title={t('file_tree.git_modified')}>
                        M
                      </span>
                    )}
                    {isAdd && (
                      <span className="git-badge git-badge-a" title={t('file_tree.git_added')}>
                        A
                      </span>
                    )}
                    {isUntracked && (
                      <span className="git-badge git-badge-u" title={t('file_tree.git_untracked')}>
                        U
                      </span>
                    )}

                    {!entry.isDir && entry.size != null && (
                      <span className="result-size">{formatFileSize(entry.size)}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : rootEntries.length === 0 ? (
          <div className="sidebar-empty">
            <p className="sidebar-empty-title">{t('file_tree.empty')}</p>
          </div>
        ) : (
          /* Tree mode: Hierarchical view */
          <div className="file-tree-list" role="tree">
            {rootEntries.map((entry) => (
              <TreeNodeItem
                key={entry.relativePath}
                entry={entry}
                depth={0}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                loadingDirs={loadingDirs}
                loadingFile={loadingFile}
                gitModifiedSet={gitModifiedSet}
                gitAddedSet={gitAddedSet}
                gitUntrackedSet={gitUntrackedSet}
                dirChangesMap={dirChangesMap}
                onToggleDir={handleToggleDir}
                onSelectFile={handleSelectFile}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
