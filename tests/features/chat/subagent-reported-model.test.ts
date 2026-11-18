import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSubagentDetails } from '@core/agent-activity';
import { chatReducer, INITIAL_STATE, type ChatSessionState } from '@core/reducer';
import { hydrateChatMessages } from '@core/session';
import { deriveAgentWorkingStatus } from '@features/chat/agent-working-status';
import { SessionEventController } from '@features/chat/session-events';
import { SubagentActivityModal } from '@features/chat/SubagentActivityModal';
import { createSubagentActivityController, SubagentActivityEntry } from '@features/chat/subagent-activity-modal';
import { translate } from '@shared/i18n';

const cwd = '/project';
const taskId = 't_shared';
const label = 'Inspect source';
const agent = 'explore';
const parentModel = { provider: 'test', id: 'parent-only-model' };
const t: React.ComponentProps<typeof SubagentActivityModal>['t'] = (key, params) => translate('en', key, params);

function result({ id = taskId, model, status = 'running', mode = 'background', title = label }: {
  id?: string; model?: string; status?: 'running' | 'completed'; mode?: 'background' | 'task'; title?: string;
}) {
  return {
    content: [{ type: 'text', text: 'Subagent task report' }],
    details: { gentleAgents: { taskId: id, agent, label: title, status, mode, ...(model === undefined ? {} : { model }) } },
  };
}

function viewer() {
  let state: ChatSessionState = INITIAL_STATE;
  let current = 'parent-a';
  let open = false;
  let callNumber = 0;
  const events = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: cwd }),
    getCurrentSessionId: () => current,
    dispatch: action => { state = chatReducer(state, action); },
  });
  const details = () => getSubagentDetails(state);
  const activity = createSubagentActivityController({
    getTasks: details,
    getActiveElement: () => null,
    getOtherDialogOpen: () => false,
    setOpen: value => { open = value; },
  });
  const selectSession = (sessionId: string, messages: unknown[] = []) => {
    activity.close(false);
    current = sessionId;
    const owner = { cwd, sessionId: current, sessionFile: `${cwd}/${current}.jsonl` };
    events.handleStatusChange({ state: 'connected', label: 'Connected', detail: '', model: parentModel, ...owner });
    events.handleEvent({ type: 'runtime_snapshot', ...owner, messages, activity: 'idle' });
  };
  selectSession(current);
  return {
    selectSession,
    switchToHistory(sessionId: string, messages: unknown[]) {
      activity.close(false);
      current = sessionId;
      state = chatReducer(state, { type: 'SWITCH_SESSION_SUCCESS', payload: { sessionId, sessionFile: `${cwd}/${sessionId}.jsonl`, messages: hydrateChatMessages(messages) } });
    },
    isWorking: () => deriveAgentWorkingStatus(state).isWorking,
    widget(status?: 'running' | 'completed') {
      const tasks = status ? [{ summary: { id: taskId, agent, label, status } }] : [];
      events.handleEvent({
        type: 'extension_ui_request', id: 'widget', method: 'setWidget', widgetKey: 'gentle-agents',
        cwd, sessionId: current, widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks })],
      });
    },
    report(value: unknown, toolName = 'subagent_status', sessionId: string | null = current, isError = false) {
      const owner = { cwd, sessionId, sessionFile: `${cwd}/${sessionId}.jsonl` };
      const toolCallId = `call-${++callNumber}`;
      events.handleEvent({ type: 'tool_execution_start', ...owner, toolName, toolCallId });
      events.handleEvent({ type: 'tool_execution_end', ...owner, toolName, toolCallId, result: value, isError });
    },
    settle() {
      events.handleEvent({ type: 'agent_end', cwd, sessionId: current });
    },
    openDetail() {
      activity.close(false);
      const entry = { tasks: details(), onClick: activity.onClick, t };
      assert.match(renderToStaticMarkup(React.createElement(SubagentActivityEntry, entry)), /<button\b/, 'subagent entry must remain visible');
      entry.onClick();
      assert.equal(open, true, 'subagent entry opens the detail dialog');
      const html = renderToStaticMarkup(React.createElement(SubagentActivityModal, {
        tasks: entry.tasks, selectedId: taskId, onSelect: () => {}, onClose: () => activity.close(), t,
      }));
      assert.match(html, /role="dialog"/);
      assert.match(html, /<h3>Inspect source<\/h3>/);
      return html;
    },
  };
}

test('S1.1 modal shows the reported model for the selected task in its parent session only', () => {
  const ui = viewer();
  // Both sessions have the same task ID, and another task reports in parent A.
  ui.selectSession('parent-b');
  ui.widget('running');
  ui.report(result({ model: 'test/other-session-model' }), 'subagent_run');
  ui.selectSession('parent-a');
  ui.widget('running');
  ui.report(result({ model: 'test/selected-child-model' }), 'subagent_run');
  ui.report(result({ id: 't_sibling', model: 'test/sibling-task-model', title: 'Inspect tests' }));
  const html = ui.openDetail();
  assert.doesNotMatch(html, /parent-only-model|other-session-model|sibling-task-model|live model|current model/i);
  assert.match(html, /test\/selected-child-model/, 'show Pi’s structured report, not the parent or another task’s model');
  assert.match(html, /reported model|model (?:last )?reported/i, 'label the model as reported rather than live');
});

test('S1.1 a sister session’s same-ID report does not supply a model to an unreported task', () => {
  const ui = viewer();
  ui.widget('running');
  ui.report(result({ model: 'test/other-session-model' }), 'subagent_run', 'parent-b');
  ui.report(result({ id: 't_sibling', model: 'test/sibling-task-model', title: 'Inspect tests' }));
  assert.doesNotMatch(ui.openDetail(), /other-session-model|sibling-task-model|parent-only-model/);
  ui.selectSession('parent-b');
  ui.widget('running');
  assert.match(ui.openDetail(), /test\/other-session-model/);
});

test('S1.1 unowned and unsuccessful reports, unrelated tool data, and prose are not attribution', () => {
  const ui = viewer();
  ui.widget('running');
  ui.report(result({ model: 'test/unowned-model' }), 'subagent_status', null);
  ui.report(result({ model: 'test/failed-model' }), 'subagent_status', 'parent-a', true);
  ui.report(result({ model: 'test/unrelated-model' }), 'read');
  ui.report({ content: [{ type: 'text', text: `Task ${taskId} model is test/prose-model` }] });
  assert.doesNotMatch(ui.openDetail(), /Last reported model|unowned-model|failed-model|unrelated-model|prose-model|parent-only-model/);
});

test('S1.2 reopening the modal reflects the newest concrete Pi report', () => {
  const ui = viewer();
  ui.widget('running');
  ui.report(result({ model: 'test/first-report' }), 'subagent_run');
  const first = ui.openDetail();
  ui.report(result({ model: 'test/newest-report' }));
  const latest = ui.openDetail();
  assert.doesNotMatch(latest, /first-report/);
  assert.match(latest, /test\/newest-report/, 'show the newer report on reopen');
  assert.match(first, /test\/first-report/, 'the first view showed the report available then');
});

for (const model of [undefined, 'default']) {
  test(`S1.2 ${model ?? 'missing'} model is not concrete and does not erase the last concrete report`, () => {
    const ui = viewer();
    ui.widget('running');
    ui.report(result({ model }), 'subagent_run');
    assert.doesNotMatch(ui.openDetail(), /\bdefault\b|parent-only-model/i);
    ui.report(result({ model: 'test/last-concrete-model' }));
    ui.report(result({ model }));
    const html = ui.openDetail();
    assert.doesNotMatch(html, /\bdefault\b|parent-only-model/i);
    assert.match(html, /test\/last-concrete-model/, 'keep the last concrete Pi report');
  });
}

test('S1.3 a fresh runtime reattach recovers a finished foreground task’s model from loaded Pi history', () => {
  const ui = viewer();
  const saved = result({ model: 'test/persisted-child-model', status: 'completed', mode: 'task' });
  ui.selectSession('reopened-parent', [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'persisted-call', name: 'subagent_run', arguments: { agent, task: label, mode: 'task' } }] },
    { role: 'toolResult', toolCallId: 'persisted-call', toolName: 'subagent_run', ...saved, isError: false },
  ]);
  const html = ui.openDetail();
  assert.match(html, /completed/i);
  assert.match(html, /test\/persisted-child-model/, 'recover the structured model without a live report or widget');
});

test('S1.3 switching to loaded history recovers a persisted background completion', () => {
  const ui = viewer();
  const saved = result({ model: 'test/persisted-background-model', status: 'completed' });
  ui.switchToHistory('closed-parent', [
    { role: 'user', content: 'Delegate work' },
    { role: 'custom', customType: 'gentle-agents.result', ...saved },
  ]);
  const html = ui.openDetail();
  assert.match(html, /completed/i);
  assert.match(html, /test\/persisted-background-model/);
});

test('S1.3 live foreground completion keeps its modal entry and reported model after the widget empties', () => {
  const ui = viewer();
  ui.widget('running');
  assert.doesNotMatch(ui.openDetail(), /foreground-finished-model/);
  ui.widget('completed');
  ui.report(result({ model: 'test/foreground-finished-model', status: 'completed', mode: 'task' }), 'subagent_run');
  ui.widget();
  ui.settle();
  assert.equal(ui.isWorking(), false, 'retained detail must not turn a finished task into live activity');
  const html = ui.openDetail();
  assert.match(html, /completed/i);
  assert.match(html, /test\/foreground-finished-model/);
});
