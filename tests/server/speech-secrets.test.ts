import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handleIpcCommand } from '@server/web-ipc-bridge';
import { setStorageFilePathForTest } from '@server/storage';

// IPC contract: save_voice_credential {provider, endpoint, apiKey},
// get_voice_credential_status {provider, endpoint}, clear_voice_credential
// {provider, endpoint}. Each returns only {configured: boolean}. Credentials
// are scoped to the exact provider and endpoint and never sent back to clients.
const endpoint = 'https://voice.example/v1';
const otherEndpoint = 'https://other.example/v1';
const key = 'voice-test-secret';

async function isolated(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-secret-ipc-'));
  const previous = process.env.PI_VIEWER_CONFIG_PATH;
  process.env.PI_VIEWER_CONFIG_PATH = path.join(dir, 'viewer.json');
  setStorageFilePathForTest(path.join(dir, 'viewer.json'));
  t.after(() => {
    setStorageFilePathForTest(null);
    if (previous === undefined) delete process.env.PI_VIEWER_CONFIG_PATH;
    else process.env.PI_VIEWER_CONFIG_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const save = (provider: string, url: string, apiKey: string) =>
  handleIpcCommand('save_voice_credential', { provider, endpoint: url, apiKey });
const status = (provider: string, url: string) =>
  handleIpcCommand('get_voice_credential_status', { provider, endpoint: url });
const clear = (provider: string, url: string) =>
  handleIpcCommand('clear_voice_credential', { provider, endpoint: url });

test('S1.1 invalid endpoints never echo supplied credentials in errors', async (t) => {
  await isolated(t);
  await assert.rejects(save('openai', `not-a-url-${key}`, key), (error: Error) => {
    assert.equal(error.message.includes(key), false);
    return true;
  });
});

test('S1.1 save, query and clear expose presence only and isolate provider and endpoint', async (t) => {
  await isolated(t);
  assert.deepEqual(await status('openai', endpoint), { configured: false });
  assert.deepEqual(await save('openai', endpoint, key), { configured: true });
  assert.deepEqual(await status('openai', endpoint), { configured: true });
  assert.deepEqual(await status('openai', otherEndpoint), { configured: false });
  assert.deepEqual(await status('openai-compatible', endpoint), { configured: false });
  assert.equal(JSON.stringify(await handleIpcCommand('get_viewer_storage')).includes(key), false);
  assert.deepEqual(await clear('openai', endpoint), { configured: false });
  assert.deepEqual(await status('openai', endpoint), { configured: false });
});

test('S1.2 and S3.1 no-auth IPC uses stored OpenAI key for both synthesis and transcription', async (t) => {
  await isolated(t);
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  let requestUrl = '';
  let authorization = '';
  const events: any[] = [];
  ws.on('connection', (socket, request) => {
    requestUrl = request.url || '';
    authorization = request.headers.authorization || '';
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString());
      events.push(event);
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') }));
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const localEndpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
  const originalFetch = globalThis.fetch;
  const calls: Array<{url: string; authorization: string | null}> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ text: 'recognized' }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await save('openai', localEndpoint, key), { configured: true });
    const preferences = { ttsEnabled: true, sttEnabled: true, ttsProvider: 'openai', sttProvider: 'openai', openAiBaseUrl: localEndpoint };
    const tts = await handleIpcCommand('synthesize_speech_tts', { text: 'hello', preferences });
    const stt = await handleIpcCommand('transcribe_speech_stt', { audioBase64: Buffer.from('audio').toString('base64'), preferences });
    const wav = Buffer.from(tts.audioBase64, 'base64');
    assert.equal(tts.mimeType, 'audio/wav');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(wav.subarray(44), Buffer.from([1, 2]));
    assert.match(requestUrl, /^\/v1\/realtime\?model=/);
    assert.equal(authorization, `Bearer ${key}`);
    assert.ok(events.some((event) => JSON.stringify(event).includes('hello')));
    assert.equal(stt.text, 'recognized');
    assert.deepEqual(calls, [{ url: `${localEndpoint}/audio/transcriptions`, authorization: `Bearer ${key}` }]);
    assert.equal(JSON.stringify([tts, stt]).includes(key), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve, reject) => ws.close((err) => err ? reject(err) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('S1.2 stored credential cannot be redirected to a different endpoint', async (t) => {
  await isolated(t);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.deepEqual(await save('openai', endpoint, key), { configured: true });
  await assert.rejects(handleIpcCommand('synthesize_speech_tts', { text: 'hello', preferences: {
    ttsEnabled: true, sttEnabled: false, ttsProvider: 'openai', openAiBaseUrl: otherEndpoint,
  } }));
  assert.equal(calls, 0);
  assert.deepEqual(await status('openai', endpoint), { configured: true });
});

test('S1.2 compatible transcription uses its own stored credential through IPC', async (t) => {
  await isolated(t);
  const originalFetch = globalThis.fetch;
  const calls: Array<{url: string; authorization: string | null}> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ choices: [{ message: { content: '<transcription>recognized</transcription>' } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.deepEqual(await save('openai-compatible', endpoint, key), { configured: true });
  const result = await handleIpcCommand('transcribe_speech_stt', { audioBase64: Buffer.from('audio').toString('base64'), mimeType: 'audio/wav', preferences: {
    ttsEnabled: false, sttEnabled: true, sttProvider: 'openai-compatible', compatibleSttBaseUrl: endpoint, compatibleSttModel: 'audio-model',
  } });
  assert.equal(result.text, 'recognized');
  assert.deepEqual(calls, [{ url: `${endpoint}/chat/completions`, authorization: `Bearer ${key}` }]);
  assert.equal(JSON.stringify(result).includes(key), false);
});
