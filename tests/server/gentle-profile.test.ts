import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// sdd.ts captures HOME at import time. Isolate it before importing the real IPC handler.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-profile-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GENTLE_PI_CONFIG_HOME = path.join(home, 'gentle-config');
delete process.env.GENTLE_SHELL_PREFIX;
const { handleIpcCommand } = await import('@server/web-ipc-bridge');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const agent = path.join(home, '.pi', 'agent');
const profiles = path.join(agent, 'profiles');
const storePath = path.join(home, 'gentle-config', 'profiles.json');
const initialStore = { kind: 'gentle-pi.agent_model_profiles', version: 1, active: 'existing', profiles: { existing: { reviewer: { model: 'vendor/old', thinking: 'low' } } } };
const declarationPath = (root: string) => path.join(root, '.pi', 'gentle-ai', 'profile.json');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function put(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function resetStore() { put(storePath, initialStore); }
function profile(id: string, model = 'vendor/model', effort = 'high') {
  put(path.join(profiles, `${id}.json`), { id, name: id, model_profiles: { worker: { model, effort } } });
}
async function activate(name: string, cwd: string) {
  return await handleIpcCommand('set_active_sdd_profile', { name, scope: 'project', cwd }) as any;
}
async function failure(name: string, cwd: string): Promise<string> {
  let result: any;
  try {
    result = await activate(name, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(message, 'failure must have a message');
    return message;
  }
  assert.equal(result?.success, false, 'activation must report failure');
  assert.ok(result.message, 'failure must have a message');
  assert.doesNotMatch(result.message, /activated successfully|activation successful/i);
  return result.message;
}
const selectionPath = path.join(profiles, 'projects-active.json');
function declaration(root: string) {
  const pin = readJson(declarationPath(root));
  assert.equal(pin.kind, 'gentle-pi.agent_model_profile_pin');
  assert.equal(pin.version, 1);
  assert.match(pin.profile, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  return pin.profile as string;
}

test('S1.5 discovery uses requested cwd and quoted frontmatter identity for activation', async () => {
  const requested = path.join(home, 'discovery-requested');
  const active = path.join(home, 'discovery-active');
  fs.mkdirSync(requested); fs.mkdirSync(active);
  put(path.join(active, '.pi', 'agents', 'active-only.md'), '---\nname: active-only\n---\nActive instructions');
  put(path.join(requested, '.pi', 'agents', 'filename.md'), '---\nname: "actual-worker"\ndescription: Requested agent\n---\nInstructions');
  const state = await import('@server/bridge/state');
  const original = state.getActiveCwd();
  state.setActiveCwd(active);
  try {
    const result: any = await handleIpcCommand('get_sdd_profiles', { cwd: requested });
    assert.ok(result.allAgents.includes('actual-worker'));
    assert.equal(result.agentMeta['actual-worker'].id, 'actual-worker');
    assert.equal(result.allAgents.includes('filename'), false);
    assert.equal(result.allAgents.includes('active-only'), false);
    resetStore();
    put(path.join(profiles, 'discovery.json'), { id: 'discovery', name: 'discovery', model_profiles: { 'actual-worker': { model: 'vendor/model', effort: 'high' } } });
    assert.equal((await activate('discovery', requested)).success, true);
    assert.deepEqual(readJson(storePath).profiles[declaration(requested)]['actual-worker'], { model: 'vendor/model', thinking: 'high' });
  } finally { state.setActiveCwd(original); }
});

test('S1.5 consumer directory precedence and filename fallback preserve discovery', async () => {
  const root = path.join(home, 'discovery-precedence'); fs.mkdirSync(root);
  put(path.join(agent, 'agents', 'one.md'), '---\nname: shared-agent\ndescription: global agent\n---\nInstructions');
  put(path.join(agent, 'subagents', 'two.md'), '---\nname: shared-agent\ndescription: global subagent\n---\nInstructions');
  put(path.join(root, '.pi', 'agents', 'three.md'), '---\nname: shared-agent\ndescription: project agent\n---\nInstructions');
  put(path.join(root, '.pi', 'subagents', 'four.md'), "---\nname: 'shared-agent'\ndescription: project subagent\n---\nInstructions");
  put(path.join(root, '.pi', 'agents', 'fallback.md'), 'Instructions without frontmatter');
  const result: any = await handleIpcCommand('get_sdd_profiles', { cwd: root });
  assert.equal(result.agentMeta['shared-agent'].description, 'project subagent');
  assert.equal(result.agentMeta.fallback.id, 'fallback');
  assert.equal(result.allAgents.filter((name: string) => name === 'shared-agent').length, 1);
});

test('S1.1 project activation publishes routing without changing existing selection', async () => {
  resetStore(); profile('first');
  const root = path.join(home, 'project-one'); fs.mkdirSync(root);
  const result = await activate('first', root);
  assert.equal(result.success, true);
  const name = declaration(root);
  const store = readJson(storePath);
  assert.equal(store.active, 'existing');
  assert.deepEqual(store.profiles.existing, initialStore.profiles.existing);
  assert.deepEqual(store.profiles[name].worker, { model: 'vendor/model', thinking: 'high' });
});

test('S1.2 worktree roots and non-Git cwd share identities by profile ID', async () => {
  resetStore(); profile('a', 'vendor/a', 'low'); profile('b', 'vendor/b', 'medium');
  const repo = path.join(home, 'repo'); const worktree = path.join(home, 'worktree');
  fs.mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'second', worktree]);
  const nested = path.join(worktree, 'nested'); fs.mkdirSync(nested);
  const plain = path.join(home, 'plain'); fs.mkdirSync(plain);
  await activate('a', repo); await activate('b', nested); await activate('a', plain);
  const a = declaration(repo); const b = declaration(worktree); const c = declaration(plain);
  assert.equal(fs.existsSync(declarationPath(nested)), false);
  assert.equal(a, c);
  assert.notEqual(a, b);
  const store = readJson(storePath);
  assert.deepEqual(store.profiles[a].worker, { model: 'vendor/a', thinking: 'low' });
  assert.deepEqual(store.profiles[b].worker, { model: 'vendor/b', thinking: 'medium' });
  assert.deepEqual(store.profiles[c].worker, { model: 'vendor/a', thinking: 'low' });
});

for (const [label, badStore] of [
  ['malformed JSON', '{bad'],
  ['unsupported version', JSON.stringify({ ...initialStore, version: 99 })],
] as const) {
  test(`S1.3 ${label} store fails without changing files or viewer selection`, async () => {
    const root = path.join(home, `invalid-store-${label.replace(' ', '-')}`); fs.mkdirSync(root);
    profile('valid'); put(storePath, badStore);
    const pin = declarationPath(root); const oldPin = '{"foreign":true}'; put(pin, oldPin);
    const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
    await failure('valid', root);
    assert.equal(fs.readFileSync(storePath, 'utf8'), badStore);
    assert.equal(fs.readFileSync(pin, 'utf8'), oldPin);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
  });
}

test('S1.3 ambiguous bundled prefix fails before any publication or selection write', async () => {
  const root = path.join(home, 'ambiguous-prefix'); fs.mkdirSync(root);
  profile('prefix'); resetStore();
  const before = fs.readFileSync(storePath, 'utf8');
  const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
  process.env.GENTLE_SHELL_PREFIX = path.join(home, 'unverified-prefix');
  try {
    const message = await failure('prefix', root);
    assert.match(message, /bundled|prefix/i);
    assert.equal(fs.readFileSync(storePath, 'utf8'), before);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
    assert.equal(fs.existsSync(declarationPath(root)), false);
  } finally { delete process.env.GENTLE_SHELL_PREFIX; }
});

test('S1.3 invalid routing fails without changing files or viewer selection', async () => {
  const root = path.join(home, 'invalid-routing'); fs.mkdirSync(root); profile('bad', 'bad model');
  const pin = declarationPath(root); const oldPin = '{"foreign":true}'; put(pin, oldPin);
  const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
  resetStore(); const before = fs.readFileSync(storePath, 'utf8');
  await failure('bad', root);
  assert.equal(fs.readFileSync(storePath, 'utf8'), before);
  assert.equal(fs.readFileSync(pin, 'utf8'), oldPin);
  assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
});

for (const [label, value] of [['null', null], ['false', false], ['zero', 0], ['empty-string', '']] as const) {
  test(`S1.3 ${label} raw routing is rejected without writes`, async () => {
    const root = path.join(home, `raw-${label}`); fs.mkdirSync(root);
    const source = path.join(profiles, `raw-${label}.json`);
    put(source, { id: `raw-${label}`, name: `raw-${label}`, model_profiles: value });
    resetStore(); const store = fs.readFileSync(storePath, 'utf8');
    const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
    const pin = declarationPath(root); put(pin, '{"old":true}');
    await failure(`raw-${label}`, root);
    assert.equal(fs.readFileSync(storePath, 'utf8'), store);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
    assert.equal(fs.readFileSync(pin, 'utf8'), '{"old":true}');
  });
}

for (const [label, invalid] of [
  ['profile', { existing: null }],
  ['agent', { existing: { worker: false } }],
  ['active', { existing: { worker: 'vendor/model' } }],
] as const) {
  test(`S1.3 invalid nested store ${label} is rejected without writes`, async () => {
    const root = path.join(home, `store-${label}`); fs.mkdirSync(root); profile(`store-${label}`);
    const store = JSON.stringify({ ...initialStore, active: label === 'active' ? 'missing' : 'existing', profiles: invalid });
    put(storePath, store);
    const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
    const pin = declarationPath(root); put(pin, '{"old":true}');
    await failure(`store-${label}`, root);
    assert.equal(fs.readFileSync(storePath, 'utf8'), store);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
    assert.equal(fs.readFileSync(pin, 'utf8'), '{"old":true}');
  });
}

test('S1.3 valid Gentle routing and unknown store fields survive publication', async () => {
  const root = path.join(home, 'store-valid'); fs.mkdirSync(root); profile('store-valid');
  const store = { ...initialStore, extra: { keep: true }, profiles: { existing: { worker: { effort: 'max', tier: 'fast', extra: 42 }, other: 'vendor/model', inherit: {} } } };
  put(storePath, store);
  assert.equal((await activate('store-valid', root)).success, true);
  const after = readJson(storePath);
  assert.equal(after.active, 'existing');
  assert.deepEqual(after.extra, store.extra);
  assert.deepEqual(after.profiles.existing, store.profiles.existing);
});

test('S1.3 declaration write failure reports partial publication rather than success', async () => {
  resetStore(); profile('write-failure');
  const root = path.join(home, 'write-failure'); fs.mkdirSync(root);
  put(path.join(root, '.pi'), 'blocking file');
  const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
  const message = await failure('write-failure', root);
  assert.match(message, /publish|declar|partial/i);
  assert.doesNotMatch(message, /activated successfully|activation successful/i);
  assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
  assert.equal(fs.readFileSync(path.join(root, '.pi'), 'utf8'), 'blocking file');
  assert.deepEqual(readJson(storePath).profiles.existing, initialStore.profiles.existing);
});

test('S1.4 concurrent activations preserve both entries and the clone pin', async () => {
  resetStore(); profile('concurrent-a', 'vendor/a'); profile('concurrent-b', 'vendor/b');
  const a = path.join(home, 'concurrent-a'); const b = path.join(home, 'concurrent-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  execFileSync('git', ['init', '-q', a]);
  const clonePin = path.join(a, '.git', 'gentle-ai', 'profile-pin.json');
  const oldPin = JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'existing' });
  put(clonePin, oldPin);
  // Simultaneous requests exercise the public API; synchronous handlers may serialize
  // before Promise.all receives them, so this does not force an interleaving.
  await Promise.all([activate('concurrent-a', a), activate('concurrent-b', b)]);
  const store = readJson(storePath);
  assert.equal(store.profiles[declaration(a)].worker.model, 'vendor/a');
  assert.equal(store.profiles[declaration(b)].worker.model, 'vendor/b');
  assert.deepEqual(store.profiles.existing, initialStore.profiles.existing);
  assert.equal(fs.readFileSync(clonePin, 'utf8'), oldPin);
});

test('S2.1 project result describes declaration and existing-session limitation', async () => {
  resetStore(); profile('feedback'); const root = path.join(home, 'feedback'); fs.mkdirSync(root);
  const result = await activate('feedback', root);
  assert.equal(result.success, true);
  assert.match(result.message, /declar/i);
  assert.match(result.message, /session|sesión/i);
});

test('S2.2 missing project cwd rejects activation without changing stored selection or Gentle files', async () => {
  const root = path.join(home, 'missing-cwd'); fs.mkdirSync(root);
  const state = await import('@server/bridge/state');
  const previous = state.getActiveCwd();
  state.setActiveCwd(root);
  profile('missing-cwd'); resetStore();
  const store = fs.readFileSync(storePath, 'utf8');
  const selected = JSON.stringify({ [root]: 'previous' }); put(selectionPath, selected);
  try {
    let result: any;
    try { result = await handleIpcCommand('set_active_sdd_profile', { name: 'missing-cwd', scope: 'project' }); }
    catch (error) { result = { success: false, message: String(error) }; }
    assert.equal(result?.success, false);
    assert.match(result.message, /cwd|directory|project/i);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
    assert.equal(fs.readFileSync(storePath, 'utf8'), store);
    assert.equal(fs.existsSync(declarationPath(root)), false);
  } finally { state.setActiveCwd(previous); }
});

test('S3.1 S4.1 saving renamed stable ID updates the shared entry without rewriting declarations', async () => {
  resetStore(); profile('edit', 'vendor/old', 'low');
  const a = path.join(home, 'edit-a'); const b = path.join(home, 'edit-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  await activate('edit', a); await activate('edit', b);
  const oldA = fs.readFileSync(declarationPath(a), 'utf8');
  const oldB = fs.readFileSync(declarationPath(b), 'utf8');
  const oldNameA = declaration(a); const oldNameB = declaration(b);
  const selection = fs.readFileSync(selectionPath, 'utf8');
  const result: any = await handleIpcCommand('save_sdd_profile', { cwd: a, scope: 'global', profile: { id: 'edit', name: 'Renamed', model_profiles: { worker: { model: 'vendor/new', effort: 'max' } } } });
  assert.equal(result.success, true);
  assert.equal(result.profile.id, 'edit');
  assert.equal(result.profile.name, 'Renamed');
  const store = readJson(storePath);
  assert.equal(declaration(a), oldNameA);
  assert.equal(oldNameA, oldNameB);
  assert.deepEqual(store.profiles[oldNameB].worker, { model: 'vendor/new', thinking: 'max' });
  assert.equal(fs.readFileSync(declarationPath(a), 'utf8'), oldA);
  assert.equal(fs.readFileSync(declarationPath(b), 'utf8'), oldB);
  assert.equal(store.active, 'existing');
  assert.deepEqual(store.profiles.existing, initialStore.profiles.existing);
  assert.equal(fs.readFileSync(selectionPath, 'utf8'), selection);
});

test('S3.1 legacy name selection follows a stable ID rename without reselection', async () => {
  resetStore(); profile('legacy-id');
  const root = path.join(home, 'legacy-edit'); fs.mkdirSync(root);
  await activate('legacy-id', root);
  put(selectionPath, JSON.stringify({ [root]: 'legacy-id' }));
  const source = path.join(profiles, 'legacy-id.json');
  put(source, { id: 'legacy-id', name: 'Old Name', model_profiles: { worker: { model: 'vendor/old' } } });
  put(selectionPath, JSON.stringify({ [root]: 'Old Name' }));
  const result: any = await handleIpcCommand('save_sdd_profile', { cwd: root, profile: { id: 'legacy-id', name: 'New Name', model_profiles: { worker: { model: 'vendor/renamed', effort: 'medium' } } } });
  assert.equal(result.success, true);
  assert.deepEqual(readJson(storePath).profiles[declaration(root)].worker, { model: 'vendor/renamed', thinking: 'medium' });
  const listed: any = await handleIpcCommand('get_sdd_profiles', { cwd: root });
  assert.equal(listed.projectActiveProfile, 'legacy-id');
});

test('S3.2 never-published inactive, new and duplicate profiles do not publish', async () => {
  resetStore(); profile('selected-save'); profile('inactive-save');
  const a = path.join(home, 'save-inactive'); const b = path.join(home, 'save-unselected');
  fs.mkdirSync(a); fs.mkdirSync(b); await activate('selected-save', a);
  const store = fs.readFileSync(storePath, 'utf8');
  const pin = fs.readFileSync(declarationPath(a), 'utf8');
  const selection = fs.readFileSync(selectionPath, 'utf8');
  for (const args of [
    { cwd: a, profile: { id: 'inactive-save', name: 'inactive-save', model_profiles: { worker: { model: 'vendor/inactive' } } } },
    { cwd: a, profile: { name: 'new-profile', model_profiles: { worker: { model: 'vendor/new' } } } },
    { cwd: a, profile: { name: 'selected-save-copy', model_profiles: { worker: { model: 'vendor/copy' } } } },
  ]) {
    const result: any = await handleIpcCommand('save_sdd_profile', { scope: 'global', ...args });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(storePath, 'utf8'), store);
    assert.equal(fs.readFileSync(declarationPath(a), 'utf8'), pin);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selection);
    assert.equal(fs.existsSync(declarationPath(b)), false);
  }
});

for (const withCwd of [true, false]) {
  test(`S3.1 S3.2 previously published profile updates from ${withCwd ? 'unrelated cwd' : 'no cwd'}`, async () => {
    resetStore(); profile(`shared-${withCwd}`, 'vendor/old', 'low');
    const a = path.join(home, `shared-a-${withCwd}`); const b = path.join(home, `shared-b-${withCwd}`);
    fs.mkdirSync(a); fs.mkdirSync(b); await activate(`shared-${withCwd}`, a);
    const pin = fs.readFileSync(declarationPath(a), 'utf8'); const name = declaration(a);
    const selection = fs.readFileSync(selectionPath, 'utf8');
    const result: any = await handleIpcCommand('save_sdd_profile', { ...(withCwd ? { cwd: b } : {}), profile: { id: `shared-${withCwd}`, name: 'Renamed', model_profiles: { worker: { model: 'vendor/updated', effort: 'high' } } } });
    assert.equal(result.success, true);
    assert.deepEqual(readJson(storePath).profiles[name].worker, { model: 'vendor/updated', thinking: 'high' });
    assert.equal(fs.readFileSync(declarationPath(a), 'utf8'), pin);
    assert.equal(fs.readFileSync(selectionPath, 'utf8'), selection);
    assert.equal(fs.existsSync(declarationPath(b)), false);
  });
}

test('S4.2 unowned collision refuses overwrite even when routing initially matches', async () => {
  resetStore(); profile('collision');
  const a = path.join(home, 'collision-a'); const b = path.join(home, 'collision-b'); fs.mkdirSync(a); fs.mkdirSync(b);
  await activate('collision', a);
  const name = declaration(a); const current = readJson(storePath);
  // Rebuild a valid foreign store with the observed entry but no ownership metadata.
  const foreign = { kind: current.kind, version: current.version, active: current.active, profiles: current.profiles };
  put(storePath, foreign);
  const before = fs.readFileSync(storePath, 'utf8');
  const selected = fs.readFileSync(selectionPath, 'utf8');
  await failure('collision', b);
  assert.equal(fs.readFileSync(storePath, 'utf8'), before);
  assert.ok(readJson(storePath).profiles[name]);
  assert.equal(fs.readFileSync(selectionPath, 'utf8'), selected);
  assert.equal(fs.existsSync(declarationPath(b)), false);
});

test('S4.2 legacy file identity migrates only selected declaration and keeps old entry', async () => {
  resetStore(); const a = path.join(home, 'legacy-migrate-a'); const b = path.join(home, 'legacy-migrate-b'); fs.mkdirSync(a); fs.mkdirSync(b);
  put(path.join(profiles, 'legacy-file.json'), { name: 'Legacy Profile', model_profiles: { worker: { model: 'vendor/legacy', effort: 'low' } } });
  const oldStore = { ...initialStore, profiles: { ...initialStore.profiles, 'old-content-hash': { worker: { model: 'vendor/legacy', thinking: 'low' } } } };
  put(storePath, oldStore);
  const oldPin = JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'old-content-hash' });
  put(declarationPath(a), oldPin); put(declarationPath(b), oldPin);
  await activate('legacy-file', a);
  const name = declaration(a);
  assert.notEqual(name, 'old-content-hash');
  assert.equal(fs.readFileSync(declarationPath(b), 'utf8'), oldPin);
  assert.deepEqual(readJson(storePath).profiles['old-content-hash'], oldStore.profiles['old-content-hash']);
  await activate('legacy-file', b);
  assert.equal(declaration(b), name);
});

test('S3.3 publication failure reports saved profile and unchanged declaration', async () => {
  resetStore(); profile('save-fail'); const root = path.join(home, 'save-fail'); fs.mkdirSync(root);
  await activate('save-fail', root);
  const pin = fs.readFileSync(declarationPath(root), 'utf8');
  const selection = fs.readFileSync(selectionPath, 'utf8');
  const malformed = '{invalid'; put(storePath, malformed);
  let result: any;
  try {
    result = await handleIpcCommand('save_sdd_profile', { cwd: root, scope: 'global', profile: { id: 'save-fail', name: 'save-fail', model_profiles: { worker: { model: 'vendor/new', effort: 'low' } } } });
  } catch (error) { result = { success: false, message: String(error) }; }
  assert.equal(result.success, false);
  assert.match(result.message, /sav|persist/i);
  assert.match(result.message, /publish|sync|gentle/i);
  assert.equal(readJson(path.join(profiles, 'save-fail.json')).model_profiles.worker.model, 'vendor/new');
  assert.equal(fs.readFileSync(storePath, 'utf8'), malformed);
  assert.equal(fs.readFileSync(declarationPath(root), 'utf8'), pin);
  assert.equal(fs.readFileSync(selectionPath, 'utf8'), selection);
});

test('S2.1 global activation retains its original storage and response', async () => {
  resetStore(); const before = fs.readFileSync(storePath, 'utf8');
  const result = await handleIpcCommand('set_active_sdd_profile', { name: ' global ', scope: 'global' });
  assert.deepEqual(result, { success: true, message: "Profile ' global ' activated globally" });
  assert.equal(fs.readFileSync(path.join(profiles, '.active'), 'utf8'), 'global\n');
  assert.equal(fs.readFileSync(storePath, 'utf8'), before);
});
