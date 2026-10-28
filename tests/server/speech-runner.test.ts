import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  setTtsRunnerForTest,
  setSttRunnerForTest,
  synthesizeTts,
  transcribeStt,
} from '@server/bridge/speech-runner';
import type { SpeechPreferences } from '@core/types/speech';

describe('Speech Inference Runners', () => {
  it('S3.1 retains the OpenAI Audio STT route and configuration', async () => {
    const original = globalThis.fetch;
    let url = '';
    let model = '';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      model = String((init?.body as FormData).get('model'));
      return new Response(JSON.stringify({ text: 'openai transcript' }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await transcribeStt({ audioBuffer: Buffer.from('audio'), preferences: {
        ttsEnabled: false, sttEnabled: true, sttProvider: 'openai', openAiApiKey: 'existing-key',
        openAiBaseUrl: 'https://existing.example/v1', openAiSttModel: 'existing-model',
      } });
      assert.equal(result.text, 'openai transcript');
      assert.equal(url, 'https://existing.example/v1/audio/transcriptions');
      assert.equal(model, 'existing-model');
    } finally { globalThis.fetch = original; }
  });

  it('S3.1 retains the Wyoming STT route and configuration', async () => {
    let received = '';
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (received.includes('audio-stop')) {
          const data = JSON.stringify({ text: 'wyoming transcript' });
          socket.end(JSON.stringify({ type: 'transcript', data_length: Buffer.byteLength(data) }) + '\n' + data);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const result = await transcribeStt({ audioBuffer: Buffer.from('audio'), preferences: {
        ttsEnabled: false, sttEnabled: true, sttProvider: 'wyoming',
        wyomingSttUrl: `tcp://127.0.0.1:${port}`, wyomingSttLanguage: 'en',
      } });
      assert.equal(result.text, 'wyoming transcript');
      assert.match(received, /"language":"en"/);
      assert.match(received, /audio-stop/);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  afterEach(() => {
    setTtsRunnerForTest(null);
    setSttRunnerForTest(null);
  });

  it('synthesizeTts rejects when TTS is disabled in preferences', async () => {
    const prefs: SpeechPreferences = {
      ttsEnabled: false,
      sttEnabled: false,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
    };

    await assert.rejects(
      async () => synthesizeTts({ text: 'Hola mundo', preferences: prefs }),
      /TTS is disabled in preferences/
    );
  });

  it('transcribeStt rejects when STT is disabled in preferences', async () => {
    const prefs: SpeechPreferences = {
      ttsEnabled: false,
      sttEnabled: false,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
    };

    await assert.rejects(
      async () => transcribeStt({ audioBuffer: Buffer.from('audio'), preferences: prefs }),
      /STT is disabled in preferences/
    );
  });

  it('synthesizeTts runs mock runner and returns base64 wav when enabled', async () => {
    const prefs: SpeechPreferences = {
      ttsEnabled: true,
      sttEnabled: false,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
      ttsProvider: 'wyoming',
    };

    setTtsRunnerForTest(async (text) => {
      assert.equal(text, 'Hola');
      return Buffer.from('WAV-HEADER-MOCK-DATA');
    });

    const res = await synthesizeTts({ text: 'Hola', preferences: prefs });
    assert.equal(res.mimeType, 'audio/wav');
    assert.equal(Buffer.from(res.audioBase64, 'base64').toString(), 'WAV-HEADER-MOCK-DATA');
  });

  it('transcribeStt runs mock runner and returns transcribed text when enabled', async () => {
    const prefs: SpeechPreferences = {
      ttsEnabled: false,
      sttEnabled: true,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
      sttProvider: 'wyoming',
    };

    setSttRunnerForTest(async (buffer) => {
      assert.equal(buffer.toString(), 'INPUT-AUDIO-MOCK');
      return 'transcripción exitosa';
    });

    const res = await transcribeStt({
      audioBuffer: Buffer.from('INPUT-AUDIO-MOCK'),
      preferences: prefs,
    });

    assert.equal(res.text, 'transcripción exitosa');
    assert.equal(res.confidence, 1.0);
  });

  it('synthesizeTts throws clear error when ttsProvider is openai but apiKey is missing even if OPENAI_API_KEY is in env', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-env-key-that-must-be-ignored';
    try {
      const prefs: SpeechPreferences = {
        ttsEnabled: true,
        sttEnabled: false,
        selectedTtsPackId: 'es_MX-claude-high',
        selectedSttPackId: 'es-kroko-64l',
        ttsProvider: 'openai',
      };

      await assert.rejects(
        async () => synthesizeTts({ text: 'Hola mundo', preferences: prefs }),
        /OpenAI Speech \(TTS\) requiere una API key configurada en Ajustes/
      );
    } finally {
      if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('transcribeStt throws clear error when sttProvider is openai but apiKey is missing even if OPENAI_API_KEY is in env', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-env-key-that-must-be-ignored';
    try {
      const prefs: SpeechPreferences = {
        ttsEnabled: false,
        sttEnabled: true,
        selectedTtsPackId: 'es_MX-claude-high',
        selectedSttPackId: 'es-kroko-64l',
        sttProvider: 'openai',
      };

      await assert.rejects(
        async () =>
          transcribeStt({
            audioBuffer: Buffer.from('AUDIO-DATA'),
            preferences: prefs,
          }),
        /OpenAI Speech \(STT\) requiere una API key configurada en Ajustes/
      );
    } finally {
      if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});
