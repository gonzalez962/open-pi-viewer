import { useCallback, useEffect, useRef, useState } from 'react';
import { pickDirectoryPi } from '@infra/bridge';
import { isWebShim } from '@infra/web-oauth-access';
import { loadProjectOrder, promoteProjectOrder, saveProjectOrder } from '@features/projects/project-order';
import {
  addProject,
  isSameProjectPath,
  decideRemoveProject,
  decideSelectProject,
  loadProjectsRegistry,
  saveProjectsRegistry,
  updateProjectName,
  validateProjectsRegistry,
  type ProjectItem,
  type ProjectsRegistry,
} from '@features/projects/projects';

export interface UseProjectsOptions {
  /** config.workingDirectory, read to seed the initial registry and as pickDirectoryPi's default path. */
  workingDirectory: string;
  getPrimaryPath?: (path: string) => string | undefined;
  isBusy: boolean;
  /** Inversion point: the connection cluster owns StartupManager; this hook only calls it. */
  applyWorkingDirectory: (workingDirectory: string) => void;
  /** Optional callback to activate project chat state in multi-project state when a project becomes active. */
  onActivateProject?: (projectId: string) => void;
}

export interface UseProjectsResult {
  projectsRegistry: ProjectsRegistry;
  projectOrder: string[];
  handleSelectProject: (project: ProjectItem, options?: { promote?: boolean }) => void;
  handleAddProject: (pickedPath?: string, customName?: string) => Promise<void>;
  handleRenameProject: (projectId: string, newName: string) => void;
  handleRemoveProject: (projectId: string) => void;
  /**
   * Adds (or re-activates) a project for the given path without switching the
   * connection's working directory. Exposed for the settings panel's save path
   * (handleSaveAndApplySettings in App.tsx, a settings-cluster handler out of this
   * slice's scope) which used to write `projectsRegistry` directly when the user typed a
   * new working directory into the form; now that the registry setter is encapsulated
   * here, this mirrors that exact inline block (addProject + save + setProjectsRegistry,
   * no applyWorkingDirectory call - the settings panel drives its own connection apply).
   * Supports an optional `options.activate` flag (defaults to true) to prevent background
   * discovery/connection from hijacking the active project selection.
   */
  addProjectForPath: (path: string, options?: { activate?: boolean; promote?: boolean }) => ProjectItem;
}

/**
 * Owns the projects registry and its handlers. Real decision logic (the
 * already-active/isBusy no-op guard on select, and whether removing the active project
 * should switch the working directory) lives in the pure, tested `decideSelectProject`
 * and `decideRemoveProject`; this hook is thin glue between those, storage persistence,
 * and the connection cluster's injected `applyWorkingDirectory`.
 */
export function useProjects({
  workingDirectory,
  getPrimaryPath,
  isBusy,
  applyWorkingDirectory,
  onActivateProject,
}: UseProjectsOptions): UseProjectsResult {
  const [projectsRegistry, setProjectsRegistry] = useState<ProjectsRegistry>(
    () => loadProjectsRegistry(undefined, workingDirectory).registry
  );

  const [projectOrder, setProjectOrder] = useState<string[]>(() => isWebShim() ? loadProjectOrder() : []);
  const projectOrderRef = useRef(projectOrder);
  const promote = useCallback((project: ProjectItem, projects: ProjectItem[]) => {
    if (!isWebShim()) return;
    const primary = getPrimaryPath?.(project.path);
    if (primary && projects.some(member => {
      if (!projectOrderRef.current.includes(member.id)) return false;
      const memberPrimary = getPrimaryPath?.(member.path);
      return isSameProjectPath(member.path, primary) || Boolean(memberPrimary && isSameProjectPath(memberPrimary, primary));
    })) return;
    const next = promoteProjectOrder(projectOrderRef.current, project.id);
    if (next === projectOrderRef.current) return;
    projectOrderRef.current = next;
    setProjectOrder(next);
    saveProjectOrder(next);
  }, [getPrimaryPath]);

  const projectsRegistryRef = useRef(projectsRegistry);
  projectsRegistryRef.current = projectsRegistry;

  // Synchronize in-memory registry when storage updates from external or server sync
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleSync = (event: Event) => {
      const detail = (event as CustomEvent)?.detail;
      const prevActive = projectsRegistryRef.current.activeProjectId;
      const incomingRegistry =
        detail && detail.projects
          ? validateProjectsRegistry(detail.projects).registry
          : loadProjectsRegistry(undefined, workingDirectory).registry;

      // Preserve currently active project if it exists in the incoming project list
      const effectiveActive =
        prevActive && incomingRegistry.projects.some((p) => p.id === prevActive)
          ? prevActive
          : incomingRegistry.activeProjectId;

      const nextRegistry: ProjectsRegistry = {
        ...incomingRegistry,
        activeProjectId: effectiveActive,
      };

      projectsRegistryRef.current = nextRegistry;
      setProjectsRegistry(nextRegistry);

      if (effectiveActive && effectiveActive !== prevActive) {
        onActivateProject?.(effectiveActive);
      }
    };

    window.addEventListener('viewer:storage_synced', handleSync);
    window.addEventListener('storage', handleSync);

    return () => {
      window.removeEventListener('viewer:storage_synced', handleSync);
      window.removeEventListener('storage', handleSync);
    };
  }, [workingDirectory, onActivateProject]);

  const handleSelectProject = useCallback(
    (project: ProjectItem, options?: { promote?: boolean }) => {
      const currentRegistry = projectsRegistryRef.current;
      if (options?.promote !== false && currentRegistry.projects.some(p => p.id === project.id)) promote(project, currentRegistry.projects);
      const decision = decideSelectProject(currentRegistry, project, isBusy);
      if (decision.action === 'noop') {
        return;
      }

      saveProjectsRegistry(decision.registry);
      projectsRegistryRef.current = decision.registry;
      setProjectsRegistry(decision.registry);
      onActivateProject?.(decision.registry.activeProjectId!);
      applyWorkingDirectory(decision.path!);
    },
    [isBusy, applyWorkingDirectory, onActivateProject, promote]
  );

  const handleAddProject = useCallback(
    async (pickedPath?: string, customName?: string) => {
      let targetPath = pickedPath;
      if (!targetPath) {
        const picked = await pickDirectoryPi(workingDirectory);
        if (picked) {
          targetPath = picked;
        }
      }

      if (!targetPath) {
        return;
      }

      const currentRegistry = projectsRegistryRef.current;
      const { registry: nextRegistry, project: addedProj } = addProject(
        currentRegistry,
        targetPath,
        customName
      );
      saveProjectsRegistry(nextRegistry);
      projectsRegistryRef.current = nextRegistry;
      setProjectsRegistry(nextRegistry);

      promote(addedProj, nextRegistry.projects);
      onActivateProject?.(addedProj.id);
      applyWorkingDirectory(addedProj.path);
    },
    [workingDirectory, applyWorkingDirectory, onActivateProject, promote]
  );

  const handleRenameProject = useCallback(
    (projectId: string, newName: string) => {
      const currentRegistry = projectsRegistryRef.current;
      const next = updateProjectName(currentRegistry, projectId, newName);
      saveProjectsRegistry(next);
      projectsRegistryRef.current = next;
      setProjectsRegistry(next);
    },
    []
  );

  const handleRemoveProject = useCallback(
    (projectId: string) => {
      const currentRegistry = projectsRegistryRef.current;
      const decision = decideRemoveProject(currentRegistry, projectId);
      saveProjectsRegistry(decision.registry);
      projectsRegistryRef.current = decision.registry;
      setProjectsRegistry(decision.registry);

      if (decision.applyPath && decision.registry.activeProjectId) {
        onActivateProject?.(decision.registry.activeProjectId);
        applyWorkingDirectory(decision.applyPath);
      }
    },
    [applyWorkingDirectory, onActivateProject]
  );

  const addProjectForPath = useCallback(
    (path: string, options?: { activate?: boolean; promote?: boolean }) => {
      const currentRegistry = projectsRegistryRef.current;
      const { registry: nextRegistry, project: addedProj } = addProject(
        currentRegistry,
        path,
        undefined,
        options
      );
      saveProjectsRegistry(nextRegistry);
      projectsRegistryRef.current = nextRegistry;
      setProjectsRegistry(nextRegistry);
      if (options?.activate !== false && options?.promote) promote(addedProj, nextRegistry.projects);
      return addedProj;
    },
    [promote]
  );

  return {
    projectsRegistry,
    projectOrder,
    handleSelectProject,
    handleAddProject,
    handleRenameProject,
    handleRemoveProject,
    addProjectForPath,
  };
}
