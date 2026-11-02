import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate } from '@shared/i18n';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';

const snapshot = (tasks: unknown[]) => ({ tasks, nextId: 10, updatedTurn: 1 });
const tasks = [
  { id: 1, title: 'Write tests', status: 'done' },
  { id: 2, title: 'Implement', status: 'in_progress' },
  { id: 3, title: 'Old plan', status: 'dropped' },
];

function harness() {
  let state = chatReducer(INITIAL_STATE, { type: 'SESSION_READY', payload: {
    sessionId: 'one', sessionFile: '/one', messages: [], activity: 'idle',
  } });
  let current = 'one';
  const controller = new SessionEventController({
    getCurrentConfig: () => ({ nodePath: 'node', piEntrypoint: '/pi.js', workingDirectory: '/project' }),
    getCurrentSessionId: () => current,
    dispatch: action => { state = chatReducer(state, action); },
  });
  const live = (value: unknown, sessionId = current, isError = false) => controller.handleEvent({
    type: 'tool_execution_end', toolCallId: 'call', toolName: 'todo', sessionId,
    result: { content: [{ type: 'text', text: 'Todo updated' }], details: { gentleTodo: value } }, isError,
  } as any);
  return { controller, live, state: () => state as any, select: (id: string) => {
    current = id;
    controller.handleEvent({ type: 'runtime_snapshot', sessionId: id, sessionFile: `/${id}`, messages: [], activity: 'idle' } as any);
  } };
}

// The panel is controlled so its real toggle handler can be exercised without a DOM dependency.
const t = (key: any, params?: Record<string, string | number>) => translate('en', key, params);

function findToggle(node: any): any {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button' && typeof node.props?.onClick === 'function' && node.props['aria-expanded'] !== undefined) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = findToggle(child);
    if (found) return found;
  }
  return null;
}

test('S1.1 panel counter and task visibility follow collapse, expansion and updated snapshots', async () => {
  const { TodoPanel } = await import('@features/chat/TodoPanel');
  let expanded = true;
  let currentTasks = tasks;
  let tree: any;
  const render = () => {
    function Host() {
      tree = TodoPanel({ todo: snapshot(currentTasks), expanded, onToggle: () => { expanded = !expanded; }, t } as any);
      return tree;
    }
    return renderToStaticMarkup(React.createElement(Host));
  };

  let markup = render();
  assert.match(markup, /1\s*\/\s*2/);
  assert.match(markup, /Write tests/);
  assert.match(markup, /Implement/);
  let toggle = findToggle(tree);
  assert.ok(toggle, 'panel exposes an accessible toggle');
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  markup = render();
  assert.match(markup, /1\s*\/\s*2/);
  assert.doesNotMatch(markup, /Write tests/);
  toggle = findToggle(tree);
  assert.equal(toggle.props['aria-expanded'], false);

  currentTasks = [{ id: 2, title: 'Implement', status: 'done' }, { id: 3, title: 'Old plan', status: 'dropped' }];
  markup = render();
  assert.match(markup, /1\s*\/\s*1/);
  findToggle(tree).props.onClick();
  markup = render();
  assert.equal(findToggle(tree).props['aria-expanded'], true);
  assert.match(markup, /Implement/);
  assert.match(markup, /1\s*\/\s*1/);
});

test('S2.1 panel is absent for missing, incompatible and empty snapshots', async () => {
  const { TodoPanel } = await import('@features/chat/TodoPanel');
  for (const todo of [undefined, null, {}, { tasks: 'invalid' }, snapshot([])]) {
    const markup = renderToStaticMarkup(React.createElement(TodoPanel, {
      todo, expanded: true, onToggle: () => {}, t,
    } as any));
    assert.equal(markup, '', `unsupported snapshot ${JSON.stringify(todo)} must not render a panel`);
  }
});

test('S1.1 live todo results update the current task list', () => {
  const h = harness();
  h.live(snapshot(tasks));
  assert.deepEqual(h.state().todo?.tasks, tasks);
  const updated = [{ id: 2, title: 'Implement', status: 'done' }];
  h.live(snapshot(updated));
  assert.deepEqual(h.state().todo?.tasks, updated);
});

test('S1.2 restored history uses the latest successful todo result', () => {
  const h = harness();
  const result = (value: unknown, isError = false) => ({ role: 'toolResult', toolName: 'todo', toolCallId: 'call', content: [{ type: 'text', text: 'result' }], details: { gentleTodo: value }, isError });
  h.controller.handleEvent({ type: 'runtime_snapshot', sessionId: 'one', sessionFile: '/one', activity: 'idle', messages: [
    result(snapshot([{ id: 1, title: 'First', status: 'pending' }])),
    result(snapshot(tasks)),
    result(snapshot([{ id: 4, title: 'Failed', status: 'done' }]), true),
  ] } as any);
  assert.deepEqual(h.state().todo?.tasks, tasks);
});

test('S2.1 invalid and failed results do not replace valid tasks; empty snapshot clears them', () => {
  const h = harness();
  h.live(snapshot(tasks));
  for (const invalid of [null, {}, { tasks: 'bad' }, { tasks: [{ id: 1, title: 'Bad', status: 'unknown' }] }]) {
    h.live(invalid);
    assert.deepEqual(h.state().todo?.tasks, tasks);
  }
  h.live(snapshot([{ id: 4, title: 'Failed', status: 'done' }]), 'one', true);
  assert.deepEqual(h.state().todo?.tasks, tasks);
  h.live(snapshot([]));
  assert.ok(!h.state().todo || h.state().todo.tasks.length === 0);
});

test('S2.2 switching, stale events and disconnect cannot leak todo state', () => {
  const h = harness();
  h.live(snapshot(tasks));
  assert.deepEqual(h.state().todo?.tasks, tasks);
  h.select('two');
  assert.ok(!h.state().todo || h.state().todo.tasks.length === 0);
  h.live(snapshot(tasks), 'one');
  assert.ok(!h.state().todo || h.state().todo.tasks.length === 0);
  h.live(snapshot(tasks));
  assert.deepEqual(h.state().todo?.tasks, tasks);
  h.controller.handleStatusChange({ state: 'disconnected', label: 'Disconnected', detail: 'Closed' });
  assert.ok(!h.state().todo || h.state().todo.tasks.length === 0);
});
