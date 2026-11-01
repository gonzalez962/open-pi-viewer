import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRemoteStorageUpdate, initStorageSynchronization } from '@app/storage-sync';
import { GITHUB_PAT_STORAGE_KEY, saveGitHubPat } from '@features/projects/github-clone';

function browser(initial: Record<string, string>, invoke: (cmd: string, args?: any) => Promise<any>) {
  const data = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
    clear: () => data.clear(),
  };
  const previous = (globalThis as any).window;
  (globalThis as any).window = { localStorage, __IS_WEB_IPC__: true, __TAURI_INTERNALS__: { invoke }, addEventListener() {}, dispatchEvent() {} };
  return { localStorage, restore: () => { (globalThis as any).window = previous; } };
}

for (const existing of [false, true]) {
  test(`T1 S2.${existing ? '2' : '1'}: import-if-missing acknowledges ${existing ? 'conflict' : 'persistence'} before cleanup`, async () => {
    let backend: string | null = existing ? 'fake_backend_pat' : null;
    let imports = 0;
    const b = browser({ [GITHUB_PAT_STORAGE_KEY]: 'fake_legacy_pat' }, async (cmd, args) => {
      if (cmd === 'get_viewer_storage') return { version: 1, githubPatConfigured: Boolean(backend) };
      if (cmd === 'import_github_credential') {
        assert.deepEqual(args, { payload: { token: 'fake_legacy_pat' } });
        assert.equal(b.localStorage.getItem(GITHUB_PAT_STORAGE_KEY), 'fake_legacy_pat');
        imports++;
        backend ??= args.payload.token;
        return { configured: true };
      }
      if (cmd === 'get_github_credential_status') return { configured: Boolean(backend) };
      throw new Error(`Unexpected command ${cmd}`);
    });
    try {
      await initStorageSynchronization();
      assert.equal(imports, 1);
      assert.equal(backend, existing ? 'fake_backend_pat' : 'fake_legacy_pat');
      assert.equal(b.localStorage.getItem(GITHUB_PAT_STORAGE_KEY), null);
      handleRemoteStorageUpdate({ version: 1, githubPat: 'fake_legacy_pat' });
      assert.equal(b.localStorage.getItem(GITHUB_PAT_STORAGE_KEY), null);
      await initStorageSynchronization();
      assert.equal(b.localStorage.getItem(GITHUB_PAT_STORAGE_KEY), null);
      assert.equal(imports, 1);
    } finally { b.restore(); }
  });
}

for (const mode of ['failure', 'uncertain'] as const) {
  test(`T1 S2.2: ${mode} migration acknowledgement preserves local source`, async () => {
    let imports = 0;
    const b = browser({ [GITHUB_PAT_STORAGE_KEY]: 'fake_legacy_pat' }, async (cmd, args) => {
      if (cmd === 'get_viewer_storage') return { version: 1, githubPatConfigured: false };
      if (cmd === 'import_github_credential') {
        assert.deepEqual(args, { payload: { token: 'fake_legacy_pat' } });
        imports++;
        if (mode === 'failure') throw new Error('unavailable');
        return { configured: false };
      }
      if (cmd === 'get_github_credential_status') return { configured: false };
      throw new Error(`Unexpected command ${cmd}`);
    });
    try {
      try { await initStorageSynchronization(); } catch { /* failure must retain source */ }
      assert.equal(b.localStorage.getItem(GITHUB_PAT_STORAGE_KEY), 'fake_legacy_pat');
      assert.equal(imports, 1);
    } finally { b.restore(); }
  });
}

test('T1 S1.3: fresh frontend credential save never persists browser copy even in preview', async () => {
  const b = browser({}, async () => { throw new Error('unavailable'); });
  try {
    try { await saveGitHubPat('fake_fresh_pat', b.localStorage); } catch { /* unavailable backend */ }
    assert.equal(b.localStorage.getItem(GITHUB_PAT_STORAGE_KEY), null);
  } finally { b.restore(); }
});
