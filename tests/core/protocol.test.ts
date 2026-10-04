import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { formatToolPrimaryArg } from '@features/chat/ActivityBlocks';
import {
  abortPi,
  buildSendPromptArgs,
  connectPi,
  disconnectPi,
  ensureBridgeListenersReady,
  getMessagesPi,
  listSessionsPi,
  newSessionPi,
  switchSessionPi,
  sendPromptPi,
  sendExtensionUiResponsePi,
  getAvailableModelsPi,
  setModelPi,
  getAvailableThinkingLevelsPi,
  setThinkingLevelPi,
  getSessionStatsPi,
} from '@infra/bridge';
import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  isAbsolutePath,
  isConfigReady,
  loadConnectConfig,
  saveConnectConfig,
  validateConnectConfig,
} from '@features/settings/config';
import { canRetryConnection, StartupManager } from '@features/settings/connection';
import type { ConnectConfig } from '@core/types/connection';
import {
  createExtensionUiCancelResponse,
  createExtensionUiResponse,
  defaultDialogAdapter,
  extractChatTextDelta,
  extractImagesFromMessage,
  extractTextFromContent,
  extractThinkingDelta,
  extractToolCallDelta,
  extractToolOutput,
  generatePromptRequestId,
  getSafePreviewImageSrc,
  isDialogExtensionUiRequest,
  isSupportedDialogExtensionUiRequest,
  isToolExecutionEndEvent,
  isToolExecutionStartEvent,
  isToolExecutionUpdateEvent,
  isValidPromptRequestId,
  JsonlParser,
  parseMessageBlocks,
  parseSelectChoice,
  PROMPT_REQUEST_ID_PREFIX,
  type ExtensionUiDialogAdapter,
} from '@core/protocol';
import { chatReducer, INITIAL_STATE } from '@core/reducer';
import {
  convertRpcMessageToChatMessage,
  hydrateChatMessages,
  isValidSessionRecord,
  loadAllSessionRecords,
  loadSessionRecord,
  normalizeWorkingDirectory,
  recordSessionSwitched,
  resolveSessionResumePlan,
  saveSessionRecord,
  updateSessionHasMessages,
} from '@core/session';
import { SessionEventController } from '@features/chat/session-events';
import type { ThinkingBlock, ToolCallBlock } from '@core/types/messages';
import type {
  ExtensionUiRequest,
  ExtensionUiResponsePayload,
  SendExtensionUiResponseResult,
  SendPromptResult,
} from '@core/types/events';
import type { SessionPersistenceStatus, ViewerSessionRecord } from '@core/types/sessions';

test('JsonlParser: parses single complete LF frame', () => {
  const parser = new JsonlParser();
  const records = parser.feedString('{"type":"agent_start"}\n');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].type, 'agent_start');
  assert.strictEqual(parser.pendingBytes, 0);
});

test('JsonlParser: strips Windows CRLF (\\r\\n) correctly', () => {
  const parser = new JsonlParser();
  const records = parser.feedString('{"id":"req-1","success":true}\r\n');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].id, 'req-1');
  assert.strictEqual(records[0].success, true);
  assert.strictEqual(parser.pendingBytes, 0);
});

test('JsonlParser: handles multiple lines in a single chunk', () => {
  const parser = new JsonlParser();
  const chunk = '{"n":1}\n{"n":2}\r\n{"n":3}\n';
  const records = parser.feedString(chunk);
  assert.strictEqual(records.length, 3);
  assert.strictEqual(records[0].n, 1);
  assert.strictEqual(records[1].n, 2);
  assert.strictEqual(records[2].n, 3);
  assert.strictEqual(parser.pendingBytes, 0);
});

test('JsonlParser: handles split frames across chunks', () => {
  const parser = new JsonlParser();
  const chunk1 = '{"type":"message_update","delta":"';
  const chunk2 = 'Hello world"}\n';

  const records1 = parser.feedString(chunk1);
  assert.strictEqual(records1.length, 0);
  assert.ok(parser.pendingBytes > 0);

  const records2 = parser.feedString(chunk2);
  assert.strictEqual(records2.length, 1);
  assert.strictEqual(records2[0].type, 'message_update');
  assert.strictEqual(records2[0].delta, 'Hello world');
  assert.strictEqual(parser.pendingBytes, 0);
});

test('JsonlParser: preserves UTF-8 multi-byte sequences split across chunks', () => {
  const parser = new JsonlParser();
  const encoder = new TextEncoder();

  // '🎉' is 4 bytes: [240, 159, 142, 137]
  const full = '{"emoji":"🎉"}\n';
  const bytes = encoder.encode(full);

  // Split right in the middle of the 4-byte emoji sequence
  const part1 = bytes.subarray(0, 11); // splits inside emoji bytes
  const part2 = bytes.subarray(11);

  const records1 = parser.feedBytes(part1);
  assert.strictEqual(records1.length, 0);

  const records2 = parser.feedBytes(part2);
  assert.strictEqual(records2.length, 1);
  assert.strictEqual(records2[0].emoji, '🎉');
  assert.strictEqual(parser.pendingBytes, 0);
});

test('JsonlParser: preserves Unicode separators U+2028 and U+2029 inside strings without splitting', () => {
  const parser = new JsonlParser();
  // Per docs/rpc.md: U+2028 and U+2029 are valid inside JSON strings and must not split records!
  const line = '{"text":"line1\u2028line2\u2029line3"}\n';
  const records = parser.feedString(line);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].text, 'line1\u2028line2\u2029line3');
});

test('JsonlParser: enforces maximum buffer limit', () => {
  const parser = new JsonlParser(1024);
  const oversized = new Uint8Array(2048);
  assert.throws(() => {
    parser.feedBytes(oversized);
  }, /exceeded maximum record size/);
});

test('Extension UI: identifies dialog requests and generates cancellation response', () => {
  const dialogReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'dlg-123',
    method: 'select',
    title: 'Allow tool?',
    options: ['Allow', 'Deny'],
  };

  assert.strictEqual(isDialogExtensionUiRequest(dialogReq), true);

  const cancelResp = createExtensionUiCancelResponse(dialogReq.id);
  assert.deepStrictEqual(cancelResp, {
    type: 'extension_ui_response',
    id: 'dlg-123',
    cancelled: true,
  });

  const notifyReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'notif-456',
    method: 'notify',
    message: 'info message',
  };
  assert.strictEqual(isDialogExtensionUiRequest(notifyReq), false);
});

test('Extension UI: isSupportedDialogExtensionUiRequest identifies supported dialog methods', () => {
  const selectReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-1',
    method: 'select',
    title: 'Choose option',
    options: ['One', 'Two'],
  };
  const inputReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-2',
    method: 'input',
    title: 'Enter name',
  };
  const confirmReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-3',
    method: 'confirm',
    title: 'Proceed?',
  };
  const editorReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-4',
    method: 'editor',
    title: 'Edit code',
  };
  const notifyReq: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'req-5',
    method: 'notify',
    message: 'Done',
  };

  assert.strictEqual(isSupportedDialogExtensionUiRequest(selectReq), true);
  assert.strictEqual(isSupportedDialogExtensionUiRequest(inputReq), true);
  assert.strictEqual(isSupportedDialogExtensionUiRequest(confirmReq), true);
  assert.strictEqual(isSupportedDialogExtensionUiRequest(editorReq), false);
  assert.strictEqual(isSupportedDialogExtensionUiRequest(notifyReq), false);
});

test('Extension UI: parseSelectChoice handles numeric, exact, and case-insensitive matching', () => {
  const options = ['Alpha', 'Beta Release', 'Gamma'];

  // 1-based numeric index
  assert.strictEqual(parseSelectChoice('1', options), 'Alpha');
  assert.strictEqual(parseSelectChoice('2', options), 'Beta Release');
  assert.strictEqual(parseSelectChoice('3', options), 'Gamma');

  // Exact name matching
  assert.strictEqual(parseSelectChoice('Alpha', options), 'Alpha');
  assert.strictEqual(parseSelectChoice('Beta Release', options), 'Beta Release');

  // Case-insensitive name matching (returns exact original casing)
  assert.strictEqual(parseSelectChoice('alpha', options), 'Alpha');
  assert.strictEqual(parseSelectChoice('BETA RELEASE', options), 'Beta Release');
  assert.strictEqual(parseSelectChoice('gamma', options), 'Gamma');

  // Out of bounds number
  assert.strictEqual(parseSelectChoice('0', options), null);
  assert.strictEqual(parseSelectChoice('4', options), null);
  assert.strictEqual(parseSelectChoice('-1', options), null);

  // Non-matching string
  assert.strictEqual(parseSelectChoice('Delta', options), null);

  // Whitespace and empty inputs
  assert.strictEqual(parseSelectChoice('', options), null);
  assert.strictEqual(parseSelectChoice('   ', options), null);
  assert.strictEqual(parseSelectChoice(null, options), null);
  assert.strictEqual(parseSelectChoice(undefined, options), null);

  // Empty options list
  assert.strictEqual(parseSelectChoice('1', []), null);
});

test('Extension UI: createExtensionUiResponse generates proper RPC shapes', () => {
  // Cancelled
  assert.deepStrictEqual(
    createExtensionUiResponse({ id: 'req-1', cancelled: true }),
    { type: 'extension_ui_response', id: 'req-1', cancelled: true }
  );

  // Confirmed true
  assert.deepStrictEqual(
    createExtensionUiResponse({ id: 'req-2', method: 'confirm', confirmed: true }),
    { type: 'extension_ui_response', id: 'req-2', confirmed: true }
  );

  // Confirmed false
  assert.deepStrictEqual(
    createExtensionUiResponse({ id: 'req-2', method: 'confirm', confirmed: false }),
    { type: 'extension_ui_response', id: 'req-2', confirmed: false }
  );

  // Value
  assert.deepStrictEqual(
    createExtensionUiResponse({ id: 'req-3', method: 'select', value: 'opt-a' }),
    { type: 'extension_ui_response', id: 'req-3', value: 'opt-a' }
  );

  // Fallback cancelled when missing value/confirmed
  assert.deepStrictEqual(
    createExtensionUiResponse({ id: 'req-4' }),
    { type: 'extension_ui_response', id: 'req-4', cancelled: true }
  );
});

test('Extension UI protocol shape: createExtensionUiResponse strips optional cwd from wire shape', () => {
  const payloadWithCwd: ExtensionUiResponsePayload = {
    id: 'req-cwd-1',
    method: 'select',
    value: 'choice-1',
    cwd: '/workspace/project-a',
  };
  const wire = createExtensionUiResponse(payloadWithCwd);
  assert.deepStrictEqual(wire, {
    type: 'extension_ui_response',
    id: 'req-cwd-1',
    value: 'choice-1',
  });
  assert.strictEqual('cwd' in wire, false, 'Wire shape must not contain cwd property');

  const cancelWithCwd: ExtensionUiResponsePayload = {
    id: 'req-cwd-2',
    cancelled: true,
    cwd: '/workspace/project-b',
  };
  const cancelWire = createExtensionUiResponse(cancelWithCwd);
  assert.deepStrictEqual(cancelWire, {
    type: 'extension_ui_response',
    id: 'req-cwd-2',
    cancelled: true,
  });
  assert.strictEqual('cwd' in cancelWire, false, 'Wire shape must not contain cwd property');
});

test('Extension UI: defaultDialogAdapter invokes window dialogs and handles cancellation', () => {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;

  try {
    // 1. Mock window.prompt and window.confirm
    let lastPromptMessage = '';
    let lastPromptDefault = '';
    let mockPromptReturn: string | null = '1';

    let lastConfirmMessage = '';
    let mockConfirmReturn = true;

    (globalThis as unknown as { window: unknown }).window = {
      prompt: (msg: string, def: string) => {
        lastPromptMessage = msg;
        lastPromptDefault = def;
        return mockPromptReturn;
      },
      confirm: (msg: string) => {
        lastConfirmMessage = msg;
        return mockConfirmReturn;
      },
    };

    // Select with numeric choice
    const selectReq: ExtensionUiRequest = {
      type: 'extension_ui_request',
      id: 'sel-1',
      method: 'select',
      title: 'Pick one',
      options: ['Red', 'Green', 'Blue'],
    };
    mockPromptReturn = '2';
    const selectRes = defaultDialogAdapter.select(selectReq);
    assert.strictEqual(selectRes, 'Green');
    assert.ok(lastPromptMessage.includes('1. Red'));
    assert.ok(lastPromptMessage.includes('2. Green'));

    // Select with cancel
    mockPromptReturn = null;
    assert.strictEqual(defaultDialogAdapter.select(selectReq), null);

    // Input with text
    const inputReq: ExtensionUiRequest = {
      type: 'extension_ui_request',
      id: 'inp-1',
      method: 'input',
      title: 'Your name',
      prefill: 'Default User',
    };
    mockPromptReturn = 'Alice';
    const inputRes = defaultDialogAdapter.input(inputReq);
    assert.strictEqual(inputRes, 'Alice');
    assert.strictEqual(lastPromptDefault, 'Default User');

    // Input with cancel
    mockPromptReturn = null;
    assert.strictEqual(defaultDialogAdapter.input(inputReq), null);

    // Confirm OK
    const confReq: ExtensionUiRequest = {
      type: 'extension_ui_request',
      id: 'conf-1',
      method: 'confirm',
      title: 'Are you sure?',
      message: 'This cannot be undone.',
    };
    mockConfirmReturn = true;
    assert.strictEqual(defaultDialogAdapter.confirm(confReq), true);
    assert.ok(lastConfirmMessage.includes('Are you sure?'));
    assert.ok(lastConfirmMessage.includes('This cannot be undone.'));

    // Confirm Cancel
    mockConfirmReturn = false;
    assert.strictEqual(defaultDialogAdapter.confirm(confReq), false);
  } finally {
    if (originalWindow !== undefined) {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    } else {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  }

  // Without window object in environment, dialog methods safely return null
  assert.strictEqual(
    defaultDialogAdapter.select({ type: 'extension_ui_request', id: 's', method: 'select', options: ['A'] }),
    null
  );
  assert.strictEqual(
    defaultDialogAdapter.input({ type: 'extension_ui_request', id: 'i', method: 'input' }),
    null
  );
  assert.strictEqual(
    defaultDialogAdapter.confirm({ type: 'extension_ui_request', id: 'c', method: 'confirm' }),
    null
  );
});

test('Extension UI: ExtensionUiDialogAdapter interface accepts optional cancelPending method', () => {
  let cancelledCwd: string | undefined = 'not-called';
  const adapter: ExtensionUiDialogAdapter = {
    select: () => 'chosen',
    input: () => 'text',
    confirm: () => true,
    cancelPending: (cwd?: string) => {
      cancelledCwd = cwd;
    },
  };

  assert.strictEqual(
    adapter.select({ type: 'extension_ui_request', id: '1', method: 'select' }),
    'chosen'
  );
  assert.strictEqual(
    adapter.input({ type: 'extension_ui_request', id: '2', method: 'input' }),
    'text'
  );
  assert.strictEqual(
    adapter.confirm({ type: 'extension_ui_request', id: '3', method: 'confirm' }),
    true
  );

  adapter.cancelPending?.('/project/cwd');
  assert.strictEqual(cancelledCwd, '/project/cwd');

  adapter.cancelPending?.(undefined);
  assert.strictEqual(cancelledCwd, undefined);
});

test('sendExtensionUiResponsePi: invokes send_extension_ui_response command via mock invoke', async () => {
  let capturedCmd = '';
  let capturedArgs: unknown = null;

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    capturedCmd = cmd;
    capturedArgs = args;
    const res: SendExtensionUiResponseResult = {
      id: 'dialog-456',
      success: true,
    };
    return res as unknown as T;
  };

  const payload: ExtensionUiResponsePayload = {
    id: 'dialog-456',
    method: 'select',
    value: 'Selected Option',
  };

  const result = await sendExtensionUiResponsePi(payload, mockInvoke);

  assert.strictEqual(capturedCmd, 'send_extension_ui_response');
  assert.deepStrictEqual(capturedArgs, { payload });
  assert.strictEqual(result.id, 'dialog-456');
  assert.strictEqual(result.success, true);
});

test('sendExtensionUiResponsePi: validates ID and rejects missing response ID', async () => {
  const mockInvoke = async <T>(): Promise<T> => {
    return { success: true } as unknown as T;
  };

  // Empty ID
  await assert.rejects(
    async () => {
      await sendExtensionUiResponsePi({ id: '', method: 'select', value: 'opt' }, mockInvoke);
    },
    /Extension UI response missing required request ID/
  );

  // Missing response ID from backend
  await assert.rejects(
    async () => {
      await sendExtensionUiResponsePi({ id: 'valid-id', method: 'confirm', confirmed: true }, mockInvoke);
    },
    /Backend response missing required request ID/
  );
});

test('sendExtensionUiResponsePi: passes optional cwd in payload to Tauri invoke command', async () => {
  let capturedArgs: unknown = null;
  const mockInvoke = async <T>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
    capturedArgs = args;
    return { id: 'dialog-cwd-1', success: true } as unknown as T;
  };

  const payload: ExtensionUiResponsePayload = {
    id: 'dialog-cwd-1',
    method: 'confirm',
    confirmed: true,
    cwd: '/path/project-1',
  };

  const result = await sendExtensionUiResponsePi(payload, mockInvoke);
  assert.strictEqual(result.id, 'dialog-cwd-1');
  assert.deepStrictEqual(capturedArgs, { payload });
});

test('extractTextFromContent: extracts string and block text accurately', () => {
  assert.strictEqual(extractTextFromContent('plain string'), 'plain string');
  assert.strictEqual(
    extractTextFromContent([
      { type: 'text', text: 'Hello ' },
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: 'world!' },
    ]),
    'Hello world!'
  );
  assert.strictEqual(extractTextFromContent(null), '');
});

test('extractChatTextDelta: filters only text_delta and ignores thinking/toolcall deltas', () => {
  // text_delta with content is returned
  assert.strictEqual(
    extractChatTextDelta({ type: 'text_delta', delta: 'Hello world' }),
    'Hello world'
  );

  // thinking_delta must NOT go to chat
  assert.strictEqual(
    extractChatTextDelta({ type: 'thinking_delta', delta: 'Thinking about the answer...' }),
    null
  );

  // toolcall_delta must NOT go to chat
  assert.strictEqual(
    extractChatTextDelta({ type: 'toolcall_delta', delta: '{"path":"foo"}' }),
    null
  );

  // Non-delta event types
  assert.strictEqual(extractChatTextDelta({ type: 'text_start' }), null);
  assert.strictEqual(extractChatTextDelta({ type: 'text_end' }), null);
  assert.strictEqual(extractChatTextDelta({ type: 'thinking_start' }), null);
  assert.strictEqual(extractChatTextDelta({ type: 'toolcall_start' }), null);

  // Empty or invalid deltas
  assert.strictEqual(extractChatTextDelta({ type: 'text_delta', delta: '' }), null);
  assert.strictEqual(extractChatTextDelta(null), null);
  assert.strictEqual(extractChatTextDelta(undefined), null);
  assert.strictEqual(extractChatTextDelta({}), null);
});

test('generatePromptRequestId: falls back to secure random values when randomUUID is unavailable', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secureCrypto = (originalCrypto?.value as Crypto | undefined) ?? (webcrypto as unknown as Crypto);
  const mockCrypto = {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      return secureCrypto.getRandomValues(array);
    },
  };

  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: mockCrypto });
    const id1 = generatePromptRequestId();
    const id2 = generatePromptRequestId();
    const uuidV4Pattern = /^prompt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    assert.notStrictEqual(id1, id2, 'Fallback prompt IDs must be unique');
    assert.match(id1, uuidV4Pattern);
    assert.match(id2, uuidV4Pattern);
    assert.ok(isValidPromptRequestId(id1));
    assert.ok(isValidPromptRequestId(id2));
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
  }
});

test('generatePromptRequestId: fails clearly when secure crypto sources are unavailable', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    assert.throws(() => generatePromptRequestId(), /Secure crypto random number generation is unavailable/);
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
  }
});

test('generatePromptRequestId: generates authoritative client ID prefixed with prompt- and valid UUID v4', () => {
  const id1 = generatePromptRequestId();
  const id2 = generatePromptRequestId();

  assert.notStrictEqual(id1, id2, 'Consecutive prompt IDs must be unique');
  assert.ok(id1.startsWith(PROMPT_REQUEST_ID_PREFIX), `Must start with ${PROMPT_REQUEST_ID_PREFIX}`);
  assert.ok(id2.startsWith(PROMPT_REQUEST_ID_PREFIX), `Must start with ${PROMPT_REQUEST_ID_PREFIX}`);

  const uuidPart1 = id1.slice(PROMPT_REQUEST_ID_PREFIX.length);
  const uuidPart2 = id2.slice(PROMPT_REQUEST_ID_PREFIX.length);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  assert.ok(uuidRegex.test(uuidPart1), `Suffix must be valid UUID v4: ${uuidPart1}`);
  assert.ok(uuidRegex.test(uuidPart2), `Suffix must be valid UUID v4: ${uuidPart2}`);
  assert.ok(isValidPromptRequestId(id1));
  assert.ok(isValidPromptRequestId(id2));
});

test('isValidPromptRequestId: validates bounds, non-empty, prefix namespace, and character set', () => {
  // Valid IDs
  assert.strictEqual(isValidPromptRequestId('prompt-123e4567-e89b-12d3-a456-426614174000'), true);
  assert.strictEqual(isValidPromptRequestId('prompt-custom_id-123'), true);
  assert.strictEqual(isValidPromptRequestId('prompt-a'), true);

  // Invalid: empty or whitespace
  assert.strictEqual(isValidPromptRequestId(''), false);
  assert.strictEqual(isValidPromptRequestId('   '), false);
  assert.strictEqual(isValidPromptRequestId(' prompt-123'), false);
  assert.strictEqual(isValidPromptRequestId('prompt-123 '), false);

  // Invalid: non-prompt namespace
  assert.strictEqual(isValidPromptRequestId('internal-123'), false);
  assert.strictEqual(isValidPromptRequestId('handshake-1'), false);
  assert.strictEqual(isValidPromptRequestId('abort-1'), false);
  assert.strictEqual(isValidPromptRequestId('prompt-'), false); // prefix only with no identifier

  // Invalid: exceeding length limit (128 chars)
  const oversized = `prompt-${'a'.repeat(129)}`;
  assert.strictEqual(isValidPromptRequestId(oversized), false);

  // Invalid: forbidden characters
  assert.strictEqual(isValidPromptRequestId('prompt-test\n123'), false);
  assert.strictEqual(isValidPromptRequestId('prompt-test;drop'), false);
  assert.strictEqual(isValidPromptRequestId('prompt-test space'), false);
  assert.strictEqual(isValidPromptRequestId('prompt-test/slash'), false);

  // Invalid: non-string types
  assert.strictEqual(isValidPromptRequestId(null), false);
  assert.strictEqual(isValidPromptRequestId(undefined), false);
  assert.strictEqual(isValidPromptRequestId(12345), false);
  assert.strictEqual(isValidPromptRequestId({}), false);
});

test('buildSendPromptArgs: pure payload builder matches backend SendPromptPayload schema exactly', () => {
  const id = 'prompt-123e4567-e89b-12d3-a456-426614174000';
  const message = 'Hello from frontend';

  const args = buildSendPromptArgs(id, message);
  assert.deepStrictEqual(args, {
    payload: {
      id: 'prompt-123e4567-e89b-12d3-a456-426614174000',
      message: 'Hello from frontend',
    },
  });
});

test('buildSendPromptArgs: omits streamingBehavior for an ordinary idle send', () => {
  const args = buildSendPromptArgs('prompt-1', 'Hello');
  assert.deepStrictEqual(args, {
    payload: {
      id: 'prompt-1',
      message: 'Hello',
    },
  });
  assert.ok(!('streamingBehavior' in args.payload));
});

test('buildSendPromptArgs: includes streamingBehavior: "followUp" when queuing while busy', () => {
  const args = buildSendPromptArgs('prompt-2', 'Follow up', undefined, 'followUp');
  assert.deepStrictEqual(args, {
    payload: {
      id: 'prompt-2',
      message: 'Follow up',
      streamingBehavior: 'followUp',
    },
  });
});

test('sendPromptPi: bridge passes payload and echoes authoritative ID via mock invoke', async () => {
  const testId = generatePromptRequestId();
  const testMsg = 'What is the speed of light?';

  let capturedCmd = '';
  let capturedArgs: unknown = null;

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    capturedCmd = cmd;
    capturedArgs = args;
    const res: SendPromptResult = {
      id: testId,
      accepted: true,
    };
    return res as unknown as T;
  };

  const result = await sendPromptPi(testId, testMsg, mockInvoke);

  assert.strictEqual(capturedCmd, 'send_prompt');
  assert.deepStrictEqual(capturedArgs, {
    payload: {
      id: testId,
      message: testMsg,
    },
  });
  assert.strictEqual(result.id, testId);
  assert.strictEqual(result.accepted, true);
});

test('sendPromptPi: forwards streamingBehavior: "followUp" to the backend when queuing', async () => {
  const testId = generatePromptRequestId();

  let capturedArgs: unknown = null;
  const mockInvoke = async <T>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
    capturedArgs = args;
    return { id: testId, accepted: true } as unknown as T;
  };

  await sendPromptPi(testId, 'Queued message', undefined, mockInvoke, 'followUp');

  assert.deepStrictEqual(capturedArgs, {
    payload: {
      id: testId,
      message: 'Queued message',
      streamingBehavior: 'followUp',
    },
  });
});

test('sendPromptPi: rejects missing or empty ID from backend without synthetic fallback', async () => {
  const testId = generatePromptRequestId();

  // Mock invoke returning missing ID
  const mockInvokeMissingId = async <T>(): Promise<T> => {
    return { accepted: true } as unknown as T;
  };

  await assert.rejects(
    async () => {
      await sendPromptPi(testId, 'Test message', mockInvokeMissingId);
    },
    /Backend response missing required request ID/
  );

  // Mock invoke returning empty ID
  const mockInvokeEmptyId = async <T>(): Promise<T> => {
    return { id: '', accepted: true } as unknown as T;
  };

  await assert.rejects(
    async () => {
      await sendPromptPi(testId, 'Test message', mockInvokeEmptyId);
    },
    /Backend response missing required request ID/
  );
});

test('Remount simulation: remounted components generate distinct independent IDs without counter desync', () => {
  // Simulate multiple independent component mounts (e.g. WebView reload or tab remount)
  const mount1Ids = [generatePromptRequestId(), generatePromptRequestId()];
  const mount2Ids = [generatePromptRequestId(), generatePromptRequestId()];
  const mount3Ids = [generatePromptRequestId(), generatePromptRequestId()];

  const allIds = [...mount1Ids, ...mount2Ids, ...mount3Ids];
  const uniqueIds = new Set(allIds);

  // In the old implementation with promptSeqRef = useRef(0), every mount started at prompt-1,
  // causing instant counter collision and desynchronization with backend PROMPT_COUNTER.
  // With authoritative UUID-based IDs, all generated IDs across mounts must be strictly disjoint.
  assert.strictEqual(uniqueIds.size, allIds.length, 'All generated IDs across remounts must be strictly unique');
  for (const id of allIds) {
    assert.ok(isValidPromptRequestId(id));
  }
});

test('Rejection then new send: precondition rejection leaves state idle, and new send receives separate ID without stale correlation', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test-model' } },
  });

  const id1 = generatePromptRequestId();
  const id2 = generatePromptRequestId();
  assert.notStrictEqual(id1, id2);

  // 1. Submit prompt 1
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: id1, message: 'First attempt' },
  });
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.pendingPromptId, id1);

  // 2. Backend rejects prompt 1 (e.g. precondition rejection or rate limit)
  state = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: id1, error: 'Agent bridge precondition failed' },
  });
  assert.strictEqual(state.agentActivity, 'idle');
  assert.strictEqual(state.pendingPromptId, null);
  assert.strictEqual(state.lastError, 'Agent bridge precondition failed');
  assert.strictEqual(state.statusLabel, 'Connected');

  // 3. User submits new prompt 2 with independent authoritative ID
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: id2, message: 'Second attempt' },
  });
  assert.strictEqual(state.agentActivity, 'busy');
  assert.strictEqual(state.pendingPromptId, id2);
  assert.strictEqual(state.lastError, null);

  // 4. Stale rejection or acceptance for id1 arriving now MUST be ignored
  const stateAfterStaleAccept = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: id1 },
  });
  assert.strictEqual(stateAfterStaleAccept.pendingPromptId, id2);
  assert.strictEqual(stateAfterStaleAccept.agentActivity, 'busy');

  const stateAfterStaleReject = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: id1, error: 'Old error' },
  });
  assert.strictEqual(stateAfterStaleReject.pendingPromptId, id2);
  assert.strictEqual(stateAfterStaleReject.agentActivity, 'busy');
  assert.strictEqual(stateAfterStaleReject.lastError, null);

  // 5. Matching acceptance for id2 is accepted
  const stateAfterMatchingAccept = chatReducer(state, {
    type: 'PROMPT_ACCEPTED',
    payload: { id: id2 },
  });
  assert.strictEqual(stateAfterMatchingAccept.pendingPromptId, id2);
  assert.strictEqual(stateAfterMatchingAccept.agentActivity, 'busy');
  assert.strictEqual(stateAfterMatchingAccept.statusDetail, 'Prompt accepted by Pi; streaming response...');
});

/* ========================================================================= */
/* Test Harness: Mock and Throwing Storage for Node Execution                */
/* ========================================================================= */

class MockStorage implements Storage {
  private store: Map<string, string> = new Map();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

class ThrowingStorage implements Storage {
  get length(): number {
    throw new Error('Access denied (SecurityError)');
  }

  clear(): void {
    throw new Error('Access denied (SecurityError)');
  }

  getItem(_key: string): string | null {
    throw new Error('Storage disabled by security policy (SecurityError)');
  }

  key(_index: number): string | null {
    throw new Error('Access denied (SecurityError)');
  }

  removeItem(_key: string): void {
    throw new Error('Access denied (SecurityError)');
  }

  setItem(_key: string, _value: string): void {
    throw new Error('QuotaExceededError: storage quota exceeded');
  }
}

/* ========================================================================= */
/* Config Persistence & Validation Tests                                     */
/* ========================================================================= */

test('Config: isAbsolutePath identifies Windows drive, UNC, and Unix root paths', () => {
  assert.strictEqual(isAbsolutePath('C:\\path\\file.js'), true);
  assert.strictEqual(isAbsolutePath('D:/path/file.js'), true);
  assert.strictEqual(isAbsolutePath('\\\\server\\share\\path'), true);
  assert.strictEqual(isAbsolutePath('/usr/local/bin/node'), true);

  assert.strictEqual(isAbsolutePath('relative/path.js'), false);
  assert.strictEqual(isAbsolutePath('./path.js'), false);
  assert.strictEqual(isAbsolutePath('../path.js'), false);
  assert.strictEqual(isAbsolutePath('node'), false);
});

const VALID_SAMPLE_CONFIG: ConnectConfig = {
  nodePath: 'node',
  piEntrypoint: 'C:\\pi\\dist\\cli.js',
  workingDirectory: 'C:\\projects\\demo',
  fileTreeRefreshInterval: 15,
};

test('Config: validateConnectConfig validates structure, non-empty fields, absolute paths, and JS extensions', () => {
  // Non-object
  assert.strictEqual(validateConnectConfig(null).valid, false);
  assert.strictEqual(validateConnectConfig('string').valid, false);

  // Empty nodePath
  assert.strictEqual(
    validateConnectConfig({ ...VALID_SAMPLE_CONFIG, nodePath: '  ' }).valid,
    false
  );

  // Non-absolute piEntrypoint
  const nonAbsEntry = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    piEntrypoint: 'relative/cli.js',
  });
  assert.strictEqual(nonAbsEntry.valid, false);
  assert.match(nonAbsEntry.error!, /absolute path/);

  // Invalid extension
  const badExt = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    piEntrypoint: 'C:\\pi\\cli.ts',
  });
  assert.strictEqual(badExt.valid, false);
  assert.match(badExt.error!, /JavaScript extension/);

  // Non-absolute workingDirectory
  const nonAbsCwd = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    workingDirectory: 'relative/cwd',
  });
  assert.strictEqual(nonAbsCwd.valid, false);
  assert.match(nonAbsCwd.error!, /absolute path/);

  // DEFAULT_CONFIG starts unconfigured without personal paths (not ready)
  assert.strictEqual(validateConnectConfig(DEFAULT_CONFIG).valid, false);
  assert.strictEqual(isConfigReady(DEFAULT_CONFIG), false);

  // Valid Windows default config
  assert.strictEqual(validateConnectConfig(VALID_SAMPLE_CONFIG).valid, true);
  assert.strictEqual(isConfigReady(VALID_SAMPLE_CONFIG), true);

  // Valid Unix config
  const unixConfig = {
    nodePath: 'node',
    piEntrypoint:
      '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    workingDirectory: '/home/user/project',
  };
  assert.strictEqual(validateConnectConfig(unixConfig).valid, true);
});

test('Config: load returns workstation defaults when storage is absent (null)', () => {
  const mockStore = new MockStorage();
  const res = loadConnectConfig(mockStore);
  assert.strictEqual(res.source, 'default');
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
  assert.strictEqual(res.warning, undefined);
});

test('Config: load returns workstation defaults with honest warning when storage contains corrupt JSON', () => {
  const mockStore = new MockStorage();
  mockStore.setItem(CONFIG_STORAGE_KEY, '{corrupted-json:');
  const res = loadConnectConfig(mockStore);
  assert.strictEqual(res.source, 'default');
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
  assert.match(res.warning!, /Corrupted configuration in storage/);
});

test('Config: load returns workstation defaults with honest warning when stored config is partial', () => {
  const mockStore = new MockStorage();
  mockStore.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ nodePath: 'node' }));
  const res = loadConnectConfig(mockStore);
  assert.strictEqual(res.source, 'default');
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
  assert.match(
    res.warning!,
    /Partial configuration in storage missing required fields/
  );
});

test('Config: load returns workstation defaults with honest warning when stored config has invalid fields', () => {
  const mockStore = new MockStorage();
  mockStore.setItem(
    CONFIG_STORAGE_KEY,
    JSON.stringify({
      nodePath: '',
      piEntrypoint: 'relative/cli.py',
      workingDirectory: 'relative',
    })
  );
  const res = loadConnectConfig(mockStore);
  assert.strictEqual(res.source, 'default');
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
  assert.match(res.warning!, /Stored configuration is invalid/);
});

test('Config: load handles storage throws honestly without crashing and returns defaults with warning', () => {
  const throwingStore = new ThrowingStorage();
  const res = loadConnectConfig(throwingStore);
  assert.strictEqual(res.source, 'default');
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
  assert.match(res.warning!, /Failed to read configuration from storage/);
});

test('Config: save validates fields and rejects invalid config without writing to storage', () => {
  const mockStore = new MockStorage();
  const res = saveConnectConfig({ nodePath: '' }, mockStore);
  assert.strictEqual(res.success, false);
  assert.match(res.error!, /Node executable path cannot be empty/);
  assert.strictEqual(mockStore.getItem(CONFIG_STORAGE_KEY), null);
});

test('Config: save handles storage throws honestly without crashing and returns error result', () => {
  const throwingStore = new ThrowingStorage();
  const res = saveConnectConfig(VALID_SAMPLE_CONFIG, throwingStore);
  assert.strictEqual(res.success, false);
  assert.match(res.error!, /Failed to persist configuration to storage/);
});

test('Config: validated save roundtrip persists and reloads matching configuration', () => {
  const mockStore = new MockStorage();
  const customConfig = {
    nodePath: 'C:\\nodejs\\node.exe',
    piEntrypoint: 'C:\\tools\\pi\\dist\\cli.mjs',
    workingDirectory: 'C:\\work\\custom-app',
    fileTreeRefreshInterval: 15,
  };

  const saveRes = saveConnectConfig(customConfig, mockStore);
  assert.strictEqual(saveRes.success, true);
  assert.strictEqual(saveRes.error, undefined);

  const loadRes = loadConnectConfig(mockStore);
  assert.strictEqual(loadRes.source, 'stored');
  assert.deepStrictEqual(loadRes.config, customConfig);
  assert.strictEqual(loadRes.warning, undefined);
});

/* ========================================================================= */
/* Bridge Connect & Disconnect Mock Tests                                    */
/* ========================================================================= */

test('connectPi: bridge passes payload and returns connected status via mock invoke', async () => {
  let invokedCmd = '';
  let invokedArgs: unknown = null;

  const mockInvoke = async <T>(
    cmd: string,
    args?: Record<string, unknown>
  ): Promise<T> => {
    invokedCmd = cmd;
    invokedArgs = args;
    return { connected: true, model: { id: 'test-pi-model' } } as T;
  };

  const res = await connectPi(DEFAULT_CONFIG, mockInvoke);

  assert.strictEqual(invokedCmd, 'connect');
  assert.deepStrictEqual(invokedArgs, {
    payload: {
      nodePath: DEFAULT_CONFIG.nodePath,
      piEntrypoint: DEFAULT_CONFIG.piEntrypoint,
      workingDirectory: DEFAULT_CONFIG.workingDirectory,
    },
  });
  assert.strictEqual(res.connected, true);
  assert.strictEqual(res.model?.id, 'test-pi-model');
});

test('disconnectPi: bridge invokes disconnect via mock invoke', async () => {
  let invokedCmd = '';
  const mockInvoke = async <T>(cmd: string): Promise<T> => {
    invokedCmd = cmd;
    return undefined as T;
  };

  await disconnectPi(mockInvoke);
  assert.strictEqual(invokedCmd, 'disconnect');
});

test('abortPi: bridge invokes abort via mock invoke', async () => {
  let invokedCmd = '';
  const mockInvoke = async <T>(cmd: string): Promise<T> => {
    invokedCmd = cmd;
    return undefined as T;
  };

  await abortPi(mockInvoke);
  assert.strictEqual(invokedCmd, 'abort');
});

test('ensureBridgeListenersReady: resolves in default bridge environment', async () => {
  await assert.doesNotReject(async () => {
    await ensureBridgeListenersReady();
  });
});

/* ========================================================================= */
/* StartupManager Lifecycle & React StrictMode Tests                         */
/* ========================================================================= */

test('StartupManager: duplicate startup under StrictMode-like cleanup/setup invokes backend connect exactly once', async () => {
  let connectCount = 0;
  const events: string[] = [];

  const manager = new StartupManager({
    connectFn: async () => {
      connectCount++;
      return { connected: true, model: { id: 'model-1' } };
    },
    ensureListenersReadyFn: async () => {},
    onStart: () => events.push('start'),
    onSuccess: (res) => events.push(`success:${res.model?.id}`),
    onError: (err) => events.push(`error:${err}`),
  });

  // StrictMode Mount 1
  void manager.start(DEFAULT_CONFIG);
  // StrictMode Synchronous Cleanup 1
  manager.cancel();
  // StrictMode Mount 2
  const finalPromise = manager.start(DEFAULT_CONFIG);

  await finalPromise;

  assert.strictEqual(connectCount, 1, 'connectFn must be invoked exactly once');
  assert.deepStrictEqual(events, ['start', 'success:model-1']);
});

test('StartupManager: cancelled-before-invocation drops scheduled connection when cleanup runs before microtask', async () => {
  let connectCalled = false;
  let listenersCalled = false;
  let startCalled = false;

  const manager = new StartupManager({
    connectFn: async () => {
      connectCalled = true;
      return { connected: true, model: null };
    },
    ensureListenersReadyFn: async () => {
      listenersCalled = true;
    },
    onStart: () => {
      startCalled = true;
    },
  });

  // Schedule start
  const p = manager.start(DEFAULT_CONFIG);
  // Synchronous cleanup (e.g. unmount before microtask runs)
  manager.cancel();

  await p;

  assert.strictEqual(connectCalled, false);
  assert.strictEqual(listenersCalled, false);
  assert.strictEqual(startCalled, false);
});

test('StartupManager: ensures bridge listeners are ready before invoking backend connect (listener ordering)', async () => {
  const sequence: string[] = [];
  let listenersAttached = false;

  const manager = new StartupManager({
    ensureListenersReadyFn: async () => {
      sequence.push('listeners:waiting');
      await new Promise((r) => setTimeout(r, 5));
      listenersAttached = true;
      sequence.push('listeners:ready');
    },
    connectFn: async () => {
      assert.strictEqual(
        listenersAttached,
        true,
        'Bridge listeners must be ready BEFORE connect is invoked'
      );
      sequence.push('connect:invoked');
      return { connected: true, model: null };
    },
    onSuccess: () => sequence.push('success'),
  });

  await manager.start(DEFAULT_CONFIG);

  assert.deepStrictEqual(sequence, [
    'listeners:waiting',
    'listeners:ready',
    'connect:invoked',
    'success',
  ]);
});

test('StartupManager: stale success from superseded or cancelled attempt is dropped without dispatching', async () => {
  let resolveAttempt1!: (res: {
    connected: boolean;
    model: { id: string };
  }) => void;
  const attempt1Promise = new Promise<{
    connected: boolean;
    model: { id: string };
  }>((r) => {
    resolveAttempt1 = r;
  });

  const successes: string[] = [];
  let callCount = 0;

  const manager = new StartupManager({
    connectFn: async () => {
      callCount++;
      if (callCount === 1) {
        return await attempt1Promise;
      }
      return { connected: true, model: { id: 'attempt-2-model' } };
    },
    ensureListenersReadyFn: async () => {},
    onSuccess: (res) => successes.push(res.model?.id ?? 'none'),
  });

  // Attempt 1 starts with a manual schedule so it begins execution
  let runScheduled!: () => void;
  manager.updateOptions({
    scheduleFn: (cb) => {
      runScheduled = cb;
    },
  });

  void manager.start(DEFAULT_CONFIG);
  runScheduled(); // Now Attempt 1 begins execution
  await Promise.resolve(); // Allow ensureListeners microtask to resolve to reach connectFn

  assert.strictEqual(callCount, 1);

  // Attempt 2 supersedes Attempt 1 (e.g. user applied new config or retried)
  manager.updateOptions({
    scheduleFn: (cb) => queueMicrotask(cb),
  });
  const attempt2Promise = manager.start(DEFAULT_CONFIG, { force: true });
  await attempt2Promise;

  assert.strictEqual(callCount, 2);
  assert.deepStrictEqual(successes, ['attempt-2-model']);

  // Now the slow Attempt 1 finally resolves
  resolveAttempt1({ connected: true, model: { id: 'attempt-1-STALE' } });
  await new Promise((r) => setTimeout(r, 5));

  // Stale success must NOT have been dispatched
  assert.deepStrictEqual(successes, ['attempt-2-model']);
});

test('StartupManager: stale error from superseded or cancelled attempt is dropped without dispatching', async () => {
  let rejectAttempt1!: (err: Error) => void;
  const attempt1Promise = new Promise<{
    connected: boolean;
    model: null;
  }>((_, rej) => {
    rejectAttempt1 = rej;
  });

  const errors: string[] = [];
  const successes: string[] = [];
  let callCount = 0;

  const manager = new StartupManager({
    connectFn: async () => {
      callCount++;
      if (callCount === 1) {
        return await attempt1Promise;
      }
      return { connected: true, model: null };
    },
    ensureListenersReadyFn: async () => {},
    onError: (err) => errors.push(err),
    onSuccess: () => successes.push('connected'),
  });

  let runScheduled!: () => void;
  manager.updateOptions({
    scheduleFn: (cb) => {
      runScheduled = cb;
    },
  });

  void manager.start(DEFAULT_CONFIG);
  runScheduled(); // Attempt 1 begins execution
  await Promise.resolve(); // Allow ensureListeners microtask to resolve to reach connectFn

  assert.strictEqual(callCount, 1);

  // Attempt 2 supersedes Attempt 1
  manager.updateOptions({
    scheduleFn: (cb) => queueMicrotask(cb),
  });
  const attempt2Promise = manager.start(DEFAULT_CONFIG, { force: true });
  await attempt2Promise;

  assert.strictEqual(callCount, 2);
  assert.deepStrictEqual(successes, ['connected']);
  assert.deepStrictEqual(errors, []);

  // Now Attempt 1 rejects with an arbitrary error
  rejectAttempt1(new Error('Subprocess crashed abruptly with code 1'));
  await new Promise((r) => setTimeout(r, 5));

  // Stale error must NOT be dispatched to the UI; not swallowed by error message string
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(successes, ['connected']);
});

test('StartupManager: explicit retry after failure starts new attempt and recovers without replaying prompts', async () => {
  let attemptCount = 0;
  const events: string[] = [];

  const manager = new StartupManager({
    connectFn: async () => {
      if (attemptCount === 1) {
        throw new Error('Executable not found: node');
      }
      return { connected: true, model: { id: 'recovered-model' } };
    },
    ensureListenersReadyFn: async () => {},
    onStart: () => {
      attemptCount++;
      events.push(`start:${attemptCount}`);
    },
    onError: (err) => events.push(`error:${err}`),
    onSuccess: (res) => events.push(`success:${res.model?.id}`),
  });

  // Attempt 1 fails
  await manager.start(DEFAULT_CONFIG);
  assert.deepStrictEqual(events, [
    'start:1',
    'error:Executable not found: node',
  ]);

  // Reducer receives error
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_FAIL',
    payload: { error: 'Executable not found: node' },
  });
  assert.strictEqual(state.connectionStatus, 'error');
  assert.strictEqual(state.lastError, 'Executable not found: node');

  // Verify that prompt list is clean and not automatically replayed
  assert.strictEqual(state.messages.length, 0);
  assert.strictEqual(state.pendingPromptId, null);

  // User clicks Retry
  await manager.retry();
  assert.deepStrictEqual(events, [
    'start:1',
    'error:Executable not found: node',
    'start:2',
    'success:recovered-model',
  ]);

  // Reducer transitions to connected
  state = chatReducer(state, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'recovered-model' } },
  });
  assert.strictEqual(state.connectionStatus, 'connected');
  assert.strictEqual(state.lastError, null);
  // Messages remain clean, prompt never automatically replayed
  assert.strictEqual(state.messages.length, 0);
});

test('StartupManager: coalesces concurrent start calls with identical config while in-flight', async () => {
  let connectCalls = 0;
  let finishConnect!: () => void;
  const connectPending = new Promise<{
    connected: boolean;
    model: null;
  }>((r) => {
    finishConnect = () => r({ connected: true, model: null });
  });

  const manager = new StartupManager({
    connectFn: async () => {
      connectCalls++;
      return await connectPending;
    },
    ensureListenersReadyFn: async () => {},
  });

  // Call start twice in parallel with identical config
  const p1 = manager.start(DEFAULT_CONFIG);
  const p2 = manager.start(DEFAULT_CONFIG);

  assert.strictEqual(
    p1,
    p2,
    'Concurrent start calls with same config must return identical in-flight promise'
  );

  // Let microtask run and execute
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(connectCalls, 1);

  finishConnect();
  await Promise.all([p1, p2]);
  assert.strictEqual(connectCalls, 1);
});

/* ========================================================================= */
/* Clean-Disconnect Recovery & Retry Availability Regression Tests           */
/* ========================================================================= */

test('canRetryConnection: production availability logic allows retry for disconnected and error, rejects connecting and connected', () => {
  // Offline / clean exit without error must offer explicit Retry
  assert.strictEqual(
    canRetryConnection('disconnected'),
    true,
    'Disconnected state must allow explicit Retry'
  );

  // Failure / abnormal exit must offer explicit Retry
  assert.strictEqual(
    canRetryConnection('error'),
    true,
    'Error state must allow explicit Retry'
  );

  // In-flight connection attempt must not allow duplicate retry triggers
  assert.strictEqual(
    canRetryConnection('connecting'),
    false,
    'Connecting state must suppress Retry'
  );

  // Active connected session must not render Retry
  assert.strictEqual(
    canRetryConnection('connected'),
    false,
    'Connected state must suppress Retry'
  );
});

test('Clean exit recovery: clean process exit leaves state disconnected without lastError, and explicit Retry reconnects successfully', async () => {
  // 1. Session is initially connected
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'initial-model' } },
  });
  assert.strictEqual(state.connectionStatus, 'connected');
  assert.strictEqual(state.lastError, null);
  assert.strictEqual(canRetryConnection(state.connectionStatus), false);

  // 2. Pi process cleanly exits (Tauri bridge emits status-change state: 'disconnected')
  state = chatReducer(state, {
    type: 'DISCONNECT',
    payload: { detail: 'Pi RPC process offline — disconnected' },
  });
  assert.strictEqual(state.connectionStatus, 'disconnected');
  assert.strictEqual(state.lastError, null, 'Clean exit must not set lastError');
  // Production availability logic must offer Retry in disconnected state
  assert.strictEqual(
    canRetryConnection(state.connectionStatus),
    true,
    'Disconnected state must enable Retry availability'
  );

  // 3. User clicks explicit Retry
  let retryConnectCount = 0;
  const events: string[] = [];

  const manager = new StartupManager({
    connectFn: async () => {
      retryConnectCount++;
      return { connected: true, model: { id: 'reconnected-model' } };
    },
    ensureListenersReadyFn: async () => {},
    onStart: () => {
      events.push('start');
      state = chatReducer(state, { type: 'CONNECT_START' });
    },
    onSuccess: (res) => {
      events.push(`success:${res.model?.id}`);
      state = chatReducer(state, {
        type: 'CONNECT_SUCCESS',
        payload: { model: res.model },
      });
    },
    onError: (err) => {
      events.push(`error:${err}`);
      state = chatReducer(state, {
        type: 'CONNECT_FAIL',
        payload: { error: err },
      });
    },
  });

  // Start retry
  await manager.retry(DEFAULT_CONFIG);

  assert.strictEqual(retryConnectCount, 1, 'connectFn must be called on retry');
  assert.deepStrictEqual(events, ['start', 'success:reconnected-model']);
  assert.strictEqual(state.connectionStatus, 'connected');
  assert.strictEqual(state.lastError, null);
  assert.strictEqual(state.modelInfo?.id, 'reconnected-model');
  // No prompt resubmission
  assert.strictEqual(state.messages.length, 0);
  assert.strictEqual(state.pendingPromptId, null);
  assert.strictEqual(canRetryConnection(state.connectionStatus), false);
});

// =============================================================================
// Session Continuity & Ownership Regression Tests
// =============================================================================

test('Session: normalizeWorkingDirectory handles Windows drive, slashes, and whitespace', () => {
  assert.strictEqual(
    normalizeWorkingDirectory('c:\\projects\\pi-viewer'),
    'C:/projects/pi-viewer'
  );
  assert.strictEqual(
    normalizeWorkingDirectory('C:\\projects\\pi-viewer\\'),
    'C:/projects/pi-viewer'
  );
  assert.strictEqual(
    normalizeWorkingDirectory('  /home/user/pi-viewer/  '),
    '/home/user/pi-viewer'
  );
  assert.strictEqual(normalizeWorkingDirectory('C:/'), 'C:/');
  assert.strictEqual(normalizeWorkingDirectory('/'), '/');
  assert.strictEqual(normalizeWorkingDirectory(''), '');
});

test('Session: isValidSessionRecord validates schema and rejects invalid/secret types', () => {
  const valid: ViewerSessionRecord = {
    sessionId: 'session-uuid-1',
    sessionFile: 'C:/sessions/session-uuid-1.jsonl',
    cwd: 'C:/projects/pi-viewer',
    hasMessages: false,
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
  };
  assert.strictEqual(isValidSessionRecord(valid), true);

  assert.strictEqual(isValidSessionRecord(null), false);
  assert.strictEqual(isValidSessionRecord(undefined), false);
  assert.strictEqual(isValidSessionRecord('not-object'), false);
  assert.strictEqual(isValidSessionRecord({ ...valid, sessionId: '' }), false);
  assert.strictEqual(isValidSessionRecord({ ...valid, sessionFile: '   ' }), false);
  assert.strictEqual(isValidSessionRecord({ ...valid, hasMessages: 'false' }), false);
});

function createMockStorage(initialStore?: Map<string, string>): Storage {
  const store = initialStore ?? new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

test('Session: loadSessionRecord returns null on first opening', () => {
  const mockStorage = createMockStorage();
  const result = loadSessionRecord('C:/projects/pi-viewer', mockStorage);
  assert.strictEqual(result.record, null);
});

test('Session: saveSessionRecord and loadSessionRecord roundtrip maintains isolation across working directories', () => {
  const mockStorage = createMockStorage();

  const recordA: ViewerSessionRecord = {
    sessionId: 'session-a',
    sessionFile: 'C:/sessions/session-a.jsonl',
    cwd: 'C:/projects/dir-a',
    hasMessages: true,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
  };

  const recordB: ViewerSessionRecord = {
    sessionId: 'session-b',
    sessionFile: 'C:/sessions/session-b.jsonl',
    cwd: 'C:/projects/dir-b',
    hasMessages: false,
    createdAt: '2026-09-19T11:00:00.000Z',
    updatedAt: '2026-09-19T11:00:00.000Z',
  };

  const saveA = saveSessionRecord(recordA, mockStorage);
  assert.strictEqual(saveA.success, true);
  const saveB = saveSessionRecord(recordB, mockStorage);
  assert.strictEqual(saveB.success, true);

  // Retrieve dir A
  const loadedA = loadSessionRecord('c:\\projects\\dir-a', mockStorage);
  assert.ok(loadedA.record);
  assert.strictEqual(loadedA.record.sessionId, 'session-a');
  assert.strictEqual(loadedA.record.hasMessages, true);

  // Retrieve dir B
  const loadedB = loadSessionRecord('C:/projects/dir-b/', mockStorage);
  assert.ok(loadedB.record);
  assert.strictEqual(loadedB.record.sessionId, 'session-b');
  assert.strictEqual(loadedB.record.hasMessages, false);

  // Retrieve unknown dir C
  const loadedC = loadSessionRecord('C:/projects/dir-c', mockStorage);
  assert.strictEqual(loadedC.record, null);
});

test('Session: updateSessionHasMessages updates hasMessages flag and updatedAt timestamp', () => {
  const mockStorage = createMockStorage();

  const record: ViewerSessionRecord = {
    sessionId: 'session-empty',
    sessionFile: 'C:/sessions/session-empty.jsonl',
    cwd: 'C:/projects/pi-viewer',
    hasMessages: false,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
  };

  saveSessionRecord(record, mockStorage);

  const updateRes = updateSessionHasMessages('C:/projects/pi-viewer', true, mockStorage);
  assert.strictEqual(updateRes.success, true);

  const reloaded = loadSessionRecord('C:/projects/pi-viewer', mockStorage);
  assert.ok(reloaded.record);
  assert.strictEqual(reloaded.record.hasMessages, true);
  assert.notStrictEqual(reloaded.record.updatedAt, '2026-09-19T10:00:00.000Z');
});

test('Session: resolveSessionResumePlan distinguishes first opening, empty session, and historical session', () => {
  const mockStorage = createMockStorage();

  // 1. First opening: no record in storage
  const plan1 = resolveSessionResumePlan('C:/projects/new-project', mockStorage);
  assert.strictEqual(plan1.type, 'first_opening');

  // 2. Empty session: record exists with hasMessages = false
  saveSessionRecord(
    {
      sessionId: 'session-empty',
      sessionFile: 'C:/sessions/session-empty.jsonl',
      cwd: 'C:/projects/empty-project',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  const plan2 = resolveSessionResumePlan('C:/projects/empty-project', mockStorage);
  assert.strictEqual(plan2.type, 'resume_empty');
  if (plan2.type === 'resume_empty') {
    assert.strictEqual(plan2.record.sessionId, 'session-empty');
  }

  // 3. Historical session: record exists with hasMessages = true
  saveSessionRecord(
    {
      sessionId: 'session-with-msgs',
      sessionFile: 'C:/sessions/session-with-msgs.jsonl',
      cwd: 'C:/projects/historical-project',
      hasMessages: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  const plan3 = resolveSessionResumePlan('C:/projects/historical-project', mockStorage);
  assert.strictEqual(plan3.type, 'resume_existing');
  if (plan3.type === 'resume_existing') {
    assert.strictEqual(plan3.record.sessionId, 'session-with-msgs');
  }
});

test('Session: storage throw or corrupted JSON returns empty records with diagnostic warning without crashing', () => {
  const corruptStorage = {
    getItem: () => '{{{bad json',
    setItem: () => {},
  } as unknown as Storage;

  const resultCorrupt = loadAllSessionRecords(corruptStorage);
  assert.deepStrictEqual(resultCorrupt.records, {});
  assert.ok(resultCorrupt.warning?.includes('Failed to parse session registry'));

  const throwingStorage = {
    getItem: () => {
      throw new Error('SecurityError: access denied');
    },
    setItem: () => {},
  } as unknown as Storage;

  const resultThrow = loadAllSessionRecords(throwingStorage);
  assert.deepStrictEqual(resultThrow.records, {});
  assert.ok(resultThrow.warning?.includes('Storage access failed'));
});

test('Message conversion: convertRpcMessageToChatMessage extracts plain text and filters thinking/tools', () => {
  // 1. User message with string content
  const userMsg = {
    role: 'user',
    content: 'What is ODD?',
    timestamp: 1726760000000,
  };
  const convertedUser = convertRpcMessageToChatMessage(userMsg, 0);
  assert.ok(convertedUser);
  assert.strictEqual(convertedUser.role, 'user');
  assert.strictEqual(convertedUser.content, 'What is ODD?');

  // 2. Assistant message with thinking content + text content
  const assistantMsg = {
    id: 'asst-msg-1',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Internal reasoning here...' },
      { type: 'text', text: 'Organic Driven Development is a methodology.' },
    ],
    timestamp: 1726760005000,
  };
  const convertedAssistant = convertRpcMessageToChatMessage(assistantMsg, 1);
  assert.ok(convertedAssistant);
  assert.strictEqual(convertedAssistant.role, 'assistant');
  // Thinking block must be excluded; only text extracted
  assert.strictEqual(
    convertedAssistant.content,
    'Organic Driven Development is a methodology.'
  );
  assert.strictEqual(convertedAssistant.id, 'asst-msg-1');

  // 3. Ignored role (toolResult) returns null
  const toolMsg = {
    role: 'toolResult',
    content: [{ type: 'text', text: 'file content' }],
    timestamp: 1726760002000,
  };
  assert.strictEqual(convertRpcMessageToChatMessage(toolMsg, 2), null);
});

test('Message conversion: hydrateChatMessages converts full multi-turn conversation accurately', () => {
  const rawList = [
    { role: 'user', content: 'First prompt', timestamp: 1000 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'First answer' }],
      timestamp: 2000,
    },
    { role: 'toolResult', content: 'ignored tool data', timestamp: 2500 },
    { role: 'user', content: 'Second prompt', timestamp: 3000 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Hidden chain of thought' },
        { type: 'text', text: 'Second answer' },
      ],
      timestamp: 4000,
    },
  ];

  const hydrated = hydrateChatMessages(rawList);
  assert.strictEqual(hydrated.length, 4);
  assert.strictEqual(hydrated[0].content, 'First prompt');
  assert.strictEqual(hydrated[1].content, 'First answer');
  assert.strictEqual(hydrated[2].content, 'Second prompt');
  assert.strictEqual(hydrated[3].content, 'Second answer');
  assert.ok(!hydrated[3].content.includes('Hidden chain of thought'));
});

test('Message conversion: convertRpcMessageToChatMessage parses image blocks in user messages', () => {
  const validPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const userMsgWithImages = {
    role: 'user',
    content: [
      { type: 'text', text: 'Here is the diagram' },
      { type: 'image', data: validPng, mimeType: 'image/png' },
    ],
    timestamp: 1726760010000,
  };
  const converted = convertRpcMessageToChatMessage(userMsgWithImages, 0);
  assert.ok(converted);
  assert.strictEqual(converted.role, 'user');
  assert.strictEqual(converted.content, 'Here is the diagram');
  assert.deepEqual((converted as any).images, [
    { type: 'image', data: validPng, mimeType: 'image/png' },
  ]);
});

test('Message conversion: hydrateChatMessages retains user message with only images and no text', () => {
  const validWebp = 'UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2AAA';
  const rawList = [
    {
      role: 'user',
      content: [
        { type: 'image', data: validWebp, mimeType: 'image/webp' },
      ],
      timestamp: 1000,
    },
  ];
  const hydrated = hydrateChatMessages(rawList);
  assert.strictEqual(hydrated.length, 1);
  assert.strictEqual(hydrated[0].role, 'user');
  assert.strictEqual(hydrated[0].content, '');
  assert.deepEqual((hydrated[0] as any).images, [
    { type: 'image', data: validWebp, mimeType: 'image/webp' },
  ]);
});

test('Message conversion: rejects invalid/dangerous MIME types or missing image data without synthesizing', () => {
  const validJpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const userMsgWithInvalidImages = {
    role: 'user',
    content: [
      { type: 'text', text: 'Malicious or invalid' },
      { type: 'image', data: 'alert(1)', mimeType: 'text/html' },
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'image', mimeType: 'image/png' },
      { type: 'image', data: validJpeg, mimeType: 'image/jpeg' },
    ],
    timestamp: 1726760020000,
  };
  const converted = convertRpcMessageToChatMessage(userMsgWithInvalidImages, 0);
  assert.ok(converted);
  assert.strictEqual(converted.content, 'Malicious or invalid');
  // Only the valid image should be retained, no synthesis
  assert.deepEqual((converted as any).images, [
    { type: 'image', data: validJpeg, mimeType: 'image/jpeg' },
  ]);
});

test('Message conversion: extractImagesFromMessage deduplicates identical images between content and images list while preserving repeated items in content', () => {
  const validPngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const msgWithDuplicateBetweenContentAndImages = {
    role: 'user',
    content: [
      { type: 'image', data: validPngData, mimeType: 'image/png' },
      { type: 'image', data: validPngData, mimeType: 'image/png' },
    ],
    images: [
      { type: 'image', data: validPngData, mimeType: 'image/png' },
    ],
  };

  const images = extractImagesFromMessage(msgWithDuplicateBetweenContentAndImages);
  // Preserves 2 legitimate repeats in content, but does NOT add the 3rd duplicate from images list
  assert.strictEqual(images.length, 2);
});

test('Message conversion: preserves non-preview image MIME types like HEIC in domain model', () => {
  const validHeicData = 'AAAAHGZ0eXBoZWljAAAAAG1pZjFtaGVpYw==';
  const userMsgWithHeic = {
    role: 'user',
    content: [
      { type: 'image', data: validHeicData, mimeType: 'image/heic' },
    ],
  };
  const converted = convertRpcMessageToChatMessage(userMsgWithHeic, 0);
  assert.ok(converted);
  assert.strictEqual(converted.images?.length, 1);
  assert.strictEqual(converted.images?.[0].mimeType, 'image/heic');
});

test('Preview image validation: validates raw base64 and dataURI, rejecting malformed prefixes and non-base64', () => {
  const validPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // Valid raw base64
  assert.strictEqual(
    getSafePreviewImageSrc({ type: 'image', data: validPng, mimeType: 'image/png' }),
    `data:image/png;base64,${validPng}`
  );

  // Valid prefixed data URI
  assert.strictEqual(
    getSafePreviewImageSrc({ type: 'image', data: `data:image/png;base64,${validPng}`, mimeType: 'image/png' }),
    `data:image/png;base64,${validPng}`
  );

  // Mismatched/dangerous prefix: data:text/html with png mimeType -> REJECTED
  assert.strictEqual(
    getSafePreviewImageSrc({ type: 'image', data: `data:text/html;base64,${validPng}`, mimeType: 'image/png' }),
    null
  );

  // Arbitrary non-image prefix -> REJECTED
  assert.strictEqual(
    getSafePreviewImageSrc({ type: 'image', data: `data:application/javascript;base64,${validPng}`, mimeType: 'image/png' }),
    null
  );

  // Malformed base64 with invalid chars (scripts, spaces) -> REJECTED
  assert.strictEqual(
    getSafePreviewImageSrc({ type: 'image', data: '<script>alert(1)</script>', mimeType: 'image/png' }),
    null
  );

  // Non-preview MIME (HEIC/TIFF) -> REJECTED for preview display
  assert.strictEqual(
    getSafePreviewImageSrc({ type: 'image', data: validPng, mimeType: 'image/heic' }),
    null
  );
});

test('Bridge: getMessagesPi and newSessionPi invoke respective Tauri commands', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === 'get_messages') {
      return [{ role: 'user', content: 'mock msg' }] as T;
    }
    if (cmd === 'new_session') {
      return { cancelled: false, sessionId: 's-new', sessionFile: 'f-new' } as T;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const msgs = await getMessagesPi(mockInvoke);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(calls[0].cmd, 'get_messages');

  const newSess = await newSessionPi(mockInvoke);
  assert.strictEqual(newSess.cancelled, false);
  assert.strictEqual(newSess.sessionId, 's-new');
  assert.strictEqual(calls[1].cmd, 'new_session');
});

test('StartupManager: first opening starts without sessionFile and saves session record on success', async () => {
  const mockStorage = createMockStorage();

  let passedSessionOptions: unknown = null;
  const manager = new StartupManager({
    storage: mockStorage,
    connectFn: async (_config, sessionOptions) => {
      passedSessionOptions = sessionOptions;
      return {
        connected: true,
        model: { id: 'test-model' },
        sessionId: 'first-sess-id',
        sessionFile: 'C:/sessions/first-sess.jsonl',
        messageCount: 0,
        canonicalCwd: 'C:/projects/first-opening',
      };
    },
    ensureListenersReadyFn: async () => {},
  });

  await manager.start({
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/first-opening',
  });

  // First opening must NOT pass sessionFile (--continue forbidden as fallback)
  assert.deepStrictEqual(passedSessionOptions, {
    sessionFile: undefined,
    requireSessionFileExists: false,
  });

  // After success, session record must be stored
  const stored = loadSessionRecord('C:/projects/first-opening', mockStorage);
  assert.ok(stored.record);
  assert.strictEqual(stored.record.sessionId, 'first-sess-id');
  assert.strictEqual(stored.record.hasMessages, false);
});

test('StartupManager: resumes empty session without requiring disk file existence', async () => {
  const mockStorage = createMockStorage();

  // Pre-store an empty session
  saveSessionRecord(
    {
      sessionId: 'empty-sess-id',
      sessionFile: 'C:/sessions/empty-sess.jsonl',
      cwd: 'C:/projects/my-project',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let passedSessionOptions: unknown = null;
  const manager = new StartupManager({
    storage: mockStorage,
    connectFn: async (_config, sessionOptions) => {
      passedSessionOptions = sessionOptions;
      return {
        connected: true,
        model: { id: 'test-model' },
        sessionId: 'empty-sess-id',
        sessionFile: 'C:/sessions/empty-sess.jsonl',
        messageCount: 0,
      };
    },
    ensureListenersReadyFn: async () => {},
  });

  await manager.start({
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/my-project',
  });

  // Must resume with sessionFile, but requireSessionFileExists must be FALSE (file created lazily)
  assert.deepStrictEqual(passedSessionOptions, {
    sessionFile: 'C:/sessions/empty-sess.jsonl',
    requireSessionFileExists: false,
  });
});

test('StartupManager: resumes historical session with requireSessionFileExists = true', async () => {
  const mockStorage = createMockStorage();

  // Pre-store a historical session with messages
  saveSessionRecord(
    {
      sessionId: 'hist-sess-id',
      sessionFile: 'C:/sessions/hist-sess.jsonl',
      cwd: 'C:/projects/hist-project',
      hasMessages: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let passedSessionOptions: unknown = null;
  const manager = new StartupManager({
    storage: mockStorage,
    connectFn: async (_config, sessionOptions) => {
      passedSessionOptions = sessionOptions;
      return {
        connected: true,
        model: { id: 'test-model' },
        sessionId: 'hist-sess-id',
        sessionFile: 'C:/sessions/hist-sess.jsonl',
        messageCount: 3,
        messages: [{ role: 'user', content: 'hi' }],
      };
    },
    ensureListenersReadyFn: async () => {},
  });

  await manager.start({
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/hist-project',
  });

  // Must require that the historical session file exists on disk
  assert.deepStrictEqual(passedSessionOptions, {
    sessionFile: 'C:/sessions/hist-sess.jsonl',
    requireSessionFileExists: true,
  });
});

test('StartupManager: missing historical session fails clearly without overwriting stored reference', async () => {
  const mockStorage = createMockStorage();

  // Pre-store a historical session
  saveSessionRecord(
    {
      sessionId: 'deleted-historical-sess',
      sessionFile: 'C:/sessions/deleted.jsonl',
      cwd: 'C:/projects/missing-file-project',
      hasMessages: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let capturedError: string | null = null;
  const manager = new StartupManager({
    storage: mockStorage,
    connectFn: async (_config, sessionOptions) => {
      if (sessionOptions?.requireSessionFileExists) {
        throw new Error(
          `Saved session file not found: '${sessionOptions.sessionFile}'. File may have been moved or deleted.`
        );
      }
      return { connected: true, model: null };
    },
    onError: (err) => {
      capturedError = err;
    },
    ensureListenersReadyFn: async () => {},
  });

  await manager.start({
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/missing-file-project',
  });

  // 1. Must report truthful error
  assert.ok(capturedError);
  assert.ok(
    (capturedError as string).includes('Saved session file not found: \'C:/sessions/deleted.jsonl\'')
  );

  // 2. Crucial: Stored reference must NOT be overwritten on failure!
  const storedAfterFail = loadSessionRecord(
    'C:/projects/missing-file-project',
    mockStorage
  );
  assert.ok(storedAfterFail.record);
  assert.strictEqual(storedAfterFail.record.sessionId, 'deleted-historical-sess');
});

test('StartupManager: New conversation recovery explicitly starts fresh and updates reference only after success', async () => {
  const mockStorage = createMockStorage();

  saveSessionRecord(
    {
      sessionId: 'broken-historical-sess',
      sessionFile: 'C:/sessions/broken.jsonl',
      cwd: 'C:/projects/recovery-project',
      hasMessages: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let passedOptions: unknown = null;
  let connectSucceeds = false;

  const manager = new StartupManager({
    storage: mockStorage,
    connectFn: async (_config, sessionOptions) => {
      passedOptions = sessionOptions;
      if (!connectSucceeds) {
        throw new Error('Node execution failed');
      }
      return {
        connected: true,
        model: null,
        sessionId: 'fresh-recovery-sess',
        sessionFile: 'C:/sessions/fresh-recovery.jsonl',
        messageCount: 0,
      };
    },
    ensureListenersReadyFn: async () => {},
  });

  // Attempt 1: Start fresh with recovery, but connect fails
  connectSucceeds = false;
  await manager.start(
    {
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/recovery-project',
    },
    { freshSession: true, force: true }
  );

  // Fresh session must omit sessionFile
  assert.deepStrictEqual(passedOptions, {
    sessionFile: undefined,
    requireSessionFileExists: false,
  });

  // Failure must NOT overwrite existing record
  const check1 = loadSessionRecord('C:/projects/recovery-project', mockStorage);
  assert.strictEqual(check1.record?.sessionId, 'broken-historical-sess');

  // Attempt 2: Start fresh with recovery, connect succeeds
  connectSucceeds = true;
  await manager.start(
    {
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/recovery-project',
    },
    { freshSession: true, force: true }
  );

  // Success updates to the fresh session reference!
  const check2 = loadSessionRecord('C:/projects/recovery-project', mockStorage);
  assert.strictEqual(check2.record?.sessionId, 'fresh-recovery-sess');
  assert.strictEqual(check2.record?.hasMessages, false);
});

test('Session persistence marker: prompt submission or rejection does NOT mark hasMessages: true', () => {
  const mockStorage = createMockStorage();

  // Fresh session initialized
  saveSessionRecord(
    {
      sessionId: 'sess-test-empty',
      sessionFile: 'C:/sessions/test-empty.jsonl',
      cwd: 'C:/projects/test-empty',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  // User submits prompt, but prompt is rejected
  let state = chatReducer(INITIAL_STATE, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: 'Hello' },
  });
  state = chatReducer(state, {
    type: 'PROMPT_REJECTED',
    payload: { id: 'prompt-1', error: 'Agent busy' },
  });

  // Check storage: hasMessages must still be FALSE
  const stored = loadSessionRecord('C:/projects/test-empty', mockStorage);
  assert.strictEqual(stored.record?.hasMessages, false);

  // Resume plan must remain resume_empty (does NOT require disk file)
  const plan = resolveSessionResumePlan('C:/projects/test-empty', mockStorage);
  assert.strictEqual(plan.type, 'resume_empty');
});

test('Session persistence marker: closure before assistant completion keeps hasMessages: false; only assistant completion sets true', () => {
  const mockStorage = createMockStorage();

  saveSessionRecord(
    {
      sessionId: 'sess-streaming',
      sessionFile: 'C:/sessions/sess-streaming.jsonl',
      cwd: 'C:/projects/streaming-test',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  // Streaming starts: message_start and message_update
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: { id: 'test' } },
  });
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: { role: 'assistant', content: 'Incomplete...' },
    },
  });
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: ' more tokens' },
  });

  // App is closed or crashes before message_end arrives: hasMessages MUST still be false!
  const recordBeforeEnd = loadSessionRecord('C:/projects/streaming-test', mockStorage);
  assert.strictEqual(recordBeforeEnd.record?.hasMessages, false);

  // Now simulate authoritative assistant completion
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: { role: 'assistant', content: 'Incomplete... more tokens [DONE]' },
    },
  });
  // App marks persistence evidence on authoritative assistant completion
  updateSessionHasMessages('C:/projects/streaming-test', true, mockStorage);

  const recordAfterEnd = loadSessionRecord('C:/projects/streaming-test', mockStorage);
  assert.strictEqual(recordAfterEnd.record?.hasMessages, true);

  // Reopen now recognizes it as resume_existing (requires disk file)
  const plan = resolveSessionResumePlan('C:/projects/streaming-test', mockStorage);
  assert.strictEqual(plan.type, 'resume_existing');
});

test('New conversation: confirmed cancellation preserves old messages and ready status', () => {
  const existingMessages = [
    { id: '1', role: 'user' as const, content: 'Existing user msg', timestamp: '10:00' },
    { id: '2', role: 'assistant' as const, content: 'Existing asst msg', timestamp: '10:01' },
  ];

  let state = chatReducer(INITIAL_STATE, {
    type: 'SESSION_READY',
    payload: {
      sessionId: 'old-id',
      sessionFile: 'C:/sessions/old.jsonl',
      messages: existingMessages,
    },
  });
  assert.strictEqual(state.isHydrated, true);
  assert.strictEqual(state.connectionStatus, 'connected');

  // Reset initiated
  state = chatReducer(state, { type: 'NEW_CONVERSATION_START' });
  assert.strictEqual(state.isResetting, true);

  // Pi extension confirmed cancellation before any reset occurred
  state = chatReducer(state, { type: 'NEW_CONVERSATION_CANCELLED' });
  assert.strictEqual(state.isResetting, false);
  assert.strictEqual(state.isHydrated, true, 'Old state must remain hydrated and ready');
  assert.strictEqual(state.connectionStatus, 'connected');
  assert.strictEqual(state.messages.length, 2, 'Old messages must be preserved');
  assert.strictEqual(state.sessionId, 'old-id');
});

test('New conversation: partialReset fails closed, blocks prompt sending, and requires reconciliation', () => {
  const existingMessages = [
    { id: '1', role: 'user' as const, content: 'Old message', timestamp: '10:00' },
  ];

  let state = chatReducer(INITIAL_STATE, {
    type: 'SESSION_READY',
    payload: {
      sessionId: 'old-id',
      sessionFile: 'C:/sessions/old.jsonl',
      messages: existingMessages,
    },
  });
  assert.strictEqual(state.isHydrated, true);

  // Reset initiated
  state = chatReducer(state, { type: 'NEW_CONVERSATION_START' });

  // Pi executed new_session, but second step get_state timed out / failed
  state = chatReducer(state, {
    type: 'NEW_CONVERSATION_FAIL',
    payload: { error: 'get_state timed out after new_session' },
  });

  assert.strictEqual(state.isResetting, false);
  // Fail closed: isHydrated MUST be false to block prompt submission!
  assert.strictEqual(state.isHydrated, false, 'Sending must be blocked after partial reset failure');
  assert.strictEqual(state.connectionStatus, 'error');
  assert.strictEqual(state.statusLabel, 'Reset Failed');
  assert.ok(state.lastError?.includes('get_state timed out'));
  // Old messages are retained for reference, NOT cleared claiming false success
  assert.strictEqual(state.messages.length, 1);
});

test('New conversation: initial RPC failure/timeout fails closed and blocks prompt sending', () => {
  let state = chatReducer(INITIAL_STATE, {
    type: 'SESSION_READY',
    payload: {
      sessionId: 'sess-1',
      sessionFile: 'C:/sessions/s1.jsonl',
      messages: [{ id: '1', role: 'user', content: 'test', timestamp: '10:00' }],
    },
  });

  state = chatReducer(state, { type: 'NEW_CONVERSATION_START' });

  // Initial RPC timed out or rejected
  state = chatReducer(state, {
    type: 'NEW_CONVERSATION_FAIL',
    payload: { error: 'new_session RPC timeout (15s)' },
  });

  assert.strictEqual(state.isResetting, false);
  assert.strictEqual(state.isHydrated, false, 'Sending must be blocked on uncertain RPC failure');
  assert.strictEqual(state.connectionStatus, 'error');
});

test('Session: Windows path case-insensitive matching preserves identity without lowercasing POSIX paths', () => {
  const mockStorage = createMockStorage();

  // 1. Save Windows record with specific casing
  saveSessionRecord(
    {
      sessionId: 'win-session',
      sessionFile: 'C:/sessions/win.jsonl',
      cwd: 'C:/Users/Personal/Project',
      hasMessages: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  // Look up using different Windows casing: c:\users\personal\project
  const lookupWin = loadSessionRecord('c:\\users\\personal\\project', mockStorage);
  assert.ok(lookupWin.record, 'Windows path lookup must find record case-insensitively');
  assert.strictEqual(lookupWin.record?.sessionId, 'win-session');

  // Update hasMessages using different casing
  updateSessionHasMessages('C:\\USERS\\PERSONAL\\PROJECT', false, mockStorage);
  const reloadedWin = loadSessionRecord('C:/Users/Personal/Project', mockStorage);
  assert.strictEqual(reloadedWin.record?.hasMessages, false);

  // 2. POSIX paths must remain strictly case-sensitive!
  saveSessionRecord(
    {
      sessionId: 'posix-case-upper',
      sessionFile: '/sessions/upper.jsonl',
      cwd: '/home/user/MyRepo',
      hasMessages: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  // Different case on POSIX: /home/user/myrepo must NOT match /home/user/MyRepo
  const lookupPosixDiff = loadSessionRecord('/home/user/myrepo', mockStorage);
  assert.strictEqual(lookupPosixDiff.record, null, 'POSIX path lookup must remain case-sensitive');

  const lookupPosixSame = loadSessionRecord('/home/user/MyRepo', mockStorage);
  assert.strictEqual(lookupPosixSame.record?.sessionId, 'posix-case-upper');
});

// =============================================================================
// Production SessionEventController Orchestration Tests
// =============================================================================

test('SessionEventController: Settings cwd A -> B switch ensures assistant completion in B marks B, not A', async () => {
  const mockStorage = createMockStorage();

  // Pre-seed session record for dir A and dir B
  saveSessionRecord(
    {
      sessionId: 'sess-a',
      sessionFile: 'C:/sessions/a.jsonl',
      cwd: 'C:/projects/dir-a',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  saveSessionRecord(
    {
      sessionId: 'sess-b',
      sessionFile: 'C:/sessions/b.jsonl',
      cwd: 'C:/projects/dir-b',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let currentConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/dir-a',
  };
  let currentSessionId: string | null = 'sess-a';

  const dispatchedActions: any[] = [];
  const controller = new SessionEventController({
    getCurrentConfig: () => currentConfig,
    getCurrentSessionId: () => currentSessionId,
    dispatch: (action) => dispatchedActions.push(action),
    checkPersistenceFn: async () => ({
      sessionId: currentSessionId!,
      sessionFile: `C:/sessions/${currentSessionId}.jsonl`,
      canonicalCwd: currentConfig.workingDirectory,
      generation: 1,
      messageCount: 2,
      fileExists: true,
    }),
    updateSessionMarkerFn: (cwd, hasMessages) =>
      updateSessionHasMessages(cwd, hasMessages, mockStorage),
  });

  // Now user changes Settings: cwd switches from A to B, new session sess-b connects
  currentConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/dir-b',
  };
  currentSessionId = 'sess-b';

  // In session B, an assistant message_end arrives
  controller.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'Answer in B' },
  });

  // Allow async verification to resolve
  await new Promise((r) => setTimeout(r, 10));

  // Storage for dir B must be marked hasMessages: true
  const recordB = loadSessionRecord('C:/projects/dir-b', mockStorage);
  assert.strictEqual(recordB.record?.hasMessages, true, 'Dir B must be marked historical');

  // Storage for dir A must remain hasMessages: false (NOT contaminated by stale closure)
  const recordA = loadSessionRecord('C:/projects/dir-a', mockStorage);
  assert.strictEqual(recordA.record?.hasMessages, false, 'Dir A must remain empty');
});

test('SessionEventController: Deferred old native response from superseded session is discarded', async () => {
  const mockStorage = createMockStorage();

  saveSessionRecord(
    {
      sessionId: 'sess-new',
      sessionFile: 'C:/sessions/new.jsonl',
      cwd: 'C:/projects/same-cwd',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let currentConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:/pi/cli.js',
    workingDirectory: 'C:/projects/same-cwd',
  };
  let currentSessionId: string | null = 'sess-old';

  let resolveNativeCheck!: (status: SessionPersistenceStatus) => void;
  const deferredCheckPromise = new Promise<SessionPersistenceStatus>((resolve) => {
    resolveNativeCheck = resolve;
  });

  const controller = new SessionEventController({
    getCurrentConfig: () => currentConfig,
    getCurrentSessionId: () => currentSessionId,
    dispatch: () => {},
    checkPersistenceFn: () => deferredCheckPromise,
    updateSessionMarkerFn: (cwd, hasMessages) =>
      updateSessionHasMessages(cwd, hasMessages, mockStorage),
  });

  // Assistant finishes in old session -> check triggered
  controller.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'Old response' },
  });

  // While check is pending, New Conversation resets session to sess-new
  currentSessionId = 'sess-new';

  // Now the deferred check for sess-old finally resolves
  resolveNativeCheck({
    sessionId: 'sess-old',
    sessionFile: 'C:/sessions/old.jsonl',
    canonicalCwd: 'C:/projects/same-cwd',
    generation: 1,
    messageCount: 2,
    fileExists: true,
  });

  await new Promise((r) => setTimeout(r, 10));

  // The active session sess-new must NOT be marked historical by old check
  const record = loadSessionRecord('C:/projects/same-cwd', mockStorage);
  assert.strictEqual(record.record?.sessionId, 'sess-new');
  assert.strictEqual(record.record?.hasMessages, false, 'Stale response must be discarded');
});

test('SessionEventController: First preflight rejection or empty settled does not mark hasMessages', async () => {
  const mockStorage = createMockStorage();

  saveSessionRecord(
    {
      sessionId: 'sess-preflight',
      sessionFile: 'C:/sessions/preflight.jsonl',
      cwd: 'C:/projects/preflight-test',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  let checkCalled = false;
  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/preflight-test',
    }),
    getCurrentSessionId: () => 'sess-preflight',
    dispatch: () => {},
    checkPersistenceFn: async () => {
      checkCalled = true;
      return {
        sessionId: 'sess-preflight',
        sessionFile: 'C:/sessions/preflight.jsonl',
        canonicalCwd: 'C:/projects/preflight-test',
        generation: 1,
        messageCount: 0,
        fileExists: false, // Pi has not created the file
      };
    },
    updateSessionMarkerFn: (cwd, hasMessages) =>
      updateSessionHasMessages(cwd, hasMessages, mockStorage),
  });

  // Prompt rejected; agent settles without assistant message
  controller.handleEvent({
    type: 'agent_settled',
  });

  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(checkCalled, true);
  const record = loadSessionRecord('C:/projects/preflight-test', mockStorage);
  assert.strictEqual(record.record?.hasMessages, false, 'Empty settled must not mark historical');
});

test('SessionEventController: Native file absent or check failure does not mark hasMessages', async () => {
  const mockStorage = createMockStorage();

  saveSessionRecord(
    {
      sessionId: 'sess-fail-disk',
      sessionFile: 'C:/sessions/fail-disk.jsonl',
      cwd: 'C:/projects/fail-disk',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/fail-disk',
    }),
    getCurrentSessionId: () => 'sess-fail-disk',
    dispatch: () => {},
    checkPersistenceFn: async () => {
      throw new Error('Native RPC get_state timeout');
    },
    updateSessionMarkerFn: (cwd, hasMessages) =>
      updateSessionHasMessages(cwd, hasMessages, mockStorage),
  });

  // Assistant message ends, but native check throws
  controller.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'Hello' },
  });

  await new Promise((r) => setTimeout(r, 10));

  const record = loadSessionRecord('C:/projects/fail-disk', mockStorage);
  assert.strictEqual(record.record?.hasMessages, false, 'Failed check must not mark historical');
});

test('SessionEventController: Successful first assistant with confirmed native file marks durability', async () => {
  const mockStorage = createMockStorage();

  saveSessionRecord(
    {
      sessionId: 'sess-success',
      sessionFile: 'C:/sessions/success.jsonl',
      cwd: 'C:/projects/success-test',
      hasMessages: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    mockStorage
  );

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/success-test',
    }),
    getCurrentSessionId: () => 'sess-success',
    dispatch: () => {},
    checkPersistenceFn: async () => ({
      sessionId: 'sess-success',
      sessionFile: 'C:/sessions/success.jsonl',
      canonicalCwd: 'C:/projects/success-test',
      generation: 1,
      messageCount: 2,
      fileExists: true,
    }),
    updateSessionMarkerFn: (cwd, hasMessages) =>
      updateSessionHasMessages(cwd, hasMessages, mockStorage),
  });

  // First completed assistant response
  controller.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'Confirmed assistant response' },
  });

  await new Promise((r) => setTimeout(r, 10));

  const record = loadSessionRecord('C:/projects/success-test', mockStorage);
  assert.strictEqual(record.record?.hasMessages, true, 'Confirmed native file marks hasMessages: true');

  // Durability: subsequent check cannot lower existing true marker
  updateSessionHasMessages('C:/projects/success-test', false, mockStorage);
  // updateSessionHasMessages allows setting, but verifyAndPersistCurrentSession only ever sets true
  const plan = resolveSessionResumePlan('C:/projects/success-test', mockStorage);
  assert.strictEqual(plan.type, 'resume_empty'); // when manually set false
  // Re-run controller check
  await controller.verifyAndPersistCurrentSession();
  const reloaded = loadSessionRecord('C:/projects/success-test', mockStorage);
  assert.strictEqual(reloaded.record?.hasMessages, true, 'Controller restores true marker upon confirmed file');
});

test('SessionEventController: Surfaces storage write warnings when storage throws or fails', async () => {
  let capturedWarning: string | null = null;

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/warn-test',
    }),
    getCurrentSessionId: () => 'sess-warn',
    dispatch: () => {},
    checkPersistenceFn: async () => ({
      sessionId: 'sess-warn',
      sessionFile: 'C:/sessions/warn.jsonl',
      canonicalCwd: 'C:/projects/warn-test',
      generation: 1,
      messageCount: 2,
      fileExists: true,
    }),
    updateSessionMarkerFn: () => ({
      success: false,
      error: 'QuotaExceededError: storage full',
    }),
    onStorageWarning: (w) => {
      capturedWarning = w;
    },
  });

  controller.handleEvent({
    type: 'message_end',
    message: { role: 'assistant', content: 'Content' },
  });

  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(capturedWarning, 'QuotaExceededError: storage full');
});

test('extractThinkingDelta: extracts thinking deltas and rejects non-thinking events', () => {
  assert.strictEqual(
    extractThinkingDelta({ type: 'thinking_delta', delta: 'Analyzing repository structure...' }),
    'Analyzing repository structure...'
  );
  assert.strictEqual(extractThinkingDelta({ type: 'text_delta', delta: 'hello' }), null);
  assert.strictEqual(extractThinkingDelta({ type: 'toolcall_delta', delta: '{"path":"a"}' }), null);
  assert.strictEqual(extractThinkingDelta({ type: 'thinking_start' }), null);
  assert.strictEqual(extractThinkingDelta({ type: 'thinking_end', content: 'done' }), null);
  assert.strictEqual(extractThinkingDelta({ type: 'thinking_delta', delta: '' }), null);
  assert.strictEqual(extractThinkingDelta(null), null);
  assert.strictEqual(extractThinkingDelta(undefined), null);
  assert.strictEqual(extractThinkingDelta({}), null);
});

test('extractToolCallDelta: extracts toolcall deltas and rejects non-toolcall events', () => {
  assert.strictEqual(
    extractToolCallDelta({ type: 'toolcall_delta', delta: '{"path":"src/App.tsx"}' }),
    '{"path":"src/App.tsx"}'
  );
  assert.strictEqual(extractToolCallDelta({ type: 'text_delta', delta: 'hello' }), null);
  assert.strictEqual(extractToolCallDelta({ type: 'thinking_delta', delta: 'thinking...' }), null);
  assert.strictEqual(extractToolCallDelta({ type: 'toolcall_start', id: 'call-1' }), null);
  assert.strictEqual(extractToolCallDelta({ type: 'toolcall_end' }), null);
  assert.strictEqual(extractToolCallDelta({ type: 'toolcall_delta', delta: '' }), null);
  assert.strictEqual(extractToolCallDelta(null), null);
  assert.strictEqual(extractToolCallDelta(undefined), null);
});

test('extractToolOutput: extracts plain text from varied tool output formats', () => {
  // String output
  assert.strictEqual(extractToolOutput('hello world'), 'hello world');

  // Object with output string
  assert.strictEqual(extractToolOutput({ output: 'File contents here' }), 'File contents here');

  // Object with text string
  assert.strictEqual(extractToolOutput({ text: 'Grep results' }), 'Grep results');

  // Object with content block array (standard Pi RPC toolResult)
  assert.strictEqual(
    extractToolOutput({
      content: [
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' },
      ],
    }),
    'Line 1\nLine 2'
  );

  // Object with content string
  assert.strictEqual(extractToolOutput({ content: 'Single string content' }), 'Single string content');

  // Direct array of text objects
  assert.strictEqual(
    extractToolOutput([
      { type: 'text', text: 'Item 1' },
      { type: 'text', text: 'Item 2' },
    ]),
    'Item 1\nItem 2'
  );

  // Null, undefined, empty
  assert.strictEqual(extractToolOutput(null), '');
  assert.strictEqual(extractToolOutput(undefined), '');
  assert.strictEqual(extractToolOutput(123), '');
});

test('Type guards: isToolExecutionStartEvent, isToolExecutionUpdateEvent, isToolExecutionEndEvent', () => {
  assert.strictEqual(
    isToolExecutionStartEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'read',
    }),
    true
  );
  assert.strictEqual(
    isToolExecutionStartEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      // missing toolName
    }),
    false
  );
  assert.strictEqual(isToolExecutionStartEvent({ type: 'message_start' }), false);

  assert.strictEqual(
    isToolExecutionUpdateEvent({
      type: 'tool_execution_update',
      toolCallId: 'call_1',
    }),
    true
  );
  assert.strictEqual(
    isToolExecutionUpdateEvent({
      type: 'tool_execution_update',
      // missing toolCallId
    }),
    false
  );

  assert.strictEqual(
    isToolExecutionEndEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      isError: false,
    }),
    true
  );
  assert.strictEqual(isToolExecutionEndEvent({ type: 'other' }), false);
});

test('formatToolPrimaryArg: formats concise primary args for known tools', () => {
  // read: path
  assert.strictEqual(formatToolPrimaryArg('read', { path: 'src/App.tsx' }), 'src/App.tsx');

  // grep: pattern and path
  assert.strictEqual(
    formatToolPrimaryArg('grep', { pattern: 'useState', path: 'src/' }),
    '"useState" in src/'
  );
  assert.strictEqual(formatToolPrimaryArg('grep', { pattern: 'TODO' }), '"TODO"');

  // find: pattern or path
  assert.strictEqual(formatToolPrimaryArg('find', { pattern: '*.tsx' }), '*.tsx');
  assert.strictEqual(formatToolPrimaryArg('find', { path: 'src/' }), 'src/');

  // ls: path
  assert.strictEqual(formatToolPrimaryArg('ls', { path: 'src-tauri' }), 'src-tauri');

  // String args
  assert.strictEqual(formatToolPrimaryArg('custom', 'simple-arg'), 'simple-arg');

  // Null/undefined
  assert.strictEqual(formatToolPrimaryArg('read', null), null);
  assert.strictEqual(formatToolPrimaryArg('read', undefined), null);
});

test('parseMessageBlocks: parses string and structured blocks into typed MessageBlock array', () => {
  // String content
  const stringBlocks = parseMessageBlocks('Just plain text');
  assert.strictEqual(stringBlocks.length, 1);
  assert.strictEqual(stringBlocks[0].type, 'text');
  assert.strictEqual((stringBlocks[0] as { text: string }).text, 'Just plain text');

  // Empty string
  assert.deepStrictEqual(parseMessageBlocks(''), []);

  // Non-array/non-string
  assert.deepStrictEqual(parseMessageBlocks(null), []);

  // Multi-block content
  const multiBlocks = parseMessageBlocks([
    { type: 'thinking', thinking: 'Let me think about this' },
    { type: 'toolCall', id: 'call_42', name: 'read', arguments: { path: 'Cargo.toml' } },
    { type: 'text', text: 'Here is the Cargo.toml file' },
  ]);

  assert.strictEqual(multiBlocks.length, 3);
  assert.strictEqual(multiBlocks[0].type, 'thinking');
  assert.strictEqual((multiBlocks[0] as ThinkingBlock).thinking, 'Let me think about this');
  assert.strictEqual((multiBlocks[0] as ThinkingBlock).isStreaming, false);

  assert.strictEqual(multiBlocks[1].type, 'tool_call');
  const toolBlock = multiBlocks[1] as ToolCallBlock;
  assert.strictEqual(toolBlock.id, 'call_42');
  assert.strictEqual(toolBlock.name, 'read');
  assert.deepStrictEqual(toolBlock.args, { path: 'Cargo.toml' });
  assert.strictEqual(toolBlock.status, 'completed');

  assert.strictEqual(multiBlocks[2].type, 'text');
  assert.strictEqual((multiBlocks[2] as { text: string }).text, 'Here is the Cargo.toml file');
});

test('Session hydration: pairs historical toolResult messages with preceding assistant toolCall blocks', () => {
  const rawHistory = [
    { role: 'user', content: 'Inspect directory', timestamp: 1000 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Listing repository root...' },
        { type: 'toolCall', id: 'call_ls_1', name: 'ls', arguments: { path: '.' } },
      ],
      timestamp: 2000,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_ls_1',
      toolName: 'ls',
      content: [{ type: 'text', text: 'Cargo.toml\npackage.json\nsrc' }],
      isError: false,
      timestamp: 2500,
    },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call_read_1', name: 'read', arguments: { path: 'package.json' } },
      ],
      timestamp: 3000,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_read_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'File not found' }],
      isError: true,
      timestamp: 3500,
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Completed inspection with 1 success and 1 error.' },
      ],
      timestamp: 4000,
    },
  ];

  const hydrated = hydrateChatMessages(rawHistory);

  // toolResult messages should NOT be standalone messages in hydrated list
  assert.strictEqual(hydrated.length, 4);

  // 1st assistant message: toolCall ls
  const firstAsst = hydrated[1];
  assert.strictEqual(firstAsst.role, 'assistant');
  assert.ok(firstAsst.blocks);
  assert.strictEqual(firstAsst.blocks.length, 2);

  const thinkingBlock = firstAsst.blocks[0] as ThinkingBlock;
  assert.strictEqual(thinkingBlock.type, 'thinking');
  assert.strictEqual(thinkingBlock.thinking, 'Listing repository root...');
  assert.strictEqual(thinkingBlock.isStreaming, false);

  const lsBlock = firstAsst.blocks[1] as ToolCallBlock;
  assert.strictEqual(lsBlock.type, 'tool_call');
  assert.strictEqual(lsBlock.id, 'call_ls_1');
  assert.strictEqual(lsBlock.name, 'ls');
  assert.strictEqual(lsBlock.status, 'completed');
  assert.strictEqual(lsBlock.isError, false);
  assert.strictEqual(lsBlock.output, 'Cargo.toml\npackage.json\nsrc');

  // 2nd assistant message: toolCall read (failed)
  const secondAsst = hydrated[2];
  assert.strictEqual(secondAsst.role, 'assistant');
  const readBlock = secondAsst.blocks?.[0] as ToolCallBlock;
  assert.strictEqual(readBlock.id, 'call_read_1');
  assert.strictEqual(readBlock.status, 'error');
  assert.strictEqual(readBlock.isError, true);
  assert.strictEqual(readBlock.output, 'File not found');

  // 3rd assistant message: final summary
  const thirdAsst = hydrated[3];
  assert.strictEqual(thirdAsst.role, 'assistant');
  assert.strictEqual(thirdAsst.content, 'Completed inspection with 1 success and 1 error.');
});

test('SessionEventController: dispatches thinking and tool execution events to reducer', () => {
  const dispatched: Array<{ type: string; payload?: unknown }> = [];

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: 'C:/pi/cli.js',
      workingDirectory: 'C:/projects/test',
    }),
    getCurrentSessionId: () => 'sess-1',
    dispatch: (action) => {
      dispatched.push(action as { type: string; payload?: unknown });
    },
  });

  // 1. thinking delta in message_update
  controller.handleEvent({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'thinking_delta',
      delta: 'Reasoning about codebase...',
    },
  });
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'EVENT_THINKING_UPDATE');
  assert.deepStrictEqual(dispatched[0].payload, { delta: 'Reasoning about codebase...' });

  // 2. tool_execution_start
  controller.handleEvent({
    type: 'tool_execution_start',
    toolCallId: 'call-grep-1',
    toolName: 'grep',
    args: { pattern: 'find' },
  });
  assert.strictEqual(dispatched.length, 2);
  assert.strictEqual(dispatched[1].type, 'EVENT_TOOL_EXECUTION_START');
  assert.deepStrictEqual(dispatched[1].payload, {
    toolCallId: 'call-grep-1',
    toolName: 'grep',
    args: { pattern: 'find' },
  });

  // 3. tool_execution_update
  controller.handleEvent({
    type: 'tool_execution_update',
    toolCallId: 'call-grep-1',
    partialResult: { content: [{ type: 'text', text: 'match 1' }] },
  });
  assert.strictEqual(dispatched.length, 3);
  assert.strictEqual(dispatched[2].type, 'EVENT_TOOL_EXECUTION_UPDATE');
  assert.deepStrictEqual(dispatched[2].payload, {
    toolCallId: 'call-grep-1',
    output: 'match 1',
  });

  // 4. tool_execution_end
  controller.handleEvent({
    type: 'tool_execution_end',
    toolCallId: 'call-grep-1',
    result: { content: [{ type: 'text', text: 'match 1\nmatch 2' }] },
    isError: false,
  });
  assert.strictEqual(dispatched.length, 4);
  assert.strictEqual(dispatched[3].type, 'EVENT_TOOL_EXECUTION_END');
  assert.deepStrictEqual(dispatched[3].payload, {
    toolCallId: 'call-grep-1',
    output: 'match 1\nmatch 2',
    isError: false,
  });
});

// =============================================================================
// Session History Browser Bridge, Reducer, and Storage Sync Tests
// =============================================================================

test('Bridge: listSessionsPi and switchSessionPi invoke respective Tauri commands', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return [
        {
          id: 'sess-1',
          path: '/sessions/sess-1.jsonl',
          firstMessage: 'Hola',
          messageCount: 3,
          isActive: true,
        },
      ] as T;
    }
    if (cmd === 'switch_session') {
      return {
        cancelled: false,
        sessionId: 'sess-2',
        sessionFile: '/sessions/sess-2.jsonl',
        messageCount: 5,
        messages: [],
        error: null,
      } as T;
    }
    throw new Error(`Unexpected command ${cmd}`);
  };

  const listRes = await listSessionsPi('C:/project', mockInvoke);
  assert.strictEqual(calls[0].cmd, 'list_sessions');
  assert.deepStrictEqual(calls[0].args, { payload: { workingDirectory: 'C:/project' } });
  assert.strictEqual(listRes.length, 1);
  assert.strictEqual(listRes[0].id, 'sess-1');

  const switchRes = await switchSessionPi('/sessions/sess-2.jsonl', mockInvoke);
  assert.strictEqual(calls[1].cmd, 'switch_session');
  assert.deepStrictEqual(calls[1].args, { payload: { sessionPath: '/sessions/sess-2.jsonl' } });
  assert.strictEqual(switchRes.sessionId, 'sess-2');
  assert.strictEqual(switchRes.cancelled, false);
});

test('Session Storage: recordSessionSwitched updates stored session record for cwd', () => {
  const mockStorage = createMockStorage();
  const cwd = 'C:/projects/my-repo';

  const res = recordSessionSwitched(cwd, 'new-sess-123', 'C:/sessions/new.jsonl', true, mockStorage);
  assert.strictEqual(res.success, true);

  const lookup = loadSessionRecord(cwd, mockStorage);
  assert.strictEqual(lookup.record?.sessionId, 'new-sess-123');
  assert.strictEqual(lookup.record?.sessionFile, 'C:/sessions/new.jsonl');
  assert.strictEqual(lookup.record?.hasMessages, true);
});

/* ========================================================================= */
/* Controlled Mutation Tools & Approval Gate Tests                           */
/* ========================================================================= */

test('Config: ignores legacy toolPolicy and requireApproval options without error', () => {
  const res = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    toolPolicy: 'full',
    requireApproval: false,
  });
  assert.strictEqual(res.valid, true);
  assert.strictEqual((res.config as unknown as Record<string, unknown>).toolPolicy, undefined);
  assert.strictEqual((res.config as unknown as Record<string, unknown>).requireApproval, undefined);

  // fileTreeRefreshInterval validation
  const validInterval = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    fileTreeRefreshInterval: 30,
  });
  assert.strictEqual(validInterval.valid, true);
  assert.strictEqual(validInterval.config?.fileTreeRefreshInterval, 30);

  // 0 is valid (disabled)
  const disabledInterval = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    fileTreeRefreshInterval: 0,
  });
  assert.strictEqual(disabledInterval.valid, true);
  assert.strictEqual(disabledInterval.config?.fileTreeRefreshInterval, 0);

  // Floating point rounds to integer
  const floatInterval = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    fileTreeRefreshInterval: 12.6,
  });
  assert.strictEqual(floatInterval.valid, true);
  assert.strictEqual(floatInterval.config?.fileTreeRefreshInterval, 13);

  // Default is 15 when omitted
  const omittedInterval = validateConnectConfig({
    nodePath: 'node',
    piEntrypoint: 'C:\\path\\cli.js',
    workingDirectory: 'C:\\work',
  });
  assert.strictEqual(omittedInterval.valid, true);
  assert.strictEqual(omittedInterval.config?.fileTreeRefreshInterval, 15);

  // Negative number rejected
  const negativeInterval = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    fileTreeRefreshInterval: -5,
  });
  assert.strictEqual(negativeInterval.valid, false);
  assert.match(negativeInterval.error!, /File tree refresh interval must be a non-negative number/);

  // Non-number rejected
  const stringInterval = validateConnectConfig({
    ...VALID_SAMPLE_CONFIG,
    fileTreeRefreshInterval: '15',
  });
  assert.strictEqual(stringInterval.valid, false);
  assert.match(stringInterval.error!, /File tree refresh interval must be a non-negative number/);
});

test('Bridge: getAvailableModelsPi, setModelPi, thinking levels and session stats invoke respective commands', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === 'get_available_models') {
      return {
        models: [
          { id: 'm1', name: 'Model 1', provider: 'prov1', reasoning: true, contextWindow: 200000 },
          { id: 'm2', name: 'Model 2', provider: 'prov2', reasoning: false, contextWindow: 128000 },
        ],
      } as T;
    }
    if (cmd === 'set_model') {
      return { id: args?.modelId as string, provider: args?.provider as string } as T;
    }
    if (cmd === 'get_available_thinking_levels') {
      return { levels: ['off', 'low', 'medium', 'high'] } as T;
    }
    if (cmd === 'set_thinking_level') {
      return {} as T;
    }
    if (cmd === 'get_session_stats') {
      return {
        sessionId: 'sess-1',
        tokens: { input: 1500, output: 300, total: 1800 },
        cost: 0.05,
        contextUsage: { tokens: 1800, contextWindow: 200000, percent: 0.9 },
      } as T;
    }
    throw new Error(`Unhandled command: ${cmd}`);
  };

  // 1. getAvailableModelsPi
  const models = await getAvailableModelsPi(mockInvoke);
  assert.strictEqual(models.length, 2);
  assert.strictEqual(models[0].id, 'm1');
  assert.strictEqual(models[1].id, 'm2');

  // 2. setModelPi
  const modelRes = await setModelPi('prov1', 'm1', mockInvoke);
  assert.strictEqual(modelRes.id, 'm1');
  assert.strictEqual(modelRes.provider, 'prov1');

  // 3. getAvailableThinkingLevelsPi
  const levels = await getAvailableThinkingLevelsPi(mockInvoke);
  assert.deepStrictEqual(levels, ['off', 'low', 'medium', 'high']);

  // 4. setThinkingLevelPi
  await setThinkingLevelPi('high', mockInvoke);

  // 5. getSessionStatsPi
  const stats = await getSessionStatsPi(mockInvoke);
  assert.strictEqual(stats?.sessionId, 'sess-1');
  assert.strictEqual(stats?.tokens?.total, 1800);
  assert.strictEqual(stats?.contextUsage?.percent, 0.9);

  // Verify all calls
  assert.strictEqual(calls.length, 5);
  assert.strictEqual(calls[0].cmd, 'get_available_models');
  assert.strictEqual(calls[1].cmd, 'set_model');
  assert.deepStrictEqual(calls[1].args, { provider: 'prov1', modelId: 'm1' });
  assert.strictEqual(calls[2].cmd, 'get_available_thinking_levels');
  assert.strictEqual(calls[3].cmd, 'set_thinking_level');
  assert.deepStrictEqual(calls[3].args, { level: 'high' });
  assert.strictEqual(calls[4].cmd, 'get_session_stats');
});

test('SessionEventController: refreshes session stats on assistant message_end and agent_settled', async () => {
  const dispatched: any[] = [];
  let statsRefreshedCount = 0;

  const { SessionEventController } = await import('@features/chat/session-events');
  const controller = new SessionEventController({
    getCurrentConfig: () => DEFAULT_CONFIG,
    getCurrentSessionId: () => 'test-session',
    dispatch: (action) => dispatched.push(action),
    refreshSessionStatsFn: async () => {
      statsRefreshedCount++;
      return {
        sessionId: 'test-session',
        tokens: { input: 50, output: 20, total: 70 },
      };
    },
  });

  // Assistant message_end triggers stats refresh
  controller.handleEvent({
    type: 'message_end',
    message: {
      id: 'asst-1',
      role: 'assistant',
      content: 'Done',
    },
  });

  // Wait for async refresh
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(statsRefreshedCount, 1);
  const statsAction = dispatched.find((a) => a.type === 'SET_SESSION_STATS');
  assert.ok(statsAction);
  assert.strictEqual(statsAction.payload.stats.tokens.total, 70);

  // User message_end does NOT trigger stats refresh
  controller.handleEvent({
    type: 'message_end',
    message: {
      id: 'user-1',
      role: 'user',
      content: 'Next',
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(statsRefreshedCount, 1);

  // agent_settled triggers stats refresh
  controller.handleEvent({
    type: 'agent_settled',
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(statsRefreshedCount, 2);
});

