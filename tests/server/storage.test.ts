import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadViewerStorage,
  saveViewerStorage,
  updateViewerStorageKey,
  setStorageFilePathForTest,
} from '@server/storage';

test('server/storage: returns default empty storage when file does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-viewer-storage-test-'));
  const testFile = path.join(tmpDir, 'test-open-pi-viewer.json');
  setStorageFilePathForTest(testFile);

  try {
    const data = loadViewerStorage();
    assert.strictEqual(data.version, 1);
    assert.strictEqual(data.uiPreferences, null);
    assert.strictEqual(data.connectConfig, null);
    assert.strictEqual(data.projects, null);
  } finally {
    setStorageFilePathForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server/storage: atomically saves and updates viewer storage', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-viewer-storage-test-'));
  const testFile = path.join(tmpDir, 'nested', 'test-open-pi-viewer.json');
  setStorageFilePathForTest(testFile);

  try {
    saveViewerStorage({
      uiPreferences: { theme: 'dark', language: 'es' },
      projects: { activeProjectId: 'p1', projects: [] },
    });

    assert.ok(fs.existsSync(testFile), 'Storage file was created');
    const loaded = loadViewerStorage();
    assert.deepEqual(loaded.uiPreferences, { theme: 'dark', language: 'es' });
    assert.deepEqual(loaded.projects, { activeProjectId: 'p1', projects: [] });

    // Test updating a single key
    updateViewerStorageKey('connectConfig', { nodePath: 'node', workingDirectory: '/test' });
    const updated = loadViewerStorage();
    assert.deepEqual(updated.uiPreferences, { theme: 'dark', language: 'es' });
    assert.deepEqual(updated.connectConfig, { nodePath: 'node', workingDirectory: '/test' });
  } finally {
    setStorageFilePathForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
