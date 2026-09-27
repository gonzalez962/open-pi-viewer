import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categorizeBlock,
  categorizeToolName,
  groupChatMessages,
  groupMessageBlocks,
  type ProcessGroup,
} from '@core/process-grouping';
import type { ChatMessage, MessageBlock, ThinkingBlock, ToolCallBlock } from '@core/types/messages';

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

function thinking(overrides: Partial<ThinkingBlock> = {}): ThinkingBlock {
  return { type: 'thinking', thinking: 'reasoning...', ...overrides };
}

test('categorizeToolName: bash-family tool names', () => {
  assert.equal(categorizeToolName('bash'), 'bash');
  assert.equal(categorizeToolName('powershell'), 'bash');
  assert.equal(categorizeToolName('Shell'), 'bash');
});

test('categorizeToolName: edit', () => {
  assert.equal(categorizeToolName('edit'), 'edit');
  assert.equal(categorizeToolName('MultiEdit'), 'edit');
});

test('categorizeToolName: read', () => {
  assert.equal(categorizeToolName('read'), 'read');
});

test('categorizeToolName: write', () => {
  assert.equal(categorizeToolName('write'), 'write');
});

test('categorizeToolName: search-like tools (grep/find/ls/glob/search)', () => {
  assert.equal(categorizeToolName('grep'), 'search');
  assert.equal(categorizeToolName('find'), 'search');
  assert.equal(categorizeToolName('ls'), 'search');
  assert.equal(categorizeToolName('glob'), 'search');
  assert.equal(categorizeToolName('web_search'), 'search');
  assert.equal(categorizeToolName('grep_tool'), 'search');
});

test('categorizeToolName: agent/subagent/task tools', () => {
  assert.equal(categorizeToolName('task'), 'agents');
  assert.equal(categorizeToolName('subagent'), 'agents');
  assert.equal(categorizeToolName('run_agent'), 'agents');
});

test('categorizeToolName: unknown tool falls back to other', () => {
  assert.equal(categorizeToolName('mystery_tool'), 'other');
  assert.equal(categorizeToolName(''), 'other');
  assert.equal(categorizeToolName(undefined), 'other');
});

test('categorizeBlock: thinking block is always thinking category', () => {
  assert.equal(categorizeBlock(thinking()), 'thinking');
});

test('categorizeBlock: tool_call block delegates to categorizeToolName', () => {
  assert.equal(categorizeBlock(tool('bash')), 'bash');
  assert.equal(categorizeBlock(tool('unknown_thing')), 'other');
});

test('groupMessageBlocks: empty array yields no items', () => {
  assert.deepEqual(groupMessageBlocks([]), []);
});

test('groupMessageBlocks: a single text block passes through unchanged, no group', () => {
  const blocks: MessageBlock[] = [{ type: 'text', text: 'hello' }];
  const items = groupMessageBlocks(blocks);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'block');
  assert.deepEqual((items[0] as { type: 'block'; block: MessageBlock }).block, blocks[0]);
});

test('groupMessageBlocks: consecutive process blocks merge into one ProcessGroup', () => {
  const blocks: MessageBlock[] = [thinking(), tool('bash'), tool('read'), tool('edit')];
  const items = groupMessageBlocks(blocks);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'process_group');
  const group = items[0] as ProcessGroup;
  assert.equal(group.total, 4);
  assert.deepEqual(group.categoryOrder, ['thinking', 'bash', 'read', 'edit']);
  assert.deepEqual(group.counts, { thinking: 1, bash: 1, read: 1, edit: 1 });
  assert.equal(group.hasError, false);
});

test('groupMessageBlocks: a text block breaks the group into two separate groups', () => {
  const blocks: MessageBlock[] = [
    tool('bash'),
    tool('read'),
    { type: 'text', text: 'summary so far' },
    tool('edit'),
    tool('write'),
  ];
  const items = groupMessageBlocks(blocks);
  assert.equal(items.length, 3);
  assert.equal(items[0].type, 'process_group');
  assert.equal((items[0] as ProcessGroup).total, 2);
  assert.equal(items[1].type, 'block');
  assert.equal(items[2].type, 'process_group');
  assert.equal((items[2] as ProcessGroup).total, 2);
  assert.deepEqual((items[2] as ProcessGroup).categoryOrder, ['edit', 'write']);
});

test('groupMessageBlocks: repeated categories count correctly and dedupe categoryOrder', () => {
  const blocks: MessageBlock[] = [tool('bash'), tool('bash'), tool('read'), tool('bash')];
  const items = groupMessageBlocks(blocks);
  const group = items[0] as ProcessGroup;
  assert.deepEqual(group.categoryOrder, ['bash', 'read']);
  assert.deepEqual(group.counts, { bash: 3, read: 1 });
  assert.equal(group.total, 4);
});

test('groupMessageBlocks: a group with an error tool_call sets hasError true', () => {
  const blocks: MessageBlock[] = [tool('bash'), tool('read', { isError: true, status: 'error' })];
  const group = groupMessageBlocks(blocks)[0] as ProcessGroup;
  assert.equal(group.hasError, true);
});

test('groupMessageBlocks: multiple text blocks in a row produce no empty groups between them', () => {
  const blocks: MessageBlock[] = [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ];
  const items = groupMessageBlocks(blocks);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.type === 'block'));
});

test('groupMessageBlocks: group ids are unique and stable within a call', () => {
  const blocks: MessageBlock[] = [
    tool('bash'),
    { type: 'text', text: 'break' },
    tool('read'),
  ];
  const items = groupMessageBlocks(blocks);
  const groups = items.filter((i) => i.type === 'process_group') as ProcessGroup[];
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].id, groups[1].id);
});

test('groupChatMessages: groups blocks per message, leaves messages without blocks alone', () => {
  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: '10:00',
      blocks: [tool('bash'), tool('read'), { type: 'text', text: 'done' }],
    },
    {
      id: 'm2',
      role: 'user',
      content: 'hello',
      timestamp: '10:01',
    },
  ];

  const grouped = groupChatMessages(messages);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].message.id, 'm1');
  assert.equal(grouped[0].renderItems.length, 2);
  assert.equal(grouped[0].renderItems[0].type, 'process_group');
  assert.equal(grouped[1].message.id, 'm2');
  assert.deepEqual(grouped[1].renderItems, []);
});

test('groupChatMessages: empty messages array yields empty array', () => {
  assert.deepEqual(groupChatMessages([]), []);
});
