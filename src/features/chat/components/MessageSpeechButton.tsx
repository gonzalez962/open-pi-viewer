import React, { useState } from 'react';
import { useSpeech } from '@features/settings/hooks/useSpeech';
import type { SpeechPreferences } from '@core/types/speech';
import { playWavBase64 } from '@infra/audio-player';

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

  if (!preferences?.ttsEnabled) {
    return null;
  }

  const handlePlay = async () => {
    if (isPlaying || isSynthesizing) return;
    try {
      const audioBase64 = await synthesize(text, preferences);
      if (audioBase64) {
        setIsPlaying(true);
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
      className="message-speech-play-btn"
      onClick={handlePlay}
      disabled={isSynthesizing || isPlaying}
      title={isPlaying ? 'Reproduciendo audio...' : 'Escuchar mensaje (TTS Local)'}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        opacity: isPlaying ? 1 : 0.6,
        padding: '2px 6px',
        fontSize: '0.85rem',
        borderRadius: '4px',
      }}
    >
      {isSynthesizing ? '⏳' : isPlaying ? '🔊' : '🔈'}
    </button>
  );
};
