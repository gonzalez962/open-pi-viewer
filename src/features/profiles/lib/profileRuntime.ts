import {
  applyProfileRuntime,
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
  currentContextKey: string;
  lastRestoredContextKey: string | null;
  manualSelectionContextKey: string | null;
  effectiveProfile: ProfileSummary | null;
}

export type RestorationDecisionReason =
  | 'not_connected'
  | 'busy'
  | 'not_initialized'
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

export class ProjectProfileRequestTracker {
  private currentRequestId = 0;
  private currentCwd: string | undefined = undefined;

  public beginRequest(cwd?: string): number {
    this.currentCwd = cwd;
    return ++this.currentRequestId;
  }

  public isCurrent(requestId: number, cwd?: string): boolean {
    return this.currentRequestId === requestId && this.currentCwd === cwd;
  }

  public getCurrentRequestId(): number {
    return this.currentRequestId;
  }
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

  public getContextKey(cwd?: string, sessionId?: string | null): string {
    return createProfileRuntimeContextKey(cwd, sessionId);
  }

  public recordManualSelection(cwd?: string, sessionId?: string | null): void {
    if (this.state.isRestoring) return;
    const key = this.getContextKey(cwd, sessionId);
    this.state.manualSelectionContextKey = key;
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
    effectiveProfile: ProfileSummary | null;
    availableModels: ModelInfo[];
    onSelectModel: (provider: string, modelId: string) => Promise<void>;
    onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  }): Promise<boolean> {
    const contextKey = this.getContextKey(params.cwd, params.sessionId);
    const decision = decideProfileRestoration({
      isConnected: params.isConnected,
      isBusy: params.isBusy,
      isSessionInitialized: params.isSessionInitialized,
      currentContextKey: contextKey,
      lastRestoredContextKey: this.state.lastRestoredContextKey,
      manualSelectionContextKey: this.state.manualSelectionContextKey,
      effectiveProfile: params.effectiveProfile,
    });

    if (!decision.shouldRestore) {
      if (
        decision.reason === 'no_profile' &&
        params.isConnected &&
        !params.isBusy &&
        params.isSessionInitialized
      ) {
        // Mark context handled so we do not re-evaluate repeatedly on renders
        this.state.lastRestoredContextKey = contextKey;
      }
      return false;
    }

    this.state.isRestoring = true;
    try {
      const applied = await restoreProfileRuntime(params.effectiveProfile, {
        isConnected: params.isConnected,
        isBusy: params.isBusy,
        availableModels: params.availableModels,
        onSelectModel: params.onSelectModel,
        onSelectThinkingLevel: params.onSelectThinkingLevel,
      });
      this.state.lastRestoredContextKey = contextKey;
      return applied;
    } finally {
      this.state.isRestoring = false;
    }
  }

  public getState(): Readonly<ProfileRuntimeCoordinatorState> {
    return { ...this.state };
  }
}
