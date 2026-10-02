import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categorizeProcess,
  createProcessGroup,
  extractProcessItemsFromMessage,
  groupChatMessages,
  isInteractiveUserTool,
  isProcessOnlyAssistantMessage,
} from '@core/process-grouping';
import type { ChatMessage } from '@core/types/messages';

test('process-grouping: categorizeProcess identifies categories accurately', () => {
  // bash
  assert.equal(categorizeProcess({ type: 'tool_call', id: '1', name: 'bash', status: 'completed' }), 'bash');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '2', name: 'powershell', status: 'completed' }), 'bash');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '3', name: 'sh', status: 'completed' }), 'bash');

  // edit
  assert.equal(categorizeProcess({ type: 'tool_call', id: '4', name: 'edit', status: 'completed' }), 'edit');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '5', name: 'patch', status: 'completed' }), 'edit');

  // read
  assert.equal(categorizeProcess({ type: 'tool_call', id: '6', name: 'read', status: 'completed' }), 'read');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '7', name: 'read_workspace_file', status: 'completed' }), 'read');

  // write
  assert.equal(categorizeProcess({ type: 'tool_call', id: '8', name: 'write', status: 'completed' }), 'write');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '9', name: 'create_file', status: 'completed' }), 'write');

  // search
  assert.equal(categorizeProcess({ type: 'tool_call', id: '10', name: 'grep', status: 'completed' }), 'search');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '11', name: 'find', status: 'completed' }), 'search');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '12', name: 'codegraph', status: 'completed' }), 'search');

  // agents
  assert.equal(categorizeProcess({ type: 'tool_call', id: '13', name: 'subagent_run', status: 'completed' }), 'agents');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '14', name: 'subagent_status', status: 'completed' }), 'agents');
  assert.equal(categorizeProcess({ type: 'tool_call', id: '15', name: 'agent', status: 'completed' }), 'agents');

  // thinking
  assert.equal(categorizeProcess({ type: 'thinking', thinking: 'Let me analyze...' }), 'thinking');

  // other
  assert.equal(categorizeProcess({ type: 'tool_call', id: '16', name: 'web_search', status: 'completed' }), 'other');
});

test('process-grouping: isProcessOnlyAssistantMessage discriminates process-only vs text messages', () => {
  const userMsg: ChatMessage = {
    id: 'u1',
    role: 'user',
    content: 'hello',
    timestamp: '12:00',
  };
  assert.equal(isProcessOnlyAssistantMessage(userMsg), false);

  const processOnlyMsg: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: '12:01',
    blocks: [
      { type: 'tool_call', id: 't1', name: 'bash', status: 'completed' },
    ],
  };
  assert.equal(isProcessOnlyAssistantMessage(processOnlyMsg), true);

  const textMsg: ChatMessage = {
    id: 'a2',
    role: 'assistant',
    content: 'Here is your answer!',
    timestamp: '12:02',
  };
  assert.equal(isProcessOnlyAssistantMessage(textMsg), false);

  const mixedMsg: ChatMessage = {
    id: 'a3',
    role: 'assistant',
    content: 'Executing task now...',
    timestamp: '12:03',
    blocks: [
      { type: 'text', text: 'Executing task now...' },
      { type: 'tool_call', id: 't2', name: 'read', status: 'completed' },
    ],
  };
  assert.equal(isProcessOnlyAssistantMessage(mixedMsg), false);
});

test('process-grouping: groupChatMessages combines consecutive process messages into a single ProcessGroup', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Fix the bug', timestamp: '10:00' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '10:01',
      blocks: [{ type: 'tool_call', id: 't1', name: 'read', status: 'completed' }],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      timestamp: '10:02',
      blocks: [
        { type: 'thinking', thinking: 'Analyzing the code...' },
        { type: 'tool_call', id: 't2', name: 'edit', status: 'completed' },
      ],
    },
    {
      id: 'a3',
      role: 'assistant',
      content: '',
      timestamp: '10:03',
      blocks: [{ type: 'tool_call', id: 't3', name: 'bash', status: 'completed' }],
    },
    {
      id: 'a4',
      role: 'assistant',
      content: 'I fixed the issue!',
      timestamp: '10:04',
    },
  ];

  const grouped = groupChatMessages(messages, true);

  // Expect: User message -> ProcessGroup (combining a1, a2, a3) -> Final text message
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].type, 'message');
  assert.equal(grouped[1].type, 'process_group');
  assert.equal(grouped[2].type, 'message');

  if (grouped[1].type === 'process_group') {
    assert.equal(grouped[1].totalCount, 4); // read, thinking, edit, bash
    assert.deepEqual(grouped[1].categoriesPresent, ['bash', 'edit', 'read', 'thinking']);
    assert.equal(grouped[1].byCategory.read.length, 1);
    assert.equal(grouped[1].byCategory.thinking.length, 1);
    assert.equal(grouped[1].byCategory.edit.length, 1);
    assert.equal(grouped[1].byCategory.bash.length, 1);
  }
});

test('process-grouping: extractProcessItemsFromMessage and createProcessGroup form structured groups', () => {
  const msg: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: '10:00',
    blocks: [
      { type: 'tool_call', id: 't1', name: 'bash', status: 'completed' },
      { type: 'tool_call', id: 't2', name: 'subagent_run', status: 'running' },
    ],
  };

  const items = extractProcessItemsFromMessage(msg);
  assert.equal(items.length, 2);
  assert.equal(items[0].category, 'bash');
  assert.equal(items[1].category, 'agents');

  const group = createProcessGroup('group-1', items, '10:00');
  assert.equal(group.totalCount, 2);
  assert.equal(group.hasRunning, true);
  assert.equal(group.hasErrors, false);
  assert.deepEqual(group.categoriesPresent, ['agents', 'bash']);
});

test('process-grouping: isInteractiveUserTool identifies interactive decision tools and excludes them from process groups', () => {
  assert.equal(isInteractiveUserTool('ask_user_question'), true);
  assert.equal(isInteractiveUserTool('ask_user_choice'), true);
  assert.equal(isInteractiveUserTool('ask_user_confirmation'), true);
  assert.equal(isInteractiveUserTool('question'), true);
  assert.equal(isInteractiveUserTool('bash'), false);
  assert.equal(isInteractiveUserTool('read'), false);
  assert.equal(isInteractiveUserTool('edit'), false);
  assert.equal(isInteractiveUserTool('subagent_run'), false);

  // A message containing ask_user_question is NOT process-only
  const interactiveMsg: ChatMessage = {
    id: 'ai-1',
    role: 'assistant',
    content: '',
    timestamp: '10:05',
    blocks: [
      {
        type: 'tool_call',
        id: 't-ask',
        name: 'ask_user_question',
        args: { questions: [{ question: 'Coffee or tea?' }] },
        status: 'running',
      },
    ],
  };
  assert.equal(isProcessOnlyAssistantMessage(interactiveMsg), false);

  // extractProcessItemsFromMessage excludes interactive tools
  const items = extractProcessItemsFromMessage(interactiveMsg);
  assert.equal(items.length, 0);

  // groupChatMessages preserves interactive tool messages uncollapsed
  const turnWithInteractive: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Install this', timestamp: '10:00' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '10:01',
      blocks: [{ type: 'tool_call', id: 't1', name: 'bash', status: 'completed' }],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      timestamp: '10:02',
      blocks: [{ type: 'tool_call', id: 't2', name: 'read', status: 'completed' }],
    },
    interactiveMsg,
  ];

  const grouped = groupChatMessages(turnWithInteractive, true);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].type, 'message'); // user
  assert.equal(grouped[1].type, 'process_group'); // bash + read
  assert.equal(grouped[2].type, 'message'); // interactive message
  if (grouped[1].type === 'process_group') {
    assert.equal(grouped[1].totalCount, 2);
  }
  if (grouped[2].type === 'message') {
    assert.equal(grouped[2].message.blocks?.[0].type, 'tool_call');
    assert.equal((grouped[2].message.blocks?.[0] as any).name, 'ask_user_question');
  }
});
