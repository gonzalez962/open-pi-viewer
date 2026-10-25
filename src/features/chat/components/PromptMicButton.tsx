import React, { useState, useRef } from 'react';
import { useSpeech } from '@features/settings/hooks/useSpeech';
import type { SpeechPreferences } from '@core/types/speech';

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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
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
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
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
        padding: '0 8px',
        color: isRecording ? '#ef4444' : 'inherit',
      }}
    >
      {isTranscribing ? '⏳' : isRecording ? '🛑' : '🎤'}
    </button>
  );
};
