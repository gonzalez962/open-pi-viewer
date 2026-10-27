import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpeechSettingsSection } from '@features/settings/components/SpeechSettingsSection';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPEECH_PREFERENCES,
  validateSpeechPreferences,
  validateCustomModelConfig,
} from '@core/types/speech';
import { PreferencesController, type UiPreferences } from '@infra/preferences';

function createMockStorage(initialData: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initialData));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    length: store.size,
  };
}

describe('Speech types and preferences validation', () => {
  it('default speech preferences configure Wyoming docker containers and OpenAI API defaults', () => {
    assert.equal(DEFAULT_SPEECH_PREFERENCES.ttsEnabled, false);
    assert.equal(DEFAULT_SPEECH_PREFERENCES.sttEnabled, false);
    assert.equal(DEFAULT_SPEECH_PREFERENCES.ttsProvider, 'wyoming');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.sttProvider, 'wyoming');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.wyomingTtsUrl, 'tcp://127.0.0.1:10200');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.wyomingSttUrl, 'tcp://127.0.0.1:10300');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.openAiBaseUrl, 'https://api.openai.com/v1');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.openAiTtsModel, 'tts-1');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.openAiTtsVoice, 'alloy');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.openAiSttModel, 'whisper-1');
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
      ttsProvider: 'openai',
      sttProvider: 'openai',
      openAiApiKey: 'sk-test-key',
      openAiBaseUrl: 'https://api.openai.com/v1',
      openAiTtsModel: 'tts-1-hd',
      openAiTtsVoice: 'nova',
      openAiSttModel: 'whisper-1',
      openAiSttLanguage: 'en',
      ttsRate: 1.25,
      autoSpeakResponses: true,
    };
    const validated = validateSpeechPreferences(input);
    assert.equal(validated.ttsEnabled, true);
    assert.equal(validated.sttEnabled, true);
    assert.equal(validated.ttsProvider, 'openai');
    assert.equal(validated.sttProvider, 'openai');
    assert.equal(validated.openAiApiKey, 'sk-test-key');
    assert.equal(validated.openAiTtsModel, 'tts-1-hd');
    assert.equal(validated.openAiTtsVoice, 'nova');
    assert.equal(validated.openAiSttModel, 'whisper-1');
    assert.equal(validated.openAiSttLanguage, 'en');
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
    let currentPrefs: UiPreferences = { language: 'es', theme: 'dark' };

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

  it('SpeechSettingsSection renders container config and docker compose without crashing', () => {
    const html = renderToStaticMarkup(
      React.createElement(SpeechSettingsSection, {
        preferences: {
          ...DEFAULT_SPEECH_PREFERENCES,
          ttsEnabled: true,
          sttEnabled: true,
          wyomingTtsVoice: 'es_MX-claude-high',
          wyomingSttModel: 'tiny',
        },
        onSpeechPreferencesChange: () => {},
      })
    );
    assert.ok(html.includes('speech-settings-section'));
    assert.ok(html.includes('docker-compose.speech.yml'));
    assert.ok(html.includes('wyoming-piper'));
    assert.ok(html.includes('wyoming-whisper'));
    assert.ok(html.includes('OpenAI Audio API'));
    assert.ok(html.includes('/v1/audio/speech'));
    assert.ok(html.includes('/v1/audio/transcriptions'));
  });
});
