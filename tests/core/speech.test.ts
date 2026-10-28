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
import { PreferencesController, loadUiPreferences, type UiPreferences } from '@infra/preferences';

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
  it('S1.1 keeps non-secret audio settings while excluding voice keys from browser persistence', async () => {
    const storage = createMockStorage();
    let current: UiPreferences = { language: 'en', theme: 'dark' };
    const controller = new PreferencesController({ storage, getPreferences: () => current,
      setPreferences: (value) => { current = value; }, setWarning: () => {} });
    await controller.setSpeechPreferences({
      sttProvider: 'openai-compatible' as any,
      compatibleSttBaseUrl: 'https://audio.example/v1',
      compatibleSttApiKey: 'test-key',
      compatibleSttModel: 'audio-model',
      openAiApiKey: 'existing-key',
      wyomingSttUrl: 'tcp://localhost:1234',
    } as any);
    const speech = loadUiPreferences(storage).preferences.speech as any;
    assert.equal(speech.sttProvider, 'openai-compatible');
    assert.equal(speech.compatibleSttBaseUrl, 'https://audio.example/v1');
    assert.equal(JSON.stringify(speech).includes('test-key'), false);
    assert.equal(JSON.stringify(storage.getItem('pi_viewer_ui_preferences')).includes('test-key'), false);
    assert.equal(speech.compatibleSttModel, 'audio-model');
    assert.equal(JSON.stringify(speech).includes('existing-key'), false);
    assert.equal(JSON.stringify(storage.getItem('pi_viewer_ui_preferences')).includes('existing-key'), false);
    assert.equal(speech.wyomingSttUrl, 'tcp://localhost:1234');
  });
  it('default speech preferences configure Wyoming docker containers and OpenAI API defaults', () => {
    assert.equal(DEFAULT_SPEECH_PREFERENCES.ttsEnabled, false);
    assert.equal(DEFAULT_SPEECH_PREFERENCES.sttEnabled, false);
    assert.equal(DEFAULT_SPEECH_PREFERENCES.ttsProvider, 'wyoming');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.sttProvider, 'wyoming');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.wyomingTtsUrl, 'tcp://127.0.0.1:10200');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.wyomingSttUrl, 'tcp://127.0.0.1:10300');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.openAiBaseUrl, 'https://api.openai.com/v1');
    assert.equal(DEFAULT_SPEECH_PREFERENCES.openAiTtsModel, 'gpt-realtime-2.1-mini');
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
      openAiTtsModel: 'gpt-realtime-2.1-mini',
      openAiTtsVoice: 'marin',
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
    assert.equal(JSON.stringify(validated).includes('sk-test-key'), false);
    assert.equal(validated.openAiTtsModel, 'gpt-realtime-2.1-mini');
    assert.equal(validated.openAiTtsVoice, 'marin');
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

  it('PreferencesController persists and reloads speech preferences', async () => {
    const storage = createMockStorage();
    let currentPrefs: UiPreferences = { language: 'es', theme: 'dark' };

    const controller = new PreferencesController({
      storage,
      getPreferences: () => currentPrefs as any,
      setPreferences: (p) => { currentPrefs = p as any; },
      setWarning: () => {},
    });

    await controller.setSpeechPreferences({
      ttsEnabled: true,
      sttEnabled: false,
      ttsRate: 1.5,
    });

    assert.equal(currentPrefs.speech?.ttsEnabled, true);
    assert.equal(currentPrefs.speech?.sttEnabled, false);
    assert.equal(currentPrefs.speech?.ttsRate, 1.5);
  });

  it('S2.2 reports bridge storage failure instead of successful speech save', async () => {
    const storage = createMockStorage();
    let current: UiPreferences = { language: 'en', theme: 'dark' };
    let warning: string | null = null;
    const previous = globalThis.window;
    (globalThis as any).window = { __IS_WEB_IPC__: true, __TAURI_INTERNALS__: {
      __isWebIpc: true, invoke: async () => { throw new Error('server unavailable'); },
    } };
    try {
      const controller = new PreferencesController({ storage, getPreferences: () => current,
        setPreferences: (value) => { current = value; }, setWarning: (value) => { warning = value; } });
      const result = await controller.setSpeechPreferences({ ttsEnabled: true });
      assert.equal(result.success, false);
      assert.ok(warning);
      assert.notEqual(current.speech?.ttsEnabled, true);
    } finally { (globalThis as any).window = previous; }
  });

  it('S2.2 reports server success when local persistence fails and retains authoritative speech', async () => {
    const storage = createMockStorage();
    storage.setItem = () => { throw new Error('local unavailable'); };
    let current: UiPreferences = { language: 'en', theme: 'dark' };
    let warning: string | null = null;
    const previous = globalThis.window;
    (globalThis as any).window = { __IS_WEB_IPC__: true, __TAURI_INTERNALS__: {
      __isWebIpc: true, invoke: async (_cmd: string, args: any) => ({ version: 1, uiPreferences: args.value }),
    } };
    try {
      const controller = new PreferencesController({ storage, getPreferences: () => current,
        setPreferences: (value) => { current = value; }, setWarning: (value) => { warning = value; } });
      const result = await controller.setSpeechPreferences({ ttsEnabled: true });
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /saved on the server, but local storage failed/i);
      assert.match(warning ?? '', /saved on the server, but local storage failed/i);
      assert.equal(current.speech?.ttsEnabled, true);
    } finally { (globalThis as any).window = previous; }
  });

  it('S2.1 retains concurrent unrelated changes when a speech save completes', async () => {
    const storage = createMockStorage();
    let current: UiPreferences = { language: 'en', theme: 'dark' };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = globalThis.window;
    (globalThis as any).window = { __IS_WEB_IPC__: true, __TAURI_INTERNALS__: {
      __isWebIpc: true, invoke: async (cmd: string, args: any) => { entered(); await gate; assert.equal(cmd, 'patch_speech_preferences'); assert.deepEqual(args.payload.patch, { ttsEnabled: true }); return { version: 1, uiPreferences: { language: 'es', theme: 'dark', speech: { ttsEnabled: true } } }; },
    } };
    try {
      const controller = new PreferencesController({ storage, getPreferences: () => current,
        setPreferences: (value) => { current = value; }, setWarning: () => {} });
      const pending = controller.setSpeechPreferences({ ttsEnabled: true });
      await started;
      current = { ...current, language: 'es' };
      release();
      const result = await pending;
      assert.equal(result.success, true);
      assert.equal(current.language, 'es');
      assert.equal(current.speech?.ttsEnabled, true);
      assert.equal(loadUiPreferences(storage).preferences.language, 'es');
    } finally { (globalThis as any).window = previous; }
  });

  it('S2.1 exposes separate explicit save actions for STT and TTS', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechSettingsSection, {
      preferences: DEFAULT_SPEECH_PREFERENCES, onSpeechPreferencesChange: () => {},
    }));
    assert.match(html, /<button\b[^>]*>[^<]*guardar[^<]*tts[^<]*<\/button>/i);
    assert.match(html, /<button\b[^>]*>[^<]*guardar[^<]*stt[^<]*<\/button>/i);
  });

  it('S2.1 compatible STT exposes one save action rather than a separate connection save', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechSettingsSection, {
      preferences: { ...DEFAULT_SPEECH_PREFERENCES, sttProvider: 'openai-compatible' }, onSpeechPreferencesChange: () => {},
    }));
    assert.ok(html.includes('Guardar STT'));
    assert.equal(html.includes('Guardar conexión compatible'), false);
    assert.equal(html.includes('Eliminar clave compatible'), false);
    assert.equal(html.includes('Clave compatible:'), false);
  });

  it('S2.1 shared OpenAI connection has a styled save without status or delete actions', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechSettingsSection, {
      preferences: DEFAULT_SPEECH_PREFERENCES, onSpeechPreferencesChange: () => {},
    }));
    assert.match(html, /<button[^>]*style="[^"]*background:#2563eb[^"]*"[^>]*>Guardar conexión OpenAI<\/button>/);
    assert.equal(html.includes('Eliminar clave OpenAI'), false);
    assert.equal(html.includes('Clave OpenAI:'), false);
  });

  it('S1.1 never reloads a legacy voice secret into the settings form', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechSettingsSection, {
      preferences: { ...DEFAULT_SPEECH_PREFERENCES, openAiApiKey: 'legacy-secret', compatibleSttApiKey: 'legacy-compatible', sttProvider: 'openai-compatible' },
      onSpeechPreferencesChange: () => {},
    }));
    assert.equal(html.includes('legacy-secret'), false);
    assert.equal(html.includes('legacy-compatible'), false);
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
    assert.ok(html.includes('OpenAI Realtime'));
    assert.ok(html.includes('/v1/audio/transcriptions'));
  });
});
