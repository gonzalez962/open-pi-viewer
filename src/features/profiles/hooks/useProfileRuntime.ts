import { useCallback, useEffect, useRef } from 'react';
import type { ProfileSummary } from '@core/types/profiles';
import type { ModelInfo, ThinkingLevel } from '@core/types/models';
import {
  ProfileRuntimeCoordinator,
} from '../lib/profileRuntime';

export interface UseProfileRuntimeOptions {
  cwd?: string;
  sessionId: string | null;
  isConnected: boolean;
  isBusy: boolean;
  isSessionInitialized: boolean;
  effectiveProfile: ProfileSummary | null;
  availableModels: ModelInfo[];
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

export interface UseProfileRuntimeResult {
  isRestoring: boolean;
  recordManualSelection: () => void;
  resetManualSelection: () => void;
}

export function useProfileRuntime(options: UseProfileRuntimeOptions): UseProfileRuntimeResult {
  const coordinatorRef = useRef<ProfileRuntimeCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new ProfileRuntimeCoordinator();
  }
  const coordinator = coordinatorRef.current;

  const {
    cwd,
    sessionId,
    isConnected,
    isBusy,
    isSessionInitialized,
    effectiveProfile,
    availableModels,
    onSelectModel,
    onSelectThinkingLevel,
  } = options;

  useEffect(() => {
    void coordinator.restore({
      cwd,
      sessionId,
      isConnected,
      isBusy,
      isSessionInitialized,
      effectiveProfile,
      availableModels,
      onSelectModel,
      onSelectThinkingLevel,
    });
  }, [
    coordinator,
    cwd,
    sessionId,
    isConnected,
    isBusy,
    isSessionInitialized,
    effectiveProfile,
    availableModels,
    onSelectModel,
    onSelectThinkingLevel,
  ]);

  const recordManualSelection = useCallback(() => {
    coordinator.recordManualSelection(cwd, sessionId);
  }, [coordinator, cwd, sessionId]);

  const resetManualSelection = useCallback(() => {
    coordinator.resetManualSelection(cwd, sessionId);
  }, [coordinator, cwd, sessionId]);

  return {
    isRestoring: coordinator.isRestoring(),
    recordManualSelection,
    resetManualSelection,
  };
}
