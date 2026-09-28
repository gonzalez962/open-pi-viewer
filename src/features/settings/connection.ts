import { connectPi, ensureBridgeListenersReady } from '@infra/bridge';
import {
  resolveSessionResumePlan,
  saveSessionRecord,
  type SessionResumePlan,
} from '@core/session';
import type {
  ConnectConfig,
  ConnectionState,
  ConnectResult,
  ConnectSessionOptions,
} from '@core/types/connection';
import type { ConfigSaveResult } from '@features/settings/config';

/**
 * Determine whether explicit Retry is available based on connection state.
 *
 * Both 'disconnected' (clean process exit/offline) and 'error' (spawn or runtime failure)
 * allow explicit manual reconnection using applied settings.
 *
 * In-progress states ('connecting') and established states ('connected') do not offer retry.
 */
export function canRetryConnection(status: ConnectionState): boolean {
  return status === 'disconnected' || status === 'error';
}

export interface ConfigApplyOutcome {
  /** Notice to surface in the settings panel; null clears any previous notice. */
  settingsStorageNotice: string | null;
  /** Whether the connection-load storage warning (from the initial config read) should be cleared. */
  clearConnectionStorageWarning: boolean;
}

/**
 * Decides the settings-panel notice and connection-load-warning outcome of persisting
 * a new connect config, given the already-computed save result. Mirrors the identical
 * if/else branching that used to live inline in both App.tsx's former
 * `applyProjectConnectConfig` (project switch) and `handleSaveAndApplySettings`
 * (settings panel save): on failure, surface the save error (or a default message) as
 * the settings storage notice and leave the connection-load warning untouched; on
 * success, clear both.
 */
export function resolveConfigApplyOutcome(
  saveResult: ConfigSaveResult
): ConfigApplyOutcome {
  if (!saveResult.success) {
    return {
      settingsStorageNotice:
        saveResult.error || 'Failed to save configuration to local storage',
      clearConnectionStorageWarning: false,
    };
  }
  return { settingsStorageNotice: null, clearConnectionStorageWarning: true };
}

export interface StartupManagerOptions {
  connectFn?: (
    config: ConnectConfig,
    sessionOptions?: ConnectSessionOptions
  ) => Promise<ConnectResult>;
  ensureListenersReadyFn?: () => Promise<void>;
  onStart?: (config: ConnectConfig) => void;
  onSuccess?: (result: ConnectResult) => void;
  onError?: (error: string, config?: ConnectConfig) => void;
  scheduleFn?: (callback: () => void) => void;
  storage?: Storage | null;
  resolveResumePlanFn?: (cwd: string) => SessionResumePlan;
}

/**
 * Real outcome of one connection attempt, resolved by `start()`/`retry()` only after the
 * attempt settled: 'success' after onSuccess fired, 'error' after onError fired, and
 * 'cancelled' when the attempt was cancelled or superseded (its callbacks were dropped).
 */
export type AttemptOutcome =
  | { status: 'success' }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

const CANCELLED: AttemptOutcome = { status: 'cancelled' };

export interface ActiveAttempt {
  readonly id: number;
  readonly config: ConnectConfig;
  readonly freshSession?: boolean;
  cancelled: boolean;
}

/**
 * StartupManager manages connection lifecycle and startup attempt identity.
 *
 * Prevents duplicate competing startups and stale dispatches under React StrictMode:
 * 1. Cancelled-before-invocation scheduling: StrictMode's synchronous cleanup
 *    cancels the initial attempt before its microtask invocation begins.
 * 2. Lifetime attempt identity: Each attempt holds an incrementing integer ID.
 *    Any callback (success or error) from an older, cancelled, or superseded
 *    attempt is discarded without dispatching to the store.
 * 3. Bridge listener readiness: Awaits bridge listener attachment before
 *    invoking backend connection.
 * 4. Startup coalescing: Concurrent start requests for identical configs reuse
 *    the in-flight attempt rather than launching competing child processes.
 * 5. Explicit retry: Forces a new attempt identity and clears previous failures
 *    without touching or replaying user prompt messages.
 */
export class StartupManager {
  private nextAttemptId = 0;
  private activeAttempt: ActiveAttempt | null = null;
  private options: StartupManagerOptions;
  private inFlightPromise: Promise<AttemptOutcome> | null = null;

  constructor(options: StartupManagerOptions = {}) {
    this.options = options;
  }

  updateOptions(options: Partial<StartupManagerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  getActiveAttempt(): ActiveAttempt | null {
    return this.activeAttempt;
  }

  isInFlight(): boolean {
    return this.inFlightPromise !== null;
  }

  cancel(): void {
    if (this.activeAttempt) {
      this.activeAttempt.cancelled = true;
      this.activeAttempt = null;
    }
  }

  start(
    config: ConnectConfig,
    options: { force?: boolean; freshSession?: boolean } = {}
  ): Promise<AttemptOutcome> {
    // If an attempt is already active with the exact same config and not forced, coalesce
    if (
      !options.force &&
      !options.freshSession &&
      this.activeAttempt &&
      !this.activeAttempt.cancelled &&
      this.isSameConfig(this.activeAttempt.config, config) &&
      this.inFlightPromise
    ) {
      return this.inFlightPromise;
    }

    // Invalidate and cancel any prior active attempt
    this.cancel();

    const attempt: ActiveAttempt = {
      id: ++this.nextAttemptId,
      config: { ...config },
      freshSession: options.freshSession,
      cancelled: false,
    };
    this.activeAttempt = attempt;

    const schedule =
      this.options.scheduleFn ?? ((cb: () => void) => queueMicrotask(cb));

    let resolvePromise: (outcome: AttemptOutcome) => void;
    const promise = new Promise<AttemptOutcome>((resolve) => {
      resolvePromise = resolve;
    });
    this.inFlightPromise = promise;

    schedule(() => {
      // Cancelled-before-invocation:
      // If StrictMode cleanup ran before this microtask, attempt.cancelled is true
      if (attempt.cancelled || this.activeAttempt?.id !== attempt.id) {
        if (this.activeAttempt?.id === attempt.id) {
          this.inFlightPromise = null;
        }
        resolvePromise(CANCELLED);
        return;
      }

      let outcome: AttemptOutcome = CANCELLED;
      void this.executeAttempt(attempt)
        .then((result) => {
          outcome = result;
        })
        .finally(() => {
          if (this.activeAttempt?.id === attempt.id) {
            this.inFlightPromise = null;
          }
          resolvePromise(outcome);
        });
    });

    return promise;
  }

  retry(config?: ConnectConfig): Promise<AttemptOutcome> {
    const targetConfig = config ?? this.activeAttempt?.config;
    if (!targetConfig) {
      return Promise.resolve(CANCELLED);
    }
    return this.start(targetConfig, { force: true });
  }

  private isSameConfig(a: ConnectConfig, b: ConnectConfig): boolean {
    return (
      a.nodePath === b.nodePath &&
      a.piEntrypoint === b.piEntrypoint &&
      a.workingDirectory === b.workingDirectory
    );
  }

  private async executeAttempt(attempt: ActiveAttempt): Promise<AttemptOutcome> {
    if (attempt.cancelled || this.activeAttempt?.id !== attempt.id) {
      return CANCELLED;
    }

    this.options.onStart?.(attempt.config);

    try {
      const ensureListeners =
        this.options.ensureListenersReadyFn ?? ensureBridgeListenersReady;
      await ensureListeners();

      if (attempt.cancelled || this.activeAttempt?.id !== attempt.id) {
        return CANCELLED;
      }

      // Determine session resumption options based on attempt type and recorded identity
      let sessionOptions: ConnectSessionOptions | undefined;
      if (attempt.freshSession) {
        // Explicit fresh session requested: never pass sessionFile
        sessionOptions = {
          sessionFile: undefined,
          requireSessionFileExists: false,
        };
      } else {
        const resolvePlan =
          this.options.resolveResumePlanFn ??
          ((cwd: string) => resolveSessionResumePlan(cwd, this.options.storage));
        const plan = resolvePlan(attempt.config.workingDirectory);

        if (plan.type === 'first_opening') {
          sessionOptions = {
            sessionFile: undefined,
            requireSessionFileExists: false,
          };
        } else if (plan.type === 'resume_empty') {
          sessionOptions = {
            sessionFile: plan.record.sessionFile,
            requireSessionFileExists: false,
          };
        } else if (plan.type === 'resume_existing') {
          sessionOptions = {
            sessionFile: plan.record.sessionFile,
            requireSessionFileExists: true,
          };
        }
      }

      const connect = this.options.connectFn ?? connectPi;
      const result = await connect(attempt.config, sessionOptions);

      if (attempt.cancelled || this.activeAttempt?.id !== attempt.id) {
        return CANCELLED;
      }

      // On successful connection, persist or reconcile durable session record
      if (result.sessionId && result.sessionFile) {
        saveSessionRecord(
          {
            sessionId: result.sessionId,
            sessionFile: result.sessionFile,
            cwd: attempt.config.workingDirectory,
            hasMessages: (result.messageCount ?? 0) > 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          this.options.storage
        );
      }

      this.options.onSuccess?.(result);
      return { status: 'success' };
    } catch (err: unknown) {
      if (attempt.cancelled || this.activeAttempt?.id !== attempt.id) {
        return CANCELLED;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      this.options.onError?.(errorMsg, attempt.config);
      return { status: 'error', error: errorMsg };
    }
  }
}
