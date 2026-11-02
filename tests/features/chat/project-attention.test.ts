import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventController, type SessionEventControllerOptions } from '@features/chat/session-events';

function harness() {
  const attention: any[] = [];
  const actions: any[] = [];
  const notifications: any[] = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/active' }),
    getCurrentSessionId: () => 'active-session',
    getProjectSessionId: () => 'selected',
    resolveTargetProjectId: (cwd: string | undefined) => cwd === '/other' ? 'other' : cwd === '/active' ? 'active' : undefined,
    dispatch: (action: Parameters<SessionEventControllerOptions['dispatch']>[0]) => actions.push(action),
    notifyAppEventFn: (event: Parameters<NonNullable<SessionEventControllerOptions['notifyAppEventFn']>>[0]) => notifications.push(event),
    getPreferences: () => ({ language: 'en', notifications: { enabled: false, sound: false, suppressWhenFocused: true, onTaskComplete: false, onWaitingInput: false } }),
    checkPersistenceFn: async () => { throw new Error('not available'); },
    dialogAdapter: { select: async () => null, input: async () => null, confirm: async () => null },
    sendExtensionUiResponseFn: async (payload: Parameters<NonNullable<SessionEventControllerOptions['sendExtensionUiResponseFn']>>[0]) => ({ id: payload.id, success: true }),
    onAttention: (event: any) => attention.push(event),
  } as any);
  return { controller, attention, actions, notifications };
}

for (const sessionId of ['selected', 'background']) {
  for (const [text, stopReason, expected] of [
    ['Done', 'stop', 'task_complete'],
    ['Failed', 'error', 'error'],
    ['Necesito que confirmes para continuar.', 'stop', 'waiting_input'],
  ] as const) {
    test(`S1.1 ${sessionId}: ${expected} retains originating project`, () => {
      const { controller, attention } = harness();
      const base = { cwd: '/other', sessionId };
      controller.handleEvent({ ...base, type: 'agent_start' });
      controller.handleEvent({ ...base, type: 'message_end', message: { role: 'assistant', content: text, stopReason } });
      controller.handleEvent({ ...base, type: 'agent_settled' });
      assert.equal(attention.length, 1);
      assert.equal(attention[0].projectId, 'other');
      assert.equal(attention[0].sessionId, sessionId);
      assert.equal(attention[0].type, expected);
    });
  }
  test(`S1.1 ${sessionId}: interactive request emits waiting`, () => {
    const { controller, attention } = harness();
    controller.handleEvent({ type: 'extension_ui_request', cwd: '/other', sessionId, id: 'prompt', method: 'confirm' });
    assert.equal(attention.length, 1);
    assert.equal(attention[0].projectId, 'other');
    assert.equal(attention[0].sessionId, sessionId);
    assert.equal(attention[0].type, 'waiting_input');
  });
}

test('S1.1 in-app callback is independent of disabled OS notifications', () => {
  const { controller, attention, notifications } = harness();
  controller.handleEvent({ type: 'agent_settled', cwd: '/other', sessionId: 'selected' });
  assert.equal(notifications[0].preferences.enabled, false);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].type, 'task_complete');
});

test('S1.2 background bridge error surfaces without active conversation dispatch', () => {
  const { controller, attention, actions } = harness();
  controller.handleStatusChange({ state: 'error', label: 'Error', detail: 'Process exited', cwd: '/other', sessionId: 'background' });
  assert.equal(attention.length, 1);
  assert.equal(attention[0].projectId, 'other');
  assert.equal(attention[0].type, 'error');
  assert.deepEqual(actions, []);
});

test('S2.2 repeated turn is deduplicated, new turn eligible, cancellation ignored', () => {
  const { controller, attention } = harness();
  const base = { cwd: '/other', sessionId: 'background' };
  const turn = (stopReason: string) => {
    controller.handleEvent({ ...base, type: 'agent_start' });
    controller.handleEvent({ ...base, type: 'message_end', message: { role: 'assistant', content: 'Done', stopReason } });
    controller.handleEvent({ ...base, type: 'agent_settled' });
    controller.handleEvent({ ...base, type: 'agent_settled' });
  };
  turn('stop'); assert.equal(attention.length, 1);
  turn('stop'); assert.equal(attention.length, 2);
  turn('aborted'); assert.equal(attention.length, 2);
});

test('S2.2 duplicate prompts are suppressed, distinct prompts and new turns remain eligible', () => {
  const { controller, attention } = harness();
  const base = { cwd: '/other', sessionId: 'background' };
  const prompt = (id: string) => controller.handleEvent({ ...base, type: 'extension_ui_request', id, method: 'confirm' });
  controller.handleEvent({ ...base, type: 'agent_start' });
  prompt('one'); prompt('one'); prompt('two');
  assert.deepEqual(attention.map(a => a.type), ['waiting_input', 'waiting_input']);
  controller.handleEvent({ ...base, type: 'agent_start' });
  prompt('one');
  assert.equal(attention.length, 3);
});

test('S1.1 unknown explicit origins do not emit attention', () => {
  const { controller, attention } = harness();
  controller.handleEvent({ type: 'agent_settled', cwd: '/unknown', sessionId: 'background' });
  controller.handleStatusChange({ state: 'error', label: 'Error', detail: 'failed', cwd: '/unknown', sessionId: 'background' });
  assert.deepEqual(attention, []);
});

test('S3.1 existing selected session completion, input and cancellation still route and notify', () => {
  const { controller, actions, notifications } = harness();
  const base = { cwd: '/other', sessionId: 'selected' };
  controller.handleEvent({ ...base, type: 'agent_start' });
  controller.handleEvent({ ...base, type: 'message_end', message: { role: 'assistant', content: 'Done', stopReason: 'stop' } });
  controller.handleEvent({ ...base, type: 'agent_settled' });
  controller.handleEvent({ ...base, type: 'extension_ui_request', id: 'prompt', method: 'confirm' });
  controller.handleEvent({ ...base, type: 'agent_start' });
  controller.handleEvent({ ...base, type: 'message_end', message: { role: 'assistant', content: 'Cancelled', stopReason: 'aborted' } });
  controller.handleEvent({ ...base, type: 'agent_settled' });
  assert.deepEqual(notifications.map(n => n.eventType), ['task_complete', 'waiting_input']);
  assert.deepEqual(actions.map(a => a.type), ['EVENT_MESSAGE_END', 'EVENT_AGENT_SETTLED', 'EVENT_MESSAGE_END', 'EVENT_AGENT_SETTLED']);
  assert.ok(actions.every(a => a.targetProjectId === 'other'));
});
