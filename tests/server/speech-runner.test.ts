import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  setTtsRunnerForTest,
  setSttRunnerForTest,
  synthesizeTts,
  transcribeStt,
  resolveTtsModelPaths,
  resolveSttModelPaths,
} from '../../server/bridge/speech-runner';
import {
  setSpeechModelsDirForTest,
} from '../../server/bridge/speech';
import type { SpeechPreferences } from '../../src/core/types/speech';

describe('Speech Inference Runners', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-runner-test-'));
    setSpeechModelsDirForTest(tempDir);
  });

  afterEach(() => {
    setTtsRunnerForTest(null);
    setSttRunnerForTest(null);
    setSpeechModelsDirForTest(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
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

  it('synthesizeTts runs mock runner and returns base64 wav when enabled with custom model', async () => {
    const customOnnx = path.join(tempDir, 'voice.onnx');
    fs.writeFileSync(customOnnx, 'FAKE-ONNX');
    fs.writeFileSync(path.join(tempDir, 'voice.onnx.json'), '{}');

    const prefs: SpeechPreferences = {
      ttsEnabled: true,
      sttEnabled: false,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
      ttsCustom: {
        isCustom: true,
        modelPath: customOnnx,
      },
    };

    setTtsRunnerForTest(async (text, modelPath, configPath) => {
      assert.equal(text, 'Hola');
      assert.equal(modelPath, customOnnx);
      return Buffer.from('WAV-HEADER-MOCK-DATA');
    });

    const res = await synthesizeTts({ text: 'Hola', preferences: prefs });
    assert.equal(res.mimeType, 'audio/wav');
    assert.equal(Buffer.from(res.audioBase64, 'base64').toString(), 'WAV-HEADER-MOCK-DATA');
  });

  it('transcribeStt runs mock runner and returns transcribed text with custom model', async () => {
    const customOnnx = path.join(tempDir, 'encoder.onnx');
    fs.writeFileSync(customOnnx, 'FAKE-ONNX');

    const prefs: SpeechPreferences = {
      ttsEnabled: false,
      sttEnabled: true,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
      sttCustom: {
        isCustom: true,
        modelPath: customOnnx,
      },
    };

    setSttRunnerForTest(async (buffer, encPath) => {
      assert.equal(buffer.toString(), 'INPUT-AUDIO-MOCK');
      assert.equal(encPath, customOnnx);
      return 'transcripción exitosa';
    });

    const res = await transcribeStt({
      audioBuffer: Buffer.from('INPUT-AUDIO-MOCK'),
      preferences: prefs,
    });

    assert.equal(res.text, 'transcripción exitosa');
    assert.equal(res.confidence, 1.0);
  });

  it('synthesizeTts throws clear error when ttsProvider is openai but apiKey is missing', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
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
        /OpenAI Speech \(TTS\) requiere una API key/
      );
    } finally {
      if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    }
  });

  it('transcribeStt throws clear error when sttProvider is openai but apiKey is missing', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
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
        /OpenAI Speech \(STT\) requiere una API key/
      );
    } finally {
      if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    }
  });
});
