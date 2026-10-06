import assert from 'node:assert';
import test from 'node:test';

import { chatReducer, INITIAL_STATE, type ChatAction, type ChatSessionState } from '@core/reducer';
import { connectionReducer } from '@core/reducer/connection';
import { sessionsReducer } from '@core/reducer/sessions';
import { messagingReducer } from '@core/reducer/messaging';
import { toolExecutionReducer } from '@core/reducer/tool-execution';
import { modelsReducer } from '@core/reducer/models';
import { generatePromptRequestId } from '@core/protocol';
import type { ChatMessage, ThinkingBlock, ToolCallBlock } from '@core/types/messages';
import type { ModelInfo, SessionStats } from '@core/types/models';

test('Reducer: initial state has honest disconnected status', () => {
  assert.strictEqual(INITIAL_STATE.connectionStatus, 'disconnected');
  assert.strictEqual(INITIAL_STATE.agentActivity, 'idle');
  assert.strictEqual(INITIAL_STATE.messages.length, 0);
});

test('Reducer: handles connection lifecycle (start, success, fail, disconnect)', () => {
  let state = chatReducer(INITIAL_STATE, { type: 'CONNECT_START' });
  assert.strictEqual(state.connectionStatus, 'connecting');

  state = chatReducer(state, {
    type: 'CONNECT_SUCCESS',
    payload: {
      model: { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
    },
  });
  assert.strictEqual(state.connectionStatus, 'connected');
  assert.strictEqual(state.modelInfo?.id, 'claude-sonnet-4');
  assert.strictEqual(state.agentActivity, 'idle');

  state = chatReducer(state, { type: 'DISCONNECT' });
  assert.strictEqual(state.connectionStatus, 'disconnected');
  assert.strictEqual(state.agentActivity, 'idle');

  state = chatReducer(state, {
    type: 'CONNECT_FAIL',
    payload: { error: 'Failed to spawn node' },
  });
  assert.strictEqual(state.connectionStatus, 'error');
  assert.strictEqual(state.lastError, 'Failed to spawn node');
});

test('Reducer: prompt submit and acceptance sets busy state', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'What is 2+2?' },
  });
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.messages.length, 1);
  assert.strictEqual(state.messages[0].role, 'user');
  assert.strictEqual(state.messages[0].content, 'What is 2+2?');

  state = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: 'prompt-1' },
  });
  assert.strictEqual(state.agentActivity, 'busy');
});

test('Reducer: prompt rejection reverts busy state to idle', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Hello' },
  });
  assert.strictEqual(state.agentActivity, 'busy');

  state = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-1', error: 'Agent already streaming' },
  });
  assert.strictEqual(state.agentActivity, 'idle');
  assert.strictEqual(state.lastError, 'Agent already streaming');
});

test('Reducer: streaming deltas accumulate and message_end reconciles without duplicate tokens', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  // Start assistant message
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'asst-msg-1', role: 'assistant', content: '' },
    },
  });

  assert.strictEqual(state.messages.length, 1);
  assert.strictEqual(state.messages[0].role, 'assistant');
  assert.strictEqual(state.messages[0].content, '');
  assert.strictEqual(state.messages[0].isStreaming, true);

  // Streaming deltas arrive
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: 'The answer ' },
  });
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: 'is 4.' },
  });

  assert.strictEqual(state.messages[0].content, 'The answer is 4.');

  // Authoritative message_end arrives with full content
  // Must NOT duplicate tokens into "The answer is 4.The answer is 4."!
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: {
        id: 'asst-msg-1',
        role: 'assistant',
        content: 'The answer is 4.',
      },
    },
  });

  assert.strictEqual(state.messages[0].content, 'The answer is 4.');
  assert.strictEqual(state.messages[0].isStreaming, false);
  assert.strictEqual(state.activeAssistantMessageId, null);
});

test('Reducer: settled uses agent_settled, NOT agent_end', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Calculate' },
  });
  assert.strictEqual(state.agentActivity, 'busy');

  // agent_end is emitted when one low-level run completes, but Pi may still retry or continue
  state = chatReducer(state, {
    type: 'EVENT_AGENT_END',
    payload: { willRetry: false },
  });
  // Must still be busy!
  assert.strictEqual(
    state.agentActivity,
    'busy',
    'agentActivity must remain busy on agent_end'
  );

  // agent_settled authoritatively signals completion
  state = chatReducer(state, { type: 'EVENT_AGENT_SETTLED' });
  assert.strictEqual(
    state.agentActivity,
    'idle',
    'agentActivity must transition to idle on agent_settled'
  );
  assert.strictEqual(state.pendingPromptId, null);
});

test('Reducer: abort flow restores idle state', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Infinite loop' },
  });
  assert.strictEqual(state.agentActivity, 'busy');

  state = chatReducer(state, { type: 'ABORT_CLICKED' });
  state = chatReducer(state, { type: 'ABORT_COMPLETED' });
  assert.strictEqual(state.agentActivity, 'idle');
});

test('Reducer: process exit resets state cleanly on error or EOF', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'p1', message: 'hello' },
  });
  assert.strictEqual(state.agentActivity, 'busy');

  state = chatReducer(state, {
    type: 'PROCESS_EXIT',
    payload: { error: 'Subprocess crashed' },
  });
  assert.strictEqual(state.connectionStatus, 'error');
  assert.strictEqual(state.agentActivity, 'idle');
  assert.strictEqual(state.lastError, 'Subprocess crashed');
  assert.strictEqual(state.activeAssistantMessageId, null);
});

test('Reducer: EVENT_MESSAGE_END ignores non-assistant roles (user and tool)', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'u1', message: 'Hello' },
  });
  assert.strictEqual(state.messages.length, 1);
  assert.strictEqual(state.messages[0].role, 'user');

  // User end event arrives (e.g. from history replay or session echo)
  const stateAfterUserEnd = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: { id: 'u1', role: 'user', content: 'Hello user' },
    },
  });
  // Must NOT convert user message into assistant or add an assistant message
  assert.strictEqual(stateAfterUserEnd.messages.length, 1);
  assert.strictEqual(stateAfterUserEnd.messages[0].role, 'user');
  assert.strictEqual(stateAfterUserEnd.messages[0].content, 'Hello');

  // Tool end event arrives
  const stateAfterToolEnd = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: { id: 'tool-1', role: 'tool', content: 'Tool execution result' },
    },
  });
  // Must be ignored completely
  assert.strictEqual(stateAfterToolEnd.messages.length, 1);
  assert.strictEqual(stateAfterToolEnd.messages[0].role, 'user');
});

test('Reducer: ABORT_COMPLETED finalizes in-flight streaming flags and resets active IDs', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'p1', message: 'Generate story' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'asst-1', role: 'assistant', content: 'Once upon' },
    },
  });
  assert.strictEqual(state.messages[1].isStreaming, true);
  assert.strictEqual(state.activeAssistantMessageId, 'asst-1');

  // Abort operation
  state = chatReducer(state, { type: 'ABORT_CLICKED' });
  state = chatReducer(state, { type: 'ABORT_COMPLETED' });

  assert.strictEqual(state.agentActivity, 'idle');
  assert.strictEqual(state.pendingPromptId, null);
  assert.strictEqual(state.activeAssistantMessageId, null);
  assert.strictEqual(state.messages[1].isStreaming, false);

  // Late EVENT_MESSAGE_UPDATE arriving after abort must be ignored
  const stateAfterLateUpdate = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: ' a time' },
  });
  assert.strictEqual(stateAfterLateUpdate.messages[1].content, 'Once upon');

  // Late EVENT_MESSAGE_END arriving after abort must NOT resurrect or inject new message
  const stateAfterLateEnd = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: { id: 'asst-phantom', role: 'assistant', content: 'Late phantom text' },
    },
  });
  assert.strictEqual(stateAfterLateEnd.messages.length, 2);
  assert.strictEqual(stateAfterLateEnd.activeAssistantMessageId, null);
});

test('Reducer: ABORT_COMPLETED prunes empty in-flight assistant message', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'p1', message: 'Hello' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'asst-empty', role: 'assistant', content: '' },
    },
  });

  assert.strictEqual(state.messages.length, 2);
  assert.strictEqual(state.activeAssistantMessageId, 'asst-empty');

  // Abort operation while message is empty
  state = chatReducer(state, { type: 'ABORT_COMPLETED' });

  assert.strictEqual(state.agentActivity, 'idle');
  assert.strictEqual(state.pendingPromptId, null);
  assert.strictEqual(state.activeAssistantMessageId, null);
  assert.strictEqual(state.messages.length, 1);
  assert.strictEqual(state.messages[0].role, 'user');
});

test('Reducer: ABORT_COMPLETED preserves in-flight assistant message with content and marks isCancelled: true', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'p2', message: 'Generate response' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'asst-content', role: 'assistant', content: 'Partial response before abort' },
    },
  });

  assert.strictEqual(state.messages.length, 2);
  assert.strictEqual(state.messages[1].isStreaming, true);

  // Abort operation
  state = chatReducer(state, { type: 'ABORT_COMPLETED' });

  assert.strictEqual(state.agentActivity, 'idle');
  assert.strictEqual(state.pendingPromptId, null);
  assert.strictEqual(state.activeAssistantMessageId, null);
  assert.strictEqual(state.messages.length, 2);
  assert.strictEqual(state.messages[1].id, 'asst-content');
  assert.strictEqual(state.messages[1].isStreaming, false);
  assert.strictEqual(state.messages[1].isCancelled, true);
  assert.strictEqual(state.messages[1].content, 'Partial response before abort');
});

test('Reducer: DISCONNECT and PROCESS_EXIT finalize streaming flags and reject late events', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'asst-stream', role: 'assistant', content: 'Streaming...' },
    },
  });
  assert.strictEqual(state.messages[0].isStreaming, true);

  // Disconnect
  state = chatReducer(state, { type: 'DISCONNECT' });
  assert.strictEqual(state.connectionStatus, 'disconnected');
  assert.strictEqual(state.messages[0].isStreaming, false);
  assert.strictEqual(state.activeAssistantMessageId, null);

  // Late events while disconnected must be ignored
  const stateAfterLateStart = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'late-start', role: 'assistant', content: 'Nope' },
    },
  });
  assert.strictEqual(stateAfterLateStart.messages.length, 1);

  const stateAfterLateUpdate = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: ' extra' },
  });
  assert.strictEqual(stateAfterLateUpdate.messages[0].content, 'Streaming...');

  const stateAfterLateEnd = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: { id: 'late-end', role: 'assistant', content: 'Done' },
    },
  });
  assert.strictEqual(stateAfterLateEnd.messages.length, 1);
});

test('Reducer: PROMPT_REJECTED after disconnect preserves disconnected status and ignores stale rejection', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Hello' },
  });
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.pendingPromptId, 'prompt-1');

  // Disconnect occurs while prompt-1 is in flight
  state = chatReducer(state, { type: 'DISCONNECT' });
  assert.strictEqual(state.connectionStatus, 'disconnected');
  assert.strictEqual(state.statusLabel, 'Disconnected');
  assert.strictEqual(state.pendingPromptId, null);

  // Stale rejection for prompt-1 arrives after disconnect
  const stateAfterStaleRejection = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-1', error: 'Process closed' },
  });

  // Must preserve disconnected state and label, NOT clobber to Connected
  assert.strictEqual(stateAfterStaleRejection.connectionStatus, 'disconnected');
  assert.strictEqual(stateAfterStaleRejection.statusLabel, 'Disconnected');
  assert.strictEqual(stateAfterStaleRejection.pendingPromptId, null);
  assert.strictEqual(stateAfterStaleRejection.agentActivity, 'idle');
});

test('Reducer: PROMPT_REJECTED after PROCESS_EXIT preserves error status and ignores stale rejection', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Heavy computation' },
  });
  assert.strictEqual(state.agentActivity, 'busy');

  // Child process crashes while prompt-1 is in flight
  state = chatReducer(state, {
    type: 'PROCESS_EXIT',
    payload: { error: 'Subprocess terminated unexpectedly' },
  });
  assert.strictEqual(state.connectionStatus, 'error');
  assert.strictEqual(state.statusLabel, 'Process Error');
  assert.strictEqual(state.lastError, 'Subprocess terminated unexpectedly');
  assert.strictEqual(state.pendingPromptId, null);

  // Stale rejection for prompt-1 arrives after process exit
  const stateAfterStaleRejection = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-1', error: 'Child stdin closed' },
  });

  // Must preserve error state and Process Error label, NOT set statusLabel Connected
  assert.strictEqual(stateAfterStaleRejection.connectionStatus, 'error');
  assert.strictEqual(stateAfterStaleRejection.statusLabel, 'Process Error');
  assert.strictEqual(stateAfterStaleRejection.lastError, 'Subprocess terminated unexpectedly');
});

test('Reducer: PROMPT_ACCEPTED and PROMPT_REJECTED correlate to active pendingPromptId and ignore stale prompt responses after new prompt', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  // Submit prompt-1
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First question' },
  });
  assert.strictEqual(state.pendingPromptId, 'prompt-1');

  // Submit prompt-2 (e.g. after settling or retry)
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-2', message: 'Second question' },
  });
  assert.strictEqual(state.pendingPromptId, 'prompt-2');
  const runningDetail = state.statusDetail;

  // Stale PROMPT_ACCEPTED for prompt-1 arrives
  const stateAfterStaleAccept = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: 'prompt-1' },
  });
  // Must be ignored since pendingPromptId is prompt-2
  assert.strictEqual(stateAfterStaleAccept.pendingPromptId, 'prompt-2');
  assert.strictEqual(stateAfterStaleAccept.statusDetail, runningDetail);

  // Stale PROMPT_REJECTED for prompt-1 arrives
  const stateAfterStaleReject = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-1', error: 'Stale error' },
  });
  // Must be ignored: must not reset agentActivity or pendingPromptId of prompt-2
  assert.strictEqual(stateAfterStaleReject.agentActivity, 'busy');
  assert.strictEqual(stateAfterStaleReject.pendingPromptId, 'prompt-2');
  assert.strictEqual(stateAfterStaleReject.lastError, null);

  // Matching PROMPT_ACCEPTED for prompt-2 arrives
  const stateAfterMatchingAccept = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: 'prompt-2' },
  });
  assert.strictEqual(stateAfterMatchingAccept.statusDetail, 'Prompt accepted by Pi; streaming response...');

  // Matching PROMPT_REJECTED for prompt-2 arrives
  const stateAfterMatchingReject = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-2', error: 'Rate limit exceeded' },
  });
  assert.strictEqual(stateAfterMatchingReject.agentActivity, 'idle');
  assert.strictEqual(stateAfterMatchingReject.pendingPromptId, null);
  assert.strictEqual(stateAfterMatchingReject.lastError, 'Rate limit exceeded');
});

test('Reducer: PROMPT_ACCEPTED ignores acceptance if disconnected', () => {
  // Stale acceptance when disconnected
  const state = chatReducer(INITIAL_STATE, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: 'prompt-1' },
  });
  assert.strictEqual(state.connectionStatus, 'disconnected');
  assert.strictEqual(state.statusDetail, INITIAL_STATE.statusDetail);
});

test('Reducer: ABORT_COMPLETED with correlated promptId ignores stale abort after new prompt and preserves disconnected/error state', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Old prompt' },
  });

  // User submits new prompt-2 before old abort completion arrives
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-2', message: 'New prompt' },
  });
  assert.strictEqual(state.pendingPromptId, 'prompt-2');
  assert.strictEqual(state.agentActivity, 'busy');

  // Stale abort completion for prompt-1 arrives
  const stateAfterStaleAbort = chatReducer(state, {
    type: 'ABORT_COMPLETED',
    payload: { promptId: 'prompt-1' },
  });
  // Must NOT cancel prompt-2!
  assert.strictEqual(stateAfterStaleAbort.pendingPromptId, 'prompt-2');
  assert.strictEqual(stateAfterStaleAbort.agentActivity, 'busy');

  // Matching abort completion for prompt-2 arrives
  const stateAfterMatchingAbort = chatReducer(state, {
    type: 'ABORT_COMPLETED',
    payload: { promptId: 'prompt-2' },
  });
  assert.strictEqual(stateAfterMatchingAbort.pendingPromptId, null);
  assert.strictEqual(stateAfterMatchingAbort.agentActivity, 'idle');
  assert.strictEqual(stateAfterMatchingAbort.statusLabel, 'Connected');

  // Abort completion after error preserves error state
  let errorState = chatReducer(INITIAL_STATE, {
    type: 'PROCESS_EXIT',
    payload: { error: 'Process crashed' },
  });
  assert.strictEqual(errorState.connectionStatus, 'error');
  assert.strictEqual(errorState.statusLabel, 'Process Error');

  const errorStateAfterAbort = chatReducer(errorState, {
    type: 'ABORT_COMPLETED',
    payload: { promptId: 'prompt-1' },
  });
  assert.strictEqual(errorStateAfterAbort.connectionStatus, 'error');
  assert.strictEqual(errorStateAfterAbort.statusLabel, 'Process Error');
});

test('Reducer: PROMPT_ACCEPTED and PROMPT_REJECTED require explicit matching IDs (reject empty, undefined, or mismatched)', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  const activeId = generatePromptRequestId();
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: activeId, message: 'Test message' },
  });
  assert.strictEqual(state.pendingPromptId, activeId);
  const originalDetail = state.statusDetail;

  // Empty string ID in PROMPT_ACCEPTED
  const stateEmptyAccept = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: '' },
  });
  assert.strictEqual(stateEmptyAccept.statusDetail, originalDetail);

  // Mismatched ID in PROMPT_ACCEPTED
  const stateMismatchedAccept = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: 'prompt-mismatched-id' },
  });
  assert.strictEqual(stateMismatchedAccept.statusDetail, originalDetail);

  // Empty string ID in PROMPT_REJECTED
  const stateEmptyReject = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: '', error: 'Some error' },
  });
  assert.strictEqual(stateEmptyReject.agentActivity, 'busy');
  assert.strictEqual(stateEmptyReject.pendingPromptId, activeId);

  // Mismatched ID in PROMPT_REJECTED
  const stateMismatchedReject = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-mismatched-id', error: 'Some error' },
  });
  assert.strictEqual(stateMismatchedReject.agentActivity, 'busy');
  assert.strictEqual(stateMismatchedReject.pendingPromptId, activeId);
});

test('Reducer: CONNECT_SUCCESS does not set isHydrated; SESSION_READY sets isHydrated and enables readiness', () => {
  // 1. Initially disconnected and not hydrated
  assert.strictEqual(INITIAL_STATE.isHydrated, false);
  assert.strictEqual(INITIAL_STATE.isResetting, false);

  // 2. Bridge status-change emits 'connected' before command returns
  const stateConnected = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });
  assert.strictEqual(stateConnected.connectionStatus, 'connected');
  // Crucial: isHydrated remains FALSE so prompt input stays disabled during race!
  assert.strictEqual(stateConnected.isHydrated, false);

  // 3. Command result completes with hydrated messages -> SESSION_READY
  const messages = [
    {
      id: 'msg-1',
      role: 'user' as const,
      content: 'Past question',
      timestamp: '10:00 AM',
    },
    {
      id: 'msg-2',
      role: 'assistant' as const,
      content: 'Past response',
      timestamp: '10:01 AM',
    },
  ];

  const stateReady = chatReducer(stateConnected, {
    type: 'SESSION_READY',
    payload: {
      sessionId: 'session-123',
      sessionFile: 'C:/sessions/session-123.jsonl',
      messages,
      model: { id: 'test-model' },
    },
  });

  assert.strictEqual(stateReady.isHydrated, true);
  assert.strictEqual(stateReady.sessionId, 'session-123');
  assert.strictEqual(stateReady.sessionFile, 'C:/sessions/session-123.jsonl');
  assert.strictEqual(stateReady.messages.length, 2);
  assert.strictEqual(stateReady.messages[0].content, 'Past question');
});

test('Reducer: New conversation lifecycle (start, success, cancelled, fail)', () => {
  const initialStateWithMessages = chatReducer(INITIAL_STATE, {
    type: 'SESSION_READY',
    payload: {
      sessionId: 'old-session',
      sessionFile: 'C:/sessions/old.jsonl',
      messages: [
        {
          id: '1',
          role: 'user',
          content: 'Hello',
          timestamp: '12:00',
        },
      ],
    },
  });
  assert.strictEqual(initialStateWithMessages.messages.length, 1);

  // 1. Start reset
  const stateResetting = chatReducer(initialStateWithMessages, {
    type: 'NEW_CONVERSATION_START',
  });
  assert.strictEqual(stateResetting.isResetting, true);

  // 2. Cancellation retains original messages and context
  const stateCancelled = chatReducer(stateResetting, {
    type: 'NEW_CONVERSATION_CANCELLED',
  });
  assert.strictEqual(stateCancelled.isResetting, false);
  assert.strictEqual(stateCancelled.messages.length, 1);
  assert.strictEqual(stateCancelled.sessionId, 'old-session');
  assert.ok(stateCancelled.statusDetail.includes('cancelled'));

  // 3. Failure retains original messages and context with truthful error
  const stateFailed = chatReducer(stateResetting, {
    type: 'NEW_CONVERSATION_FAIL',
    payload: { error: 'Node process error' },
  });
  assert.strictEqual(stateFailed.isResetting, false);
  assert.strictEqual(stateFailed.messages.length, 1);
  assert.strictEqual(stateFailed.lastError, 'Node process error');

  // 4. Success resets messages to empty and updates session identity atomically
  const stateSuccess = chatReducer(stateResetting, {
    type: 'NEW_CONVERSATION_SUCCESS',
    payload: {
      sessionId: 'new-session-456',
      sessionFile: 'C:/sessions/new.jsonl',
    },
  });
  assert.strictEqual(stateSuccess.isResetting, false);
  assert.strictEqual(stateSuccess.isHydrated, true);
  assert.strictEqual(stateSuccess.messages.length, 0);
  assert.strictEqual(stateSuccess.sessionId, 'new-session-456');
  assert.strictEqual(stateSuccess.sessionFile, 'C:/sessions/new.jsonl');
  assert.strictEqual(stateSuccess.lastError, null);
});

test('Reducer: handles streaming thinking delta and appends to thinking block', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Hello' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-1', role: 'assistant', content: '' } },
  });

  assert.strictEqual(state.messages.length, 2);
  const asstMsg = state.messages[1];
  assert.strictEqual(asstMsg.role, 'assistant');

  // Stream thinking chunk 1
  state = chatReducer(state, {
    type: 'EVENT_THINKING_UPDATE',
    payload: { delta: 'Evaluating' },
  });

  let currentMsg = state.messages[1];
  assert.ok(currentMsg.blocks);
  assert.strictEqual(currentMsg.blocks.length, 1);
  assert.strictEqual(currentMsg.blocks[0].type, 'thinking');
  assert.strictEqual((currentMsg.blocks[0] as ThinkingBlock).thinking, 'Evaluating');
  assert.strictEqual((currentMsg.blocks[0] as ThinkingBlock).isStreaming, true);

  // Stream thinking chunk 2
  state = chatReducer(state, {
    type: 'EVENT_THINKING_UPDATE',
    payload: { delta: ' parameters...' },
  });

  currentMsg = state.messages[1];
  assert.strictEqual(currentMsg.blocks?.length, 1);
  assert.strictEqual(
    (currentMsg.blocks?.[0] as ThinkingBlock).thinking,
    'Evaluating parameters...'
  );
  assert.strictEqual((currentMsg.blocks?.[0] as ThinkingBlock).isStreaming, true);
});

test('Reducer: text delta after thinking delta marks thinking as complete', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Question' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-1', role: 'assistant', content: '' } },
  });

  state = chatReducer(state, {
    type: 'EVENT_THINKING_UPDATE',
    payload: { delta: 'Thinking deeply' },
  });

  // Now text delta arrives
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: 'Here is the answer' },
  });

  const msg = state.messages[1];
  assert.ok(msg.blocks);
  assert.strictEqual(msg.blocks.length, 2);

  // Thinking block should have isStreaming: false
  assert.strictEqual(msg.blocks[0].type, 'thinking');
  assert.strictEqual((msg.blocks[0] as ThinkingBlock).isStreaming, false);

  // Text block appended
  assert.strictEqual(msg.blocks[1].type, 'text');
  assert.strictEqual((msg.blocks[1] as { text: string }).text, 'Here is the answer');
  assert.strictEqual(msg.content, 'Here is the answer');
});

test('Reducer: handles tool_execution_start, tool_execution_update, tool_execution_end lifecycle', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Check files' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-1', role: 'assistant', content: '' } },
  });

  // 1. Tool execution start
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: {
      toolCallId: 'call_read_1',
      toolName: 'read',
      args: { path: 'src/types.ts' },
    },
  });

  let msg = state.messages[1];
  assert.ok(msg.blocks);
  assert.strictEqual(msg.blocks.length, 1);
  assert.strictEqual(msg.blocks[0].type, 'tool_call');
  let toolBlock = msg.blocks[0] as ToolCallBlock;
  assert.strictEqual(toolBlock.id, 'call_read_1');
  assert.strictEqual(toolBlock.name, 'read');
  assert.strictEqual(toolBlock.status, 'running');
  assert.deepStrictEqual(toolBlock.args, { path: 'src/types.ts' });

  // 2. Tool execution update
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_UPDATE',
    payload: {
      toolCallId: 'call_read_1',
      output: 'export type ConnectionState = ...',
    },
  });

  msg = state.messages[1];
  toolBlock = msg.blocks?.[0] as ToolCallBlock;
  assert.strictEqual(toolBlock.status, 'running');
  assert.strictEqual(toolBlock.output, 'export type ConnectionState = ...');

  // 3. Tool execution end
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_END',
    payload: {
      toolCallId: 'call_read_1',
      output: 'export type ConnectionState = ... (full)',
      isError: false,
    },
  });

  msg = state.messages[1];
  toolBlock = msg.blocks?.[0] as ToolCallBlock;
  assert.strictEqual(toolBlock.status, 'completed');
  assert.strictEqual(toolBlock.isError, false);
  assert.strictEqual(toolBlock.output, 'export type ConnectionState = ... (full)');
});

test('Reducer: EVENT_MESSAGE_END reconciles message blocks and preserves tool output and status', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Read file' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-1', role: 'assistant', content: '' } },
  });

  // Track tool execution during run
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'call_100', toolName: 'read', args: { path: 'foo.txt' } },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_END',
    payload: { toolCallId: 'call_100', output: 'content of foo.txt', isError: false },
  });

  // Now message_end arrives with authoritative message content array
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: {
        id: 'asst-1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I need to read foo.txt' },
          { type: 'toolCall', id: 'call_100', name: 'read', arguments: { path: 'foo.txt' } },
          { type: 'text', text: 'Here is what foo.txt contains.' },
        ],
      },
    },
  });

  const msg = state.messages[1];
  assert.strictEqual(msg.isStreaming, false);
  assert.strictEqual(msg.content, 'Here is what foo.txt contains.');
  assert.ok(msg.blocks);
  assert.strictEqual(msg.blocks.length, 3);

  // Thinking block should be non-streaming
  assert.strictEqual(msg.blocks[0].type, 'thinking');
  assert.strictEqual((msg.blocks[0] as ThinkingBlock).isStreaming, false);

  // Tool block MUST have preserved execution output and status!
  assert.strictEqual(msg.blocks[1].type, 'tool_call');
  const toolBlock = msg.blocks[1] as ToolCallBlock;
  assert.strictEqual(toolBlock.id, 'call_100');
  assert.strictEqual(toolBlock.status, 'completed');
  assert.strictEqual(toolBlock.output, 'content of foo.txt');

  // Text block
  assert.strictEqual(msg.blocks[2].type, 'text');
  assert.strictEqual((msg.blocks[2] as { text: string }).text, 'Here is what foo.txt contains.');
});

test('Reducer: ABORT_COMPLETED and PROCESS_EXIT mark active thinking blocks as non-streaming', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Long task' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-1', role: 'assistant', content: '' } },
  });

  state = chatReducer(state, {
    type: 'EVENT_THINKING_UPDATE',
    payload: { delta: 'Thinking indefinitely...' },
  });

  assert.strictEqual(
    (state.messages[1].blocks?.[0] as ThinkingBlock).isStreaming,
    true
  );

  // Abort completed
  state = chatReducer(state, {
    type: 'ABORT_COMPLETED',
    payload: { promptId: 'prompt-1' },
  });

  assert.strictEqual(
    (state.messages[1].blocks?.[0] as ThinkingBlock).isStreaming,
    false
  );
  assert.strictEqual(state.messages[1].isStreaming, false);
});

test('Reducer: tool execution events NEVER append tool blocks to past assistant messages from earlier turns', () => {
  // Setup conversation with 2 completed past turns:
  // Turn 1: User 1 -> Assistant 1
  // Turn 2: User 2 -> Assistant 2
  // Turn 3: User 3 (current in-flight prompt)
  const pastAssistant1: ChatMessage = {
    id: 'asst-past-1',
    role: 'assistant',
    content: 'Past answer 1',
    timestamp: '10:00:00',
    isStreaming: false,
  };
  const pastAssistant2: ChatMessage = {
    id: 'asst-past-2',
    role: 'assistant',
    content: 'Past answer 2',
    timestamp: '10:01:00',
    isStreaming: false,
  };
  const currentUser: ChatMessage = {
    id: 'user-3',
    role: 'user',
    content: 'Lee package.json',
    timestamp: '10:02:00',
  };

  let state: ChatSessionState = {
    ...INITIAL_STATE,
    connectionStatus: 'connected',
    agentActivity: 'busy',
    activeAssistantMessageId: null, // message_end may have cleared active ID or not yet started
    messages: [
      { id: 'user-1', role: 'user', content: 'Pregunta 1', timestamp: '09:59:00' },
      pastAssistant1,
      { id: 'user-2', role: 'user', content: 'Pregunta 2', timestamp: '10:00:30' },
      pastAssistant2,
      currentUser,
    ],
  };

  // Tool execution start arrives for Turn 3's tool call
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: {
      toolCallId: 'call-read-pkg',
      toolName: 'read',
      args: { path: 'package.json' },
    },
  });

  // VERIFY: Past assistant messages must remain completely untouched!
  const msg1 = state.messages.find((m) => m.id === 'asst-past-1');
  const msg2 = state.messages.find((m) => m.id === 'asst-past-2');
  assert.strictEqual(msg1?.blocks, undefined, 'Past assistant 1 must NOT receive tool block');
  assert.strictEqual(msg2?.blocks, undefined, 'Past assistant 2 must NOT receive tool block');

  // VERIFY: A new assistant message was created AFTER currentUser for Turn 3
  const lastMsg = state.messages[state.messages.length - 1];
  assert.strictEqual(lastMsg.role, 'assistant');
  assert.notStrictEqual(lastMsg.id, 'asst-past-1');
  assert.notStrictEqual(lastMsg.id, 'asst-past-2');
  assert.strictEqual(lastMsg.blocks?.length, 1);
  assert.strictEqual(lastMsg.blocks?.[0].type, 'tool_call');
  assert.strictEqual((lastMsg.blocks?.[0] as ToolCallBlock).id, 'call-read-pkg');
  assert.strictEqual((lastMsg.blocks?.[0] as ToolCallBlock).name, 'read');
  assert.strictEqual((lastMsg.blocks?.[0] as ToolCallBlock).status, 'running');

  // Tool execution update updates ONLY the turn 3 tool block
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_UPDATE',
    payload: {
      toolCallId: 'call-read-pkg',
      output: '{"name": "pi-viewer"}',
    },
  });
  assert.strictEqual(state.messages.find((m) => m.id === 'asst-past-1')?.blocks, undefined);
  assert.strictEqual(state.messages.find((m) => m.id === 'asst-past-2')?.blocks, undefined);
  const updatedLastMsg = state.messages[state.messages.length - 1];
  assert.strictEqual((updatedLastMsg.blocks?.[0] as ToolCallBlock).output, '{"name": "pi-viewer"}');

  // Tool execution end finalizes ONLY the turn 3 tool block
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_END',
    payload: {
      toolCallId: 'call-read-pkg',
      output: '{"name": "pi-viewer", "version": "0.1.0"}',
      isError: false,
    },
  });
  assert.strictEqual(state.messages.find((m) => m.id === 'asst-past-1')?.blocks, undefined);
  assert.strictEqual(state.messages.find((m) => m.id === 'asst-past-2')?.blocks, undefined);
  const finalLastMsg = state.messages[state.messages.length - 1];
  assert.strictEqual((finalLastMsg.blocks?.[0] as ToolCallBlock).status, 'completed');
  assert.strictEqual((finalLastMsg.blocks?.[0] as ToolCallBlock).output, '{"name": "pi-viewer", "version": "0.1.0"}');
});

test('Reducer: handles LOAD_SESSIONS lifecycle (start, success, error)', () => {
  let state = { ...INITIAL_STATE };

  state = chatReducer(state, { type: 'LOAD_SESSIONS_START' });
  assert.strictEqual(state.isSessionsLoading, true);
  assert.strictEqual(state.sessionsError, null);

  const sampleSessions = [
    { id: 's1', path: '/s1.jsonl', firstMessage: 'Task 1', messageCount: 2, isActive: true },
    { id: 's2', path: '/s2.jsonl', firstMessage: 'Task 2', messageCount: 4, isActive: false },
  ];

  state = chatReducer(state, {
    type: 'LOAD_SESSIONS_SUCCESS',
    payload: { sessions: sampleSessions },
  });
  assert.strictEqual(state.isSessionsLoading, false);
  assert.strictEqual(state.sessions.length, 2);
  assert.strictEqual(state.sessions[0].id, 's1');

  state = chatReducer(state, {
    type: 'LOAD_SESSIONS_ERROR',
    payload: { error: 'Failed to read directory' },
  });
  assert.strictEqual(state.isSessionsLoading, false);
  assert.strictEqual(state.sessionsError, 'Failed to read directory');
});

test('Reducer: handles SWITCH_SESSION lifecycle and updates isActive flags', () => {
  let state: ChatSessionState = {
    ...INITIAL_STATE,
    connectionStatus: 'connected',
    sessionId: 's1',
    sessionFile: '/s1.jsonl',
    sessions: [
      { id: 's1', path: '/s1.jsonl', firstMessage: 'Task 1', messageCount: 2, isActive: true },
      { id: 's2', path: '/s2.jsonl', firstMessage: 'Task 2', messageCount: 4, isActive: false },
    ],
  };

  state = chatReducer(state, {
    type: 'SWITCH_SESSION_START',
    payload: { sessionPath: '/s2.jsonl' },
  });
  assert.strictEqual(state.isSwitchingSession, true);

  state = chatReducer(state, {
    type: 'SWITCH_SESSION_SUCCESS',
    payload: {
      sessionId: 's2',
      sessionFile: '/s2.jsonl',
      messages: [
        { id: 'm1', role: 'user', content: 'Task 2', timestamp: '10:00' },
      ],
    },
  });
  assert.strictEqual(state.isSwitchingSession, false);
  assert.strictEqual(state.sessionId, 's2');
  assert.strictEqual(state.sessionFile, '/s2.jsonl');
  assert.strictEqual(state.messages.length, 1);
  assert.strictEqual(state.isHydrated, true);

  // Verify isActive updated across sessions list
  const activeSession = state.sessions.find((s) => s.isActive);
  assert.strictEqual(activeSession?.id, 's2');
  assert.strictEqual(state.sessions.find((s) => s.id === 's1')?.isActive, false);

  // Test SWITCH_SESSION_CANCELLED
  state = chatReducer(state, { type: 'SWITCH_SESSION_CANCELLED' });
  assert.strictEqual(state.isSwitchingSession, false);

  // Test SWITCH_SESSION_ERROR
  state = chatReducer(state, {
    type: 'SWITCH_SESSION_ERROR',
    payload: { error: 'File read error' },
  });
  assert.strictEqual(state.isSwitchingSession, false);
  assert.strictEqual(state.lastError, 'File read error');
});

test('Reducer: TOGGLE_SIDEBAR opens, closes, and explicitly sets state', () => {
  let state = { ...INITIAL_STATE, isSidebarOpen: true };

  state = chatReducer(state, { type: 'TOGGLE_SIDEBAR' });
  assert.strictEqual(state.isSidebarOpen, false);

  state = chatReducer(state, { type: 'TOGGLE_SIDEBAR' });
  assert.strictEqual(state.isSidebarOpen, true);

  state = chatReducer(state, { type: 'TOGGLE_SIDEBAR', payload: { isOpen: false } });
  assert.strictEqual(state.isSidebarOpen, false);

  state = chatReducer(state, { type: 'TOGGLE_SIDEBAR', payload: { isOpen: true } });
  assert.strictEqual(state.isSidebarOpen, true);
});

test('Reducer: UPDATE_SESSION_STATUS updates runtime status of matching session by id or path', () => {
  const initialSessions: SessionSummary[] = [
    { id: 's1', path: '/path/s1.jsonl', messageCount: 5, isActive: true, firstMessage: 'Hello' },
    { id: 's2', path: '/path/s2.jsonl', messageCount: 2, isActive: false, firstMessage: 'Background' },
  ];
  let state = { ...INITIAL_STATE, sessions: initialSessions };

  // Update s2 by id to working
  state = chatReducer(state, {
    type: 'UPDATE_SESSION_STATUS',
    payload: { sessionId: 's2', status: 'working' },
  });
  assert.strictEqual(state.sessions.find((s) => s.id === 's2')?.status, 'working');
  assert.strictEqual(state.sessions.find((s) => s.id === 's1')?.status, undefined);

  // Update s2 by path to waiting
  state = chatReducer(state, {
    type: 'UPDATE_SESSION_STATUS',
    payload: { sessionPath: '/path/s2.jsonl', status: 'waiting' },
  });
  assert.strictEqual(state.sessions.find((s) => s.id === 's2')?.status, 'waiting');

  // Update s2 to completed
  state = chatReducer(state, {
    type: 'UPDATE_SESSION_STATUS',
    payload: { sessionId: 's2', status: 'completed' },
  });
  assert.strictEqual(state.sessions.find((s) => s.id === 's2')?.status, 'completed');
});

test('Reducer: model, thinking level, and session stats actions update state correctly', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'm-default', name: 'Default Model', provider: 'prov' } },
  });

  // 1. SET_AVAILABLE_MODELS
  state = chatReducer(state, {
    type: 'SET_AVAILABLE_MODELS',
    payload: {
      models: [
        { id: 'm1', name: 'Model 1', provider: 'p1' },
        { id: 'm2', name: 'Model 2', provider: 'p2' },
      ],
    },
  });
  assert.strictEqual(state.availableModels.length, 2);
  assert.strictEqual(state.isModelsLoading, false);

  // 2. MODEL_CHANGE lifecycle
  state = chatReducer(state, { type: 'MODEL_CHANGE_START' });
  assert.strictEqual(state.isChangingModel, true);

  state = chatReducer(state, {
    type: 'MODEL_CHANGE_SUCCESS',
    payload: {
      model: { id: 'm2', name: 'Model 2', provider: 'p2' },
      thinkingLevel: 'medium',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
  });
  assert.strictEqual(state.isChangingModel, false);
  assert.strictEqual(state.modelInfo?.id, 'm2');
  assert.strictEqual(state.thinkingLevel, 'medium');
  assert.deepStrictEqual(state.availableThinkingLevels, ['off', 'low', 'medium', 'high']);

  // MODEL_CHANGE_FAIL
  state = chatReducer(state, { type: 'MODEL_CHANGE_START' });
  state = chatReducer(state, {
    type: 'MODEL_CHANGE_FAIL',
    payload: { error: 'Failed to switch model' },
  });
  assert.strictEqual(state.isChangingModel, false);
  assert.strictEqual(state.lastError, 'Failed to switch model');

  // 3. SET_THINKING_LEVEL & SET_AVAILABLE_THINKING_LEVELS
  state = chatReducer(state, {
    type: 'SET_THINKING_LEVEL',
    payload: { level: 'high' },
  });
  assert.strictEqual(state.thinkingLevel, 'high');

  state = chatReducer(state, {
    type: 'SET_AVAILABLE_THINKING_LEVELS',
    payload: { levels: ['off', 'minimal', 'high'] },
  });
  assert.deepStrictEqual(state.availableThinkingLevels, ['off', 'minimal', 'high']);

  // 4. SET_SESSION_STATS
  state = chatReducer(state, {
    type: 'SET_SESSION_STATS',
    payload: {
      stats: {
        sessionId: 'sess-1',
        tokens: { input: 1000, output: 200, total: 1200 },
        contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
      },
    },
  });
  assert.strictEqual(state.sessionStats?.tokens?.total, 1200);
  assert.strictEqual(state.sessionStats?.contextUsage?.percent, 0.6);

  // 5. DISCONNECT clears stats and available models
  state = chatReducer(state, { type: 'DISCONNECT' });
  assert.strictEqual(state.sessionStats, null);
  assert.deepStrictEqual(state.availableModels, []);
});

test('Reducer: per-model context tracking, unrecorded model null stats, restore previous stats, and session resets', () => {
  // 1. Initial connection with anthropic model
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: {
      model: { id: 'claude-3-5-sonnet', provider: 'anthropic', contextWindow: 200000 },
    },
  });
  assert.deepStrictEqual(state.modelStats, {});
  assert.strictEqual(state.sessionStats, null);

  // 2. SET_SESSION_STATS stores stats under active model key in modelStats
  const anthropicStats: SessionStats = {
    sessionId: 'sess-1',
    tokens: { input: 5000, output: 1000, total: 6000 },
    contextUsage: { tokens: 6000, contextWindow: 200000, percent: 3.0 },
  };
  state = chatReducer(state, {
    type: 'SET_SESSION_STATS',
    payload: { stats: anthropicStats },
  });
  assert.strictEqual(state.sessionStats, anthropicStats);
  assert.strictEqual(state.modelStats['anthropic/claude-3-5-sonnet'], anthropicStats);

  // 3. MODEL_CHANGE_SUCCESS with a new unrecorded model sets sessionStats to null
  const newModel: ModelInfo = { id: 'gpt-4o', provider: 'openai', contextWindow: 128000 };
  state = chatReducer(state, {
    type: 'MODEL_CHANGE_SUCCESS',
    payload: { model: newModel },
  });
  assert.strictEqual(state.sessionStats, null);
  assert.strictEqual(state.modelInfo?.id, 'gpt-4o');
  // Existing anthropic stats remain in modelStats
  assert.strictEqual(state.modelStats['anthropic/claude-3-5-sonnet'], anthropicStats);
  assert.strictEqual(state.modelStats['openai/gpt-4o'], undefined);

  // Record stats for gpt-4o
  const openaiStats: SessionStats = {
    sessionId: 'sess-1',
    tokens: { input: 1200, output: 400, total: 1600 },
    contextUsage: { tokens: 1600, contextWindow: 128000, percent: 1.25 },
  };
  state = chatReducer(state, {
    type: 'SET_SESSION_STATS',
    payload: { stats: openaiStats },
  });
  assert.strictEqual(state.sessionStats, openaiStats);
  assert.strictEqual(state.modelStats['openai/gpt-4o'], openaiStats);

  // 4. MODEL_CHANGE_SUCCESS back to the previously recorded model restores its sessionStats
  state = chatReducer(state, {
    type: 'MODEL_CHANGE_SUCCESS',
    payload: { model: { id: 'claude-3-5-sonnet', provider: 'anthropic', contextWindow: 200000 } },
  });
  assert.strictEqual(state.sessionStats, anthropicStats);
  assert.strictEqual(state.modelInfo?.id, 'claude-3-5-sonnet');

  // 5. NEW_SESSION_SUCCESS resets modelStats to {} and sessionStats to null
  state = chatReducer(state, {
    type: 'NEW_SESSION_SUCCESS',
    payload: { sessionId: 'sess-2', sessionFile: '/path/to/sess-2.json' },
  });
  assert.deepStrictEqual(state.modelStats, {});
  assert.strictEqual(state.sessionStats, null);

  // Set stats again to verify SWITCH_SESSION_SUCCESS resets modelStats
  state = chatReducer(state, {
    type: 'SET_SESSION_STATS',
    payload: { stats: anthropicStats },
  });
  assert.strictEqual(state.modelStats['anthropic/claude-3-5-sonnet'], anthropicStats);

  // 6. SWITCH_SESSION_SUCCESS resets modelStats to {} and sessionStats to null
  state = chatReducer(state, {
    type: 'SWITCH_SESSION_SUCCESS',
    payload: {
      sessionId: 'sess-3',
      sessionFile: '/path/to/sess-3.json',
      messages: [],
    },
  });
  assert.deepStrictEqual(state.modelStats, {});
  assert.strictEqual(state.sessionStats, null);
});

test('Reducer composition contract: each slice returns undefined for an action it does not own', () => {
  const foreignToConnection: ChatAction = {
    type: 'SET_THINKING_LEVEL',
    payload: { level: 'high' },
  };
  assert.strictEqual(connectionReducer(INITIAL_STATE, foreignToConnection), undefined);

  const foreignToSessions: ChatAction = { type: 'CONNECT_START' };
  assert.strictEqual(sessionsReducer(INITIAL_STATE, foreignToSessions), undefined);

  const foreignToMessaging: ChatAction = { type: 'TOGGLE_SIDEBAR' };
  assert.strictEqual(messagingReducer(INITIAL_STATE, foreignToMessaging), undefined);

  const foreignToToolExecution: ChatAction = { type: 'CLEAR_ERROR' };
  assert.strictEqual(toolExecutionReducer(INITIAL_STATE, foreignToToolExecution), undefined);

  const foreignToModels: ChatAction = { type: 'ABORT_CLICKED' };
  assert.strictEqual(modelsReducer(INITIAL_STATE, foreignToModels), undefined);
});

test('Reducer composition contract: chatReducer falls through every slice and returns unchanged state for an unrecognized action type', () => {
  const unknownAction = { type: 'SOME_UNKNOWN_ACTION_TYPE' } as unknown as ChatAction;
  const result = chatReducer(INITIAL_STATE, unknownAction);
  assert.strictEqual(result, INITIAL_STATE);
});

test('Reducer composition contract: chatReducer dispatches an owned action to its slice regardless of slice order', () => {
  const state = chatReducer(INITIAL_STATE, {
    type: 'SET_THINKING_LEVEL',
    payload: { level: 'medium' },
  });
  assert.strictEqual(state.thinkingLevel, 'medium');
});

// --- Issue #6: queue prompts during generation via streamingBehavior: "followUp" ---

test('Reducer: PROMPT_QUEUED during busy streaming preserves pendingPromptId/agentActivity/activeAssistantMessageId', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Long running task' },
  });
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-msg-1', role: 'assistant', content: '' } },
  });
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.pendingPromptId, 'prompt-1');
  assert.strictEqual(state.activeAssistantMessageId, 'asst-msg-1');

  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Follow up while busy' },
  });

  // Queueing must not disturb the in-flight prompt's tracked state.
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.pendingPromptId, 'prompt-1');
  assert.strictEqual(state.activeAssistantMessageId, 'asst-msg-1');

  const queuedMessage = state.messages.find((m) => m.id === 'prompt-2');
  assert.ok(queuedMessage, 'queued message must be appended');
  assert.strictEqual(queuedMessage?.role, 'user');
  assert.strictEqual(queuedMessage?.isQueued, true);

  // The streaming assistant message must still be reachable by subsequent updates.
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: 'still streaming' },
  });
  const assistantMessage = state.messages.find((m) => m.id === 'asst-msg-1');
  assert.strictEqual(assistantMessage?.content, 'still streaming');
  assert.strictEqual(assistantMessage?.isStreaming, true);
});

test('Reducer: EVENT_MESSAGE_START inserts a new assistant message before trailing queued messages', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First turn' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Queued follow-up' },
  });

  // Pi starts the follow-up's assistant turn while the queued user message is still last.
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { id: 'asst-msg-2', role: 'assistant', content: '' } },
  });

  const ids = state.messages.map((m) => m.id);
  assert.deepStrictEqual(ids, ['prompt-1', 'asst-msg-2', 'prompt-2']);
});

test('Reducer: user-role message_start clears isQueued on the earliest matching queued message', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First turn' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Queued follow-up' },
  });

  // Pi begins processing the queued follow-up: emits a user-role message_start.
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'user-echo-1', role: 'user', content: 'Queued follow-up' },
    },
  });

  const queuedMessage = state.messages.find((m) => m.id === 'prompt-2');
  assert.strictEqual(queuedMessage?.isQueued, false);
  // Position and content are preserved; only the flag is cleared.
  assert.strictEqual(queuedMessage?.content, 'Queued follow-up');
  assert.strictEqual(state.messages[state.messages.length - 1].id, 'prompt-2');
});

test('Reducer: user-role message_start of the running prompt does not clear a queued follow-up', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First turn' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Queued follow-up' },
  });

  // Pi echoes the running prompt after the follow-up was already queued.
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { id: 'user-echo-1', role: 'user', content: 'First turn' },
    },
  });

  assert.strictEqual(state.messages.find((m) => m.id === 'prompt-2')?.isQueued, true);
});

test('Reducer: user-role message_start matches a queued message whose sent text has appended file blocks', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-1', message: 'First queued' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Second queued' },
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        id: 'user-echo-2',
        role: 'user',
        content: 'Second queued\n\n<file name="a.txt">\nhello\n</file>',
      },
    },
  });

  assert.strictEqual(state.messages.find((m) => m.id === 'prompt-1')?.isQueued, true);
  assert.strictEqual(state.messages.find((m) => m.id === 'prompt-2')?.isQueued, false);
});

test('Reducer: EVENT_AGENT_SETTLED clears any leftover queued flags', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First turn' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Queued follow-up' },
  });
  state = chatReducer(state, { type: 'EVENT_AGENT_SETTLED' });

  const queuedMessage = state.messages.find((m) => m.id === 'prompt-2');
  assert.strictEqual(queuedMessage?.isQueued, false);
  assert.strictEqual(state.agentActivity, 'idle');
});

test('Reducer: QUEUED_PROMPT_REJECTED removes the queued message and sets lastError without idling the agent', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First turn' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Queued follow-up' },
  });

  state = chatReducer(state, {
    type: 'QUEUED_PROMPT_REJECTED',
    payload: { id: 'prompt-2', error: 'Duplicate prompt request ID' },
  });

  assert.strictEqual(state.messages.find((m) => m.id === 'prompt-2'), undefined);
  assert.strictEqual(state.lastError, 'Duplicate prompt request ID');
  // The in-flight prompt must be unaffected.
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.pendingPromptId, 'prompt-1');
});

test('Reducer: ABORT_COMPLETED clears isQueued on messages that never started and marks them cancelled', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'First turn' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-2', message: 'Queued follow-up' },
  });

  state = chatReducer(state, { type: 'ABORT_CLICKED' });
  state = chatReducer(state, { type: 'ABORT_COMPLETED' });

  const queuedMessage = state.messages.find((m) => m.id === 'prompt-2');
  assert.strictEqual(queuedMessage?.isQueued, false);
  assert.strictEqual(queuedMessage?.isCancelled, true);
  assert.strictEqual(state.agentActivity, 'idle');
});

test('Reducer: CLEAR_MESSAGES empties the active project messages without touching connection state', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Hello' },
  });
  assert.ok(state.messages.length > 0);

  state = chatReducer(state, { type: 'CLEAR_MESSAGES' });

  assert.deepEqual(state.messages, []);
  assert.strictEqual(state.connectionStatus, 'connected');
  assert.strictEqual(state.activeAssistantMessageId, null);
});

test('Reducer: CLEAR_MESSAGES on an already-empty conversation is a safe no-op', () => {
  const state = chatReducer(INITIAL_STATE, { type: 'CLEAR_MESSAGES' });
  assert.deepEqual(state.messages, []);
});

test('Reducer: ADD_SYSTEM_MESSAGE appends an assistant-rendered message without disturbing agent activity', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'ADD_SYSTEM_MESSAGE',
    payload: { content: '## Command Palette Help\n\n- `/clear` — clears the chat' },
  });

  assert.strictEqual(state.messages.length, 1);
  const [msg] = state.messages;
  assert.strictEqual(msg.role, 'assistant');
  assert.strictEqual(msg.content, '## Command Palette Help\n\n- `/clear` — clears the chat');
  assert.strictEqual(msg.isStreaming, undefined);
  assert.strictEqual(state.agentActivity, 'idle');
  assert.ok(msg.id);
  assert.ok(msg.timestamp);
});

test('Reducer: ADD_SYSTEM_MESSAGE appends after existing messages, preserving order', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Hi' },
  });

  state = chatReducer(state, {
    type: 'ADD_SYSTEM_MESSAGE',
    payload: { content: 'Reconnected.' },
  });

  assert.strictEqual(state.messages.length, 2);
  assert.strictEqual(state.messages[0].role, 'user');
  assert.strictEqual(state.messages[1].role, 'assistant');
  assert.strictEqual(state.messages[1].content, 'Reconnected.');
});

test('Reducer: PROMPT_SUBMIT preserves optimistic image attachments in user message', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  const testImages = [
    { type: 'image' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mimeType: 'image/png' },
  ];

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-img-1', message: 'Check this image', images: testImages } as any,
  });

  assert.strictEqual(state.messages.length, 1);
  const msg = state.messages[0];
  assert.strictEqual(msg.id, 'prompt-img-1');
  assert.strictEqual(msg.content, 'Check this image');
  assert.deepEqual((msg as any).images, testImages);
});

test('Reducer: PROMPT_QUEUED preserves optimistic image attachments in queued message', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Running turn' },
  });

  const testImages = [
    { type: 'image' as const, data: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', mimeType: 'image/jpeg' },
  ];

  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-queued-img', message: 'Queued image turn', images: testImages } as any,
  });

  const queuedMsg = state.messages.find((m) => m.id === 'prompt-queued-img');
  assert.ok(queuedMsg);
  assert.strictEqual(queuedMsg.isQueued, true);
  assert.deepEqual((queuedMsg as any).images, testImages);
});

test('Reducer: EVENT_MESSAGE_START preserves queued images when processing starts', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Running' },
  });

  const testImages = [
    { type: 'image' as const, data: 'UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2AAA', mimeType: 'image/webp' },
  ];

  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-q', message: '(see attached image)', images: testImages } as any,
  });

  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        id: 'echo-1',
        role: 'user',
        content: '(see attached image)',
      },
    },
  });

  const processedMsg = state.messages.find((m) => m.id === 'prompt-q');
  assert.ok(processedMsg);
  assert.strictEqual(processedMsg.isQueued, false);
  assert.deepEqual((processedMsg as any).images, testImages);
});

test('Reducer regression: EVENT_MESSAGE_START running image echo does not dequeue unrelated queued follow-up and preserves abort cancellation', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  const imageA = [
    { type: 'image' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mimeType: 'image/png' },
  ];
  const imageB = [
    { type: 'image' as const, data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', mimeType: 'image/gif' },
  ];

  // 1. Submit running prompt A with image A
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-running-A', message: '(see attached image)', images: imageA },
  });

  // 2. Queue follow-up prompt B with image B
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-queued-B', message: '(see attached image)', images: imageB },
  });

  // 3. Pi emits echo of running prompt A with image A
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        id: 'echo-running-A',
        role: 'user',
        content: [
          { type: 'text', text: '(see attached image)' },
          { type: 'image', data: imageA[0].data, mimeType: 'image/png' },
        ],
      },
    },
  });

  // Queued prompt B must NOT be dequeued by running prompt A's echo
  const promptBAfterEcho = state.messages.find((m) => m.id === 'prompt-queued-B');
  assert.ok(promptBAfterEcho);
  assert.strictEqual(promptBAfterEcho.isQueued, true, 'Queued prompt B must remain queued');

  // 4. Abort while prompt A is running
  state = chatReducer(state, { type: 'ABORT_CLICKED' });
  state = chatReducer(state, { type: 'ABORT_COMPLETED' });

  // Abort must cancel prompt B because it was still queued
  const promptBAfterAbort = state.messages.find((m) => m.id === 'prompt-queued-B');
  assert.ok(promptBAfterAbort);
  assert.strictEqual(promptBAfterAbort.isQueued, false);
  assert.strictEqual(promptBAfterAbort.isCancelled, true, 'Prompt B must be cancelled on abort');
});

test('Reducer: EVENT_MESSAGE_START image-only echo matches queued message by image identity without text', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  const imageB = [
    { type: 'image' as const, data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', mimeType: 'image/gif' },
  ];

  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Running' },
  });

  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-queued-imgonly', message: '', images: imageB },
  });

  // Pi emits user-role message_start with ONLY an image block and no text
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        id: 'echo-imgonly',
        role: 'user',
        content: [
          { type: 'image', data: imageB[0].data, mimeType: 'image/gif' },
        ],
      },
    },
  });

  const queuedMsg = state.messages.find((m) => m.id === 'prompt-queued-imgonly');
  assert.ok(queuedMsg);
  assert.strictEqual(queuedMsg.isQueued, false);
  assert.deepEqual(queuedMsg.images, imageB);
});
