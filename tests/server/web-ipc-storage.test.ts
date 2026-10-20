import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleIpcCommand } from '@server/web-ipc-bridge';

test('server/bridge: IPC get_viewer_storage, save_viewer_storage, update_viewer_storage_key', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-storage-test-'));
  const testFile = path.join(tmpDir, 'test-open-pi-viewer.json');
  const { setStorageFilePathForTest } = await import('@server/storage');
  setStorageFilePathForTest(testFile);

  t.after(() => {
    setStorageFilePathForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Initial read
  const initial: any = await handleIpcCommand('get_viewer_storage');
  assert.strictEqual(initial.version, 1);
  assert.strictEqual(initial.uiPreferences, null);

  // 2. Save storage
  const saved: any = await handleIpcCommand('save_viewer_storage', {
    uiPreferences: { theme: 'light', language: 'en' },
  });
  assert.strictEqual(saved.version, 1);
  assert.deepStrictEqual(saved.uiPreferences, { theme: 'light', language: 'en' });

  // 4. Update projects key when a project is removed
  const projectsUpdate: any = await handleIpcCommand('update_viewer_storage_key', {
    key: 'projects',
    value: {
      activeProjectId: 'p2',
      projects: [{ id: 'p2', path: '/work/project-2' }],
    },
  });
  assert.strictEqual(projectsUpdate.projects.projects.length, 1);
  assert.strictEqual(projectsUpdate.projects.projects[0].id, 'p2');
  assert.strictEqual(projectsUpdate.projects.activeProjectId, 'p2');
});

