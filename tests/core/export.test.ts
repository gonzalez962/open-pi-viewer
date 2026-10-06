import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPORT_SCHEMA_VERSION,
  EXPORT_DISCLOSURES,
  sanitizeExportFilename,
  generateExportFilename,
  exportToMarkdown,
  exportToJson,
  isExportableTranscript,
} from '@core/export';
import type {
  ConversationJsonExport,
} from '@core/types/export';
import type { ChatMessage } from '@core/types/messages';

// Unique canary strings to verify strict exclusion of private/sensitive data
const CANARY_THINKING_SECRET = 'CANARY_THINKING_SECRET_98765_DO_NOT_LEAK';
const CANARY_TOOL_ARG_TOKEN = 'CANARY_TOOL_ARG_TOKEN_sk_live_12345_SECRET';
const CANARY_TOOL_OUTPUT_DATA = 'CANARY_TOOL_OUTPUT_SECRET_DATABASE_PASSWORD_999';
const CANARY_IMAGE_BASE64_RAW = 'CANARY_IMAGE_BASE64_RAW_DATA_BLOB_XYZ1234567890';
const CANARY_INTERNAL_CWD = '/Users/sensitive/agent-working-directory/private-project';
const CANARY_SESSION_PATH = '/var/data/pi/sessions/session-internal-raw-uuid.jsonl';

// ============================================================================
// Group 1: Filename Sanitization & Generation
// ============================================================================

test('filename: sanitizeExportFilename cleans invalid chars, path separators, and controls', () => {
  const dirty = 'My Project / Session: 2026 *Special* <Test> | "Quotes" ? % `test` \u0000\u001f';
  const clean = sanitizeExportFilename(dirty);
  assert.equal(clean.includes('/'), false);
  assert.equal(clean.includes('\\'), false);
  assert.equal(clean.includes(':'), false);
  assert.equal(clean.includes('*'), false);
  assert.equal(clean.includes('?'), false);
  assert.equal(clean.includes('"'), false);
  assert.equal(clean.includes('<'), false);
  assert.equal(clean.includes('>'), false);
  assert.equal(clean.includes('|'), false);
  assert.equal(/[\u0000-\u001f]/.test(clean), false);
});

test('filename: sanitizeExportFilename strips path traversal sequences', () => {
  const traversal = '../../../../etc/passwd';
  const clean = sanitizeExportFilename(traversal);
  assert.equal(clean.includes('..'), false);
  assert.equal(clean.includes('/'), false);
});

test('filename: sanitizeExportFilename handles Windows reserved device names', () => {
  const reservedNames = [
    'CON', 'con', 'PRN', 'prn', 'AUX', 'aux', 'NUL', 'nul',
    'COM1', 'com1', 'COM9', 'LPT1', 'lpt1', 'LPT9',
    'CON.txt', 'nul.json', 'aux.md',
  ];

  for (const name of reservedNames) {
    const clean = sanitizeExportFilename(name);
    assert.notEqual(clean.toLowerCase(), 'con');
    assert.notEqual(clean.toLowerCase(), 'prn');
    assert.notEqual(clean.toLowerCase(), 'aux');
    assert.notEqual(clean.toLowerCase(), 'nul');
    assert.match(clean, /^[a-z0-9_-]+$/i);
  }
});

test('filename: sanitizeExportFilename removes trailing dots and spaces for Windows safety', () => {
  const trailing = 'my-export-name. . . ';
  const clean = sanitizeExportFilename(trailing);
  assert.equal(clean.endsWith('.'), false);
  assert.equal(clean.endsWith(' '), false);
  assert.ok(clean.length > 0);
});

test('filename: sanitizeExportFilename enforces length bounds and falls back on empty', () => {
  assert.equal(sanitizeExportFilename(''), 'pi-conversation');
  assert.equal(sanitizeExportFilename('   '), 'pi-conversation');
  assert.equal(sanitizeExportFilename(undefined), 'pi-conversation');
  assert.equal(sanitizeExportFilename('???***///'), 'pi-conversation');

  const veryLong = 'a'.repeat(300);
  const bounded = sanitizeExportFilename(veryLong);
  assert.ok(bounded.length <= 60);
});

test('filename: sanitizeExportFilename sanitizes fallback when title is missing or stripped', () => {
  // Traversal fallback is cleaned
  assert.equal(sanitizeExportFilename('', '../../etc/passwd'), 'etc-passwd');
  // Traversal-only fallback falls back to safe pi-conversation
  assert.equal(sanitizeExportFilename('', '../../..'), 'pi-conversation');
  // Whitespace-only fallback falls back to safe pi-conversation
  assert.equal(sanitizeExportFilename(undefined, '   '), 'pi-conversation');
  // Invalid chars in fallback fall back to safe pi-conversation
  assert.equal(sanitizeExportFilename('???', '///:::***'), 'pi-conversation');
  // Windows reserved name in fallback is prefixed
  assert.equal(sanitizeExportFilename('', 'CON'), 'session-con');
});

test('filename: sanitizeExportFilename enforces max 50 bound even with Windows reserved prefix', () => {
  const longReserved = 'con-' + 'a'.repeat(60);
  const sanitized = sanitizeExportFilename(longReserved);
  assert.ok(sanitized.length <= 50, `Length must be <= 50, got ${sanitized.length}`);
  assert.ok(sanitized.startsWith('session-con'), 'Must have reserved prefix');
});

test('filename: sanitizeExportFilename avoids clipping Unicode surrogate pairs at 50-char boundary', () => {
  // 49 ASCII characters + 1 emoji (surrogate pair of 2 code units) + extra
  const withEmoji = 'a'.repeat(49) + '🚀' + 'extra';
  const sanitized = sanitizeExportFilename(withEmoji);
  assert.ok(sanitized.length <= 50, `Length must be <= 50, got ${sanitized.length}`);
  // Verify string does not end with an orphaned high surrogate (0xD800 - 0xDBFF)
  const lastCode = sanitized.charCodeAt(sanitized.length - 1);
  assert.ok(lastCode < 0xd800 || lastCode > 0xdbff, 'Must not end with orphaned high surrogate');
});

test('filename: generateExportFilename uses deterministic epoch fallback without ambient clock access', () => {
  // When exportedAt is omitted, must deterministically return epoch 1970-01-01, never ambient date
  const nameNoDate = generateExportFilename({
    title: 'Default Clock Test',
    format: 'markdown',
  });
  assert.equal(nameNoDate, 'default-clock-test-1970-01-01.md');

  // When options is omitted entirely
  const defaultAll = generateExportFilename();
  assert.equal(defaultAll, 'pi-conversation-1970-01-01.md');
});

test('filename: generateExportFilename parses UTC offset consistently and validates calendar dates', () => {
  // Timezone offset 2026-01-01T01:00:00+05:00 is 2025-12-31T20:00:00Z in UTC
  const offsetName = generateExportFilename({
    title: 'Offset Test',
    exportedAt: '2026-01-01T01:00:00+05:00',
  });
  assert.equal(offsetName, 'offset-test-2025-12-31.md');

  // Impossible calendar date (February 31) must fall back to epoch
  const feb31Name = generateExportFilename({
    title: 'Feb 31 Test',
    exportedAt: '2026-02-31',
  });
  assert.equal(feb31Name, 'feb-31-test-1970-01-01.md');

  // Malformed date (9999-99-99) must fall back to epoch
  const malformedName = generateExportFilename({
    title: 'Malformed Test',
    exportedAt: '9999-99-99',
  });
  assert.equal(malformedName, 'malformed-test-1970-01-01.md');
});

test('filename: generateExportFilename handles Invalid Date object safely without throwing', () => {
  assert.doesNotThrow(() => {
    const invalidDateName = generateExportFilename({
      title: 'Invalid Date Object',
      exportedAt: new Date(NaN),
    });
    assert.equal(invalidDateName, 'invalid-date-object-1970-01-01.md');
  });
});

// ============================================================================
// Group 2: Empty Transcript Behavior & Validation
// ============================================================================

test('validation: isExportableTranscript detects empty or invalid message lists', () => {
  assert.equal(isExportableTranscript([]), false);
  assert.equal(isExportableTranscript(undefined), false);
  assert.equal(isExportableTranscript(null as unknown as ChatMessage[]), false);

  const validMessages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'hello', timestamp: '10:00' },
  ];
  assert.equal(isExportableTranscript(validMessages), true);
});

test('empty: exportToMarkdown and exportToJson handle empty messages gracefully', () => {
  const md = exportToMarkdown([], {
    title: 'Empty Chat',
    exportedAt: '2026-03-30T12:00:00.000Z',
  });
  assert.match(md, /Empty Chat/);
  assert.match(md, /No messages/i);
  assert.match(md, /Scope/i);

  const jsonStr = exportToJson([], {
    title: 'Empty Chat',
    exportedAt: '2026-03-30T12:00:00.000Z',
  });
  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.schemaVersion, EXPORT_SCHEMA_VERSION);
  assert.equal(parsed.metadata.messageCount, 0);
  assert.deepEqual(parsed.messages, []);
});

// ============================================================================
// Group 3: Privacy & Canary Protection (Zero Leakage)
// ============================================================================

test('privacy: Markdown export omits thinking blocks, tool args, tool outputs, and image base64', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Can you inspect the config?',
      timestamp: '10:00:00 AM',
      images: [
        {
          type: 'image',
          data: CANARY_IMAGE_BASE64_RAW,
          mimeType: 'image/png',
        },
      ],
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: 'Here is what I found.',
      timestamp: '10:00:05 AM',
      blocks: [
        {
          type: 'thinking',
          thinking: `Internal reasoning with sensitive data: ${CANARY_THINKING_SECRET}`,
        },
        {
          type: 'text',
          text: 'Here is what I found.',
        },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'read_file',
          args: { path: '/secret/key', token: CANARY_TOOL_ARG_TOKEN },
          status: 'completed',
          output: `Private output: ${CANARY_TOOL_OUTPUT_DATA}`,
        },
      ],
    },
  ];

  const md = exportToMarkdown(messages, {
    title: 'Canary Test',
    exportedAt: '2026-03-30T12:00:00.000Z',
  });

  // Verify canaries are STRICTLY absent
  assert.equal(md.includes(CANARY_THINKING_SECRET), false, 'Thinking secret must not appear in Markdown');
  assert.equal(md.includes(CANARY_TOOL_ARG_TOKEN), false, 'Tool args secret must not appear in Markdown');
  assert.equal(md.includes(CANARY_TOOL_OUTPUT_DATA), false, 'Tool output secret must not appear in Markdown');
  assert.equal(md.includes(CANARY_IMAGE_BASE64_RAW), false, 'Image base64 data must not appear in Markdown');
  assert.equal(md.includes(CANARY_INTERNAL_CWD), false, 'CWD path must not appear in Markdown');
  assert.equal(md.includes(CANARY_SESSION_PATH), false, 'Session store path must not appear in Markdown');

  // Verify allowed metadata is present
  assert.match(md, /read_file/);
  assert.match(md, /completed/);
  assert.match(md, /image\/png/);
  assert.match(md, /Here is what I found/);
});

test('privacy: JSON export omits thinking blocks, tool args, tool outputs, and image base64', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Upload image and run tool',
      timestamp: '10:00:00 AM',
      images: [
        {
          type: 'image',
          data: CANARY_IMAGE_BASE64_RAW,
          mimeType: 'image/jpeg',
        },
      ],
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: 'I did the work.',
      timestamp: '10:00:10 AM',
      blocks: [
        {
          type: 'thinking',
          thinking: CANARY_THINKING_SECRET,
        },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'bash_exec',
          args: CANARY_TOOL_ARG_TOKEN,
          status: 'error',
          output: CANARY_TOOL_OUTPUT_DATA,
        },
        {
          type: 'text',
          text: 'I did the work.',
        },
      ],
    },
  ];

  const jsonStr = exportToJson(messages, {
    title: 'JSON Canary Test',
    exportedAt: '2026-03-30T12:00:00.000Z',
  });

  // Strict canary absence
  assert.equal(jsonStr.includes(CANARY_THINKING_SECRET), false, 'Thinking secret must not appear in JSON');
  assert.equal(jsonStr.includes(CANARY_TOOL_ARG_TOKEN), false, 'Tool arg token must not appear in JSON');
  assert.equal(jsonStr.includes(CANARY_TOOL_OUTPUT_DATA), false, 'Tool output secret must not appear in JSON');
  assert.equal(jsonStr.includes(CANARY_IMAGE_BASE64_RAW), false, 'Image base64 must not appear in JSON');

  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.metadata.messageCount, 2);

  // Check user message image metadata
  const userMsg = parsed.messages[0];
  assert.equal(userMsg.images?.count, 1);
  assert.deepEqual(userMsg.images?.mimeTypes, ['image/jpeg']);
  assert.equal((userMsg.images as unknown as Record<string, unknown>).data, undefined);

  // Check assistant message tools
  const asstMsg = parsed.messages[1];
  assert.equal(asstMsg.tools?.length, 1);
  assert.equal(asstMsg.tools?.[0].name, 'bash_exec');
  assert.equal(asstMsg.tools?.[0].status, 'error');
  assert.equal((asstMsg.tools?.[0] as unknown as Record<string, unknown>).args, undefined);
  assert.equal((asstMsg.tools?.[0] as unknown as Record<string, unknown>).output, undefined);
  assert.equal((asstMsg as unknown as Record<string, unknown>).thinking, undefined);
});

// ============================================================================
// Group 4: Canonical Text Precedence & No Duplication
// ============================================================================

test('precedence: avoids duplicating text when message has both content and text blocks', () => {
  const repeatedText = 'This is the canonical assistant reply.';
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      role: 'assistant',
      content: repeatedText, // reducer stores accumulated text in content
      timestamp: '11:00:00 AM',
      blocks: [
        {
          type: 'text',
          text: repeatedText, // and also has it in blocks
        },
      ],
    },
  ];

  const md = exportToMarkdown(messages);
  // Count occurrences of repeatedText in md
  const matches = md.split(repeatedText).length - 1;
  assert.equal(matches, 1, 'Text must appear exactly once, never duplicated');

  const jsonStr = exportToJson(messages);
  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.messages[0].text, repeatedText);
});

test('precedence: preserves interleaved text and tool calls without dropping content', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      role: 'assistant',
      content: 'First part. Second part.',
      timestamp: '11:05:00 AM',
      blocks: [
        { type: 'text', text: 'First part.' },
        { type: 'tool_call', id: 'c1', name: 'search', status: 'completed' },
        { type: 'text', text: 'Second part.' },
      ],
    },
  ];

  const md = exportToMarkdown(messages);
  const firstIndex = md.indexOf('First part.');
  const toolIndex = md.indexOf('search');
  const secondIndex = md.indexOf('Second part.');

  assert.ok(firstIndex !== -1, 'First part should exist');
  assert.ok(toolIndex !== -1, 'Tool call should exist');
  assert.ok(secondIndex !== -1, 'Second part should exist');
  assert.ok(firstIndex < toolIndex, 'First part should precede tool call');
  assert.ok(toolIndex < secondIndex, 'Tool call should precede second part');
});

test('precedence: falls back to content when blocks contains only tool calls', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      role: 'assistant',
      content: 'Explanation of tool action.',
      timestamp: '11:10:00 AM',
      blocks: [
        { type: 'tool_call', id: 'c1', name: 'grep', status: 'completed' },
      ],
    },
  ];

  const md = exportToMarkdown(messages);
  assert.match(md, /Explanation of tool action\./);
  assert.match(md, /grep/);

  const jsonStr = exportToJson(messages);
  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.messages[0].text, 'Explanation of tool action.');
  assert.equal(parsed.messages[0].tools?.[0].name, 'grep');
});

// ============================================================================
// Group 5: Disclosures & Notice Requirements
// ============================================================================

test('disclosures: both Markdown and JSON explicitly disclose scope, omissions, and secret policy', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'test', timestamp: '12:00' },
  ];

  const md = exportToMarkdown(messages);
  assert.match(md, /Scope/i);
  assert.match(md, /Content Policy/i);
  assert.match(md, /redaction/i);

  const jsonStr = exportToJson(messages);
  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.metadata.disclosures.scope, EXPORT_DISCLOSURES.scope);
  assert.equal(parsed.metadata.disclosures.contentPolicy, EXPORT_DISCLOSURES.contentPolicy);
  assert.equal(parsed.metadata.disclosures.secretRedactionNotice, EXPORT_DISCLOSURES.secretRedactionNotice);
});

// ============================================================================
// Group 6: Text Formatting Robustness & No Executable HTML Injection
// ============================================================================

test('formatting: preserves user code fences and backticks without injecting executable HTML', () => {
  const complexContent = '```typescript\nconst x = "<script>alert(1)</script>";\n```\n`inline code` and <b>bold HTML</b>';
  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'user',
      content: complexContent,
      timestamp: '12:00',
    },
    {
      id: '2',
      role: 'assistant',
      content: 'Done',
      timestamp: '12:01',
      blocks: [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'dangerous<script>bad</script>',
          status: 'completed',
        },
        {
          type: 'text',
          text: 'Done',
        },
      ],
    },
  ];

  const md = exportToMarkdown(messages);
  // User content must be preserved
  assert.match(md, /```typescript/);
  assert.match(md, /`inline code`/);
  assert.match(md, /<b>bold HTML<\/b>/);

  // Serializer must not create unescaped executable HTML for tool names
  assert.equal(md.includes('<script>bad</script>'), false);
});

// ============================================================================
// Group 7: Input Immutability & Message Order
// ============================================================================

test('immutability: export does not mutate input array or message objects', () => {
  const originalMessages: ChatMessage[] = [
    Object.freeze({
      id: '1',
      role: 'user',
      content: 'First',
      timestamp: '10:00',
      images: [Object.freeze({ type: 'image', data: 'data', mimeType: 'image/png' })],
    }),
    Object.freeze({
      id: '2',
      role: 'assistant',
      content: 'Second',
      timestamp: '10:01',
      blocks: [
        Object.freeze({ type: 'thinking', thinking: 'thought' }),
        Object.freeze({ type: 'text', text: 'Second' }),
      ],
    }),
  ];

  const snapshot = JSON.stringify(originalMessages);

  // Run both exports
  exportToMarkdown(originalMessages);
  exportToJson(originalMessages);

  assert.equal(JSON.stringify(originalMessages), snapshot, 'Input messages must be untouched');
});

// ============================================================================
// Group 8: Triangulation & Edge Case Serialization
// ============================================================================

test('triangulate: tool call isError flag correctly maps to error status', () => {
  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: '13:00',
      blocks: [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'failing_tool',
          status: 'completed', // status was completed but isError is true
          isError: true,
          output: 'crash',
        },
      ],
    },
  ];

  const md = exportToMarkdown(messages);
  assert.match(md, /failing_tool/);
  assert.match(md, /status: error/);

  const jsonStr = exportToJson(messages);
  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.messages[0].tools?.[0].status, 'error');
});

test('triangulate: multiple images deduplicate mime types in summary', () => {
  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'user',
      content: 'multi image',
      timestamp: '13:05',
      images: [
        { type: 'image', data: 'd1', mimeType: 'image/png' },
        { type: 'image', data: 'd2', mimeType: 'image/png' },
        { type: 'image', data: 'd3', mimeType: 'image/jpeg' },
      ],
    },
  ];

  const md = exportToMarkdown(messages);
  assert.match(md, /3 \(image\/png, image\/jpeg\)/);

  const jsonStr = exportToJson(messages);
  const parsed = JSON.parse(jsonStr) as ConversationJsonExport;
  assert.equal(parsed.messages[0].images?.count, 3);
  assert.deepEqual(parsed.messages[0].images?.mimeTypes, ['image/png', 'image/jpeg']);
});

test('triangulate: invalid date string falls back to epoch safely in filename', () => {
  const filename = generateExportFilename({
    title: 'Safe Export',
    format: 'markdown',
    exportedAt: 'invalid-date-string',
  });
  assert.equal(filename, 'safe-export-1970-01-01.md');
});

test('triangulate: serializers use deterministic epoch fallback for absent, invalid, or impossible dates', () => {
  // Absent exportedAt -> deterministic 1970-01-01T00:00:00.000Z
  const mdDefault = exportToMarkdown([]);
  assert.match(mdDefault, /- \*\*Exported\*\*: 1970-01-01T00:00:00\.000Z/);

  const jsonDefault = JSON.parse(exportToJson([])) as ConversationJsonExport;
  assert.equal(jsonDefault.metadata.exportedAt, '1970-01-01T00:00:00.000Z');

  // Invalid Date object -> deterministic epoch fallback, must not throw
  assert.doesNotThrow(() => {
    const mdInv = exportToMarkdown([], { exportedAt: new Date(NaN) });
    assert.match(mdInv, /- \*\*Exported\*\*: 1970-01-01T00:00:00\.000Z/);

    const jsonInv = JSON.parse(exportToJson([], { exportedAt: new Date(NaN) })) as ConversationJsonExport;
    assert.equal(jsonInv.metadata.exportedAt, '1970-01-01T00:00:00.000Z');
  });

  // Timezone offset 2026-01-01T01:00:00+05:00 -> 2025-12-31T20:00:00.000Z
  const jsonOffset = JSON.parse(
    exportToJson([], { exportedAt: '2026-01-01T01:00:00+05:00' })
  ) as ConversationJsonExport;
  assert.equal(jsonOffset.metadata.exportedAt, '2025-12-31T20:00:00.000Z');

  // Impossible date (2026-02-31) -> deterministic epoch fallback
  const jsonFeb31 = JSON.parse(
    exportToJson([], { exportedAt: '2026-02-31' })
  ) as ConversationJsonExport;
  assert.equal(jsonFeb31.metadata.exportedAt, '1970-01-01T00:00:00.000Z');

  // Malformed date (9999-99-99) -> deterministic epoch fallback
  const jsonMalformed = JSON.parse(
    exportToJson([], { exportedAt: '9999-99-99' })
  ) as ConversationJsonExport;
  assert.equal(jsonMalformed.metadata.exportedAt, '1970-01-01T00:00:00.000Z');
});
