import { test } from 'node:test';
import assert from 'node:assert';
import { groupChatMessages, isProcessOnlyAssistantMessage } from '@core/process-grouping';
import type { ChatMessage } from '@core/types/messages';

test('Process grouping: correctly detects pure process messages without text', () => {
  const pureToolMessage: ChatMessage = {
    id: 'msg-tool-1',
    role: 'assistant',
    content: '',
    timestamp: '12:00:00',
    blocks: [
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'grep',
        args: { pattern: 'test' },
        status: 'completed',
        isError: false,
      },
    ],
  };

  const conversationalMessage: ChatMessage = {
    id: 'msg-text-1',
    role: 'assistant',
    content: 'Here is the result of the investigation.',
    timestamp: '12:00:05',
    blocks: [
      {
        type: 'text',
        text: 'Here is the result of the investigation.',
      },
    ],
  };

  const mixedMessage: ChatMessage = {
    id: 'msg-mixed-1',
    role: 'assistant',
    content: 'Let me execute this command:',
    timestamp: '12:00:10',
    blocks: [
      {
        type: 'text',
        text: 'Let me execute this command:',
      },
      {
        type: 'tool_call',
        id: 'call-2',
        name: 'bash',
        args: { command: 'ls' },
        status: 'completed',
        isError: false,
      },
    ],
  };

  // Pure tool message should be identified as process-only
  assert.strictEqual(isProcessOnlyAssistantMessage(pureToolMessage), true);

  // Conversational message should not be process-only
  assert.strictEqual(isProcessOnlyAssistantMessage(conversationalMessage), false);

  // Mixed message with both text and tool call should not be process-only
  assert.strictEqual(isProcessOnlyAssistantMessage(mixedMessage), false);
});

test('Process grouping: groups consecutive tool-only messages cleanly without separating text', () => {
  const messages: ChatMessage[] = [
    {
      id: 'm-user',
      role: 'user',
      content: 'Run check',
      timestamp: '10:00:00',
    },
    {
      id: 'm-tool-1',
      role: 'assistant',
      content: '',
      timestamp: '10:00:01',
      blocks: [{ type: 'tool_call', id: 'c-1', name: 'grep', status: 'completed', isError: false }],
    },
    {
      id: 'm-tool-2',
      role: 'assistant',
      content: '',
      timestamp: '10:00:02',
      blocks: [{ type: 'tool_call', id: 'c-2', name: 'read', status: 'completed', isError: false }],
    },
    {
      id: 'm-reply',
      role: 'assistant',
      content: 'Done!',
      timestamp: '10:00:05',
      blocks: [{ type: 'text', text: 'Done!' }],
    },
  ];

  const grouped = groupChatMessages(messages, true);

  // User message, then one consolidated process group for tool calls, then final assistant reply
  assert.strictEqual(grouped.length, 3);
  assert.strictEqual(grouped[0].type, 'message');
  assert.strictEqual(grouped[0].message.role, 'user');

  assert.strictEqual(grouped[1].type, 'process_group');
  if (grouped[1].type === 'process_group') {
    assert.strictEqual(grouped[1].items.length, 2);
  }

  assert.strictEqual(grouped[2].type, 'message');
  assert.strictEqual(grouped[2].message.role, 'assistant');
  assert.strictEqual(grouped[2].message.content, 'Done!');
});
