let sharedSpeechContext: AudioContext | null = null;
let currentSourceNode: AudioBufferSourceNode | null = null;
let currentAudioElement: HTMLAudioElement | null = null;
let activePlaybackListeners: Array<() => void> = [];

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
 * Stops any actively playing TTS audio immediately across both Web Audio and HTML5 element.
 */
export function stopSpeechAudio(): void {
  if (currentSourceNode) {
    try {
      currentSourceNode.stop();
    } catch {}
    currentSourceNode = null;
  }
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.currentTime = 0;
    } catch {}
    currentAudioElement = null;
  }
  const listeners = [...activePlaybackListeners];
  activePlaybackListeners = [];
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
}

/**
 * Returns true if speech audio is currently playing.
 */
export function isSpeechAudioPlaying(): boolean {
  return currentSourceNode !== null || currentAudioElement !== null;
}

/**
 * Plays a base64-encoded WAV audio buffer with high-fidelity anti-aliasing resampling
 * via Web Audio API, with soft gain headroom to prevent inter-sample DAC clipping,
 * falling back gracefully to HTML5 Audio Element if needed.
 */
export async function playWavBase64(base64: string, volume = 0.9): Promise<void> {
  // Stop any previously playing audio before starting new playback
  stopSpeechAudio();

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
      const copy = bytes.buffer.slice(0);
      const audioBuffer = await ctx.decodeAudioData(copy);

      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(Math.max(0.05, Math.min(1.0, volume)), ctx.currentTime);

      source.buffer = audioBuffer;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      currentSourceNode = source;

      return new Promise<void>((resolve) => {
        const cleanup = () => {
          if (currentSourceNode === source) {
            currentSourceNode = null;
          }
          const idx = activePlaybackListeners.indexOf(cleanup);
          if (idx !== -1) activePlaybackListeners.splice(idx, 1);
          resolve();
        };

        activePlaybackListeners.push(cleanup);
        source.onended = cleanup;
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
    currentAudioElement = audio;
    audio.volume = Math.max(0.05, Math.min(1.0, volume));

    const cleanup = () => {
      if (currentAudioElement === audio) {
        currentAudioElement = null;
      }
      const idx = activePlaybackListeners.indexOf(cleanup);
      if (idx !== -1) activePlaybackListeners.splice(idx, 1);
      URL.revokeObjectURL(url);
      resolve();
    };

    activePlaybackListeners.push(cleanup);

    audio.onended = cleanup;
    audio.onerror = (e) => {
      cleanup();
      reject(e);
    };
    audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}
