import assert from 'node:assert/strict';
import test from 'node:test';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import type { SessionRuntimeStatus } from '@core/types/sessions';

function initialState() {
  return {
    ...INITIAL_STATE,
    sessionId: 'a',
    sessionFile: '/a.jsonl',
    sessions: [
      { id: 'a', path: '/a.jsonl', firstMessage: 'A', messageCount: 1, isActive: true },
      { id: 'b', path: '/b.jsonl', firstMessage: 'B', messageCount: 1, isActive: false },
    ],
  };
}

for (const status of ['working', 'waiting', 'completed'] as SessionRuntimeStatus[]) {
  test(`session badges: ${status} is acknowledged by switching and only fresh activity restores it`, () => {
    let state = chatReducer(initialState(), {
      type: 'UPDATE_SESSION_STATUS', payload: { sessionId: 'b', status },
    });
    assert.equal(state.sessions[1].status, status);
    state = chatReducer(state, {
      type: 'SWITCH_SESSION_SUCCESS',
      payload: { sessionId: 'b', sessionFile: '/b.jsonl', messages: [] },
    });
    assert.equal(state.sessions[1].status, undefined);
    state = chatReducer(state, {
      type: 'SWITCH_SESSION_SUCCESS',
      payload: { sessionId: 'a', sessionFile: '/a.jsonl', messages: [] },
    });
    assert.equal(state.sessions[1].status, undefined);
    state = chatReducer(state, {
      type: 'UPDATE_SESSION_STATUS', payload: { sessionPath: '/b.jsonl', status },
    });
    assert.equal(state.sessions[1].status, status);
  });

  test(`session badges: ${status} is suppressed for the active session by id or path`, () => {
    for (const identity of [{ sessionId: 'a' }, { sessionPath: '/a.jsonl' }]) {
      const state = chatReducer(initialState(), {
        type: 'UPDATE_SESSION_STATUS', payload: { ...identity, status },
      });
      assert.equal(state.sessions[0].status, undefined);
    }
  });
}

test('session badges: refreshing the list preserves unseen background activity and clears active badges', () => {
  let state = chatReducer(initialState(), {
    type: 'UPDATE_SESSION_STATUS', payload: { sessionId: 'b', status: 'waiting' },
  });
  state = chatReducer(state, {
    type: 'LOAD_SESSIONS_SUCCESS', payload: { sessions: initialState().sessions },
  });
  assert.equal(state.sessions[1].status, 'waiting');
  assert.equal(state.sessions[0].status, undefined);
});
