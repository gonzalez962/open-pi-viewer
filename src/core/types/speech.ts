/**
 * Speech (TTS / STT) types for Wyoming Docker & OpenAI Audio API.
 */

export type SpeechProvider = 'wyoming' | 'openai';

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
  selectedTtsPackId?: string;
  selectedSttPackId?: string;
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
    typeof rec.selectedTtsPackId === 'string' && rec.selectedTtsPackId.trim()
      ? rec.selectedTtsPackId.trim()
      : DEFAULT_SPEECH_PREFERENCES.selectedTtsPackId;

  const selectedSttPackId =
    typeof rec.selectedSttPackId === 'string' && rec.selectedSttPackId.trim()
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
