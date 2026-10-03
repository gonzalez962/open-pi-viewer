import { useCallback, useRef, useState } from 'react';
import { pickDirectoryPi } from '@infra/bridge';
import {
  addProject,
  decideRemoveProject,
  decideSelectProject,
  loadProjectsRegistry,
  saveProjectsRegistry,
  updateProjectName,
  type ProjectItem,
  type ProjectsRegistry,
} from '@features/projects/projects';

export interface UseProjectsOptions {
  /** config.workingDirectory, read to seed the initial registry and as pickDirectoryPi's default path. */
  workingDirectory: string;
  isBusy: boolean;
  /** Inversion point: the connection cluster owns StartupManager; this hook only calls it. */
  applyWorkingDirectory: (workingDirectory: string) => void;
  /** Optional callback to activate project chat state in multi-project state when a project becomes active. */
  onActivateProject?: (projectId: string) => void;
}

export interface UseProjectsResult {
  projectsRegistry: ProjectsRegistry;
  handleSelectProject: (project: ProjectItem) => void;
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
   */
  addProjectForPath: (path: string) => void;
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
  isBusy,
  applyWorkingDirectory,
  onActivateProject,
}: UseProjectsOptions): UseProjectsResult {
  const [projectsRegistry, setProjectsRegistry] = useState<ProjectsRegistry>(
    () => loadProjectsRegistry(undefined, workingDirectory).registry
  );

  const projectsRegistryRef = useRef(projectsRegistry);
  projectsRegistryRef.current = projectsRegistry;

  const handleSelectProject = useCallback(
    (project: ProjectItem) => {
      const currentRegistry = projectsRegistryRef.current;
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
    [isBusy, applyWorkingDirectory, onActivateProject]
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

      onActivateProject?.(addedProj.id);
      applyWorkingDirectory(addedProj.path);
    },
    [workingDirectory, applyWorkingDirectory, onActivateProject]
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
    (path: string) => {
      const currentRegistry = projectsRegistryRef.current;
      const { registry: nextRegistry } = addProject(currentRegistry, path);
      saveProjectsRegistry(nextRegistry);
      projectsRegistryRef.current = nextRegistry;
      setProjectsRegistry(nextRegistry);
    },
    []
  );

  return {
    projectsRegistry,
    handleSelectProject,
    handleAddProject,
    handleRenameProject,
    handleRemoveProject,
    addProjectForPath,
  };
}
