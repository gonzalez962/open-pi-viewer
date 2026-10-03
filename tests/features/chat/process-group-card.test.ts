import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translate } from '@shared/i18n';
import { groupMessageBlocks, type ProcessGroup } from '@core/process-grouping';
import type { MessageBlock, ThinkingBlock, ToolCallBlock } from '@core/types/messages';
import { ProcessGroupCard } from '@features/chat/ProcessGroupCard';
import {
  ToolCard,
  detectLanguageFromPath,
  extractBashCommand,
  extractEditReplacements,
  extractWriteContent,
  resolveLanguageHint,
} from '@features/chat/ActivityBlocks';

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);

function tool(name: string, overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    type: 'tool_call',
    id: overrides.id ?? `id-${name}-${Math.random()}`,
    name,
    status: 'completed',
    output: '',
    isError: false,
    ...overrides,
  };
}

function thinking(): ThinkingBlock {
  return { type: 'thinking', thinking: 'reasoning...' };
}

function buildGroup(blocks: MessageBlock[]): ProcessGroup {
  const items = groupMessageBlocks(blocks);
  const group = items.find((i) => i.type === 'process_group');
  assert.ok(group, 'expected at least one process_group in fixture blocks');
  return group as ProcessGroup;
}

test('ProcessGroupCard: renders total activity count and a badge per present category', () => {
  const group = buildGroup([thinking(), tool('bash'), tool('read'), tool('read')]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.ok(markup.includes('4'), 'header should show the total activity count');
  assert.ok(markup.includes('Thinking'));
  assert.ok(markup.includes('Bash'));
  assert.ok(markup.includes('Read'));
  // read appears twice -> count 2 badge
  assert.ok(markup.includes('Read') && markup.includes('· 2'));
});

test('ProcessGroupCard: collapsed by default — no child ToolCard/ThinkingCard markup rendered', () => {
  const group = buildGroup([tool('bash'), tool('read')]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.equal(markup.includes('tool-card'), false);
  assert.equal(markup.includes('process-category-children'), false);
  assert.ok(markup.includes('process-category-toggle'));
});

test('ProcessGroupCard: global toggle shows "+ Expand all" when collapsed', () => {
  const group = buildGroup([tool('bash')]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));
  assert.ok(markup.includes('+ Expand all'));
});

test('ProcessGroupCard: category toggle buttons render a "+" sign when collapsed', () => {
  const group = buildGroup([tool('bash'), tool('edit')]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));
  // Two category rows collapsed -> two "+" signs (one per category toggle)
  const plusCount = (markup.match(/>\+</g) || []).length;
  assert.ok(plusCount >= 2, `expected at least 2 collapsed "+" signs, saw ${plusCount}`);
});

test('ProcessGroupCard: shows "With observations" badge when the group has an error tool_call', () => {
  const group = buildGroup([
    tool('bash'),
    tool('read', { isError: true, status: 'error' }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));
  assert.ok(markup.includes('With observations'));
});

test('ProcessGroupCard: omits "With observations" badge when nothing failed', () => {
  const group = buildGroup([tool('bash'), tool('read')]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));
  assert.equal(markup.includes('With observations'), false);
});

test('ProcessGroupCard: clicking the global toggle and a category toggle does not throw', () => {
  function findAll(node: unknown, predicate: (n: any) => boolean, acc: any[] = []): any[] {
    if (!node || typeof node !== 'object') return acc;
    const n = node as any;
    if (predicate(n)) acc.push(n);
    const children = React.Children.toArray(n.props?.children);
    for (const child of children) findAll(child, predicate, acc);
    return acc;
  }

  const group = buildGroup([tool('bash'), tool('edit')]);
  let capturedTree: unknown = null;
  function Host() {
    capturedTree = ProcessGroupCard({ group, t });
    return capturedTree as React.ReactElement;
  }
  renderToStaticMarkup(React.createElement(Host));

  const globalToggle = findAll(
    capturedTree,
    (n) => n.props?.className === 'process-group-global-toggle'
  )[0];
  assert.ok(globalToggle, 'global toggle button should be present in the tree');
  assert.doesNotThrow(() => globalToggle.props.onClick());

  const categoryToggles = findAll(
    capturedTree,
    (n) => n.props?.className === 'process-category-toggle'
  );
  assert.ok(categoryToggles.length > 0);
  assert.doesNotThrow(() => categoryToggles[0].props.onClick());
});

// --- ToolCard formatted previews (write/edit/read/bash) ---

test('ToolCard: tool error badge shows the sober "Completed with warnings" label', () => {
  const block = tool('read', { status: 'error', isError: true });
  const markup = renderToStaticMarkup(React.createElement(ToolCard, { block, t }));
  assert.ok(markup.includes('Completed with warnings'));
  assert.equal(markup.includes('>Failed<'), false);
});

test('detectLanguageFromPath: infers language from a file extension', () => {
  assert.equal(detectLanguageFromPath('src/core/picolor.ts'), 'typescript');
  assert.equal(detectLanguageFromPath('script.py'), 'python');
  assert.equal(detectLanguageFromPath(undefined), undefined);
  assert.equal(detectLanguageFromPath('no-extension'), undefined);
});

test('extractWriteContent: reads path and decoded content from write args', () => {
  const result = extractWriteContent({ path: 'a/b.ts', content: 'const x = 1;\nconsole.log(x);' });
  assert.ok(result);
  assert.equal(result?.path, 'a/b.ts');
  assert.equal(result?.content, 'const x = 1;\nconsole.log(x);');
  assert.equal(extractWriteContent({ path: 'a/b.ts' }), null);
  assert.equal(extractWriteContent('not-an-object'), null);
});

test('extractEditReplacements: single oldText/newText pair', () => {
  const result = extractEditReplacements({ oldText: 'foo', newText: 'bar' });
  assert.deepEqual(result, [{ oldText: 'foo', newText: 'bar' }]);
});

test('extractEditReplacements: old_string/new_string aliases', () => {
  const result = extractEditReplacements({ old_string: 'foo', new_string: 'bar' });
  assert.deepEqual(result, [{ oldText: 'foo', newText: 'bar' }]);
});

test('extractEditReplacements: an edits array with multiple replacement pairs', () => {
  const result = extractEditReplacements({
    edits: [
      { oldText: 'a', newText: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  });
  assert.deepEqual(result, [
    { oldText: 'a', newText: 'b' },
    { oldText: 'c', newText: 'd' },
  ]);
});

test('extractEditReplacements: returns empty array when neither shape is present', () => {
  assert.deepEqual(extractEditReplacements({ path: 'x' }), []);
  assert.deepEqual(extractEditReplacements(undefined), []);
});

test('extractBashCommand: reads command from object args or a bare string', () => {
  assert.equal(extractBashCommand({ command: 'npm test' }), 'npm test');
  assert.equal(extractBashCommand('npm test'), 'npm test');
  assert.equal(extractBashCommand({ path: 'x' }), undefined);
});

test('resolveLanguageHint: prefers an explicit language field, falls back to path inference', () => {
  assert.equal(resolveLanguageHint({ language: 'Rust' }, 'a.ts'), 'rust');
  assert.equal(resolveLanguageHint({}, 'a.py'), 'python');
  assert.equal(resolveLanguageHint({}, undefined), undefined);
});

test('ToolCard: write tool renders decoded content preview (not escaped JSON), with line count and language', () => {
  const block = tool('write', {
    args: { path: 'src/x.ts', content: 'function add(a, b) {\n  return a + b;\n}' },
  });
  const markup = renderToStaticMarkup(
    React.createElement(ToolCard, { block, t, defaultOpen: true })
  );

  assert.ok(markup.includes('File content'));
  assert.equal(markup.includes('\\n'), false, 'newlines must be real, not an escaped \\n');
  assert.ok(markup.includes('3 lines'));
  assert.ok(markup.includes('typescript'));
  assert.ok(markup.includes('function'));
});

test('ToolCard: edit tool renders old/new replacement blocks', () => {
  const block = tool('edit', {
    args: { path: 'src/x.ts', oldText: 'const a = 1;', newText: 'const a = 2;' },
  });
  const markup = renderToStaticMarkup(
    React.createElement(ToolCard, { block, t, defaultOpen: true })
  );

  assert.ok(markup.includes('edit-old-text'));
  assert.ok(markup.includes('edit-new-text'));
  assert.ok(markup.includes('Before'));
  assert.ok(markup.includes('After'));
  assert.ok(markup.includes('const'));
});

test('ToolCard: bash tool renders a "$" command bar instead of a JSON args dump', () => {
  const block = tool('bash', { args: { command: 'npm test' } });
  const markup = renderToStaticMarkup(
    React.createElement(ToolCard, { block, t, defaultOpen: true })
  );

  assert.ok(markup.includes('terminal-command-bar'));
  assert.ok(markup.includes('npm test'));
  assert.equal(markup.includes('"command"'), false, 'should not fall back to raw JSON args');
});

test('ToolCard: read tool highlights output by inferred file language', () => {
  const block = tool('read', {
    args: { path: 'src/x.py' },
    output: 'def add(a, b):\n    return a + b',
  });
  const markup = renderToStaticMarkup(
    React.createElement(ToolCard, { block, t, defaultOpen: true })
  );

  assert.ok(markup.includes('tool-code-pre'));
  assert.ok(markup.includes('def'));
});

test('ToolCard: other (unhandled) tool category keeps the plain JSON args view', () => {
  const block = tool('grep', { args: { pattern: 'foo', path: 'src' } });
  const markup = renderToStaticMarkup(
    React.createElement(ToolCard, { block, t, defaultOpen: true })
  );
  assert.ok(markup.includes('tool-args-pre'));
  assert.ok(markup.includes('pattern'));
});

// --- ODD Agent Indicators in ProcessGroupCard (Issue #22) ---

test('ProcessGroupCard: explicit subagent dispatch renders left-aligned Orchestrator and role indicators', () => {
  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'gentle-ai-explore' },
      status: 'completed',
    }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.ok(markup.includes('odd-agent-indicators'), 'should render .odd-agent-indicators container');
  assert.ok(markup.includes('odd-agent-orchestrator'), 'should render Orchestrator badge');
  assert.ok(markup.includes('Orchestrator'), 'should display localized Orchestrator label');
  assert.ok(markup.includes('odd-agent-explore'), 'should render explore role indicator');
  assert.ok(markup.includes('Explore'), 'should display localized Explore label');
  assert.ok(markup.includes('odd-agent-status-dispatched'), 'completed tool maps to dispatched status');
  assert.equal(markup.includes('is-running'), false, 'dispatched status should not have is-running');
});

test('ProcessGroupCard: running dispatch tool renders is-dispatching pulse class on indicator and localized tooltip', () => {
  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'gentle-ai-verify' },
      status: 'running',
    }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.ok(markup.includes('odd-agent-verify'));
  assert.ok(markup.includes('Verify'));
  assert.ok(markup.includes('odd-agent-status-dispatching'));
  assert.ok(markup.includes('is-dispatching'));
  assert.ok(markup.includes('title="Verify (Dispatching)"'));
});

test('ProcessGroupCard: ordinary tools and status commands produce NO agent indicators or Orchestrator', () => {
  const group = buildGroup([
    tool('bash', { args: { command: 'git status' } }),
    tool('subagent_status', { args: { id: 'task-1' } }),
    tool('read', { args: { path: 'a.ts' } }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.equal(markup.includes('odd-agent-indicators'), false, 'should NOT render .odd-agent-indicators');
  assert.equal(markup.includes('odd-agent-orchestrator'), false, 'should NOT render Orchestrator badge');
});

test('ProcessGroupCard: supports Spanish localization for agent indicators and dispatching lifecycle', () => {
  const tEs = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('es', key, params);

  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'gentle-ai-worker' },
      status: 'running',
    }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t: tEs }));

  assert.ok(markup.includes('Orquestador'), 'Spanish Orchestrator label');
  assert.ok(markup.includes('Trabajador'), 'Spanish Worker label');
  assert.ok(markup.includes('title="Trabajador (Despachando)"'));
});

test('ProcessGroupCard: multiple dispatches of the same role renders count badge', () => {
  const group = buildGroup([
    tool('subagent_run', { args: { agent: 'gentle-ai-explore' }, status: 'completed' }),
    tool('subagent_run', { args: { agent: 'gentle-ai-explore' }, status: 'completed' }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.ok(markup.includes('odd-agent-count'));
  assert.ok(markup.includes('· 2'));
});

test('ProcessGroupCard: unknown agent displays conservative label without pretending a known role', () => {
  const group = buildGroup([
    tool('subagent_run', { args: { agent: 'custom-analyzer' }, status: 'completed' }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.ok(markup.includes('odd-agent-unknown'));
  assert.ok(markup.includes('custom-analyzer'));
});

test('ProcessGroupCard: preserves full extreme long agent identifier without spaces for wrapping layout', () => {
  const longName = 'custom-extreme-long-agent-identifier-without-spaces-2026';
  const group = buildGroup([
    tool('subagent_run', { args: { agent: longName }, status: 'completed' }),
  ]);
  const markup = renderToStaticMarkup(React.createElement(ProcessGroupCard, { group, t }));

  assert.ok(markup.includes('odd-agent-indicator'));
  assert.ok(markup.includes('odd-agent-label'));
  assert.ok(markup.includes(longName), 'must preserve full unknown identifier without truncation');
});

test('chat.css: ODD agent indicators enforce pill/header shrink and label wrapping without nowrap overflow', () => {
  const css = readFileSync(join(process.cwd(), 'src/features/chat/chat.css'), 'utf8');

  // Verify .odd-agent-indicator does not have white-space: nowrap which causes overflow at 320px
  const indicatorRuleMatch = css.match(/\.odd-agent-indicator\s*\{([^}]+)\}/);
  assert.ok(indicatorRuleMatch, 'should find .odd-agent-indicator CSS rule');
  const indicatorProps = indicatorRuleMatch[1];
  assert.equal(
    indicatorProps.includes('white-space: nowrap'),
    false,
    '.odd-agent-indicator must not set white-space: nowrap'
  );
  assert.match(
    indicatorProps,
    /max-width:\s*100%/,
    '.odd-agent-indicator must have max-width: 100% for container shrink'
  );

  // Verify .odd-agent-label supports breaking/wrapping for long names without spaces
  const labelRuleMatch = css.match(/\.odd-agent-label\s*\{([^}]+)\}/);
  assert.ok(labelRuleMatch, 'should find .odd-agent-label CSS rule');
  const labelProps = labelRuleMatch[1];
  assert.match(
    labelProps,
    /overflow-wrap:\s*anywhere/,
    '.odd-agent-label must have overflow-wrap: anywhere'
  );
  assert.match(
    labelProps,
    /word-break:\s*break-word/,
    '.odd-agent-label must have word-break: break-word'
  );
});