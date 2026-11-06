import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_STATE, chatReducer } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';
import { deriveAgentWorkingStatus, getSelectedSessionJobCount } from '@features/chat/agent-working-status';
import { planPromptDispatch } from '@features/chat/hooks/usePromptState';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSubagentSnapshot } from '@core/agent-activity';
import { ProjectDock, getProjectStatusClass } from '@features/projects/ProjectDock';
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

test('project sidebar reflects live subagents after the main agent settles, including background projects', () => {
  const idle = { ...INITIAL_STATE, connectionStatus: 'connected' as const, agentActivity: 'idle' as const };
  const project = (id: string) => ({ id, path: `/repo/${id}`, createdAt: '', lastOpenedAt: '' });
  for (const status of ['running', 'queued', 'waiting', 'completed', 'failed', 'cancelled']) {
    const subagents = parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'worker-1', agent: 'worker', status } }] });
    assert.ok(subagents);
    const live = ['running', 'queued', 'waiting'].includes(status);
    const state = { ...idle, subagents };
    const activity = projects.getProjectActivity(state);
    assert.equal(activity.isBusy, live, status);
    for (const activeProjectId of ['foreground', 'background']) {
      const markup = renderToStaticMarkup(React.createElement(ProjectDock, {
        projects: [project('foreground'), project('background')], activeProjectId,
        connectionState: 'connected', agentActivity: 'idle', isBusy: false, locale: 'es',
        projectStatusMap: { foreground: projects.getProjectActivity(idle), background: activity },
        onSelectProject: () => {}, onRenameProject: () => {}, onRemoveProject: () => {},
      }));
      assert.equal((markup.match(/project-status-dot status-busy/g) ?? []).length, live ? 1 : 0, `${status}: only the working project is busy`);
      assert.equal((markup.match(/project-status-dot status-ready/g) ?? []).length, live ? 1 : 2);
      assert.equal(markup.includes('class="project-status-text">Agente trabajando...</span>'), live);
      assert.ok(markup.includes('class="project-status-text">Listo</span>'));
    }
    assert.equal(projects.getProjectActivity({ ...state, connectionStatus: 'disconnected' }).isBusy, false, `${status}: disconnected telemetry is not live`);
  }
  assert.equal(projects.getProjectActivity({ ...idle, agentActivity: 'busy' }).isBusy, true, 'main agent activity still counts');
});

for (const settleFirst of [true, false]) {
  test(`S1.2 jobs and children: ${settleFirst ? 'settlement first' : 'activity first'}, duplicates notify once`, () => {
    const h = harness();
    const widget = (status: string) => h.emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', status } }] })] });
    h.emit({ type: 'agent_start' });
    h.start('job');
    widget('running');
    if (settleFirst) h.emit({ type: 'agent_settled' });
    h.stop('job');
    h.stop('job');
    assert.deepEqual(h.notifications, []);
    widget('completed');
    if (!settleFirst) {
      assert.deepEqual(h.notifications, []);
      h.emit({ type: 'agent_settled' });
    }
    h.emit({ type: 'agent_settled' });
    widget('completed');
    assert.deepEqual(h.notifications, ['task_complete']);
  });
}

for (const invalidation of ['new turn', 'cancel', 'disconnect', 'exit', 'replacement']) {
  test(`S1.4 invalid snapshot and ${invalidation} never release stale success`, () => {
    const h = harness();
    const widget = (value: unknown) => h.emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify(value)] });
    h.emit({ type: 'agent_start' });
    widget({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'child', agent: 'worker', status: 'running' } }] });
    h.emit({ type: 'agent_settled' });
    widget({ schema: 'gentle-agents.activity/v1', tasks: null });
    assert.deepEqual(h.notifications, [], invalidation);
    if (invalidation === 'new turn') h.emit({ type: 'agent_start' });
    if (invalidation === 'cancel') {
      h.emit({ type: 'agent_start' });
      h.emit({ type: 'message_end', message: { role: 'assistant', content: 'Cancelled', stopReason: 'aborted' } });
      h.emit({ type: 'agent_settled' });
    }
    if (invalidation === 'disconnect' || invalidation === 'exit') h.controller.handleStatusChange({ state: invalidation === 'exit' ? 'error' : 'disconnected', cwd: '/repo', sessionId: 'a', label: 'Closed', detail: '' });
    if (invalidation === 'replacement') h.emit({ type: 'runtime_snapshot', sessionId: 'a', sessionFile: '/repo/replacement', activity: 'idle', messages: [], activeJobs: [] });
    widget({ schema: 'gentle-agents.activity/v1', tasks: [] });
    assert.deepEqual(h.notifications, [], invalidation);
  });
}

test('job counts follow starts, session switches, completion and stop', () => {
  const h = harness();
  const counts = () => [projects.getProjectActivity(h.state).jobCount, getSelectedSessionJobCount(h.state)];
  assert.deepEqual(counts(), [0, 0]);
  h.start('one'); h.start('two'); h.start('other', 'b');
  assert.deepEqual(counts(), [3, 2]);
  h.selectSession('b');
  assert.deepEqual(counts(), [3, 1]);
  h.notice('one');
  assert.deepEqual(counts(), [2, 1]);
  h.stop('other', 'b');
  assert.deepEqual(counts(), [1, 0]);
  h.selectSession('a');
  assert.deepEqual(counts(), [1, 1]);
  h.stop('two');
  assert.deepEqual(counts(), [0, 0]);
});

test('S2.1 successful background start survives settlement without streaming or disabling prompts', () => {
  const h = harness();
  h.emit({ type: 'message_start', message: { role: 'assistant', content: '' } });
  h.start('one');
  h.emit({ type: 'agent_settled' });
  assert.equal(h.state.agentActivity, 'idle');
  assert.equal(h.state.isHydrated, true);
  assert.equal(h.state.connectionStatus, 'connected');
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(planPromptDispatch({ prompt: 'next prompt', hasAttachments: false, isReadyToSend: h.state.connectionStatus === 'connected' && h.state.isHydrated && !Boolean(h.state.agentActivity === ('busy' as string)) && !h.state.isResetting, canQueue: false }), { action: 'send_prompt' });
  assert.equal(h.working(), true, 'job contributes to visible working status');
  h.notice('one');
  assert.equal(h.working(), false);
  assert.deepEqual(h.notifications, ['task_complete']);
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
  h.controller.handleStatusChange({ state: 'disconnected', cwd: '/repo', sessionId: 'a', label: 'Disconnected', detail: '' });
  assert.equal(h.state.connectionStatus, 'disconnected');
  const project = projects.getProjectActivity(h.state);
  assert.equal(getProjectStatusClass(true, project.connectionState, project.agentActivity, Boolean(project.isBusy)), 'status-busy');
  assert.equal(h.working(), false);
  h.controller.handleStatusChange({ state: 'connected', cwd: '/repo', sessionId: 'a', label: 'Connected', detail: '' });
  assert.equal(h.working(), true, 'live sibling session remains active');
  h.controller.handleStatusChange({ state: 'disconnected', cwd: '/repo', sessionId: 'b', label: 'Disconnected', detail: '' });
  assert.equal(h.working(), false, 'disconnected sessions do not leave stale jobs');
  h.emit({ type: 'message_start', message: { role: 'assistant', content: '' } });
  assert.equal(h.working(), true);
  h.emit({ type: 'agent_settled' });
  assert.equal(h.working(), false);
});

test('real producer job notices distinguish monitor batches from terminal outcomes', () => {
  for (const status of ['exited', 'failed', 'stopped']) {
    const h = harness();
    h.emit({ type: 'tool_execution_end', toolCallId: 'start', toolName: 'bash_background', result: { content: [{ type: 'text', text: 'Started background job j1 ("build").' }], details: { gentleJobs: { jobId: 'j1', kind: 'background', status: 'running' } } } });
    h.emit({ type: 'agent_settled' });
    assert.equal(h.working(), true);
    h.emit({ type: 'message_end', message: { role: 'custom', customType: 'gentle-jobs.notice', content: 'Background job j1 ("build") exited with code 0.', details: { gentleJobs: { jobId: 'j1', kind: 'background', status } } } });
    assert.equal(h.working(), false, status);
  }
  for (const event of ['events', 'timeout', 'flood']) {
    const h = harness();
    h.emit({ type: 'tool_execution_end', toolCallId: 'start', toolName: 'monitor', result: { details: { gentleJobs: { jobId: 'm1', kind: 'monitor', status: 'running' } } } });
    h.emit({ type: 'agent_settled' });
    assert.equal(h.working(), true);
    h.emit({ type: 'message_end', message: { role: 'custom', customType: 'gentle-jobs.notice', content: 'Monitor m1 ("watch") reported 1 new line:', details: { gentleJobs: { jobId: 'm1', kind: 'monitor', status: event === 'events' ? 'running' : 'stopped', event } } } });
    assert.equal(h.working(), event === 'events', event);
  }
});

test('real completion text without details accepts label after id', () => {
  const h = harness();
  h.emit({ type: 'tool_execution_end', toolCallId: 'start', toolName: 'bash_background', result: { content: [{ type: 'text', text: 'Started background job j1 ("build").' }] } });
  h.emit({ type: 'agent_settled' });
  assert.equal(h.working(), true);
  h.emit({ type: 'message_end', message: { role: 'custom', customType: 'gentle-jobs.notice', content: 'Background job j1 ("build") exited with code 0.' } });
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
