import assert from 'node:assert/strict';
import test from 'node:test';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import { createInitialMultiProjectState, multiProjectChatReducer } from '@core/reducer/multi-project';
import type { SessionStats } from '@core/types/models';
import { SessionEventController } from '@features/chat/session-events';

const usage = (sessionId: string, tokens: number): SessionStats => ({
  sessionId,
  contextUsage: { tokens, contextWindow: 10000, percent: tokens / 100 },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const config = (workingDirectory: string) => ({ nodePath: '', piEntrypoint: '', workingDirectory });

test('S1.1 delayed project A statistics do not replace project B usage', async () => {
  const a = usage('session-a', 1200);
  const b = usage('session-b', 2300);
  let state = createInitialMultiProjectState('a', { ...INITIAL_STATE, sessionId: 'session-a', sessionStats: a });
  state = multiProjectChatReducer(state, { type: 'INIT_PROJECT_STATE', payload: { projectId: 'b', state: { ...INITIAL_STATE, sessionId: 'session-b', sessionStats: b } } });
  const pending = deferred<SessionStats | null>();
  const controller = new SessionEventController({
    getCurrentConfig: () => config(state.activeProjectId === 'a' ? '/a' : '/b'),
    getCurrentSessionId: () => state.projects[state.activeProjectId!].sessionId,
    resolveTargetProjectId: (cwd) => cwd === '/a' ? 'a' : 'b',
    dispatch: (action) => { state = multiProjectChatReducer(state, action); },
    refreshSessionStatsFn: () => pending.promise,
  });
  const refresh = controller.refreshSessionStats();
  state = multiProjectChatReducer(state, { type: 'SET_ACTIVE_PROJECT', payload: { projectId: 'b' } });
  pending.resolve(a);
  await refresh;
  assert.equal(state.projects.b.sessionStats?.contextUsage?.tokens, 2300);
});

test('S1.2 delayed session A statistics do not replace selected session B usage', async () => {
  const a = usage('session-a', 1200);
  const b = usage('session-b', 2300);
  let state = { ...INITIAL_STATE, sessionId: 'session-a', sessionStats: a };
  const pending = deferred<SessionStats | null>();
  const controller = new SessionEventController({
    getCurrentConfig: () => config('/project'),
    getCurrentSessionId: () => state.sessionId,
    dispatch: (action) => { state = chatReducer(state, action); },
    refreshSessionStatsFn: () => pending.promise,
  });
  const refresh = controller.refreshSessionStats();
  state = chatReducer(state, { type: 'SWITCH_SESSION_SUCCESS', payload: { sessionId: 'session-b', sessionFile: '/b.jsonl', messages: [] } });
  state = chatReducer(state, { type: 'SET_SESSION_STATS', payload: { stats: b } });
  pending.resolve(a);
  await refresh;
  assert.equal(state.sessionId, 'session-b');
  assert.equal(state.sessionStats?.contextUsage?.tokens, 2300);
});

test('S1.3 initializing model metadata preserves recorded session usage', () => {
  const stats = usage('session-a', 1200);
  let state = { ...INITIAL_STATE, sessionId: 'session-a' };
  state = chatReducer(state, { type: 'SET_SESSION_STATS', payload: { stats } });
  state = chatReducer(state, { type: 'MODEL_CHANGE_SUCCESS', payload: { model: { id: 'model', provider: 'provider' } } });
  assert.equal(state.sessionStats?.contextUsage?.tokens, 1200);
});

test('S1.4 returning to a used session restores its usage after metadata initialization', async () => {
  const a = usage('session-a', 1200);
  const b = usage('session-b', 2300);
  let state = { ...INITIAL_STATE, sessionId: 'session-a', sessionStats: a };
  state = chatReducer(state, { type: 'SWITCH_SESSION_SUCCESS', payload: { sessionId: 'session-b', sessionFile: '/b.jsonl', messages: [] } });
  state = chatReducer(state, { type: 'SET_SESSION_STATS', payload: { stats: b } });
  state = chatReducer(state, { type: 'SWITCH_SESSION_SUCCESS', payload: { sessionId: 'session-a', sessionFile: '/a.jsonl', messages: [] } });
  const controller = new SessionEventController({
    getCurrentConfig: () => config('/project'),
    getCurrentSessionId: () => state.sessionId,
    dispatch: (action) => { state = chatReducer(state, action); },
    refreshSessionStatsFn: async () => a,
  });
  await controller.refreshSessionStats();
  state = chatReducer(state, { type: 'MODEL_CHANGE_SUCCESS', payload: { model: { id: 'model', provider: 'provider' } } });
  assert.equal(state.sessionId, 'session-a');
  assert.equal(state.sessionStats?.contextUsage?.tokens, 1200);
});
