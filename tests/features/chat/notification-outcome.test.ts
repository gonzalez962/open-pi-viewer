import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventController } from '@features/chat/session-events';
import type { NotifyAppEventParams } from '@infra/notifications';

for (const [text, stopReason, expected] of [
  ['Necesito que confirmes para continuar.', 'stop', 'waiting_input'],
  ['Done', 'error', 'error'],
  ['No pude completar la tarea.', 'stop', 'error'],
  ['Done', 'stop', 'task_complete'],
  ['Cancelled', 'aborted', null],
] as const) {
  test(`settled notification outcome: ${stopReason} / ${expected}`, () => {
    const sent: NotifyAppEventParams[] = [];
    const controller = new SessionEventController({
      getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/repo' }),
      getCurrentSessionId: () => 'one', dispatch: () => {},
      checkPersistenceFn: async () => { throw new Error('No persistence in test'); },
      notifyAppEventFn: params => sent.push(params),
    });
    controller.handleEvent({ type: 'agent_start', sessionId: 'one' });
    controller.handleEvent({ type: 'message_end', sessionId: 'one', message: { role: 'assistant', content: text, stopReason } });
    controller.handleEvent({ type: 'agent_end', sessionId: 'one', willRetry: true });
    assert.equal(sent.length, 0);
    controller.handleEvent({ type: 'agent_settled', sessionId: 'one' });
    assert.equal(sent.length, expected === null ? 0 : 1);
    if (expected) assert.equal(sent[0].eventType, expected);
  });
}
