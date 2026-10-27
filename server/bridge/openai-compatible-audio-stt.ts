import { formatOpenAiApiUrl } from './openai-speech-client';

const PROMPT = 'Transcribe the audio faithfully. Return the transcription inside <transcription> and </transcription> tags.';

export async function transcribeCompatibleAudio(options: {
  audioBuffer: Buffer; mimeType?: string; baseUrl?: string; apiKey?: string; model?: string;
}): Promise<string> {
  const { audioBuffer } = options;
  const baseUrl = options.baseUrl?.trim();
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim();
  if (!baseUrl || !apiKey || !model) throw new Error('Compatible audio STT requires a base URL, API key and model ID.');
  let url: URL;
  try {
    url = new URL(formatOpenAiApiUrl(baseUrl, '/chat/completions'));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error('Invalid compatible audio STT base URL.');
  }
  const mimeType = (options.mimeType || 'audio/wav').split(';')[0].trim().toLowerCase();
  const format = mimeType === 'audio/wav' || mimeType === 'audio/x-wav' ? 'wav' : mimeType === 'audio/mpeg' ? 'mp3' : null;
  if (!format) throw new Error('Compatible audio STT supports WAV or MP3 audio only.');
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'input_audio', input_audio: { data: audioBuffer.toString('base64'), format } },
      ] }] }),
    });
  } catch {
    throw new Error('Compatible audio STT request failed.');
  }
  if (!response.ok) throw new Error('Compatible audio STT request failed.');
  let content: unknown;
  try {
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    content = data.choices?.[0]?.message?.content;
  } catch {
    throw new Error('Compatible audio STT returned an invalid response.');
  }
  const match = typeof content === 'string' ? /<transcription>([\s\S]*?)<\/transcription>/.exec(content) : null;
  if (!match) throw new Error('Compatible audio STT response is missing the transcription tag.');
  return match[1].trim();
}
