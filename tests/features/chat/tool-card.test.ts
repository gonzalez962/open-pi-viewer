import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ToolCallBlock } from '@core/types/messages';
import { ToolCard } from '@features/chat/ActivityBlocks';
import { translate, type TranslationKey } from '@shared/i18n';

const t = (key: TranslationKey, params?: Record<string, string | number>) => translate('es', key, params);

function renderToolCard(overrides: Partial<ToolCallBlock> = {}, defaultOpen = false) {
  const block: ToolCallBlock = { type: 'tool_call', id: 'tool', name: 'read', status: 'completed', ...overrides };
  return renderToStaticMarkup(React.createElement(ToolCard, { block, t, defaultOpen }));
}

test('ToolCard: status badges keep their original localized labels and running indicator', () => {
  const cases = [
    ['completed', 'activity.tool_status_completed'],
    ['running', 'activity.tool_status_running'],
    ['error', 'activity.tool_status_failed'],
  ] as const;
  for (const [status, key] of cases) {
    const html = renderToolCard({ status });
    const label = t(key);
    const spinner = status === 'running' ? '<span class="tool-running-spinner" aria-hidden="true"></span>' : '';
    assert.ok(html.includes(`<span class="tool-status-badge tool-badge-${status}">${spinner}${label}</span>`));
    assert.equal(html.split(label).length, 2, 'status text occurs once');
    assert.doesNotMatch(html, /aria-label=|role="status"/);
  }
});

test('ToolCard: the optional argument stays in the same native disclosure button', () => {
  for (const [name, args, summary] of [
    ['read', { path: `/src/${'nested-directory/'.repeat(12)}file.ts` }, `/src/${'nested-directory/'.repeat(12)}file.ts`],
    ['bash', { command: `echo ${'a'.repeat(100)}` }, `echo ${'a'.repeat(52)}...`],
  ] as const) {
    const html = renderToolCard({ name, args });
    const header = html.match(/<button type="button" class="tool-card-header" aria-expanded="false">([\s\S]*?)<\/button>/)?.[1];
    assert.ok(header, 'native button supports click and keyboard activation');
    assert.match(header, /class="tool-header-left">[\s\S]*?class="tool-icon-wrapper" aria-hidden="true"/);
    assert.ok(header.includes(`<span class="tool-name">${name}</span><span class="tool-arg-badge" title="${summary}">${summary}</span>`));
    assert.match(header, /class="tool-header-right">[\s\S]*?tool-status-badge[\s\S]*?class="tool-toggle-indicator" aria-hidden="true"/);
    assert.doesNotMatch(html, /role="region"/);
  }

  const withoutArg = renderToolCard({}, true);
  assert.doesNotMatch(withoutArg, /tool-arg-badge/);
  assert.match(withoutArg, /<button type="button" class="tool-card-header" aria-expanded="true">/);
  assert.match(withoutArg, /class="chevron-icon chevron-open"/);
  assert.match(withoutArg, /class="tool-card-body" role="region"/);
});
