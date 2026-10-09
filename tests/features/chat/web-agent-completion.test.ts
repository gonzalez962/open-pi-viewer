import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventController } from '@features/chat/session-events';
import { INITIAL_STATE, type ChatAction } from '@core/reducer';
import { multiProjectChatReducer, type MultiProjectChatState } from '@core/reducer/multi-project';
import { getProjectStatusClass } from '@features/projects/ProjectDock';

function fixture() {
  let state: MultiProjectChatState = {
    activeProjectId: 'a',
    projects: {
      a: { ...INITIAL_STATE, connectionStatus: 'connected', sessionId: 'session-a', agentActivity: 'busy' },
      b: { ...INITIAL_STATE, connectionStatus: 'connected', sessionId: 'session-b', agentActivity: 'busy' },
    },
  };
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: '/a' }),
    getCurrentSessionId: () => state.projects.a.sessionId,
    getProjectSessionId: (id: string) => state.projects[id]?.sessionId ?? null,
    resolveTargetProjectId: (cwd?: string) => cwd === '/b' ? 'b' : 'a',
    dispatch: (action: ChatAction & { targetProjectId?: string }) => { state = multiProjectChatReducer(state, action); },
    refreshSessionStatsFn: async () => null,
    checkPersistenceFn: async () => ({ persisted: false, sessionId: null, sessionFile: null }),
    notifyAppEventFn: () => {},
  } as any);
  return { controller, state: () => state };
}

test('web settled event stops background project pulse without settling the active project', () => {
  const f = fixture();
  f.controller.handleEvent({ type: 'agent_settled', cwd: '/b', sessionId: 'session-b' });
  const state = f.state();
  assert.equal(state.projects.b.agentActivity, 'idle');
  assert.equal(getProjectStatusClass(false, state.projects.b.connectionStatus, state.projects.b.agentActivity, false), 'status-ready');
  assert.equal(state.projects.a.agentActivity, 'busy');
});

test('stale same-project settled event and retry end do not clear active work', () => {
  const f = fixture();
  f.controller.handleEvent({ type: 'agent_settled', cwd: '/b', sessionId: 'old-session-b' });
  assert.equal(f.state().projects.b.agentActivity, 'busy');
  f.controller.handleEvent({ type: 'agent_end', cwd: '/b', sessionId: 'session-b', willRetry: true });
  assert.equal(f.state().projects.b.agentActivity, 'busy');
});

test('old session process exit does not disconnect a replacement session in the same project', () => {
  const f = fixture();
  f.controller.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: 'Exited', cwd: '/b', sessionId: 'old-session-b' } as any);
  assert.equal(f.state().projects.b.agentActivity, 'busy');
  assert.equal(f.state().projects.b.connectionStatus, 'connected');
});
