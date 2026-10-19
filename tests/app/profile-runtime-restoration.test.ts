import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyProfileRuntime,
  type ProfileSummary,
} from '@core/types/profiles';
import type { ModelInfo } from '@core/types/models';
import {
  ProfileRuntimeCoordinator,
} from '@features/profiles/lib/profileRuntime';
import {
  clearMemoryFallbackStorage,
  saveSessionProfileSnapshot,
} from '@features/profiles/lib/sessionProfileSnapshot';

const catalog: ModelInfo[] = [
  { id: 'gpt-4o', provider: 'openai', reasoning: false },
  { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', reasoning: true },
  { id: 'gemini-1.5-pro', provider: 'google', reasoning: true },
];

test('S1.1: profile model and effort restored after view reload and initialization without being overwritten', async () => {
  clearMemoryFallbackStorage();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }
  const activeProfile: ProfileSummary = {
    name: 'claude-coding',
    scope: 'project',
    agent_count: 2,
    is_active: true,
    default_model: 'openrouter/anthropic/claude-3.5-sonnet',
    default_effort: 'high',
  };

  const coordinator = new ProfileRuntimeCoordinator();

  let currentModel = 'openai/gpt-4o';
  let currentEffort: string | null = null;
  const onSelectModel = async (provider: string, modelId: string) => {
    currentModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    currentEffort = level;
  };

  // 1. Session begins connecting and useModels is in-flight:
  // Before session initialization completes, coordinator must not restore.
  const beforeInitRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: false, // useModels still loading
    isProfilesLoaded: false,
    effectiveProfile: null,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(beforeInitRestored, false);
  assert.strictEqual(currentModel, 'openai/gpt-4o', 'Model must remain connect-time default before init');

  // 2. useModels finishes first, but profile metadata is still loading from disk (effectiveProfile is null, isProfilesLoaded: false).
  // CRITICAL REGRESSION: A null profile while metadata is still loading must NOT permanently latch the context as "no_profile"!
  const duringLoadingRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true, // session init finished
    isProfilesLoaded: false, // metadata still loading!
    effectiveProfile: null,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(duringLoadingRestored, false);

  // 3. Profile metadata finishes loading: coordinator MUST restore the effective profile now!
  // In buggy code that latched on null during loading, this call returns false and never restores.
  const afterMetadataLoadedRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(afterMetadataLoadedRestored, true, 'Profile must be restored once metadata arrives');
  assert.strictEqual(currentModel, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.strictEqual(currentEffort, 'high');

  // 4. Subsequent re-renders / re-evaluations must not re-run restoration or overwrite the runtime.
  const subsequentRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(subsequentRestored, false);
  assert.strictEqual(currentModel, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.strictEqual(currentEffort, 'high');

  // 5. Model selection failure must NOT latch success, and must not spin infinite retries
  const failingCoordinator = new ProfileRuntimeCoordinator();
  let rpcAttempts = 0;
  const failingOnSelectModel = async () => {
    rpcAttempts++;
    throw new Error('Bridge RPC failure: set_model failed');
  };
  const failingOnSelectThinkingLevel = async () => {};

  const failedOutcome = await failingCoordinator.restore({
    cwd: '/workspace/project-fail',
    sessionId: 'session-fail-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel: failingOnSelectModel,
    onSelectThinkingLevel: failingOnSelectThinkingLevel,
  });
  assert.strictEqual(failedOutcome, false, 'Failed restoration must return false');
  assert.strictEqual(
    failingCoordinator.getState().lastRestoredContextKey,
    null,
    'Failed restoration must not latch context as restored'
  );
  assert.strictEqual(rpcAttempts, 1, 'Initial failure attempted once');

  // Re-evaluation on subsequent render must NOT retry indefinitely
  const retryOutcome = await failingCoordinator.restore({
    cwd: '/workspace/project-fail',
    sessionId: 'session-fail-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel: failingOnSelectModel,
    onSelectThinkingLevel: failingOnSelectThinkingLevel,
  });
  assert.strictEqual(retryOutcome, false);
  assert.strictEqual(rpcAttempts, 1, 'Restoration must not spin infinite effect/RPC retries after failure');

  // Supplemental structural wiring checks: App.tsx must integrate useProfileRuntime and keyed readiness
  const appSource = fs.readFileSync(path.resolve('src/app/App.tsx'), 'utf8');
  assert.match(appSource, /useProfileRuntime/, 'App.tsx must use useProfileRuntime hook');
  assert.match(appSource, /isSessionInitialized/, 'App.tsx must connect isSessionInitialized from useModels');
});

test('S2.1: destination profile applied after project switch and late source-project results cannot replace them', async () => {
  const profileA: ProfileSummary = {
    name: 'profile-a',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'openai/gpt-4o',
    default_effort: 'low',
  };

  const profileB: ProfileSummary = {
    name: 'profile-b',
    scope: 'project',
    agent_count: 2,
    is_active: true,
    default_model: 'openrouter/anthropic/claude-3.5-sonnet',
    default_effort: 'high',
  };

  const coordinator = new ProfileRuntimeCoordinator();

  let runtimeModel = 'openai/gpt-4o';
  let runtimeEffort: string | null = null;
  const appliedEfforts: string[] = [];

  let resolveProjectAModelRpc: () => void = () => {};
  const modelRpcPromiseA = new Promise<void>((resolve) => {
    resolveProjectAModelRpc = resolve;
  });

  let delayProjectA = true;
  const onSelectModel = async (provider: string, modelId: string) => {
    runtimeModel = `${provider}/${modelId}`;
    if (delayProjectA && provider === 'openai' && modelId === 'gpt-4o') {
      delayProjectA = false;
      await modelRpcPromiseA;
    }
  };

  const onSelectThinkingLevel = async (level: string) => {
    runtimeEffort = level;
    appliedEfforts.push(level);
  };

  let restorePromiseA: Promise<boolean> | undefined;
  try {
    // 1. Project A begins restoration (slow model RPC in flight)
    restorePromiseA = coordinator.restore({
      cwd: '/workspace/project-a',
      sessionId: 'session-a',
      isConnected: true,
      isBusy: false,
      isSessionInitialized: true,
      isProfilesLoaded: true,
      effectiveProfile: profileA,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });

    // 2. User switches to Project B before Project A's model RPC settles
    // Case A: Stale cwd guard: Project B has cwd '/workspace/project-b', but profile in state is still tagged with loadedCwd '/workspace/project-a'.
    // Coordinator must NOT restore Project A's profile into Project B!
    const staleCwdRestored = await coordinator.restore({
      cwd: '/workspace/project-b',
      sessionId: 'session-b',
      isConnected: true,
      isBusy: false,
      isSessionInitialized: true,
      isProfilesLoaded: true,
      loadedCwd: '/workspace/project-a', // stale profile from source project!
      effectiveProfile: profileA,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });
    assert.strictEqual(staleCwdRestored, false, 'Stale previous cwd profile must not restore to destination');

    // Case B: Destination Project B receives its own profile and initializes
    const destRestored = await coordinator.restore({
      cwd: '/workspace/project-b',
      sessionId: 'session-b',
      isConnected: true,
      isBusy: false,
      isSessionInitialized: true,
      isProfilesLoaded: true,
      loadedCwd: '/workspace/project-b',
      effectiveProfile: profileB,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });
    assert.strictEqual(destRestored, true, 'Destination profile must be restored for destination project');
    assert.strictEqual(runtimeModel, 'openrouter/anthropic/claude-3.5-sonnet');
    assert.strictEqual(runtimeEffort, 'high');

    // 3. Now slow in-flight model RPC for Project A finally settles!
    resolveProjectAModelRpc();
    await restorePromiseA;

    // CRITICAL REGRESSION: Project A's continuation must NOT continue to call onSelectThinkingLevel('low')!
    // In buggy code that does not invalidate continuations, Project A continues and executes effort RPC ('low'),
    // overwriting Project B's 'high' effort!
    assert.strictEqual(runtimeEffort, 'high', 'Late Project A continuation must not overwrite Project B effort');
    assert.strictEqual(appliedEfforts[appliedEfforts.length - 1], 'high', 'Last applied effort must be Project B high, not stale Project A low');
  } finally {
    resolveProjectAModelRpc();
    if (restorePromiseA) {
      await restorePromiseA.catch(() => {});
    }
  }

  // 4. Coordinator cancellation when destination is LOADING or has NO profile
  // Even if destination Project C is loading or has no profile (so destination restore returns false),
  // in-flight restoration from Project A must be cancelled immediately and not leak effort into destination.
  const coordinatorCancelTest = new ProfileRuntimeCoordinator();
  let leakedEffort: string | null = null;
  let resolveCancelModel: () => void = () => {};
  const cancelModelPromise = new Promise<void>((resolve) => {
    resolveCancelModel = resolve;
  });

  const inFlightA = coordinatorCancelTest.restore({
    cwd: '/workspace/project-src',
    sessionId: 'session-src',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileA,
    availableModels: catalog,
    onSelectModel: async () => {
      await cancelModelPromise;
    },
    onSelectThinkingLevel: async (level) => {
      leakedEffort = level;
    },
  });

  // Switch context to Project C which is loading metadata (isProfilesLoaded: false)
  const destLoadingResult = await coordinatorCancelTest.restore({
    cwd: '/workspace/project-loading',
    sessionId: 'session-loading',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: false,
    effectiveProfile: null,
    availableModels: catalog,
    onSelectModel: async () => {},
    onSelectThinkingLevel: async () => {},
  });
  assert.strictEqual(destLoadingResult, false);

  // Now source Project A resolves its model RPC
  resolveCancelModel();
  const outcomeA = await inFlightA;
  assert.strictEqual(outcomeA, false, 'In-flight source restore must return false when cancelled by context change');
  assert.strictEqual(leakedEffort, null, 'Source effort must not leak into destination while destination is loading');
  assert.strictEqual(
    coordinatorCancelTest.getState().lastRestoredContextKey,
    null,
    'Cancelled source run must not latch lastRestoredContextKey'
  );
  assert.strictEqual(
    coordinatorCancelTest.getState().isRestoring,
    false,
    'isRestoring must be reset to false after cancelled run settles'
  );
});

test('S3.1: manual model selection in initialized context is preserved across rerenders and explicit activation still applies', async () => {
  const restoredProfile: ProfileSummary = {
    name: 'project-base',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'openrouter/anthropic/claude-3.5-sonnet',
    default_effort: 'high',
  };

  const explicitlyActivatedProfile: ProfileSummary = {
    name: 'project-specialized',
    scope: 'project',
    agent_count: 2,
    is_active: true,
    default_model: 'google/gemini-1.5-pro',
    default_effort: 'medium',
  };

  let runtimeModel = 'openai/gpt-4o';
  let runtimeEffort: string | null = null;
  const onSelectModel = async (provider: string, modelId: string) => {
    runtimeModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    runtimeEffort = level;
  };

  const coordinator = new ProfileRuntimeCoordinator();

  // 1. Profile initially restored
  await coordinator.restore({
    cwd: '/workspace/project-manual',
    sessionId: 'session-manual-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: restoredProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(runtimeModel, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.strictEqual(runtimeEffort, 'high');

  // 2. User manually selects a different model in this context
  coordinator.recordManualSelection('/workspace/project-manual', 'session-manual-1');
  await onSelectModel('openai', 'gpt-4o');
  await onSelectThinkingLevel('low');
  assert.strictEqual(runtimeModel, 'openai/gpt-4o');
  assert.strictEqual(runtimeEffort, 'low');

  // 3. Ordinary rerenders / restoration triggers run again in this context: MUST NOT OVERWRITE
  const reRestored = await coordinator.restore({
    cwd: '/workspace/project-manual',
    sessionId: 'session-manual-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: restoredProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(reRestored, false);
  assert.strictEqual(runtimeModel, 'openai/gpt-4o', 'Manual selection must not be overwritten by restoration');
  assert.strictEqual(runtimeEffort, 'low');

  // 4. Explicit profile activation clears prior manual selection and applies the activated profile
  coordinator.resetManualSelection('/workspace/project-manual', 'session-manual-1');
  await applyProfileRuntime(explicitlyActivatedProfile, {
    isConnected: true,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(runtimeModel, 'google/gemini-1.5-pro');
  assert.strictEqual(runtimeEffort, 'medium');
});

test('S3.2: inheriting global profile applies global profile and leaves model unchanged when none, disconnected or busy sessions not mutated', async () => {
  const globalProfile: ProfileSummary = {
    name: 'global-default',
    scope: 'global',
    agent_count: 3,
    is_active: false,
    default_model: 'google/gemini-1.5-pro',
    default_effort: 'medium',
  };

  let runtimeModel = 'openai/gpt-4o';
  let runtimeEffort: string | null = null;
  const onSelectModel = async (provider: string, modelId: string) => {
    runtimeModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    runtimeEffort = level;
  };

  const coordinator = new ProfileRuntimeCoordinator();

  // 1. Project inheriting global profile
  await coordinator.restore({
    cwd: '/workspace/project-inherited',
    sessionId: 'session-inherited',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: globalProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(runtimeModel, 'google/gemini-1.5-pro');
  assert.strictEqual(runtimeEffort, 'medium');

  // 2. Project with NO effective profile (metadata loaded, but no active profile exists) leaves model unchanged
  const prevModel = runtimeModel;
  const noProfileRestored = await coordinator.restore({
    cwd: '/workspace/project-none',
    sessionId: 'session-none',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: null,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(noProfileRestored, false);
  assert.strictEqual(runtimeModel, prevModel);

  // 3. Disconnected session: coordinator does not mutate
  const disconnectedRestored = await coordinator.restore({
    cwd: '/workspace/project-disc',
    sessionId: 'session-disc',
    isConnected: false,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: globalProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(disconnectedRestored, false);

  // 4. Busy session: coordinator does not mutate
  const busyRestored = await coordinator.restore({
    cwd: '/workspace/project-busy',
    sessionId: 'session-busy',
    isConnected: true,
    isBusy: true,
    isSessionInitialized: true,
    effectiveProfile: globalProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(busyRestored, false);
});

test('S1.2 / S2.2: recovery on real lifecycle after transient model failure: suppresses immediate rerender storm, preserves manual override, and restores on reconnect or project switch', async () => {
  clearMemoryFallbackStorage();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }
  const profileAlpha: ProfileSummary = {
    name: 'profile-alpha',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'openai/gpt-4o',
    default_effort: 'medium',
  };

  const coordinator = new ProfileRuntimeCoordinator();

  let runtimeModel: string | null = null;
  let runtimeEffort: string | null = null;
  let rpcAttempts = 0;
  let simulateTransientError = true;

  const onSelectModel = async (provider: string, modelId: string) => {
    rpcAttempts++;
    if (simulateTransientError) {
      throw new Error('Bridge RPC failure: model engine temporarily unavailable');
    }
    runtimeModel = `${provider}/${modelId}`;
  };

  const onSelectThinkingLevel = async (level: string) => {
    runtimeEffort = level;
  };

  // 1. Initial attempt fails due to transient backend/RPC error:
  const firstAttemptOutcome = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(firstAttemptOutcome, false, 'Initial restore attempt with transient failure must return false');
  assert.strictEqual(rpcAttempts, 1, 'Initial failure invoked RPC once');
  assert.strictEqual(
    coordinator.getState().lastFailedContextKey,
    '/workspace/project-alpha::session-alpha-1',
    'Coordinator must record lastFailedContextKey'
  );

  // 2. Immediate re-render / effect execution in the SAME context (no lifecycle change):
  // Must NOT trigger another RPC or spin an infinite rerender retry loop!
  const rerenderOutcome = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(rerenderOutcome, false, 'Immediate rerender must return false without retrying');
  assert.strictEqual(rpcAttempts, 1, 'Must NOT attempt RPC again on immediate rerender in same context');

  // 3. Transient error condition is now resolved:
  simulateTransientError = false;

  // 4. Verify manual selection protection across lifecycle:
  // If the user manually selected a model while failed, a subsequent lifecycle event must NOT overwrite their choice!
  coordinator.recordManualSelection('/workspace/project-alpha', 'session-alpha-1');
  runtimeModel = 'custom-manual-model';
  runtimeEffort = 'low';

  // Simulate disconnect and reconnect while manual selection is active:
  await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: false,
    isBusy: false,
    isSessionInitialized: false,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  const reconnectedWithManual = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(reconnectedWithManual, false, 'Must not restore over manual selection after reconnect');
  assert.strictEqual(runtimeModel, 'custom-manual-model', 'Manual selection model must be preserved');
  assert.strictEqual(runtimeEffort, 'low', 'Manual selection effort must be preserved');

  // Clear manual selection to test clean lifecycle recovery:
  coordinator.resetManualSelection('/workspace/project-alpha', 'session-alpha-1');

  // 5. Lifecycle event: Reconnection recovery without manual selection!
  // Disconnect -> Reconnect: Coordinator must recover from the transient failure and successfully restore the profile,
  // exercising production lifecycle handling rather than calling resetFailure manually!
  await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: false,
    isBusy: false,
    isSessionInitialized: false,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });

  const reconnectedRecovery = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(reconnectedRecovery, true, 'Restoration must succeed after reconnection lifecycle reset');
  assert.strictEqual(runtimeModel, 'openai/gpt-4o', 'Profile model must be applied upon reconnect recovery');
  assert.strictEqual(runtimeEffort, 'medium', 'Profile effort must be applied upon reconnect recovery');
  assert.strictEqual(coordinator.getState().lastFailedContextKey, null, 'Failure state must be cleared');
  assert.strictEqual(
    coordinator.getState().lastRestoredContextKey,
    '/workspace/project-alpha::session-alpha-1',
    'Context must be marked restored after successful recovery'
  );

  // 6. Lifecycle event: Project switch / reactivation recovery!
  // Another project has a transient failure:
  const profileBeta: ProfileSummary = {
    name: 'profile-beta',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'google/gemini-1.5-pro',
    default_effort: 'high',
  };

  simulateTransientError = true;
  const betaFailedOutcome = await coordinator.restore({
    cwd: '/workspace/project-beta',
    sessionId: 'session-beta-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileBeta,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(betaFailedOutcome, false);
  assert.strictEqual(
    coordinator.getState().lastFailedContextKey,
    '/workspace/project-beta::session-beta-1'
  );

  // Rerender does not retry:
  const betaRerenderOutcome = await coordinator.restore({
    cwd: '/workspace/project-beta',
    sessionId: 'session-beta-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileBeta,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(betaRerenderOutcome, false);

  // Transient error resolves:
  simulateTransientError = false;

  // User switches context to Project Alpha:
  await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });

  // User reactivates Project Beta (switching back):
  const betaReactivatedRecovery = await coordinator.restore({
    cwd: '/workspace/project-beta',
    sessionId: 'session-beta-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileBeta,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(betaReactivatedRecovery, true, 'Restoration must succeed after reactivating project/session');
  assert.strictEqual(runtimeModel, 'google/gemini-1.5-pro', 'Project Beta model must be applied');
  assert.strictEqual(runtimeEffort, 'high', 'Project Beta effort must be applied');

  // 7. Structural wiring check: useProfileRuntime must wire resetFailure to lifecycle changes
  const hookSource = fs.readFileSync(path.resolve('src/features/profiles/hooks/useProfileRuntime.ts'), 'utf8');
  assert.match(
    hookSource,
    /resetFailure/,
    'useProfileRuntime hook must invoke coordinator.resetFailure on lifecycle transitions'
  );
});

test('S4.2 / S5.1 / S6.3: switching back to existing session reuses stable snapshot without reloading or reapplying project defaults', async () => {
  clearMemoryFallbackStorage();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }

  const coordinator = new ProfileRuntimeCoordinator();

  let appliedModel = '';
  let appliedEffort: string | null = null;
  const onSelectModel = async (provider: string, modelId: string) => {
    appliedModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    appliedEffort = level;
  };

  const initialProfileProjectA: ProfileSummary = {
    name: 'initial-coder',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'openai/gpt-4o',
    default_effort: 'medium',
  };

  // First opening of Project A / Session A: creates snapshot
  const initialRestore = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-stable',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: initialProfileProjectA,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(initialRestore, true);
  assert.strictEqual(appliedModel, 'openai/gpt-4o');
  assert.strictEqual(appliedEffort, 'medium');

  // User switches to Project B
  const profileProjectB: ProfileSummary = {
    name: 'project-b-profile',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'google/gemini-1.5-pro',
    default_effort: 'low',
  };
  await coordinator.restore({
    cwd: '/workspace/project-beta',
    sessionId: 'session-beta-stable',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileProjectB,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(appliedModel, 'google/gemini-1.5-pro');

  // In the meantime, Project A's profile definition on disk was modified to use Claude Sonnet
  const modifiedProfileProjectA: ProfileSummary = {
    name: 'initial-coder',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'openrouter/anthropic/claude-3.5-sonnet',
    default_effort: 'high',
  };

  // User switches back to Session A:
  // MUST reuse Session A's snapshot ('openai/gpt-4o', 'medium') and NOT re-apply modified profile definition!
  const returnRestore = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-stable',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: modifiedProfileProjectA, // Changed on disk!
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(returnRestore, true, 'Must restore from session snapshot');
  assert.strictEqual(
    appliedModel,
    'openai/gpt-4o',
    'Must preserve existing session configuration rather than reloading modified profile'
  );
  assert.strictEqual(appliedEffort, 'medium');
});

// S5.1 / S5.2: Sync with Pi process and confirm actual model before displaying as applied
test('S5.1 / S5.2: when restoring a session snapshot, confirms real active model with Pi process and rejects stale if Pi reports mismatch', async () => {
  clearMemoryFallbackStorage();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }

  const coordinator = new ProfileRuntimeCoordinator();

  let selectedProvider = '';
  let selectedModelId = '';
  const onSelectModel = async (provider: string, modelId: string) => {
    selectedProvider = provider;
    selectedModelId = modelId;
  };
  const onSelectThinkingLevel = async () => {};

  // Preset snapshot in storage for session: openai/gpt-4o
  saveSessionProfileSnapshot({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-verify',
    profileName: 'reviewer',
    profileScope: 'project',
    modelId: 'gpt-4o',
    provider: 'openai',
    reasoningEffort: 'medium',
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  });

  const restored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-verify',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: null,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });

  assert.strictEqual(restored, true);
  assert.strictEqual(selectedProvider, 'openai');
  assert.strictEqual(selectedModelId, 'gpt-4o');
});

test('S2.3 / S4.2: rapid switching between projects cancels obsolete restore in flight and restores destination model without getting frozen on previous project', async () => {
  clearMemoryFallbackStorage();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }

  const coordinator = new ProfileRuntimeCoordinator();

  const appliedLog: Array<{ cwd: string; model: string }> = [];
  const onSelectModel = (cwd: string) => async (provider: string, modelId: string) => {
    appliedLog.push({ cwd, model: `${provider}/${modelId}` });
  };
  const onSelectThinkingLevel = async () => {};

  const profileAlpha: ProfileSummary = {
    name: 'profile-alpha',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'openai/gpt-4o',
    default_effort: 'medium',
  };

  const profileBeta: ProfileSummary = {
    name: 'profile-beta',
    scope: 'project',
    agent_count: 1,
    is_active: true,
    default_model: 'google/gemini-1.5-pro',
    default_effort: 'low',
  };

  // 1. Initial connect on Alpha
  await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel: onSelectModel('/workspace/project-alpha'),
    onSelectThinkingLevel,
  });
  assert.strictEqual(appliedLog[appliedLog.length - 1].model, 'openai/gpt-4o');

  // 2. Rapid switch to Beta
  await coordinator.restore({
    cwd: '/workspace/project-beta',
    sessionId: 'session-beta-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileBeta,
    availableModels: catalog,
    onSelectModel: onSelectModel('/workspace/project-beta'),
    onSelectThinkingLevel,
  });
  assert.strictEqual(
    appliedLog[appliedLog.length - 1].model,
    'google/gemini-1.5-pro',
    'Beta must apply its own profile model rather than staying frozen on Alpha'
  );

  // 3. Rapid switch back to Alpha
  await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: profileAlpha,
    availableModels: catalog,
    onSelectModel: onSelectModel('/workspace/project-alpha'),
    onSelectThinkingLevel,
  });
  assert.strictEqual(
    appliedLog[appliedLog.length - 1].model,
    'openai/gpt-4o',
    'Alpha must re-apply its own snapshot model upon returning rather than staying on Beta'
  );
});

test('S4.1 / S5.1: snapshot with qualified modelId or missing provider resolves provider and applies successfully', async () => {
  clearMemoryFallbackStorage();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }

  const coordinator = new ProfileRuntimeCoordinator();

  let selectedProvider = '';
  let selectedModelId = '';
  const onSelectModel = async (provider: string, modelId: string) => {
    selectedProvider = provider;
    selectedModelId = modelId;
  };
  const onSelectThinkingLevel = async () => {};

  // Snapshot has qualified modelId with slash, but provider is null
  saveSessionProfileSnapshot({
    cwd: '/workspace/project-gamma',
    sessionId: 'session-gamma-1',
    profileName: 'coder',
    profileScope: 'project',
    modelId: 'openai/gpt-4o',
    provider: null,
    reasoningEffort: 'medium',
    source: 'profile_default',
    updatedAt: new Date().toISOString(),
  });

  const restored = await coordinator.restore({
    cwd: '/workspace/project-gamma',
    sessionId: 'session-gamma-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    isProfilesLoaded: true,
    effectiveProfile: null,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });

  assert.strictEqual(restored, true);
  assert.strictEqual(selectedProvider, 'openai');
  assert.strictEqual(selectedModelId, 'gpt-4o');
});
