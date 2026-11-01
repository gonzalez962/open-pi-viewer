import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleIpcCommand } from '@server/web-ipc-bridge';

test('S1.3 legacy server voice keys are removed before generic IPC reads', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-speech-legacy-'));
  const testFile = path.join(tmpDir, 'storage.json');
  const { setStorageFilePathForTest } = await import('@server/storage');
  setStorageFilePathForTest(testFile);
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  fs.writeFileSync(testFile, JSON.stringify({ version: 1, uiPreferences: { language: 'en', theme: 'dark', speech: {
    ttsEnabled: true, sttEnabled: true, openAiApiKey: 'legacy-openai-secret', compatibleSttApiKey: 'legacy-compatible-secret',
  } } }));
  const result = await handleIpcCommand('get_viewer_storage');
  assert.equal(JSON.stringify(result).includes('legacy-openai-secret'), false);
  assert.equal(JSON.stringify(result).includes('legacy-compatible-secret'), false);
  const persisted = fs.readFileSync(testFile, 'utf8');
  assert.equal(persisted.includes('legacy-openai-secret'), false);
  assert.equal(persisted.includes('legacy-compatible-secret'), false);
  assert.equal(result.uiPreferences?.speech && (result.uiPreferences.speech as any).ttsEnabled, true);
});

test('S1.1 generic IPC storage never returns or persists submitted voice keys', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-speech-save-'));
  const testFile = path.join(tmpDir, 'storage.json');
  const { setStorageFilePathForTest } = await import('@server/storage');
  setStorageFilePathForTest(testFile);
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const saved = await handleIpcCommand('save_viewer_storage', { uiPreferences: { language: 'en', theme: 'dark', speech: {
    ttsEnabled: true, sttEnabled: true, openAiApiKey: 'submitted-openai', compatibleSttApiKey: 'submitted-compatible',
  } } });
  const loaded = await handleIpcCommand('get_viewer_storage');
  for (const value of [saved, loaded, fs.readFileSync(testFile, 'utf8')]) {
    assert.equal(JSON.stringify(value).includes('submitted-openai'), false);
    assert.equal(JSON.stringify(value).includes('submitted-compatible'), false);
  }
});

test('S2.1 speech-only IPC patch preserves current unrelated and other speech settings', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-speech-patch-'));
  const { setStorageFilePathForTest } = await import('@server/storage');
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  await handleIpcCommand('save_viewer_storage', { uiPreferences: { language: 'es', theme: 'light', speech: { ttsEnabled: false, sttEnabled: true, wyomingSttModel: 'small' } } });
  const result = await handleIpcCommand('patch_speech_preferences', { patch: { ttsEnabled: true } });
  const loaded = await handleIpcCommand('get_viewer_storage');
  assert.deepEqual(result, loaded);
  assert.equal(loaded.uiPreferences.language, 'es');
  assert.equal(loaded.uiPreferences.theme, 'light');
  assert.equal(loaded.uiPreferences.speech.ttsEnabled, true);
  assert.equal(loaded.uiPreferences.speech.sttEnabled, true);
  assert.equal(loaded.uiPreferences.speech.wyomingSttModel, 'small');
});

for (const [cmd, args] of [
  ['get_viewer_storage', {}],
  ['save_viewer_storage', { payload: { uiPreferences: { theme: 'dark' } } }],
  ['update_viewer_storage_key', { key: 'projects', value: null }],
] as const) {
  test(`T1 S1.1: ${cmd} hides saved GitHub PAT`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-github-boundary-'));
    const { setStorageFilePathForTest, saveViewerStorage } = await import('@server/storage');
    setStorageFilePathForTest(path.join(dir, 'storage.json'));
    t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
    const token = 'fake_t1_saved_pat';
    saveViewerStorage({ githubPat: token });
    const serialized = JSON.stringify(await handleIpcCommand(cmd, args));
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(Buffer.from(token).toString('base64')), false);
  });
}

for (const [cmd, args] of [
  ['save_viewer_storage', { payload: { githubPat: 'fake_replacement_pat' } }],
  ['update_viewer_storage_key', { key: 'githubPat', value: null }],
] as const) {
  test(`T1 S1.3: ${cmd} cannot replace or clear saved PAT`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-github-preserve-'));
    const { setStorageFilePathForTest, saveViewerStorage, loadViewerStorage } = await import('@server/storage');
    setStorageFilePathForTest(path.join(dir, 'storage.json'));
    t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
    saveViewerStorage({ githubPat: 'fake_original_pat' });
    let result: unknown;
    try { result = await handleIpcCommand(cmd, args); } catch (error) { result = String(error); }
    const serialized = JSON.stringify(result) ?? '';
    assert.equal(serialized.includes('fake_original_pat'), false);
    assert.equal(serialized.includes('fake_replacement_pat'), false);
    assert.equal(loadViewerStorage().githubPat, 'fake_original_pat');
  });
}

for (const key of ['githubPat', 'githubPatConfigured']) {
  test(`T1 S1.3: save rejects protected ${key} without changing stored bytes`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-protected-save-'));
    const file = path.join(dir, 'storage.json');
    const { setStorageFilePathForTest, saveViewerStorage } = await import('@server/storage');
    setStorageFilePathForTest(file);
    t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
    saveViewerStorage({ githubPat: 'fake_original_pat' });
    const before = fs.readFileSync(file);
    await assert.rejects(handleIpcCommand('save_viewer_storage', { payload: { [key]: 'fake_submitted_pat', projects: {} } }),
      (error: Error) => error.message === 'Protected storage key');
    assert.deepEqual(fs.readFileSync(file), before);
  });
}

test('T1 S1.1: SSE storage updates expose status but not saved PAT', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-github-sse-'));
  const { setStorageFilePathForTest, saveViewerStorage } = await import('@server/storage');
  const { addSseClient, removeSseClient } = await import('@server/bridge/sse');
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  const chunks: string[] = [];
  const client = { write: (chunk: string) => chunks.push(chunk) } as any;
  addSseClient(client);
  t.after(() => { removeSseClient(client); setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  saveViewerStorage({ githubPat: 'fake_sse_pat' });
  assert.equal(chunks.length, 1);
  const event = JSON.parse(chunks[0].slice(6));
  assert.equal(event.event, 'viewer://storage_updated');
  assert.equal(event.payload.githubPatConfigured, true);
  assert.equal(chunks[0].includes('fake_sse_pat'), false);
  assert.equal(chunks[0].includes(Buffer.from('fake_sse_pat').toString('base64')), false);
});

for (const action of ['empty-status', 'configured-status', 'save', 'replace', 'clear'] as const) {
  test(`T1 S1.3: explicit credential ${action} returns only status and changes requested state`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-github-credential-'));
    const { setStorageFilePathForTest, saveViewerStorage, loadViewerStorage } = await import('@server/storage');
    setStorageFilePathForTest(path.join(dir, 'storage.json'));
    t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
    if (action !== 'empty-status' && action !== 'save') saveViewerStorage({ githubPat: 'fake_first_pat' });
    const cmd = action.endsWith('status') ? 'get_github_credential_status' : action === 'clear' ? 'clear_github_credential' : 'save_github_credential';
    const result = await handleIpcCommand(cmd, action === 'save' || action === 'replace' ? { payload: { token: 'fake_second_pat' } } : {});
    const expected = action !== 'empty-status' && action !== 'clear';
    assert.deepEqual(result, { configured: expected });
    const stored = loadViewerStorage().githubPat;
    if (action === 'save' || action === 'replace') assert.equal(stored, 'fake_second_pat');
    else if (action === 'configured-status') assert.equal(stored, 'fake_first_pat');
    else assert.ok(!stored);
  });
}

test('T1 S2.2: credential import preserves existing backend PAT and returns status only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-github-import-'));
  const { setStorageFilePathForTest, saveViewerStorage, loadViewerStorage } = await import('@server/storage');
  setStorageFilePathForTest(path.join(dir, 'storage.json'));
  t.after(() => { setStorageFilePathForTest(null); fs.rmSync(dir, { recursive: true, force: true }); });
  saveViewerStorage({ githubPat: 'fake_backend_pat' });
  const result = await handleIpcCommand('import_github_credential', { payload: { token: 'fake_legacy_pat' } });
  assert.deepEqual(result, { configured: true });
  assert.equal(loadViewerStorage().githubPat, 'fake_backend_pat');
});

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

