import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate } from '@shared/i18n';
import { parseSubagentSnapshot } from '@core/agent-activity';

const t = (key: any, params?: Record<string, string | number>) => translate('en', key, params);
const tasks = [
  { id: 'one', agent: 'worker', label: 'First task', status: 'running', thread: { version: 1, dropped: 0, items: [{ kind: 'text', text: 'First response' }] } },
  { id: 'two', agent: 'reviewer', label: 'Second task', status: 'waiting', thread: { version: 2, dropped: 2, items: [{ kind: 'tool', name: 'read', args: '{"path":"a"}', running: false, isError: false, output: 'Real output' }] } },
];

function find(node: any, predicate: (element: any) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
function text(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return React.Children.toArray(node?.props?.children).map(text).join(' ');
}

// Controlled rendering calls the production component and its actual button handlers.
test('S3.2 task selection and live updates show only the selected real activity', async () => {
  const { SubagentActivityModal } = await import('@features/chat/SubagentActivityModal');
  let selectedId = 'one';
  let current: any[] = tasks;
  let tree: any;
  const render = () => {
    function Host() {
      tree = SubagentActivityModal({ tasks: current, selectedId, onSelect: (id: string) => { selectedId = id; }, onClose: () => {}, t } as any);
      return tree;
    }
    return renderToStaticMarkup(React.createElement(Host));
  };
  let html = render();
  assert.match(html, /First response/);
  assert.doesNotMatch(html, /Real output/);
  const select = find(tree, node => node.type === 'button' && text(node).includes('Second task'));
  assert.ok(select, 'second task exposes a selection button');
  select.props.onClick();
  html = render();
  assert.equal(selectedId, 'two');
  assert.match(html, /read/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /First response/);
  current = [tasks[0], { ...tasks[1], thread: { version: 3, dropped: 2, items: [{ kind: 'note', text: 'New live note' }] } }];
  html = render();
  assert.match(html, /New live note/);
  assert.doesNotMatch(html, /Real output/);
});

test('S3.3 modal communicates partial and metadata-only activity without inventing content', async () => {
  const { SubagentActivityModal } = await import('@features/chat/SubagentActivityModal');
  const render = (list: any[], selectedId: string) => renderToStaticMarkup(React.createElement(SubagentActivityModal, { tasks: list, selectedId, onSelect: () => {}, onClose: () => {}, t } as any));
  const partial = render(tasks, 'two');
  assert.match(partial, /read/);
  assert.match(partial, /aria-expanded="false"/);
  assert.match(partial, /partial|truncat|earlier|dropped/i);
  const metadata = render([{ id: 'three', agent: 'worker', label: 'Metadata only', status: 'running', thread: { version: 1, dropped: 0, items: [] } }], 'three');
  assert.match(metadata, /Metadata only/);
  assert.match(metadata, /unavailable|no activity|no.*detail/i);
  assert.doesNotMatch(metadata, /Real output|First response/);
});

test('S3.3 parsed oversized thread renders viewer truncation and bounded snapshot notices', async () => {
  const { SubagentActivityModal } = await import('@features/chat/SubagentActivityModal');
  const parsed = parseSubagentSnapshot({ schema: 'gentle-agents.activity/v1', tasks: [{ summary: { id: 'a', agent: 'worker', status: 'running' }, thread: { version: 1, dropped: 0, items: [{ kind: 'text', text: 'z'.repeat(3000) }] } }] });
  assert.ok(parsed);
  const html = renderToStaticMarkup(React.createElement(SubagentActivityModal, { tasks: parsed, selectedId: 'a', onSelect: () => {}, onClose: () => {}, t }));
  assert.match(html, /viewer.*truncat/i);
  assert.match(html, /bounded|limited.*snapshot/i);
  assert.ok(!html.includes('z'.repeat(3000)));
});

test('S3.2 production modal focus handlers move focus inside and wrap Tab', async () => {
  const { SubagentActivityModal } = await import('@features/chat/SubagentActivityModal');
  let tree: any;
  function Host() { tree = SubagentActivityModal({ tasks: tasks as any, selectedId: 'one', onSelect: () => {}, onClose: () => {}, t }); return tree; }
  renderToStaticMarkup(React.createElement(Host));
  const dialog = find(tree, node => node.props?.role === 'dialog');
  let focused = '';
  const first = { focus: () => { focused = 'first'; }, hidden: false, getAttribute: () => null, style: {} };
  const last = { focus: () => { focused = 'last'; }, hidden: false, getAttribute: () => null, style: {} };
  const element = { querySelector: () => first, querySelectorAll: () => [first, last], contains: (value: unknown) => value === first || value === last };
  assert.equal(typeof dialog.ref, 'function');
  dialog.ref(element);
  assert.equal(focused, 'first');
  let prevented = false;
  dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; }, currentTarget: element, target: last });
  assert.equal(prevented, true);
  assert.equal(focused, 'first');
  prevented = false;
  dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; }, currentTarget: element, target: first });
  assert.equal(prevented, true);
  assert.equal(focused, 'last');
});

// The interaction controller is the production handler used by the entry point and
// window listener, not a reimplementation of keyboard/focus decisions in the test.
test('S3.2 click and Alt+A open; Escape restores focus; another dialog takes precedence', async () => {
  const { createSubagentActivityController } = await import('@features/chat/subagent-activity-modal');
  let open = false;
  let focused = 0;
  let otherDialog = false;
  let activeTasks: any[] = tasks;
  const trigger = { focus: () => { focused++; } };
  const controller = createSubagentActivityController({
    getTasks: () => activeTasks, getOtherDialogOpen: () => otherDialog,
    getActiveElement: () => trigger, setOpen: (value: boolean) => { open = value; },
  });
  const key = (key: string, altKey = false) => {
    let prevented = false;
    controller.onKeyDown({ key, altKey, preventDefault: () => { prevented = true; } } as any);
    return prevented;
  };
  controller.onClick();
  assert.equal(open, true);
  assert.equal(key('Escape'), true);
  assert.equal(open, false);
  assert.equal(focused, 1);
  assert.equal(key('a', true), true);
  assert.equal(open, true);
  otherDialog = true;
  assert.equal(key('Escape'), false);
  assert.equal(open, true);
  assert.equal(focused, 1);
  otherDialog = false;
  assert.equal(key('Escape'), true);
  assert.equal(open, false);
  assert.equal(focused, 2);
  otherDialog = true;
  assert.equal(key('a', true), false);
  controller.onClick();
  assert.equal(open, false);
});

test('S2.3 missing or empty tasks hide the entry and Alt+A is a safe no-op', async () => {
  const { SubagentActivityEntry, createSubagentActivityController } = await import('@features/chat/subagent-activity-modal');
  for (const tasks of [undefined, null, []]) {
    assert.equal(renderToStaticMarkup(React.createElement(SubagentActivityEntry, { tasks, onClick: () => assert.fail('must not open'), t } as any)), '');
    let open = false;
    let prevented = false;
    const controller = createSubagentActivityController({ getTasks: () => tasks, getOtherDialogOpen: () => false, getActiveElement: () => null, setOpen: (value: boolean) => { open = value; } });
    controller.onKeyDown({ key: 'a', altKey: true, preventDefault: () => { prevented = true; } } as any);
    assert.equal(open, false);
    assert.equal(prevented, false);
  }
  const markup = renderToStaticMarkup(React.createElement(SubagentActivityEntry, { tasks: tasks, onClick: () => {}, t } as any));
  assert.match(markup, /Subagent process/i);
  assert.match(markup, /2/);
});
