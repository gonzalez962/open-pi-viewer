import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { setStorageFilePathForTest } from '@server/storage';
import {
  getOrCreatePiRpc,
  handleIpcCommand,
  resetPiRpcForTest,
  setPiAgentDirForTest,
  setSessionsRootDirForTest,
  setSubprocessSpawnerForTest,
} from '@server/web-ipc-bridge';

type CatalogReply = { success: true; data: { models: unknown[] } } | { success: false; error: string };

class FakePi extends EventEmitter {
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: string[] = [];

  constructor(file: string, catalog: CatalogReply) {
    super();
    this.stdin.on('data', (chunk) => {
      const command = JSON.parse(chunk.toString());
      this.commands.push(command.type);
      const reply = command.type === 'get_available_models' ? catalog : {
        success: true,
        data: { sessionId: path.basename(file), sessionFile: file },
      };
      this.stdout.write(JSON.stringify({ type: 'response', id: command.id, ...reply }) + '\n');
    });
  }

  kill() {
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

function fixture(t: TestContext, catalog: CatalogReply) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-model-catalog-'));
  const modelsPath = path.join(root, 'models.json');
  const modelsJson = JSON.stringify({ providers: { saved: { models: [{ id: 'offline-model' }] } } });
  const children: FakePi[] = [];
  setPiAgentDirForTest(root);
  setSessionsRootDirForTest(root);
  setStorageFilePathForTest(path.join(root, 'viewer.json'));
  setSubprocessSpawnerForTest((_cmd, args) => {
    const child = new FakePi(args[args.indexOf('--session') + 1], catalog);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  t.after(() => {
    resetPiRpcForTest();
    setSubprocessSpawnerForTest(null);
    setStorageFilePathForTest(null);
    setSessionsRootDirForTest(null);
    setPiAgentDirForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(modelsPath, modelsJson);

  async function connect() {
    const sessionFile = path.join(root, 'session.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'session', cwd: root }) + '\n');
    await handleIpcCommand('connect', { payload: { workingDirectory: root, sessionFile } });
    await getOrCreatePiRpc(root, sessionFile); // Wait for the connection's background handshake.
  }

  return { children, connect, assertConfigUnchanged: () => assert.equal(fs.readFileSync(modelsPath, 'utf8'), modelsJson) };
}

const listModels = () => handleIpcCommand('get_available_models');

test('web model catalog returns the live Pi catalog without exposing provider connection data', async (t) => {
  const model = {
    id: 'runtime-only', name: 'Runtime model', provider: 'extension',
    input: ['text', 'image'], reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' },
    contextWindow: 128_000, maxTokens: 8192,
  };
  const f = fixture(t, {
    success: true,
    data: { models: [{ ...model, headers: { Authorization: 'fixture-secret' }, baseUrl: 'https://internal.example.test', apiKey: 'fixture-key' }] },
  });
  await f.connect();

  assert.deepEqual(await listModels(), { models: [model] });
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].commands, ['get_state', 'get_available_models']);
  f.assertConfigUnchanged();
});

test('web model catalog propagates a live Pi RPC error instead of returning the offline catalog', async (t) => {
  const f = fixture(t, { success: false, error: 'Runtime catalog unavailable' });
  await f.connect();

  await assert.rejects(listModels, { message: 'Pi get_available_models failed: Runtime catalog unavailable' });
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].commands, ['get_state', 'get_available_models']);
  f.assertConfigUnchanged();
});

test('web model catalog preserves the offline list without spawning, even after Pi exits', async (t) => {
  const f = fixture(t, { success: true, data: { models: [] } });

  const offline = await listModels();
  assert.ok(Array.isArray(offline));
  assert.deepEqual(offline.map(({ provider, id }) => [provider, id]), [
    ['saved', 'offline-model'], ['openai-codex', 'gpt-5.5'], ['openai-codex', 'gpt-5'],
  ]);
  assert.equal(f.children.length, 0);

  await f.connect();
  f.children[0].kill();
  assert.deepEqual(await listModels(), offline);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].commands, ['get_state']);
  f.assertConfigUnchanged();
});
