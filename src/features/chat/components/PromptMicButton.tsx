import React, { useState, useRef } from 'react';
import { useSpeech } from '@features/settings/hooks/useSpeech';
import type { SpeechPreferences } from '@core/types/speech';
import { convertBlobToWav16kMono } from '@infra/wav-recorder';

export interface PromptMicButtonProps {
  preferences?: SpeechPreferences;
  onTranscription: (text: string) => void;
  disabled?: boolean;
}

export const PromptMicButton: React.FC<PromptMicButtonProps> = ({
  preferences,
  onTranscription,
  disabled,
}) => {
  const { transcribe, isTranscribing } = useSpeech();
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  if (!preferences?.sttEnabled) {
    return null;
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        try {
          const rawBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
          const wavBlob = await convertBlobToWav16kMono(rawBlob);

          const reader = new FileReader();
          reader.onloadend = async () => {
            const base64Data = (reader.result as string)?.split(',')[1];
            if (base64Data) {
              const text = await transcribe(base64Data, preferences);
              if (text && text.trim()) {
                onTranscription(text.trim());
              }
            }
          };
          reader.readAsDataURL(wavBlob);
        } catch (convErr) {
          // If Web Audio decoding fails in older browser context, fallback to raw blob
          try {
            const rawBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64Data = (reader.result as string)?.split(',')[1];
              if (base64Data) {
                const text = await transcribe(base64Data, preferences);
                if (text && text.trim()) {
                  onTranscription(text.trim());
                }
              }
            };
            reader.readAsDataURL(rawBlob);
          } catch {}
        } finally {
          stream.getTracks().forEach((track) => track.stop());
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleToggle = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <button
      type="button"
      className={`prompt-action-btn prompt-mic-btn ${isRecording ? 'is-recording' : ''}`}
      onClick={handleToggle}
      disabled={disabled || isTranscribing}
      title={isRecording ? 'Detener grabación de voz' : 'Hablar (STT Local)'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '30px',
        height: '30px',
        borderRadius: '50%',
        border: isRecording ? '1px solid #ef4444' : '1px solid var(--border-color, #404040)',
        background: isRecording ? 'rgba(239, 68, 68, 0.2)' : 'var(--card-bg, #262626)',
        color: isRecording ? '#ef4444' : 'inherit',
        cursor: disabled || isTranscribing ? 'not-allowed' : 'pointer',
        boxShadow: isRecording ? '0 0 8px rgba(239, 68, 68, 0.4)' : '0 1px 3px rgba(0,0,0,0.2)',
        transition: 'all 0.15s ease',
        fontSize: '0.9rem',
      }}
    >
      {isTranscribing ? '⏳' : isRecording ? '🛑' : '🎤'}
    </button>
  );
};
