import assert from 'node:assert/strict';
import test from 'node:test';
import { chatReducer, INITIAL_STATE, type ChatSessionState, type ChatAction } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';
import { parseSubagentSnapshot } from '@core/agent-activity';
import { getAgentWorkingStatus, deriveAgentWorkingStatus } from '@features/chat/agent-working-status';
import type { RpcEventBase } from '@core/types/events';

function createConnectedState(sessionId = 'session-1'): ChatSessionState {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: null },
  });
  state = chatReducer(state, {
    type: 'SESSION_READY',
    payload: {
      sessionId,
      sessionFile: `/path/${sessionId}.jsonl`,
      messages: [],
      activity: 'idle',
    },
  });
  return state;
}

function createBusyState(sessionId = 'session-1', prompt = 'Investigate issue'): ChatSessionState {
  const connected = createConnectedState(sessionId);
  return chatReducer(connected, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: prompt },
  });
}

test('S3.1 current-session gentle-agents.activity/v1 setWidget snapshot updates target project indicator without opening a dialog', () => {
  let state = createConnectedState('session-1');
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];
  let dialogOpened = false;
  const mockDialogAdapter = {
    select: async () => { dialogOpened = true; return null; },
    input: async () => { dialogOpened = true; return null; },
    confirm: async () => { dialogOpened = true; return null; },
    cancelPending: () => {},
  };
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/path/pi.js', piPath: 'pi', model: 'default', thinkingLevel: 'low', workingDirectory: '/path/project-1' }),
    getCurrentSessionId: () => 'session-1',
    resolveTargetProjectId: (cwd?: string) => (cwd === '/path/project-1' ? 'proj-1' : undefined),
    dispatch: (action) => { dispatched.push(action); state = chatReducer(state, action); },
    dialogAdapter: mockDialogAdapter,
  });
  const widgetPayload = { schema: 'gentle-agents.activity/v1', summary: { running: 1, queued: 0, waiting: 0, finished: 0 }, tasks: [{ summary: { id: 't_abc123', agent: 'explore', label: 'Map the auth module', status: 'running', lastStep: 'reading lib/auth.ts' } }] };
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-req-1', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify(widgetPayload)], sessionId: 'session-1', cwd: '/path/project-1' } as unknown as RpcEventBase);
  assert.equal(dialogOpened, false, 'setWidget must not open an extension UI dialog');
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading lib/auth.ts');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Trabajando - Explore: reading lib/auth.ts');
  const detailed = deriveAgentWorkingStatus(state, 'en');
  assert.equal(detailed.isWorking, true);
});

test('S3.2 queued, running or waiting subagents continue after main agent settles, prioritize waiting, and clear on terminal snapshot', () => {
  let state = createConnectedState('session-1');
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/path/pi.js', piPath: 'pi', model: 'default', thinkingLevel: 'low', workingDirectory: '/path/project-1' }),
    getCurrentSessionId: () => 'session-1',
    dispatch: (action) => { dispatched.push(action); state = chatReducer(state, action); },
  });
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-1', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 't1', agent: 'worker', status: 'running', lastStep: 'editing src/app.ts' } }] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  controller.handleEvent({ type: 'agent_settled', sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(state.agentActivity, 'idle');
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Worker: editing src/app.ts');
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-2', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 't1', agent: 'worker', status: 'waiting', lastStep: 'asked confirmation' } }, { summary: { id: 't2', agent: 'explore', status: 'running', lastStep: 'scanning files' } }] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Worker: waiting for response');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Worker: esperando respuesta');
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-3', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 't1', agent: 'worker', status: 'completed' } }] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), null);
});

test('S3.3 malformed, unrelated or stale-session widget data does not corrupt activity or mark session waiting, and disconnect resets', () => {
  let state = createConnectedState('session-1');
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/path/pi.js', piPath: 'pi', model: 'default', thinkingLevel: 'low', workingDirectory: '/path/project-1' }),
    getCurrentSessionId: () => 'session-1',
    dispatch: (action) => { dispatched.push(action); state = chatReducer(state, action); },
  });
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-ok', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 't1', agent: 'explore', status: 'running', lastStep: 'reading' } }] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-bad', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: ['{ invalid json...'], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-other', method: 'setWidget', widgetKey: 'unrelated-widget', widgetLines: [JSON.stringify({ tasks: [] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');
  const malformedPayloads = [{ schema: 'gentle-agents.activity/v1' }, { schema: 'gentle-agents.activity/v1', tasks: null }, { schema: 'gentle-agents.activity/v1', tasks: 'invalid-string' }, { schema: 'gentle-agents.activity/v1', tasks: 42 }];
  for (const payload of malformedPayloads) {
    controller.handleEvent({ type: 'extension_ui_request', id: 'widget-malformed-tasks', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify(payload)], sessionId: 'session-1' } as unknown as RpcEventBase);
    assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading', 'malformed tasks payload must retain previously seeded live activity');
  }
  assert.equal(parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1' }), null);
  assert.equal(parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1', tasks: null }), null);
  assert.equal(parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1', tasks: 'invalid-string' }), null);
  assert.equal(parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1', tasks: 42 }), null);
  assert.deepEqual(parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1', tasks: [] }), []);
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-valid-empty', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), null, 'valid empty snapshot must clear live activity');
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-reseed', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 't1', agent: 'explore', status: 'running', lastStep: 'reading' } }] })], sessionId: 'session-1' } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');
  const preStaleDispatchCount = dispatched.length;
  controller.handleEvent({ type: 'extension_ui_request', id: 'widget-stale', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [] })], sessionId: 'session-stale-999', sessionFile: '/path/stale.jsonl' } as unknown as RpcEventBase);
  const waitingDispatches = dispatched.slice(preStaleDispatchCount).filter((a) => a.type === 'UPDATE_SESSION_STATUS' && (a.payload as any)?.status === 'waiting');
  assert.equal(waitingDispatches.length, 0, 'stale setWidget must not mark background session waiting');
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');
  controller.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: 'Process disconnected' });
  assert.equal(getAgentWorkingStatus(state, 'en'), null);
});

test('S3.4 primary-agent tool activity without explicit phase infers exploring, implementing or checking phases while preserving precedence', () => {
  let readState = createBusyState();
  readState = chatReducer(readState, { type: 'EVENT_MESSAGE_START', payload: { message: { role: 'assistant', content: [] } } });
  readState = chatReducer(readState, { type: 'EVENT_TOOL_EXECUTION_START', payload: { toolCallId: 't-read', toolName: 'read', args: { path: 'src/app.ts' } } });
  assert.equal(getAgentWorkingStatus(readState, 'en'), 'Exploring - Read');
  assert.equal(getAgentWorkingStatus(readState, 'es'), 'Explorando - Read');
  let editState = createBusyState();
  editState = chatReducer(editState, { type: 'EVENT_MESSAGE_START', payload: { message: { role: 'assistant', content: [] } } });
  editState = chatReducer(editState, { type: 'EVENT_TOOL_EXECUTION_START', payload: { toolCallId: 't-edit', toolName: 'edit', args: { path: 'src/app.ts' } } });
  assert.equal(getAgentWorkingStatus(editState, 'en'), 'Implementing - Edit');
  assert.equal(getAgentWorkingStatus(editState, 'es'), 'Implementando - Edit');
  let testBashState = createBusyState();
  testBashState = chatReducer(testBashState, { type: 'EVENT_MESSAGE_START', payload: { message: { role: 'assistant', content: [] } } });
  testBashState = chatReducer(testBashState, { type: 'EVENT_TOOL_EXECUTION_START', payload: { toolCallId: 't-bash-test', toolName: 'bash', args: { command: 'npm test' } } });
  assert.equal(getAgentWorkingStatus(testBashState, 'en'), 'Checking - Bash');
  assert.equal(getAgentWorkingStatus(testBashState, 'es'), 'Verificando - Bash');
  let arbitraryBashState = createBusyState();
  arbitraryBashState = chatReducer(arbitraryBashState, { type: 'EVENT_MESSAGE_START', payload: { message: { role: 'assistant', content: [] } } });
  arbitraryBashState = chatReducer(arbitraryBashState, { type: 'EVENT_TOOL_EXECUTION_START', payload: { toolCallId: 't-bash-arb', toolName: 'bash', args: { command: 'ls -la' } } });
  assert.equal(getAgentWorkingStatus(arbitraryBashState, 'en'), 'Working - Bash');
  assert.equal(getAgentWorkingStatus(arbitraryBashState, 'es'), 'Trabajando - Bash');
  let explicitState = createBusyState();
  explicitState = chatReducer(explicitState, { type: 'EVENT_MESSAGE_START', payload: { message: { role: 'assistant', content: [] } } });
  explicitState = chatReducer(explicitState, { type: 'EVENT_TOOL_EXECUTION_START', payload: { toolCallId: 't-phase', toolName: 'gentle_odd_phase', args: { phase: 'planning' } } });
  explicitState = chatReducer(explicitState, { type: 'EVENT_TOOL_EXECUTION_START', payload: { toolCallId: 't-read-2', toolName: 'read', args: { path: 'src/app.ts' } } });
  assert.equal(getAgentWorkingStatus(explicitState, 'en'), 'Planning - Read');
  assert.equal(getAgentWorkingStatus(explicitState, 'es'), 'Planificando - Read');
});

test('PRESERVE: streaming thinking and generating distinguish without subagents', () => {
  let state = createBusyState();
  state = chatReducer(state, { type: 'EVENT_MESSAGE_START', payload: { message: { id: 'asst-1', role: 'assistant', content: '' } } });
  state = chatReducer(state, { type: 'EVENT_THINKING_UPDATE', payload: { delta: 'Analyzing problem...' } });
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Thinking');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Pensando');
});

const thread = { version: 3, dropped: 2, items: [
  { kind: 'text', text: 'Child response' },
  { kind: 'tool', name: 'read', args: '{"path":"a"}', running: false, isError: false, output: 'file content' },
] };
const task = (value: unknown = thread) => ({ summary: { id: 'child', agent: 'worker', label: 'Investigate', status: 'running', lastStep: 'Reading' }, thread: value });
const snapshot = (tasks: unknown[]) => ({ schema: 'gentle-agents.activity/v1', tasks });

function harness() {
  let current = 'one';
  let state = chatReducer(INITIAL_STATE, { type: 'SESSION_READY', payload: { sessionId: current, sessionFile: '/one', messages: [], activity: 'busy' } });
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' }),
    getCurrentSessionId: () => current,
    dispatch: action => { state = chatReducer(state, action); },
  });
  const send = (value: unknown, sessionId = current) => controller.handleEvent({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'gentle-agents', widgetLines: [JSON.stringify(value)], sessionId } as any);
  return { controller, send, state: () => state, select: (id: string) => { current = id; controller.handleEvent({ type: 'runtime_snapshot', sessionId: id, sessionFile: `/${id}`, messages: [], activity: 'idle' } as any); } };
}

test('S3.1 live publisher thread and metadata survive routing and update', () => {
  const h = harness();
  h.send(snapshot([task()]));
  assert.equal(h.state().subagents[0]?.label, 'Investigate');
  assert.deepEqual((h.state().subagents[0] as any)?.thread, thread);
  const updated = { version: 4, dropped: 2, items: [{ kind: 'note', text: 'Done reading' }] };
  h.send(snapshot([task(updated)]));
  assert.deepEqual((h.state().subagents[0] as any)?.thread, updated);
});

test('S3.3 validated activity rejects malformed items and bounds oversized input', () => {
  const parsed = parseSubagentSnapshot(snapshot([task({ version: 1, dropped: 0, items: [
    { kind: 'text', text: 'x'.repeat(100000) },
    { kind: 'tool', name: 'read', args: {}, running: 'yes', isError: false, output: 'invalid' },
    { kind: 'unknown', text: 'not activity' },
  ] })]));
  const items = (parsed?.[0] as any)?.thread?.items;
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.ok(items[0].text.length < 100000);
});

test('S2.3 absent and invalid snapshots preserve conversation; empty clears activity', () => {
  const h = harness();
  for (const invalid of [null, {}, { schema: 'wrong', tasks: [task()] }, { schema: 'gentle-agents.activity/v1', tasks: 'invalid' }]) {
    h.send(invalid);
    assert.equal(h.state().subagents.length, 0);
  }
  h.controller.handleEvent({ type: 'message_start', sessionId: 'one', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } } as any);
  assert.ok(h.state().messages.length > 0);
  h.send(snapshot([task()]));
  h.send(snapshot([]));
  assert.equal(h.state().subagents.length, 0);
});

test('S3.1/S2.4 live child keeps existing working status after main agent ends', () => {
  const h = harness();
  h.send(snapshot([task()]));
  assert.equal(getAgentWorkingStatus(h.state(), 'en'), 'Working - Worker: Reading');
  h.controller.handleEvent({ type: 'agent_end', sessionId: 'one' } as any);
  assert.equal(getAgentWorkingStatus(h.state(), 'en'), 'Working - Worker: Reading');
  h.send(snapshot([{ ...task(), summary: { ...task().summary, lastStep: 'Checking' } }]));
  assert.equal(getAgentWorkingStatus(h.state(), 'en'), 'Working - Worker: Checking');
});

test('S2.4 main agent end preserves children; switching, stale events and disconnect clear them', () => {
  const h = harness();
  h.send(snapshot([task()]));
  h.controller.handleEvent({ type: 'agent_end', sessionId: 'one' } as any);
  assert.equal(h.state().subagents.length, 1);
  h.select('two');
  assert.equal(h.state().subagents.length, 0);
  h.send(snapshot([task()]), 'one');
  assert.equal(h.state().subagents.length, 0);
  h.send(snapshot([task()]));
  assert.equal(h.state().subagents.length, 1);
  h.controller.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: 'Closed' });
  assert.equal(h.state().subagents.length, 0);
});
