import assert from 'node:assert';
import test from 'node:test';

import {
  parseReasoningEffort,
  sanitizeProfileName,
  isSyntheticAgentKey,
  buildDynamicCategories,
  parseAgentMarkdownFrontmatter,
  resolveEffectiveProfile,
  applyProfileToSubagentsConfig,
  resolveProfileModel,
  resolveProfileEffort,
  applyProfileRuntime,
  generateProfileId,
  REASONING_EFFORTS,
  type Profile,
  type ProfileSummary,
  type DiscoveredAgentMeta,
} from '@core/types/profiles';
import {
  getSupportedReasoningEffortsForModel,
  type ModelInfo,
} from '@core/types/models';

test('parseReasoningEffort: normalizes valid effort levels and preserves casing/trimming', () => {
  for (const effort of REASONING_EFFORTS) {
    assert.strictEqual(parseReasoningEffort(effort), effort);
    assert.strictEqual(parseReasoningEffort(effort.toUpperCase()), effort);
    assert.strictEqual(parseReasoningEffort(`  ${effort}  `), effort);
  }

  assert.strictEqual(parseReasoningEffort('off'), 'off');
  assert.strictEqual(parseReasoningEffort('MINIMAL'), 'minimal');
  assert.strictEqual(parseReasoningEffort(' low '), 'low');
  assert.strictEqual(parseReasoningEffort('Medium'), 'medium');
  assert.strictEqual(parseReasoningEffort('HIGH'), 'high');
  assert.strictEqual(parseReasoningEffort('xHigh'), 'xhigh');
  assert.strictEqual(parseReasoningEffort(' MAX '), 'max');
});

test('parseReasoningEffort: maps reset tokens and blank strings to undefined', () => {
  const resetTokens = ['default', 'predeterminado', 'heredar', 'none', '-', 'unset'];

  for (const token of resetTokens) {
    assert.strictEqual(
      parseReasoningEffort(token),
      undefined,
      `Expected token "${token}" to resolve to undefined`
    );
    assert.strictEqual(
      parseReasoningEffort(token.toUpperCase()),
      undefined,
      `Expected uppercase token "${token.toUpperCase()}" to resolve to undefined`
    );
    assert.strictEqual(
      parseReasoningEffort(`  ${token}  `),
      undefined,
      `Expected padded token "  ${token}  " to resolve to undefined`
    );
  }

  assert.strictEqual(parseReasoningEffort(''), undefined);
  assert.strictEqual(parseReasoningEffort('   '), undefined);
  assert.strictEqual(parseReasoningEffort(null), undefined);
  assert.strictEqual(parseReasoningEffort(undefined), undefined);
});

test('parseReasoningEffort: handles non-string and invalid inputs cleanly or throws in strict mode', () => {
  // Non-strict mode: silently returns undefined for invalid values
  assert.strictEqual(parseReasoningEffort(12345), undefined);
  assert.strictEqual(parseReasoningEffort(true), undefined);
  assert.strictEqual(parseReasoningEffort({}), undefined);
  assert.strictEqual(parseReasoningEffort([]), undefined);
  assert.strictEqual(parseReasoningEffort('turbo'), undefined);
  assert.strictEqual(parseReasoningEffort('ultra-high'), undefined);

  // Strict mode: throws descriptive errors
  assert.throws(
    () => parseReasoningEffort(123, true),
    /Invalid effort value type: number/
  );
  assert.throws(
    () => parseReasoningEffort(true, true),
    /Invalid effort value type: boolean/
  );
  assert.throws(
    () => parseReasoningEffort('turbo', true),
    /Invalid effort level: "turbo"/
  );

  // Strict mode on null / undefined still returns undefined
  assert.strictEqual(parseReasoningEffort(null, true), undefined);
  assert.strictEqual(parseReasoningEffort(undefined, true), undefined);
});

test('sanitizeProfileName: replaces spaces, uppercase, and special characters with hyphens', () => {
  assert.strictEqual(sanitizeProfileName('My Custom Profile'), 'my-custom-profile');
  assert.strictEqual(sanitizeProfileName('balanced-default'), 'balanced-default');
  assert.strictEqual(sanitizeProfileName('PROJECT_profile_1'), 'project_profile_1');
  assert.strictEqual(sanitizeProfileName('deep reasoning!'), 'deep-reasoning-');
  assert.strictEqual(sanitizeProfileName('profile@name#2025$'), 'profile-name-2025-');
  assert.strictEqual(sanitizeProfileName('  padded profile  '), 'padded-profile');
  assert.strictEqual(sanitizeProfileName('multi---hyphen'), 'multi---hyphen');
});

test('isSyntheticAgentKey: identifies synthetic keys and rejects invalid names', () => {
  // Synthetic prefix icons
  assert.strictEqual(isSyntheticAgentKey('⚡ fast-agent'), true);
  assert.strictEqual(isSyntheticAgentKey('🧠 deep-thinker'), true);
  assert.strictEqual(isSyntheticAgentKey('📦 package-helper'), true);
  assert.strictEqual(isSyntheticAgentKey('👑 orchestrator'), true);

  // Placeholder / assign text
  assert.strictEqual(isSyntheticAgentKey('custom-agent [Asignar modelo]'), true);
  assert.strictEqual(isSyntheticAgentKey('[Asignar modelo]'), true);

  // Whitespace within keys
  assert.strictEqual(isSyntheticAgentKey('sdd explore'), true);
  assert.strictEqual(isSyntheticAgentKey('my agent'), true);
  assert.strictEqual(isSyntheticAgentKey('agent with multiple spaces'), true);

  // Empty or invalid types
  assert.strictEqual(isSyntheticAgentKey(''), true);
  assert.strictEqual(isSyntheticAgentKey('   '), true);
  assert.strictEqual(isSyntheticAgentKey(null as unknown as string), true);
  assert.strictEqual(isSyntheticAgentKey(undefined as unknown as string), true);
  assert.strictEqual(isSyntheticAgentKey(123 as unknown as string), true);

  // Valid, clean agent identifiers
  assert.strictEqual(isSyntheticAgentKey('sdd-explore'), false);
  assert.strictEqual(isSyntheticAgentKey('sdd-verify'), false);
  assert.strictEqual(isSyntheticAgentKey('gentle-ai-worker'), false);
  assert.strictEqual(isSyntheticAgentKey('jd-judge-a'), false);
  assert.strictEqual(isSyntheticAgentKey('custom-subagent-1'), false);
  assert.strictEqual(isSyntheticAgentKey('my_project_agent'), false);
});

test('buildDynamicCategories: returns empty categories when no agents are provided', () => {
  const emptyResult = buildDynamicCategories([]);
  assert.strictEqual(emptyResult.length, 0);
  assert.deepStrictEqual(emptyResult, []);
});

test('buildDynamicCategories: filters out synthetic agent keys and produces empty result if all are synthetic', () => {
  const onlySynthetic = buildDynamicCategories([
    '⚡ runner',
    '🧠 brain',
    '📦 box',
    '👑 king',
    'foo [Asignar modelo]',
    'with space',
    '',
  ]);
  assert.strictEqual(onlySynthetic.length, 0);
  assert.deepStrictEqual(onlySynthetic, []);
});

test('buildDynamicCategories: dynamically categorizes arbitrary newly defined agents without static catalog', () => {
  const agents: DiscoveredAgentMeta[] = [
    { id: 'zeta-custom-worker', scope: 'project' },
    { id: 'alpha-custom-tool', scope: 'project' },
    { id: 'sdd-custom-phase', scope: 'global' },
    { id: 'jd-custom-evaluator', scope: 'global' },
    { id: 'review-custom-lint', scope: 'global' },
    { id: 'gentle-ai-planner', scope: 'global' },
  ];

  const categories = buildDynamicCategories(agents);

  // Verifies categories are generated dynamically from discovered prefixes and scope
  const catIds = categories.map((c) => c.id);
  assert.ok(catIds.includes('sdd-core'));
  assert.ok(catIds.includes('judgment-day'));
  assert.ok(catIds.includes('reviewers'));
  assert.ok(catIds.includes('gentle-ai'));
  assert.ok(catIds.includes('project'));

  // Agents inside each category are sorted alphabetically
  const projectCat = categories.find((c) => c.id === 'project')!;
  assert.deepStrictEqual(projectCat.agents, ['alpha-custom-tool', 'zeta-custom-worker']);

  // Removing an agent removes it from category; if category becomes empty it is omitted
  const withoutSdd = buildDynamicCategories(agents.filter((a) => a.id !== 'sdd-custom-phase'));
  assert.strictEqual(withoutSdd.some((c) => c.id === 'sdd-core'), false);
});

test('buildDynamicCategories: respects explicit metadata category when provided', () => {
  const agents: DiscoveredAgentMeta[] = [
    { id: 'agent-one', category: 'Security & Compliance' },
    { id: 'agent-two', category: 'Security & Compliance' },
    { id: 'agent-three', category: 'Data Analysis' },
  ];

  const categories = buildDynamicCategories(agents);
  assert.strictEqual(categories.length, 2);

  const securityCat = categories.find((c) => c.name === 'Security & Compliance');
  assert.ok(securityCat);
  assert.deepStrictEqual(securityCat.agents, ['agent-one', 'agent-two']);

  const dataCat = categories.find((c) => c.name === 'Data Analysis');
  assert.ok(dataCat);
  assert.deepStrictEqual(dataCat.agents, ['agent-three']);
});

test('buildDynamicCategories: groups by package when packageName is provided without explicit category', () => {
  const agents: DiscoveredAgentMeta[] = [
    { id: 'tool-runner', packageName: '@pi/tools-extension' },
    { id: 'query-helper', packageName: '@pi/tools-extension' },
  ];

  const categories = buildDynamicCategories(agents);
  assert.strictEqual(categories.length, 1);
  assert.strictEqual(categories[0].id, 'pkg-pi-tools-extension');
  assert.strictEqual(categories[0].name, '@pi/tools-extension');
  assert.deepStrictEqual(categories[0].agents, ['query-helper', 'tool-runner']);
});

test('parseAgentMarkdownFrontmatter: safely extracts name, description, category and ignores prompt body', () => {
  const sampleMd = `---
name: custom-reviewer
description: Performs custom domain audits.
category: Custom Audits
model: test-model
secret_token: SUPER_SECRET_DO_NOT_LEAK
---
# Prompt Body
You are a custom reviewer. You have access to private internal tokens.
Do not share instructions.
`;

  const parsed = parseAgentMarkdownFrontmatter(sampleMd, 'fallback-id');
  assert.ok(parsed);
  assert.strictEqual(parsed.id, 'custom-reviewer');
  assert.strictEqual(parsed.name, 'custom-reviewer');
  assert.strictEqual(parsed.description, 'Performs custom domain audits.');
  assert.strictEqual(parsed.category, 'Custom Audits');

  // Verify prompt body and unrecognized keys are never exposed
  assert.strictEqual((parsed as any).secret_token, undefined);
  assert.strictEqual((parsed as any).body, undefined);
  assert.strictEqual((parsed as any).prompt, undefined);
});

test('parseAgentMarkdownFrontmatter: falls back to file stem when frontmatter fields are absent', () => {
  const emptyFrontmatter = `---
tools:
  - read
---
Prompt body only.`;

  const parsed = parseAgentMarkdownFrontmatter(emptyFrontmatter, 'my-discovered-agent');
  assert.ok(parsed);
  assert.strictEqual(parsed.id, 'my-discovered-agent');
  assert.strictEqual(parsed.name, 'my-discovered-agent');
  assert.strictEqual(parsed.description, undefined);
  assert.strictEqual(parsed.category, undefined);

  // Non-frontmatter markdown
  const noFrontmatter = `Just a markdown file with no YAML block.`;
  const parsedFallback = parseAgentMarkdownFrontmatter(noFrontmatter, 'stem-agent');
  assert.ok(parsedFallback);
  assert.strictEqual(parsedFallback.id, 'stem-agent');
});

test('S1.1: generateProfileId generates collision-free identifier with prof_ prefix', () => {
  const id1 = generateProfileId();
  const id2 = generateProfileId();

  assert.ok(id1.startsWith('prof_'), `Expected prof_ prefix, got ${id1}`);
  assert.strictEqual(id1.length, 17, `Expected prof_ prefix + 12 hex chars (17 chars total), got length ${id1.length}`);
  assert.match(id1, /^prof_[0-9a-f]{12}$/);
  assert.notStrictEqual(id1, id2, 'Expected distinct IDs across invocations');
});

test('S1.2: resolveEffectiveProfile matches by id when pointer contains profile id and supports duplicate names', () => {
  const profiles: ProfileSummary[] = [
    {
      id: 'prof_111111111111',
      name: 'Mi Perfil Compartido',
      scope: 'global',
      agent_count: 5,
      is_active: false,
    },
    {
      id: 'prof_222222222222',
      name: 'Mi Perfil Compartido',
      scope: 'global',
      agent_count: 8,
      is_active: false,
    },
  ];

  // Resolve by id of the second one
  const result = resolveEffectiveProfile('prof_222222222222', null, profiles);
  assert.strictEqual(result.name, 'Mi Perfil Compartido');
  assert.strictEqual(result.id, 'prof_222222222222');
  assert.ok(result.profile);
  assert.strictEqual(result.profile?.id, 'prof_222222222222');
  assert.strictEqual(result.profile?.agent_count, 8);
});

test('S2.1 / S2.2: resolveEffectiveProfile matches legacy profiles without id by name or sanitized name', () => {
  const profiles: ProfileSummary[] = [
    {
      name: 'balanced-custom',
      scope: 'global',
      agent_count: 4,
      is_active: false,
    },
  ];

  const result = resolveEffectiveProfile(null, 'Balanced Custom', profiles);
  assert.strictEqual(result.name, 'balanced-custom');
  assert.ok(result.profile);
  assert.strictEqual(result.profile?.name, 'balanced-custom');
});

test('resolveEffectiveProfile: returns project active profile with isFallback: false when project active is set', () => {
  const profiles: ProfileSummary[] = [
    {
      name: 'global-team-profile',
      scope: 'global',
      agent_count: 10,
      is_active: false,
    },
    {
      name: 'project-special',
      scope: 'project',
      agent_count: 8,
      is_active: false,
    },
  ];

  const result = resolveEffectiveProfile('project-special', 'global-team-profile', profiles);
  assert.strictEqual(result.name, 'project-special');
  assert.strictEqual(result.scope, 'project');
  assert.strictEqual(result.isFallback, false);
  assert.ok(result.profile);
  assert.strictEqual(result.profile.name, 'project-special');
});

test('resolveEffectiveProfile: falls back to global active profile with isFallback: true when project active is absent or empty', () => {
  const profiles: ProfileSummary[] = [
    {
      name: 'global-team-profile',
      scope: 'global',
      agent_count: 10,
      is_active: false,
    },
  ];

  // projectActive is null
  const nullResult = resolveEffectiveProfile(null, 'global-team-profile', profiles);
  assert.strictEqual(nullResult.name, 'global-team-profile');
  assert.strictEqual(nullResult.scope, 'global');
  assert.strictEqual(nullResult.isFallback, true);
  assert.ok(nullResult.profile);
  assert.strictEqual(nullResult.profile.name, 'global-team-profile');

  // projectActive is undefined
  const undefResult = resolveEffectiveProfile(undefined, 'global-team-profile', profiles);
  assert.strictEqual(undefResult.name, 'global-team-profile');
  assert.strictEqual(undefResult.isFallback, true);

  // projectActive is blank whitespace
  const blankResult = resolveEffectiveProfile('   ', 'global-team-profile', profiles);
  assert.strictEqual(blankResult.name, 'global-team-profile');
  assert.strictEqual(blankResult.isFallback, true);
});

test('resolveEffectiveProfile: returns null when neither project active nor global active is set', () => {
  // Profiles exist, but neither active pointer is set
  const profiles: ProfileSummary[] = [
    {
      name: 'speed-economy',
      scope: 'global',
      agent_count: 14,
      is_active: false,
    },
    {
      name: 'deep-reasoning',
      scope: 'project',
      agent_count: 14,
      is_active: false,
    },
  ];

  const result = resolveEffectiveProfile(null, null, profiles);
  assert.strictEqual(result.name, null);
  assert.strictEqual(result.scope, null);
  assert.strictEqual(result.isFallback, false);
  assert.strictEqual(result.profile, null);

  // Empty profiles list
  const emptyResult = resolveEffectiveProfile(null, null, []);
  assert.strictEqual(emptyResult.name, null);
  assert.strictEqual(emptyResult.scope, null);
  assert.strictEqual(emptyResult.isFallback, false);
  assert.strictEqual(emptyResult.profile, null);
});

test('applyProfileToSubagentsConfig: applies default_model, default_effort, active_profile, and model_profiles', () => {
  const currentConfig: Record<string, unknown> = {
    existing_setting: 'preserve_me',
  };

  const profile: Profile = {
    name: 'test-profile',
    default_model: 'anthropic/claude-sonnet-4-5',
    default_effort: 'high',
    model_profiles: {
      'sdd-explore': { model: 'anthropic/claude-haiku-4-5', effort: 'low' },
      'sdd-apply': { model: 'anthropic/claude-sonnet-4-5' },
    },
  };

  const nextConfig = applyProfileToSubagentsConfig(currentConfig, profile);

  assert.strictEqual(nextConfig.active_profile, 'test-profile');
  assert.strictEqual(nextConfig.default_model, 'anthropic/claude-sonnet-4-5');
  assert.strictEqual(nextConfig.default_effort, 'high');
  assert.strictEqual(nextConfig.existing_setting, 'preserve_me');

  const modelProfiles = nextConfig.model_profiles as Record<string, { model: string; effort?: string }>;
  assert.ok(modelProfiles);
  assert.deepStrictEqual(modelProfiles['sdd-explore'], {
    model: 'anthropic/claude-haiku-4-5',
    effort: 'low',
  });
  assert.deepStrictEqual(modelProfiles['sdd-apply'], {
    model: 'anthropic/claude-sonnet-4-5',
  });
});

test('applyProfileToSubagentsConfig: preserves existing custom fields in subagents.json', () => {
  const currentConfig: Record<string, unknown> = {
    timeouts: { sdd_apply: 300, general: 60 },
    custom_tools: ['linter', 'formatter'],
    shortcuts: { e: 'sdd-explore', v: 'sdd-verify' },
    custom_flag: true,
    default_effort: 'low',
  };

  const profile: Profile = {
    name: 'minimal-profile',
    default_model: 'openai/o3-mini',
    // no default_effort provided -> should delete existing default_effort
    model_profiles: {
      'sdd-tasks': { model: 'openai/o3-mini', effort: 'medium' },
    },
  };

  const nextConfig = applyProfileToSubagentsConfig(currentConfig, profile);

  assert.strictEqual(nextConfig.active_profile, 'minimal-profile');
  assert.strictEqual(nextConfig.default_model, 'openai/o3-mini');
  assert.strictEqual('default_effort' in nextConfig, false);

  // Custom fields preserved
  assert.deepStrictEqual(nextConfig.timeouts, { sdd_apply: 300, general: 60 });
  assert.deepStrictEqual(nextConfig.custom_tools, ['linter', 'formatter']);
  assert.deepStrictEqual(nextConfig.shortcuts, { e: 'sdd-explore', v: 'sdd-verify' });
  assert.strictEqual(nextConfig.custom_flag, true);
});

test('applyProfileToSubagentsConfig: filters out synthetic agent keys', () => {
  const profile: Profile = {
    name: 'synthetic-filter-test',
    default_model: 'anthropic/claude-sonnet-4-5',
    model_profiles: {
      'sdd-verify': { model: 'anthropic/claude-haiku-4-5', effort: 'low' },
      '⚡ fast-agent': { model: 'fast-model' },
      '🧠 deep-thinker': { model: 'o3' },
      '📦 packager': { model: 'haiku' },
      '👑 orchestrator': { model: 'opus' },
      'bad-key [Asignar modelo]': { model: 'dummy' },
      'invalid key with spaces': { model: 'dummy' },
      '': { model: 'dummy' },
    },
  };

  const nextConfig = applyProfileToSubagentsConfig({}, profile);
  const modelProfiles = nextConfig.model_profiles as Record<string, { model: string; effort?: string }>;

  assert.ok(modelProfiles);
  assert.strictEqual(Object.keys(modelProfiles).length, 1);
  assert.ok(modelProfiles['sdd-verify']);
  assert.strictEqual(modelProfiles['sdd-verify'].model, 'anthropic/claude-haiku-4-5');
});

test('getSupportedReasoningEffortsForModel: returns ["off"] when reasoning is explicitly false', () => {
  const modelNoReasoning: ModelInfo = {
    id: 'claude-3-haiku',
    reasoning: false,
  };
  assert.deepStrictEqual(getSupportedReasoningEffortsForModel(modelNoReasoning), ['off']);

  const modelWithFalseAndMap: ModelInfo = {
    id: 'test-false-priority',
    reasoning: false,
  };
  assert.deepStrictEqual(getSupportedReasoningEffortsForModel(modelWithFalseAndMap), ['off']);
});

test('getSupportedReasoningEffortsForModel: derives supported levels from thinkingLevelMap', () => {
  const modelWithMap: ModelInfo = {
    id: 'test-mapped-model',
    thinkingLevelMap: {
      off: 'off',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
  };
  assert.deepStrictEqual(
    getSupportedReasoningEffortsForModel(modelWithMap),
    ['off', 'low', 'medium', 'high', 'xhigh']
  );
});

test('getSupportedReasoningEffortsForModel: derives supported levels from reasoningEfforts', () => {
  const modelWithEfforts: ModelInfo = {
    id: 'test-efforts-model',
    reasoningEfforts: ['LOW', 'HIGH', 'max'],
  };
  assert.deepStrictEqual(
    getSupportedReasoningEffortsForModel(modelWithEfforts),
    ['low', 'high', 'max']
  );
});

test('getSupportedReasoningEffortsForModel: defaults to ["low", "medium", "high"] for undefined/unconfigured models', () => {
  assert.deepStrictEqual(
    getSupportedReasoningEffortsForModel(null),
    ['low', 'medium', 'high']
  );
  assert.deepStrictEqual(
    getSupportedReasoningEffortsForModel(undefined),
    ['low', 'medium', 'high']
  );
  assert.deepStrictEqual(
    getSupportedReasoningEffortsForModel({ id: 'plain-model' }),
    ['low', 'medium', 'high']
  );
  assert.deepStrictEqual(
    getSupportedReasoningEffortsForModel({ id: 'reasoning-empty', reasoning: true }),
    ['low', 'medium', 'high']
  );
});

test('resolveProfileModel: resolves exact approved catalog metadata and avoids double prefixing', () => {
  const catalog: ModelInfo[] = [
    { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o' },
    { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', name: 'Claude 3.5 Sonnet' },
    { id: 'deepseek/deepseek-r1', provider: 'openrouter', name: 'DeepSeek R1' },
    { id: 'claude-3-7-sonnet-20250219', provider: 'anthropic', name: 'Claude 3.7 Sonnet' },
  ];

  // 1. Matches qualified ID with single slash
  const r1 = resolveProfileModel('openai/gpt-4o', catalog);
  assert.deepStrictEqual(r1, { provider: 'openai', modelId: 'gpt-4o' });

  // 2. Matches multi-slash qualified ID in catalog without double-prefixing
  const r2 = resolveProfileModel('openrouter/anthropic/claude-3.5-sonnet', catalog);
  assert.deepStrictEqual(r2, { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' });

  // 3. Matches direct model id if given without provider prefix
  const r3 = resolveProfileModel('anthropic/claude-3.5-sonnet', catalog);
  assert.deepStrictEqual(r3, { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' });

  // 4. Fallback splits only on the first slash when not present in catalog
  const r4 = resolveProfileModel('custom-prov/org/nested/model-v1', []);
  assert.deepStrictEqual(r4, { provider: 'custom-prov', modelId: 'org/nested/model-v1' });

  // 5. Fallback without slash leaves provider empty
  const r5 = resolveProfileModel('unqualified-model', []);
  assert.deepStrictEqual(r5, { provider: '', modelId: 'unqualified-model' });

  // 6. Null, empty, or whitespace returns null
  assert.strictEqual(resolveProfileModel(null, catalog), null);
  assert.strictEqual(resolveProfileModel(undefined, catalog), null);
  assert.strictEqual(resolveProfileModel('', catalog), null);
  assert.strictEqual(resolveProfileModel('   ', catalog), null);
});

test('resolveProfileEffort: maps valid efforts and resets invalid/unset tokens', () => {
  assert.strictEqual(resolveProfileEffort('high'), 'high');
  assert.strictEqual(resolveProfileEffort('MEDIUM'), 'medium');
  assert.strictEqual(resolveProfileEffort('off'), 'off');
  assert.strictEqual(resolveProfileEffort('default'), undefined);
  assert.strictEqual(resolveProfileEffort('none'), undefined);
  assert.strictEqual(resolveProfileEffort(''), undefined);
  assert.strictEqual(resolveProfileEffort(null), undefined);
});

test('applyProfileRuntime: live model + effort sequence and guard logic', async () => {
  const catalog: ModelInfo[] = [
    { id: 'gpt-4o', provider: 'openai' },
  ];
  const callSequence: string[] = [];

  const mockSelectModel = async (provider: string, modelId: string) => {
    callSequence.push(`model:${provider}:${modelId}`);
  };
  const mockSelectThinking = async (level: string) => {
    callSequence.push(`thinking:${level}`);
  };

  const profile: ProfileSummary = {
    name: 'test-profile',
    scope: 'project',
    agent_count: 0,
    is_active: true,
    default_model: 'openai/gpt-4o',
    default_effort: 'high',
  };

  // When not connected: does nothing and returns false
  const notConnectedResult = await applyProfileRuntime(profile, {
    isConnected: false,
    availableModels: catalog,
    onSelectModel: mockSelectModel,
    onSelectThinkingLevel: mockSelectThinking,
  });
  assert.strictEqual(notConnectedResult, false);
  assert.strictEqual(callSequence.length, 0);

  // When connected: applies model first, then thinking level
  const connectedResult = await applyProfileRuntime(profile, {
    isConnected: true,
    availableModels: catalog,
    onSelectModel: mockSelectModel,
    onSelectThinkingLevel: mockSelectThinking,
  });
  assert.strictEqual(connectedResult, true);
  assert.deepStrictEqual(callSequence, [
    'model:openai:gpt-4o',
    'thinking:high',
  ]);

  // When profile has no effort: only model is called
  callSequence.length = 0;
  const noEffortProfile: ProfileSummary = {
    ...profile,
    default_effort: undefined,
  };
  await applyProfileRuntime(noEffortProfile, {
    isConnected: true,
    availableModels: catalog,
    onSelectModel: mockSelectModel,
    onSelectThinkingLevel: mockSelectThinking,
  });
  assert.deepStrictEqual(callSequence, ['model:openai:gpt-4o']);

  // When profile is null: does nothing and returns false
  callSequence.length = 0;
  const nullResult = await applyProfileRuntime(null, {
    isConnected: true,
    availableModels: catalog,
    onSelectModel: mockSelectModel,
    onSelectThinkingLevel: mockSelectThinking,
  });
  assert.strictEqual(nullResult, false);
  assert.strictEqual(callSequence.length, 0);
});
