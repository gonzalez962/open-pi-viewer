import assert from 'node:assert/strict';
import test from 'node:test';

// Public local-only ranking contract: storage is injectable, promotion returns a
// new ID list, and the dock resolves group membership from its current registry.
async function api() { return import('@features/projects/project-order'); }
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage;
}

test('S12.1: sequential entries persist independent ID rank and restore in a new reader', async () => {
  const { loadProjectOrder, promoteProjectOrder, saveProjectOrder, PROJECT_ORDER_STORAGE_KEY } = await api();
  const store = storage();
  assert.deepEqual(loadProjectOrder(store), []);
  let order = promoteProjectOrder([], 'parent');
  order = promoteProjectOrder(order, 'ordinary');
  order = promoteProjectOrder(order, 'child');
  assert.deepEqual(order, ['child', 'ordinary', 'parent']);
  saveProjectOrder(order, store);
  assert.ok(store.getItem(PROJECT_ORDER_STORAGE_KEY));
  assert.deepEqual(loadProjectOrder(store), order);
  const again = promoteProjectOrder(loadProjectOrder(store), 'ordinary');
  assert.deepEqual(again, ['child', 'ordinary', 'parent']);
  assert.deepEqual(loadProjectOrder(store), order);
});

test('S12.2: malformed and unavailable storage is safe; stale and duplicate IDs cannot erase valid IDs', async () => {
  const { loadProjectOrder, promoteProjectOrder, saveProjectOrder, PROJECT_ORDER_STORAGE_KEY } = await api();
  const store = storage();
  store.setItem(PROJECT_ORDER_STORAGE_KEY, '{bad');
  assert.deepEqual(loadProjectOrder(store), []);
  store.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(['stale', 'child', null, 4, 'child', '', 'ordinary']));
  assert.deepEqual(loadProjectOrder(store), ['stale', 'child', 'ordinary']);
  assert.deepEqual(promoteProjectOrder(loadProjectOrder(store), 'parent'), ['parent', 'stale', 'child', 'ordinary']);
  const throwing = { ...store, getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(loadProjectOrder(throwing), []);
  assert.doesNotThrow(() => saveProjectOrder(['child'], throwing));
  assert.deepEqual(loadProjectOrder(null), []);
  assert.doesNotThrow(() => saveProjectOrder(['child'], null));
});
