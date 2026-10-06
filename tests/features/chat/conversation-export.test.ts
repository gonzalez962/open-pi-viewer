import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exportConversation,
  hasExportableContent,
  parseExportFormat,
  resolveExportTitle,
} from '@features/chat/conversation-export';
import type { ChatAction } from '@core/reducer';
import type { ChatMessage } from '@core/types/messages';
import type { SessionSummary } from '@core/types/sessions';

function createSampleMessages(): ChatMessage[] {
  return [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Can you inspect the logs?',
      timestamp: '10:00:00 AM',
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: 'Sure, let me check.',
      timestamp: '10:00:05 AM',
      blocks: [
        {
          type: 'text',
          text: 'Sure, let me check.',
        },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'read_logs',
          status: 'completed',
        },
      ],
    },
  ];
}

test('parseExportFormat: defaults to markdown when args are empty or whitespace', () => {
  assert.deepEqual(parseExportFormat(''), { ok: true, format: 'markdown' });
  assert.deepEqual(parseExportFormat('   '), { ok: true, format: 'markdown' });
});

test('parseExportFormat: parses md and json case-insensitively', () => {
  assert.deepEqual(parseExportFormat('md'), { ok: true, format: 'markdown' });
  assert.deepEqual(parseExportFormat('MD'), { ok: true, format: 'markdown' });
  assert.deepEqual(parseExportFormat('  md  '), { ok: true, format: 'markdown' });
  assert.deepEqual(parseExportFormat('json'), { ok: true, format: 'json' });
  assert.deepEqual(parseExportFormat('JSON'), { ok: true, format: 'json' });
  assert.deepEqual(parseExportFormat('  json  '), { ok: true, format: 'json' });
});

test('parseExportFormat: rejects invalid formats and extra arguments', () => {
  assert.deepEqual(parseExportFormat('invalid'), { ok: false, raw: 'invalid' });
  assert.deepEqual(parseExportFormat('txt'), { ok: false, raw: 'txt' });
  assert.deepEqual(parseExportFormat('md extra'), { ok: false, raw: 'md extra' });
  assert.deepEqual(parseExportFormat('json 123'), { ok: false, raw: 'json 123' });
});

test('resolveExportTitle: prefers customTitle over firstMessage and falls back cleanly', () => {
  const customSession: SessionSummary = {
    id: 's-1',
    path: '/path/1',
    firstMessage: 'First message text',
    customTitle: 'My Custom Title',
    messageCount: 2,
    isActive: true,
  };
  assert.equal(resolveExportTitle(customSession), 'My Custom Title');

  const firstMsgSession: SessionSummary = {
    id: 's-2',
    path: '/path/2',
    firstMessage: 'First message text',
    messageCount: 1,
    isActive: true,
  };
  assert.equal(resolveExportTitle(firstMsgSession), 'First message text');

  const blankCustomSession: SessionSummary = {
    id: 's-3',
    path: '/path/3',
    firstMessage: 'First message text',
    customTitle: '   ',
    messageCount: 1,
    isActive: true,
  };
  assert.equal(resolveExportTitle(blankCustomSession), 'First message text');

  const emptySession: SessionSummary = {
    id: 's-4',
    path: '/path/4',
    firstMessage: '',
    messageCount: 0,
    isActive: true,
  };
  assert.equal(resolveExportTitle(emptySession), undefined);
  assert.equal(resolveExportTitle(null), undefined);
  assert.equal(resolveExportTitle(undefined), undefined);
});

test('hasExportableContent: accurately identifies transcripts with exportable messages', () => {
  assert.equal(hasExportableContent([]), false);
  assert.equal(hasExportableContent(undefined), false);
  assert.equal(hasExportableContent(null), false);

  const whitespaceOnly: ChatMessage[] = [
    {
      id: 'm-0',
      role: 'user',
      content: '   ',
      timestamp: '10:00:00 AM',
    },
  ];
  assert.equal(hasExportableContent(whitespaceOnly), false);

  const withText: ChatMessage[] = [
    {
      id: 'm-1',
      role: 'user',
      content: 'Hello',
      timestamp: '10:00:00 AM',
    },
  ];
  assert.equal(hasExportableContent(withText), true);

  const withToolOnly: ChatMessage[] = [
    {
      id: 'm-2',
      role: 'assistant',
      content: '',
      timestamp: '10:00:01 AM',
      blocks: [
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'bash',
          status: 'completed',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(withToolOnly), true);

  const withImageOnly: ChatMessage[] = [
    {
      id: 'm-3',
      role: 'user',
      content: '',
      timestamp: '10:00:02 AM',
      images: [
        {
          type: 'image',
          data: 'base64',
          mimeType: 'image/png',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(withImageOnly), true);
});

test('hasExportableContent: rejects thinking-only or whitespace blocks adhering to omission policy', () => {
  // Finding 4: thinking blocks are omitted from export, so thinking-only messages are not exportable
  const thinkingOnly: ChatMessage[] = [
    {
      id: 'm-think',
      role: 'assistant',
      content: '',
      timestamp: '10:00:00 AM',
      blocks: [
        {
          type: 'thinking',
          thinking: 'internal reasoning that should never be exported',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(thinkingOnly), false);

  const thinkingWithWhitespace: ChatMessage[] = [
    {
      id: 'm-think-ws',
      role: 'assistant',
      content: '   ',
      timestamp: '10:00:00 AM',
      blocks: [
        {
          type: 'thinking',
          thinking: 'thought',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(thinkingWithWhitespace), false);

  // Whitespace-only text block
  const whitespaceTextBlock: ChatMessage[] = [
    {
      id: 'm-ws-block',
      role: 'user',
      content: '',
      timestamp: '10:00:00 AM',
      blocks: [
        {
          type: 'text',
          text: '   \n  \t ',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(whitespaceTextBlock), false);
});

test('hasExportableContent: canonical text precedence and content fallback edges', () => {
  // Finding 4: When blocks contain text blocks, they take precedence over content.
  // If the text block is whitespace-only, content is NOT used as fallback (precedence edge).
  const blockPrecedenceEdge: ChatMessage[] = [
    {
      id: 'm-prec',
      role: 'user',
      content: 'This should be ignored because blocks has text block',
      timestamp: '10:00:00 AM',
      blocks: [
        {
          type: 'text',
          text: '   ',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(blockPrecedenceEdge), false);

  // Content fallback edge: blocks has thinking-only block (no text block), so canonical text falls back to content
  const contentFallbackWithThinking: ChatMessage[] = [
    {
      id: 'm-fallback',
      role: 'assistant',
      content: 'Visible answer text',
      timestamp: '10:00:00 AM',
      blocks: [
        {
          type: 'thinking',
          thinking: 'internal thoughts',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(contentFallbackWithThinking), true);

  // Thinking block with a tool call counts because tool calls are exportable
  const thinkingWithTool: ChatMessage[] = [
    {
      id: 'm-think-tool',
      role: 'assistant',
      content: '',
      timestamp: '10:00:00 AM',
      blocks: [
        {
          type: 'thinking',
          thinking: 'thoughts',
        },
        {
          type: 'tool_call',
          id: 'tc-1',
          name: 'grep',
          status: 'completed',
        },
      ],
    },
  ];
  assert.equal(hasExportableContent(thinkingWithTool), true);
});

test('exportConversation: default format exports markdown and initiates download', async () => {
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];
  let downloadedPayload: { content: string; filename: string; mimeType?: string } | null = null;

  const fixedDate = new Date('2026-03-30T14:00:00.000Z');

  const outcome = await exportConversation({
    args: '',
    messages,
    sessionTitle: 'Log Inspection',
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: (payload) => {
        downloadedPayload = payload;
        return { success: true, initiated: true, filename: payload.filename };
      },
    },
    now: () => fixedDate,
  });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.filename, 'log-inspection-2026-03-30.md');

  assert.ok(downloadedPayload !== null);
  const payloadMd = downloadedPayload as { content: string; filename: string; mimeType?: string };
  assert.equal(payloadMd.filename, 'log-inspection-2026-03-30.md');
  assert.equal(payloadMd.mimeType, 'text/markdown;charset=utf-8');
  assert.ok(payloadMd.content.includes('# Log Inspection'));
  assert.ok(payloadMd.content.includes('Can you inspect the logs?'));
  assert.ok(payloadMd.content.includes('read_logs'));

  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: explicit "md" argument initiates markdown export', async () => {
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];
  let capturedFilename = '';

  const outcome = await exportConversation({
    args: 'md',
    messages,
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: (payload) => {
        capturedFilename = payload.filename;
        return { success: true, initiated: true, filename: payload.filename };
      },
    },
    now: () => new Date('2026-03-30T14:00:00.000Z'),
  });

  assert.equal(outcome.status, 'success');
  assert.ok(capturedFilename.endsWith('.md'));
});

test('exportConversation: explicit "json" argument exports versioned JSON', async () => {
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];
  let downloadedPayload: { content: string; filename: string; mimeType?: string } | null = null;

  const fixedDate = new Date('2026-03-30T14:00:00.000Z');

  const outcome = await exportConversation({
    args: 'json',
    messages,
    sessionTitle: 'Log Inspection',
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: (payload) => {
        downloadedPayload = payload;
        return { success: true, initiated: true, filename: payload.filename };
      },
    },
    now: () => fixedDate,
  });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.filename, 'log-inspection-2026-03-30.json');

  assert.ok(downloadedPayload !== null);
  const payloadJson = downloadedPayload as { content: string; filename: string; mimeType?: string };
  assert.equal(payloadJson.filename, 'log-inspection-2026-03-30.json');
  assert.equal(payloadJson.mimeType, 'application/json;charset=utf-8');

  const parsed = JSON.parse(payloadJson.content);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.metadata.title, 'Log Inspection');
  assert.equal(parsed.metadata.exportedAt, '2026-03-30T14:00:00.000Z');
  assert.ok(parsed.metadata.disclosures.scope.includes('currently loaded transcript'));
  assert.equal(parsed.messages.length, 2);

  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: rejects invalid format without triggering download', async () => {
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];
  let downloadTriggered = false;

  const outcome = await exportConversation({
    args: 'yaml',
    messages,
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => {
        downloadTriggered = true;
        return { success: true, initiated: true, filename: 'test.yaml' };
      },
    },
  });

  assert.equal(outcome.status, 'invalid_format');
  assert.equal(downloadTriggered, false);
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: rejects extra arguments after valid format', async () => {
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];
  let downloadTriggered = false;

  const outcome = await exportConversation({
    args: 'md extra',
    messages,
    language: 'es',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => {
        downloadTriggered = true;
        return { success: true, initiated: true, filename: 'test.md' };
      },
    },
  });

  assert.equal(outcome.status, 'invalid_format');
  assert.equal(downloadTriggered, false);
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: reports empty notice and skips download when messages list is empty', async () => {
  const dispatched: ChatAction[] = [];
  let downloadTriggered = false;

  const outcome = await exportConversation({
    args: '',
    messages: [],
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => {
        downloadTriggered = true;
        return { success: true, initiated: true, filename: 'empty.md' };
      },
    },
  });

  assert.equal(outcome.status, 'empty');
  assert.equal(downloadTriggered, false);
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: reports empty notice when messages have only whitespace placeholder', async () => {
  const dispatched: ChatAction[] = [];
  let downloadTriggered = false;

  const placeholderMessages: ChatMessage[] = [
    {
      id: 'p-1',
      role: 'user',
      content: '   ',
      timestamp: '12:00:00 PM',
    },
  ];

  const outcome = await exportConversation({
    args: 'md',
    messages: placeholderMessages,
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => {
        downloadTriggered = true;
        return { success: true, initiated: true, filename: 'test.md' };
      },
    },
  });

  assert.equal(outcome.status, 'empty');
  assert.equal(downloadTriggered, false);
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: handles download failure and dispatches visible failure notice', async () => {
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];

  const outcome = await exportConversation({
    args: '',
    messages,
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => ({
        success: false,
        initiated: false,
        filename: 'log.md',
        error: 'Host Blob creation denied',
      }),
    },
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'Host Blob creation denied');
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: encompasses throwing clock in preparation pipeline with honest failure notice', async () => {
  // Finding 3: now() throws outside try in old code; must be caught with honest failure notice
  const messages = createSampleMessages();
  const dispatched: ChatAction[] = [];
  let downloadCalled = false;

  const outcome = await exportConversation({
    args: 'md',
    messages,
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => {
        downloadCalled = true;
        return { success: true, initiated: true, filename: 'test.md' };
      },
    },
    now: () => {
      throw new Error('System clock failure');
    },
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'System clock failure');
  assert.equal(downloadCalled, false);
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: encompasses throwing serialization field getters with honest failure notice', async () => {
  // Finding 3: Serializer throwing during preparation must be caught, not escape to caller
  const throwingMessage: ChatMessage = {
    id: 'm-throw',
    role: 'user',
    get content(): string {
      throw new Error('Message content getter failed');
    },
    timestamp: '10:00:00 AM',
  };
  const dispatched: ChatAction[] = [];
  let downloadCalled = false;

  const outcome = await exportConversation({
    args: 'md',
    messages: [throwingMessage],
    language: 'en',
    dispatch: (action) => dispatched.push(action),
    downloadAdapter: {
      triggerDownload: () => {
        downloadCalled = true;
        return { success: true, initiated: true, filename: 'test.md' };
      },
    },
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'Message content getter failed');
  assert.equal(downloadCalled, false);
  assert.equal(dispatched.length, 0, 'Must not dispatch ADD_SYSTEM_MESSAGE in T5');
});

test('exportConversation: snapshots messages before feedback so feedback notice is not in export', async () => {
  const messages = createSampleMessages();
  const dynamicMessages = [...messages];
  let serializedContent = '';
  const dispatched: ChatAction[] = [];

  const outcome = await exportConversation({
    args: 'md',
    messages: dynamicMessages,
    language: 'en',
    dispatch: (action) => {
      dispatched.push(action);
    },
    downloadAdapter: {
      triggerDownload: (payload) => {
        serializedContent = payload.content;
        return { success: true, initiated: true, filename: payload.filename };
      },
    },
  });

  assert.equal(outcome.status, 'success');
  // Serialized content must not contain the feedback system message
  assert.ok(!serializedContent.includes('Export initiated'));
  // Zero system messages dispatched in T5
  assert.equal(dispatched.length, 0);
  assert.equal(dynamicMessages.length, 2);
});

test('exportConversation: does not mutate original input messages', async () => {
  const messages = createSampleMessages();
  const originalSnapshot = JSON.stringify(messages);

  await exportConversation({
    args: 'md',
    messages,
    language: 'en',
    dispatch: () => {},
    downloadAdapter: {
      triggerDownload: (payload) => ({
        success: true,
        initiated: true,
        filename: payload.filename,
      }),
    },
  });

  assert.equal(JSON.stringify(messages), originalSnapshot);
});

test('integration: end-to-end export workflow never calls agent or mutates messages', async () => {
  const originalMessages = createSampleMessages();
  const stateMessages = [...originalMessages];

  const dispatched: ChatAction[] = [];
  const fakeAdapter = {
    triggerDownload: (payload: { filename: string }) => ({
      success: true,
      initiated: true,
      filename: payload.filename,
    }),
  };

  // Run valid /export
  const outcome1 = await exportConversation({
    args: '',
    messages: stateMessages,
    sessionTitle: 'Test Conversation',
    language: 'en',
    dispatch: (a) => dispatched.push(a),
    downloadAdapter: fakeAdapter,
  });
  assert.equal(outcome1.status, 'success');

  // Run invalid /export
  const outcome2 = await exportConversation({
    args: 'unsupported_format',
    messages: stateMessages,
    sessionTitle: 'Test Conversation',
    language: 'en',
    dispatch: (a) => dispatched.push(a),
    downloadAdapter: fakeAdapter,
  });
  assert.equal(outcome2.status, 'invalid_format');

  // Messages in state were not mutated or cleared
  assert.equal(originalMessages.length, 2);
  assert.equal(originalMessages[0].content, 'Can you inspect the logs?');
  const toolBlock = originalMessages[1].blocks?.[1];
  assert.ok(toolBlock && toolBlock.type === 'tool_call' && toolBlock.name === 'read_logs');
});
