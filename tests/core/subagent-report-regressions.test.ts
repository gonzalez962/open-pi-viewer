import assert from 'node:assert/strict';
import test from 'node:test';
import { getSubagentDetails } from '@core/agent-activity';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import { hydrateChatMessages } from '@core/session';
import { SessionEventController } from '@features/chat/session-events';

const sessionId = 'parent';
const taskId = 'child';
const cwd = '/project';

function report(model: string, status: 'running' | 'completed') {
  return { details: { gentleAgents: { taskId, agent: 'worker', status, model } } };
}

function completion(model: string) {
  return { role: 'custom', customType: 'gentle-agents.result', ...report(model, 'completed') };
}

function viewer() {
  let state = INITIAL_STATE;
  const events = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: 'pi', workingDirectory: cwd }),
    getCurrentSessionId: () => sessionId,
    dispatch: action => { state = chatReducer(state, action); },
  });
  return {
    ready(sessionFile: string, messages: unknown[] = []) {
      events.handleEvent({ type: 'runtime_snapshot', cwd, sessionId, sessionFile, messages });
    },
    disconnect(sessionFile: string) {
      events.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: '', cwd, sessionId, sessionFile });
    },
    widget(sessionFile: string) {
      events.handleEvent({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', cwd, sessionId, sessionFile,
        widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: taskId, agent: 'worker', status: 'running' } }] })] });
    },
    live(sessionFile: string, model: string) {
      events.handleEvent({ type: 'tool_execution_end', toolName: 'subagent_status', toolCallId: 'call', cwd, sessionId, sessionFile, result: report(model, 'running') });
    },
    details: () => getSubagentDetails(state),
    transcript: () => state.messages,
  };
}

test('S1.1 reattaching a different file with the same parent and task IDs does not inherit the old model', () => {
  const ui = viewer();
  ui.ready('/a.jsonl');
  ui.widget('/a.jsonl');
  ui.live('/a.jsonl', 'provider/old');
  assert.equal(ui.details()[0]?.reportedModel, 'provider/old');
  ui.disconnect('/a.jsonl');
  ui.ready('/b.jsonl');
  ui.widget('/b.jsonl');
  assert.deepEqual(ui.details().map(task => [task.id, task.reportedModel]), [[taskId, undefined]]);
});

test('S1.2 replacement history takes precedence over an earlier live report for the same owner', () => {
  const ui = viewer();
  ui.ready('/a.jsonl');
  ui.widget('/a.jsonl');
  ui.live('/a.jsonl', 'provider/old');
  assert.equal(ui.details()[0]?.reportedModel, 'provider/old');
  const visible = [{ role: 'user', id: 'prompt', content: 'Delegate work', timestamp: 1 }];
  ui.ready('/a.jsonl', [...visible, completion('provider/new')]);
  assert.equal(ui.details()[0]?.status, 'completed');
  assert.equal(ui.details()[0]?.reportedModel, 'provider/new');
  ui.live('/a.jsonl', 'default');
  assert.equal(ui.details()[0]?.reportedModel, 'provider/new');
  ui.live('/a.jsonl', 'provider/newest');
  assert.equal(ui.details()[0]?.reportedModel, 'provider/newest');
  assert.deepEqual(ui.transcript().map(({ id, role, content }) => ({ id, role, content })), visible.map(({ id, role, content }) => ({ id, role, content })));
});

test('S1.3 a sole custom result exposes a completed detail without adding a transcript item', () => {
  const ui = viewer();
  const raw = [completion('provider/persisted')];
  assert.deepEqual([...hydrateChatMessages(raw)], []);
  ui.ready('/a.jsonl', raw);
  assert.equal(ui.transcript().length, 0);
  assert.deepEqual(ui.details().map(task => [task.id, task.status, task.reportedModel]), [[taskId, 'completed', 'provider/persisted']]);
});
