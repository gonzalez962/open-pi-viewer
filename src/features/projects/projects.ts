import { isWindowsPath, normalizeWorkingDirectory } from '@core/session';

export const PROJECTS_STORAGE_KEY = 'pi_viewer_projects';

export interface ProjectItem {
  id: string;
  path: string;
  customName?: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ProjectsRegistry {
  projects: ProjectItem[];
  activeProjectId: string | null;
}

export interface ProjectsLoadResult {
  registry: ProjectsRegistry;
  warning?: string;
}

export interface ProjectsSaveResult {
  success: boolean;
  error?: string;
}

function generateProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Extracts directory name from Windows (C:\foo\bar, C:/foo/bar) and POSIX (/home/user/project) paths,
 * handling trailing slashes cleanly.
 */
export function deriveProjectBasename(path: string): string {
  if (!path) return '';
  const trimmed = path.trim().replace(/\\/g, '/');
  if (!trimmed) return '';

  if (trimmed === '/') return '/';

  const stripped = trimmed.replace(/\/+$/, '');
  if (!stripped) return '';

  if (/^[a-zA-Z]:$/.test(stripped)) {
    return stripped;
  }

  const parts = stripped.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Returns project customName if present, otherwise directory basename or 'Project' fallback.
 */
export function getProjectDisplayName(project: ProjectItem): string {
  return project.customName?.trim() || deriveProjectBasename(project.path) || 'Project';
}

/**
 * Extracts 1-2 uppercase characters for square tile avatar (e.g. "pi-viewer" -> "PV", "my project" -> "MP", "App" -> "AP" or "A").
 */
export function getProjectMonogram(name: string): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  const words = trimmed.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Uses normalizeWorkingDirectory from src/session.ts to ensure consistent path representations.
 */
export function normalizeProjectPath(path: string): string {
  return normalizeWorkingDirectory(path);
}

function mapNetworkPathToPosix(p: string): string {
  if (/^[zZ]:[\\\/]?/i.test(p)) {
    const sub = p.slice(2).replace(/^[\\\/]+/, '').replace(/\\/g, '/');
    return sub ? `/home/hermes/Desarrollos/${sub}` : '/home/hermes/Desarrollos';
  }
  return p;
}

/**
 * Compares normalized paths case-insensitively on Windows and case-sensitively on POSIX,
 * with cross-platform network drive awareness (e.g. Z:\ maps to /home/hermes/Desarrollos).
 */
export function isSameProjectPath(pathA: string, pathB: string): boolean {
  const normA = normalizeProjectPath(pathA);
  const normB = normalizeProjectPath(pathB);
  if (!normA && !normB) return true;
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (isWindowsPath(normA) && isWindowsPath(normB)) {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  // Check if one is a network drive (e.g. Z:\...) mapping to Samba share on POSIX
  const isNetA = /^[zZ]:[\\\/]?/i.test(normA);
  const isNetB = /^[zZ]:[\\\/]?/i.test(normB);
  if (isNetA || isNetB) {
    const posixA = mapNetworkPathToPosix(normA);
    const posixB = mapNetworkPathToPosix(normB);
    if (posixA.toLowerCase() === posixB.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function findProjectByCwd(
  projects: ProjectItem[],
  cwd?: string | null
): ProjectItem | undefined {
  if (!cwd) return undefined;
  return projects.find((p) => isSameProjectPath(p.path, cwd));
}

/**
 * Validates registry structure with honest fallbacks for invalid items.
 */
export function validateProjectsRegistry(input: unknown): {
  valid: boolean;
  registry: ProjectsRegistry;
  warning?: string;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      registry: { projects: [], activeProjectId: null },
      warning: 'Projects registry payload must be a non-null object',
    };
  }

  const raw = input as Record<string, unknown>;
  const warnings: string[] = [];

  let rawProjects: unknown[] = [];
  if (!Array.isArray(raw.projects)) {
    warnings.push('Projects registry projects property must be an array');
  } else {
    rawProjects = raw.projects;
  }

  const validProjects: ProjectItem[] = [];
  for (let i = 0; i < rawProjects.length; i++) {
    const item = rawProjects[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`Project item at index ${i} is not a valid object`);
      continue;
    }

    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id.trim()) {
      warnings.push(`Project item at index ${i} has invalid or missing id`);
      continue;
    }

    if (typeof rec.path !== 'string' || !rec.path.trim()) {
      warnings.push(`Project item at index ${i} has invalid or missing path`);
      continue;
    }

    const normalizedPath = normalizeProjectPath(rec.path);
    if (!normalizedPath) {
      warnings.push(`Project item at index ${i} has empty normalized path`);
      continue;
    }

    const id = rec.id.trim();
    let createdAt =
      typeof rec.createdAt === 'string' && rec.createdAt.trim()
        ? rec.createdAt.trim()
        : '';
    let lastOpenedAt =
      typeof rec.lastOpenedAt === 'string' && rec.lastOpenedAt.trim()
        ? rec.lastOpenedAt.trim()
        : '';

    if (!createdAt) {
      createdAt = new Date().toISOString();
      warnings.push(`Project item '${id}' missing createdAt; defaulted to current timestamp`);
    }
    if (!lastOpenedAt) {
      lastOpenedAt = createdAt;
      warnings.push(`Project item '${id}' missing lastOpenedAt; defaulted to createdAt`);
    }

    let customName: string | undefined = undefined;
    if (typeof rec.customName === 'string') {
      const trimmed = rec.customName.trim();
      if (trimmed.length > 0) {
        customName = trimmed;
      }
    }

    validProjects.push({
      id,
      path: normalizedPath,
      ...(customName ? { customName } : {}),
      createdAt,
      lastOpenedAt,
    });
  }

  let activeProjectId: string | null = null;
  if (typeof raw.activeProjectId === 'string') {
    const matchingProject = validProjects.find((p) => p.id === raw.activeProjectId);
    if (matchingProject) {
      activeProjectId = raw.activeProjectId;
    } else {
      activeProjectId = validProjects.length > 0 ? validProjects[0].id : null;
      warnings.push(
        `Active project ID '${raw.activeProjectId}' not found in registry; defaulted to ${activeProjectId ? `'${activeProjectId}'` : 'null'}`
      );
    }
  } else if (raw.activeProjectId === null) {
    activeProjectId = null;
  } else if (raw.activeProjectId === undefined) {
    activeProjectId = validProjects.length > 0 ? validProjects[0].id : null;
  } else {
    warnings.push('Invalid activeProjectId type; expected string, null, or undefined');
    activeProjectId = validProjects.length > 0 ? validProjects[0].id : null;
  }

  const valid = warnings.length === 0;
  return {
    valid,
    registry: {
      projects: validProjects,
      activeProjectId,
    },
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  };
}

function createInitialRegistry(fallbackCwd?: string): ProjectsRegistry {
  if (!fallbackCwd) {
    return { projects: [], activeProjectId: null };
  }
  const norm = normalizeProjectPath(fallbackCwd);
  if (!norm) {
    return { projects: [], activeProjectId: null };
  }
  const now = new Date().toISOString();
  const initialProject: ProjectItem = {
    id: generateProjectId(),
    path: norm,
    createdAt: now,
    lastOpenedAt: now,
  };
  return {
    projects: [initialProject],
    activeProjectId: initialProject.id,
  };
}

/**
 * Reads from localStorage, catching throws honestly.
 * If storage is empty/missing and fallbackCwd is provided, seeds a default initial project with that fallbackCwd.
 */
export function loadProjectsRegistry(
  storage?: Storage | null,
  fallbackCwd?: string
): ProjectsLoadResult {
  let store: Storage | null = null;
  try {
    store =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined'
          ? window.localStorage
          : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      registry: createInitialRegistry(fallbackCwd),
      warning: `Storage access failed: ${msg}`,
    };
  }

  if (!store) {
    return {
      registry: createInitialRegistry(fallbackCwd),
    };
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(PROJECTS_STORAGE_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      registry: createInitialRegistry(fallbackCwd),
      warning: `Failed to read projects registry from storage: ${msg}`,
    };
  }

  if (raw === null || raw === undefined) {
    return {
      registry: createInitialRegistry(fallbackCwd),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      registry: createInitialRegistry(fallbackCwd),
      warning: `Corrupted projects registry in storage (${msg}); reset to defaults`,
    };
  }

  const validation = validateProjectsRegistry(parsed);
  if (validation.registry.projects.length === 0 && fallbackCwd) {
    return {
      registry: createInitialRegistry(fallbackCwd),
      ...(validation.warning ? { warning: validation.warning } : {}),
    };
  }

  return {
    registry: validation.registry,
    ...(validation.warning ? { warning: validation.warning } : {}),
  };
}

/**
 * Validates and saves to localStorage, catching any errors honestly.
 */
export function saveProjectsRegistry(
  registry: ProjectsRegistry,
  storage?: Storage | null
): ProjectsSaveResult {
  const validation = validateProjectsRegistry(registry);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.warning || 'Invalid projects registry',
    };
  }

  let store: Storage | null = null;
  try {
    store =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined'
          ? window.localStorage
          : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Storage access failed: ${msg}`,
    };
  }

  if (!store) {
    return {
      success: false,
      error: 'Storage unavailable; cannot persist projects registry',
    };
  }

  try {
    store.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(validation.registry));
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to persist projects registry to storage: ${msg}`,
    };
  }
}

/**
 * If project with same path exists, activates it and returns isNew: false.
 * Otherwise, appends new ProjectItem, sets active, and returns isNew: true.
 */
export function addProject(
  registry: ProjectsRegistry,
  path: string,
  customName?: string
): { registry: ProjectsRegistry; project: ProjectItem; isNew: boolean } {
  const normalizedPath = normalizeProjectPath(path);
  const existingIndex = registry.projects.findIndex((p) =>
    isSameProjectPath(p.path, normalizedPath)
  );

  const now = new Date().toISOString();
  const trimmedName = customName?.trim() || undefined;

  if (existingIndex >= 0) {
    const existing = registry.projects[existingIndex];
    const updatedProject: ProjectItem = {
      ...existing,
      lastOpenedAt: now,
      ...(trimmedName ? { customName: trimmedName } : {}),
    };
    const updatedProjects = [...registry.projects];
    updatedProjects[existingIndex] = updatedProject;
    return {
      registry: {
        projects: updatedProjects,
        activeProjectId: updatedProject.id,
      },
      project: updatedProject,
      isNew: false,
    };
  }

  const newProject: ProjectItem = {
    id: generateProjectId(),
    path: normalizedPath,
    ...(trimmedName ? { customName: trimmedName } : {}),
    createdAt: now,
    lastOpenedAt: now,
  };

  return {
    registry: {
      projects: [...registry.projects, newProject],
      activeProjectId: newProject.id,
    },
    project: newProject,
    isNew: true,
  };
}

/**
 * Removes project. If active project was removed, activates the first remaining project or null.
 */
export function removeProject(
  registry: ProjectsRegistry,
  id: string
): { registry: ProjectsRegistry; removedProject?: ProjectItem } {
  const removedProject = registry.projects.find((p) => p.id === id);
  const remainingProjects = registry.projects.filter((p) => p.id !== id);

  let activeProjectId = registry.activeProjectId;
  if (activeProjectId === id) {
    activeProjectId = remainingProjects.length > 0 ? remainingProjects[0].id : null;
  } else if (
    activeProjectId !== null &&
    !remainingProjects.some((p) => p.id === activeProjectId)
  ) {
    activeProjectId = remainingProjects.length > 0 ? remainingProjects[0].id : null;
  }

  return {
    registry: {
      projects: remainingProjects,
      activeProjectId,
    },
    removedProject,
  };
}

/**
 * Updates customName. Trims; if empty, sets customName: undefined.
 */
export function updateProjectName(
  registry: ProjectsRegistry,
  id: string,
  customName: string
): ProjectsRegistry {
  const trimmed = customName.trim();
  const updatedProjects = registry.projects.map((p) => {
    if (p.id === id) {
      if (trimmed.length > 0) {
        return { ...p, customName: trimmed };
      }
      const copy = { ...p };
      delete copy.customName;
      return copy;
    }
    return p;
  });

  return {
    ...registry,
    projects: updatedProjects,
  };
}

/**
 * Sets activeProjectId and updates lastOpenedAt.
 */
export function setActiveProject(
  registry: ProjectsRegistry,
  id: string
): ProjectsRegistry {
  const targetExists = registry.projects.some((p) => p.id === id);
  if (!targetExists) {
    return registry;
  }

  const now = new Date().toISOString();
  const updatedProjects = registry.projects.map((p) =>
    p.id === id ? { ...p, lastOpenedAt: now } : p
  );

  return {
    ...registry,
    projects: updatedProjects,
    activeProjectId: id,
  };
}

export interface ProjectStatusInfo {
  connectionState: import('@core/types/connection').ConnectionState;
  agentActivity: import('@core/types/messages').AgentActivity;
  isBusy?: boolean;
}

export interface SelectProjectDecision {
  action: 'noop' | 'apply';
  registry: ProjectsRegistry;
  path?: string;
}

/**
 * Decides the outcome of selecting a project in the dock: selecting the already-active
 * project is a no-op. Otherwise the project becomes active and its path should be applied.
 */
export function decideSelectProject(
  registry: ProjectsRegistry,
  project: ProjectItem,
  _isBusy?: boolean
): SelectProjectDecision {
  if (project.id === registry.activeProjectId) {
    return { action: 'noop', registry };
  }
  // Concurrent multi-project sessions allow switching even while an agent is busy in background
  const next = setActiveProject(registry, project.id);
  return { action: 'apply', registry: next, path: project.path };
}

export interface RemoveProjectDecision {
  registry: ProjectsRegistry;
  removedProject?: ProjectItem;
  applyPath?: string;
}

/**
 * Decides the registry after removing a project and whether the newly-active project
 * (when the removed one was active and another project remains) should be applied as
 * the new working directory, mirroring App.tsx's former inline `handleRemoveProject`.
 */
export function decideRemoveProject(
  registry: ProjectsRegistry,
  projectId: string
): RemoveProjectDecision {
  const { registry: next, removedProject } = removeProject(registry, projectId);
  const wasActive = removedProject?.id === registry.activeProjectId;

  if (!wasActive || !next.activeProjectId) {
    return { registry: next, removedProject };
  }

  const nextActive = next.projects.find((p) => p.id === next.activeProjectId);
  return {
    registry: next,
    removedProject,
    ...(nextActive ? { applyPath: nextActive.path } : {}),
  };
}
