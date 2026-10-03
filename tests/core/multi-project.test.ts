import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialMultiProjectState,
  getActiveProjectState,
  multiProjectChatReducer,
  INITIAL_STATE,
  type ChatSessionState,
} from '@core/reducer';

test('multi-project reducer: createInitialMultiProjectState initializes with active project', () => {
  // Default with no arguments
  const defaultState = createInitialMultiProjectState();
  assert.strictEqual(defaultState.activeProjectId, null);
  assert.deepEqual(defaultState.projects, {});

  // With initial project id
  const withProject = createInitialMultiProjectState('proj-alpha');
  assert.strictEqual(withProject.activeProjectId, 'proj-alpha');
  assert.deepEqual(withProject.projects['proj-alpha'], INITIAL_STATE);

  // With initial project id and custom initial state
  const customState: ChatSessionState = {
    ...INITIAL_STATE,
    connectionStatus: 'connected',
  };
  const withCustom = createInitialMultiProjectState('proj-custom', customState);
  assert.strictEqual(withCustom.activeProjectId, 'proj-custom');
  assert.strictEqual(withCustom.projects['proj-custom'].connectionStatus, 'connected');
});

test('multi-project reducer: getActiveProjectState returns active project state or INITIAL_STATE fallback', () => {
  // Null activeProjectId
  const emptyState = createInitialMultiProjectState();
  assert.deepEqual(getActiveProjectState(emptyState), INITIAL_STATE);

  // Existing active project
  const customState: ChatSessionState = {
    ...INITIAL_STATE,
    connectionStatus: 'connected',
  };
  const activeState = createInitialMultiProjectState('proj-active', customState);
  assert.deepEqual(getActiveProjectState(activeState), customState);

  // Active project ID set but missing from projects map
  const missingProjectState = {
    activeProjectId: 'proj-missing',
    projects: {},
  };
  assert.deepEqual(getActiveProjectState(missingProjectState), INITIAL_STATE);
});

test('multi-project reducer: SET_ACTIVE_PROJECT switches activeProjectId and initializes empty state if needed', () => {
  let state = createInitialMultiProjectState('proj-1');
  assert.strictEqual(state.activeProjectId, 'proj-1');

  // Switch to a new project: initializes state and updates activeProjectId
  state = multiProjectChatReducer(state, {
    type: 'SET_ACTIVE_PROJECT',
    payload: { projectId: 'proj-2' },
  });
  assert.strictEqual(state.activeProjectId, 'proj-2');
  assert.ok(state.projects['proj-2']);
  assert.deepEqual(state.projects['proj-2'], INITIAL_STATE);

  // Mutate proj-2 state to ensure switching back preserves it
  state = multiProjectChatReducer(state, {
    type: 'CONNECT_START',
  });
  assert.strictEqual(state.projects['proj-2'].connectionStatus, 'connecting');

  // Switch back to proj-1
  state = multiProjectChatReducer(state, {
    type: 'SET_ACTIVE_PROJECT',
    payload: { projectId: 'proj-1' },
  });
  assert.strictEqual(state.activeProjectId, 'proj-1');
  assert.strictEqual(state.projects['proj-2'].connectionStatus, 'connecting');

  // Switching to already active project is idempotent and returns identical reference
  const unchanged = multiProjectChatReducer(state, {
    type: 'SET_ACTIVE_PROJECT',
    payload: { projectId: 'proj-1' },
  });
  assert.strictEqual(unchanged, state);
});

test('multi-project reducer: REMOVE_PROJECT_STATE removes project and clears activeProjectId if it was active', () => {
  let state = createInitialMultiProjectState('proj-1');
  state = multiProjectChatReducer(state, {
    type: 'SET_ACTIVE_PROJECT',
    payload: { projectId: 'proj-2' },
  });
  assert.strictEqual(state.activeProjectId, 'proj-2');

  // Remove inactive project (proj-1)
  state = multiProjectChatReducer(state, {
    type: 'REMOVE_PROJECT_STATE',
    payload: { projectId: 'proj-1' },
  });
  assert.strictEqual(state.projects['proj-1'], undefined);
  assert.strictEqual(state.activeProjectId, 'proj-2');
  assert.ok(state.projects['proj-2']);

  // Remove active project (proj-2)
  state = multiProjectChatReducer(state, {
    type: 'REMOVE_PROJECT_STATE',
    payload: { projectId: 'proj-2' },
  });
  assert.strictEqual(state.projects['proj-2'], undefined);
  assert.strictEqual(state.activeProjectId, null);

  // Removing non-existent project returns unchanged state reference
  const unchanged = multiProjectChatReducer(state, {
    type: 'REMOVE_PROJECT_STATE',
    payload: { projectId: 'proj-nonexistent' },
  });
  assert.strictEqual(unchanged, state);
});

test('multi-project reducer: INIT_PROJECT_STATE initializes or resets project state', () => {
  let state = createInitialMultiProjectState('proj-1');

  // Init with default INITIAL_STATE
  state = multiProjectChatReducer(state, {
    type: 'INIT_PROJECT_STATE',
    payload: { projectId: 'proj-2' },
  });
  assert.deepEqual(state.projects['proj-2'], INITIAL_STATE);

  // Init with custom state
  const customState: ChatSessionState = {
    ...INITIAL_STATE,
    connectionStatus: 'connected',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'hi',
        timestamp: new Date().toISOString(),
      },
    ],
  };
  state = multiProjectChatReducer(state, {
    type: 'INIT_PROJECT_STATE',
    payload: { projectId: 'proj-2', state: customState },
  });
  assert.strictEqual(state.projects['proj-2'].connectionStatus, 'connected');
  assert.strictEqual(state.projects['proj-2'].messages.length, 1);
});

test('multi-project reducer: Routing ChatAction without targetProjectId modifies active project state only, leaving background projects untouched', () => {
  let state = createInitialMultiProjectState('proj-active');
  state = multiProjectChatReducer(state, {
    type: 'INIT_PROJECT_STATE',
    payload: {
      projectId: 'proj-background',
      state: { ...INITIAL_STATE, connectionStatus: 'disconnected' },
    },
  });

  // Dispatch CONNECT_START with no targetProjectId
  state = multiProjectChatReducer(state, {
    type: 'CONNECT_START',
  });

  // Active project was modified
  assert.strictEqual(state.projects['proj-active'].connectionStatus, 'connecting');
  // Background project was untouched
  assert.strictEqual(state.projects['proj-background'].connectionStatus, 'disconnected');

  // When activeProjectId is null and no targetProjectId, action is a no-op
  const nullActiveState = {
    activeProjectId: null,
    projects: { ...state.projects },
  };
  const unrouted = multiProjectChatReducer(nullActiveState, {
    type: 'CONNECT_START',
  });
  assert.strictEqual(unrouted, nullActiveState);
});

test('multi-project reducer: Routing ChatAction with explicit targetProjectId modifies targeted project state only, even when another project is active', () => {
  let state = createInitialMultiProjectState('proj-active');
  state = multiProjectChatReducer(state, {
    type: 'INIT_PROJECT_STATE',
    payload: {
      projectId: 'proj-background',
      state: { ...INITIAL_STATE, connectionStatus: 'disconnected' },
    },
  });

  // Route CONNECT_START targeting proj-background while proj-active is active
  state = multiProjectChatReducer(state, {
    type: 'CONNECT_START',
    targetProjectId: 'proj-background',
  });

  // Active project remained untouched
  assert.strictEqual(state.projects['proj-active'].connectionStatus, 'disconnected');
  // Background targeted project was modified
  assert.strictEqual(state.projects['proj-background'].connectionStatus, 'connecting');

  // Explicit targetProjectId routes properly even if activeProjectId is null
  const nullActiveState = {
    activeProjectId: null,
    projects: { ...state.projects },
  };
  const routedNullActive = multiProjectChatReducer(nullActiveState, {
    type: 'CONNECT_START',
    targetProjectId: 'proj-active',
  });
  assert.strictEqual(routedNullActive.projects['proj-active'].connectionStatus, 'connecting');
});

test('multi-project reducer: unhandled actions return identical state reference', () => {
  const state = createInitialMultiProjectState('proj-1');
  const unchanged = multiProjectChatReducer(state, {
    type: 'NON_EXISTENT_ACTION' as any,
  });
  assert.strictEqual(unchanged, state);
});

test('multi-project reducer: switching active project isolates session lists and never leaks prior project sessions', () => {
  let state = createInitialMultiProjectState('proj-alpha');

  // Load sessions into proj-alpha
  state = multiProjectChatReducer(state, {
    type: 'LOAD_SESSIONS_SUCCESS',
    targetProjectId: 'proj-alpha',
    payload: {
      sessions: [
        { id: 'sess-alpha-1', path: '/path/alpha/sess-1.jsonl', messageCount: 5 } as any,
      ],
    },
  });

  const alphaState = getActiveProjectState(state);
  assert.strictEqual(alphaState.sessions.length, 1);
  assert.strictEqual(alphaState.sessions[0].id, 'sess-alpha-1');

  // Switch to new project proj-beta
  state = multiProjectChatReducer(state, {
    type: 'SET_ACTIVE_PROJECT',
    payload: { projectId: 'proj-beta' },
  });

  // Proj-beta must start with fresh isolated empty session list
  const betaInitialState = getActiveProjectState(state);
  assert.strictEqual(betaInitialState.sessions.length, 0, 'New project must not inherit prior project sessions');

  // Load sessions into proj-beta
  state = multiProjectChatReducer(state, {
    type: 'LOAD_SESSIONS_SUCCESS',
    targetProjectId: 'proj-beta',
    payload: {
      sessions: [
        { id: 'sess-beta-1', path: '/path/beta/sess-1.jsonl', messageCount: 2 } as any,
      ],
    },
  });

  const betaState = getActiveProjectState(state);
  assert.strictEqual(betaState.sessions.length, 1);
  assert.strictEqual(betaState.sessions[0].id, 'sess-beta-1');
  assert.strictEqual(state.projects['proj-alpha'].sessions[0].id, 'sess-alpha-1');

  // Switch back to proj-alpha
  state = multiProjectChatReducer(state, {
    type: 'SET_ACTIVE_PROJECT',
    payload: { projectId: 'proj-alpha' },
  });

  const restoredAlpha = getActiveProjectState(state);
  assert.strictEqual(restoredAlpha.sessions.length, 1);
  assert.strictEqual(restoredAlpha.sessions[0].id, 'sess-alpha-1');
});
