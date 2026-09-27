import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACT_PROCESSES_STORAGE_KEY,
  loadCompactProcessesPreference,
  saveCompactProcessesPreference,
} from '@shared/compact-processes';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

test('compact processes: defaults to on when unset or storage is unavailable', () => {
  assert.equal(loadCompactProcessesPreference(memoryStorage()), true);
  assert.equal(loadCompactProcessesPreference(null), true);
});

test('compact processes: an explicit false turns it off and round-trips', () => {
  const storage = memoryStorage();
  assert.equal(saveCompactProcessesPreference(false, storage), true);
  assert.equal(storage.getItem(COMPACT_PROCESSES_STORAGE_KEY), 'false');
  assert.equal(loadCompactProcessesPreference(storage), false);
  saveCompactProcessesPreference(true, storage);
  assert.equal(loadCompactProcessesPreference(storage), true);
});
