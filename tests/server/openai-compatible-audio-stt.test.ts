import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeStt } from '@server/bridge/speech-runner';

const preferences = {
  ttsEnabled: false, sttEnabled: true,
  sttProvider: 'openai-compatible',
  compatibleSttBaseUrl: 'https://audio.example/v1',
  compatibleSttApiKey: 'test-key',
  compatibleSttModel: 'audio-model',
} as any;
const audioBuffer = Buffer.from('recorded audio');

async function withResponse(content: string, test: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try { await test(calls); } finally { globalThis.fetch = original; }
}

describe('Compatible audio STT', () => {
  it('S2.1 sends the model, audio and fixed prompt to the configured endpoint', async () => {
    await withResponse('<transcription>Hello</transcription>', async (calls) => {
      const result = await transcribeStt({ audioBuffer, mimeType: 'audio/wav', preferences });
      assert.equal(result.text, 'Hello');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://audio.example/v1/chat/completions');
      assert.equal(calls[0].init.method, 'POST');
      const headers = new Headers(calls[0].init.headers);
      assert.equal(headers.get('authorization'), 'Bearer test-key');
      const body = JSON.parse(String(calls[0].init.body));
      assert.equal(body.model, 'audio-model');
      const content = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
      const prompt = content.find((part: any) => part.type === 'text')?.text;
      assert.match(prompt, /transcri/i);
      assert.match(prompt, /<transcription>/i);
      assert.equal(content.find((part: any) => part.type === 'input_audio')?.input_audio?.data, audioBuffer.toString('base64'));
      assert.equal(content.find((part: any) => part.type === 'input_audio')?.input_audio?.format, 'wav');
    });
  });

  it('S2.2 returns only tagged text from a response with surrounding text', async () => {
    await withResponse('Before <transcription>Hello world</transcription> after', async () => {
      assert.equal((await transcribeStt({ audioBuffer, mimeType: 'audio/wav', preferences })).text, 'Hello world');
    });
  });

  it('does not expose credentials from upstream errors', async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response(JSON.stringify({ error: { message: 'test-key' } }), { status: 401 }); }) as typeof fetch;
    try {
      await assert.rejects(transcribeStt({ audioBuffer, mimeType: 'audio/wav', preferences }), (error: Error) => {
        assert.ok(!error.message.includes('test-key'));
        assert.equal(called, true);
        return true;
      });
    } finally { globalThis.fetch = original; }
  });

  it('rejects transport failures without exposing credentials', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('test-key'); }) as typeof fetch;
    try {
      await assert.rejects(transcribeStt({ audioBuffer, mimeType: 'audio/wav', preferences }), (error: Error) => {
        assert.ok(!error.message.includes('test-key'));
        return true;
      });
    } finally { globalThis.fetch = original; }
  });

  it('S2.3 rejects a response without the transcription tag', async () => {
    await withResponse('This is not tagged', async (calls) => {
      await assert.rejects(transcribeStt({ audioBuffer, mimeType: 'audio/wav', preferences }), /transcription/i);
      assert.equal(calls.length, 1);
    });
  });
});
