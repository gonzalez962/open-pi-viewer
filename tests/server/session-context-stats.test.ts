import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleIpcCommand, setSessionsRootDirForTest } from '@server/web-ipc-bridge';
import { piRpc } from '@server/bridge/rpc';

test('S1.4 stats request for a previously used session does not read the unrelated active session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-context-'));
  const a = path.join(root, 'a.jsonl');
  const b = path.join(root, 'b.jsonl');
  const writeSession = (file: string, id: string, input: number) => fs.writeFileSync(file,
    JSON.stringify({ type: 'session', id }) + '\n' +
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input, output: 1 } } }) + '\n');
  writeSession(a, 'a', 1200);
  writeSession(b, 'b', 2300);
  const oldFile = piRpc.sessionFile;
  const oldId = piRpc.sessionId;
  setSessionsRootDirForTest(root);
  piRpc.sessionFile = b;
  piRpc.sessionId = 'b';
  t.after(() => {
    piRpc.sessionFile = oldFile;
    piRpc.sessionId = oldId;
    setSessionsRootDirForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const stats = await handleIpcCommand('get_session_stats', { payload: { sessionFile: a } });
  assert.equal(stats.sessionId, 'a');
  assert.equal(stats.contextUsage.tokens, 1200);
  assert.equal(piRpc.sessionFile, b);
});
