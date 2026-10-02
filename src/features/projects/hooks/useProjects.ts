import { useCallback, useState } from 'react';
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
}: UseProjectsOptions): UseProjectsResult {
  const [projectsRegistry, setProjectsRegistry] = useState<ProjectsRegistry>(
    () => loadProjectsRegistry(undefined, workingDirectory).registry
  );

  const handleSelectProject = useCallback(
    (project: ProjectItem) => {
      const decision = decideSelectProject(projectsRegistry, project, isBusy);
      if (decision.action === 'noop') {
        return;
      }

      saveProjectsRegistry(decision.registry);
      setProjectsRegistry(decision.registry);
      applyWorkingDirectory(decision.path!);
    },
    [projectsRegistry, isBusy, applyWorkingDirectory]
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

      if (targetPath) {
        const { registry: nextRegistry, project: addedProj } = addProject(
          projectsRegistry,
          targetPath,
          customName
        );
        saveProjectsRegistry(nextRegistry);
        setProjectsRegistry(nextRegistry);

        applyWorkingDirectory(addedProj.path);
      }
    },
    [workingDirectory, projectsRegistry, applyWorkingDirectory]
  );

  const handleRenameProject = useCallback(
    (projectId: string, newName: string) => {
      const next = updateProjectName(projectsRegistry, projectId, newName);
      saveProjectsRegistry(next);
      setProjectsRegistry(next);
    },
    [projectsRegistry]
  );

  const handleRemoveProject = useCallback(
    (projectId: string) => {
      const decision = decideRemoveProject(projectsRegistry, projectId);
      saveProjectsRegistry(decision.registry);
      setProjectsRegistry(decision.registry);

      if (decision.applyPath) {
        applyWorkingDirectory(decision.applyPath);
      }
    },
    [projectsRegistry, applyWorkingDirectory]
  );

  const addProjectForPath = useCallback(
    (path: string) => {
      const { registry: nextRegistry } = addProject(projectsRegistry, path);
      saveProjectsRegistry(nextRegistry);
      setProjectsRegistry(nextRegistry);
    },
    [projectsRegistry]
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
