import test from 'node:test';
import assert from 'node:assert/strict';
import { setActiveSddProfilePi, MOCK_SDD_PROFILES_STORAGE_KEY, MOCK_SDD_PROJECT_ACTIVE_PROFILE_PREFIX } from '@infra/bridge';
import { applyProfileRuntime } from '@core/types/profiles';
import { initWebIpcClient } from '@infra/web-ipc-client';

test('S2.1 web shim forwards project activation and declaration feedback via IPC', async () => {
  const originals = { window: globalThis.window, fetch: globalThis.fetch };
  const calls: any[] = [];
  const fakeWindow: any = { addEventListener() {} };
  const result = { success: true, message: 'Declaration persisted; existing session may need to restart' };
  Object.assign(globalThis, { window: fakeWindow, fetch: async (url: string, options: any) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ result }) };
  } });
  try {
    initWebIpcClient();
    const args = { name: 'selected', scope: 'project', cwd: '/worktree' };
    assert.deepEqual(await fakeWindow.__TAURI_INTERNALS__.invoke('set_active_sdd_profile', args), result);
    assert.deepEqual(calls, [{ url: '/api/ipc', method: 'POST', body: { cmd: 'set_active_sdd_profile', args } }]);
  } finally {
    Object.assign(globalThis, originals);
  }
});

test('S2.1 preview activation retains project localStorage behavior', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const oldWindow = (globalThis as any).window;
  const oldStorage = (globalThis as any).localStorage;
  (globalThis as any).window = { localStorage: storage };
  (globalThis as any).localStorage = storage;
  try {
    storage.setItem(MOCK_SDD_PROFILES_STORAGE_KEY, JSON.stringify([{ id: 'preview', name: 'Preview', model_profiles: {} }]));
    const result = await setActiveSddProfilePi({ name: 'preview', scope: 'project', cwd: '/project' });
    assert.deepEqual(result, { success: true, message: "Active profile set to 'preview'" });
    assert.equal(storage.getItem(`${MOCK_SDD_PROJECT_ACTIVE_PROFILE_PREFIX}/project`), 'preview');
  } finally {
    if (oldWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = oldWindow;
    if (oldStorage === undefined) delete (globalThis as any).localStorage; else (globalThis as any).localStorage = oldStorage;
  }
});

test('S2.1 orchestrator activation still applies default model and effort', async () => {
  const calls: string[] = [];
  await applyProfileRuntime({ name: 'Profile', scope: 'global', agent_count: 1, is_active: false, default_model: 'vendor/model', default_effort: 'high' }, {
    isConnected: true,
    availableModels: [{ id: 'model', provider: 'vendor' }],
    onSelectModel: async (provider, model) => { calls.push(`${provider}/${model}`); },
    onSelectThinkingLevel: async (effort) => { calls.push(effort); },
  });
  assert.deepEqual(calls, ['vendor/model', 'high']);
});
