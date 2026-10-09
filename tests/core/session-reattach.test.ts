import test from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';

test('session hydration restores busy/waiting activity without changing desktop default', () => {
  for (const activity of ['busy', 'waiting'] as const) {
    const state = chatReducer(INITIAL_STATE, { type: 'SESSION_READY', payload: { messages: [], activity } } as any);
    assert.equal(state.agentActivity, 'busy');
    assert.equal(state.isHydrated, true);
  }
  assert.equal(chatReducer(INITIAL_STATE, { type: 'SESSION_READY', payload: { messages: [] } }).agentActivity, 'idle');
});

test('reattached prompt response preserves originating session identity and deduplicates replay', async () => {
  const responses: any[] = [];
  let finish!: (value: boolean) => void;
  let dialogs = 0;
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/project' }),
    getCurrentSessionId: () => 'other-session',
    dispatch: () => {},
    sendExtensionUiResponseFn: async (payload) => { responses.push(payload); return { id: payload.id, success: true }; },
    dialogAdapter: { select: () => null, input: () => null, confirm: () => { dialogs++; return new Promise<boolean>((resolve) => { finish = resolve; }); } },
  });
  const prompt = { type: 'extension_ui_request' as const, id: 'approval', method: 'confirm', cwd: '/project', sessionFile: '/project/session-a.jsonl' };
  const answering = controller.handleExtensionUiRequest(prompt);
  await controller.handleExtensionUiRequest(prompt);
  assert.equal(dialogs, 1);
  finish(true);
  await answering;
  assert.equal(responses[0].sessionFile, prompt.sessionFile);
  assert.equal(responses[0].confirmed, true);
});

test('runtime snapshots restore dialogs before the current React session identity changes', async () => {
  let shown = false;
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/project' }),
    getCurrentSessionId: () => 'old-session', dispatch: () => {},
    dialogAdapter: { select: () => null, input: () => null, confirm: () => { shown = true; return new Promise(() => {}); } },
  });
  controller.handleEvent({ type: 'runtime_snapshot', sessionId: 'new-session', messages: [], pendingExtensionPrompts: [{ type: 'extension_ui_request', id: 'restore', method: 'confirm', sessionId: 'new-session' }] });
  assert.equal(shown, true);
  controller.cancelPendingDialogRequests(undefined, true);
});

test('browser controller detachment dismisses local dialog without cancelling runtime request', async () => {
  const responses: any[] = [];
  let finish!: (value: boolean | null) => void;
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/project' }),
    getCurrentSessionId: () => 'session', dispatch: () => {},
    sendExtensionUiResponseFn: async (payload) => { responses.push(payload); return { id: payload.id, success: true }; },
    dialogAdapter: { select: () => null, input: () => null, confirm: () => new Promise((resolve) => { finish = resolve; }), cancelPending: () => finish(null) },
  });
  const pending = controller.handleExtensionUiRequest({ type: 'extension_ui_request', id: 'approval', method: 'confirm' });
  (controller as any).cancelPendingDialogRequests(undefined, true);
  await pending;
  assert.deepEqual(responses, []);
});
