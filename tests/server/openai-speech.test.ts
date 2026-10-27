import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOpenAiApiUrl,
  synthesizeOpenAiTts,
  transcribeOpenAiStt,
  type OpenAiTtsOptions,
  type OpenAiSttOptions,
} from '../../server/bridge/openai-speech-client';

describe('OpenAI Speech Client', () => {
  it('formatOpenAiApiUrl normalizes base URLs and paths correctly', () => {
    assert.equal(
      formatOpenAiApiUrl('https://api.openai.com/v1', '/audio/speech'),
      'https://api.openai.com/v1/audio/speech'
    );
    assert.equal(
      formatOpenAiApiUrl('https://api.openai.com/v1/', '/audio/speech'),
      'https://api.openai.com/v1/audio/speech'
    );
    assert.equal(
      formatOpenAiApiUrl('http://localhost:8000', '/audio/transcriptions'),
      'http://localhost:8000/v1/audio/transcriptions'
    );
    assert.equal(
      formatOpenAiApiUrl('http://localhost:8000/v1/', 'audio/transcriptions'),
      'http://localhost:8000/v1/audio/transcriptions'
    );
  });

  it('synthesizeOpenAiTts rejects when apiKey is missing', async () => {
    await assert.rejects(
      async () =>
        synthesizeOpenAiTts({
          text: 'Hola',
          apiKey: '',
        }),
      /API key is required/
    );
  });

  it('synthesizeOpenAiTts sends POST to /v1/audio/speech with Authorization header and returns audio Base64', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse(String(init?.body || '{}'));

      const fakeAudioBuffer = Buffer.from('RIFF-FAKE-AUDIO-WAV-OR-MP3');
      return new Response(fakeAudioBuffer, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    };

    const result = await synthesizeOpenAiTts(
      {
        text: 'Prueba de voz',
        apiKey: 'sk-test-key-12345',
        baseUrl: 'https://api.openai.com/v1',
        model: 'tts-1',
        voice: 'alloy',
        speed: 1.25,
      },
      mockFetch as any
    );

    assert.equal(capturedUrl, 'https://api.openai.com/v1/audio/speech');
    assert.equal(capturedHeaders['Authorization'], 'Bearer sk-test-key-12345');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.equal(capturedBody.model, 'tts-1');
    assert.equal(capturedBody.input, 'Prueba de voz');
    assert.equal(capturedBody.voice, 'alloy');
    assert.equal(capturedBody.speed, 1.25);
    assert.equal(capturedBody.response_format, 'wav');

    assert.ok(result.audioBase64);
    assert.equal(
      Buffer.from(result.audioBase64, 'base64').toString('utf8'),
      'RIFF-FAKE-AUDIO-WAV-OR-MP3'
    );
  });

  it('transcribeOpenAiStt rejects when apiKey is missing', async () => {
    await assert.rejects(
      async () =>
        transcribeOpenAiStt({
          audioBuffer: Buffer.from('fake-audio'),
          apiKey: '',
        }),
      /API key is required/
    );
  });

  it('transcribeOpenAiStt sends multipart/form-data to /v1/audio/transcriptions and parses response', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let isFormData = false;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      isFormData = init?.body instanceof FormData;

      return new Response(JSON.stringify({ text: 'Transcripción simulada' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await transcribeOpenAiStt(
      {
        audioBuffer: Buffer.from('RIFF-WAV-BYTES'),
        apiKey: 'sk-stt-key-abc',
        baseUrl: 'https://api.openai.com/v1',
        model: 'whisper-1',
        language: 'es',
      },
      mockFetch as any
    );

    assert.equal(capturedUrl, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(capturedHeaders['Authorization'], 'Bearer sk-stt-key-abc');
    assert.equal(isFormData, true);
    assert.equal(result.text, 'Transcripción simulada');
  });

  it('synthesizeOpenAiTts throws clear error with message when API returns 401/400', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          error: { message: 'Incorrect API key provided' },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await assert.rejects(
      async () =>
        synthesizeOpenAiTts(
          {
            text: 'Test',
            apiKey: 'sk-invalid',
          },
          mockFetch as any
        ),
      /Incorrect API key provided/
    );
  });
});
