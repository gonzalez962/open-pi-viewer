import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_STATE, chatReducer } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';
import { deriveAgentWorkingStatus } from '@features/chat/agent-working-status';
import { planPromptDispatch } from '@features/chat/hooks/usePromptState';
import { getProjectStatusClass } from '@features/projects/ProjectDock';
import * as projects from '@features/projects/projects';

function harness() {
  let state: typeof INITIAL_STATE = { ...INITIAL_STATE, connectionStatus: 'connected', isHydrated: true, sessionId: 'a', sessionFile: '/repo/a', sessions: [
    { id: 'a', path: '/repo/a', firstMessage: '', messageCount: 0, isActive: true },
    { id: 'b', path: '/repo/b', firstMessage: '', messageCount: 0, isActive: false },
  ] };
  const dispatch = (action: any) => { state = chatReducer(state, action); }; 
  const selectSession = (id: string) => dispatch({ type: 'SESSION_READY', payload: { sessionId: id, sessionFile: `/repo/${id}`, messages: [], activity: 'idle' } });
  const notifications: string[] = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/repo' }),
    getCurrentSessionId: () => state.sessionId,
    dispatch,
    notifyAppEventFn: event => { notifications.push(event.eventType); },
    checkPersistenceFn: async () => ({ sessionId: 'a', sessionFile: '/repo/a', canonicalCwd: '/repo', generation: 1, messageCount: 0, fileExists: false }),
    dialogAdapter: { select: () => new Promise(() => {}), input: () => new Promise(() => {}), confirm: () => new Promise(() => {}) },
  });
  const emit = (event: Record<string, unknown>) => controller.handleEvent({ cwd: '/repo', sessionId: 'a', ...event } as any);
  const start = (id: string, sessionId = 'a', toolName = 'bash_background') => emit({ type: 'tool_execution_end', sessionId, toolCallId: `start-${id}`, toolName, result: { details: { gentleJobs: { id } } } });
  const stop = (id: string, sessionId = 'a') => emit({ type: 'tool_execution_end', sessionId, toolCallId: `stop-${id}`, toolName: 'job_stop', result: { details: { gentleJobs: { id } } } });
  const notice = (id: string, sessionId = 'a') => emit({ type: 'message_end', sessionId, message: { role: 'custom', customType: 'gentle-jobs.notice', details: { gentleJobs: { id } }, content: '' } });
  const working = () => deriveAgentWorkingStatus(state).isWorking;
  return { controller, dispatch, selectSession, emit, start, stop, notice, working, notifications, get state() { return state; } };
}

test('S2.1 successful background start survives settlement without streaming or disabling prompts', () => {
  const h = harness();
  h.emit({ type: 'message_start', message: { role: 'assistant', content: '' } });
  h.start('one');
  h.emit({ type: 'agent_settled' });
  assert.equal(h.state.agentActivity, 'idle');
  assert.equal(h.state.isHydrated, true);
  assert.equal(h.state.connectionStatus, 'connected');
  assert.deepEqual(h.notifications, ['task_complete']);
  assert.deepEqual(planPromptDispatch({ prompt: 'next prompt', hasAttachments: false, isReadyToSend: h.state.connectionStatus === 'connected' && h.state.isHydrated && h.state.agentActivity !== 'busy' && !h.state.isResetting, canQueue: false }), { action: 'send_prompt' });
  assert.equal(h.working(), true, 'job contributes to visible working status');
  h.notice('one');
  assert.equal(h.working(), false);
});

test('S2.2 stop and exit remove only their own job and session contribution', () => {
  const h = harness();
  h.start('one'); h.start('two'); h.start('other', 'b', 'monitor');
  h.emit({ type: 'agent_settled' });
  h.stop('one');
  assert.equal(h.working(), true, 'other jobs remain active');
  h.notice('two');
  assert.equal(h.working(), true, 'another session remains active');
  h.stop('other', 'b');
  assert.equal(h.working(), false);
  h.emit({ type: 'message_start', message: { role: 'assistant', content: '' } });
  h.start('last'); h.stop('last');
  assert.equal(h.working(), true, 'ongoing agent work remains active');
  h.emit({ type: 'agent_settled' });
  assert.equal(h.working(), false);
});

test('S2.3 switching selected session retains background project work', () => {
  const h = harness();
  h.start('one');
  h.emit({ type: 'agent_settled' });
  h.emit({ type: 'runtime_snapshot', sessionId: 'a', sessionFile: '/repo/a', activity: 'idle', messages: [], activeJobs: ['one'] });
  h.selectSession('b');
  assert.equal(h.state.sessionId, 'b');
  h.controller.handleEvent({ type: 'runtime_snapshot', cwd: '/repo', sessionId: 'b', sessionFile: '/repo/b', activity: 'idle', messages: [], activeJobs: [] } as any);
  const getProjectActivity = (projects as any).getProjectActivity;
  assert.equal(typeof getProjectActivity, 'function', 'project activity must be derived from project state');
  const status = getProjectActivity(h.state);
  assert.equal(getProjectStatusClass(true, status.connectionState, status.agentActivity, status.isBusy), 'status-busy');
  h.notice('one');
  const idleStatus = getProjectActivity(h.state);
  assert.equal(getProjectStatusClass(true, idleStatus.connectionState, idleStatus.agentActivity, idleStatus.isBusy), 'status-ready');
});

test('S2.4 waiting and ordinary work survive while disconnect clears jobs', () => {
  const h = harness();
  h.start('one');
  h.emit({ type: 'agent_settled' });
  assert.equal(h.working(), true);
  h.emit({ type: 'extension_ui_request', id: 'confirm', method: 'confirm' });
  assert.equal(h.notifications.includes('waiting_input'), true);
  h.start('other', 'b');
  h.emit({ type: 'extension_ui_request', sessionId: 'b', sessionFile: '/repo/b', id: 'other-confirm', method: 'confirm' });
  assert.equal(h.state.sessions.find(session => session.id === 'b')?.status, 'waiting', 'pending input takes precedence over job activity');
  h.controller.handleStatusChange({ state: 'disconnected', cwd: '/repo', sessionId: 'a', label: 'Disconnected' });
  assert.equal(h.state.connectionStatus, 'disconnected');
  assert.equal(h.working(), false);
  h.controller.handleStatusChange({ state: 'connected', cwd: '/repo', sessionId: 'a', label: 'Connected' });
  assert.equal(h.working(), false, 'reconnect must not resurrect stale jobs');
  h.emit({ type: 'message_start', message: { role: 'assistant', content: '' } });
  assert.equal(h.working(), true);
  h.emit({ type: 'agent_settled' });
  assert.equal(h.working(), false);
});

test('S3.1 structured and text evidence tracks valid starts, stops and completion only', () => {
  const h = harness();
  h.emit({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'bash_background', isError: true, result: { details: { gentleJobs: { id: 'bad' } } } });
  h.emit({ type: 'tool_execution_end', toolCallId: 'malformed', toolName: 'monitor', result: { details: { gentleJobs: { id: '' } } } });
  assert.equal(h.working(), false);
  h.emit({ type: 'tool_execution_end', toolCallId: 'text', toolName: 'monitor', result: { content: [{ type: 'text', text: 'Started monitor "watch" (job-2)' }] } });
  assert.equal(h.working(), true, 'reference text start is recognized');
  h.emit({ type: 'message_end', message: { role: 'custom', customType: 'gentle-jobs.notice', content: 'Background job "watch" (job-2) exited' } });
  assert.equal(h.working(), false);
  h.start('structured');
  assert.equal(h.working(), true);
  h.emit({ type: 'tool_execution_end', toolCallId: 'stop-text', toolName: 'job_stop', result: { content: [{ type: 'text', text: 'Stopped (structured)' }] } });
  assert.equal(h.working(), false);
});
