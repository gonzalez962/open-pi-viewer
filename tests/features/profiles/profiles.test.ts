import assert from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  filterProfiles,
  computeProfileCounts,
  EMPTY_PROFILE_FORM,
  type ProfileSummary,
} from '@features/profiles/types';
import { ProfilesView } from '@features/profiles/ProfilesView';
import { ProfileModal } from '@features/profiles/components/ProfileModal';
import { ModelSelect } from '@features/profiles/components/ModelSelect';
import { mergeCustomProviderModels } from '@features/profiles/hooks/useProfiles';
import {
  type ModelInfo,
  type ModelThinkingLevelsMap,
  getSupportedReasoningEffortsForModel,
} from '@core/types/models';
import { findModelInCatalog } from '@features/profiles/lib/approvedModels';
import {
  resolveCompatibleEffort,
  resolveModelDefaultThinkingLevel,
} from '@features/profiles/lib/effort';
import type { Profile } from '@core/types/profiles';
import {
  getSddProfilesPi,
  saveSddProfilePi,
  deleteSddProfilePi,
  setActiveSddProfilePi,
  getPiChainsPi,
  MOCK_SDD_PROFILES_STORAGE_KEY,
  MOCK_SDD_INSTALLED_AGENTS_KEY,
} from '@infra/bridge';

// In-memory Storage mock for preview/bridge environment testing
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    const keys = Array.from(this.store.keys());
    return keys[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const sampleProfiles: ProfileSummary[] = [
  {
    name: 'team-standard',
    description: 'Equilibrio entre calidad y costo para Spec-Driven Development',
    default_model: 'anthropic/claude-sonnet-4-5',
    default_effort: 'medium',
    agent_count: 14,
    scope: 'global',
    is_active: true,
  },
  {
    name: 'deep-reasoning',
    description: 'Máximo nivel de razonamiento y verificación rigurosa',
    default_model: 'openai/o3-mini',
    default_effort: 'high',
    agent_count: 14,
    scope: 'global',
    is_active: false,
  },
  {
    name: 'speed-economy',
    description: 'Velocidad y costo mínimo para tareas ligeras e iteraciones rápidas',
    default_model: 'anthropic/claude-haiku-4-5',
    default_effort: 'low',
    agent_count: 14,
    scope: 'global',
    is_active: false,
  },
  {
    name: 'frontend-focus',
    description: 'Configuración para UI y componentes React',
    default_model: 'anthropic/claude-sonnet-4-5',
    default_effort: 'medium',
    agent_count: 6,
    scope: 'global',
    is_active: false,
    path: '~/.pi/agent/profiles/frontend-focus.json',
  },
  {
    name: 'project-specialized',
    description: 'Perfil exclusivo con agentes de backend y base de datos',
    default_model: 'openai/gpt-4o',
    default_effort: 'high',
    agent_count: 4,
    scope: 'project',
    is_active: false,
    path: '/my/project/.pi/profiles/project-specialized.json',
    model_profiles: {
      'custom-db-agent': { model: 'openai/o1-preview', effort: 'high' },
    } as any,
  },
];

test('filterProfiles: filters profiles by query in name, description, and default_model', () => {
  // Query in name
  const nameMatch = filterProfiles(sampleProfiles, 'team-standard');
  assert.strictEqual(nameMatch.length, 1);
  assert.strictEqual(nameMatch[0].name, 'team-standard');

  // Query in description
  const descMatch = filterProfiles(sampleProfiles, 'costo mínimo');
  assert.strictEqual(descMatch.length, 1);
  assert.strictEqual(descMatch[0].name, 'speed-economy');

  // Query in default_model (exact unique model)
  const modelMatch = filterProfiles(sampleProfiles, 'gpt-4o');
  assert.strictEqual(modelMatch.length, 1);
  assert.strictEqual(modelMatch[0].name, 'project-specialized');

  // Query in default_model (shared across multiple profiles)
  const sharedModelMatch = filterProfiles(sampleProfiles, 'claude-sonnet');
  assert.strictEqual(sharedModelMatch.length, 2);
  assert.ok(sharedModelMatch.some((p) => p.name === 'team-standard'));
  assert.ok(sharedModelMatch.some((p) => p.name === 'frontend-focus'));

  // Query in model_profiles agentKey and model
  const agentKeyMatch = filterProfiles(sampleProfiles, 'custom-db-agent');
  assert.strictEqual(agentKeyMatch.length, 1);
  assert.strictEqual(agentKeyMatch[0].name, 'project-specialized');

  const agentModelMatch = filterProfiles(sampleProfiles, 'o1-preview');
  assert.strictEqual(agentModelMatch.length, 1);
  assert.strictEqual(agentModelMatch[0].name, 'project-specialized');

  // Query case-insensitivity and whitespace trimming
  const caseInsensitive = filterProfiles(sampleProfiles, '   DEEP-REASONING   ');
  assert.strictEqual(caseInsensitive.length, 1);
  assert.strictEqual(caseInsensitive[0].name, 'deep-reasoning');

  // No match
  const noMatch = filterProfiles(sampleProfiles, 'non-existent-query');
  assert.strictEqual(noMatch.length, 0);
});

test('filterProfiles: filters profiles by scope (all, global, project)', () => {
  // All scopes
  const allProfiles = filterProfiles(sampleProfiles, '', 'all');
  assert.strictEqual(allProfiles.length, 5);

  // Global scope
  const globalOnly = filterProfiles(sampleProfiles, '', 'global');
  assert.strictEqual(globalOnly.length, 4);
  assert.ok(globalOnly.every((p) => p.scope === 'global'));

  // Project scope
  const projectOnly = filterProfiles(sampleProfiles, '', 'project');
  assert.strictEqual(projectOnly.length, 1);
  assert.strictEqual(projectOnly[0].name, 'project-specialized');

  // Combining scope filter with search query
  const combined = filterProfiles(sampleProfiles, 'claude-sonnet', 'global');
  assert.strictEqual(combined.length, 2);
  assert.ok(combined.some((p) => p.name === 'team-standard'));
  assert.ok(combined.some((p) => p.name === 'frontend-focus'));
});

test('computeProfileCounts: computes total, global, project, and active counts', () => {
  // Empty profiles array
  const emptyCounts = computeProfileCounts([]);
  assert.deepStrictEqual(emptyCounts, {
    total: 0,
    global: 0,
    project: 0,
    active: 0,
  });

  // Sample profiles array
  const counts = computeProfileCounts(sampleProfiles);
  assert.strictEqual(counts.total, 5);
  assert.strictEqual(counts.global, 4);
  assert.strictEqual(counts.project, 1);
  assert.strictEqual(counts.active, 1);

  // Array with multiple active profiles (e.g. from different contexts or mock states)
  const multiActive: ProfileSummary[] = [
    { ...sampleProfiles[0], is_active: true },
    { ...sampleProfiles[1], is_active: true },
    { ...sampleProfiles[3], is_active: false },
  ];
  const multiCounts = computeProfileCounts(multiActive);
  assert.strictEqual(multiCounts.total, 3);
  assert.strictEqual(multiCounts.active, 2);
});

test('bridge: getSddProfilesPi returns 0 profiles when empty and resolves null active profile', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const payload = await getSddProfilesPi();

    // 0 profiles exist by default
    assert.strictEqual(payload.profiles.length, 0);

    // Default effective active profile is null
    assert.strictEqual(payload.effectiveActiveProfile, null);
    assert.strictEqual(payload.effectiveScope, null);
    assert.strictEqual(payload.projectActiveProfile, null);
    assert.strictEqual(payload.globalActiveProfile, null);

    // Empty discovery returns empty categories and empty allAgents without fake default category
    assert.strictEqual(payload.categories.length, 0);
    assert.deepStrictEqual(payload.categories, []);
    assert.strictEqual(payload.allAgents.length, 0);
    assert.deepStrictEqual(payload.allAgents, []);
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('bridge: saveSddProfilePi persists project-scoped profile without altering global profiles', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const projectWorkspace = '/workspaces/project-alpha';
    const otherWorkspace = '/workspaces/project-beta';

    const projectProfile: Profile = {
      name: 'alpha-custom',
      description: 'Alpha project specific profile',
      default_model: 'anthropic/claude-sonnet-4-5',
      default_effort: 'high',
      model_profiles: {
        'sdd-explore': { model: 'anthropic/claude-haiku-4-5', effort: 'low' },
        'custom-alpha-worker': { model: 'openai/o3-mini', effort: 'high' },
      },
    };

    // 1. Save project-scoped profile
    const saveRes = await saveSddProfilePi({
      cwd: projectWorkspace,
      scope: 'project',
      profile: projectProfile,
    });

    assert.strictEqual(saveRes.success, true);
    assert.strictEqual(saveRes.profile?.name, 'alpha-custom');
    assert.strictEqual(
      saveRes.path,
      `${projectWorkspace}/.pi/profiles/alpha-custom.json`
    );

    // 2. Querying projectWorkspace returns the project profile
    const alphaPayload = await getSddProfilesPi(projectWorkspace);
    const alphaProfile = alphaPayload.profiles.find((p) => p.name === 'alpha-custom');
    assert.ok(alphaProfile);
    assert.strictEqual(alphaProfile.scope, 'project');

    // Saved profiles model_profiles alone are legacy references and MUST NOT make an agent appear installed
    assert.strictEqual(alphaPayload.categories.length, 0);
    assert.strictEqual(alphaPayload.allAgents.length, 0);

    // The profile still cleanly retains its overrides for lossless roundtrip
    assert.strictEqual(alphaProfile.agent_count, 2);

    // 3. Querying otherWorkspace does NOT contain the project profile (isolation)
    const betaPayload = await getSddProfilesPi(otherWorkspace);
    const betaHasAlpha = betaPayload.profiles.some((p) => p.name === 'alpha-custom');
    assert.strictEqual(betaHasAlpha, false);

    // 4. Verify stored mock profiles in localStorage only contains the project profile
    const rawStored = JSON.parse(fakeStorage.getItem(MOCK_SDD_PROFILES_STORAGE_KEY) || '[]');
    assert.strictEqual(rawStored.length, 1);
    assert.strictEqual(rawStored[0].scope, 'project');
    assert.strictEqual(rawStored[0].cwd, projectWorkspace);

    // 5. Saving a global profile makes it visible across all workspaces
    const globalProfile: Profile = {
      name: 'global-corporate',
      description: 'Corporate global standards',
      default_model: 'anthropic/claude-sonnet-4-5',
      model_profiles: {},
    };
    const globalSaveRes = await saveSddProfilePi({
      scope: 'global',
      profile: globalProfile,
    });
    assert.strictEqual(globalSaveRes.success, true);
    assert.strictEqual(globalSaveRes.profile?.name, 'global-corporate');
    assert.strictEqual(
      globalSaveRes.path,
      '~/.pi/agent/profiles/global-corporate.json'
    );

    const checkAlpha = await getSddProfilesPi(projectWorkspace);
    const checkBeta = await getSddProfilesPi(otherWorkspace);
    const checkGlobal = await getSddProfilesPi();

    assert.ok(checkAlpha.profiles.some((p) => p.name === 'global-corporate'));
    assert.ok(checkBeta.profiles.some((p) => p.name === 'global-corporate'));
    assert.ok(checkGlobal.profiles.some((p) => p.name === 'global-corporate'));

    // project-alpha still has both, project-beta still does not have alpha-custom
    assert.ok(checkAlpha.profiles.some((p) => p.name === 'alpha-custom'));
    assert.strictEqual(checkBeta.profiles.some((p) => p.name === 'alpha-custom'), false);
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('bridge: setActiveSddProfilePi sets project active profile and does not overwrite global active profile', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const projectCwd = '/workspaces/my-app';
    const otherCwd = '/workspaces/other-app';

    // Save global custom profile
    await saveSddProfilePi({
      scope: 'global',
      profile: {
        name: 'global-team-profile',
        description: 'Global standard profile',
        default_model: 'openai/o3-mini',
        model_profiles: {},
      },
    });

    // Save project custom profile
    await saveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      profile: {
        name: 'project-local-profile',
        description: 'Project specific profile',
        default_model: 'anthropic/claude-sonnet-4-5',
        model_profiles: {},
      },
    });

    // Set global active profile
    const setGlobalRes = await setActiveSddProfilePi({
      scope: 'global',
      name: 'global-team-profile',
    });
    assert.strictEqual(setGlobalRes.success, true);

    // Global active is set
    const initialGlobal = await getSddProfilesPi();
    assert.strictEqual(initialGlobal.globalActiveProfile, 'global-team-profile');
    assert.strictEqual(initialGlobal.projectActiveProfile, null);
    assert.strictEqual(initialGlobal.effectiveActiveProfile, 'global-team-profile');
    assert.strictEqual(initialGlobal.effectiveScope, 'global');

    // Set project active profile
    const setProjectRes = await setActiveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      name: 'project-local-profile',
    });
    assert.strictEqual(setProjectRes.success, true);

    // In projectCwd: projectActive is 'project-local-profile', globalActive is still 'global-team-profile'
    const appPayload = await getSddProfilesPi(projectCwd);
    assert.strictEqual(appPayload.projectActiveProfile, 'project-local-profile');
    assert.strictEqual(appPayload.globalActiveProfile, 'global-team-profile'); // not overwritten!
    assert.strictEqual(appPayload.effectiveActiveProfile, 'project-local-profile');
    assert.strictEqual(appPayload.effectiveScope, 'project');

    // In otherCwd: projectActive is null, falls back to globalActive
    const otherPayload = await getSddProfilesPi(otherCwd);
    assert.strictEqual(otherPayload.projectActiveProfile, null);
    assert.strictEqual(otherPayload.globalActiveProfile, 'global-team-profile');
    assert.strictEqual(otherPayload.effectiveActiveProfile, 'global-team-profile');
    assert.strictEqual(otherPayload.effectiveScope, 'global');
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('bridge: setActiveSddProfilePi with name: null clears project override, restoring global fallback', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const projectCwd = '/workspaces/my-app';

    // Save global custom profile
    await saveSddProfilePi({
      scope: 'global',
      profile: {
        name: 'global-team-profile',
        description: 'Global standard profile',
        default_model: 'openai/o3-mini',
        model_profiles: {},
      },
    });

    // Save project custom profile
    await saveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      profile: {
        name: 'project-local-profile',
        description: 'Project specific profile',
        default_model: 'anthropic/claude-sonnet-4-5',
        model_profiles: {},
      },
    });

    // 1. Establish global active profile
    await setActiveSddProfilePi({
      scope: 'global',
      name: 'global-team-profile',
    });

    // 2. Establish project override
    await setActiveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      name: 'project-local-profile',
    });

    const beforeClear = await getSddProfilesPi(projectCwd);
    assert.strictEqual(beforeClear.projectActiveProfile, 'project-local-profile');
    assert.strictEqual(beforeClear.effectiveActiveProfile, 'project-local-profile');
    assert.strictEqual(beforeClear.effectiveScope, 'project');

    // 3. Clear project override using name: null
    const clearRes = await setActiveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      name: null,
    });
    assert.strictEqual(clearRes.success, true);

    // 4. Project falls back automatically to global profile
    const afterClear = await getSddProfilesPi(projectCwd);
    assert.strictEqual(afterClear.projectActiveProfile, null);
    assert.strictEqual(afterClear.globalActiveProfile, 'global-team-profile');
    assert.strictEqual(afterClear.effectiveActiveProfile, 'global-team-profile');
    assert.strictEqual(afterClear.effectiveScope, 'global');
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('bridge: deleteSddProfilePi deletes profile and clears active state if matching', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const projectCwd = '/workspaces/cleanup-test';

    // 1. Create a project profile
    await saveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      profile: {
        name: 'temp-profile',
        description: 'To be deleted',
        default_model: 'openai/gpt-4o',
        model_profiles: {},
      },
    });

    // 2. Set it as active for project
    await setActiveSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      name: 'temp-profile',
    });

    const checkActive = await getSddProfilesPi(projectCwd);
    assert.strictEqual(checkActive.projectActiveProfile, 'temp-profile');
    assert.strictEqual(checkActive.effectiveActiveProfile, 'temp-profile');

    // 3. Delete the profile
    const deleteRes = await deleteSddProfilePi({
      cwd: projectCwd,
      scope: 'project',
      name: 'temp-profile',
    });
    assert.strictEqual(deleteRes.success, true);

    // 4. Verify profile is removed and project active state is cleared
    const afterDelete = await getSddProfilesPi(projectCwd);
    const profileExists = afterDelete.profiles.some((p) => p.name === 'temp-profile');
    assert.strictEqual(profileExists, false);
    assert.strictEqual(afterDelete.projectActiveProfile, null);
    // When no global profile is configured, effective profile resolves to null
    assert.strictEqual(afterDelete.effectiveActiveProfile, null);
    assert.strictEqual(afterDelete.effectiveScope, null);

    // 5. Deleting non-existent profile throws error
    await assert.rejects(
      async () => {
        await deleteSddProfilePi({
          cwd: projectCwd,
          scope: 'project',
          name: 'non-existent-profile',
        });
      },
      /Profile 'non-existent-profile' not found/
    );
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('mergeCustomProviderModels: merges custom provider models and updates reasoning configuration', () => {
  const baseModels: ModelInfo[] = [
    {
      id: 'claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      reasoning: false,
    },
  ];

  const customProviders = {
    cinlo: {
      name: 'Cinlo AI',
      models: [
        {
          id: 'cinlo-coder-r1',
          name: 'Cinlo Coder R1',
          reasoning: true,
          reasoningEfforts: ['low', 'high', 'max'],
          thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
        },
        {
          id: 'claude-3-5-sonnet',
          reasoning: true,
          reasoningEfforts: ['medium', 'high'],
          thinkingLevelMap: { medium: 'medium', high: 'high' },
        },
        {
          id: 'local-fast',
          name: 'Local Fast Model',
          reasoning: false,
        },
      ],
    },
  };

  const merged = mergeCustomProviderModels(baseModels, customProviders as any);

  // 1. Existing model 'claude-3-5-sonnet' was updated with reasoning, reasoningEfforts, and thinkingLevelMap
  const updatedSonnet = merged.find((m) => m.id === 'claude-3-5-sonnet');
  assert.ok(updatedSonnet);
  assert.strictEqual(updatedSonnet.reasoning, true);
  assert.deepStrictEqual(updatedSonnet.reasoningEfforts, ['medium', 'high']);
  assert.deepStrictEqual(updatedSonnet.thinkingLevelMap, { medium: 'medium', high: 'high' });

  // 2. New custom model 'cinlo-coder-r1' was added with provider 'cinlo' and reasoning metadata
  const customCoder = merged.find((m) => m.id === 'cinlo-coder-r1');
  assert.ok(customCoder);
  assert.strictEqual(customCoder.name, 'Cinlo Coder R1');
  assert.strictEqual(customCoder.provider, 'cinlo');
  assert.strictEqual(customCoder.reasoning, true);
  assert.deepStrictEqual(customCoder.reasoningEfforts, ['low', 'high', 'max']);
  assert.deepStrictEqual(customCoder.thinkingLevelMap, { low: 'low', high: 'high', max: 'max' });

  // 3. New non-reasoning custom model 'local-fast' was added with reasoning: false
  const localFast = merged.find((m) => m.id === 'local-fast');
  assert.ok(localFast);
  assert.strictEqual(localFast.provider, 'cinlo');
  assert.strictEqual(localFast.reasoning, false);

  // 4. Handles undefined / null / empty providers gracefully
  assert.deepStrictEqual(mergeCustomProviderModels(baseModels, undefined), baseModels);
  assert.deepStrictEqual(mergeCustomProviderModels(baseModels, {}), baseModels);
});

test('bridge: dynamic discovery populates arbitrary newly defined agents and updates on definition removal', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    // 1. Initially no simulated installed agents -> empty categories
    const initial = await getSddProfilesPi();
    assert.strictEqual(initial.categories.length, 0);
    assert.strictEqual(initial.allAgents.length, 0);

    // 2. Set arbitrary new agents in simulated installed config
    fakeStorage.setItem(
      MOCK_SDD_INSTALLED_AGENTS_KEY,
      JSON.stringify([
        { id: 'custom-infra-planner', category: 'Infrastructure', scope: 'project' },
        { id: 'custom-db-migrator', category: 'Database', scope: 'project' },
        { id: 'review-security-plus', scope: 'global' },
      ])
    );

    const populated = await getSddProfilesPi();
    assert.strictEqual(populated.categories.length, 3);

    const infraCat = populated.categories.find((c) => c.name === 'Infrastructure');
    assert.ok(infraCat);
    assert.deepStrictEqual(infraCat.agents, ['custom-infra-planner']);

    const dbCat = populated.categories.find((c) => c.name === 'Database');
    assert.ok(dbCat);
    assert.deepStrictEqual(dbCat.agents, ['custom-db-migrator']);

    const reviewCat = populated.categories.find((c) => c.id === 'reviewers');
    assert.ok(reviewCat);
    assert.deepStrictEqual(reviewCat.agents, ['review-security-plus']);

    assert.deepStrictEqual(populated.allAgents.sort(), [
      'custom-db-migrator',
      'custom-infra-planner',
      'review-security-plus',
    ]);

    // 3. Remove one definition -> category is omitted when empty
    fakeStorage.setItem(
      MOCK_SDD_INSTALLED_AGENTS_KEY,
      JSON.stringify([
        { id: 'custom-infra-planner', category: 'Infrastructure', scope: 'project' },
      ])
    );

    const updated = await getSddProfilesPi();
    assert.strictEqual(updated.categories.length, 1);
    assert.strictEqual(updated.categories[0].name, 'Infrastructure');
    assert.strictEqual(updated.categories.some((c) => c.name === 'Database'), false);
    assert.strictEqual(updated.categories.some((c) => c.id === 'reviewers'), false);
    assert.deepStrictEqual(updated.allAgents, ['custom-infra-planner']);
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('bridge: getSddProfilesPi retains model_profiles in preview summaries', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    await saveSddProfilePi({
      scope: 'global',
      profile: {
        name: 'summary-test-profile',
        description: 'Profile testing model_profiles retention',
        default_model: 'anthropic/claude-3.5-sonnet',
        model_profiles: {
          'test-agent': { model: 'openai/gpt-4o', effort: 'high' },
        },
      },
    });

    const payload = await getSddProfilesPi();
    const summary = payload.profiles.find((p) => p.name === 'summary-test-profile');
    assert.ok(summary);
    assert.deepStrictEqual(summary.model_profiles, {
      'test-agent': { model: 'openai/gpt-4o', effort: 'high' },
    });
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('bridge: setActiveSddProfilePi fails honestly when named profile does not exist', async () => {
  const fakeStorage = new MemoryStorage();
  (globalThis as any).window = { localStorage: fakeStorage };
  (globalThis as any).localStorage = fakeStorage;

  try {
    const res = await setActiveSddProfilePi({
      scope: 'global',
      name: 'non-existent-profile',
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('not found'));
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  }
});

test('mergeCustomProviderModels: preserves thinkingLevel and defaultThinkingLevel without metadata loss', () => {
  const baseModels: ModelInfo[] = [
    {
      id: 'cpam/agy',
      name: 'Agy',
      provider: 'cpam',
    },
  ];

  const customProviders = {
    cpam: {
      name: 'CPAM',
      models: [
        {
          id: 'agy',
          name: 'Agy',
          reasoning: true,
          thinkingLevel: 'high',
          defaultThinkingLevel: 'high',
          thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' },
        },
        {
          id: 'new-model',
          name: 'New Reasoning Model',
          reasoning: true,
          thinkingLevel: 'medium',
          defaultThinkingLevel: 'low',
        },
      ],
    },
  };

  const merged = mergeCustomProviderModels(baseModels, customProviders as any);

  // 1. Updated existing model retains thinkingLevel and defaultThinkingLevel
  const agy = merged.find((m) => m.id === 'cpam/agy');
  assert.ok(agy);
  assert.strictEqual(agy.thinkingLevel, 'high');
  assert.strictEqual(agy.defaultThinkingLevel, 'high');

  // 2. Newly added model retains thinkingLevel and defaultThinkingLevel
  const newModel = merged.find((m) => m.id === 'new-model');
  assert.ok(newModel);
  assert.strictEqual(newModel.thinkingLevel, 'medium');
  assert.strictEqual(newModel.defaultThinkingLevel, 'low');
});

test('orchestrator and subagent selection defaults: selects model configured default effort and respects settings override', () => {
  const catalog: ModelInfo[] = [
    {
      id: 'cpam/agy',
      name: 'Agy',
      provider: 'cpam',
      reasoning: true,
      defaultThinkingLevel: 'high',
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' },
    },
    {
      id: 'openai/o3-mini',
      name: 'o3-mini',
      provider: 'openai',
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
    },
    {
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o Mini',
      provider: 'openai',
      reasoning: false,
    },
  ];

  // 1. Selecting orchestrator model cpam/agy resolves to its default 'high'
  const agyModel = findModelInCatalog(catalog, 'cpam/agy');
  assert.ok(agyModel);
  const agySupported = getSupportedReasoningEffortsForModel(agyModel);
  const agyDefault = resolveModelDefaultThinkingLevel(agyModel, {}, agySupported);
  assert.strictEqual(agyDefault, 'high');

  // 2. Settings override takes precedence over agy's default 'high'
  const settingsOverrides: ModelThinkingLevelsMap = { 'cpam/agy': 'medium' };
  const agyOverridden = resolveModelDefaultThinkingLevel(agyModel, settingsOverrides, agySupported);
  assert.strictEqual(agyOverridden, 'medium');

  // 3. Selecting explicit subagent model sets that subagent's effort to its resolved default
  const o3Model = findModelInCatalog(catalog, 'openai/o3-mini');
  assert.ok(o3Model);
  const o3Supported = getSupportedReasoningEffortsForModel(o3Model);
  const o3Default = resolveModelDefaultThinkingLevel(o3Model, {}, o3Supported);
  assert.strictEqual(o3Default, 'medium');

  // 4. Selecting non-reasoning subagent model sets effort to 'off'
  const nonReasoning = findModelInCatalog(catalog, 'openai/gpt-4o-mini');
  assert.ok(nonReasoning);
  const nonReasoningSupported = getSupportedReasoningEffortsForModel(nonReasoning);
  assert.deepStrictEqual(nonReasoningSupported, ['off']);
  const nonReasoningDefault = resolveModelDefaultThinkingLevel(nonReasoning, {}, nonReasoningSupported);
  assert.strictEqual(nonReasoningDefault, 'off');

  // 5. Inherited subagent model preserves inherit behavior without creating unnecessary overrides
  const modelProfiles: Record<string, { model: string; effort?: string }> = {
    'inheriting-agent': { model: '', effort: '' },
    'explicit-agent': { model: 'openai/o3-mini', effort: 'medium' },
    'overridden-effort-only': { model: '', effort: 'high' },
  };

  // When main model changes to nonReasoning (off-only):
  // - 'inheriting-agent' has empty effort -> remains empty (preserves inherit)
  // - 'overridden-effort-only' had explicit effort 'high' -> clamped to 'off'
  // - 'explicit-agent' has its own model -> untouched
  const updatedProfiles = { ...modelProfiles };
  for (const [key, entry] of Object.entries(updatedProfiles)) {
    if (!entry.model || entry.model.trim() === '') {
      if (entry.effort) {
        const clamped = resolveCompatibleEffort(entry.effort, nonReasoningSupported);
        updatedProfiles[key] = { ...entry, effort: clamped || undefined };
      }
    }
  }

  assert.strictEqual(updatedProfiles['inheriting-agent'].model, '');
  assert.strictEqual(updatedProfiles['inheriting-agent'].effort, '');
  assert.strictEqual(updatedProfiles['overridden-effort-only'].effort, 'off');
  assert.strictEqual(updatedProfiles['explicit-agent'].model, 'openai/o3-mini');
  assert.strictEqual(updatedProfiles['explicit-agent'].effort, 'medium');
});

test('ProfilesView: passes modelThinkingLevels from useProfiles to ProfileModal', () => {
  let capturedView: any = null;
  function Harness() {
    capturedView = ProfilesView({ cwd: '/test-cwd' });
    return null;
  }

  renderToStaticMarkup(React.createElement(Harness));
  assert.ok(capturedView, 'ProfilesView returned a rendered tree');

  let profileModalElement: any = null;
  React.Children.forEach(capturedView?.props?.children, (child: any) => {
    if (child?.type === ProfileModal) {
      profileModalElement = child;
    }
  });

  assert.ok(profileModalElement, 'ProfileModal element exists in ProfilesView tree');
  assert.ok(
    'modelThinkingLevels' in profileModalElement.props,
    'ProfileModal must receive modelThinkingLevels prop'
  );
  assert.strictEqual(
    typeof profileModalElement.props.modelThinkingLevels,
    'object',
    'modelThinkingLevels should be an object (map)'
  );
});

test('ProfileModal: uses passed modelThinkingLevels map for default effort on model selection', () => {
  const catalog: ModelInfo[] = [
    {
      id: 'cpam/agy',
      name: 'Agy',
      provider: 'cpam',
      reasoning: true,
      defaultThinkingLevel: 'high',
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' },
    },
  ];

  function findChildByType(node: any, type: any): any {
    if (!node) return null;
    if (node.type === type) return node;
    if (node.props?.children) {
      const children = React.Children.toArray(node.props.children);
      for (const child of children) {
        const found = findChildByType(child, type);
        if (found) return found;
      }
    }
    return null;
  }

  const updatedFields: Record<string, any> = {};
  let modalElement: any = null;

  function ModalHarness() {
    modalElement = ProfileModal({
      isOpen: true,
      isEditing: false,
      isSaving: false,
      formData: EMPTY_PROFILE_FORM,
      error: null,
      availableModels: catalog,
      categories: [],
      modelThinkingLevels: { 'cpam/agy': 'low' },
      onClose: () => {},
      onChangeField: (field, value) => {
        updatedFields[field] = value;
      },
      onChangeAgentModel: () => {},
      onRemoveAgentOverride: () => {},
      onSave: () => {},
    });
    return null;
  }

  renderToStaticMarkup(React.createElement(ModalHarness));
  const modelSelect = findChildByType(modalElement, ModelSelect);
  assert.ok(modelSelect, 'ModelSelect should be rendered inside ProfileModal');

  // Trigger main model selection
  modelSelect.props.onChange('cpam/agy');

  assert.strictEqual(updatedFields.default_model, 'cpam/agy');
  // Must use override from modelThinkingLevels ('low') instead of model default ('high')
  assert.strictEqual(
    updatedFields.default_effort,
    'low',
    'ProfileModal must use the passed modelThinkingLevels override on model selection'
  );
});

test('getPiChainsPi: invokes get_pi_chains and returns chains list', async () => {
  const mockChains = [
    {
      name: 'spec-driven-pipeline',
      description: 'End-to-end SDD flow',
      path: '/path/chains/sdd.json',
      steps: [
        { name: 'explore', description: 'Analyze requirements' },
        { name: 'worker', description: 'Implement code' },
        { name: 'verify', description: 'Run test suite' },
      ],
    },
  ];

  const result = await getPiChainsPi(async (cmd) => {
    assert.strictEqual(cmd, 'get_pi_chains');
    return mockChains;
  });

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'spec-driven-pipeline');
  assert.strictEqual(result[0].steps.length, 3);
});

test('getPiChainsPi: returns empty array when invoke fails', async () => {
  const result = await getPiChainsPi(async () => {
    throw new Error('IPC failed');
  });

  assert.deepStrictEqual(result, []);
});

test('ProfileModal: renders profile-agent-desc-hint when agentMeta contains descriptions', () => {
  const catalog: ModelInfo[] = [
    {
      id: 'test/m1',
      name: 'M1',
      provider: 'test',
      reasoning: false,
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(ProfileModal, {
      isOpen: true,
      isEditing: false,
      isSaving: false,
      formData: {
        ...EMPTY_PROFILE_FORM,
        model_profiles: {
          'test-agent': { model: 'test/m1' },
        },
      },
      error: null,
      availableModels: catalog,
      categories: [
        {
          id: 'test-cat',
          name: 'Testing Category',
          agents: ['test-agent'],
        },
      ],
      agentMeta: {
        'test-agent': {
          name: 'test-agent',
          description: 'Autonomous exploration agent for codebase',
        },
      },
      onClose: () => {},
      onChangeField: () => {},
      onChangeAgentModel: () => {},
      onRemoveAgentOverride: () => {},
      onSave: () => {},
    })
  );

  assert.ok(html.includes('profile-agent-desc-hint'));
  assert.ok(html.includes('Autonomous exploration agent for codebase'));
});

test('ProfilesView: renders chains section when chains are provided', () => {
  const mockChains = [
    {
      name: 'spec-pipeline',
      description: 'Pipeline for formal review',
      path: '/path/chains/sdd.json',
      steps: [
        { name: 'explore', description: 'Analyze requirements' },
        { name: 'worker', description: 'Implement code' },
        { name: 'verify', description: 'Run test suite' },
      ],
    },
  ];

  // Render chains-grid card markup structure directly to test visual representation
  const html = renderToStaticMarkup(
    React.createElement(
      'div',
      { className: 'profiles-chains-section' },
      React.createElement('div', { className: 'profiles-section-header' },
        React.createElement('h3', { className: 'profiles-section-title' }, `Cadenas de Trabajo / Chains (${mockChains.length})`),
        React.createElement('p', { className: 'profiles-section-subtitle' }, 'Pipelines coordinados de subagentes.')
      ),
      React.createElement(
        'div',
        { className: 'chains-grid' },
        mockChains.map((chain) =>
          React.createElement(
            'div',
            { key: chain.name, className: 'chain-card' },
            React.createElement('div', { className: 'chain-card-header' },
              React.createElement('span', { className: 'chain-badge' }, 'Chain'),
              React.createElement('h4', { className: 'chain-name' }, chain.name)
            ),
            React.createElement('p', { className: 'chain-desc' }, chain.description),
            React.createElement(
              'div',
              { className: 'chain-steps' },
              React.createElement('span', { className: 'chain-steps-label' }, 'Flujo de ejecución:'),
              React.createElement(
                'div',
                { className: 'chain-steps-flow' },
                chain.steps.map((st, idx) =>
                  React.createElement(
                    React.Fragment,
                    { key: st.name },
                    React.createElement('span', { className: 'chain-step-chip', title: st.description }, st.name),
                    idx < chain.steps.length - 1 ? React.createElement('span', { className: 'chain-step-arrow' }, '→') : null
                  )
                )
              )
            )
          )
        )
      )
    )
  );

  assert.ok(html.includes('profiles-chains-section'));
  assert.ok(html.includes('spec-pipeline'));
  assert.ok(html.includes('Pipeline for formal review'));
  assert.ok(html.includes('chain-step-chip'));
  assert.ok(html.includes('explore'));
  assert.ok(html.includes('worker'));
  assert.ok(html.includes('verify'));
  assert.ok(html.includes('→'));
});
