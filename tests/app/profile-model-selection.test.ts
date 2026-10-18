import assert from 'node:assert/strict';
import test from 'node:test';

import { executeModelSelection } from '@features/providers/lib/modelSelection';
import {
  multiProjectChatReducer,
  createInitialMultiProjectState,
  type MultiProjectChatState,
} from '@core/reducer/multi-project';
import type { ModelInfo, ThinkingLevel } from '@core/types/models';
import type { ChatAction } from '@core/reducer';
import { INITIAL_STATE } from '@core/reducer/initial-state';

const catalog: ModelInfo[] = [
  { id: 'gpt-4o', provider: 'openai', reasoning: false },
  { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', reasoning: true, defaultThinkingLevel: 'high' as ThinkingLevel },
  { id: 'gemini-1.5-pro', provider: 'google', reasoning: true },
];

test('executeModelSelection: successful model selection dispatches start and success scoped to targetProjectId', async () => {
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];
  const dispatch = (action: ChatAction & { targetProjectId?: string }) => {
    dispatched.push(action);
  };

  let setModelCalledWith: { provider: string; modelId: string } | null = null;
  const mockSetModel = async (provider: string, modelId: string): Promise<ModelInfo> => {
    setModelCalledWith = { provider, modelId };
    return { id: modelId, provider, reasoning: false };
  };

  const mockGetAvailableLevels = async (): Promise<ThinkingLevel[]> => ['off'];
  const mockGetModelLevels = async () => ({});

  const result = await executeModelSelection({
    provider: 'openai',
    modelId: 'gpt-4o',
    targetProjectId: 'project-destination',
    availableModels: catalog,
    dispatch,
    setModelFn: mockSetModel,
    getAvailableThinkingLevelsFn: mockGetAvailableLevels,
    getModelThinkingLevelsFn: mockGetModelLevels,
  });

  assert.deepStrictEqual(setModelCalledWith, { provider: 'openai', modelId: 'gpt-4o' });
  assert.strictEqual(result.id, 'gpt-4o');
  assert.strictEqual(result.provider, 'openai');

  assert.strictEqual(dispatched.length, 2);
  assert.strictEqual(dispatched[0].type, 'MODEL_CHANGE_START');
  assert.strictEqual(dispatched[0].targetProjectId, 'project-destination');

  assert.strictEqual(dispatched[1].type, 'MODEL_CHANGE_SUCCESS');
  assert.strictEqual(dispatched[1].targetProjectId, 'project-destination');
  if (dispatched[1].type === 'MODEL_CHANGE_SUCCESS') {
    assert.strictEqual(dispatched[1].payload.model.id, 'gpt-4o');
    assert.strictEqual(dispatched[1].payload.model.provider, 'openai');
  }
});

test('executeModelSelection: RPC failure dispatches MODEL_CHANGE_FAIL scoped to targetProjectId and re-throws to notify caller', async () => {
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];
  const dispatch = (action: ChatAction & { targetProjectId?: string }) => {
    dispatched.push(action);
  };

  const failingSetModel = async (): Promise<ModelInfo> => {
    throw new Error('Desktop runtime error: model not available');
  };

  await assert.rejects(
    async () => {
      await executeModelSelection({
        provider: 'openai',
        modelId: 'non-existent-model',
        targetProjectId: 'project-destination',
        availableModels: catalog,
        dispatch,
        setModelFn: failingSetModel,
      });
    },
    {
      name: 'Error',
      message: 'Desktop runtime error: model not available',
    }
  );

  assert.strictEqual(dispatched.length, 2);
  assert.strictEqual(dispatched[0].type, 'MODEL_CHANGE_START');
  assert.strictEqual(dispatched[0].targetProjectId, 'project-destination');

  assert.strictEqual(dispatched[1].type, 'MODEL_CHANGE_FAIL');
  assert.strictEqual(dispatched[1].targetProjectId, 'project-destination');
  if (dispatched[1].type === 'MODEL_CHANGE_FAIL') {
    assert.strictEqual(dispatched[1].payload.error, 'Desktop runtime error: model not available');
  }
});

test('multiProjectChatReducer: late model dispatch with targetProjectId does not mutate active project', () => {
  // Scenario: Project A starts an async model change, but active project switches to Project B before RPC finishes
  const initialState: MultiProjectChatState = {
    activeProjectId: 'project-b',
    projects: {
      'project-a': {
        ...INITIAL_STATE,
        modelInfo: { id: 'gpt-4o', provider: 'openai' },
      },
      'project-b': {
        ...INITIAL_STATE,
        modelInfo: { id: 'gemini-1.5-pro', provider: 'google' },
      },
    },
  };

  const lateProjectAAction: ChatAction & { targetProjectId?: string } = {
    type: 'MODEL_CHANGE_SUCCESS',
    targetProjectId: 'project-a',
    payload: {
      model: { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter' },
      thinkingLevel: 'high',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
  };

  const nextState = multiProjectChatReducer(initialState, lateProjectAAction);

  // Project A must receive the updated model
  assert.strictEqual(nextState.projects['project-a'].modelInfo?.id, 'anthropic/claude-3.5-sonnet');
  assert.strictEqual(nextState.projects['project-a'].modelInfo?.provider, 'openrouter');
  assert.strictEqual(nextState.projects['project-a'].thinkingLevel, 'high');

  // CRITICAL: Project B (currently active) MUST NOT be mutated by late Project A dispatch!
  assert.strictEqual(
    nextState.projects['project-b'].modelInfo?.id,
    'gemini-1.5-pro',
    'Active Project B model must not be mutated by late Project A dispatch'
  );
  assert.strictEqual(
    nextState.projects['project-b'].modelInfo?.provider,
    'google',
    'Active Project B provider must not be mutated by late Project A dispatch'
  );
});

test('executeModelSelection: preserves raw slash-containing model IDs without duplicating provider prefix', async () => {
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];
  const dispatch = (action: ChatAction & { targetProjectId?: string }) => {
    dispatched.push(action);
  };

  let appliedModelId: string | null = null;
  let appliedProvider: string | null = null;
  let appliedThinkingLevel: ThinkingLevel | null = null;

  const mockSetModel = async (provider: string, modelId: string): Promise<ModelInfo> => {
    appliedProvider = provider;
    appliedModelId = modelId;
    return { id: modelId, provider, reasoning: true };
  };

  const mockSetThinkingLevel = async (level: ThinkingLevel): Promise<void> => {
    appliedThinkingLevel = level;
  };

  const result = await executeModelSelection({
    provider: 'openrouter',
    modelId: 'anthropic/claude-3.5-sonnet',
    targetProjectId: 'project-openrouter',
    availableModels: catalog,
    dispatch,
    setModelFn: mockSetModel,
    getAvailableThinkingLevelsFn: async () => ['off', 'low', 'medium', 'high'],
    getModelThinkingLevelsFn: async () => ({}),
    setThinkingLevelFn: mockSetThinkingLevel,
  });

  // Verify that provider was NOT prefixed onto modelId (must NOT be openrouter/anthropic/claude-3.5-sonnet)
  assert.strictEqual(appliedProvider, 'openrouter');
  assert.strictEqual(appliedModelId, 'anthropic/claude-3.5-sonnet');
  assert.strictEqual(result.id, 'anthropic/claude-3.5-sonnet');
  assert.strictEqual(result.provider, 'openrouter');
  assert.strictEqual(appliedThinkingLevel, 'high');
});
