import { useState, useCallback } from 'react';
import {
  inspectCustomSpeechModelPi,
  synthesizeSpeechTtsPi,
  transcribeSpeechSttPi,
  checkWyomingServicePi,
  manageDockerSpeechServicePi,
  getDockerSpeechStatusPi,
  type DockerSpeechActionResult,
} from '@infra/bridge';
import type {
  SpeechPreferences,
  CustomModelConfig,
} from '@core/types/speech';

export interface UseSpeechReturn {
  isSynthesizing: boolean;
  isTranscribing: boolean;
  error: string | null;
  validateCustomModel: (config: CustomModelConfig) => Promise<any>;
  synthesize: (text: string, preferences: SpeechPreferences, rate?: number) => Promise<string | null>;
  transcribe: (audioBase64: string, preferences: SpeechPreferences) => Promise<string | null>;
  checkWyomingStatus: (url: string) => Promise<{ ok: boolean; info?: any; error?: string }>;
  manageDockerService: (
    service: 'piper' | 'whisper',
    action: 'status' | 'start' | 'stop' | 'restart' | 'remove' | 'create',
    preferences: SpeechPreferences
  ) => Promise<DockerSpeechActionResult>;
  getDockerStatus: (service: 'piper' | 'whisper') => Promise<{ exists: boolean; state: string; statusText?: string }>;
}

export function useSpeech(): UseSpeechReturn {
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateCustomModel = useCallback(async (config: CustomModelConfig) => {
    setError(null);
    try {
      const res = await inspectCustomSpeechModelPi({
        isCustom: config.isCustom,
        modelPath: config.modelPath,
        configPath: config.configPath,
        tokensPath: config.tokensPath,
      });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return { valid: false, error: msg };
    }
  }, []);

  const synthesize = useCallback(
    async (text: string, preferences: SpeechPreferences, rate?: number): Promise<string | null> => {
      setIsSynthesizing(true);
      setError(null);
      try {
        const res = await synthesizeSpeechTtsPi({ text, preferences, rate });
        return res.audioBase64;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setIsSynthesizing(false);
      }
    },
    []
  );

  const transcribe = useCallback(
    async (audioBase64: string, preferences: SpeechPreferences): Promise<string | null> => {
      setIsTranscribing(true);
      setError(null);
      try {
        const res = await transcribeSpeechSttPi({ audioBase64, preferences });
        return res.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      } finally {
        setIsTranscribing(false);
      }
    },
    []
  );

  const checkWyomingStatus = useCallback(async (url: string) => {
    try {
      return await checkWyomingServicePi({ url });
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }, []);

  const manageDockerService = useCallback(
    async (
      service: 'piper' | 'whisper',
      action: 'status' | 'start' | 'stop' | 'restart' | 'remove' | 'create',
      preferences: SpeechPreferences
    ) => {
      return await manageDockerSpeechServicePi({ service, action, preferences });
    },
    []
  );

  const getDockerStatus = useCallback(async (service: 'piper' | 'whisper') => {
    return await getDockerSpeechStatusPi({ service });
  }, []);

  return {
    isSynthesizing,
    isTranscribing,
    error,
    validateCustomModel,
    synthesize,
    transcribe,
    checkWyomingStatus,
    manageDockerService,
    getDockerStatus,
  };
}
