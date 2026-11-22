import assert from 'node:assert/strict';
import test from 'node:test';

// Public local-only ranking contract: storage is injectable and reopening a
// ranked project does not change its position.
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
  const { loadProjectOrder, appendProjectOrder, saveProjectOrder, PROJECT_ORDER_STORAGE_KEY } = await api();
  const store = storage();
  assert.deepEqual(loadProjectOrder(store), []);
  const order = ['1', '2', '3', '4'].reduce(appendProjectOrder, [] as string[]);
  assert.deepEqual(order, ['1', '2', '3', '4']);
  saveProjectOrder(order, store);
  assert.equal(store.getItem(PROJECT_ORDER_STORAGE_KEY), '["1","2","3","4"]');
  assert.equal(store.length, 1);
  const restored = loadProjectOrder(store);
  assert.deepEqual(restored, order);
  assert.strictEqual(appendProjectOrder(restored, '2'), restored);
  assert.deepEqual(loadProjectOrder(store), order);
});

test('S12.2: malformed and unavailable storage is safe; stale and duplicate IDs cannot erase valid IDs', async () => {
  const { loadProjectOrder, appendProjectOrder, saveProjectOrder, PROJECT_ORDER_STORAGE_KEY } = await api();
  const store = storage();
  store.setItem(PROJECT_ORDER_STORAGE_KEY, '{bad');
  assert.deepEqual(loadProjectOrder(store), []);
  store.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(['stale', 'child', null, 4, 'child', '', 'ordinary']));
  assert.deepEqual(loadProjectOrder(store), ['stale', 'child', 'ordinary']);
  assert.deepEqual(appendProjectOrder(loadProjectOrder(store), 'parent'), ['stale', 'child', 'ordinary', 'parent']);
  const throwing = { ...store, getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(loadProjectOrder(throwing), []);
  assert.doesNotThrow(() => saveProjectOrder(['child'], throwing));
  assert.deepEqual(loadProjectOrder(null), []);
  assert.doesNotThrow(() => saveProjectOrder(['child'], null));
});

test('a historical order stays intact on load and reopening; a new project appends', async () => {
  const { loadProjectOrder, appendProjectOrder, saveProjectOrder, PROJECT_ORDER_STORAGE_KEY } = await api();
  const store = storage();
  store.setItem(PROJECT_ORDER_STORAGE_KEY, '["4","3","2","1"]');
  const restored = loadProjectOrder(store);
  assert.deepEqual(restored, ['4', '3', '2', '1']);
  assert.strictEqual(appendProjectOrder(restored, '3'), restored);
  assert.equal(store.getItem(PROJECT_ORDER_STORAGE_KEY), '["4","3","2","1"]');
  saveProjectOrder(appendProjectOrder(restored, '5'), store);
  assert.equal(store.getItem(PROJECT_ORDER_STORAGE_KEY), '["4","3","2","1","5"]');
});
