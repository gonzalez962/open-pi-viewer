import { useState, useCallback } from 'react';
import {
  getSpeechPackStatusPi,
  downloadSpeechPackPi,
  inspectCustomSpeechModelPi,
  synthesizeSpeechTtsPi,
  transcribeSpeechSttPi,
} from '@infra/bridge';
import type {
  SpeechPreferences,
  CustomModelConfig,
} from '@core/types/speech';

export interface UseSpeechReturn {
  isChecking: boolean;
  isDownloading: boolean;
  isSynthesizing: boolean;
  isTranscribing: boolean;
  error: string | null;
  checkPackStatus: (packId: string) => Promise<any>;
  downloadPack: (packId: string) => Promise<any>;
  validateCustomModel: (config: CustomModelConfig) => Promise<any>;
  synthesize: (text: string, preferences: SpeechPreferences, rate?: number) => Promise<string | null>;
  transcribe: (audioBase64: string, preferences: SpeechPreferences) => Promise<string | null>;
}

export function useSpeech(): UseSpeechReturn {
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkPackStatus = useCallback(async (packId: string) => {
    setIsChecking(true);
    setError(null);
    try {
      const res = await getSpeechPackStatusPi({ packId });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setIsChecking(false);
    }
  }, []);

  const downloadPack = useCallback(async (packId: string) => {
    setIsDownloading(true);
    setError(null);
    try {
      const res = await downloadSpeechPackPi({ packId });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setIsDownloading(false);
    }
  }, []);

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
        return null;
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

  return {
    isChecking,
    isDownloading,
    isSynthesizing,
    isTranscribing,
    error,
    checkPackStatus,
    downloadPack,
    validateCustomModel,
    synthesize,
    transcribe,
  };
}
