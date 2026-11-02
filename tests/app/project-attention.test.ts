import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isMobileViewport } from '@app/mobile-navigation';

const projects = [{ id: 'active', path: '/active', customName: 'Active' }, { id: 'other', path: '/other', customName: 'Other project' }];
const event = { projectId: 'other', sessionId: 'background', type: 'task_complete' };

async function render(overrides: Record<string, unknown> = {}) {
  const { ProjectAttentionToast } = await import('@app/ProjectAttentionToast');
  return renderToStaticMarkup(React.createElement(ProjectAttentionToast, {
    event, projects, activeProjectId: 'active', isMobile: isMobileViewport(768), locale: 'en', onDismiss: () => {}, ...overrides,
  } as any));
}

test('S2.1 pending events are bounded, filtered, and pruned when context changes', async () => {
  const { enqueueAttention, pruneAttention } = await import('@app/project-attention');
  const context = { projects, activeProjectId: 'active', isMobile: true };
  const other = { ...event, type: 'error' as const };
  let queue = enqueueAttention([], event as any, context);
  queue = enqueueAttention(queue, other, context);
  assert.deepEqual(queue, [event, other]);
  assert.deepEqual(enqueueAttention(queue, { ...event, projectId: 'unknown' } as any, context), queue);
  assert.deepEqual(enqueueAttention(queue, { ...event, projectId: 'active' } as any, context), queue);
  assert.deepEqual(enqueueAttention(queue, event as any, { ...context, isMobile: false }), queue);
  queue = enqueueAttention(queue, event as any, context);
  queue = enqueueAttention(queue, other, context);
  assert.equal(queue.length, 3);
  assert.deepEqual(pruneAttention(queue, { ...context, activeProjectId: 'other' }), []);
  assert.deepEqual(pruneAttention(queue, { ...context, projects: [projects[0]] }), []);
  assert.deepEqual(pruneAttention(queue, { ...context, isMobile: false }), []);
});

test('S2.1 mobile toast identifies the other project and localized completion with accessible dismiss', async () => {
  const html = await render();
  assert.match(html, /Other project/);
  assert.match(html, /complet/i);
  assert.match(html, /role="(?:status|alert)"|aria-live=/);
  assert.match(html, /<button[^>]*aria-label="[^"]+"/);
});

test('S2.1 toast is positioned at the top with safe-area spacing', async () => {
  const html = await render();
  assert.match(html, /position\s*:\s*fixed/i);
  assert.match(html, /top\s*:[^;"]*(?:env\(safe-area-inset-top\)|0)/i);
  assert.match(html, /env\(safe-area-inset-top\)/i);
});

test('S2.1 dismiss control removes the toast without automatic project navigation', async () => {
  const { ProjectAttentionToast } = await import('@app/ProjectAttentionToast');
  let current: typeof event | null = event;
  const navigations: string[] = [];
  const props = () => ({
    event: current, projects, activeProjectId: 'active', isMobile: true, locale: 'en',
    onDismiss: () => { current = null; },
    onSelectProject: (id: string) => navigations.push(id),
  });
  const tree = (ProjectAttentionToast as any)(props());
  const buttons: any[] = [];
  function visit(node: any): void {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!React.isValidElement(node)) return;
    const element = node as React.ReactElement<any>;
    if (element.type === 'button') buttons.push(element);
    visit(element.props.children);
  }
  visit(tree);
  assert.deepEqual(navigations, [], 'rendering must not switch projects');
  const dismiss = buttons.find(button => /dismiss|close|cerrar/i.test(button.props['aria-label'] ?? ''));
  assert.ok(dismiss, 'accessible dismiss button exists');
  dismiss.props.onClick();
  assert.equal(current, null);
  assert.deepEqual(navigations, [], 'dismiss must not switch projects');
  assert.equal(renderToStaticMarkup(React.createElement(ProjectAttentionToast, props() as any)), '');
});

test('S2.1 desktop, active project and unknown project never render attention', async () => {
  assert.equal(await render({ isMobile: isMobileViewport(769) }), '');
  assert.equal(await render({ activeProjectId: 'other' }), '');
  assert.equal(await render({ event: { ...event, projectId: 'unknown' } }), '');
});

test('S2.1 error and waiting states are localized', async () => {
  const error = await render({ event: { ...event, type: 'error' }, locale: 'es' });
  const waiting = await render({ event: { ...event, type: 'waiting_input' }, locale: 'es' });
  assert.match(error, /Other project/);
  assert.match(error, /error/i);
  assert.match(waiting, /Other project/);
  assert.match(waiting, /espera|respuesta|entrada/i);
});
