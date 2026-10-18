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

const catalog: ModelInfo[] = [
  { id: 'gpt-4o', provider: 'openai', reasoning: false },
  { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', reasoning: true },
  { id: 'gemini-1.5-pro', provider: 'google', reasoning: true },
];

test('S1.1: profile model and effort restored after view reload and initialization without being overwritten', async () => {
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
    isProfilesLoaded: true,
    effectiveProfile: globalProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(busyRestored, false);
});
