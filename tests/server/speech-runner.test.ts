import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setTtsRunnerForTest,
  setSttRunnerForTest,
  synthesizeTts,
  transcribeStt,
} from '@server/bridge/speech-runner';
import type { SpeechPreferences } from '@core/types/speech';

describe('Speech Inference Runners', () => {
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
