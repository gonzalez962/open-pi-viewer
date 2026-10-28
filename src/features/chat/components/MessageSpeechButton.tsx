import React, { useState, useEffect } from 'react';
import { DEFAULT_SPEECH_PREFERENCES, type SpeechPreferences } from '@core/types/speech';
import { splitMarkdownIntoSpeechChunks } from '@core/markdown';
import { synthesizeSpeechTtsPi } from '@infra/bridge';
import {
  startSpeechQueue,
  pauseSpeechAudio,
  resumeSpeechAudio,
  stopSpeechAudio,
  subscribeSpeechPlayback,
  getSpeechPlaybackState,
  type SpeechPlaybackState,
} from '@infra/audio-player';

export interface MessageSpeechButtonProps {
  text: string;
  preferences?: SpeechPreferences;
  messageId?: string;
}

export const MessageSpeechButton: React.FC<MessageSpeechButtonProps> = ({
  text,
  preferences,
  messageId,
}) => {
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [playbackState, setPlaybackState] = useState<SpeechPlaybackState>(getSpeechPlaybackState);

  useEffect(() => {
    return subscribeSpeechPlayback((state) => {
      setPlaybackState(state);
    });
  }, []);

  if (!preferences?.ttsEnabled) {
    return null;
  }

  const trackKey = messageId || text;
  const isThisActive =
    playbackState.isActive &&
    Boolean(
      (messageId && playbackState.currentTrackId === messageId) ||
      playbackState.currentTrackId === text ||
      playbackState.currentTrackId === trackKey
    );

  const isThisPlaying = isThisActive && playbackState.isPlaying;
  const isThisPaused = isThisActive && playbackState.isPaused;

  const handleToggle = async () => {
    // 1. If this message is currently speaking -> PAUSE it
    if (isThisPlaying) {
      await pauseSpeechAudio();
      return;
    }

    // 2. If this message is currently paused -> RESUME it
    if (isThisPaused) {
      await resumeSpeechAudio();
      return;
    }

    // 3. Otherwise, synthesize and stream-play paragraph by paragraph
    if (isSynthesizing) return;

    setIsSynthesizing(true);
    try {
      const activePrefs: SpeechPreferences = {
        ...DEFAULT_SPEECH_PREFERENCES,
        ...preferences,
        ttsEnabled: true,
      };

      const chunks = splitMarkdownIntoSpeechChunks(text);
      if (chunks.length === 0) return;

      const session = startSpeechQueue(trackKey);

      for (let i = 0; i < chunks.length; i++) {
        if (session.isAborted()) break;

        const chunkText = chunks[i];
        const res = await synthesizeSpeechTtsPi({ text: chunkText, preferences: activePrefs, rate: activePrefs.ttsRate });
        const audioBase64 = res.audioBase64;

        if (session.isAborted()) break;
        if (audioBase64) {
          await session.enqueue(audioBase64);
        }
      }

      session.finish();
    } catch {
      // ignore
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopSpeechAudio();
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <button
        type="button"
        className={`message-speech-play-btn ${isThisPlaying ? 'is-playing' : isThisPaused ? 'is-paused' : ''}`}
        onClick={handleToggle}
        disabled={isSynthesizing && !isThisActive}
        title={
          isThisPlaying
            ? 'Pausar lectura'
            : isThisPaused
            ? 'Reanudar lectura'
            : isSynthesizing
            ? 'Sintetizando...'
            : 'Escuchar mensaje (TTS Local)'
        }
        style={{
          background: isThisPlaying
            ? 'rgba(239, 68, 68, 0.15)'
            : isThisPaused
            ? 'rgba(234, 179, 8, 0.15)'
            : 'transparent',
          border: isThisPlaying
            ? '1px solid rgba(239, 68, 68, 0.4)'
            : isThisPaused
            ? '1px solid rgba(234, 179, 8, 0.4)'
            : 'none',
          color: isThisPlaying ? '#ef4444' : isThisPaused ? '#eab308' : 'inherit',
          cursor: 'pointer',
          opacity: isSynthesizing && !isThisActive ? 0.6 : 1,
          padding: '2px 8px',
          fontSize: '0.85rem',
          borderRadius: '4px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          transition: 'all 0.15s ease',
        }}
      >
        {isSynthesizing && !isThisActive ? (
          '⏳'
        ) : isThisPlaying ? (
          <>
            <span>⏸</span>
            <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Pausar</span>
          </>
        ) : isThisPaused ? (
          <>
            <span>▶</span>
            <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Reanudar</span>
          </>
        ) : (
          '🔈'
        )}
      </button>

      {/* Stop button shown while active (playing or paused) */}
      {isThisActive && (
        <button
          type="button"
          className="message-speech-stop-btn"
          onClick={handleStop}
          title="Detener lectura"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#ef4444',
            cursor: 'pointer',
            padding: '2px 6px',
            fontSize: '0.8rem',
            borderRadius: '4px',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          ⏹
        </button>
      )}
    </div>
  );
};
