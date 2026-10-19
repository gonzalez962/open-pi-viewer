import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionProfileSnapshotKey,
  isValidSessionProfileSnapshot,
  loadAllSessionProfileSnapshots,
  loadSessionProfileSnapshot,
  saveSessionProfileSnapshot,
  updateSessionProfileSnapshotManualSelection,
  updateSessionProfileSnapshotExplicitProfile,
  type SessionProfileSnapshot,
} from '@features/profiles/lib/sessionProfileSnapshot';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

test('S4.1: session profile snapshot key generation normalizes cwd and binds to sessionId', () => {
  const key1 = createSessionProfileSnapshotKey('c:\\projects\\my-app', 'session-123');
  const key2 = createSessionProfileSnapshotKey('C:/projects/my-app/', 'session-123');
  assert.strictEqual(key1, key2, 'Key must be lexically normalized across path separators and drive casing');
  assert.strictEqual(key1, 'C:/projects/my-app::session-123');
  assert.strictEqual(isValidSessionProfileSnapshot(null), false);
  const loadedAll = loadAllSessionProfileSnapshots(new MemoryStorage());
  assert.deepStrictEqual(loadedAll.snapshots, {});
});

test('S4.1 / S4.3: persists and loads session snapshot in storage surviving reloads without cross-contamination', () => {
  const storage = new MemoryStorage();

  const snapshotA: SessionProfileSnapshot = {
    cwd: 'C:/projects/proj-a',
    sessionId: 'sess-a',
    profileName: 'reviewer',
    profileScope: 'project',
    modelId: 'gpt-4o',
    provider: 'openai',
    reasoningEffort: 'high',
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  };

  const snapshotB: SessionProfileSnapshot = {
    cwd: 'C:/projects/proj-b',
    sessionId: 'sess-b',
    profileName: 'coder',
    profileScope: 'global',
    modelId: 'claude-3.5-sonnet',
    provider: 'openrouter',
    reasoningEffort: 'max',
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  };

  const saveResA = saveSessionProfileSnapshot(snapshotA, storage);
  assert.strictEqual(saveResA.success, true);
  const saveResB = saveSessionProfileSnapshot(snapshotB, storage);
  assert.strictEqual(saveResB.success, true);

  // Load specifically for project A session
  const loadedA = loadSessionProfileSnapshot('C:/projects/proj-a', 'sess-a', storage);
  assert.ok(loadedA.snapshot);
  assert.strictEqual(loadedA.snapshot.profileName, 'reviewer');
  assert.strictEqual(loadedA.snapshot.modelId, 'gpt-4o');
  assert.strictEqual(loadedA.snapshot.provider, 'openai');
  assert.strictEqual(loadedA.snapshot.reasoningEffort, 'high');

  // Load specifically for project B session (no cross contamination)
  const loadedB = loadSessionProfileSnapshot('C:/projects/proj-b', 'sess-b', storage);
  assert.ok(loadedB.snapshot);
  assert.strictEqual(loadedB.snapshot.profileName, 'coder');
  assert.strictEqual(loadedB.snapshot.modelId, 'claude-3.5-sonnet');
  assert.strictEqual(loadedB.snapshot.reasoningEffort, 'max');

  // Non-existent session returns null snapshot
  const nonExistent = loadSessionProfileSnapshot('C:/projects/proj-a', 'unknown-sess', storage);
  assert.strictEqual(nonExistent.snapshot, null);
});

test('S6.1: explicit profile reselection updates the session snapshot and resets source to profile_default', () => {
  const storage = new MemoryStorage();

  const initial: SessionProfileSnapshot = {
    cwd: 'C:/projects/proj-a',
    sessionId: 'sess-1',
    profileName: 'architect',
    profileScope: 'project',
    modelId: 'gpt-4o',
    provider: 'openai',
    reasoningEffort: 'medium',
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  };
  saveSessionProfileSnapshot(initial, storage);

  const updated = updateSessionProfileSnapshotExplicitProfile(
    'C:/projects/proj-a',
    'sess-1',
    {
      profileName: 'debugger',
      profileScope: 'project',
      modelId: 'gemini-1.5-pro',
      provider: 'google',
      reasoningEffort: 'low',
    },
    storage
  );

  assert.strictEqual(updated.success, true);
  const reloaded = loadSessionProfileSnapshot('C:/projects/proj-a', 'sess-1', storage);
  assert.ok(reloaded.snapshot);
  assert.strictEqual(reloaded.snapshot.profileName, 'debugger');
  assert.strictEqual(reloaded.snapshot.modelId, 'gemini-1.5-pro');
  assert.strictEqual(reloaded.snapshot.provider, 'google');
  assert.strictEqual(reloaded.snapshot.reasoningEffort, 'low');
  assert.strictEqual(reloaded.snapshot.source, 'profile_default');
});

test('S6.2: manual model or effort change preserves profile reference but marks source manual_override', () => {
  const storage = new MemoryStorage();

  const initial: SessionProfileSnapshot = {
    cwd: 'C:/projects/proj-a',
    sessionId: 'sess-1',
    profileName: 'architect',
    profileScope: 'project',
    modelId: 'gpt-4o',
    provider: 'openai',
    reasoningEffort: 'medium',
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  };
  saveSessionProfileSnapshot(initial, storage);

  const updated = updateSessionProfileSnapshotManualSelection(
    'C:/projects/proj-a',
    'sess-1',
    {
      modelId: 'claude-3.5-sonnet',
      provider: 'openrouter',
    },
    storage
  );

  assert.strictEqual(updated.success, true);
  const reloaded = loadSessionProfileSnapshot('C:/projects/proj-a', 'sess-1', storage);
  assert.ok(reloaded.snapshot);
  assert.strictEqual(reloaded.snapshot.profileName, 'architect', 'Preserves original profile association');
  assert.strictEqual(reloaded.snapshot.modelId, 'claude-3.5-sonnet');
  assert.strictEqual(reloaded.snapshot.provider, 'openrouter');
  assert.strictEqual(reloaded.snapshot.reasoningEffort, 'medium', 'Preserves unmodified effort');
  assert.strictEqual(reloaded.snapshot.source, 'manual_override');
});
