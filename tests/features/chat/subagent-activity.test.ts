import assert from 'node:assert/strict';
import test from 'node:test';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';
import { parseSubagentSnapshot } from '@core/agent-activity';
import { getAgentWorkingStatus } from '@features/chat/agent-working-status';

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
