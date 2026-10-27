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
        position: 'absolute',
        left: '8px',
        bottom: '8px',
        zIndex: 5,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        borderRadius: '6px',
        border: isRecording ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.1)',
        background: isRecording
          ? 'rgba(239, 68, 68, 0.3)'
          : 'rgba(30, 30, 30, 0.65)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        color: isRecording ? '#ef4444' : 'inherit',
        cursor: disabled || isTranscribing ? 'not-allowed' : 'pointer',
        boxShadow: isRecording
          ? '0 0 10px rgba(239, 68, 68, 0.6)'
          : '0 2px 5px rgba(0, 0, 0, 0.25)',
        transition: 'all 0.15s ease',
        fontSize: '0.82rem',
        opacity: isRecording ? 1 : 0.85,
      }}
    >
      {isTranscribing ? '⏳' : isRecording ? '🛑' : '🎤'}
    </button>
  );
};
