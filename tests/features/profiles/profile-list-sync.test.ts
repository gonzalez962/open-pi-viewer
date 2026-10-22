import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Run the actual hook callbacks with isolated persistence and browser events.
const source = fs.readFileSync(new URL('../../../src/features/profiles/hooks/useProfiles.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('useProfiles.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function expressions() {
  let save: ts.Expression | undefined;
  let del: ts.Expression | undefined;
  const effects: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleSaveProfile') {
      save = (node.initializer as ts.CallExpression).arguments[0];
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleDeleteProfile') {
      del = (node.initializer as ts.CallExpression).arguments[0];
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect') effects.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(save);
  assert.ok(del);
  return { save, del, effects };
}
function compile(expression: ts.Expression, scope: Record<string, unknown>) {
  const js = ts.transpileModule(`const callback = ${expression.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(scope), `${js}; return callback;`)(...Object.values(scope));
}
async function fixture(success: boolean) {
  const target = new EventTarget();
  const stored: string[] = [];
  let localList: string[] = [];
  let otherList: string[] = [];
  const notifications: string[] = [];
  const window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: (event: Event) => { notifications.push(event.type); return target.dispatchEvent(event); },
  };
  const eventName = 'pi:profiles-changed';
  const { save, effects } = expressions();
  const cleanups: Array<() => void> = [];
  // Attach another mounted hook instance using the real synchronization effect.
  for (const effect of effects.filter((node) => node.getText(file).includes('addEventListener'))) {
    const cleanup = compile(effect, {
      window, PROFILE_LIST_CHANGED_EVENT: eventName,
      refreshProfiles: async () => { otherList = [...stored]; },
    })();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  const run = compile(save, {
    formData: { name: 'new-profile', description: '', default_model: '', default_effort: '', model_profiles: {}, scope: 'global' },
    sanitizeProfileName: (name: string) => name,
    setIsSaving: () => {}, setModalError: () => {},
    isEditing: false, editingOriginalName: null, editingOriginalScope: null, cwd: '/project',
    saveSddProfilePi: async () => { if (success) stored.push('new-profile'); return { success, message: 'Save rejected' }; },
    setIsModalOpen: () => {}, setSuccessNotice: () => {},
    refreshProfiles: async () => { localList = [...stored]; },
    window, Event, PROFILE_LIST_CHANGED_EVENT: eventName,
  });
  const result = await run({ preventDefault() {} });
  return { result, stored, localList, get otherList() { return otherList; }, notifications, window, cleanups, eventName };
}

test('saving a profile refreshes another mounted profile list without activation', async () => {
  const f = await fixture(true);
  assert.equal(f.result, true);
  assert.deepEqual(f.localList, ['new-profile']);
  assert.deepEqual(f.otherList, ['new-profile']);
  assert.deepEqual(f.notifications, ['pi:profiles-changed']);
  f.cleanups.forEach((cleanup) => cleanup());
});

test('rejected profile saves leave both lists unchanged and emit no notification', async () => {
  const f = await fixture(false);
  assert.equal(f.result, false);
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.localList, []);
  assert.deepEqual(f.otherList, []);
  assert.deepEqual(f.notifications, []);
  f.cleanups.forEach((cleanup) => cleanup());
});

test('deleting a profile dispatches change event and refreshes other mounted profile lists', async () => {
  const target = new EventTarget();
  let stored = ['profile-a', 'profile-b'];
  let otherList = [...stored];
  let localList = [...stored];
  const notifications: string[] = [];
  const window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: (event: Event) => { notifications.push(event.type); return target.dispatchEvent(event); },
  };
  const eventName = 'pi:profiles-changed';
  const { del, effects } = expressions();
  const cleanups: Array<() => void> = [];

  for (const effect of effects.filter((node) => node.getText(file).includes('addEventListener'))) {
    const cleanup = compile(effect, {
      window, PROFILE_LIST_CHANGED_EVENT: eventName,
      refreshProfiles: async () => { otherList = [...stored]; },
    })();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }

  const runDelete = compile(del!, {
    setIsDeleting: () => {},
    setDeletingName: () => {},
    setError: () => {},
    setSuccessNotice: () => {},
    setProfiles: (fn: (prev: any[]) => any[]) => { localList = fn(localList.map((n) => ({ name: n }))).map((p: any) => p.name); },
    deleteSddProfilePi: async () => {
      stored = stored.filter((n) => n !== 'profile-a');
      return { success: true, message: 'Deleted' };
    },
    refreshProfiles: async () => {},
    window,
    Event,
    PROFILE_LIST_CHANGED_EVENT: eventName,
    cwd: '/project',
  });

  await runDelete({ name: 'profile-a', scope: 'global' });

  assert.deepEqual(localList, ['profile-b']);
  assert.deepEqual(otherList, ['profile-b']);
  assert.deepEqual(notifications, ['pi:profiles-changed']);
  cleanups.forEach((cleanup) => cleanup());
});
