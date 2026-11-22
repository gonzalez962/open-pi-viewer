import React, { useEffect, useState, useRef } from 'react';
import type { SpeechPreferences } from '@core/types/speech';
import { transcribeSpeechSttPi } from '@infra/bridge';
import { convertBlobToWav16kMono } from '@infra/wav-recorder';

export interface PromptMicButtonProps {
  preferences?: SpeechPreferences;
  onTranscription: (text: string) => void;
  onRecordingChange?: (recording: boolean) => void;
  disabled?: boolean;
}

export const PromptMicButton: React.FC<PromptMicButtonProps> = ({
  preferences,
  onTranscription,
  onRecordingChange,
  disabled,
}) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!isRecording) return;
    onRecordingChange?.(true);
    return () => onRecordingChange?.(false);
  }, [isRecording, onRecordingChange]);

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
        setIsRecording(false);
        try {
          const rawBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
          const wavBlob = await convertBlobToWav16kMono(rawBlob);

          const reader = new FileReader();
          reader.onloadend = async () => {
            const base64Data = (reader.result as string)?.split(',')[1];
            if (base64Data) {
              setIsTranscribing(true);
              try {
                const res = await transcribeSpeechSttPi({ audioBase64: base64Data, preferences });
                if (res.text && res.text.trim()) {
                  onTranscription(res.text.trim());
                }
              } catch {
                // ignore
              } finally {
                setIsTranscribing(false);
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
                setIsTranscribing(true);
                try {
                  const res = await transcribeSpeechSttPi({ audioBase64: base64Data, preferences });
                  if (res.text && res.text.trim()) {
                    onTranscription(res.text.trim());
                  }
                } catch {
                  // ignore
                } finally {
                  setIsTranscribing(false);
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

  // Busy only prevents starting a recording, never stopping an active one.
  const isDisabled = !isRecording && (disabled || isTranscribing);
  const handleToggle = () => {
    if (isRecording) {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } else if (!isDisabled) {
      void startRecording();
    }
  };

  return (
    <button
      type="button"
      className={`prompt-action-btn prompt-mic-btn ${isRecording ? 'is-recording' : ''}`}
      onClick={handleToggle}
      disabled={isDisabled}
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
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        boxShadow: isRecording
          ? '0 0 10px rgba(239, 68, 68, 0.6)'
          : '0 2px 5px rgba(0, 0, 0, 0.25)',
        transition: 'all 0.15s ease',
        fontSize: '0.82rem',
        opacity: isRecording ? 1 : 0.85,
      }}
    >
      {isRecording ? '🛑' : isTranscribing ? '⏳' : '🎤'}
    </button>
  );
};
