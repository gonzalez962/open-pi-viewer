import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo } from '@core/types/models';
import {
  filterByEnabledModels,
  filterExcludedModels,
  isModelAllowedByEnabledModels,
} from '@features/providers/providers';

const sampleModels: ModelInfo[] = [
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
  },
  {
    id: 'claude-3-haiku-20240307',
    name: 'Claude 3 Haiku',
    provider: 'anthropic',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'openai',
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'google',
  },
];

test('S2.1 — Given nonempty enabledModels with exact references and wildcard patterns, when models load, then only matching models also allowed by provider policy appear', () => {
  // Pattern includes exact reference, wildcard with provider prefix, and thinking level suffix
  const enabledPatterns = [
    'anthropic/*',
    'openai/gpt-4o',
    'google/*:high', // Thinking level suffix :high should be stripped during model matching
  ];

  // Provider policy: anthropic excludes *haiku*
  const providerPolicies = [
    {
      id: 'anthropic',
      excludedModels: ['*haiku*'],
      models: [],
    },
  ];

  // 1. Check enabledModels filtering
  const matching = filterByEnabledModels(sampleModels, enabledPatterns);
  const matchingIds = matching.map((m) => `${m.provider}/${m.id}`);

  assert.deepEqual(matchingIds, [
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-3-haiku-20240307',
    'openai/gpt-4o',
    'google/gemini-1.5-pro',
  ]);

  // 2. Applying provider policy also excludes haiku
  const filtered = filterExcludedModels(matching, providerPolicies);
  const finalIds = filtered.map((m) => `${m.provider}/${m.id}`);

  assert.deepEqual(finalIds, [
    'anthropic/claude-3-5-sonnet-20241022',
    'openai/gpt-4o',
    'google/gemini-1.5-pro',
  ]);
});

test('S2.1 — Pi enabledModels semantics: does not treat leading exclamation as negation/exclusion operator', () => {
  // Pi model scope matching iterates patterns and includes matches; it does not support negative exclusion patterns
  const patternsWithNegationAttempt = ['!claude*'];
  const res = isModelAllowedByEnabledModels(sampleModels[0], patternsWithNegationAttempt);
  // In Pi, '!claude*' does not match 'claude-3-5-sonnet-20241022' (it would only match a model literally starting with '!')
  assert.equal(res, false, 'Negation is not an exclusion operator in Pi enabledModels semantics');
});

test('S2.2 — Given missing or empty enabledModels, when models load, then existing provider filtering behavior is unchanged', () => {
  // Empty enabledModels array
  const emptyResult = filterByEnabledModels(sampleModels, []);
  assert.equal(emptyResult.length, sampleModels.length, 'Empty array preserves all models');

  // Undefined enabledModels
  const undefinedResult = filterByEnabledModels(sampleModels, undefined);
  assert.equal(undefinedResult.length, sampleModels.length, 'Undefined preserves all models');

  // Existing provider policies continue to apply identically
  const providerPolicies = [
    {
      id: 'openai',
      excludedModels: ['gpt-3.5*'],
      models: [],
    },
  ];
  const filtered = filterExcludedModels(undefinedResult, providerPolicies);
  assert.equal(filtered.some((m) => m.id === 'gpt-3.5-turbo'), false);
  assert.equal(filtered.some((m) => m.id === 'gpt-4o'), true);
});

test('PRESERVE — filterExcludedModels still honors includedModels and excludedModels when enabledModels is absent', () => {
  const providerPolicies = [
    {
      id: 'anthropic',
      includedModels: ['*sonnet*'],
      models: [],
    },
  ];
  const filtered = filterExcludedModels(sampleModels, providerPolicies);
  const anthropicModels = filtered.filter((m) => m.provider === 'anthropic');
  assert.equal(anthropicModels.length, 1);
  assert.equal(anthropicModels[0].id, 'claude-3-5-sonnet-20241022');
});
