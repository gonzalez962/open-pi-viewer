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

test('S1.2 worktree roots and non-Git cwd isolate published routing', async () => {
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
  assert.equal(new Set([a, b, c]).size, 3);
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

test('S2.1 global activation retains its original storage and response', async () => {
  resetStore(); const before = fs.readFileSync(storePath, 'utf8');
  const result = await handleIpcCommand('set_active_sdd_profile', { name: ' global ', scope: 'global' });
  assert.deepEqual(result, { success: true, message: "Profile ' global ' activated globally" });
  assert.equal(fs.readFileSync(path.join(profiles, '.active'), 'utf8'), 'global\n');
  assert.equal(fs.readFileSync(storePath, 'utf8'), before);
});
