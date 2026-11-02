import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleConnect, handleSwitchSession } from '@server/bridge/sessions';
import { piRpc, sessionPool } from '@server/bridge/rpc';
import { setActiveCwd, sessionParseCache } from '@server/bridge/state';

const cwd = path.resolve('todo-fixture-project');
const file = path.join(cwd, 'a.jsonl');
const otherFile = path.join(cwd, 'b.jsonl');
const tasks = [{ id: 1, title: 'Older plan', status: 'in_progress' }];
const todo = { tasks, nextId: 2, updatedTurn: 1 };
const result = (value: unknown, isError = false) => ({
  role: 'toolResult', toolName: 'todo', toolCallId: 'todo-1',
  content: [{ type: 'text', text: 'todo result' }], details: { gentleTodo: value }, isError,
});
const recent = Array.from({ length: 90 }, (_, i) => ({ role: 'user', id: `recent-${i}`, content: `Message ${i}`, timestamp: i + 1 }));
const messages = [result(todo), result({ tasks: [{ id: 2, title: 'Failed', status: 'done' }], nextId: 3, updatedTurn: 2 }, true), ...recent];

function fixture(t: import('node:test').TestContext) {
  const files = new Map([[file, messages], [otherFile, recent]]);
  t.mock.method(fs, 'existsSync', (p: fs.PathLike) => files.has(String(p)));
  t.mock.method(fs, 'statSync', (() => ({ mtimeMs: 1, size: 100, mtime: new Date(0) })) as typeof fs.statSync);
  t.mock.method(fs, 'readFileSync', ((p: fs.PathOrFileDescriptor) => {
    const entries = files.get(String(p));
    if (!entries) throw new Error('unexpected file');
    return [JSON.stringify({ type: 'session', id: p === file ? 'a' : 'b', cwd }), ...entries.map((message, i) => JSON.stringify({ type: 'message', id: `entry-${i}`, message }))].join('\n');
  }) as typeof fs.readFileSync);
  t.mock.method(piRpc, 'ensureRunning', async () => {});
  setActiveCwd(cwd);
  for (const [sessionFile, history] of files) {
    sessionPool.set(path.resolve(sessionFile), {
      isAlive: () => true,
      snapshot: async () => ({ messages: history, activity: 'idle', pendingExtensionPrompts: [] }),
    } as any);
  }
  t.after(() => {
    sessionPool.delete(path.resolve(file));
    sessionPool.delete(path.resolve(otherFile));
    sessionParseCache.delete(file);
    sessionParseCache.delete(otherFile);
  });
}

test('S1.2 connect reattachment restores an older successful todo outside the 80-message window', async t => {
  fixture(t);
  const response = await handleConnect({ payload: { workingDirectory: cwd, sessionFile: file } });
  assert.equal(response.sessionId, 'a');
  assert.equal(response.hasMore, true);
  assert.deepEqual(response.messages, recent.slice(-80));
  assert.deepEqual((response as any).todo, todo);
});

test('S1.2 switching restores an older successful todo outside the 60-message window without leaking to another session', t => {
  fixture(t);
  const response = handleSwitchSession({ payload: { sessionPath: file } });
  assert.equal(response.sessionId, 'a');
  assert.equal(response.hasMore, true);
  assert.deepEqual(response.messages.map((message: any) => message.id), recent.slice(-60).map(message => message.id));
  assert.deepEqual((response as any).todo, todo);
  const other = handleSwitchSession({ payload: { sessionPath: otherFile } });
  assert.equal(other.sessionId, 'b');
  assert.ok(!(other as any).todo);
});

test('PRESERVE ordinary session switch retains bounded history and loadAll behavior without todo', t => {
  fixture(t);
  const bounded = handleSwitchSession({ payload: { sessionPath: otherFile } });
  assert.equal(bounded.hasMore, true);
  assert.deepEqual(bounded.messages.map((message: any) => message.id), recent.slice(-60).map(message => message.id));
  const all = handleSwitchSession({ payload: { sessionPath: otherFile, loadAll: true } });
  assert.equal(all.hasMore, false);
  assert.deepEqual(all.messages.map((message: any) => message.id), recent.map(message => message.id));
});
