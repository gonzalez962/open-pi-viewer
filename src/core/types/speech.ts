/**
 * Speech (TTS / STT) types and official model manifest.
 */

export type SpeechEngine = 'piper' | 'sherpa-onnx' | 'wyoming';
export type SpeechProvider = 'wyoming' | 'openai';

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
  ttsProvider?: SpeechProvider; // 'wyoming' (default) | 'openai'
  sttProvider?: SpeechProvider; // 'wyoming' (default) | 'openai'
  openAiApiKey?: string;
  openAiBaseUrl?: string; // defaults to "https://api.openai.com/v1"
  openAiTtsModel?: string; // "tts-1" | "tts-1-hd"
  openAiTtsVoice?: string; // "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
  openAiSttModel?: string; // "whisper-1"
  openAiSttLanguage?: string; // e.g. "es" | "en" | "auto"
  ttsCustom?: CustomModelConfig;
  sttCustom?: CustomModelConfig;
  ttsRate?: number; // Speed multiplier (e.g. 1.0)
  autoSpeakResponses?: boolean;
  wyomingTtsUrl?: string; // e.g. "tcp://127.0.0.1:10200"
  wyomingTtsVoice?: string; // e.g. "es_MX-claude-high"
  wyomingSttUrl?: string; // e.g. "tcp://127.0.0.1:10300"
  wyomingSttModel?: string; // e.g. "tiny" | "base" | "small" | "medium"
  wyomingSttLanguage?: string; // e.g. "es" | "en"
  customDockerCommandTts?: string;
  customDockerCommandStt?: string;
}

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  ttsEnabled: false,
  sttEnabled: false,
  selectedTtsPackId: 'es_MX-claude-high',
  selectedSttPackId: 'es-kroko-64l',
  ttsProvider: 'wyoming',
  sttProvider: 'wyoming',
  openAiBaseUrl: 'https://api.openai.com/v1',
  openAiTtsModel: 'tts-1',
  openAiTtsVoice: 'alloy',
  openAiSttModel: 'whisper-1',
  openAiSttLanguage: 'es',
  ttsRate: 1.0,
  autoSpeakResponses: false,
  wyomingTtsUrl: 'tcp://127.0.0.1:10200',
  wyomingTtsVoice: 'es_MX-claude-high',
  wyomingSttUrl: 'tcp://127.0.0.1:10300',
  wyomingSttModel: 'tiny',
  wyomingSttLanguage: 'es',
};

export const PIPER_VOICES_COMMIT = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';
export const SHERPA_STT_COMMIT = 'fe61e648310e068a5558c3d4e4d02c25742820a4';

/**
 * Manifest of official models downloadable on-demand.
 * Includes exact immutable commit URLs, expected file sizes, and official SHA-256 digests.
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
        url: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_COMMIT}/es/es_MX/claude/high/es_MX-claude-high.onnx`,
        sizeBytes: 63122309,
        expectedSha256: '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0',
      },
      {
        filename: 'es_MX-claude-high.onnx.json',
        url: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_COMMIT}/es/es_MX/claude/high/es_MX-claude-high.onnx.json`,
        sizeBytes: 4963,
        expectedSha256: '1afc81f703c0e4cb3b4d7c0dca096b8b54a98806807f0170cf5eb5557723c12d',
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
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/encoder.int8.onnx`,
        sizeBytes: 153185997,
        expectedSha256: 'e6bb47f5425983960cf70c33f460e4a277ca1ec7f3c59e3747974ad3f431f056',
      },
      {
        filename: 'decoder.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/decoder.int8.onnx`,
        sizeBytes: 606495,
        expectedSha256: '624e8ae2886d5b1957e26ac77df54a00c3b55fdfe2153d7dbf2d687ca943e58b',
      },
      {
        filename: 'joiner.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/joiner.int8.onnx`,
        sizeBytes: 337105,
        expectedSha256: 'f027a07c54ff3565419f95e9c43112196ae188450a796411784917740a9bf9d0',
      },
      {
        filename: 'tokens.txt',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/tokens.txt`,
        sizeBytes: 7037,
        expectedSha256: '783ab50c895a41884ced1a46cd57e7a5de27240500b9beacdf91bd94ed1b9d8b',
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
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_128l/encoder.int8.onnx`,
        sizeBytes: 153182955,
        expectedSha256: '28c0ab872d407a5896ba53ff17d12f35d68b797144e28ca00be4b752b9590e71',
      },
      {
        filename: 'decoder.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_128l/decoder.int8.onnx`,
        sizeBytes: 606495,
        expectedSha256: 'c36e02e86a3c3bfff1483750eea22f16e5c43c57a5c34d22ecf4ca3eb341ddf9',
      },
      {
        filename: 'joiner.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_128l/joiner.int8.onnx`,
        sizeBytes: 337105,
        expectedSha256: 'd876cff6dc6d065a824a1e8e6b915832ec0a1c7b867f8c7e592f8f3877ce2924',
      },
      {
        filename: 'tokens.txt',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_128l/tokens.txt`,
        sizeBytes: 7037,
        expectedSha256: '783ab50c895a41884ced1a46cd57e7a5de27240500b9beacdf91bd94ed1b9d8b',
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

  const wyomingTtsUrl =
    typeof rec.wyomingTtsUrl === 'string' && rec.wyomingTtsUrl.trim()
      ? rec.wyomingTtsUrl.trim()
      : DEFAULT_SPEECH_PREFERENCES.wyomingTtsUrl;

  const wyomingTtsVoice =
    typeof rec.wyomingTtsVoice === 'string' && rec.wyomingTtsVoice.trim()
      ? rec.wyomingTtsVoice.trim()
      : DEFAULT_SPEECH_PREFERENCES.wyomingTtsVoice;

  const wyomingSttUrl =
    typeof rec.wyomingSttUrl === 'string' && rec.wyomingSttUrl.trim()
      ? rec.wyomingSttUrl.trim()
      : DEFAULT_SPEECH_PREFERENCES.wyomingSttUrl;

  const wyomingSttModel =
    typeof rec.wyomingSttModel === 'string' && rec.wyomingSttModel.trim()
      ? rec.wyomingSttModel.trim()
      : DEFAULT_SPEECH_PREFERENCES.wyomingSttModel;

  const wyomingSttLanguage =
    typeof rec.wyomingSttLanguage === 'string' && rec.wyomingSttLanguage.trim()
      ? rec.wyomingSttLanguage.trim()
      : DEFAULT_SPEECH_PREFERENCES.wyomingSttLanguage;

  const customDockerCommandTts =
    typeof rec.customDockerCommandTts === 'string' && rec.customDockerCommandTts.trim()
      ? rec.customDockerCommandTts.trim()
      : undefined;

  const customDockerCommandStt =
    typeof rec.customDockerCommandStt === 'string' && rec.customDockerCommandStt.trim()
      ? rec.customDockerCommandStt.trim()
      : undefined;

  const ttsProvider: SpeechProvider =
    rec.ttsProvider === 'openai' ? 'openai' : 'wyoming';

  const sttProvider: SpeechProvider =
    rec.sttProvider === 'openai' ? 'openai' : 'wyoming';

  const openAiApiKey =
    typeof rec.openAiApiKey === 'string' && rec.openAiApiKey.trim()
      ? rec.openAiApiKey.trim()
      : undefined;

  const openAiBaseUrl =
    typeof rec.openAiBaseUrl === 'string' && rec.openAiBaseUrl.trim()
      ? rec.openAiBaseUrl.trim()
      : DEFAULT_SPEECH_PREFERENCES.openAiBaseUrl;

  const openAiTtsModel =
    typeof rec.openAiTtsModel === 'string' && rec.openAiTtsModel.trim()
      ? rec.openAiTtsModel.trim()
      : DEFAULT_SPEECH_PREFERENCES.openAiTtsModel;

  const openAiTtsVoice =
    typeof rec.openAiTtsVoice === 'string' && rec.openAiTtsVoice.trim()
      ? rec.openAiTtsVoice.trim()
      : DEFAULT_SPEECH_PREFERENCES.openAiTtsVoice;

  const openAiSttModel =
    typeof rec.openAiSttModel === 'string' && rec.openAiSttModel.trim()
      ? rec.openAiSttModel.trim()
      : DEFAULT_SPEECH_PREFERENCES.openAiSttModel;

  const openAiSttLanguage =
    typeof rec.openAiSttLanguage === 'string' && rec.openAiSttLanguage.trim()
      ? rec.openAiSttLanguage.trim()
      : DEFAULT_SPEECH_PREFERENCES.openAiSttLanguage;

  return {
    ttsEnabled,
    sttEnabled,
    selectedTtsPackId,
    selectedSttPackId,
    ttsProvider,
    sttProvider,
    ...(openAiApiKey ? { openAiApiKey } : {}),
    openAiBaseUrl,
    openAiTtsModel,
    openAiTtsVoice,
    openAiSttModel,
    openAiSttLanguage,
    ...(ttsCustom ? { ttsCustom } : {}),
    ...(sttCustom ? { sttCustom } : {}),
    ttsRate,
    autoSpeakResponses,
    wyomingTtsUrl,
    wyomingTtsVoice,
    wyomingSttUrl,
    wyomingSttModel,
    wyomingSttLanguage,
    ...(customDockerCommandTts ? { customDockerCommandTts } : {}),
    ...(customDockerCommandStt ? { customDockerCommandStt } : {}),
  };
}
