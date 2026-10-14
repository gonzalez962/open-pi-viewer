import assert from 'node:assert/strict';
import test from 'node:test';

import { chatReducer, INITIAL_STATE, type ChatSessionState, type ChatAction } from '@core/reducer';
import { SessionEventController } from '@features/chat/session-events';
import { getAgentWorkingStatus, deriveAgentWorkingStatus } from '@features/chat/agent-working-status';
import type { RpcEventBase } from '@core/types/events';

function createConnectedState(sessionId = 'session-1'): ChatSessionState {
  let state = chatReducer(INITIAL_STATE, {
    type: 'CONNECT_SUCCESS',
    payload: { model: null },
  });
  state = chatReducer(state, {
    type: 'SESSION_READY',
    payload: {
      sessionId,
      sessionFile: `/path/${sessionId}.jsonl`,
      messages: [],
      activity: 'idle',
    },
  });
  return state;
}

function createBusyState(sessionId = 'session-1', prompt = 'Investigate issue'): ChatSessionState {
  const connected = createConnectedState(sessionId);
  return chatReducer(connected, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: prompt },
  });
}

test('S3.1 current-session gentle-agents.activity/v1 setWidget snapshot updates target project indicator without opening a dialog', () => {
  let state = createConnectedState('session-1');
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];

  let dialogOpened = false;
  const mockDialogAdapter = {
    select: async () => { dialogOpened = true; return null; },
    input: async () => { dialogOpened = true; return null; },
    confirm: async () => { dialogOpened = true; return null; },
    cancelPending: () => {},
  };

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    resolveTargetProjectId: (cwd?: string) => (cwd === '/path/project-1' ? 'proj-1' : undefined),
    dispatch: (action) => {
      dispatched.push(action);
      state = chatReducer(state, action);
    },
    dialogAdapter: mockDialogAdapter,
  });

  // Transport: RPC extension_ui_request with setWidget method carrying gentle-agents.activity/v1
  const widgetPayload = {
    schema: 'gentle-agents.activity/v1',
    summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
    tasks: [
      {
        summary: {
          id: 't_abc123',
          agent: 'explore',
          label: 'Map the auth module',
          status: 'running',
          lastStep: 'reading lib/auth.ts',
        },
      },
    ],
  };

  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-req-1',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: [JSON.stringify(widgetPayload)],
    sessionId: 'session-1',
    cwd: '/path/project-1',
  } as unknown as RpcEventBase);

  // Must NOT open a dialog
  assert.equal(dialogOpened, false, 'setWidget must not open an extension UI dialog');

  // Must update indicator for project-1
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading lib/auth.ts');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Trabajando - Explore: reading lib/auth.ts');

  const detailed = deriveAgentWorkingStatus(state, 'en');
  assert.equal(detailed.isWorking, true);
});

test('S3.2 queued, running or waiting subagents continue after main agent settles, prioritize waiting, and clear on terminal snapshot', () => {
  let state = createConnectedState('session-1');
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: (action) => {
      dispatched.push(action);
      state = chatReducer(state, action);
    },
  });

  // 1. Background running subagent arrives
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-1',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: [
      JSON.stringify({
        schema: 'gentle-agents.activity/v1',
        tasks: [
          {
            summary: {
              id: 't1',
              agent: 'worker',
              status: 'running',
              lastStep: 'editing src/app.ts',
            },
          },
        ],
      }),
    ],
    sessionId: 'session-1',
  } as unknown as RpcEventBase);

  // 2. Main agent settles: indicator must continue to represent live subagent
  controller.handleEvent({
    type: 'agent_settled',
    sessionId: 'session-1',
  } as unknown as RpcEventBase);

  assert.equal(state.agentActivity, 'idle');
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Worker: editing src/app.ts');

  // 3. Waiting subagent arrives: indicator must prioritize waiting
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-2',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: [
      JSON.stringify({
        schema: 'gentle-agents.activity/v1',
        tasks: [
          {
            summary: {
              id: 't1',
              agent: 'worker',
              status: 'waiting',
              lastStep: 'asked confirmation',
            },
          },
          {
            summary: {
              id: 't2',
              agent: 'explore',
              status: 'running',
              lastStep: 'scanning files',
            },
          },
        ],
      }),
    ],
    sessionId: 'session-1',
  } as unknown as RpcEventBase);

  assert.equal(getAgentWorkingStatus(state, 'en'), 'Worker: waiting for response');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Worker: esperando respuesta');

  // 4. Terminal snapshot arrives: marks tasks finished or empty -> stops representing tasks
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-3',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: [
      JSON.stringify({
        schema: 'gentle-agents.activity/v1',
        tasks: [
          {
            summary: {
              id: 't1',
              agent: 'worker',
              status: 'completed',
            },
          },
        ],
      }),
    ],
    sessionId: 'session-1',
  } as unknown as RpcEventBase);

  assert.equal(getAgentWorkingStatus(state, 'en'), null);
});

test('S3.3 malformed, unrelated or stale-session widget data does not corrupt activity or mark session waiting, and disconnect resets', () => {
  let state = createConnectedState('session-1');
  const dispatched: Array<ChatAction & { targetProjectId?: string }> = [];

  const controller = new SessionEventController({
    getCurrentConfig: () => ({
      nodePath: 'node',
      piEntrypoint: '/path/pi.js',
      piPath: 'pi',
      model: 'default',
      thinkingLevel: 'low',
      workingDirectory: '/path/project-1',
    }),
    getCurrentSessionId: () => 'session-1',
    dispatch: (action) => {
      dispatched.push(action);
      state = chatReducer(state, action);
    },
  });

  // Seed live subagent activity
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-ok',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: [
      JSON.stringify({
        schema: 'gentle-agents.activity/v1',
        tasks: [{ summary: { id: 't1', agent: 'explore', status: 'running', lastStep: 'reading' } }],
      }),
    ],
    sessionId: 'session-1',
  } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');

  // Malformed JSON: does not corrupt live activity
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-bad',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: ['{ invalid json...'],
    sessionId: 'session-1',
  } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');

  // Unrelated widgetKey: does not corrupt live activity
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-other',
    method: 'setWidget',
    widgetKey: 'unrelated-widget',
    widgetLines: [JSON.stringify({ tasks: [] })],
    sessionId: 'session-1',
  } as unknown as RpcEventBase);
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');

  // Stale-session widget event: must not update current session or mark stale session waiting
  const preStaleDispatchCount = dispatched.length;
  controller.handleEvent({
    type: 'extension_ui_request',
    id: 'widget-stale',
    method: 'setWidget',
    widgetKey: 'gentle-agents',
    widgetLines: [JSON.stringify({ schema: 'gentle-agents.activity/v1', tasks: [] })],
    sessionId: 'session-stale-999',
    sessionFile: '/path/stale.jsonl',
  } as unknown as RpcEventBase);

  // Must not have dispatched UPDATE_SESSION_STATUS with status 'waiting'
  const waitingDispatches = dispatched
    .slice(preStaleDispatchCount)
    .filter((a) => a.type === 'UPDATE_SESSION_STATUS' && (a.payload as any)?.status === 'waiting');
  assert.equal(waitingDispatches.length, 0, 'stale setWidget must not mark background session waiting');
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Explore: reading');

  // Disconnect resets activity
  controller.handleStatusChange({
    state: 'disconnected',
    label: 'Disconnected',
    detail: 'Process disconnected',
  });
  assert.equal(getAgentWorkingStatus(state, 'en'), null);
});

test('S3.4 primary-agent tool activity without explicit phase infers exploring, implementing or checking phases while preserving precedence', () => {
  // Common read/search -> exploring
  let readState = createBusyState();
  readState = chatReducer(readState, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { role: 'assistant', content: [] } },
  });
  readState = chatReducer(readState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't-read', toolName: 'read', args: { path: 'src/app.ts' } },
  });
  assert.equal(getAgentWorkingStatus(readState, 'en'), 'Exploring - Read');
  assert.equal(getAgentWorkingStatus(readState, 'es'), 'Explorando - Read');

  // Common write/edit -> implementing
  let editState = createBusyState();
  editState = chatReducer(editState, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { role: 'assistant', content: [] } },
  });
  editState = chatReducer(editState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't-edit', toolName: 'edit', args: { path: 'src/app.ts' } },
  });
  assert.equal(getAgentWorkingStatus(editState, 'en'), 'Implementing - Edit');
  assert.equal(getAgentWorkingStatus(editState, 'es'), 'Implementando - Edit');

  // Bash validation (test command) -> checking
  let testBashState = createBusyState();
  testBashState = chatReducer(testBashState, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { role: 'assistant', content: [] } },
  });
  testBashState = chatReducer(testBashState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't-bash-test', toolName: 'bash', args: { command: 'npm test' } },
  });
  assert.equal(getAgentWorkingStatus(testBashState, 'en'), 'Checking - Bash');
  assert.equal(getAgentWorkingStatus(testBashState, 'es'), 'Verificando - Bash');

  // Arbitrary bash command -> conservative fallback (Working)
  let arbitraryBashState = createBusyState();
  arbitraryBashState = chatReducer(arbitraryBashState, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { role: 'assistant', content: [] } },
  });
  arbitraryBashState = chatReducer(arbitraryBashState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't-bash-arb', toolName: 'bash', args: { command: 'ls -la' } },
  });
  assert.equal(getAgentWorkingStatus(arbitraryBashState, 'en'), 'Working - Bash');
  assert.equal(getAgentWorkingStatus(arbitraryBashState, 'es'), 'Trabajando - Bash');

  // Explicit phase retains precedence over inferred tool phase
  let explicitState = createBusyState();
  explicitState = chatReducer(explicitState, {
    type: 'EVENT_MESSAGE_START',
    payload: { message: { role: 'assistant', content: [] } },
  });
  explicitState = chatReducer(explicitState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't-phase', toolName: 'gentle_odd_phase', args: { phase: 'planning' } },
  });
  explicitState = chatReducer(explicitState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't-read-2', toolName: 'read', args: { path: 'src/app.ts' } },
  });
  assert.equal(getAgentWorkingStatus(explicitState, 'en'), 'Planning - Read');
  assert.equal(getAgentWorkingStatus(explicitState, 'es'), 'Planificando - Read');
});

test('PRESERVE: streaming thinking and generating distinguish without subagents', () => {
  let state = createBusyState();
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        id: 'asst-1',
        role: 'assistant',
        content: '',
      },
    },
  });
  state = chatReducer(state, {
    type: 'EVENT_THINKING_UPDATE',
    payload: { delta: 'Analyzing problem...' },
  });
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Thinking');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Pensando');
});
