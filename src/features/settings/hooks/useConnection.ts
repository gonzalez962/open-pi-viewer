import { useCallback, useRef, useState } from 'react';
import { isConfigReady, loadConnectConfig, saveConnectConfig } from '@features/settings/config';
import {
  resolveConfigApplyOutcome,
  StartupManager,
  type AttemptOutcome,
  type ConfigApplyOutcome,
} from '@features/settings/connection';
import type { ConnectConfig, ConnectResult } from '@core/types/connection';

export interface UseConnectionOptions {
  /** Forwarded to StartupManager as onStart; App.tsx dispatches CONNECT_START. */
  onConnectStart: (config: ConnectConfig) => void;
  /**
   * Forwarded to StartupManager as onSuccess; App.tsx dispatches SESSION_READY from the
   * result and pins/jumps the chat scroll (owned by the chat feature, not imported here).
   */
  onConnectSuccess: (result: ConnectResult) => void;
  /** Forwarded to StartupManager as onError; App.tsx dispatches CONNECT_FAIL. */
  onConnectError: (error: string, config?: ConnectConfig) => void;
  /**
   * Settings-panel state writes (settingsDraft/settingsError/showSettings) triggered when
   * a working directory is applied from the projects cluster. The settings panel state
   * itself stays owned by App.tsx this slice; this hook only reports the outcome.
   */
  onConfigApplied: (config: ConnectConfig, outcome: ConfigApplyOutcome) => void;
}

export interface UseConnectionResult {
  config: ConnectConfig;
  isReady: boolean;
  storageWarning: string | null;
  /**
   * Raw setter, exposed so the (untouched, T5d-scoped) session-events cluster can report
   * a persistence warning exactly as it did when `storageWarning` was plain App.tsx
   * state (`SessionEventController`'s `onStorageWarning` callback).
   */
  setStorageWarning: (warning: string | null) => void;
  /** Imperative primitive used by App.tsx's mount effect (fused with session-events, see note below). */
  startConnection: (
    config: ConnectConfig,
    options?: { force?: boolean; freshSession?: boolean }
  ) => Promise<void>;
  /** Imperative primitive used by App.tsx's mount effect cleanup. */
  cancelConnection: () => void;
  /**
   * Underlies handleRetry; the isConnecting/isResetting guard stays in App.tsx (reducer
   * state, not owned here). Resolves with the attempt's real outcome after its
   * onConnectSuccess/onConnectError callback fired (Issue #9 T6's "/reload" report).
   */
  retryConnection: (config?: ConnectConfig) => Promise<AttemptOutcome>;
  /**
   * Applies an already-validated config directly (used by the settings-panel save path,
   * handleSaveAndApplySettings, which stays in App.tsx this slice). Saves, updates config
   * and the connection-load storage warning, forces a reconnect, and returns the outcome
   * so the caller can update its own settings-panel notice state.
   */
  applyConfig: (config: ConnectConfig) => ConfigApplyOutcome;
  /**
   * Applies a new working directory onto the current config (used by the projects
   * cluster's applyWorkingDirectory inversion point). Delegates to applyConfig and then
   * reports settings-panel writes via onConfigApplied.
   */
  applyWorkingDirectory: (workingDirectory: string) => void;
}

/**
 * Owns the connection cluster: persisted ConnectConfig, the connection-load storage
 * warning, and the StartupManager instance (attempt lifecycle, coalescing, retry).
 *
 * Fix folded into this extraction, mirroring T5b's usePreferences fix: App.tsx used to
 * call loadConnectConfig() twice at mount (once per lazy initializer) to derive `config`
 * and `storageWarning` from one storage read. loadConnectConfig() is a pure
 * localStorage.getItem + JSON.parse + validate with no side effect (see
 * src/features/settings/config.ts), so the two calls always produced the same snapshot -
 * the duplication was wasted work, not a correctness difference. The read is done once
 * into a ref below and feeds both pieces of state.
 */
export function useConnection({
  onConnectStart,
  onConnectSuccess,
  onConnectError,
  onConfigApplied,
}: UseConnectionOptions): UseConnectionResult {
  const initialLoadRef = useRef<ReturnType<typeof loadConnectConfig> | null>(null);
  if (!initialLoadRef.current) {
    initialLoadRef.current = loadConnectConfig();
  }
  const [config, setConfig] = useState<ConnectConfig>(() => initialLoadRef.current!.config);
  const [storageWarning, setStorageWarning] = useState<string | null>(
    () => initialLoadRef.current!.warning ?? null
  );

  // Track the last successfully persisted configuration to avoid duplicate writes on startup with existing saved settings
  const lastPersistedConfigRef = useRef<ConnectConfig | null>(
    initialLoadRef.current!.source === 'stored' ? initialLoadRef.current!.config : null
  );

  const handleSuccess = useCallback(
    (result: ConnectResult) => {
      // Persist successful discovered configuration after validated connection success (not before)
      const currentAttempt = startupManagerRef.current?.getActiveAttempt();
      if (currentAttempt && !currentAttempt.cancelled && isConfigReady(currentAttempt.config)) {
        const attemptConfig = currentAttempt.config;
        const alreadyPersisted =
          lastPersistedConfigRef.current &&
          lastPersistedConfigRef.current.nodePath === attemptConfig.nodePath &&
          lastPersistedConfigRef.current.piEntrypoint === attemptConfig.piEntrypoint &&
          lastPersistedConfigRef.current.workingDirectory === attemptConfig.workingDirectory &&
          lastPersistedConfigRef.current.fileTreeRefreshInterval === attemptConfig.fileTreeRefreshInterval;

        if (!alreadyPersisted) {
          const saveRes = saveConnectConfig(attemptConfig);
          if (saveRes.success) {
            lastPersistedConfigRef.current = { ...attemptConfig };
          }
        }
      }
      onConnectSuccess(result);
    },
    [onConnectSuccess]
  );

  // StartupManager instance managing attempt identity and StrictMode cancellation.
  // Callbacks are captured once here, at first construction, exactly matching the
  // original App.tsx behavior where onStart/onSuccess/onError closed over the mount-time
  // dispatch/pinAndJumpToBottom and were never rebuilt on subsequent renders.
  const startupManagerRef = useRef<StartupManager | null>(null);
  if (!startupManagerRef.current) {
    startupManagerRef.current = new StartupManager({
      onStart: onConnectStart,
      onSuccess: handleSuccess,
      onError: onConnectError,
    });
  }

  startupManagerRef.current.updateOptions({
    onStart: onConnectStart,
    onSuccess: handleSuccess,
    onError: onConnectError,
  });

  const startConnection = useCallback(
    (cfg: ConnectConfig, options?: { force?: boolean; freshSession?: boolean }) => {
      setConfig((prev) => {
        if (
          prev.nodePath !== cfg.nodePath ||
          prev.piEntrypoint !== cfg.piEntrypoint ||
          prev.workingDirectory !== cfg.workingDirectory ||
          prev.fileTreeRefreshInterval !== cfg.fileTreeRefreshInterval
        ) {
          return { ...cfg };
        }
        return prev;
      });
      const attempt = startupManagerRef.current?.start(cfg, options);
      return attempt ? attempt.then(() => undefined) : Promise.resolve();
    },
    []
  );

  const cancelConnection = useCallback(() => {
    startupManagerRef.current?.cancel();
  }, []);

  const retryConnection = useCallback(
    (cfg?: ConnectConfig) => {
      const targetConfig = cfg ?? config;
      if (!isConfigReady(targetConfig)) {
        const error =
          'Configuration is incomplete. Please configure Pi CLI entrypoint and working directory in Settings.';
        onConnectError(error, targetConfig);
        return Promise.resolve<AttemptOutcome>({ status: 'error', error });
      }
      return (
        startupManagerRef.current?.retry(targetConfig) ??
        Promise.resolve<AttemptOutcome>({ status: 'cancelled' })
      );
    },
    [config, onConnectError]
  );

  const applyConfig = useCallback((newConfig: ConnectConfig): ConfigApplyOutcome => {
    const saveResult = saveConnectConfig(newConfig);
    const outcome = resolveConfigApplyOutcome(saveResult);

    if (saveResult.success) {
      lastPersistedConfigRef.current = { ...newConfig };
    }

    setConfig(newConfig);
    if (outcome.clearConnectionStorageWarning) {
      setStorageWarning(null);
    }

    void startupManagerRef.current?.start(newConfig, { force: true });

    return outcome;
  }, []);

  const applyWorkingDirectory = useCallback(
    (workingDirectory: string) => {
      const updatedConfig: ConnectConfig = { ...config, workingDirectory };
      const outcome = applyConfig(updatedConfig);
      onConfigApplied(updatedConfig, outcome);
    },
    [config, applyConfig, onConfigApplied]
  );

  return {
    config,
    isReady: isConfigReady(config),
    storageWarning,
    setStorageWarning,
    startConnection,
    cancelConnection,
    retryConnection,
    applyConfig,
    applyWorkingDirectory,
  };
}
