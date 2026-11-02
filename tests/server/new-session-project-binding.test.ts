import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleIpcCommand, setSessionsRootDirForTest, setSubprocessSpawnerForTest, resetPiRpcForTest, resolveSessionsDir } from '@server/web-ipc-bridge';
import { setActiveCwd, getActiveCwd, getActiveSessionFile, getActiveSessionId, setActiveSessionFile, setActiveSessionId } from '@server/bridge/state';
import { piRpc } from '@server/bridge/rpc';

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-session-binding-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(sessions);
  const previous = { cwd: getActiveCwd(), file: getActiveSessionFile(), id: getActiveSessionId() };
  const warmup = piRpc.ensureRunning;
  piRpc.ensureRunning = async () => {};
  setSessionsRootDirForTest(sessions);
  setSubprocessSpawnerForTest(() => null);
  setActiveCwd(b); setActiveSessionFile('existing-file'); setActiveSessionId('existing-id');
  t.after(() => {
    resetPiRpcForTest(); piRpc.ensureRunning = warmup;
    setSessionsRootDirForTest(null); setSubprocessSpawnerForTest(null);
    setActiveCwd(previous.cwd); setActiveSessionFile(previous.file); setActiveSessionId(previous.id);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, a, b, sessions };
}

test('S1.1 new_session uses requesting project despite global project B', async (t) => {
  const f = fixture(t);
  const result = await handleIpcCommand('new_session', { payload: { workingDirectory: f.a } });
  assert.equal(path.dirname(result.sessionFile), resolveSessionsDir(f.a));
  assert.equal(JSON.parse(fs.readFileSync(result.sessionFile, 'utf8').split('\n')[0]).cwd, f.a);
  assert.equal((await handleIpcCommand('list_sessions', { payload: { workingDirectory: f.a } }))[0].id, result.sessionId);
  assert.deepEqual(await handleIpcCommand('list_sessions', { payload: { workingDirectory: f.b } }), []);
});

test('S1.2 invalid requested project rejects before creating records or changing active session', async (t) => {
  const f = fixture(t);
  const before = await handleIpcCommand('get_session_persistence_status');
  const files = fs.readdirSync(f.sessions);
  let failure: unknown;
  try { await handleIpcCommand('new_session', { payload: { workingDirectory: path.join(f.root, 'missing') } }); } catch (error) { failure = error; }
  assert.deepEqual(fs.readdirSync(f.sessions), files);
  assert.deepEqual(await handleIpcCommand('get_session_persistence_status'), before);
  assert.ok(failure instanceof Error, 'invalid directory must reject');
});

test('S3.2 public prompt rejects another project session with exact error', async (t) => {
  const f = fixture(t);
  const file = path.join(f.sessions, 'other.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'b', cwd: f.b }) + '\n');
  const before = await handleIpcCommand('get_session_persistence_status');
  const content = fs.readFileSync(file, 'utf8');
  await assert.rejects(handleIpcCommand('send_prompt', { payload: { cwd: f.a, sessionFile: file, id: 'prompt-test', message: 'hello' } }), { message: 'Session does not belong to project' });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(await handleIpcCommand('get_session_persistence_status'), before);
});
