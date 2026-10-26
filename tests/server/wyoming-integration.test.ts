import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWyomingHealth,
  synthesizeWyomingTts,
  transcribeWyomingStt,
} from '../../server/bridge/wyoming-client';
import {
  synthesizeTts,
  transcribeStt,
} from '../../server/bridge/speech-runner';
import { DEFAULT_SPEECH_PREFERENCES } from '../../src/core/types/speech';

describe('Wyoming Client & Speech Runner Integration', () => {
  it('checkWyomingHealth detects wyoming-piper at 10200', async () => {
    const res = await checkWyomingHealth('tcp://127.0.0.1:10200', 3000);
    assert.equal(res.ok, true, `Expected ok=true, got error: ${res.error}`);
    assert.ok(res.info?.name, 'Expected info.name to be present');
  });

  it('checkWyomingHealth detects wyoming-whisper at 10300', async () => {
    const res = await checkWyomingHealth('tcp://127.0.0.1:10300', 3000);
    assert.equal(res.ok, true, `Expected ok=true, got error: ${res.error}`);
    assert.ok(res.info?.name, 'Expected info.name to be present');
  });

  it('synthesizes text using Wyoming Piper and returns valid WAV', async () => {
    const res = await synthesizeTts({
      text: 'Prueba de integración en contenedor Docker.',
      preferences: {
        ...DEFAULT_SPEECH_PREFERENCES,
        ttsEnabled: true,
        wyomingTtsUrl: 'tcp://127.0.0.1:10200',
      },
    });

    assert.equal(res.mimeType, 'audio/wav');
    assert.ok(res.audioBase64.length > 100);
    const wavHeader = Buffer.from(res.audioBase64, 'base64').subarray(0, 4).toString('ascii');
    assert.equal(wavHeader, 'RIFF');
  });

  it('transcribes speech using Wyoming Whisper', async () => {
    // 1. Generate audio
    const tts = await synthesizeWyomingTts('buenos días', 'tcp://127.0.0.1:10200');
    assert.ok(tts.wavBuffer.length > 44);

    // 2. Transcribe audio
    const res = await transcribeStt({
      audioBuffer: tts.wavBuffer,
      preferences: {
        ...DEFAULT_SPEECH_PREFERENCES,
        sttEnabled: true,
        wyomingSttUrl: 'tcp://127.0.0.1:10300',
      },
    });

    assert.ok(res.text.length > 0, 'Transcription should not be empty');
    assert.match(res.text.toLowerCase(), /días|dias|buenos/i);
  });
});
