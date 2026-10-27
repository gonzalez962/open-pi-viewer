import { useState, useCallback, useEffect } from 'react';
import {
  getSpeechPackStatusPi,
  downloadSpeechPackPi,
  deleteSpeechPackPi,
  inspectCustomSpeechModelPi,
  synthesizeSpeechTtsPi,
  transcribeSpeechSttPi,
  checkWyomingServicePi,
  listenSpeechDownloadProgressPi,
  manageDockerSpeechServicePi,
  getDockerSpeechStatusPi,
  type SpeechDownloadProgressPayload,
  type DockerSpeechActionResult,
} from '../../../infra/bridge';
import type {
  SpeechPreferences,
  CustomModelConfig,
} from '../../../core/types/speech';

export interface UseSpeechReturn {
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress: Record<string, SpeechDownloadProgressPayload>;
  isDeleting: boolean;
  isSynthesizing: boolean;
  isTranscribing: boolean;
  error: string | null;
  checkPackStatus: (packId: string) => Promise<any>;
  downloadPack: (packId: string) => Promise<any>;
  deletePack: (packId: string) => Promise<any>;
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
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, SpeechDownloadProgressPayload>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listenSpeechDownloadProgressPi((prog) => {
      setDownloadProgress((prev) => ({
        ...prev,
        [prog.packId]: prog,
      }));
    }).then((un) => {
      unlisten = un;
    });

    return () => {
      unlisten?.();
    };
  }, []);

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
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[packId];
        return next;
      });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setIsDownloading(false);
    }
  }, []);

  const deletePack = useCallback(async (packId: string) => {
    setIsDeleting(true);
    setError(null);
    try {
      const res = await deleteSpeechPackPi({ packId });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setIsDeleting(false);
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
    isChecking,
    isDownloading,
    downloadProgress,
    isDeleting,
    isSynthesizing,
    isTranscribing,
    error,
    checkPackStatus,
    downloadPack,
    deletePack,
    validateCustomModel,
    synthesize,
    transcribe,
    checkWyomingStatus,
    manageDockerService,
    getDockerStatus,
  };
}
