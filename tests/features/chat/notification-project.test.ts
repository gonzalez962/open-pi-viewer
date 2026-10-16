import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventController } from '@features/chat/session-events';
import type { NotifyAppEventParams } from '@infra/notifications';
import { DEFAULT_LOCALE, translate } from '@shared/i18n';

for (const cwd of ['/work/source-project', 'C:\\work\\source-project\\']) {
  for (const type of ['agent_settled', 'extension_ui_request']) {
    test(`${type} notification identifies the event project (${cwd})`, () => {
      const sent: NotifyAppEventParams[] = [];
      const controller = new SessionEventController({
        getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/work/other-project' }),
        getCurrentSessionId: () => 'session',
        resolveTargetProjectId: () => 'source',
        dispatch: () => {},
        checkPersistenceFn: async () => { throw new Error('No persistence in this test'); },
        notifyAppEventFn: params => sent.push(params),
        dialogAdapter: { select: async () => null, input: async () => null, confirm: async () => null },
        sendExtensionUiResponseFn: async payload => ({ success: true, id: payload.id }),
      });
      controller.handleEvent({ type, cwd, id: 'prompt', method: 'confirm', title: 'Continue?' });
      assert.equal(sent.length, 1);
      assert.match(sent[0].title, /source-project/);
      assert.equal(sent[0].body, translate(DEFAULT_LOCALE, type === 'agent_settled' ? 'notifications.task_complete_body' : 'notifications.waiting_input_body'));
      assert.ok(!sent[0].body.includes(cwd));
      assert.doesNotMatch(sent[0].title + sent[0].body, /other-project/);
      assert.equal(sent[0].projectId, 'source');
      assert.equal(sent[0].sessionId, 'session');
    });
  }
}

test('notification without event cwd uses the current working directory', () => {
  const sent: NotifyAppEventParams[] = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/work/fallback-project' }),
    getCurrentSessionId: () => null, dispatch: () => {}, notifyAppEventFn: params => sent.push(params),
  });
  controller.handleEvent({ type: 'agent_settled' });
  assert.match(sent[0].title, /fallback-project/);
  assert.equal(sent[0].body, translate(DEFAULT_LOCALE, 'notifications.task_complete_body'));
});
