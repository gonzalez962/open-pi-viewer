let sharedSpeechContext: AudioContext | null = null;

function getSpeechAudioContext(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedSpeechContext || sharedSpeechContext.state === 'closed') {
      sharedSpeechContext = new AudioCtx();
    }
    return sharedSpeechContext;
  } catch {
    return null;
  }
}

/**
 * Plays a base64-encoded WAV audio buffer with high-fidelity anti-aliasing resampling
 * via Web Audio API, with soft gain headroom to prevent inter-sample DAC clipping,
 * falling back gracefully to HTML5 Audio Element if needed.
 */
export async function playWavBase64(base64: string, volume = 0.9): Promise<void> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // 1. Prefer Web Audio API for sinc-resampling (22.05 kHz -> 48 kHz without aliasing)
  const ctx = getSpeechAudioContext();
  if (ctx) {
    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      // decodeAudioData detaches the buffer, so pass an isolated copy
      const copy = bytes.buffer.slice(0);
      const audioBuffer = await ctx.decodeAudioData(copy);

      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();
      // Leave slight headroom to prevent inter-sample digital clipping on peaking models
      gainNode.gain.setValueAtTime(Math.max(0.05, Math.min(1.0, volume)), ctx.currentTime);

      source.buffer = audioBuffer;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      return new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start(0);
      });
    } catch {
      // Fall through to HTML5 audio element fallback
    }
  }

  // 2. Fallback to HTML5 Audio Element
  return new Promise<void>((resolve, reject) => {
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = Math.max(0.05, Math.min(1.0, volume));
    audio.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    audio.play().catch((err) => {
      URL.revokeObjectURL(url);
      reject(err);
    });
  });
}
