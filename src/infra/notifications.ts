import {
  shouldDeliverNotification,
  type NotificationEventType,
  type NotificationPreferences,
} from '@core/notifications';

import { getNotificationDelivery, type NotificationPermissionStatus } from './notification-delivery';

let sharedAudioContext: AudioContext | null = null;
const lastDeliveredTimestamps = new Map<string, number>();

function getAudioContext(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
      sharedAudioContext = new AudioCtx();
    }
    if (sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
  } catch {
    return null;
  }
}

/**
 * Synthesizes crisp notification tones using Web Audio sine oscillators and
 * smooth exponential gain ramps, without any external asset dependencies.
 */
export function playNotificationSound(
  type: 'complete' | 'question' | 'error',
  volume = 0.25
): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const baseTime = ctx.currentTime;
    const clampedVolume = Math.max(0.01, Math.min(1, volume));

    interface ToneStep {
      freq: number;
      offset: number;
      duration: number;
    }

    let sequence: ToneStep[];
    if (type === 'complete') {
      // Two ascending pleasant tones: D5 (587Hz) -> A5 (880Hz)
      sequence = [
        { freq: 587.33, offset: 0, duration: 0.12 },
        { freq: 880.0, offset: 0.12, duration: 0.2 },
      ];
    } else if (type === 'question') {
      // Three-tone alert: C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz)
      sequence = [
        { freq: 523.25, offset: 0, duration: 0.09 },
        { freq: 659.25, offset: 0.09, duration: 0.09 },
        { freq: 783.99, offset: 0.18, duration: 0.22 },
      ];
    } else {
      // Descending warning tones: A4 (440Hz) -> F4 (349Hz)
      sequence = [
        { freq: 440.0, offset: 0, duration: 0.14 },
        { freq: 349.23, offset: 0.14, duration: 0.24 },
      ];
    }

    for (const step of sequence) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(step.freq, baseTime + step.offset);

      const startTime = baseTime + step.offset;
      const endTime = startTime + step.duration;

      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(clampedVolume, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(endTime + 0.02);
    }
  } catch {
    // Gracefully handle locked or unsupported audio contexts
  }
}

export async function getNotificationPermission(): Promise<NotificationPermissionStatus> {
  return getNotificationDelivery().permission();
}

/** Called only from an explicit user action, never from incoming Pi events. */
export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  return getNotificationDelivery().requestPermission();
}

export interface DesktopNotificationOptions {
  title: string;
  body: string;
  onClick?: () => void;
}

/** Returns delivery submission success, not proof that the OS displayed a popup. */
export async function showDesktopNotification(options: DesktopNotificationOptions): Promise<boolean> {
  return getNotificationDelivery().send(options);
}

export interface NotifyAppEventParams {
  eventType: NotificationEventType;
  title: string;
  body: string;
  preferences: NotificationPreferences;
  isWindowFocused?: boolean;
  sessionId?: string;
  projectId?: string;
}

/**
 * Central event notifier evaluating delivery preferences, window focus,
 * and dispatching audio and desktop alerts accordingly.
 */
export function notifyAppEvent(params: NotifyAppEventParams): void {
  const isWindowFocused =
    params.isWindowFocused ??
    (typeof document !== 'undefined' ? document.hasFocus() : false);

  const now = Date.now();
  const deliveryKey = JSON.stringify([params.projectId ?? '', params.sessionId ?? '', params.eventType]);
  const lastDeliveredAt = lastDeliveredTimestamps.get(deliveryKey);

  const decision = shouldDeliverNotification({
    eventType: params.eventType,
    preferences: params.preferences,
    isWindowFocused,
    lastDeliveredAt,
    now,
  });

  if (!decision.shouldShowPopup && !decision.shouldPlaySound) {
    return;
  }

  lastDeliveredTimestamps.set(deliveryKey, now);
  // Keep session-scoped debounce bounded even after many projects have been visited.
  if (lastDeliveredTimestamps.size > 256) {
    lastDeliveredTimestamps.delete(lastDeliveredTimestamps.keys().next().value!);
  }

  // Native OS controls desktop popup sounds; do not layer WebAudio over them.
  if (decision.shouldPlaySound && !(decision.shouldShowPopup && getNotificationDelivery().platform === 'tauri')) {
    const soundType =
      params.eventType === 'waiting_input'
        ? 'question'
        : params.eventType === 'error'
        ? 'error'
        : 'complete';
    playNotificationSound(soundType);
  }

  if (decision.shouldShowPopup) {
    void showDesktopNotification({
      title: params.title,
      body: params.body,
    });
  }
}
