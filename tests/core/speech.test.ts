import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFICIAL_SPEECH_PACKS,
  DEFAULT_SPEECH_PREFERENCES,
  validateSpeechPreferences,
  validateCustomModelConfig,
} from '../../src/core/types/speech';
import { PreferencesController, type StorageLike } from '../../src/infra/preferences';

function createMockStorage(initialData: Record<string, string> = {}): StorageLike {
  const store = new Map<string, string>(Object.entries(initialData));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

describe('Speech types and preferences validation', () => {
  it('contains expected official speech packs with expected sha256 checksums', () => {
    assert.ok(OFFICIAL_SPEECH_PACKS['es_MX-claude-high'], 'Piper es_MX pack exists');
    assert.equal(OFFICIAL_SPEECH_PACKS['es_MX-claude-high'].engine, 'piper');
    assert.equal(OFFICIAL_SPEECH_PACKS['es_MX-claude-high'].kind, 'tts');
    assert.equal(OFFICIAL_SPEECH_PACKS['es_MX-claude-high'].files.length, 2);

    assert.ok(OFFICIAL_SPEECH_PACKS['es-kroko-64l'], 'Sherpa kroko 64l pack exists');
    assert.equal(OFFICIAL_SPEECH_PACKS['es-kroko-64l'].engine, 'sherpa-onnx');
    assert.equal(OFFICIAL_SPEECH_PACKS['es-kroko-64l'].kind, 'stt');
    assert.equal(OFFICIAL_SPEECH_PACKS['es-kroko-64l'].files.length, 4);

    for (const pack of Object.values(OFFICIAL_SPEECH_PACKS)) {
      for (const f of pack.files) {
        assert.match(f.expectedSha256, /^[0-9a-fA-F]{64}$/, `${f.filename} has a 64-character SHA-256 hash`);
        assert.ok(f.url.startsWith('https://'), `${f.filename} has a secure https URL`);
      }
    }
  });

  it('validateSpeechPreferences falls back to defaults for invalid/empty input', () => {
    const emptyResult = validateSpeechPreferences(null);
    assert.deepEqual(emptyResult, DEFAULT_SPEECH_PREFERENCES);
    assert.equal(emptyResult.ttsEnabled, false);
    assert.equal(emptyResult.sttEnabled, false);
  });

  it('validateSpeechPreferences sanitizes valid values and rates', () => {
    const input = {
      ttsEnabled: true,
      sttEnabled: true,
      selectedTtsPackId: 'es_MX-claude-high',
      selectedSttPackId: 'es-kroko-64l',
      ttsRate: 1.25,
      autoSpeakResponses: true,
    };
    const validated = validateSpeechPreferences(input);
    assert.equal(validated.ttsEnabled, true);
    assert.equal(validated.sttEnabled, true);
    assert.equal(validated.ttsRate, 1.25);
    assert.equal(validated.autoSpeakResponses, true);
  });

  it('validateCustomModelConfig validates custom model paths and 64-char sha256', () => {
    const valid = validateCustomModelConfig({
      isCustom: true,
      modelPath: 'C:/models/my-voice.onnx',
      configPath: 'C:/models/my-voice.onnx.json',
      computedSha256: '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0',
    });
    assert.ok(valid);
    assert.equal(valid.isCustom, true);
    assert.equal(valid.modelPath, 'C:/models/my-voice.onnx');
    assert.equal(valid.computedSha256, '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0');

    const invalid = validateCustomModelConfig({ modelPath: '' });
    assert.equal(invalid, undefined);
  });

  it('PreferencesController persists and reloads speech preferences', () => {
    const storage = createMockStorage();
    let currentPrefs = { language: 'es' as const, theme: 'dark' as const };
    const controller = new PreferencesController({
      storage,
      getPreferences: () => currentPrefs as any,
      setPreferences: (p) => { currentPrefs = p as any; },
      setWarning: () => {},
    });

    controller.setSpeechPreferences({
      ttsEnabled: true,
      sttEnabled: false,
      ttsRate: 1.5,
    });

    assert.equal(currentPrefs.speech?.ttsEnabled, true);
    assert.equal(currentPrefs.speech?.sttEnabled, false);
    assert.equal(currentPrefs.speech?.ttsRate, 1.5);
  });
});
