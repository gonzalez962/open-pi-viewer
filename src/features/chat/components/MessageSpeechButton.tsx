import React, { useState, useEffect } from 'react';
import { useSpeech } from '@features/settings/hooks/useSpeech';
import type { SpeechPreferences } from '@core/types/speech';
import { playWavBase64, stopSpeechAudio } from '@infra/audio-player';

export interface MessageSpeechButtonProps {
  text: string;
  preferences?: SpeechPreferences;
}

export const MessageSpeechButton: React.FC<MessageSpeechButtonProps> = ({
  text,
  preferences,
}) => {
  const { synthesize, isSynthesizing } = useSpeech();
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    return () => {
      // If unmounted while this component was the active speaker, stop audio
      if (isPlaying) {
        stopSpeechAudio();
      }
    };
  }, [isPlaying]);

  if (!preferences?.ttsEnabled) {
    return null;
  }

  const handleToggle = async () => {
    if (isPlaying) {
      stopSpeechAudio();
      setIsPlaying(false);
      return;
    }

    if (isSynthesizing) return;

    try {
      setIsPlaying(true);
      const audioBase64 = await synthesize(text, preferences);
      if (audioBase64) {
        await playWavBase64(audioBase64);
      }
    } catch {
      // ignore
    } finally {
      setIsPlaying(false);
    }
  };

  return (
    <button
      type="button"
      className={`message-speech-play-btn ${isPlaying ? 'is-playing' : ''}`}
      onClick={handleToggle}
      disabled={isSynthesizing && !isPlaying}
      title={isPlaying ? 'Detener lectura' : isSynthesizing ? 'Sintetizando...' : 'Escuchar mensaje (TTS Local)'}
      style={{
        background: isPlaying ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
        border: isPlaying ? '1px solid rgba(239, 68, 68, 0.4)' : 'none',
        color: isPlaying ? '#ef4444' : 'inherit',
        cursor: 'pointer',
        opacity: isSynthesizing && !isPlaying ? 0.6 : 1,
        padding: '2px 8px',
        fontSize: '0.85rem',
        borderRadius: '4px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        transition: 'all 0.15s ease',
      }}
    >
      {isSynthesizing ? (
        '⏳'
      ) : isPlaying ? (
        <>
          <span>⏹</span>
          <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Parar</span>
        </>
      ) : (
        '🔈'
      )}
    </button>
  );
};
