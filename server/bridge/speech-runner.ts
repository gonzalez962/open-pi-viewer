import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  inspectOfficialPack,
  getPackDir,
  inspectCustomModel,
} from './speech';
import {
  OFFICIAL_SPEECH_PACKS,
  type SpeechPreferences,
} from '../../src/core/types/speech';

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
 * Resolves local paths for TTS model and JSON config based on preferences.
 */
export async function resolveTtsModelPaths(prefs: SpeechPreferences): Promise<{
  modelPath: string;
  configPath: string;
}> {
  if (prefs.ttsCustom?.isCustom && prefs.ttsCustom.modelPath) {
    const inspected = await inspectCustomModel(prefs.ttsCustom);
    if (!inspected.valid) {
      throw new Error(`Custom TTS model is invalid: ${inspected.error}`);
    }
    const modelPath = path.resolve(prefs.ttsCustom.modelPath);
    const configPath = prefs.ttsCustom.configPath
      ? path.resolve(prefs.ttsCustom.configPath)
      : `${modelPath}.json`;
    return { modelPath, configPath };
  }

  const pack = OFFICIAL_SPEECH_PACKS[prefs.selectedTtsPackId || 'es_MX-claude-high'];
  if (!pack) {
    throw new Error(`Unknown official TTS pack: ${prefs.selectedTtsPackId}`);
  }

  const status = await inspectOfficialPack(pack);
  if (status.status !== 'verified') {
    throw new Error(
      `Official TTS pack '${pack.name}' is not ready (${status.status}). Download it in Settings first.`
    );
  }

  const packDir = getPackDir(pack.id);
  const onnxFile = pack.files.find((f) => f.filename.endsWith('.onnx'))!;
  const jsonFile = pack.files.find((f) => f.filename.endsWith('.json'))!;

  return {
    modelPath: path.join(packDir, onnxFile.filename),
    configPath: path.join(packDir, jsonFile.filename),
  };
}

/**
 * Resolves local paths for STT Sherpa-ONNX model files based on preferences.
 */
export async function resolveSttModelPaths(prefs: SpeechPreferences): Promise<{
  encoderPath: string;
  decoderPath: string;
  joinerPath: string;
  tokensPath: string;
}> {
  if (prefs.sttCustom?.isCustom && prefs.sttCustom.modelPath) {
    const inspected = await inspectCustomModel(prefs.sttCustom);
    if (!inspected.valid) {
      throw new Error(`Custom STT model is invalid: ${inspected.error}`);
    }
    const modelDir = path.dirname(path.resolve(prefs.sttCustom.modelPath));
    return {
      encoderPath: path.resolve(prefs.sttCustom.modelPath),
      decoderPath: path.join(modelDir, 'decoder.int8.onnx'),
      joinerPath: path.join(modelDir, 'joiner.int8.onnx'),
      tokensPath: prefs.sttCustom.tokensPath
        ? path.resolve(prefs.sttCustom.tokensPath)
        : path.join(modelDir, 'tokens.txt'),
    };
  }

  const pack = OFFICIAL_SPEECH_PACKS[prefs.selectedSttPackId || 'es-kroko-64l'];
  if (!pack) {
    throw new Error(`Unknown official STT pack: ${prefs.selectedSttPackId}`);
  }

  const status = await inspectOfficialPack(pack);
  if (status.status !== 'verified') {
    throw new Error(
      `Official STT pack '${pack.name}' is not ready (${status.status}). Download it in Settings first.`
    );
  }

  const packDir = getPackDir(pack.id);
  return {
    encoderPath: path.join(packDir, 'encoder.int8.onnx'),
    decoderPath: path.join(packDir, 'decoder.int8.onnx'),
    joinerPath: path.join(packDir, 'joiner.int8.onnx'),
    tokensPath: path.join(packDir, 'tokens.txt'),
  };
}

/**
 * Text-to-Speech synthesizer function runner.
 * In environments where the piper binary or piper-tts is installed in system or app bundle,
 * it invokes piper directly. If a mock runner is injected (tests), it uses the mock runner.
 */
type TtsBinaryRunner = (
  text: string,
  modelPath: string,
  configPath: string,
  rate?: number
) => Promise<Buffer>;

let ttsRunnerOverride: TtsBinaryRunner | null = null;

export function setTtsRunnerForTest(runner: TtsBinaryRunner | null): void {
  ttsRunnerOverride = runner;
}

export async function synthesizeTts(options: SynthesizeTtsOptions): Promise<SynthesizeTtsResult> {
  const { text, preferences } = options;
  if (!preferences.ttsEnabled) {
    throw new Error('TTS is disabled in preferences.');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot synthesize empty text.');
  }

  const { modelPath, configPath } = await resolveTtsModelPaths(preferences);

  if (ttsRunnerOverride) {
    const wavBuffer = await ttsRunnerOverride(trimmed, modelPath, configPath, options.rate || preferences.ttsRate);
    return {
      audioBase64: wavBuffer.toString('base64'),
      mimeType: 'audio/wav',
    };
  }

  // Attempt to invoke piper binary if available on path
  return new Promise((resolve, reject) => {
    const rate = options.rate || preferences.ttsRate || 1.0;
    // piper CLI accepts text on stdin and writes wav to stdout with --output_file -
    const args = [
      '--model', modelPath,
      '--config', configPath,
      '--output_file', '-',
    ];

    if (rate !== 1.0) {
      // Piper length_scale controls speed (inverse: 0.8 is faster, 1.25 is slower)
      const lengthScale = (1.0 / rate).toFixed(2);
      args.push('--length_scale', lengthScale);
    }

    const child = spawn('piper', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));

    child.on('error', (err) => {
      reject(new Error(`Failed to start piper TTS process: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const errDetails = Buffer.concat(stderrChunks).toString('utf8');
        return reject(new Error(`Piper exited with code ${code}: ${errDetails}`));
      }
      const wavBuffer = Buffer.concat(chunks);
      resolve({
        audioBase64: wavBuffer.toString('base64'),
        mimeType: 'audio/wav',
      });
    });

    child.stdin.write(trimmed);
    child.stdin.end();
  });
}

/**
 * Speech-to-Text transcription runner.
 */
type SttBinaryRunner = (
  audioBuffer: Buffer,
  encoderPath: string,
  decoderPath: string,
  joinerPath: string,
  tokensPath: string
) => Promise<string>;

let sttRunnerOverride: SttBinaryRunner | null = null;

export function setSttRunnerForTest(runner: SttBinaryRunner | null): void {
  sttRunnerOverride = runner;
}

export async function transcribeStt(options: TranscribeSttOptions): Promise<TranscribeSttResult> {
  const { audioBuffer, preferences } = options;
  if (!preferences.sttEnabled) {
    throw new Error('STT is disabled in preferences.');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Cannot transcribe empty audio buffer.');
  }

  const { encoderPath, decoderPath, joinerPath, tokensPath } = await resolveSttModelPaths(preferences);

  if (sttRunnerOverride) {
    const text = await sttRunnerOverride(audioBuffer, encoderPath, decoderPath, joinerPath, tokensPath);
    return { text, confidence: 1.0 };
  }

  // Attempt to invoke sherpa-onnx-offline binary if present
  return new Promise((resolve, reject) => {
    const args = [
      `--encoder=${encoderPath}`,
      `--decoder=${decoderPath}`,
      `--joiner=${joinerPath}`,
      `--tokens=${tokensPath}`,
    ];

    const child = spawn('sherpa-onnx-offline', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));

    child.on('error', (err) => {
      reject(new Error(`Failed to start sherpa-onnx STT process: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const errDetails = Buffer.concat(stderrChunks).toString('utf8');
        return reject(new Error(`Sherpa-onnx exited with code ${code}: ${errDetails}`));
      }
      const rawOutput = Buffer.concat(chunks).toString('utf8').trim();
      resolve({ text: rawOutput, confidence: 1.0 });
    });

    child.stdin.write(audioBuffer);
    child.stdin.end();
  });
}
