import { useEffect, useRef } from 'react';
import type { ChatMessage, AgentActivity, TextBlock } from '@core/types/messages';
import { DEFAULT_SPEECH_PREFERENCES, type SpeechPreferences } from '@core/types/speech';
import { cleanMarkdownForSpeech, splitMarkdownIntoSpeechChunks } from '@core/markdown';
import { useSpeech } from '@features/settings/hooks/useSpeech';
import { playWavBase64, startSpeechQueue, stopSpeechAudio } from '@infra/audio-player';

/**
 * Extracts readable assistant speech text from a ChatMessage.
 * Prefers text blocks over raw content when structured activity blocks are present,
 * avoiding speaking raw tool call payloads, thinking tokens, or error envelopes,
 * and strips Markdown syntax so TTS articulates natural spoken prose.
 */
export function extractAssistantSpeechText(msg: ChatMessage): string {
  let raw = '';
  if (msg.blocks && msg.blocks.length > 0) {
    const textBlocks = msg.blocks.filter(
      (b): b is TextBlock => b.type === 'text' && typeof (b as TextBlock).text === 'string'
    );
    if (textBlocks.length > 0) {
      const combined = textBlocks
        .map((b) => b.text.trim())
        .filter((t) => t.length > 0)
        .join('\n\n');
      if (combined.length > 0) {
        raw = combined;
      }
    }
  }
  if (!raw) {
    raw = msg.content || '';
  }
  return cleanMarkdownForSpeech(raw);
}

export interface ShouldTriggerAutoSpeechParams {
  wasBusy: boolean;
  currentActivity: AgentActivity;
  ttsEnabled?: boolean;
  lastMessage?: ChatMessage | null;
  lastSpokenId?: string | null;
}

/**
 * Pure state machine evaluator deciding if auto-TTS should trigger on agent settlement.
 */
export function shouldTriggerAutoSpeech(params: ShouldTriggerAutoSpeechParams): boolean {
  const {
    wasBusy,
    currentActivity,
    ttsEnabled,
    lastMessage,
    lastSpokenId,
  } = params;

  // Must be an active transition from busy -> idle
  if (!wasBusy || currentActivity !== 'idle') {
    return false;
  }

  // If user explicitly disabled TTS in preferences, respect that
  if (ttsEnabled === false) {
    return false;
  }

  // Must have an assistant response message
  if (!lastMessage || lastMessage.role !== 'assistant') {
    return false;
  }

  // Never speak aborted / cancelled turns
  if (lastMessage.isCancelled) {
    return false;
  }

  // Deduplicate against already spoken messages
  if (lastSpokenId && lastMessage.id === lastSpokenId) {
    return false;
  }

  // Must contain spoken text
  const text = extractAssistantSpeechText(lastMessage);
  if (!text) {
    return false;
  }

  return true;
}

export interface UseAutoSpeechOptions {
  messages: ChatMessage[];
  agentActivity: AgentActivity;
  sessionId?: string | null;
  preferences?: SpeechPreferences;
}

/**
 * React hook that triggers text-to-speech automatically when the agent completes its process.
 * Bound strictly to the React component lifecycle:
 * If the web view is closed or unmounted while the agent process continues running on the server,
 * no TTS request is ever made, saving CPU / Docker speech synthesis resources.
 */
export function useAutoSpeech({
  messages,
  agentActivity,
  sessionId,
  preferences,
}: UseAutoSpeechOptions): void {
  const { synthesize } = useSpeech();
  const isMountedRef = useRef<boolean>(true);
  const prevActivityRef = useRef<AgentActivity>(agentActivity);
  const prevSessionIdRef = useRef<string | null>(sessionId ?? null);
  const lastSpokenMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopSpeechAudio();
    };
  }, []);

  useEffect(() => {
    // If agent becomes busy with a new action, interrupt any currently playing audio immediately
    if (agentActivity === 'busy') {
      stopSpeechAudio();
    }

    // Guard against project/session switching triggering false auto-speech
    if (prevSessionIdRef.current !== (sessionId ?? null)) {
      prevSessionIdRef.current = sessionId ?? null;
      prevActivityRef.current = agentActivity;
      return;
    }

    const wasBusy = prevActivityRef.current === 'busy';
    prevActivityRef.current = agentActivity;

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

    const shouldTrigger = shouldTriggerAutoSpeech({
      wasBusy,
      currentActivity: agentActivity,
      ttsEnabled: preferences?.ttsEnabled,
      lastMessage: lastMsg,
      lastSpokenId: lastSpokenMessageIdRef.current,
    });

    if (!shouldTrigger || !lastMsg) {
      return;
    }

    lastSpokenMessageIdRef.current = lastMsg.id;
    const speechText = extractAssistantSpeechText(lastMsg);

    const activePrefs: SpeechPreferences = {
      ...DEFAULT_SPEECH_PREFERENCES,
      ...preferences,
      ttsEnabled: true, // ensure synthesis runner executes the voice generation
    };

    void (async () => {
      try {
        const rawContent = lastMsg.content || speechText;
        const chunks = splitMarkdownIntoSpeechChunks(rawContent);
        if (chunks.length === 0) return;

        const session = startSpeechQueue(lastMsg.id);

        for (let i = 0; i < chunks.length; i++) {
          if (!isMountedRef.current || session.isAborted()) break;

          const chunkText = chunks[i];
          const audioBase64 = await synthesize(chunkText, activePrefs, activePrefs.ttsRate);

          if (!isMountedRef.current || session.isAborted()) break;
          if (audioBase64) {
            await session.enqueue(audioBase64);
          }
        }

        session.finish();
      } catch (err) {
        // Prevent unhandled rejection when speech service is unavailable
        console.warn('[AutoSpeech] Synthesis failed:', err);
      }
    })();
  }, [agentActivity, messages, sessionId, preferences, synthesize]);
}
