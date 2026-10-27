let sharedSpeechContext: AudioContext | null = null;
let currentSourceNode: AudioBufferSourceNode | null = null;
let currentAudioElement: HTMLAudioElement | null = null;
let activePlaybackListeners: Array<() => void> = [];
let currentTrackId: string | null = null;
let playbackChangeListeners: Array<(state: SpeechPlaybackState) => void> = [];

export interface SpeechPlaybackState {
  isActive: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  currentTrackId: string | null;
}

export interface SpeechQueueSession {
  trackId: string;
  isAborted: () => boolean;
  enqueue: (base64Wav: string) => Promise<void>;
  finish: () => void;
  abort: () => void;
}

interface ActiveQueueState {
  trackId: string;
  aborted: boolean;
  finished: boolean;
  audioBuffers: AudioBuffer[];
  html5Blobs: string[];
  isPlayingChunk: boolean;
  ctx: AudioContext | null;
  gainNode: GainNode | null;
}

let activeQueue: ActiveQueueState | null = null;

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
 * Returns current snapshot of speech playback state across Web Audio and HTML5 element.
 */
export function getSpeechPlaybackState(): SpeechPlaybackState {
  const isWebAudio = currentSourceNode !== null;
  const isHtml5 = currentAudioElement !== null;
  const isQueueActive = activeQueue !== null && !activeQueue.aborted;
  const isActive = isWebAudio || isHtml5 || isQueueActive;

  let isPaused = false;
  if (isWebAudio && sharedSpeechContext) {
    isPaused = sharedSpeechContext.state === 'suspended';
  } else if (isHtml5 && currentAudioElement) {
    isPaused = currentAudioElement.paused;
  }

  const isPlaying = isActive && !isPaused;

  return {
    isActive,
    isPlaying,
    isPaused,
    currentTrackId: isActive ? currentTrackId : null,
  };
}

function notifyStateChange(): void {
  const state = getSpeechPlaybackState();
  for (const listener of [...playbackChangeListeners]) {
    try {
      listener(state);
    } catch {}
  }
}

/**
 * Subscribes to speech playback state changes (play, pause, resume, stop).
 */
export function subscribeSpeechPlayback(listener: (state: SpeechPlaybackState) => void): () => void {
  playbackChangeListeners.push(listener);
  try {
    listener(getSpeechPlaybackState());
  } catch {}
  return () => {
    playbackChangeListeners = playbackChangeListeners.filter((l) => l !== listener);
  };
}

/**
 * Pauses active speech playback immediately without losing position.
 */
export async function pauseSpeechAudio(): Promise<boolean> {
  if (currentSourceNode && sharedSpeechContext && sharedSpeechContext.state === 'running') {
    try {
      await sharedSpeechContext.suspend();
    } catch {}
    notifyStateChange();
    return true;
  }
  if (currentAudioElement && !currentAudioElement.paused) {
    try {
      currentAudioElement.pause();
    } catch {}
    notifyStateChange();
    return true;
  }
  return false;
}

/**
 * Resumes previously paused speech playback from where it was paused.
 */
export async function resumeSpeechAudio(): Promise<boolean> {
  if (currentSourceNode && sharedSpeechContext && sharedSpeechContext.state === 'suspended') {
    try {
      await sharedSpeechContext.resume();
    } catch {}
    notifyStateChange();
    return true;
  }
  if (currentAudioElement && currentAudioElement.paused) {
    try {
      await currentAudioElement.play();
    } catch {}
    notifyStateChange();
    return true;
  }
  return false;
}

/**
 * Toggles pause/resume on active speech playback.
 */
export async function toggleSpeechAudioPause(): Promise<'paused' | 'resumed' | 'idle'> {
  const state = getSpeechPlaybackState();
  if (!state.isActive) {
    return 'idle';
  }
  if (state.isPaused) {
    await resumeSpeechAudio();
    return 'resumed';
  } else {
    await pauseSpeechAudio();
    return 'paused';
  }
}

/**
 * Stops any actively playing TTS audio immediately across both Web Audio and HTML5 element.
 */
export function stopSpeechAudio(): void {
  if (activeQueue) {
    activeQueue.aborted = true;
    for (const url of activeQueue.html5Blobs) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    activeQueue = null;
  }
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
  currentTrackId = null;
  const listeners = [...activePlaybackListeners];
  activePlaybackListeners = [];
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
  notifyStateChange();
}

/**
 * Returns true if speech audio is currently active (playing or paused).
 */
export function isSpeechAudioPlaying(): boolean {
  return currentSourceNode !== null || currentAudioElement !== null || (activeQueue !== null && activeQueue.isPlayingChunk);
}

/**
 * Starts a chunked/pipelined speech audio playback queue.
 * Allows enqueuing audio segments incrementally as they are synthesized paragraph-by-paragraph,
 * starting playback immediately on the first segment and smoothly chaining subsequent segments.
 */
export function startSpeechQueue(trackId: string, volume = 0.9): SpeechQueueSession {
  stopSpeechAudio();
  currentTrackId = trackId;
  notifyStateChange();

  const ctx = getSpeechAudioContext();
  let gainNode: GainNode | null = null;
  if (ctx) {
    try {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(Math.max(0.05, Math.min(1.0, volume)), ctx.currentTime);
      gainNode.connect(ctx.destination);
    } catch {}
  }

  const queue: ActiveQueueState = {
    trackId,
    aborted: false,
    finished: false,
    audioBuffers: [],
    html5Blobs: [],
    isPlayingChunk: false,
    ctx,
    gainNode,
  };
  activeQueue = queue;

  function playNextChunk() {
    if (queue.aborted || activeQueue !== queue) {
      return;
    }

    // 1. Web Audio mode
    if (queue.ctx && queue.gainNode) {
      if (queue.audioBuffers.length === 0) {
        queue.isPlayingChunk = false;
        currentSourceNode = null;
        notifyStateChange();
        if (queue.finished) {
          stopSpeechAudio();
        }
        return;
      }

      queue.isPlayingChunk = true;
      const buffer = queue.audioBuffers.shift()!;
      const source = queue.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(queue.gainNode);

      currentSourceNode = source;
      notifyStateChange();

      source.onended = () => {
        if (currentSourceNode === source) {
          currentSourceNode = null;
        }
        playNextChunk();
      };

      try {
        source.start(0);
      } catch {
        playNextChunk();
      }
      return;
    }

    // 2. HTML5 audio element fallback
    if (queue.html5Blobs.length === 0) {
      queue.isPlayingChunk = false;
      currentAudioElement = null;
      notifyStateChange();
      if (queue.finished) {
        stopSpeechAudio();
      }
      return;
    }

    queue.isPlayingChunk = true;
    const blobUrl = queue.html5Blobs.shift()!;
    const audio = new Audio(blobUrl);
    audio.volume = Math.max(0.05, Math.min(1.0, volume));
    currentAudioElement = audio;
    notifyStateChange();

    const cleanupChunk = () => {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {}
      if (currentAudioElement === audio) {
        currentAudioElement = null;
      }
      playNextChunk();
    };

    audio.onended = cleanupChunk;
    audio.onerror = cleanupChunk;
    audio.play().catch(cleanupChunk);
  }

  return {
    trackId,
    isAborted: () => queue.aborted || activeQueue !== queue,
    enqueue: async (base64Wav: string) => {
      if (queue.aborted || activeQueue !== queue) return;

      const binary = atob(base64Wav);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      if (queue.ctx) {
        try {
          const copy = bytes.buffer.slice(0);
          const audioBuffer = await queue.ctx.decodeAudioData(copy);
          if (queue.aborted || activeQueue !== queue) return;
          queue.audioBuffers.push(audioBuffer);
          if (!queue.isPlayingChunk) {
            playNextChunk();
          }
          return;
        } catch {
          // fall through to HTML5 blob
        }
      }

      const blob = new Blob([bytes], { type: 'audio/wav' });
      const blobUrl = URL.createObjectURL(blob);
      if (queue.aborted || activeQueue !== queue) {
        URL.revokeObjectURL(blobUrl);
        return;
      }

      queue.html5Blobs.push(blobUrl);
      if (!queue.isPlayingChunk) {
        playNextChunk();
      }
    },
    finish: () => {
      if (queue.aborted || activeQueue !== queue) return;
      queue.finished = true;
      if (!queue.isPlayingChunk && queue.audioBuffers.length === 0 && queue.html5Blobs.length === 0) {
        stopSpeechAudio();
      }
    },
    abort: () => {
      if (activeQueue === queue) {
        stopSpeechAudio();
      } else {
        queue.aborted = true;
      }
    },
  };
}

/**
 * Plays a base64-encoded WAV audio buffer with high-fidelity anti-aliasing resampling
 * via Web Audio API, with soft gain headroom to prevent inter-sample DAC clipping,
 * falling back gracefully to HTML5 Audio Element if needed.
 */
export async function playWavBase64(base64: string, volume = 0.9, trackId?: string | null): Promise<void> {
  // Stop any previously playing audio before starting new playback
  stopSpeechAudio();
  currentTrackId = trackId ?? null;

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
      notifyStateChange();

      return new Promise<void>((resolve) => {
        const cleanup = () => {
          if (currentSourceNode === source) {
            currentSourceNode = null;
            currentTrackId = null;
          }
          const idx = activePlaybackListeners.indexOf(cleanup);
          if (idx !== -1) activePlaybackListeners.splice(idx, 1);
          notifyStateChange();
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
    notifyStateChange();

    const cleanup = () => {
      if (currentAudioElement === audio) {
        currentAudioElement = null;
        currentTrackId = null;
      }
      const idx = activePlaybackListeners.indexOf(cleanup);
      if (idx !== -1) activePlaybackListeners.splice(idx, 1);
      URL.revokeObjectURL(url);
      notifyStateChange();
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
