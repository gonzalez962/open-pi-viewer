import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MessageBlock, ThinkingBlock, ToolCallBlock, ChatMessage } from '@core/types/messages';
import { ThinkingCard, ToolCard } from '@features/chat/ActivityBlocks';
import { mergeConsecutiveAssistantMessages } from '@core/process-grouping';
import type { TranslationKey } from '@shared/i18n';

function t(key: TranslationKey, params?: Record<string, string | number>): string {
  if (key === 'activity.thinking') return 'Thinking...';
  if (key === 'activity.thought_complete') return 'Thought completed';
  if (key === 'activity.reasoning') return 'Reasoning';
  if (key === 'activity.tool_status_completed') return 'Completed';
  if (key === 'activity.tool_status_running') return 'Running...';
  if (key === 'activity.tool_status_failed') return 'Failed';
  if (key === 'activity.copied_output') return 'Copied';
  if (params && params.count !== undefined) return `${key} (${params.count})`;
  return key;
}

test('ThinkingCard: renders collapsed by default without body, shows header and label', () => {
  const block: ThinkingBlock = {
    type: 'thinking',
    thinking: 'Step 1: Check git status before proceeding.',
  };

  const html = renderToStaticMarkup(
    React.createElement(ThinkingCard, { block, t })
  );

  assert.match(html, /class="[^"]*thinking-card[^"]*thinking-collapsed[^"]*"/);
  assert.match(html, /Thought completed/);
  assert.doesNotMatch(html, /Step 1: Check git status/);
});

test('ThinkingCard: when defaultOpen is true, renders expanded with reasoning body', () => {
  const block: ThinkingBlock = {
    type: 'thinking',
    thinking: 'Detailed internal monologue...',
  };

  const html = renderToStaticMarkup(
    React.createElement(ThinkingCard, { block, t, defaultOpen: true })
  );

  assert.match(html, /class="[^"]*thinking-card[^"]*thinking-expanded[^"]*"/);
  assert.match(html, /Detailed internal monologue/);
});

test('ThinkingCard: while streaming, renders collapsed by default with thinking label and pulse icon', () => {
  const block: ThinkingBlock = {
    type: 'thinking',
    thinking: 'Partial thoughts streaming...',
    isStreaming: true,
  };

  const html = renderToStaticMarkup(
    React.createElement(ThinkingCard, { block, t })
  );

  assert.match(html, /class="[^"]*thinking-card[^"]*thinking-streaming[^"]*thinking-collapsed[^"]*"/);
  assert.match(html, /Thinking\.\.\./);
  assert.match(html, /thinking-pulse/);
  // Body is collapsed by default so user decides if they want to expand
  assert.doesNotMatch(html, /Partial thoughts streaming/);
});

test('ToolCard: renders collapsed by default showing tool name, formatted command, and status', () => {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: 'call-1',
    name: 'bash',
    args: { command: 'git status --short' },
    status: 'completed',
    output: 'M src/app/App.tsx',
  };

  const html = renderToStaticMarkup(
    React.createElement(ToolCard, { block, t })
  );

  assert.match(html, /class="[^"]*tool-card[^"]*tool-card-collapsed[^"]*"/);
  assert.match(html, /git status --short/);
  assert.match(html, /Completed/);
  // Body (output) is collapsed by default
  assert.doesNotMatch(html, /M src\/app\/App\.tsx/);
});

test('Sequential rendering: blocks appear in exact chronological order without category grouping', () => {
  const blocks: MessageBlock[] = [
    { type: 'thinking', thinking: 'First I will check git status' },
    {
      type: 'tool_call',
      id: 'call-bash-1',
      name: 'bash',
      args: { command: 'git status' },
      status: 'completed',
      output: 'clean',
    },
    { type: 'thinking', thinking: 'Now I will read the file' },
    {
      type: 'tool_call',
      id: 'call-read-1',
      name: 'read',
      args: { path: 'src/main.ts' },
      status: 'completed',
      output: 'console.log("hello");',
    },
    {
      type: 'tool_call',
      id: 'call-bash-2',
      name: 'bash',
      args: { command: 'npm test' },
      status: 'completed',
      output: 'ok',
    },
  ];

  // Render sequentially as in App.tsx
  const renderedElements = blocks.map((block, idx) => {
    if (block.type === 'thinking') {
      return React.createElement(ThinkingCard, { key: `thinking-${idx}`, block, t });
    }
    if (block.type === 'tool_call') {
      return React.createElement(ToolCard, { key: block.id, block, t });
    }
    return null;
  });

  const html = renderToStaticMarkup(
    React.createElement('div', { className: 'activity-blocks' }, ...renderedElements)
  );

  // Check that the sequence of elements matches the execution timeline:
  // bash-1 comes before read-1, which comes before bash-2
  const bash1Index = html.indexOf('git status');
  const read1Index = html.indexOf('src/main.ts');
  const bash2Index = html.indexOf('npm test');

  assert.ok(bash1Index !== -1, 'git status found');
  assert.ok(read1Index !== -1, 'src/main.ts found');
  assert.ok(bash2Index !== -1, 'npm test found');

  assert.ok(bash1Index < read1Index, 'First bash precedes read in the timeline');
  assert.ok(read1Index < bash2Index, 'Read precedes second bash in the timeline');

  // Verify that category grouping containers like process-group-card are absent
  assert.doesNotMatch(html, /class="[^"]*process-group-card[^"]*"/);
  assert.doesNotMatch(html, /class="[^"]*process-group-categories[^"]*"/);
});

test('mergeConsecutiveAssistantMessages: merges sequential assistant messages preserving block order', () => {
  const msg1: ChatMessage = {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: '10:00:00',
    blocks: [
      { type: 'thinking', thinking: 'Check branch' },
      { type: 'tool_call', id: 'c1', name: 'bash', args: { command: 'git branch' }, status: 'completed' },
    ],
  };
  const msg2: ChatMessage = {
    id: 'msg-2',
    role: 'assistant',
    content: '',
    timestamp: '10:00:05',
    blocks: [
      { type: 'thinking', thinking: 'Read code' },
      { type: 'tool_call', id: 'c2', name: 'read', args: { path: 'file.txt' }, status: 'completed' },
    ],
  };

  const merged = mergeConsecutiveAssistantMessages([msg1, msg2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'msg-1');
  assert.ok(merged[0].blocks);
  assert.equal(merged[0].blocks?.length, 4);
  assert.equal((merged[0].blocks[0] as ThinkingBlock).thinking, 'Check branch');
  assert.equal((merged[0].blocks[1] as ToolCallBlock).name, 'bash');
  assert.equal((merged[0].blocks[2] as ThinkingBlock).thinking, 'Read code');
  assert.equal((merged[0].blocks[3] as ToolCallBlock).name, 'read');
});
