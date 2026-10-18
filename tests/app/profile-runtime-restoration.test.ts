import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyProfileRuntime,
  PROFILE_ACTIVATED_EVENT,
  type ProfileSummary,
  type ProfileActivationEventDetail,
} from '../../src/core/types/profiles';
import type { ModelInfo } from '../../src/core/types/models';

type ProfileRuntimeModule = typeof import('../../src/features/profiles/lib/profileRuntime');

async function loadProfileRuntimeModule(): Promise<ProfileRuntimeModule | null> {
  try {
    return await import('../../src/features/profiles/lib/profileRuntime.js');
  } catch {
    return null;
  }
}

const catalog: ModelInfo[] = [
  { id: 'gpt-4o', provider: 'openai', reasoning: false },
  { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', reasoning: true },
  { id: 'gemini-1.5-pro', provider: 'google', reasoning: true },
];

test('S1.1: profile model and effort restored after view reload and initialization without being overwritten', async () => {
  const mod = await loadProfileRuntimeModule();

  const activeProfile: ProfileSummary = {
    name: 'claude-coding',
    scope: 'project',
    agent_count: 2,
    is_active: true,
    default_model: 'openrouter/anthropic/claude-3.5-sonnet',
    default_effort: 'high',
  };

  const connectTimeModel = 'openai/gpt-4o';
  let currentModel = connectTimeModel;
  let currentEffort: string | null = null;

  const onSelectModel = async (provider: string, modelId: string) => {
    currentModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    currentEffort = level;
  };

  if (!mod) {
    // RED: The coordinator module does not exist yet. View reload currently relies on connect-time
    // session defaults and never restores the effective profile.
    assert.strictEqual(
      currentModel,
      activeProfile.default_model,
      'Runtime model must match active profile after view reload and initialization (not connect-time model)'
    );
    assert.strictEqual(
      currentEffort,
      activeProfile.default_effort,
      'Runtime effort must match active profile after view reload and initialization'
    );
    return;
  }

  // GREEN: Production coordinator enforces deterministic sequencing:
  const coordinator = new mod.ProfileRuntimeCoordinator();

  // 1. Before session initialization completes (useModels is still loading parameters), restoration does not run.
  const beforeInitRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: false, // useModels in-flight
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(beforeInitRestored, false);
  assert.strictEqual(currentModel, 'openai/gpt-4o', 'Model must remain connect-time model before initialization completes');

  // 2. Once session initialization completes, coordinator restores the effective profile.
  const afterInitRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true, // useModels finished
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(afterInitRestored, true);
  assert.strictEqual(currentModel, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.strictEqual(currentEffort, 'high');

  // 3. Subsequent calls (rerenders or repeated effects) do not re-run restoration or overwrite the runtime.
  const subsequentRestored = await coordinator.restore({
    cwd: '/workspace/project-alpha',
    sessionId: 'session-alpha-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: activeProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(subsequentRestored, false);
  assert.strictEqual(currentModel, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.strictEqual(currentEffort, 'high');

  // Verify App.tsx wiring includes the coordinator hook and uses isSessionInitialized
  const appSource = fs.readFileSync(path.resolve('src/app/App.tsx'), 'utf8');
  assert.match(appSource, /useProfileRuntime/, 'App.tsx must use useProfileRuntime hook');
  assert.match(appSource, /isSessionInitialized/, 'App.tsx must connect isSessionInitialized from useModels');
});

test('S2.1: destination profile applied after project switch and late source-project results cannot replace them', async () => {
  const mod = await loadProfileRuntimeModule();

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

  if (!mod) {
    // RED: The request tracker and coordinator do not exist yet. Switching projects currently allows
    // late asynchronous completions to overwrite destination state and does not restore destination profile.
    let appliedModel = profileA.default_model;
    const staleCompletion = async () => {
      // In unpatched code without request tagging, Project A's late resolution replaces Project B
      appliedModel = profileA.default_model;
    };
    await staleCompletion();
    assert.strictEqual(
      appliedModel,
      profileB.default_model,
      'Destination profile model must be applied after project switch, not stale source profile'
    );
    return;
  }

  // GREEN: Production ProjectProfileRequestTracker and ProfileRuntimeCoordinator:
  const tracker = new mod.ProjectProfileRequestTracker();
  const coordinator = new mod.ProfileRuntimeCoordinator();

  let runtimeModel = 'openai/gpt-4o';
  let runtimeEffort: string | null = 'low';

  const onSelectModel = async (provider: string, modelId: string) => {
    runtimeModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    runtimeEffort = level;
  };

  // 1. Initial Project A restores profile A
  const reqA = tracker.beginRequest('/workspace/project-a');
  await coordinator.restore({
    cwd: '/workspace/project-a',
    sessionId: 'session-a',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: profileA,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(runtimeModel, 'openai/gpt-4o');

  // 2. User switches to Project B
  const reqB = tracker.beginRequest('/workspace/project-b');

  // 3. Stale completion from Project A resolves late
  const isStaleAValid = tracker.isCurrent(reqA, '/workspace/project-a');
  assert.strictEqual(isStaleAValid, false, 'Stale source project response must be invalidated');

  // If a stale source response tried to restore, the context key mismatch prevents mutation
  const lateSourceRestored = await coordinator.restore({
    cwd: '/workspace/project-a', // stale cwd
    sessionId: 'session-a',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: profileA,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(lateSourceRestored, false);

  // 4. Destination Project B initialization completes
  const isDestValid = tracker.isCurrent(reqB, '/workspace/project-b');
  assert.strictEqual(isDestValid, true);

  const destRestored = await coordinator.restore({
    cwd: '/workspace/project-b',
    sessionId: 'session-b',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: profileB,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(destRestored, true);
  assert.strictEqual(runtimeModel, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.strictEqual(runtimeEffort, 'high');
});

test('S3.1: manual model selection in initialized context is preserved across rerenders and explicit activation still applies', async () => {
  const mod = await loadProfileRuntimeModule();

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

  let runtimeModel = 'openrouter/anthropic/claude-3.5-sonnet';
  let runtimeEffort: string | null = 'high';

  const onSelectModel = async (provider: string, modelId: string) => {
    runtimeModel = `${provider}/${modelId}`;
  };
  const onSelectThinkingLevel = async (level: string) => {
    runtimeEffort = level;
  };

  if (!mod) {
    // Existing behavior in RED: user manually selects a model; ordinary rerenders do not alter it
    runtimeModel = 'openai/gpt-4o';
    runtimeEffort = 'low';

    // Rerender occurs
    assert.strictEqual(runtimeModel, 'openai/gpt-4o');

    // Explicit profile activation applies newly requested profile
    await applyProfileRuntime(explicitlyActivatedProfile, {
      isConnected: true,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });
    assert.strictEqual(runtimeModel, 'google/gemini-1.5-pro');
    assert.strictEqual(runtimeEffort, 'medium');
    return;
  }

  // GREEN: Coordinator explicitly models manual selection tracking:
  const coordinator = new mod.ProfileRuntimeCoordinator();

  // Profile initially restored
  await coordinator.restore({
    cwd: '/workspace/project-manual',
    sessionId: 'session-manual-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: restoredProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(runtimeModel, 'openrouter/anthropic/claude-3.5-sonnet');

  // User manually selects a different model in this context
  coordinator.recordManualSelection('/workspace/project-manual', 'session-manual-1');
  await onSelectModel('openai', 'gpt-4o');
  await onSelectThinkingLevel('low');
  assert.strictEqual(runtimeModel, 'openai/gpt-4o');
  assert.strictEqual(runtimeEffort, 'low');

  // Ordinary rerenders / restoration triggers run again in this context
  const reRestored = await coordinator.restore({
    cwd: '/workspace/project-manual',
    sessionId: 'session-manual-1',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: restoredProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(reRestored, false);
  assert.strictEqual(runtimeModel, 'openai/gpt-4o', 'Manual selection must not be overwritten by restoration');
  assert.strictEqual(runtimeEffort, 'low');

  // Explicit profile activation clears prior manual selection and applies the activated profile
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
  const mod = await loadProfileRuntimeModule();

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

  if (!mod) {
    // Existing behavior in RED:
    // 1. Inherited global profile applies global profile
    await applyProfileRuntime(globalProfile, {
      isConnected: true,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });
    assert.strictEqual(runtimeModel, 'google/gemini-1.5-pro');

    // 2. No effective profile leaves model unchanged
    const modelBefore = runtimeModel;
    await applyProfileRuntime(null, {
      isConnected: true,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });
    assert.strictEqual(runtimeModel, modelBefore);

    // 3. Disconnected session: applyProfileRuntime returns false and does not mutate
    const disconnectedResult = await applyProfileRuntime(globalProfile, {
      isConnected: false,
      availableModels: catalog,
      onSelectModel,
      onSelectThinkingLevel,
    });
    assert.strictEqual(disconnectedResult, false);
    return;
  }

  // GREEN: Coordinator checks:
  const coordinator = new mod.ProfileRuntimeCoordinator();

  // 1. Project inheriting global profile
  await coordinator.restore({
    cwd: '/workspace/project-inherited',
    sessionId: 'session-inherited',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
    effectiveProfile: globalProfile,
    availableModels: catalog,
    onSelectModel,
    onSelectThinkingLevel,
  });
  assert.strictEqual(runtimeModel, 'google/gemini-1.5-pro');
  assert.strictEqual(runtimeEffort, 'medium');

  // 2. Project with NO effective profile leaves model unchanged
  const prevModel = runtimeModel;
  const noProfileRestored = await coordinator.restore({
    cwd: '/workspace/project-none',
    sessionId: 'session-none',
    isConnected: true,
    isBusy: false,
    isSessionInitialized: true,
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
