import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionEventController,
  shouldRefreshWorkspaceOnEvent,
} from '@features/chat/session-events';
import { executeAutoStart } from '@features/chat/hooks/useSessionEvents';
import type { ChatAction } from '@core/reducer';
import type { ConnectConfig } from '@core/types/connection';
import type { DiscoveredEnvironment } from '@infra/bridge';
import type {
  ExtensionUiRequest,
  ExtensionUiResponsePayload,
  RpcEventBase,
  SendExtensionUiResponseResult,
} from '@core/types/events';
import type { BridgeStatusPayload } from '@infra/bridge';
import type { ExtensionUiDialogAdapter } from '@core/protocol';

/**
 * NOTE on scope: SessionEventController itself already has substantial real-contract
 * coverage in tests/core/protocol.test.ts (session cwd switch identity, deferred/stale
 * response discarding, first/subsequent persistence checks, storage warnings, event
 * dispatch to the reducer, session stats refresh). This file adds only
 * `shouldRefreshWorkspaceOnEvent`, a decision extracted from App.tsx's former inline
 * `handleEventDispatch` (odd/tasks/architecture-restructure.md, T5d) that has no prior
 * coverage anywhere.
 */

test('shouldRefreshWorkspaceOnEvent: true for a completed tool execution', () => {
  const action = { type: 'EVENT_TOOL_EXECUTION_END' } as unknown as ChatAction;
  assert.strictEqual(shouldRefreshWorkspaceOnEvent(action), true);
});

test('shouldRefreshWorkspaceOnEvent: true when the agent settles', () => {
  const action = { type: 'EVENT_AGENT_SETTLED' } as unknown as ChatAction;
  assert.strictEqual(shouldRefreshWorkspaceOnEvent(action), true);
});

test('shouldRefreshWorkspaceOnEvent: false for unrelated actions, e.g. a thinking update', () => {
  const action = { type: 'EVENT_THINKING_UPDATE' } as unknown as ChatAction;
  assert.strictEqual(shouldRefreshWorkspaceOnEvent(action), false);
});

test('SessionEventController: passes targetProjectId from resolveTargetProjectId on events and status changes', () => {
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: (action) => dispatched.push(action),
    resolveTargetProjectId: (cwd?: string) => {
      if (cwd === '/path/project-1') return 'proj-1';
      if (cwd === '/path/project-2') return 'proj-2';
      return undefined;
    },
    // Mock persistence check to avoid network or native invocations
    checkPersistenceFn: async () => ({
      sessionId: 'session-1',
      sessionFile: '/path/project-1/sess.jsonl',
      canonicalCwd: '/path/project-1',
      generation: 1,
      messageCount: 1,
      fileExists: true,
      hasMessages: true,
    }),
    refreshSessionStatsFn: async () => null,
  });

  // 1. RPC Event with cwd (agent_settled)
  controller.handleEvent({
    type: 'agent_settled',
    cwd: '/path/project-2',
  } as unknown as RpcEventBase);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'EVENT_AGENT_SETTLED');
  assert.strictEqual(dispatched[0].targetProjectId, 'proj-2');

  // 2. RPC Event with cwd (tool_execution_start)
  controller.handleEvent({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'bash',
    cwd: '/path/project-1',
  } as unknown as RpcEventBase);
  assert.strictEqual(dispatched.length, 2);
  assert.strictEqual(dispatched[1].type, 'EVENT_TOOL_EXECUTION_START');
  assert.strictEqual(dispatched[1].targetProjectId, 'proj-1');

  // 3. Status change with cwd
  controller.handleStatusChange({
    state: 'connected',
    cwd: '/path/project-2',
    model: { id: 'model-a' },
  } as unknown as BridgeStatusPayload);
  assert.strictEqual(dispatched.length, 3);
  assert.strictEqual(dispatched[2].type, 'CONNECT_SUCCESS');
  assert.strictEqual(dispatched[2].targetProjectId, 'proj-2');

  // 4. Bridge error (no cwd)
  controller.handleError('Fatal connection error');
  assert.strictEqual(dispatched.length, 4);
  assert.strictEqual(dispatched[3].type, 'CONNECT_FAIL');
  assert.strictEqual(dispatched[3].targetProjectId, undefined);
});

test('SessionEventController: defaults targetProjectId to undefined when resolveTargetProjectId is not supplied', () => {
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: (action) => dispatched.push(action),
  });

  controller.handleEvent({
    type: 'agent_settled',
    cwd: '/path/project-1',
  } as unknown as RpcEventBase);

  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'EVENT_AGENT_SETTLED');
  assert.strictEqual(dispatched[0].targetProjectId, undefined);
});

test('SessionEventController: handles select, input, and confirm dialog requests with adapter', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  const mockSend = async (payload: ExtensionUiResponsePayload): Promise<SendExtensionUiResponseResult> => {
    responses.push(payload);
    return { id: payload.id, success: true };
  };

  const mockAdapter: ExtensionUiDialogAdapter = {
    select: async (req) => {
      if (req.id === 'sel-ok') return 'option-b';
      return null;
    },
    input: async (req) => {
      if (req.id === 'inp-ok') return 'user entered value';
      return null;
    },
    confirm: async (req) => {
      if (req.id === 'conf-true') return true;
      if (req.id === 'conf-false') return false;
      return null;
    },
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: mockAdapter,
    sendExtensionUiResponseFn: mockSend,
  });

  // 1. Select success
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'sel-ok',
    method: 'select',
    options: ['option-a', 'option-b'],
  });
  assert.strictEqual(responses.length, 1);
  assert.deepStrictEqual(responses[0], {
    id: 'sel-ok',
    method: 'select',
    value: 'option-b',
  });

  // 2. Select cancelled
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'sel-cancel',
    method: 'select',
    options: ['option-a', 'option-b'],
  });
  assert.strictEqual(responses.length, 2);
  assert.deepStrictEqual(responses[1], {
    id: 'sel-cancel',
    method: 'select',
    cancelled: true,
  });

  // 3. Input success
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'inp-ok',
    method: 'input',
    title: 'Enter text',
  });
  assert.strictEqual(responses.length, 3);
  assert.deepStrictEqual(responses[2], {
    id: 'inp-ok',
    method: 'input',
    value: 'user entered value',
  });

  // 4. Input cancelled
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'inp-cancel',
    method: 'input',
    title: 'Enter text',
  });
  assert.strictEqual(responses.length, 4);
  assert.deepStrictEqual(responses[3], {
    id: 'inp-cancel',
    method: 'input',
    cancelled: true,
  });

  // 5. Confirm true
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'conf-true',
    method: 'confirm',
    title: 'Confirm deletion',
  });
  assert.strictEqual(responses.length, 5);
  assert.deepStrictEqual(responses[4], {
    id: 'conf-true',
    method: 'confirm',
    confirmed: true,
  });

  // 6. Confirm false
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'conf-false',
    method: 'confirm',
    title: 'Confirm deletion',
  });
  assert.strictEqual(responses.length, 6);
  assert.deepStrictEqual(responses[5], {
    id: 'conf-false',
    method: 'confirm',
    confirmed: false,
  });

  // 7. Confirm cancelled (null)
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'conf-cancel',
    method: 'confirm',
    title: 'Confirm deletion',
  });
  assert.strictEqual(responses.length, 7);
  assert.deepStrictEqual(responses[6], {
    id: 'conf-cancel',
    method: 'confirm',
    cancelled: true,
  });
});

test('SessionEventController: catches async adapter failures and safely attempts cancellation', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  const mockSend = async (payload: ExtensionUiResponsePayload): Promise<SendExtensionUiResponseResult> => {
    responses.push(payload);
    return { id: payload.id, success: true };
  };

  const throwingAdapter: ExtensionUiDialogAdapter = {
    select: async () => {
      throw new Error('Unexpected dialog prompt failure');
    },
    input: async () => {
      throw new Error('Unexpected input failure');
    },
    confirm: async () => {
      throw new Error('Unexpected confirm failure');
    },
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: throwingAdapter,
    sendExtensionUiResponseFn: mockSend,
  });

  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'req-err-1',
    method: 'select',
    options: ['A', 'B'],
  });

  assert.strictEqual(responses.length, 1);
  assert.deepStrictEqual(responses[0], {
    id: 'req-err-1',
    method: 'select',
    cancelled: true,
  });
});

test('SessionEventController: ignores duplicate in-flight dialog request IDs', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  let resolveFirst: (val: string) => void = () => {};

  const slowAdapter: ExtensionUiDialogAdapter = {
    select: async (req) => {
      if (req.id === 'slow-req') {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return 'other';
    },
    input: async () => null,
    confirm: async () => null,
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: slowAdapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  const req: ExtensionUiRequest = {
    type: 'extension_ui_request',
    id: 'slow-req',
    method: 'select',
    options: ['A', 'B'],
  };

  // Dispatch first request (stays pending)
  const p1 = controller.handleExtensionUiRequest(req);
  // Dispatch second request with same ID while first is pending
  const p2 = controller.handleExtensionUiRequest(req);

  // Resolve first
  resolveFirst('A');
  await Promise.all([p1, p2]);

  // Exactly one response sent
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].id, 'slow-req');
  assert.strictEqual(responses[0].value, 'A');
});

test('SessionEventController: cancels pending dialog requests on disconnect or error', async () => {
  const responses: ExtensionUiResponsePayload[] = [];

  const hangingAdapter: ExtensionUiDialogAdapter = {
    select: () => new Promise(() => {}), // never resolves
    input: async () => null,
    confirm: async () => null,
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: hangingAdapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  // Start hanging dialog
  void controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'hanging-req',
    method: 'select',
    options: ['X', 'Y'],
  });

  // Disconnect arrives
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Session closed',
  });

  // Cancellation was sent
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].id, 'hanging-req');
  assert.strictEqual(responses[0].cancelled, true);
});

test('SessionEventController: retains request cwd on success, cancellation, and adapter error', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  const mockSend = async (payload: ExtensionUiResponsePayload): Promise<SendExtensionUiResponseResult> => {
    responses.push(payload);
    return { id: payload.id, success: true };
  };

  const adapter: ExtensionUiDialogAdapter = {
    select: async (req) => {
      if (req.id === 'sel-ok') return 'choice-a';
      return null;
    },
    input: async (req) => {
      if (req.id === 'inp-err') throw new Error('Input timeout/failure');
      return null;
    },
    confirm: async () => null,
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: adapter,
    sendExtensionUiResponseFn: mockSend,
  });

  // 1. Success with cwd
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'sel-ok',
    method: 'select',
    options: ['choice-a'],
    cwd: '/path/project-alpha',
  });
  assert.strictEqual(responses.length, 1);
  assert.deepStrictEqual(responses[0], {
    id: 'sel-ok',
    method: 'select',
    value: 'choice-a',
    cwd: '/path/project-alpha',
  });

  // 2. Cancellation with cwd (user returned null)
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'sel-cancel',
    method: 'select',
    options: ['choice-a'],
    cwd: '/path/project-alpha',
  });
  assert.strictEqual(responses.length, 2);
  assert.deepStrictEqual(responses[1], {
    id: 'sel-cancel',
    method: 'select',
    cancelled: true,
    cwd: '/path/project-alpha',
  });

  // 3. Adapter error/timeout with cwd
  await controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'inp-err',
    method: 'input',
    cwd: '/path/project-beta',
  });
  assert.strictEqual(responses.length, 3);
  assert.deepStrictEqual(responses[2], {
    id: 'inp-err',
    method: 'input',
    cancelled: true,
    cwd: '/path/project-beta',
  });
});

test('SessionEventController: retains originating cwd across project switch', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  let currentActiveDir = '/path/project-a';
  let resolveDialog: (val: string) => void = () => {};

  const deferredAdapter: ExtensionUiDialogAdapter = {
    select: async () => {
      return new Promise<string>((resolve) => {
        resolveDialog = resolve;
      });
    },
    input: async () => null,
    confirm: async () => null,
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: currentActiveDir,
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: deferredAdapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  // 1. Dialog request arrives for Project A while Project A is active
  const dialogPromise = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-project-a',
    method: 'select',
    options: ['Option 1'],
    cwd: '/path/project-a',
  });

  // 2. User switches active project to Project B!
  currentActiveDir = '/path/project-b';

  // 3. User now answers the Project A dialog while Project B is active
  resolveDialog('Option 1');
  await dialogPromise;

  // 4. Response must carry Project A's cwd, NOT the new active Project B
  assert.strictEqual(responses.length, 1);
  assert.deepStrictEqual(responses[0], {
    id: 'dlg-project-a',
    method: 'select',
    value: 'Option 1',
    cwd: '/path/project-a',
  });
});

test('SessionEventController: selective cancellation on session close/disconnect by cwd', async () => {
  const responses: ExtensionUiResponsePayload[] = [];

  const hangingAdapter: ExtensionUiDialogAdapter = {
    select: () => new Promise(() => {}), // never resolves
    input: async () => null,
    confirm: async () => null,
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-a',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: hangingAdapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  // Start dialog for Project A
  void controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'select',
    options: ['A1'],
    cwd: '/path/project-a',
  });

  // Start dialog for Project B
  void controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'select',
    options: ['B1'],
    cwd: '/path/project-b',
  });

  // Disconnect arrives for Project A only
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Project A closed',
    cwd: '/path/project-a',
  });

  // Only Project A's dialog is cancelled
  assert.strictEqual(responses.length, 1);
  assert.deepStrictEqual(responses[0], {
    id: 'dlg-a',
    cancelled: true,
    cwd: '/path/project-a',
  });

  // Disconnect arrives for Project B
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Project B closed',
    cwd: '/path/project-b',
  });

  // Project B's dialog is now cancelled
  assert.strictEqual(responses.length, 2);
  assert.deepStrictEqual(responses[1], {
    id: 'dlg-b',
    cancelled: true,
    cwd: '/path/project-b',
  });
});

test('SessionEventController: avoids ID collision across different cwds', async () => {
  const responses: ExtensionUiResponsePayload[] = [];

  const adapter: ExtensionUiDialogAdapter = {
    select: async (req) => {
      if (req.cwd === '/path/project-a') return 'from-a';
      if (req.cwd === '/path/project-b') return 'from-b';
      return null;
    },
    input: async () => null,
    confirm: async () => null,
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-a',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: adapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  // Both projects emit request with same ID: "shared-dialog-id"
  const p1 = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'shared-dialog-id',
    method: 'select',
    options: ['opt'],
    cwd: '/path/project-a',
  });

  const p2 = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'shared-dialog-id',
    method: 'select',
    options: ['opt'],
    cwd: '/path/project-b',
  });

  await Promise.all([p1, p2]);

  // Both responses were processed and sent with their respective cwds
  assert.strictEqual(responses.length, 2);
  const respA = responses.find((r) => r.cwd === '/path/project-a');
  const respB = responses.find((r) => r.cwd === '/path/project-b');
  assert.ok(respA);
  assert.ok(respB);
  assert.strictEqual(respA.id, 'shared-dialog-id');
  assert.strictEqual(respA.value, 'from-a');
  assert.strictEqual(respB.id, 'shared-dialog-id');
  assert.strictEqual(respB.value, 'from-b');
});

test('SessionEventController: notifies dialogAdapter.cancelPending on cwd-scoped disconnect and avoids duplicate cancellations', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  const adapterCancelCalls: Array<string | undefined> = [];

  let resolveA: ((val: string | null) => void) | null = null;
  let resolveB: ((val: string | null) => void) | null = null;

  const adapter: ExtensionUiDialogAdapter = {
    select: (req) => {
      return new Promise<string | null>((res) => {
        if (req.cwd === '/path/project-a') resolveA = res;
        if (req.cwd === '/path/project-b') resolveB = res;
      });
    },
    input: () => Promise.resolve(null),
    confirm: () => Promise.resolve(null),
    cancelPending: (cwd?: string) => {
      adapterCancelCalls.push(cwd);
      if ((cwd === '/path/project-a' || cwd === undefined) && typeof resolveA === 'function') {
        (resolveA as (val: string | null) => void)(null);
      }
      if ((cwd === '/path/project-b' || cwd === undefined) && typeof resolveB === 'function') {
        (resolveB as (val: string | null) => void)(null);
      }
    },
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-a',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: adapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  const pA = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'select',
    options: ['A'],
    cwd: '/path/project-a',
  });

  const pB = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'select',
    options: ['B'],
    cwd: '/path/project-b',
  });

  // Project A disconnects
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Closed project A',
    cwd: '/path/project-a',
  });

  // Await A's promise completion
  await pA;

  // Verify adapter was notified with project A cwd
  assert.strictEqual(adapterCancelCalls.length, 1);
  assert.strictEqual(adapterCancelCalls[0], '/path/project-a');

  // Verify exactly 1 cancellation response was sent for Project A
  assert.strictEqual(responses.length, 1);
  assert.deepStrictEqual(responses[0], {
    id: 'dlg-a',
    cancelled: true,
    cwd: '/path/project-a',
  });

  // Project B is still pending and can now be resolved by user
  if (typeof resolveB === 'function') {
    (resolveB as (val: string | null) => void)('selected-b');
  }
  await pB;

  // Project B response sent without being cancelled
  assert.strictEqual(responses.length, 2);
  assert.deepStrictEqual(responses[1], {
    id: 'dlg-b',
    method: 'select',
    value: 'selected-b',
    cwd: '/path/project-b',
  });
});

test('SessionEventController: notifies dialogAdapter.cancelPending on global error', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  const adapterCancelCalls: Array<string | undefined> = [];

  let resolve1: ((val: string | null) => void) | null = null;

  const adapter: ExtensionUiDialogAdapter = {
    select: () => {
      return new Promise<string | null>((res) => {
        resolve1 = res;
      });
    },
    input: () => Promise.resolve(null),
    confirm: () => Promise.resolve(null),
    cancelPending: (cwd?: string) => {
      adapterCancelCalls.push(cwd);
      if (typeof resolve1 === 'function') {
        (resolve1 as (val: string | null) => void)(null);
      }
    },
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: adapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  const p1 = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-global',
    method: 'select',
    options: ['G'],
    cwd: '/path/project',
  });

  controller.handleError('Fatal process death');
  await p1;

  assert.strictEqual(adapterCancelCalls.length, 1);
  assert.strictEqual(adapterCancelCalls[0], undefined);
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].id, 'dlg-global');
  assert.strictEqual(responses[0].cancelled, true);
});

test('SessionEventController: scoped disconnect cancels legacy missing-cwd pending requests safely for active session only', async () => {
  const responses: ExtensionUiResponsePayload[] = [];
  const adapterCancelCalls: Array<{ cwd?: string; activeCwd?: string }> = [];

  let resolveActiveLegacy: ((val: string | null) => void) | null = null;
  let resolveExplicitB: ((val: string | null) => void) | null = null;

  const adapter: ExtensionUiDialogAdapter = {
    select: (req) => {
      return new Promise<string | null>((res) => {
        if (!req.cwd) resolveActiveLegacy = res;
        if (req.cwd === '/path/project-b') resolveExplicitB = res;
      });
    },
    input: () => Promise.resolve(null),
    confirm: () => Promise.resolve(null),
    cancelPending: (cwd, activeCwd) => {
      adapterCancelCalls.push({ cwd, activeCwd });
      if (cwd === '/path/project-b') {
        if (typeof resolveExplicitB === 'function') {
          (resolveExplicitB as (val: string | null) => void)(null);
        }
      }
      if (cwd === '/path/project-a') {
        if (typeof resolveActiveLegacy === 'function') {
          (resolveActiveLegacy as (val: string | null) => void)(null);
        }
      }
    },
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/to/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-a', // Active session is Project A
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: () => {},
    dialogAdapter: adapter,
    sendExtensionUiResponseFn: async (payload) => {
      responses.push(payload);
      return { id: payload.id, success: true };
    },
  });

  // 1. Enqueue legacy request with missing cwd
  const pLegacy = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-legacy',
    method: 'select',
    options: ['L'],
  });

  // 2. Enqueue request for Project B
  const pB = controller.handleExtensionUiRequest({
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'select',
    options: ['B'],
    cwd: '/path/project-b',
  });

  // Disconnect arrives for Project B (active session is Project A)
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Closed project B',
    cwd: '/path/project-b',
  });

  await pB;

  // Only Project B request was cancelled
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].id, 'dlg-b');

  // Legacy request is STILL pending for active session Project A
  // Now disconnect arrives for active session Project A
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Closed project A',
    cwd: '/path/project-a',
  });

  await pLegacy;

  // Legacy request was safely cancelled when active session disconnected
  assert.strictEqual(responses.length, 2);
  assert.strictEqual(responses[1].id, 'dlg-legacy');
  assert.strictEqual(responses[1].cancelled, true);
});

// ---------------------------------------------------------------------------
// executeAutoStart tests (P2 portable connection startup lifecycle)
// ---------------------------------------------------------------------------

test('executeAutoStart: with already-valid config connects directly without discovery', async () => {
  let discoveryCalled = false;
  let connectedConfig: ConnectConfig | null = null;
  const dispatched: any[] = [];

  const validConfig: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:\\pi\\cli.js',
    workingDirectory: 'C:\\projects\\app',
    fileTreeRefreshInterval: 15,
  };

  const result = await executeAutoStart({
    config: validConfig,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => {
      discoveryCalled = true;
      throw new Error('should not be called');
    },
    startConnection: async (cfg) => {
      connectedConfig = cfg;
    },
    dispatch: (action) => dispatched.push(action),
  });

  assert.strictEqual(result.started, true);
  assert.strictEqual(discoveryCalled, false, 'discovery must not run when saved config has valid paths');
  assert.deepStrictEqual(connectedConfig, validConfig);
  assert.strictEqual(dispatched.length, 0);
});

test('executeAutoStart: with unconfigured config awaits discovery and connects when ready', async () => {
  let connectedConfig: ConnectConfig | null = null;
  const dispatched: any[] = [];

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
    fileTreeRefreshInterval: 15,
  };

  const mockDiscovered: DiscoveredEnvironment = {
    status: 'ready',
    entrypoint: {
      status: 'discovered',
      path: 'C:\\pi\\dist\\cli.js',
      candidates: ['C:\\pi\\dist\\cli.js'],
      message: null,
    },
    initialDirectory: {
      status: 'discovered',
      path: 'C:\\projects\\verified-repo',
      message: null,
    },
    nodePath: 'node',
    issues: [],
  };

  const result = await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => mockDiscovered,
    startConnection: async (cfg) => {
      connectedConfig = cfg;
    },
    dispatch: (action) => dispatched.push(action),
  });

  assert.strictEqual(result.started, true);
  const finalConfig = connectedConfig as ConnectConfig | null;
  assert.ok(finalConfig);
  assert.strictEqual(finalConfig.piEntrypoint, 'C:\\pi\\dist\\cli.js');
  assert.strictEqual(finalConfig.workingDirectory, 'C:\\projects\\verified-repo');
  assert.strictEqual(dispatched.length, 0);
});

test('executeAutoStart: does not auto-connect when Pi CLI entrypoint is missing and dispatches CONNECT_FAIL', async () => {
  let startCalled = false;
  const dispatched: any[] = [];

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  const mockDiscovered: DiscoveredEnvironment = {
    status: 'missing',
    entrypoint: {
      status: 'missing',
      path: null,
      candidates: [],
      message: 'Pi CLI JavaScript entrypoint was not found on system PATH',
    },
    initialDirectory: {
      status: 'discovered',
      path: 'C:\\projects\\demo',
      message: null,
    },
    nodePath: 'node',
    issues: ['Pi CLI JavaScript entrypoint was not found on system PATH'],
  };

  const result = await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => mockDiscovered,
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: (action) => dispatched.push(action),
    targetProjectId: 'proj-1',
  });

  assert.strictEqual(result.started, false);
  assert.strictEqual(startCalled, false, 'must not connect when entrypoint is missing');
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'CONNECT_FAIL');
  assert.strictEqual(dispatched[0].targetProjectId, 'proj-1');
  assert.match(dispatched[0].payload.error, /Pi CLI JavaScript entrypoint was not found/);
});

test('executeAutoStart: does not auto-connect when Pi CLI entrypoint is ambiguous', async () => {
  let startCalled = false;
  const dispatched: any[] = [];

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  const mockDiscovered: DiscoveredEnvironment = {
    status: 'ambiguous',
    entrypoint: {
      status: 'ambiguous',
      path: null,
      candidates: ['C:\\pi1\\cli.js', 'C:\\pi2\\cli.js'],
      message: 'Multiple Pi CLI installations found on system PATH; please select one in Settings.',
    },
    initialDirectory: {
      status: 'discovered',
      path: 'C:\\projects\\demo',
      message: null,
    },
    nodePath: 'node',
    issues: [],
  };

  const result = await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => mockDiscovered,
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: (action) => dispatched.push(action),
  });

  assert.strictEqual(result.started, false);
  assert.strictEqual(startCalled, false, 'must not connect when entrypoint is ambiguous');
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'CONNECT_FAIL');
  assert.match(dispatched[0].payload.error, /Multiple Pi CLI installations found/);
});

test('executeAutoStart: does not auto-connect when working directory is not verified', async () => {
  let startCalled = false;
  const dispatched: any[] = [];

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  const mockDiscovered: DiscoveredEnvironment = {
    status: 'missing',
    entrypoint: {
      status: 'discovered',
      path: 'C:\\pi\\cli.js',
      candidates: ['C:\\pi\\cli.js'],
      message: null,
    },
    initialDirectory: {
      status: 'missing',
      path: null,
      message: 'No verified project directory detected; please select a project folder',
    },
    nodePath: 'node',
    issues: ['No verified project directory detected; please select a project folder'],
  };

  const result = await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => mockDiscovered,
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: (action) => dispatched.push(action),
  });

  assert.strictEqual(result.started, false);
  assert.strictEqual(startCalled, false, 'must not auto-connect to guessed location');
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'CONNECT_FAIL');
  assert.match(dispatched[0].payload.error, /No verified project directory detected/);
});

test('executeAutoStart: StrictMode cleanup drops in-flight discovery resolution safely', async () => {
  let startCalled = false;
  const dispatched: any[] = [];
  let isCancelled = false;

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  let resolveDiscovery!: (val: DiscoveredEnvironment) => void;
  const discoveryPromise = new Promise<DiscoveredEnvironment>((resolve) => {
    resolveDiscovery = resolve;
  });

  const runPromise = executeAutoStart({
    config: unconfigured,
    isCancelled: () => isCancelled,
    discoverEnvironmentFn: () => discoveryPromise,
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: (action) => dispatched.push(action),
  });

  // StrictMode unmount runs synchronously while discovery is awaiting
  isCancelled = true;

  // Now discovery finishes
  resolveDiscovery({
    status: 'ready',
    entrypoint: {
      status: 'discovered',
      path: 'C:\\pi\\cli.js',
      candidates: [],
      message: null,
    },
    initialDirectory: {
      status: 'discovered',
      path: 'C:\\projects\\app',
      message: null,
    },
    nodePath: 'node',
    issues: [],
  });

  const result = await runPromise;
  assert.strictEqual(result.started, false);
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(startCalled, false, 'startConnection must not be called after cancellation');
  assert.strictEqual(dispatched.length, 0, 'dispatch must not be called after cancellation');
});

test('executeAutoStart: notifies onMissingConfiguration with partial discovery results when cwd is missing', async () => {
  let missingCallbackParams: any = null;

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  const mockDiscovered: DiscoveredEnvironment = {
    status: 'missing',
    entrypoint: {
      status: 'discovered',
      path: '/usr/local/bin/pi-cli.js',
      candidates: ['/usr/local/bin/pi-cli.js'],
      message: null,
    },
    initialDirectory: {
      status: 'missing',
      path: null,
      message: 'No verified project directory detected; please select a project folder',
    },
    nodePath: '/usr/bin/node',
    issues: ['No verified project directory detected; please select a project folder'],
  };

  const result = await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => mockDiscovered,
    startConnection: async () => {},
    dispatch: () => {},
    onMissingConfiguration: (params) => {
      missingCallbackParams = params;
    },
  });

  assert.strictEqual(result.started, false);
  assert.ok(missingCallbackParams);
  assert.strictEqual(missingCallbackParams.partialConfig.nodePath, '/usr/bin/node');
  assert.strictEqual(missingCallbackParams.partialConfig.piEntrypoint, '/usr/local/bin/pi-cli.js');
  assert.strictEqual(missingCallbackParams.partialConfig.workingDirectory, undefined);
  assert.match(missingCallbackParams.diagnostic, /No verified project directory detected/);
});

test('prefill logic: fills partial discovery values without overwriting existing user edits', () => {
  const userEditedDraft: ConnectConfig = {
    nodePath: 'my-custom-node',
    piEntrypoint: '', // empty: should be prefilled
    workingDirectory: 'C:\\custom\\project', // already filled by user: must NOT be overwritten
    fileTreeRefreshInterval: 15,
  };

  const partialConfig: Partial<ConnectConfig> = {
    nodePath: 'discovered-node',
    piEntrypoint: 'C:\\discovered\\cli.js',
    workingDirectory: 'C:\\discovered\\cwd',
  };

  // Logic matching App.tsx's onMissingConfiguration handler
  const updatedDraft: ConnectConfig = {
    ...userEditedDraft,
    nodePath: userEditedDraft.nodePath.trim() ? userEditedDraft.nodePath : (partialConfig.nodePath || userEditedDraft.nodePath),
    piEntrypoint: userEditedDraft.piEntrypoint.trim() ? userEditedDraft.piEntrypoint : (partialConfig.piEntrypoint || userEditedDraft.piEntrypoint),
    workingDirectory: userEditedDraft.workingDirectory.trim() ? userEditedDraft.workingDirectory : (partialConfig.workingDirectory || userEditedDraft.workingDirectory),
  };

  assert.strictEqual(updatedDraft.nodePath, 'my-custom-node', 'user-edited nodePath must be preserved');
  assert.strictEqual(updatedDraft.workingDirectory, 'C:\\custom\\project', 'user-edited workingDirectory must be preserved');
  assert.strictEqual(updatedDraft.piEntrypoint, 'C:\\discovered\\cli.js', 'empty piEntrypoint must be prefilled from partial discovery');
});

test('executeAutoStart: rejects invalid partial initial config (e.g. relative path) using readiness checker', async () => {
  let discoveryCalled = false;
  let startCalled = false;

  const invalidPartialConfig: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: 'relative/cli.js', // non-empty, but invalid relative path!
    workingDirectory: 'C:\\valid\\dir',
  };

  const result = await executeAutoStart({
    config: invalidPartialConfig,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => {
      discoveryCalled = true;
      return {
        status: 'missing',
        entrypoint: { status: 'missing', path: null, candidates: [] },
        initialDirectory: { status: 'missing', path: null },
        nodePath: null,
        issues: ['Entrypoint missing'],
      };
    },
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: () => {},
  });

  assert.strictEqual(result.started, false);
  assert.strictEqual(startCalled, false, 'must not auto-connect with invalid partial config');
  assert.strictEqual(discoveryCalled, true, 'must attempt discovery when initial config fails isConfigReady');
});

test('executeAutoStart: validates returned readyConfig before connecting and drops invalid discovered paths', async () => {
  let startCalled = false;
  const dispatched: any[] = [];

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  // Discovered reports ready status, but with invalid non-JS extension!
  const invalidDiscovered: DiscoveredEnvironment = {
    status: 'ready',
    entrypoint: {
      status: 'discovered',
      path: 'C:\\pi\\cli.py', // Invalid extension!
      candidates: [],
    },
    initialDirectory: {
      status: 'discovered',
      path: 'C:\\valid\\repo',
    },
    nodePath: 'node',
    issues: [],
  };

  const result = await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => invalidDiscovered,
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: (action) => dispatched.push(action),
  });

  assert.strictEqual(result.started, false);
  assert.strictEqual(startCalled, false, 'must not connect if returned readyConfig fails readiness validation');
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'CONNECT_FAIL');
});

test('executeAutoStart: drops discovered config when manual config change occurs while discovery is in flight (race condition prevention)', async () => {
  let startCalled = false;
  const dispatched: any[] = [];

  const initialConfig: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  let currentConfig = initialConfig;

  let resolveDiscovery!: (val: DiscoveredEnvironment) => void;
  const discoveryPromise = new Promise<DiscoveredEnvironment>((resolve) => {
    resolveDiscovery = resolve;
  });

  const runPromise = executeAutoStart({
    config: initialConfig,
    // Emulates isDiscoveryCancelled guard in useSessionEvents: cancelled if user changes config
    isCancelled: () => currentConfig !== initialConfig,
    discoverEnvironmentFn: () => discoveryPromise,
    startConnection: async () => {
      startCalled = true;
    },
    dispatch: (action) => dispatched.push(action),
  });

  // User manually applies settings while discovery is in flight!
  currentConfig = {
    nodePath: 'node',
    piEntrypoint: 'C:\\user\\applied\\cli.js',
    workingDirectory: 'C:\\user\\project',
  };

  // Now discovery completes later with older/different discovered config
  resolveDiscovery({
    status: 'ready',
    entrypoint: {
      status: 'discovered',
      path: 'C:\\older\\discovered\\cli.js',
      candidates: [],
    },
    initialDirectory: {
      status: 'discovered',
      path: 'C:\\older\\discovered\\repo',
    },
    nodePath: 'node',
    issues: [],
  });

  const result = await runPromise;
  assert.strictEqual(result.started, false);
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(startCalled, false, 'older discovered config must not be started after manual config change');
  assert.strictEqual(dispatched.length, 0);
});

test('executeAutoStart: leaves targetProjectId undefined when workingDirectory is unconfigured or does not match any registered project', async () => {
  const dispatched: any[] = [];

  const unconfigured: ConnectConfig = {
    nodePath: 'node',
    piEntrypoint: '',
    workingDirectory: '',
  };

  await executeAutoStart({
    config: unconfigured,
    isCancelled: () => false,
    discoverEnvironmentFn: async () => ({
      status: 'missing',
      entrypoint: { status: 'missing', path: null, candidates: [] },
      initialDirectory: { status: 'missing', path: null },
      nodePath: null,
      issues: ['No environment detected'],
    }),
    startConnection: async () => {},
    dispatch: (action) => dispatched.push(action),
    targetProjectId: undefined, // Matched cwd was empty, so targetProjectId must be undefined
  });

  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'CONNECT_FAIL');
  assert.strictEqual(dispatched[0].targetProjectId, undefined, 'targetProjectId must be undefined to avoid project identity mismatch');
});

test('SessionEventController: dispatches UPDATE_SESSION_STATUS for background sessions on message_start, extension_ui_request, and agent_settled', () => {
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: 'cli.js',
      workingDirectory: '/repo',
    }),
    getCurrentSessionId: () => 'active-session-1',
    dispatch: (action) => dispatched.push(action),
  });

  // Event from background session 'bg-session-2'
  controller.handleEvent({
    type: 'message_start',
    sessionId: 'bg-session-2',
    sessionFile: '/repo/bg2.jsonl',
    message: { id: 'm-1', role: 'assistant', content: '' },
  } as any);

  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].type, 'UPDATE_SESSION_STATUS');
  assert.strictEqual((dispatched[0] as any).payload.sessionId, 'bg-session-2');
  assert.strictEqual((dispatched[0] as any).payload.status, 'working');

  // Extension UI request from background session
  controller.handleEvent({
    type: 'extension_ui_request',
    sessionId: 'bg-session-2',
    sessionFile: '/repo/bg2.jsonl',
    id: 'req-1',
    method: 'select',
  } as any);

  assert.strictEqual(dispatched.length, 2);
  assert.strictEqual(dispatched[1].type, 'UPDATE_SESSION_STATUS');
  assert.strictEqual((dispatched[1] as any).payload.status, 'waiting');

  // Agent settled from background session
  controller.handleEvent({
    type: 'agent_settled',
    sessionId: 'bg-session-2',
    sessionFile: '/repo/bg2.jsonl',
  } as any);

  assert.strictEqual(dispatched.length, 3);
  assert.strictEqual(dispatched[2].type, 'UPDATE_SESSION_STATUS');
  assert.strictEqual((dispatched[2] as any).payload.status, 'completed');
});
