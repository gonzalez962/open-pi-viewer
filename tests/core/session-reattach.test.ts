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

test('S2.3 nonselected live snapshot reconciles jobs without replacing selected conversation', () => {
  let state = { ...INITIAL_STATE, connectionStatus: 'connected' as const, sessionId: 'selected', sessionFile: '/project/selected', messages: [{ id: 'm', role: 'user' as const, content: 'keep', timestamp: '' }] };
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/project' }),
    getCurrentSessionId: () => state.sessionId,
    dispatch: action => { state = chatReducer(state, action) as typeof state; },
  });
  controller.handleEvent({ type: 'runtime_snapshot', sessionId: 'other', sessionFile: '/project/other', messages: [], activeJobs: ['job-1'], pendingExtensionPrompts: [] });
  assert.deepEqual(state.jobsBySession?.other, ['job-1']);
  assert.equal(state.sessionId, 'selected');
  assert.equal(state.messages[0].content, 'keep');
});

test('S2.4 selected process exit keeps sibling session jobs', () => {
  let state = { ...INITIAL_STATE, connectionStatus: 'connected' as const, sessionId: 'selected', jobsBySession: { selected: ['a'], other: ['b'] } };
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/project' }),
    getCurrentSessionId: () => state.sessionId,
    dispatch: action => { state = chatReducer(state, action) as typeof state; },
  });
  controller.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: '', cwd: '/project', sessionId: 'selected' });
  assert.deepEqual(state.jobsBySession.other, ['b']);
  assert.equal(state.jobsBySession.selected, undefined);
});

test('S2.3 unavailable background session identified only by file preserves selected session', () => {
  let state = { ...INITIAL_STATE, connectionStatus: 'connected' as const, sessionId: 'b', sessionFile: '/project/b', jobsBySession: { a: ['ja'], b: ['jb'] }, sessions: [
    { id: 'a', path: '/project/a', firstMessage: '', messageCount: 0, isActive: false },
    { id: 'b', path: '/project/b', firstMessage: '', messageCount: 0, isActive: true },
  ] };
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/project' }),
    getCurrentSessionId: () => state.sessionId,
    dispatch: action => { state = chatReducer(state, action) as typeof state; },
  });
  controller.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: '', cwd: '/project', sessionId: null, sessionFile: '/project/a' } as any);
  assert.equal(state.connectionStatus, 'connected');
  assert.deepEqual(state.jobsBySession, { b: ['jb'] });
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
