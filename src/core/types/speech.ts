/**
 * Speech (TTS / STT) types and official model manifest.
 */

export type SpeechEngine = 'piper' | 'sherpa-onnx';

export type ModelIntegrityStatus = 'verified' | 'mismatch' | 'custom' | 'missing' | 'checking';

export interface ModelFileEntry {
  filename: string;
  url: string;
  sizeBytes: number;
  expectedSha256: string;
}

export interface OfficialSpeechPack {
  id: string;
  name: string;
  engine: SpeechEngine;
  kind: 'tts' | 'stt';
  language: string;
  variant: string;
  totalSizeBytes: number;
  files: ModelFileEntry[];
}

export interface CustomModelConfig {
  isCustom: boolean;
  modelPath: string;
  configPath?: string;
  tokensPath?: string;
  computedSha256?: string;
}

export interface SpeechPreferences {
  ttsEnabled: boolean;
  sttEnabled: boolean;
  selectedTtsPackId: string;
  selectedSttPackId: string;
  ttsCustom?: CustomModelConfig;
  sttCustom?: CustomModelConfig;
  ttsRate?: number; // Speed multiplier (e.g. 1.0)
  autoSpeakResponses?: boolean;
}

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  ttsEnabled: false,
  sttEnabled: false,
  selectedTtsPackId: 'es_MX-claude-high',
  selectedSttPackId: 'es-kroko-64l',
  ttsRate: 1.0,
  autoSpeakResponses: false,
};

/**
 * Manifest of official models downloadable on-demand.
 * Includes exact URLs, expected file sizes, and official SHA-256 digests.
 */
export const OFFICIAL_SPEECH_PACKS: Record<string, OfficialSpeechPack> = {
  'es_MX-claude-high': {
    id: 'es_MX-claude-high',
    name: 'Español (México) - Claude High (Piper)',
    engine: 'piper',
    kind: 'tts',
    language: 'es',
    variant: 'es_MX',
    totalSizeBytes: 63127272,
    files: [
      {
        filename: 'es_MX-claude-high.onnx',
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/high/es_MX-claude-high.onnx',
        sizeBytes: 63122309,
        // Verified LFS sha256 from HuggingFace
        expectedSha256: '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0',
      },
      {
        filename: 'es_MX-claude-high.onnx.json',
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/high/es_MX-claude-high.onnx.json',
        sizeBytes: 4963,
        expectedSha256: '4bd5e8cb155e797369e2c53ac9297543b9a7119138300b3b27e868e85aa62495',
      },
    ],
  },
  'es-kroko-64l': {
    id: 'es-kroko-64l',
    name: 'Español - Kroko 64L INT8 (Sherpa-ONNX)',
    engine: 'sherpa-onnx',
    kind: 'stt',
    language: 'es',
    variant: 'kroko_64l',
    totalSizeBytes: 154136604,
    files: [
      {
        filename: 'encoder.int8.onnx',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_64l/encoder.int8.onnx',
        sizeBytes: 153185997,
        expectedSha256: 'e6bb47f5425983960cf70c33f460e4a277ca1ec7f3c59e3747974ad3f431f056',
      },
      {
        filename: 'decoder.int8.onnx',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_64l/decoder.int8.onnx',
        sizeBytes: 606495,
        expectedSha256: '624e8ae2886d5b1957e26ac77df54a00c3b55fdfe2153d7dbf2d687ca943e58b',
      },
      {
        filename: 'joiner.int8.onnx',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_64l/joiner.int8.onnx',
        sizeBytes: 337105,
        expectedSha256: 'f027a07c54ff3565419f95e9c43112196ae188450a796411784917740a9bf9d0',
      },
      {
        filename: 'tokens.txt',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_64l/tokens.txt',
        sizeBytes: 7037,
        expectedSha256: '3e7d1ce620f04c66053a47b9a613411b7e793ec79a2ece0857212d2ab437390a',
      },
    ],
  },
  'es-kroko-128l': {
    id: 'es-kroko-128l',
    name: 'Español - Kroko 128L INT8 (Sherpa-ONNX)',
    engine: 'sherpa-onnx',
    kind: 'stt',
    language: 'es',
    variant: 'kroko_128l',
    totalSizeBytes: 154133592,
    files: [
      {
        filename: 'encoder.int8.onnx',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_128l/encoder.int8.onnx',
        sizeBytes: 153182955,
        expectedSha256: '28c0ab872d407a5896ba53ff17d12f35d68b797144e28ca00be4b752b9590e71',
      },
      {
        filename: 'decoder.int8.onnx',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_128l/decoder.int8.onnx',
        sizeBytes: 606495,
        expectedSha256: 'c36e02e86a3c3bfff1483750eea22f16e5c43c57a5c34d22ecf4ca3eb341ddf9',
      },
      {
        filename: 'joiner.int8.onnx',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_128l/joiner.int8.onnx',
        sizeBytes: 337105,
        expectedSha256: 'd876cff6dc6d065a824a1e8e6b915832ec0a1c7b867f8c7e592f8f3877ce2924',
      },
      {
        filename: 'tokens.txt',
        url: 'https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/es/kroko_128l/tokens.txt',
        sizeBytes: 7037,
        expectedSha256: '88609333aa899deaefb1b4bcb5bacbea7fad6af06cbd475dc83a3a997d8a1327',
      },
    ],
  },
};

/**
 * Validates and sanitizes a custom model configuration object.
 */
export function validateCustomModelConfig(input: unknown): CustomModelConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  if (typeof rec.modelPath !== 'string' || !rec.modelPath.trim()) return undefined;

  return {
    isCustom: Boolean(rec.isCustom),
    modelPath: rec.modelPath.trim(),
    configPath: typeof rec.configPath === 'string' && rec.configPath.trim() ? rec.configPath.trim() : undefined,
    tokensPath: typeof rec.tokensPath === 'string' && rec.tokensPath.trim() ? rec.tokensPath.trim() : undefined,
    computedSha256: typeof rec.computedSha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(rec.computedSha256.trim())
      ? rec.computedSha256.trim().toLowerCase()
      : undefined,
  };
}

/**
 * Validates and sanitizes a speech preferences payload.
 */
export function validateSpeechPreferences(input: unknown): SpeechPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_SPEECH_PREFERENCES };
  }
  const rec = input as Record<string, unknown>;

  const ttsEnabled = typeof rec.ttsEnabled === 'boolean' ? rec.ttsEnabled : DEFAULT_SPEECH_PREFERENCES.ttsEnabled;
  const sttEnabled = typeof rec.sttEnabled === 'boolean' ? rec.sttEnabled : DEFAULT_SPEECH_PREFERENCES.sttEnabled;

  const selectedTtsPackId =
    typeof rec.selectedTtsPackId === 'string' && rec.selectedTtsPackId.trim() in OFFICIAL_SPEECH_PACKS
      ? rec.selectedTtsPackId.trim()
      : DEFAULT_SPEECH_PREFERENCES.selectedTtsPackId;

  const selectedSttPackId =
    typeof rec.selectedSttPackId === 'string' && rec.selectedSttPackId.trim() in OFFICIAL_SPEECH_PACKS
      ? rec.selectedSttPackId.trim()
      : DEFAULT_SPEECH_PREFERENCES.selectedSttPackId;

  const ttsCustom = validateCustomModelConfig(rec.ttsCustom);
  const sttCustom = validateCustomModelConfig(rec.sttCustom);

  const ttsRate =
    typeof rec.ttsRate === 'number' && Number.isFinite(rec.ttsRate) && rec.ttsRate >= 0.25 && rec.ttsRate <= 4.0
      ? rec.ttsRate
      : DEFAULT_SPEECH_PREFERENCES.ttsRate;

  const autoSpeakResponses =
    typeof rec.autoSpeakResponses === 'boolean'
      ? rec.autoSpeakResponses
      : DEFAULT_SPEECH_PREFERENCES.autoSpeakResponses;

  return {
    ttsEnabled,
    sttEnabled,
    selectedTtsPackId,
    selectedSttPackId,
    ...(ttsCustom ? { ttsCustom } : {}),
    ...(sttCustom ? { sttCustom } : {}),
    ttsRate,
    autoSpeakResponses,
  };
}
