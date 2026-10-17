import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventController } from '@features/chat/session-events';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import { hydrateChatMessages } from '@core/session';
import type { NotifyAppEventParams } from '@infra/notifications';

const error = 'Model not found: nonexistent-model';
const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: error };

test('model error is visible in live history and survives authoritative history reload', () => {
  let state = { ...INITIAL_STATE, connectionStatus: 'connected' as const, sessionId: 'one' };
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/repo' }),
    getCurrentSessionId: () => 'one',
    dispatch: action => { state = chatReducer(state, action) as typeof state; },
    checkPersistenceFn: async () => { throw new Error('No persistence in test'); },
    notifyAppEventFn: () => {},
  });
  controller.handleEvent({ type: 'message_start', sessionId: 'one', message });
  controller.handleEvent({ type: 'message_end', sessionId: 'one', message });
  assert.ok(state.messages.some(item => item.content.includes(error)), 'live history must show the exact model error');
  assert.ok(hydrateChatMessages([message]).some(item => item.content.includes(error)), 'reloaded history must show the exact model error');
});

test('failed run emits only an error notification even when settlement is repeated', () => {
  const sent: NotifyAppEventParams[] = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/repo' }),
    getCurrentSessionId: () => 'one', dispatch: () => {},
    checkPersistenceFn: async () => { throw new Error('No persistence in test'); },
    notifyAppEventFn: params => sent.push(params),
  });
  controller.handleEvent({ type: 'agent_start', sessionId: 'one' });
  controller.handleEvent({ type: 'message_end', sessionId: 'one', message });
  controller.handleEvent({ type: 'agent_end', sessionId: 'one' });
  controller.handleEvent({ type: 'agent_settled', sessionId: 'one' });
  controller.handleEvent({ type: 'agent_settled', sessionId: 'one' });
  assert.deepEqual(sent.map(item => item.eventType), ['error']);
  controller.handleEvent({ type: 'agent_start', sessionId: 'one' });
  controller.handleEvent({ type: 'message_end', sessionId: 'one', message: { role: 'assistant', content: 'Done', stopReason: 'stop' } });
  controller.handleEvent({ type: 'agent_settled', sessionId: 'one' });
  assert.deepEqual(sent.map(item => item.eventType), ['error', 'task_complete']);
});
