import type { SpeechPreferences } from '../../src/core/types/speech';
import { transcribeCompatibleAudio } from './openai-compatible-audio-stt';
import {
  synthesizeWyomingTts,
  transcribeWyomingStt,
} from './wyoming-client';
import {
  synthesizeOpenAiTts,
  transcribeOpenAiStt,
} from './openai-speech-client';

export interface SynthesizeTtsOptions {
  text: string;
  preferences: SpeechPreferences;
  rate?: number;
}

export interface SynthesizeTtsResult {
  audioBase64: string; // Base64-encoded WAV
  mimeType: 'audio/wav';
  durationSeconds?: number;
}

export interface TranscribeSttOptions {
  audioBuffer: Buffer;
  mimeType?: string;
  preferences: SpeechPreferences;
}

export interface TranscribeSttResult {
  text: string;
  confidence?: number;
}

/**
 * Test override hooks to mock speech synthesis/transcription without external servers.
 */
type TtsRunner = (text: string, preferences: SpeechPreferences, rate?: number) => Promise<Buffer>;
type SttRunner = (audioBuffer: Buffer, preferences: SpeechPreferences) => Promise<string>;

let ttsRunnerOverride: TtsRunner | null = null;
let sttRunnerOverride: SttRunner | null = null;

export function setTtsRunnerForTest(runner: TtsRunner | null): void {
  ttsRunnerOverride = runner;
}

export function setSttRunnerForTest(runner: SttRunner | null): void {
  sttRunnerOverride = runner;
}

/**
 * Synthesizes text to speech using either OpenAI Audio API or Wyoming Docker container.
 */
export async function synthesizeTts(options: SynthesizeTtsOptions): Promise<SynthesizeTtsResult> {
  const { text, preferences } = options;
  if (!preferences.ttsEnabled) {
    throw new Error('TTS is disabled in preferences.');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot synthesize empty text.');
  }

  if (ttsRunnerOverride) {
    const wavBuffer = await ttsRunnerOverride(trimmed, preferences, options.rate || preferences.ttsRate);
    return {
      audioBase64: wavBuffer.toString('base64'),
      mimeType: 'audio/wav',
    };
  }

  // 1. If OpenAI TTS provider is selected, dispatch to OpenAI /v1/audio/speech
  if (preferences.ttsProvider === 'openai') {
    const apiKey = (preferences.openAiApiKey || '').trim();
    if (!apiKey) {
      throw new Error(
        'OpenAI Speech (TTS) requiere una API key configurada en Ajustes > Voz > OpenAI API Key.'
      );
    }

    const { audioBase64 } = await synthesizeOpenAiTts({
      text: trimmed,
      apiKey,
      baseUrl: preferences.openAiBaseUrl || 'https://api.openai.com/v1',
      model: preferences.openAiTtsModel || 'tts-1',
      voice: preferences.openAiTtsVoice || 'alloy',
      speed: options.rate || preferences.ttsRate || 1.0,
      responseFormat: 'wav',
    });

    return {
      audioBase64,
      mimeType: 'audio/wav',
    };
  }

  // 2. Wyoming Docker container (default provider)
  const wyomingUrl = preferences.wyomingTtsUrl || 'tcp://127.0.0.1:10200';
  const voice = preferences.wyomingTtsVoice || preferences.selectedTtsPackId || 'es_MX-claude-high';

  try {
    const { wavBuffer, durationSeconds } = await synthesizeWyomingTts(
      trimmed,
      wyomingUrl,
      options.rate || preferences.ttsRate || 1.0,
      voice
    );
    return {
      audioBase64: wavBuffer.toString('base64'),
      mimeType: 'audio/wav',
      durationSeconds,
    };
  } catch (wyomingErr: any) {
    throw new Error(
      `Error al sintetizar voz con Wyoming Piper (${wyomingUrl}): ${wyomingErr.message}. Asegúrate de que el contenedor de Docker esté iniciado.`
    );
  }
}

/**
 * Transcribes speech to text using either OpenAI Audio API or Wyoming Docker container.
 */
export async function transcribeStt(options: TranscribeSttOptions): Promise<TranscribeSttResult> {
  const { audioBuffer, preferences } = options;
  if (!preferences.sttEnabled) {
    throw new Error('STT is disabled in preferences.');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Cannot transcribe empty audio buffer.');
  }

  if (sttRunnerOverride) {
    const text = await sttRunnerOverride(audioBuffer, preferences);
    return { text, confidence: 1.0 };
  }

  if (preferences.sttProvider === 'openai-compatible') {
    const text = await transcribeCompatibleAudio({
      audioBuffer, mimeType: options.mimeType, baseUrl: preferences.compatibleSttBaseUrl,
      apiKey: preferences.compatibleSttApiKey, model: preferences.compatibleSttModel,
    });
    return { text, confidence: 1.0 };
  }

  // 1. If OpenAI STT provider is selected, dispatch to OpenAI /v1/audio/transcriptions
  if (preferences.sttProvider === 'openai') {
    const apiKey = (preferences.openAiApiKey || '').trim();
    if (!apiKey) {
      throw new Error(
        'OpenAI Speech (STT) requiere una API key configurada en Ajustes > Voz > OpenAI API Key.'
      );
    }

    const { text } = await transcribeOpenAiStt({
      audioBuffer,
      apiKey,
      baseUrl: preferences.openAiBaseUrl || 'https://api.openai.com/v1',
      model: preferences.openAiSttModel || 'whisper-1',
      language: preferences.openAiSttLanguage || 'es',
    });

    return { text, confidence: 1.0 };
  }

  // 2. Wyoming Docker container (default provider)
  const wyomingSttUrl = preferences.wyomingSttUrl || 'tcp://127.0.0.1:10300';
  const language = preferences.wyomingSttLanguage || 'es';

  try {
    const text = await transcribeWyomingStt(
      audioBuffer,
      16000,
      wyomingSttUrl,
      language
    );
    return { text, confidence: 1.0 };
  } catch (wyomingErr: any) {
    throw new Error(
      `Error al transcribir voz con Wyoming Whisper (${wyomingSttUrl}): ${wyomingErr.message}. Asegúrate de que el contenedor de Docker esté iniciado.`
    );
  }
}
