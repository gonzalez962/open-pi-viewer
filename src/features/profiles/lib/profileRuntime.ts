import {
  applyProfileRuntime,
  resolveProfileModel,
  resolveProfileEffort,
  type ProfileSummary,
} from '@core/types/profiles';
import type { ModelInfo, ThinkingLevel } from '@core/types/models';

export interface ProfileRuntimeContext {
  cwd?: string;
  sessionId?: string | null;
}

export function createProfileRuntimeContextKey(cwd?: string, sessionId?: string | null): string {
  return `${cwd ?? ''}::${sessionId ?? ''}`;
}

export interface RestorationDecisionInput {
  isConnected: boolean;
  isBusy: boolean;
  isSessionInitialized: boolean;
  isProfilesLoaded?: boolean;
  loadedCwd?: string;
  cwd?: string;
  currentContextKey: string;
  lastRestoredContextKey: string | null;
  manualSelectionContextKey: string | null;
  effectiveProfile: ProfileSummary | null;
}

export type RestorationDecisionReason =
  | 'not_connected'
  | 'busy'
  | 'not_initialized'
  | 'profiles_loading'
  | 'stale_cwd'
  | 'manual_selection_preserved'
  | 'already_restored'
  | 'no_profile'
  | 'ready';

export interface RestorationDecision {
  shouldRestore: boolean;
  reason: RestorationDecisionReason;
}

export function decideProfileRestoration(input: RestorationDecisionInput): RestorationDecision {
  if (!input.isConnected) {
    return { shouldRestore: false, reason: 'not_connected' };
  }
  if (input.isBusy) {
    return { shouldRestore: false, reason: 'busy' };
  }
  if (!input.isSessionInitialized) {
    return { shouldRestore: false, reason: 'not_initialized' };
  }
  if (input.manualSelectionContextKey === input.currentContextKey) {
    return { shouldRestore: false, reason: 'manual_selection_preserved' };
  }
  if (input.lastRestoredContextKey === input.currentContextKey) {
    return { shouldRestore: false, reason: 'already_restored' };
  }
  if (input.loadedCwd !== undefined && input.cwd !== undefined && input.loadedCwd !== input.cwd) {
    return { shouldRestore: false, reason: 'stale_cwd' };
  }
  if (input.isProfilesLoaded === false) {
    return { shouldRestore: false, reason: 'profiles_loading' };
  }
  if (!input.effectiveProfile || (!input.effectiveProfile.default_model && !input.effectiveProfile.default_effort)) {
    return { shouldRestore: false, reason: 'no_profile' };
  }
  return { shouldRestore: true, reason: 'ready' };
}

export function findEffectiveProfileSummary(
  profiles: ProfileSummary[],
  effectiveActiveProfile: string | null,
  effectiveScope?: 'project' | 'global' | null
): ProfileSummary | null {
  if (!effectiveActiveProfile) return null;
  return (
    profiles.find(
      (p) =>
        p.name === effectiveActiveProfile &&
        (effectiveScope ? p.scope === effectiveScope : true)
    ) ||
    profiles.find((p) => p.name === effectiveActiveProfile) ||
    null
  );
}

export interface ProfileRestorationOptions {
  isConnected: boolean;
  isBusy?: boolean;
  availableModels: ModelInfo[];
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

export async function restoreProfileRuntime(
  profile: ProfileSummary | null,
  options: ProfileRestorationOptions
): Promise<boolean> {
  if (!options.isConnected || options.isBusy || !profile) {
    return false;
  }
  return applyProfileRuntime(profile, options);
}

export interface ProfileRuntimeCoordinatorState {
  lastRestoredContextKey: string | null;
  manualSelectionContextKey: string | null;
  isRestoring: boolean;
}

export class ProfileRuntimeCoordinator {
  private state: ProfileRuntimeCoordinatorState = {
    lastRestoredContextKey: null,
    manualSelectionContextKey: null,
    isRestoring: false,
  };

  private activeRunId = 0;
  private inFlightKey: string | null = null;
  private inFlightPromise: Promise<boolean> | null = null;

  public getContextKey(cwd?: string, sessionId?: string | null): string {
    return createProfileRuntimeContextKey(cwd, sessionId);
  }

  public recordManualSelection(cwd?: string, sessionId?: string | null): void {
    const key = this.getContextKey(cwd, sessionId);
    this.state.manualSelectionContextKey = key;
    // Invalidate any active in-flight restoration continuation so effort is not set
    this.activeRunId++;
  }

  public resetManualSelection(cwd?: string, sessionId?: string | null): void {
    const key = this.getContextKey(cwd, sessionId);
    if (this.state.manualSelectionContextKey === key) {
      this.state.manualSelectionContextKey = null;
    }
  }

  public isRestoring(): boolean {
    return this.state.isRestoring;
  }

  public async restore(params: {
    cwd?: string;
    sessionId?: string | null;
    isConnected: boolean;
    isBusy: boolean;
    isSessionInitialized: boolean;
    isProfilesLoaded?: boolean;
    loadedCwd?: string;
    effectiveProfile: ProfileSummary | null;
    availableModels: ModelInfo[];
    onSelectModel: (provider: string, modelId: string) => Promise<void>;
    onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  }): Promise<boolean> {
    const contextKey = this.getContextKey(params.cwd, params.sessionId);

    // Deduplicate concurrent in-flight restore calls for the same context key
    if (this.inFlightKey === contextKey && this.inFlightPromise) {
      return this.inFlightPromise;
    }

    const decision = decideProfileRestoration({
      isConnected: params.isConnected,
      isBusy: params.isBusy,
      isSessionInitialized: params.isSessionInitialized,
      isProfilesLoaded: params.isProfilesLoaded,
      loadedCwd: params.loadedCwd,
      cwd: params.cwd,
      currentContextKey: contextKey,
      lastRestoredContextKey: this.state.lastRestoredContextKey,
      manualSelectionContextKey: this.state.manualSelectionContextKey,
      effectiveProfile: params.effectiveProfile,
    });

    if (!decision.shouldRestore) {
      // Only latch as handled when metadata is confirmed loaded and there is truly no profile
      if (
        decision.reason === 'no_profile' &&
        params.isConnected &&
        !params.isBusy &&
        params.isSessionInitialized &&
        params.isProfilesLoaded !== false
      ) {
        this.state.lastRestoredContextKey = contextKey;
      }
      return false;
    }

    const runId = ++this.activeRunId;
    this.inFlightKey = contextKey;
    this.state.isRestoring = true;

    const executeRestoration = async (): Promise<boolean> => {
      try {
        const profile = params.effectiveProfile;
        if (!profile) return false;

        let modelApplied = false;
        if (profile.default_model) {
          const resolved = resolveProfileModel(profile.default_model, params.availableModels);
          if (resolved && resolved.modelId) {
            await params.onSelectModel(resolved.provider, resolved.modelId);
            modelApplied = true;
          }
        }

        // Validate that this run is still current before proceeding to effort RPC
        if (
          this.activeRunId !== runId ||
          this.state.manualSelectionContextKey === contextKey
        ) {
          return false;
        }

        if (profile.default_effort) {
          const effort = resolveProfileEffort(profile.default_effort);
          if (effort) {
            await params.onSelectThinkingLevel(effort);
          }
        }

        if (
          this.activeRunId !== runId ||
          this.state.manualSelectionContextKey === contextKey
        ) {
          return false;
        }

        this.state.lastRestoredContextKey = contextKey;
        return modelApplied;
      } finally {
        if (this.inFlightKey === contextKey) {
          this.inFlightKey = null;
          this.inFlightPromise = null;
          this.state.isRestoring = false;
        }
      }
    };

    this.inFlightPromise = executeRestoration();
    return this.inFlightPromise;
  }

  public getState(): Readonly<ProfileRuntimeCoordinatorState> {
    return { ...this.state };
  }
}
