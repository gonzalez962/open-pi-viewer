/**
 * Client for OpenAI and OpenAI-compatible Audio API endpoints:
 * - POST /v1/audio/speech (Text-to-Speech)
 * - POST /v1/audio/transcriptions (Speech-to-Text)
 */

export interface OpenAiTtsOptions {
  text: string;
  apiKey: string;
  baseUrl?: string;
  model?: string; // e.g. "tts-1", "tts-1-hd"
  voice?: string; // "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
  speed?: number; // 0.25 to 4.0
  responseFormat?: 'wav' | 'mp3' | 'opus' | 'aac' | 'flac';
}

export interface OpenAiSttOptions {
  audioBuffer: Buffer;
  apiKey: string;
  baseUrl?: string;
  model?: string; // e.g. "whisper-1"
  language?: string; // ISO-639-1 code e.g. "es", "en"
  prompt?: string;
}

/**
 * Normalizes OpenAI base URL, guaranteeing no trailing slashes and appending /v1 if omitted.
 */
export function formatOpenAiApiUrl(rawBaseUrl?: string, endpointPath = ''): string {
  let base = (rawBaseUrl || 'https://api.openai.com/v1').trim();
  base = base.replace(/\/+$/, '');

  // If user provided e.g. https://api.openai.com or http://localhost:8000 without /v1
  if (!/\/v\d+$/i.test(base)) {
    base = `${base}/v1`;
  }

  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${base}${cleanPath}`;
}

/**
 * Synthesizes speech using OpenAI /v1/audio/speech.
 * Returns audio as a base64 string.
 */
export async function synthesizeOpenAiTts(
  options: OpenAiTtsOptions,
  customFetch: typeof fetch = fetch
): Promise<{ audioBase64: string; mimeType: 'audio/wav' | 'audio/mpeg' }> {
  const {
    text,
    apiKey,
    baseUrl,
    model = 'tts-1',
    voice = 'alloy',
    speed = 1.0,
    responseFormat = 'wav',
  } = options;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('API key is required for OpenAI Speech (TTS).');
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error('Cannot synthesize empty text.');
  }

  const url = formatOpenAiApiUrl(baseUrl, '/audio/speech');

  const payload = {
    model,
    input: trimmedText,
    voice,
    speed: Math.max(0.25, Math.min(4.0, speed)),
    response_format: responseFormat,
  };

  const response = await customFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorDetail = `Status ${response.status}`;
    try {
      const errJson = (await response.json()) as any;
      if (errJson?.error?.message) {
        errorDetail = errJson.error.message;
      }
    } catch {
      try {
        const textErr = await response.text();
        if (textErr) errorDetail = textErr;
      } catch {}
    }
    throw new Error(`OpenAI TTS Error (${response.status}): ${errorDetail}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    audioBase64: buffer.toString('base64'),
    mimeType: responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
  };
}

/**
 * Transcribes audio using OpenAI /v1/audio/transcriptions.
 */
export async function transcribeOpenAiStt(
  options: OpenAiSttOptions,
  customFetch: typeof fetch = fetch
): Promise<{ text: string }> {
  const {
    audioBuffer,
    apiKey,
    baseUrl,
    model = 'whisper-1',
    language,
    prompt,
  } = options;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('API key is required for OpenAI Speech (STT).');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Cannot transcribe empty audio buffer.');
  }

  const url = formatOpenAiApiUrl(baseUrl, '/audio/transcriptions');

  const formData = new FormData();
  const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' });
  formData.append('file', audioBlob, 'audio.wav');
  formData.append('model', model);

  if (language && language.trim() && language.trim() !== 'auto') {
    formData.append('language', language.trim());
  }

  if (prompt && prompt.trim()) {
    formData.append('prompt', prompt.trim());
  }

  const response = await customFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: formData,
  });

  if (!response.ok) {
    let errorDetail = `Status ${response.status}`;
    try {
      const errJson = (await response.json()) as any;
      if (errJson?.error?.message) {
        errorDetail = errJson.error.message;
      }
    } catch {
      try {
        const textErr = await response.text();
        if (textErr) errorDetail = textErr;
      } catch {}
    }
    throw new Error(`OpenAI STT Error (${response.status}): ${errorDetail}`);
  }

  const data = (await response.json()) as { text?: string };
  return {
    text: (data.text || '').trim(),
  };
}
