/**
 * Web Audio recording and WAV encoding utilities for STT.
 * Browsers do not produce raw 16-bit PCM WAV from MediaRecorder by default
 * (they produce WebM Opus). This encoder decodes via AudioContext and encodes
 * clean 16kHz 16-bit Mono PCM WAV accepted natively by Wyoming Whisper and Sherpa-ONNX.
 */

export function encodeWav16kMono(audioBuffer: AudioBuffer, targetSampleRate = 16000): ArrayBuffer {
  // 1. Downmix all channels to mono
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const monoData = new Float32Array(length);

  for (let c = 0; c < numChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      monoData[i] += channelData[i] / numChannels;
    }
  }

  // 2. Resample to targetSampleRate if necessary
  const sourceRate = audioBuffer.sampleRate;
  let resampledData: Float32Array;

  if (sourceRate === targetSampleRate) {
    resampledData = monoData;
  } else {
    const ratio = sourceRate / targetSampleRate;
    const targetLength = Math.round(length / ratio);
    resampledData = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      const srcIndex = i * ratio;
      const index0 = Math.floor(srcIndex);
      const index1 = Math.min(index0 + 1, length - 1);
      const fraction = srcIndex - index0;
      resampledData[i] = monoData[index0] * (1 - fraction) + monoData[index1] * fraction;
    }
  }

  // 3. Convert Float32 [-1.0, 1.0] to 16-bit PCM signed integers
  const pcm16 = new Int16Array(resampledData.length);
  for (let i = 0; i < resampledData.length; i++) {
    const s = Math.max(-1, Math.min(1, resampledData[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // 4. Construct valid WAV RIFF header (44 bytes)
  const byteRate = targetSampleRate * 2; // 1 channel * 2 bytes/sample
  const blockAlign = 2; // 1 channel * 2 bytes/sample
  const buffer = new ArrayBuffer(44 + pcm16.byteLength);
  const view = new DataView(buffer);

  // "RIFF"
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + pcm16.byteLength, true);
  // "WAVE"
  view.setUint32(8, 0x57415645, false);
  // "fmt "
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample
  // "data"
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, pcm16.byteLength, true);

  // Copy PCM bytes
  new Int16Array(buffer, 44).set(pcm16);

  return buffer;
}

/**
 * Converts a recorded Blob (e.g. WebM/Ogg/Wav from browser mic) to a 16kHz 16-bit Mono WAV Blob.
 */
export async function convertBlobToWav16kMono(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const wavBuffer = encodeWav16kMono(audioBuffer, 16000);
    return new Blob([wavBuffer], { type: 'audio/wav' });
  } finally {
    void ctx.close().catch(() => {});
  }
}
