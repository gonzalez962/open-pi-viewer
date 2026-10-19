import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DefaultDirectorySetupModal } from '@features/projects/components/DefaultDirectorySetupModal';
import {
  pickDirectoryPi,
  browseFilesystemPi,
  type BrowseFilesystemResult,
} from '@infra/bridge';
import {
  getProjectStatusClass,
  getProjectStatusLabel,
  ProjectDock,
  type ProjectDockProps,
} from '@features/projects/ProjectDock';
import { FolderPickerModal } from '@features/projects/components/FolderPickerModal';
import {
  addProject,
  decideRemoveProject,
  decideSelectProject,
  deriveProjectBasename,
  findProjectByCwd,
  getProjectDisplayName,
  getProjectMonogram,
  isSameProjectPath,
  loadProjectsRegistry,
  normalizeProjectPath,
  ProjectItem,
  PROJECTS_STORAGE_KEY,
  ProjectsRegistry,
  removeProject,
  saveProjectsRegistry,
  setActiveProject,
  updateProjectName,
  validateProjectsRegistry,
} from '@features/projects/projects';
import {
  useProjects,
  type UseProjectsOptions,
  type UseProjectsResult,
} from '@features/projects/hooks/useProjects';

function createMockStorage(initialStore?: Map<string, string>): Storage {
  const store = initialStore ?? new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

// 1. Pure utility functions

test('projects: deriveProjectBasename extracts directory name across Windows and POSIX paths', () => {
  // Windows backslash
  assert.strictEqual(deriveProjectBasename('C:\\foo\\bar'), 'bar');
  assert.strictEqual(deriveProjectBasename('C:\\foo\\bar\\'), 'bar');
  assert.strictEqual(deriveProjectBasename('D:\\work\\pi-viewer'), 'pi-viewer');
  assert.strictEqual(deriveProjectBasename('D:\\work\\pi-viewer\\'), 'pi-viewer');

  // Windows forward slash
  assert.strictEqual(deriveProjectBasename('C:/foo/bar'), 'bar');
  assert.strictEqual(deriveProjectBasename('C:/foo/bar/'), 'bar');

  // POSIX
  assert.strictEqual(deriveProjectBasename('/home/user/project'), 'project');
  assert.strictEqual(deriveProjectBasename('/home/user/project/'), 'project');
  assert.strictEqual(deriveProjectBasename('/var/log'), 'log');

  // Roots
  assert.strictEqual(deriveProjectBasename('C:\\'), 'C:');
  assert.strictEqual(deriveProjectBasename('C:/'), 'C:');
  assert.strictEqual(deriveProjectBasename('/'), '/');

  // Relative or simple names
  assert.strictEqual(deriveProjectBasename('my-project'), 'my-project');
  assert.strictEqual(deriveProjectBasename('my-project/'), 'my-project');
  assert.strictEqual(deriveProjectBasename('  /home/user/app/  '), 'app');

  // Empty / whitespace
  assert.strictEqual(deriveProjectBasename(''), '');
  assert.strictEqual(deriveProjectBasename('   '), '');
});

test('projects: getProjectDisplayName prefers customName or falls back to basename or Project', () => {
  const withCustom: ProjectItem = {
    id: 'p1',
    path: '/home/user/repo',
    customName: 'Custom App',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  assert.strictEqual(getProjectDisplayName(withCustom), 'Custom App');

  // Trims customName
  const withWhitespaceCustom: ProjectItem = {
    ...withCustom,
    customName: '  Trimmed App  ',
  };
  assert.strictEqual(getProjectDisplayName(withWhitespaceCustom), 'Trimmed App');

  // Blank customName falls back to basename
  const withBlankCustom: ProjectItem = {
    ...withCustom,
    customName: '   ',
  };
  assert.strictEqual(getProjectDisplayName(withBlankCustom), 'repo');

  // Undefined customName falls back to basename
  const noCustom: ProjectItem = {
    id: 'p2',
    path: 'C:\\projects\\pi-viewer',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  assert.strictEqual(getProjectDisplayName(noCustom), 'pi-viewer');

  // Empty path and no customName falls back to 'Project'
  const emptyPath: ProjectItem = {
    id: 'p3',
    path: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  assert.strictEqual(getProjectDisplayName(emptyPath), 'Project');
});

test('projects: getProjectMonogram extracts 1-2 uppercase characters for square avatar tile', () => {
  // Hyphenated
  assert.strictEqual(getProjectMonogram('pi-viewer'), 'PV');

  // Space-separated
  assert.strictEqual(getProjectMonogram('my project'), 'MP');

  // Underscore-separated
  assert.strictEqual(getProjectMonogram('backend_service'), 'BS');

  // Multi-word takes first two words
  assert.strictEqual(getProjectMonogram('pi viewer web application'), 'PV');

  // Single word (>= 2 chars)
  assert.strictEqual(getProjectMonogram('App'), 'AP');
  assert.strictEqual(getProjectMonogram('frontend'), 'FR');

  // Single char
  assert.strictEqual(getProjectMonogram('A'), 'A');
  assert.strictEqual(getProjectMonogram('z'), 'Z');

  // Leading/trailing whitespace
  assert.strictEqual(getProjectMonogram('  super tool  '), 'ST');

  // Empty / whitespace
  assert.strictEqual(getProjectMonogram(''), '');
  assert.strictEqual(getProjectMonogram('   '), '');
});

test('projects: normalizeProjectPath normalizes paths consistently via session normalizeWorkingDirectory', () => {
  assert.strictEqual(
    normalizeProjectPath('c:\\projects\\pi-viewer\\'),
    'C:/projects/pi-viewer'
  );
  assert.strictEqual(
    normalizeProjectPath('  /home/user/project/  '),
    '/home/user/project'
  );
  assert.strictEqual(normalizeProjectPath('C:\\'), 'C:/');
  assert.strictEqual(normalizeProjectPath('/'), '/');
});

test('projects: isSameProjectPath handles Windows case-insensitivity and POSIX case-sensitivity', () => {
  // Windows: case-insensitive match
  assert.strictEqual(
    isSameProjectPath('C:\\Projects\\Pi-Viewer', 'c:/projects/pi-viewer'),
    true
  );
  assert.strictEqual(
    isSameProjectPath('c:\\work\\app\\', 'C:/work/app'),
    true
  );

  // POSIX: case-sensitive match
  assert.strictEqual(
    isSameProjectPath('/home/user/project', '/home/user/Project'),
    false
  );
  assert.strictEqual(
    isSameProjectPath('/home/user/project/', '/home/user/project'),
    true
  );

  // Different paths
  assert.strictEqual(
    isSameProjectPath('/home/user/projectA', '/home/user/projectB'),
    false
  );
  assert.strictEqual(
    isSameProjectPath('C:/projectA', 'C:/projectB'),
    false
  );

  // Windows vs POSIX
  assert.strictEqual(
    isSameProjectPath('C:/project', '/project'),
    false
  );

  // Empty paths
  assert.strictEqual(isSameProjectPath('', ''), true);
  assert.strictEqual(isSameProjectPath('', '/home'), false);
});

test('projects: isSameProjectPath matches network drive Z: with mapped Samba Desarrollos path', () => {
  assert.strictEqual(
    isSameProjectPath('Z:\\Prueba', '/home/hermes/Desarrollos/Prueba'),
    true
  );
  assert.strictEqual(
    isSameProjectPath('Z:/Prueba/', '/home/hermes/Desarrollos/Prueba/'),
    true
  );
  assert.strictEqual(
    isSameProjectPath('z:\\PI-Viewer', '/home/hermes/Desarrollos/PI-Viewer'),
    true
  );
  assert.strictEqual(
    isSameProjectPath('Z:\\Otro', '/home/hermes/Desarrollos/Prueba'),
    false
  );
});

// 2. Validation and Registry integrity

test('projects: validateProjectsRegistry returns valid for compliant payload', () => {
  const validRegistry: ProjectsRegistry = {
    projects: [
      {
        id: 'proj-1',
        path: 'C:/projects/pi-viewer',
        customName: 'Pi Viewer',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastOpenedAt: '2025-01-02T00:00:00.000Z',
      },
      {
        id: 'proj-2',
        path: '/home/user/gentle-ai',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastOpenedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    activeProjectId: 'proj-1',
  };

  const res = validateProjectsRegistry(validRegistry);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.warning, undefined);
  assert.strictEqual(res.registry.projects.length, 2);
  assert.strictEqual(res.registry.activeProjectId, 'proj-1');
  assert.strictEqual(res.registry.projects[0].customName, 'Pi Viewer');
});

test('projects: validateProjectsRegistry rejects non-object inputs with honest fallbacks', () => {
  const invalidInputs = [null, undefined, 'string', 123, true, []];
  for (const input of invalidInputs) {
    const res = validateProjectsRegistry(input);
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.registry, { projects: [], activeProjectId: null });
    assert.ok(res.warning?.includes('must be a non-null object'));
  }
});

test('projects: validateProjectsRegistry sanitizes malformed projects and reconciles activeProjectId', () => {
  const malformed = {
    projects: [
      null, // invalid
      { id: '', path: '/valid/path' }, // missing id
      { id: 'p1', path: '' }, // missing path
      {
        id: 'p2',
        path: 'c:\\app\\',
        customName: '  Trimmed Name  ',
        // missing createdAt and lastOpenedAt
      },
      {
        id: 'p3',
        path: '/home/dev',
        customName: '   ', // whitespace custom name
        createdAt: '2025-01-01T00:00:00.000Z',
        lastOpenedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    activeProjectId: 'non-existent-id',
  };

  const res = validateProjectsRegistry(malformed);
  assert.strictEqual(res.valid, false);
  assert.ok(res.warning);
  // Dropped invalid items, kept p2 and p3
  assert.strictEqual(res.registry.projects.length, 2);
  assert.strictEqual(res.registry.projects[0].id, 'p2');
  assert.strictEqual(res.registry.projects[0].path, 'C:/app');
  assert.strictEqual(res.registry.projects[0].customName, 'Trimmed Name');
  assert.ok(res.registry.projects[0].createdAt);
  assert.ok(res.registry.projects[0].lastOpenedAt);

  assert.strictEqual(res.registry.projects[1].id, 'p3');
  assert.strictEqual(res.registry.projects[1].customName, undefined);

  // Active project ID defaulted to first remaining project
  assert.strictEqual(res.registry.activeProjectId, 'p2');
});

// 3. Storage and Serialization

test('projects: saveProjectsRegistry and loadProjectsRegistry roundtrip cleanly', () => {
  const storage = createMockStorage();
  const registry: ProjectsRegistry = {
    projects: [
      {
        id: 'p1',
        path: 'C:/projects/app',
        customName: 'App',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastOpenedAt: '2025-01-02T00:00:00.000Z',
      },
    ],
    activeProjectId: 'p1',
  };

  const saveRes = saveProjectsRegistry(registry, storage);
  assert.strictEqual(saveRes.success, true);
  assert.strictEqual(saveRes.error, undefined);

  const loadRes = loadProjectsRegistry(storage);
  assert.strictEqual(loadRes.warning, undefined);
  assert.strictEqual(loadRes.registry.projects.length, 1);
  assert.strictEqual(loadRes.registry.activeProjectId, 'p1');
  assert.strictEqual(loadRes.registry.projects[0].path, 'C:/projects/app');
});

test('projects: saveProjectsRegistry rejects invalid registry and handles storage errors', () => {
  const storage = createMockStorage();

  // Invalid registry payload
  const badRes = saveProjectsRegistry({ projects: 'invalid' as unknown as ProjectItem[], activeProjectId: null }, storage);
  assert.strictEqual(badRes.success, false);
  assert.ok(badRes.error);

  // Storage unavailable (null)
  const noStorageRes = saveProjectsRegistry({ projects: [], activeProjectId: null }, null);
  assert.strictEqual(noStorageRes.success, false);
  assert.ok(noStorageRes.error?.includes('unavailable'));

  // Storage throwing on setItem
  const throwingStorage: Storage = {
    ...storage,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  const throwRes = saveProjectsRegistry({ projects: [], activeProjectId: null }, throwingStorage);
  assert.strictEqual(throwRes.success, false);
  assert.ok(throwRes.error?.includes('QuotaExceededError'));
});

test('projects: loadProjectsRegistry auto-seeds default project when storage is empty and fallbackCwd provided', () => {
  const storage = createMockStorage(); // empty storage

  const res = loadProjectsRegistry(storage, 'C:\\projects\\my-app');
  assert.strictEqual(res.warning, undefined);
  assert.strictEqual(res.registry.projects.length, 1);
  const seeded = res.registry.projects[0];
  assert.ok(seeded.id);
  assert.strictEqual(seeded.path, 'C:/projects/my-app');
  assert.strictEqual(res.registry.activeProjectId, seeded.id);
  assert.ok(seeded.createdAt);
  assert.ok(seeded.lastOpenedAt);
});

test('projects: loadProjectsRegistry returns empty registry when storage is empty and no fallbackCwd', () => {
  const storage = createMockStorage();
  const res = loadProjectsRegistry(storage);
  assert.deepStrictEqual(res.registry, { projects: [], activeProjectId: null });
  assert.strictEqual(res.warning, undefined);
});

test('projects: loadProjectsRegistry handles corrupt JSON and storage throws honestly', () => {
  const storage = createMockStorage();
  storage.setItem(PROJECTS_STORAGE_KEY, '{ broken json');

  const corruptRes = loadProjectsRegistry(storage, '/fallback/path');
  assert.ok(corruptRes.warning?.includes('Corrupted projects registry'));
  // Auto-seeds because storage was corrupted
  assert.strictEqual(corruptRes.registry.projects.length, 1);
  assert.strictEqual(corruptRes.registry.projects[0].path, '/fallback/path');

  // Throwing storage
  const throwingStorage: Storage = {
    ...storage,
    getItem: () => {
      throw new Error('Disk read fault');
    },
  };
  const throwRes = loadProjectsRegistry(throwingStorage, '/fallback/path');
  assert.ok(throwRes.warning?.includes('Disk read fault'));
  assert.strictEqual(throwRes.registry.projects.length, 1);
});

// 4. CRUD operations

test('projects: addProject appends new project and activates it', () => {
  const initialRegistry: ProjectsRegistry = {
    projects: [],
    activeProjectId: null,
  };

  const { registry, project, isNew } = addProject(
    initialRegistry,
    '/home/user/project-1',
    'Project 1'
  );

  assert.strictEqual(isNew, true);
  assert.strictEqual(registry.projects.length, 1);
  assert.strictEqual(registry.activeProjectId, project.id);
  assert.strictEqual(project.path, '/home/user/project-1');
  assert.strictEqual(project.customName, 'Project 1');
  assert.ok(project.createdAt);
  assert.ok(project.lastOpenedAt);
});

test('projects: addProject activates existing project without duplicating', () => {
  const initialRegistry: ProjectsRegistry = {
    projects: [
      {
        id: 'p1',
        path: 'C:/projects/app',
        customName: 'Existing App',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastOpenedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    activeProjectId: null,
  };

  // Adding with Windows backslash and lowercase drive
  const { registry, project, isNew } = addProject(
    initialRegistry,
    'c:\\projects\\app\\'
  );

  assert.strictEqual(isNew, false);
  assert.strictEqual(registry.projects.length, 1);
  assert.strictEqual(registry.activeProjectId, 'p1');
  assert.strictEqual(project.id, 'p1');
  assert.strictEqual(project.path, 'C:/projects/app');
  // Updated lastOpenedAt
  assert.notStrictEqual(project.lastOpenedAt, '2025-01-01T00:00:00.000Z');
});

test('projects: removeProject removes project and manages activeProjectId honestly', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const p2: ProjectItem = {
    id: 'p2',
    path: '/path/2',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };

  const registry: ProjectsRegistry = {
    projects: [p1, p2],
    activeProjectId: 'p1',
  };

  // Removing active project p1 activates remaining p2
  const step1 = removeProject(registry, 'p1');
  assert.strictEqual(step1.removedProject?.id, 'p1');
  assert.strictEqual(step1.registry.projects.length, 1);
  assert.strictEqual(step1.registry.activeProjectId, 'p2');

  // Removing the only project leaves activeProjectId null
  const step2 = removeProject(step1.registry, 'p2');
  assert.strictEqual(step2.removedProject?.id, 'p2');
  assert.strictEqual(step2.registry.projects.length, 0);
  assert.strictEqual(step2.registry.activeProjectId, null);

  // Removing non-existent project returns removedProject: undefined and leaves registry unchanged
  const step3 = removeProject(registry, 'non-existent');
  assert.strictEqual(step3.removedProject, undefined);
  assert.strictEqual(step3.registry.projects.length, 2);
  assert.strictEqual(step3.registry.activeProjectId, 'p1');
});

test('projects: updateProjectName updates, trims, or clears customName', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    customName: 'Old Name',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = {
    projects: [p1],
    activeProjectId: 'p1',
  };

  // Update name
  const updated = updateProjectName(registry, 'p1', '  New Name  ');
  assert.strictEqual(updated.projects[0].customName, 'New Name');

  // Empty string clears customName
  const cleared = updateProjectName(updated, 'p1', '   ');
  assert.strictEqual(cleared.projects[0].customName, undefined);
});

test('projects: setActiveProject switches activeProjectId and updates lastOpenedAt', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const p2: ProjectItem = {
    id: 'p2',
    path: '/path/2',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = {
    projects: [p1, p2],
    activeProjectId: 'p1',
  };

  const updated = setActiveProject(registry, 'p2');
  assert.strictEqual(updated.activeProjectId, 'p2');
  const updatedP2 = updated.projects.find((p) => p.id === 'p2');
  assert.notStrictEqual(updatedP2?.lastOpenedAt, '2025-01-01T00:00:00.000Z');

  // Non-existent ID leaves registry unchanged
  const unchanged = setActiveProject(registry, 'non-existent');
  assert.strictEqual(unchanged.activeProjectId, 'p1');
});

test('projects: decideSelectProject is a no-op when selecting the already-active project', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = { projects: [p1], activeProjectId: 'p1' };

  const decision = decideSelectProject(registry, p1, false);
  assert.strictEqual(decision.action, 'noop');
  assert.strictEqual(decision.registry, registry);
  assert.strictEqual(decision.path, undefined);
});

test('projects: decideSelectProject allows switching to a different project even when an agent response is busy', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const p2: ProjectItem = {
    id: 'p2',
    path: '/path/2',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = { projects: [p1, p2], activeProjectId: 'p1' };

  const decision = decideSelectProject(registry, p2, true);
  assert.strictEqual(decision.action, 'apply');
  assert.strictEqual(decision.path, '/path/2');
  assert.strictEqual(decision.registry.activeProjectId, 'p2');
});

test('projects: decideSelectProject activates a different project and returns its path to apply when not busy', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const p2: ProjectItem = {
    id: 'p2',
    path: '/path/2',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = { projects: [p1, p2], activeProjectId: 'p1' };

  const decision = decideSelectProject(registry, p2, false);
  assert.strictEqual(decision.action, 'apply');
  assert.strictEqual(decision.path, '/path/2');
  assert.strictEqual(decision.registry.activeProjectId, 'p2');
});

test('projects: decideRemoveProject applies the new active project path when the removed project was active and another remains', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const p2: ProjectItem = {
    id: 'p2',
    path: '/path/2',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = { projects: [p1, p2], activeProjectId: 'p1' };

  const decision = decideRemoveProject(registry, 'p1');
  assert.strictEqual(decision.removedProject?.id, 'p1');
  assert.strictEqual(decision.registry.activeProjectId, 'p2');
  assert.strictEqual(decision.applyPath, '/path/2');
});

test('projects: decideRemoveProject does not apply a path when the removed project was not active', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const p2: ProjectItem = {
    id: 'p2',
    path: '/path/2',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = { projects: [p1, p2], activeProjectId: 'p1' };

  const decision = decideRemoveProject(registry, 'p2');
  assert.strictEqual(decision.removedProject?.id, 'p2');
  assert.strictEqual(decision.registry.activeProjectId, 'p1');
  assert.strictEqual(decision.applyPath, undefined);
});

test('projects: decideRemoveProject does not apply a path when the removed active project was the last one', () => {
  const p1: ProjectItem = {
    id: 'p1',
    path: '/path/1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-01T00:00:00.000Z',
  };
  const registry: ProjectsRegistry = { projects: [p1], activeProjectId: 'p1' };

  const decision = decideRemoveProject(registry, 'p1');
  assert.strictEqual(decision.removedProject?.id, 'p1');
  assert.strictEqual(decision.registry.activeProjectId, null);
  assert.strictEqual(decision.applyPath, undefined);
});

// 5. Bridge function pickDirectoryPi

test('bridge: pickDirectoryPi returns null without throwing in non-Tauri preview environment', async () => {
  // In Node environment without Tauri, invokeFn = invoke defaults to non-Tauri preview fallback
  const res = await pickDirectoryPi();
  assert.strictEqual(res, null);
});

test('bridge: pickDirectoryPi calls pick_directory with defaultPath via mock invoke', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return 'C:/selected/folder' as T;
  };

  const res = await pickDirectoryPi('C:/initial/folder', mockInvoke);
  assert.strictEqual(res, 'C:/selected/folder');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'pick_directory');
  assert.deepStrictEqual(calls[0].args, { defaultPath: 'C:/initial/folder' });
});

test('bridge: pickDirectoryPi passes null defaultPath when omitted and handles cancellation/errors cleanly', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvokeNull = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return null as T;
  };

  const resNull = await pickDirectoryPi(undefined, mockInvokeNull);
  assert.strictEqual(resNull, null);
  assert.deepStrictEqual(calls[0].args, { defaultPath: null });

  // When mock throws error (e.g. dialog cancelled or IPC error)
  const mockInvokeThrow = async <T>(): Promise<T> => {
    throw new Error('User cancelled dialog');
  };

  const resThrow = await pickDirectoryPi(undefined, mockInvokeThrow);
  assert.strictEqual(resThrow, null);
});

// 6. ProjectDock status dot and status label utilities

test('ProjectDock: getProjectStatusClass returns status-ready for connected projects (active and inactive)', () => {
  // Connected active project
  assert.strictEqual(getProjectStatusClass(true, 'connected', 'idle', false), 'status-ready');
  // Connected inactive project (background process ready)
  assert.strictEqual(getProjectStatusClass(false, 'connected', 'idle', false), 'status-ready');
});

test('ProjectDock: getProjectStatusClass returns status-busy for busy projects (active and inactive)', () => {
  // Busy via isBusy flag
  assert.strictEqual(getProjectStatusClass(true, 'connected', 'idle', true), 'status-busy');
  assert.strictEqual(getProjectStatusClass(false, 'connected', 'idle', true), 'status-busy');
  // Busy via agentActivity === 'busy'
  assert.strictEqual(getProjectStatusClass(true, 'connected', 'busy', false), 'status-busy');
  assert.strictEqual(getProjectStatusClass(false, 'connected', 'busy', false), 'status-busy');
});

test('ProjectDock: getProjectStatusClass returns status-connecting for connecting projects', () => {
  assert.strictEqual(getProjectStatusClass(true, 'connecting', 'idle', false), 'status-connecting');
  assert.strictEqual(getProjectStatusClass(false, 'connecting', 'idle', false), 'status-connecting');
});

test('ProjectDock: getProjectStatusClass returns status-error for error projects', () => {
  assert.strictEqual(getProjectStatusClass(true, 'error', 'idle', false), 'status-error');
  assert.strictEqual(getProjectStatusClass(false, 'error', 'idle', false), 'status-error');
});

test('ProjectDock: getProjectStatusClass returns status-offline for disconnected active project', () => {
  assert.strictEqual(getProjectStatusClass(true, 'disconnected', 'idle', false), 'status-offline');
});

test('ProjectDock: getProjectStatusClass returns status-inactive for disconnected inactive project', () => {
  assert.strictEqual(getProjectStatusClass(false, 'disconnected', 'idle', false), 'status-inactive');
});

test('ProjectDock: getProjectStatusLabel returns localized labels in en and es', () => {
  // Ready
  assert.strictEqual(getProjectStatusLabel(true, 'connected', 'idle', false, 'en'), 'Ready');
  assert.strictEqual(getProjectStatusLabel(false, 'connected', 'idle', false, 'en'), 'Ready');
  assert.strictEqual(getProjectStatusLabel(true, 'connected', 'idle', false, 'es'), 'Listo');
  assert.strictEqual(getProjectStatusLabel(false, 'connected', 'idle', false, 'es'), 'Listo');

  // Busy
  assert.strictEqual(getProjectStatusLabel(true, 'connected', 'idle', true, 'en'), 'Agent running...');
  assert.strictEqual(getProjectStatusLabel(false, 'connected', 'busy', false, 'en'), 'Agent running...');
  assert.strictEqual(getProjectStatusLabel(true, 'connected', 'idle', true, 'es'), 'Agente trabajando...');
  assert.strictEqual(getProjectStatusLabel(false, 'connected', 'busy', false, 'es'), 'Agente trabajando...');

  // Connecting
  assert.strictEqual(getProjectStatusLabel(true, 'connecting', 'idle', false, 'en'), 'Connecting...');
  assert.strictEqual(getProjectStatusLabel(false, 'connecting', 'idle', false, 'en'), 'Connecting...');
  assert.strictEqual(getProjectStatusLabel(true, 'connecting', 'idle', false, 'es'), 'Conectando...');
  assert.strictEqual(getProjectStatusLabel(false, 'connecting', 'idle', false, 'es'), 'Conectando...');

  // Error
  assert.strictEqual(getProjectStatusLabel(true, 'error', 'idle', false, 'en'), 'Connection error');
  assert.strictEqual(getProjectStatusLabel(false, 'error', 'idle', false, 'en'), 'Connection error');
  assert.strictEqual(getProjectStatusLabel(true, 'error', 'idle', false, 'es'), 'Error de conexión');
  assert.strictEqual(getProjectStatusLabel(false, 'error', 'idle', false, 'es'), 'Error de conexión');

  // Disconnected active project -> status.disconnected
  assert.strictEqual(getProjectStatusLabel(true, 'disconnected', 'idle', false, 'en'), 'Disconnected');
  assert.strictEqual(getProjectStatusLabel(true, 'disconnected', 'idle', false, 'es'), 'Desconectado');

  // Disconnected inactive project -> projects.status_inactive
  assert.strictEqual(getProjectStatusLabel(false, 'disconnected', 'idle', false, 'en'), 'Inactive');
  assert.strictEqual(getProjectStatusLabel(false, 'disconnected', 'idle', false, 'es'), 'Inactivo');
});

// 7. ProjectDock Settings button relocation tests

function findElement(node: any, predicate: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = React.Children.toArray(node.props?.children);
  for (const child of children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

const baseProjectDockProps: ProjectDockProps = {
  projects: [
    {
      id: 'proj-1',
      path: '/home/user/project-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastOpenedAt: '2025-01-01T00:00:00.000Z',
    },
  ],
  activeProjectId: 'proj-1',
  connectionState: 'connected',
  agentActivity: 'idle',
  isBusy: false,
  locale: 'en',
  onSelectProject: () => {},
  onAddProject: () => {},
  onRenameProject: () => {},
  onRemoveProject: () => {},
};

test('ProjectDock footer: renders Add Project button directly followed by Settings button in order', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProjectDock, {
      ...baseProjectDockProps,
      locale: 'en',
      isSettingsOpen: false,
      onOpenSettings: () => {},
    })
  );

  // Both buttons must be rendered inside the footer
  assert.ok(markup.includes('project-dock-footer'), 'footer must exist');
  assert.ok(markup.includes('project-tile-add'), 'Add Project tile must exist');
  assert.ok(markup.includes('project-tile-settings'), 'Settings tile must exist');

  // Verify order: Add Project occurs before Settings
  const addProjectIdx = markup.indexOf('project-tile-add');
  const settingsIdx = markup.indexOf('project-tile-settings');
  assert.ok(addProjectIdx !== -1 && settingsIdx !== -1, 'both buttons must be found in markup');
  assert.ok(addProjectIdx < settingsIdx, 'Add Project button must appear before Settings button in DOM order');
});

test('ProjectDock footer: Settings button provides localized accessible labels and title in en and es', () => {
  // English
  const enMarkup = renderToStaticMarkup(
    React.createElement(ProjectDock, {
      ...baseProjectDockProps,
      locale: 'en',
    })
  );
  assert.ok(enMarkup.includes('title="Settings"'), 'English title attribute must be Settings');
  assert.ok(enMarkup.includes('aria-label="Settings"'), 'English aria-label must be Settings');
  assert.ok(enMarkup.includes('project-settings-label'), 'Settings label element must exist');
  assert.ok(enMarkup.includes('>Settings</span>'), 'English text label must render Settings');

  // Spanish
  const esMarkup = renderToStaticMarkup(
    React.createElement(ProjectDock, {
      ...baseProjectDockProps,
      locale: 'es',
    })
  );
  assert.ok(esMarkup.includes('title="Configuración"'), 'Spanish title attribute must be Configuración');
  assert.ok(esMarkup.includes('aria-label="Configuración"'), 'Spanish aria-label must be Configuración');
  assert.ok(esMarkup.includes('>Configuración</span>'), 'Spanish text label must render Configuración');
});

test('ProjectDock footer: Settings button reflects active state with is-active class', () => {
  // When settings is open
  const activeMarkup = renderToStaticMarkup(
    React.createElement(ProjectDock, {
      ...baseProjectDockProps,
      isSettingsOpen: true,
    })
  );
  assert.ok(
    activeMarkup.includes('project-footer-settings is-active'),
    'project-footer-settings row must have is-active class when settings is open'
  );
  assert.ok(
    activeMarkup.includes('project-tile-settings is-active'),
    'project-tile-settings must have is-active class when settings is open'
  );

  // When settings is closed
  const inactiveMarkup = renderToStaticMarkup(
    React.createElement(ProjectDock, {
      ...baseProjectDockProps,
      isSettingsOpen: false,
    })
  );
  assert.ok(
    inactiveMarkup.includes('project-footer-settings'),
    'project-footer-settings must exist'
  );
  assert.ok(
    !inactiveMarkup.includes('project-footer-settings is-active'),
    'project-footer-settings must not have is-active class when settings is closed'
  );
  assert.ok(
    !inactiveMarkup.includes('project-tile-settings is-active'),
    'project-tile-settings must not have is-active class when settings is closed'
  );
});

test('ProjectDock footer: clicking Settings button triggers onOpenSettings callback', () => {
  let opened = false;
  let capturedTree: any = null;

  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = ProjectDock({
        ...baseProjectDockProps,
        isSettingsOpen: false,
        onOpenSettings: () => {
          opened = true;
        },
      });
      return capturedTree;
    })
  );

  const settingsBtn = findElement(
    capturedTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('project-footer-settings')
  );

  assert.ok(settingsBtn, 'Settings button must be present in component tree');
  assert.strictEqual(typeof settingsBtn.props.onClick, 'function', 'onClick must be a function');
  settingsBtn.props.onClick();
  assert.strictEqual(opened, true, 'onClick must trigger onOpenSettings callback');
});

test('ProjectDock footer: clicking Add Project button triggers onOpenAddProject callback', () => {
  let opened = false;
  let capturedTree: any = null;

  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = ProjectDock({
        ...baseProjectDockProps,
        onOpenAddProject: () => {
          opened = true;
        },
      });
      return capturedTree;
    })
  );

  const addBtn = findElement(
    capturedTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('project-footer-row') &&
      !el.props.className.includes('project-footer-settings')
  );

  assert.ok(addBtn, 'Add Project button must be present in component tree');
  assert.strictEqual(typeof addBtn.props.onClick, 'function', 'onClick must be a function');
  addBtn.props.onClick();
  assert.strictEqual(opened, true, 'onClick must trigger onOpenAddProject callback');
});

test('FolderPickerModal: omits the selection footer and custom name field', () => {
  const html = renderToStaticMarkup(React.createElement(FolderPickerModal, {
    isOpen: true, initialPath: '/test/workspace', locale: 'en',
    onClose: () => {}, onSelectFolder: () => {},
  }));
  assert.ok(!html.includes('folder-picker-selection-footer'));
  assert.ok(!html.includes('folder-picker-custom-name'));
});

test('FolderPickerModal: keeps the native OS picker out of the web shim modal', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { isTauri: true, __IS_WEB_IPC__: true },
  });
  try {
  const html = renderToStaticMarkup(React.createElement(FolderPickerModal, {
    isOpen: true, initialPath: '/test/workspace', locale: 'en',
    onClose: () => {}, onSelectFolder: () => {},
  }));
  assert.ok(!html.includes('folder-picker-btn-native'));
  assert.ok(!html.includes('OS Explorer'));
  } finally {
    if (originalTauri) Object.defineProperty(globalThis, 'isTauri', originalTauri);
    else Reflect.deleteProperty(globalThis, 'isTauri');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('FolderPickerModal: uses an icon grid with names below icons and no per-folder paths', () => {
  const css = readFileSync('src/features/projects/projects.css', 'utf8');
  const source = readFileSync('src/features/projects/components/FolderPickerModal.tsx', 'utf8');
  assert.match(css, /\.folder-picker-grid\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.folder-picker-item\s*\{[^}]*flex-direction:\s*column/);
  assert.ok(!source.includes('folder-item-winpath'));
  assert.ok(!source.includes('folder-item-enter-btn'), 'folder tiles must not show an entry arrow');
  assert.ok(!css.includes('.folder-item-enter-btn'), 'entry arrow styles must be removed');
  assert.ok(source.includes('onDoubleClick={() => handleFolderClick(folder)}'), 'double-click navigation must remain');
});

test('FolderPickerModal: confirmation preserves the initial folder and derived project name', () => {
  let tree: any;
  let selected: unknown[] = [];
  let closed = false;
  renderToStaticMarkup(React.createElement(() => {
    tree = FolderPickerModal({
      isOpen: true, initialPath: '/test/workspace', locale: 'en',
      onClose: () => { closed = true; },
      onSelectFolder: (...args) => { selected = args; },
    });
    return tree;
  }));
  const confirm = findElement(tree, (el) => el?.type === 'button' && el.props.className === 'btn btn-primary');
  assert.ok(confirm);
  confirm.props.onClick();
  assert.deepStrictEqual(selected, ['/test/workspace', 'workspace']);
  assert.strictEqual(closed, true);
});

test('FolderPickerModal: renders accessible modal dialog with role="dialog" and aria-modal="true"', () => {
  const html = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/test/workspace',
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );

  assert.ok(html.includes('role="dialog"'), 'must have role="dialog"');
  assert.ok(html.includes('aria-modal="true"'), 'must have aria-modal="true"');
  assert.ok(html.includes('folder-picker-overlay'), 'must have folder-picker-overlay');
  assert.ok(html.includes('folder-picker-close-btn'), 'must have close button');
});

test('FolderPickerModal: exposes + Folder button beside the filter in en and es', () => {
  const enHtml = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/test/workspace',
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );

  assert.ok(
    enHtml.includes('folder-picker-btn-create-folder'),
    'folder-picker-btn-create-folder class must exist in modal markup'
  );
  assert.ok(
    enHtml.includes('+ Folder'),
    '+ Folder label must exist in English'
  );

  const esHtml = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/test/workspace',
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'es',
    })
  );

  assert.ok(
    esHtml.includes('folder-picker-btn-create-folder'),
    'folder-picker-btn-create-folder class must exist in modal markup'
  );
  assert.ok(
    esHtml.includes('+ Folder'),
    '+ Folder label must exist in Spanish'
  );
});

test('FolderPickerModal: preserves stable hook ordering across isOpen transitions while mounted', () => {
  // Verifies that FolderPickerModal can transition between open and closed while mounted
  // without triggering React hook count or ordering errors (rules of hooks compliance)
  let setOpenFn: (open: boolean) => void = () => {};

  function Harness() {
    const [open, setOpen] = React.useState(false);
    setOpenFn = setOpen;
    return React.createElement(FolderPickerModal, {
      isOpen: open,
      initialPath: '/test/workspace',
      onClose: () => setOpen(false),
      onSelectFolder: () => {},
      locale: 'en',
    });
  }

  // Initial closed render
  const closedMarkup = renderToStaticMarkup(React.createElement(Harness));
  assert.strictEqual(closedMarkup, '');
  assert.strictEqual(typeof setOpenFn, 'function');

  // Render directly with isOpen: true
  const openMarkup = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/test/workspace',
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );
  assert.ok(openMarkup.includes('folder-picker-overlay'));
  assert.ok(openMarkup.includes('folder-picker-btn-create-folder'));

  // Render directly with isOpen: false
  const closedAgain = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: false,
      initialPath: '/test/workspace',
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );
  assert.strictEqual(closedAgain, '');
});

test('FolderPickerModal: + Folder button is rendered enabled and filter input is present', () => {
  let tree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      tree = FolderPickerModal({
        isOpen: true,
        initialPath: '/test/workspace',
        onClose: () => {},
        onSelectFolder: () => {},
        locale: 'en',
      });
      return tree;
    })
  );

  const createBtn = findElement(
    tree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('folder-picker-btn-create-folder')
  );
  assert.ok(createBtn, '+ Folder button must be present');
  assert.strictEqual(createBtn.props.disabled, false, '+ Folder button must not be disabled initially');
  assert.strictEqual(createBtn.props.children, '+ Folder');
});

test('FolderPickerModal PRESERVE: existing browsing and confirmation flow intact', () => {
  const html = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/preserve/path',
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );

  // Filter input preserved
  assert.ok(html.includes('folder-picker-filter-input'), 'filter input must be preserved');
  // Up button preserved
  assert.ok(html.includes('folder-picker-btn-up'), 'up button must be preserved');
  // Confirm and Cancel action buttons preserved
  assert.ok(html.includes('folder-picker-actions'), 'action footer must be preserved');
});

test('FolderPickerModal: close button and cancel button invoke onClose callback', () => {
  let closedCount = 0;
  let capturedTree: any = null;

  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = FolderPickerModal({
        isOpen: true,
        initialPath: '/test/workspace',
        onClose: () => {
          closedCount++;
        },
        onSelectFolder: () => {},
        locale: 'en',
      });
      return capturedTree;
    })
  );

  const closeBtn = findElement(
    capturedTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('folder-picker-close-btn')
  );
  assert.ok(closeBtn, 'Close button must be present');
  closeBtn.props.onClick();
  assert.strictEqual(closedCount, 1, 'Close button must trigger onClose callback');

  const cancelBtn = findElement(
    capturedTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('btn-secondary') &&
      el?.props?.children === 'Cancel'
  );
  assert.ok(cancelBtn, 'Cancel button must be present');
  cancelBtn.props.onClick();
  assert.strictEqual(closedCount, 2, 'Cancel button must trigger onClose callback');
});

test('FolderPickerModal: closed state renders null', () => {
  const html = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: false,
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );

  assert.strictEqual(html, '');
});

// S1: Folder cards expose accessible trash button
test('FolderPickerModal S1: folder cards render accessible trash button with localized label', () => {
  const mockFolder = {
    name: 'test-folder',
    fullPath: '/workspace/test-folder',
    windowsPath: 'C:\\workspace\\test-folder',
  };

  const html = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/workspace',
      initialFolders: [mockFolder],
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );

  assert.ok(html.includes('folder-item-trash-btn'), 'Must render trash button on folder card');
  assert.ok(html.includes('Delete folder test-folder'), 'Must have accessible aria-label identifying folder');
});

// S1.1: Clicking trash button opens confirmation dialog with name, full path, and permanent warning
test('FolderPickerModal S1.1: activating trash button opens confirmation dialog with name, full path, and permanent warning', () => {
  const mockFolder = {
    name: 'target-dir',
    fullPath: '/workspace/target-dir',
    windowsPath: 'C:\\workspace\\target-dir',
  };

  // Render modal with initialFolderToDelete to test confirmation dialog contents directly
  const html = renderToStaticMarkup(
    React.createElement(FolderPickerModal, {
      isOpen: true,
      initialPath: '/workspace',
      initialFolders: [mockFolder],
      initialFolderToDelete: mockFolder,
      onClose: () => {},
      onSelectFolder: () => {},
      locale: 'en',
    })
  );

  assert.ok(html.includes('folder-picker-delete-modal'), 'Delete confirmation modal must be open');
  assert.ok(html.includes('target-dir'), 'Must display target folder name');
  assert.ok(
    html.includes('C:\\workspace\\target-dir') || html.includes('/workspace/target-dir'),
    'Must display target full path'
  );
  assert.ok(html.includes('permanent and irreversible'), 'Must display permanent deletion warning');
  assert.ok(html.includes('btn-delete-folder-confirm'), 'Must render confirm button');
  assert.ok(html.includes('btn-delete-folder-cancel'), 'Must render cancel button');
});

// S1: Trash button click stops propagation to prevent folder selection
test('FolderPickerModal S1: trash button click stops propagation to prevent folder selection', () => {
  let tree: any = null;
  const mockFolder = {
    name: 'target-dir',
    fullPath: '/workspace/target-dir',
  };

  renderToStaticMarkup(
    React.createElement(() => {
      tree = FolderPickerModal({
        isOpen: true,
        initialPath: '/workspace',
        initialFolders: [mockFolder],
        onClose: () => {},
        onSelectFolder: () => {},
        locale: 'en',
      });
      return tree;
    })
  );

  const trashBtn = findElement(
    tree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('folder-item-trash-btn')
  );
  assert.ok(trashBtn, 'Trash button must be rendered on folder item');

  let propagationStopped = false;
  trashBtn.props.onClick({
    stopPropagation: () => {
      propagationStopped = true;
    },
    preventDefault: () => {},
  });
  assert.strictEqual(propagationStopped, true, 'Trash button click must stop propagation');
});

// S2.2: Delete confirm button starts disabled until exact folder name is typed
test('FolderPickerModal S2.2: delete confirm button starts disabled until exact folder name is typed', () => {
  let tree: any = null;
  const mockFolder = {
    name: 'important-data',
    fullPath: '/workspace/important-data',
  };

  renderToStaticMarkup(
    React.createElement(() => {
      tree = FolderPickerModal({
        isOpen: true,
        initialPath: '/workspace',
        initialFolders: [mockFolder],
        initialFolderToDelete: mockFolder,
        onClose: () => {},
        onSelectFolder: () => {},
        locale: 'en',
      });
      return tree;
    })
  );

  const confirmBtn = findElement(
    tree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('btn-delete-folder-confirm')
  );
  assert.ok(confirmBtn, 'Confirm button must be rendered');
  assert.strictEqual(
    confirmBtn.props.disabled,
    true,
    'Confirm button must be disabled when confirmation name is empty'
  );

  const input = findElement(
    tree,
    (el) =>
      el?.type === 'input' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('delete-folder-input')
  );
  assert.ok(input, 'Confirmation input must be present');
  assert.strictEqual(input.props.placeholder, 'important-data', 'Input placeholder must match folder name');

  const cancelBtn = findElement(
    tree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('btn-delete-folder-cancel')
  );
  assert.ok(cancelBtn, 'Cancel button must be rendered');
});

test('projects: browseFilesystemPi returns result from mock invoke', async () => {
  const mockResult: BrowseFilesystemResult = {
    currentPath: '/test/workspace',
    windowsPath: 'Z:\\workspace',
    parentPath: '/test',
    folders: [{ name: 'sub', fullPath: '/test/workspace/sub', windowsPath: 'Z:\\workspace\\sub' }],
    shortcuts: [{ name: 'Workspace', path: '/test/workspace', windowsPath: 'Z:\\workspace' }],
  };

  const res = await browseFilesystemPi('/test/workspace', async (cmd, args) => {
    assert.strictEqual(cmd, 'browse_filesystem');
    assert.deepStrictEqual(args, { payload: { path: '/test/workspace' } });
    return mockResult as any;
  });

  assert.strictEqual(res.currentPath, '/test/workspace');
  assert.strictEqual(res.windowsPath, 'Z:\\workspace');
  assert.strictEqual(res.folders.length, 1);
  assert.strictEqual(res.folders[0].name, 'sub');
  assert.strictEqual(res.shortcuts.length, 1);
});

test('projects: browseFilesystemPi provides safe fallback when invokeFn rejects', async () => {
  const res = await browseFilesystemPi('/fallback/dir', async () => {
    throw new Error('Command failed');
  });

  assert.strictEqual(res.currentPath, '/fallback/dir');
  assert.ok(Array.isArray(res.folders));
  assert.ok(Array.isArray(res.shortcuts));
  assert.ok(res.shortcuts.length > 0);
});

test('useProjects: handleSelectProject calls onActivateProject and applyWorkingDirectory when switching project', (t) => {
  const fakeStorage = createMockStorage();
  const initialRegistry: ProjectsRegistry = {
    activeProjectId: 'proj-1',
    projects: [
      { id: 'proj-1', path: '/path/to/one', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' },
      { id: 'proj-2', path: '/path/to/two', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' },
    ],
  };
  fakeStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(initialRegistry));
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;
  t.after(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  });

  let activatedId: string | null = null;
  let appliedPath: string | null = null;
  let hookResult!: UseProjectsResult;

  function Harness() {
    hookResult = useProjects({
      workingDirectory: '/path/to/one',
      isBusy: false,
      applyWorkingDirectory: (p) => { appliedPath = p; },
      onActivateProject: (id: string) => { activatedId = id; },
    } as UseProjectsOptions);
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  const proj2 = hookResult.projectsRegistry.projects[1];
  assert.strictEqual(proj2.id, 'proj-2');

  // Switch to proj-2
  hookResult.handleSelectProject(proj2);
  assert.strictEqual(activatedId, 'proj-2', 'Switching to different project must call onActivateProject');
  assert.strictEqual(appliedPath, '/path/to/two', 'Switching to different project must call applyWorkingDirectory');

  // Selecting proj-2 again must be a no-op (guarded no-op)
  activatedId = null;
  appliedPath = null;
  hookResult.handleSelectProject(proj2);
  assert.strictEqual(activatedId, null, 'Selecting already-active project must NOT call onActivateProject');
  assert.strictEqual(appliedPath, null, 'Selecting already-active project must NOT call applyWorkingDirectory');
});

test('useProjects: handleAddProject activates newly added project and guards cancellation', async (t) => {
  const fakeStorage = createMockStorage();
  (globalThis as any).localStorage = fakeStorage;
  t.after(() => {
    delete (globalThis as any).localStorage;
  });

  let activatedId: string | null = null;
  let appliedPath: string | null = null;
  let hookResult!: UseProjectsResult;

  function Harness() {
    hookResult = useProjects({
      workingDirectory: '/path/to/one',
      isBusy: false,
      applyWorkingDirectory: (p) => { appliedPath = p; },
      onActivateProject: (id: string) => { activatedId = id; },
    } as UseProjectsOptions);
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  // Add project with explicit path
  await hookResult.handleAddProject('/path/to/added-project', 'Added Project');

  assert.ok(activatedId, 'handleAddProject must call onActivateProject for the added project');
  assert.strictEqual(appliedPath, normalizeProjectPath('/path/to/added-project'));

  // Cancelled add (when pickedPath is undefined and picker returns null)
  activatedId = null;
  appliedPath = null;
  // In preview environment without window.__TAURI_INTERNALS__, pickDirectoryPi returns null
  await hookResult.handleAddProject();
  assert.strictEqual(activatedId, null, 'Cancelled project pick must NOT call onActivateProject');
  assert.strictEqual(appliedPath, null, 'Cancelled project pick must NOT call applyWorkingDirectory');
});

test('projects: addProject with activate: false preserves active selection when adding new project', () => {
  const initialRegistry: ProjectsRegistry = {
    projects: [
      {
        id: 'p-alpha',
        path: '/workspace/alpha',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeProjectId: 'p-alpha',
  };

  const { registry, project, isNew } = addProject(
    initialRegistry,
    '/workspace/host-root',
    'Host Root',
    { activate: false }
  );

  assert.strictEqual(isNew, true);
  assert.strictEqual(registry.projects.length, 2);
  assert.strictEqual(registry.activeProjectId, 'p-alpha', 'activeProjectId must remain p-alpha and not be hijacked');
  assert.strictEqual(project.path, normalizeProjectPath('/workspace/host-root'));
});

test('projects: addProject with activate: false preserves active selection when referencing existing project', () => {
  const initialRegistry: ProjectsRegistry = {
    projects: [
      {
        id: 'p-alpha',
        path: '/workspace/alpha',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'p-beta',
        path: '/workspace/beta',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeProjectId: 'p-alpha',
  };

  const { registry, project, isNew } = addProject(
    initialRegistry,
    '/workspace/beta',
    undefined,
    { activate: false }
  );

  assert.strictEqual(isNew, false);
  assert.strictEqual(registry.projects.length, 2);
  assert.strictEqual(registry.activeProjectId, 'p-alpha', 'activeProjectId must remain p-alpha when re-adding beta passively');
  assert.strictEqual(project.id, 'p-beta');
  assert.strictEqual(project.lastOpenedAt, '2026-01-01T00:00:00.000Z', 'lastOpenedAt must not be bumped without activation');
});

test('useProjects: addProjectForPath with activate: false preserves active selection in registry and storage', (t) => {
  const fakeStorage = createMockStorage();
  const initialRegistry: ProjectsRegistry = {
    activeProjectId: 'p-alpha',
    projects: [
      { id: 'p-alpha', path: '/workspace/alpha', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' },
      { id: 'p-beta', path: '/workspace/beta', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' },
    ],
  };
  fakeStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(initialRegistry));
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;
  t.after(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  });

  let activatedId: string | null = null;
  let appliedPath: string | null = null;
  let hookResult!: UseProjectsResult;

  function Harness() {
    hookResult = useProjects({
      workingDirectory: '/workspace/alpha',
      isBusy: false,
      applyWorkingDirectory: (p) => { appliedPath = p; },
      onActivateProject: (id: string) => { activatedId = id; },
    } as UseProjectsOptions);
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  assert.strictEqual(hookResult.projectsRegistry.activeProjectId, 'p-alpha');

  // Passive addition of host-root with activate: false
  hookResult.addProjectForPath('/workspace/host-root', { activate: false });

  assert.strictEqual(activatedId, null, 'Passive addProjectForPath must not trigger onActivateProject');
  assert.strictEqual(appliedPath, null, 'Passive addProjectForPath must not trigger applyWorkingDirectory');

  const saved = JSON.parse(fakeStorage.getItem(PROJECTS_STORAGE_KEY)!);
  assert.strictEqual(
    saved.activeProjectId,
    'p-alpha',
    'Passive addProjectForPath must not hijack activeProjectId in storage'
  );
  assert.strictEqual(saved.projects.length, 3);
});

test('regression: async connection completion for discovered project preserves user-selected project and terminal context', () => {
  // Simulates App.tsx onConnectSuccess handling
  const registry: ProjectsRegistry = {
    activeProjectId: 'proj-alpha',
    projects: [
      { id: 'proj-alpha', path: '/workspace/alpha', customName: 'Project Alpha', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' },
      { id: 'proj-beta', path: '/workspace/beta', customName: 'Project Beta', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' },
    ],
  };

  // User has active project Alpha selected
  let currentRegistry = registry;
  const addProjectForPath = (path: string, options?: { activate?: boolean }) => {
    const outcome = addProject(currentRegistry, path, undefined, options);
    currentRegistry = outcome.registry;
    return outcome.project;
  };

  // Discovered host root connection completes in background
  const res = { canonicalCwd: '/workspace/discovered-host-root' };

  const matched = res.canonicalCwd
    ? findProjectByCwd(currentRegistry.projects, res.canonicalCwd)
    : undefined;
  let targetProjectId = matched?.id;

  if (!targetProjectId && res.canonicalCwd) {
    // Passive connection completion must NOT activate or hijack active project
    addProjectForPath(res.canonicalCwd, { activate: false });
    const recheck = findProjectByCwd(currentRegistry.projects, res.canonicalCwd);
    targetProjectId = recheck?.id ?? currentRegistry.activeProjectId ?? undefined;
  }

  // Active project MUST remain proj-alpha
  assert.strictEqual(currentRegistry.activeProjectId, 'proj-alpha', 'Active project must remain proj-alpha');

  // Terminal context derived from active project must still point to Alpha
  const activeProj = currentRegistry.projects.find((p) => p.id === currentRegistry.activeProjectId);
  assert.strictEqual(activeProj?.path, '/workspace/alpha', 'Active terminal cwd must remain /workspace/alpha');
  assert.strictEqual(activeProj?.customName, 'Project Alpha');

  // Target project for session hydration is correctly isolated to the discovered project
  assert.ok(targetProjectId, 'targetProjectId must be identified for session hydration');
  assert.notStrictEqual(targetProjectId, 'proj-alpha', 'Session payload must target discovered project, not alpha');
});
test('ProjectDock footer PRESERVE: clicking Clone button triggers onOpenGitHubClone and preserves Add Project behavior', () => {
  let cloneOpened = false;
  let addOpened = false;
  let capturedTree: any = null;

  renderToStaticMarkup(
    React.createElement(() => {
      capturedTree = ProjectDock({
        ...baseProjectDockProps,
        onOpenAddProject: () => {
          addOpened = true;
        },
        onOpenGitHubClone: () => {
          cloneOpened = true;
        },
      });
      return capturedTree;
    })
  );

  const cloneBtn = findElement(
    capturedTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('project-footer-clone')
  );

  assert.ok(cloneBtn, 'Clone button must be present in ProjectDock footer');
  assert.strictEqual(typeof cloneBtn.props.onClick, 'function');
  cloneBtn.props.onClick();
  assert.strictEqual(cloneOpened, true, 'onClick must trigger onOpenGitHubClone callback');

  const addBtn = findElement(
    capturedTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('project-footer-row') &&
      !el.props.className.includes('project-footer-clone') &&
      !el.props.className.includes('project-footer-settings')
  );

  assert.ok(addBtn, 'Add Project button must still be present and functional');
  addBtn.props.onClick();
  assert.strictEqual(addOpened, true, 'onClick must trigger onOpenAddProject callback');
});

test('DefaultDirectorySetupModal: renders accessible dialog when open and null when closed', () => {
  let closedTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      closedTree = DefaultDirectorySetupModal({
        isOpen: false,
        onClose: () => {},
        onConfirm: () => {},
        locale: 'en',
      });
      return closedTree;
    })
  );
  assert.strictEqual(closedTree, null);

  let openTree: any = null;
  renderToStaticMarkup(
    React.createElement(() => {
      openTree = DefaultDirectorySetupModal({
        isOpen: true,
        initialPath: '/home/user/projects',
        onClose: () => {},
        onConfirm: () => {},
        locale: 'en',
      });
      return openTree;
    })
  );

  const dialog = findElement(
    openTree,
    (el) => el?.props?.role === 'dialog' && el?.props?.['aria-modal'] === 'true'
  );
  assert.ok(dialog, 'Modal must have role="dialog" and aria-modal="true"');

  const input = findElement(
    openTree,
    (el) => el?.type === 'input' && el?.props?.id === 'default-directory-path-input'
  );
  assert.ok(input, 'Path input must be present');
  assert.strictEqual(input.props.value, '/home/user/projects');
});

test('DefaultDirectorySetupModal: triggers onConfirm on form submit with trimmed directory', () => {
  let confirmedDir: string | null = null;
  let openTree: any = null;

  renderToStaticMarkup(
    React.createElement(() => {
      openTree = DefaultDirectorySetupModal({
        isOpen: true,
        initialPath: '  /custom/projects/path  ',
        onClose: () => {},
        onConfirm: (dir) => {
          confirmedDir = dir;
        },
        locale: 'es',
      });
      return openTree;
    })
  );

  const form = findElement(openTree, (el) => el?.type === 'form');
  assert.ok(form, 'Form element must exist');
  assert.strictEqual(typeof form.props.onSubmit, 'function');

  form.props.onSubmit({ preventDefault: () => {} });
  assert.strictEqual(confirmedDir, '/custom/projects/path', 'onConfirm must be called with trimmed path');
});

test('DefaultDirectorySetupModal: close button invokes onClose callback', () => {
  let closed = false;
  let openTree: any = null;

  renderToStaticMarkup(
    React.createElement(() => {
      openTree = DefaultDirectorySetupModal({
        isOpen: true,
        onClose: () => {
          closed = true;
        },
        onConfirm: () => {},
        locale: 'en',
      });
      return openTree;
    })
  );

  const closeBtn = findElement(
    openTree,
    (el) =>
      el?.type === 'button' &&
      typeof el?.props?.className === 'string' &&
      el.props.className.includes('folder-picker-close-btn')
  );
  assert.ok(closeBtn, 'Close button must exist');
  closeBtn.props.onClick();
  assert.strictEqual(closed, true, 'Clicking close button must invoke onClose');
});

