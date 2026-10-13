import assert from 'node:assert/strict';
import test from 'node:test';

import { chatReducer, INITIAL_STATE, type ChatSessionState } from '@core/reducer';
import type { ChatMessage } from '@core/types/messages';

async function loadStatusModule() {
  return await import('@features/chat/agent-working-status');
}

function createConnectedState(): ChatSessionState {
  return chatReducer(INITIAL_STATE, {
    type: 'CONNECTION_SUCCESS',
    payload: { models: [] },
  });
}

function createBusyRunState(promptText = 'Investigate issue'): ChatSessionState {
  const connected = createConnectedState();
  return chatReducer(connected, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-1', message: promptText },
  });
}

test('S2.1 busy run with explicit phase tool call displays phase and excludes phase tool from work', async () => {
  const { getAgentWorkingStatus, deriveAgentWorkingStatus } = await loadStatusModule();

  let state = createBusyRunState();
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
      },
    },
  });

  // Explicit phase tool call with structured arguments
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: {
      toolCallId: 'phase-call-1',
      toolName: 'gentle_odd_phase',
      args: { phase: 'planning' },
    },
  });

  assert.equal(getAgentWorkingStatus(state, 'en'), 'Planning');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Planificando');

  const detailed = deriveAgentWorkingStatus(state, 'en');
  assert.equal(detailed.isWorking, true);
  assert.equal(detailed.phase, 'planning');
  assert.deepEqual(detailed.runningTools, []);

  // Now a real execution tool starts while the phase is active
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: {
      toolCallId: 'read-call-1',
      toolName: 'read',
      args: { path: 'src/main.ts' },
    },
  });

  // The phase tool must NOT be listed as execution work; only the real tool appears
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Planning - Read');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Planificando - Read');

  // Verify stringified JSON arguments for gentle_odd_phase
  let jsonArgsState = createBusyRunState();
  jsonArgsState = chatReducer(jsonArgsState, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
      },
    },
  });
  jsonArgsState = chatReducer(jsonArgsState, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: {
      toolCallId: 'phase-json-1',
      toolName: 'gentle_odd_phase',
      args: '{"phase":"implementing"}',
    },
  });
  assert.equal(getAgentWorkingStatus(jsonArgsState, 'en'), 'Implementing');
  assert.equal(getAgentWorkingStatus(jsonArgsState, 'es'), 'Implementando');
});

test('S2.2 busy run executing tools includes formatted running tool names, deduplicates, strips MCP prefixes, excludes control tools, and limits overflow', async () => {
  const { getAgentWorkingStatus, deriveAgentWorkingStatus } = await loadStatusModule();

  let state = createBusyRunState();
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
      },
    },
  });

  // Start two bash tools (should deduplicate)
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'b1', toolName: 'bash' },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'b2', toolName: 'bash' },
  });

  // Start an MCP tool (prefix should be stripped and formatted)
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'm1', toolName: 'mcp__filesystem__read_file' },
  });

  // Start control tools from pi-notify (should be excluded)
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'c1', toolName: 'subagent_run' },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'c2', toolName: 'ask_user_choice' },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'c3', toolName: 'ask_user_question' },
  });

  // Without explicit phase, fallback prefix is Working
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Bash/Read-file');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Trabajando - Bash/Read-file');

  // Add more distinct tools to test 3-item limit and overflow suffix: +N
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't3', toolName: 'grep' },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't4', toolName: 'edit' },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 't5', toolName: 'write' },
  });

  // Tools: Bash, Read-file, Grep, Edit, Write -> 5 tools -> first 3 + "+2"
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Bash/Read-file/Grep/+2');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Trabajando - Bash/Read-file/Grep/+2');

  const detailed = deriveAgentWorkingStatus(state, 'en');
  assert.deepEqual(detailed.runningTools, ['Bash', 'Read-file', 'Grep', 'Edit', 'Write']);
});

test('S2.3 busy run with streaming thinking or assistant text and no explicit phase distinguishes thinking from response generation', async () => {
  const { getAgentWorkingStatus, deriveAgentWorkingStatus } = await loadStatusModule();

  let state = createBusyRunState();
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
      },
    },
  });

  // 1. Streaming thinking deltas arrive
  state = chatReducer(state, {
    type: 'EVENT_THINKING_UPDATE',
    payload: { delta: 'Considering architectural implications...' },
  });

  assert.equal(getAgentWorkingStatus(state, 'en'), 'Thinking');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Pensando');
  assert.equal(deriveAgentWorkingStatus(state, 'en').activityKind, 'thinking');

  // 2. Assistant text begins streaming (which completes thinking block)
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_UPDATE',
    payload: { delta: 'Based on the analysis, here is the approach:' },
  });

  assert.equal(getAgentWorkingStatus(state, 'en'), 'Generating');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Generando');
  assert.equal(deriveAgentWorkingStatus(state, 'en').activityKind, 'generating');
});

test('S2.4 busy run without activity evidence or after tool finishes falls back without reusing completed tools or phases from earlier run', async () => {
  const { getAgentWorkingStatus } = await loadStatusModule();

  // 1. Busy run immediately after prompt submission, before assistant message or tool calls
  const freshBusyState = createBusyRunState();
  assert.equal(getAgentWorkingStatus(freshBusyState, 'en'), 'Working');
  assert.equal(getAgentWorkingStatus(freshBusyState, 'es'), 'Trabajando');

  // 2. Tool finishes (status: completed) -> falls back without showing finished tool
  let state = createBusyRunState();
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_START',
    payload: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
      },
    },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: { toolCallId: 'call-1', toolName: 'bash' },
  });
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working - Bash');

  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_END',
    payload: { toolCallId: 'call-1' },
  });
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Trabajando');

  // 3. Across runs: Turn 1 reports phase 'exploring' and finishes tool 'bash', then settles
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_START',
    payload: {
      toolCallId: 'phase-old',
      toolName: 'gentle_odd_phase',
      args: { phase: 'exploring' },
    },
  });
  state = chatReducer(state, {
    type: 'EVENT_TOOL_EXECUTION_END',
    payload: { toolCallId: 'phase-old' },
  });
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Exploring');

  // Turn 1 completes and settles
  state = chatReducer(state, {
    type: 'EVENT_MESSAGE_END',
    payload: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Turn 1 finished.' }],
      },
    },
  });
  state = chatReducer(state, { type: 'EVENT_AGENT_SETTLED' });

  // Now Turn 2 is submitted
  state = chatReducer(state, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'prompt-2', message: 'Second request' },
  });

  // Turn 2 MUST NOT reuse 'exploring' or old tools from Turn 1!
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working');
  assert.equal(getAgentWorkingStatus(state, 'es'), 'Trabajando');

  // Queued messages must also not inject stale activity
  state = chatReducer(state, {
    type: 'PROMPT_QUEUED',
    payload: { id: 'prompt-queued', message: 'Queued request' },
  });
  assert.equal(getAgentWorkingStatus(state, 'en'), 'Working');
});

test('S2.5 idle agent or disconnected session containing old running blocks reports no working activity', async () => {
  const { getAgentWorkingStatus, deriveAgentWorkingStatus } = await loadStatusModule();

  // 1. Fully connected but idle state
  const idleState = createConnectedState();
  assert.equal(getAgentWorkingStatus(idleState, 'en'), null);
  assert.equal(deriveAgentWorkingStatus(idleState, 'en').isWorking, false);

  // 2. Idle state with historical messages containing old blocks
  const historicalIdleState: ChatSessionState = {
    ...idleState,
    agentActivity: 'idle',
    messages: [
      {
        id: 'old-msg',
        role: 'assistant',
        content: 'Historical message',
        timestamp: '12:00:00',
        blocks: [
          {
            type: 'tool_call',
            id: 'old-call',
            name: 'bash',
            status: 'running', // stale block in history
          },
        ],
      },
    ],
  };
  assert.equal(getAgentWorkingStatus(historicalIdleState, 'en'), null);
  assert.equal(deriveAgentWorkingStatus(historicalIdleState, 'en').isWorking, false);

  // 3. Disconnected state while busy
  const disconnectedState: ChatSessionState = {
    ...historicalIdleState,
    connectionStatus: 'disconnected',
    agentActivity: 'busy',
  };
  assert.equal(getAgentWorkingStatus(disconnectedState, 'en'), null);
  assert.equal(deriveAgentWorkingStatus(disconnectedState, 'en').isWorking, false);

  // 4. Error connection status
  const errorConnectionState: ChatSessionState = {
    ...historicalIdleState,
    connectionStatus: 'error',
    agentActivity: 'busy',
  };
  assert.equal(getAgentWorkingStatus(errorConnectionState, 'en'), null);
  assert.equal(deriveAgentWorkingStatus(errorConnectionState, 'en').isWorking, false);
});

test('S2.6 English and Spanish UI preferences localize phase and fallback labels while preserving tool identities', async () => {
  const { getAgentWorkingStatus } = await loadStatusModule();

  const phases = [
    { token: 'authorizing', en: 'Authorizing', es: 'Autorizando' },
    { token: 'exploring', en: 'Exploring', es: 'Explorando' },
    { token: 'researching', en: 'Researching', es: 'Investigando' },
    { token: 'deciding', en: 'Deciding', es: 'Decidiendo' },
    { token: 'planning', en: 'Planning', es: 'Planificando' },
    { token: 'implementing', en: 'Implementing', es: 'Implementando' },
    { token: 'checking', en: 'Checking', es: 'Verificando' },
    { token: 'closing', en: 'Closing', es: 'Cerrando' },
  ];

  for (const { token, en, es } of phases) {
    let state = createBusyRunState();
    state = chatReducer(state, {
      type: 'EVENT_MESSAGE_START',
      payload: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
        },
      },
    });
    state = chatReducer(state, {
      type: 'EVENT_TOOL_EXECUTION_START',
      payload: {
        toolCallId: `call-${token}`,
        toolName: 'gentle_odd_phase',
        args: { phase: token },
      },
    });

    assert.equal(getAgentWorkingStatus(state, 'en'), en, `English label mismatch for ${token}`);
    assert.equal(getAgentWorkingStatus(state, 'es'), es, `Spanish label mismatch for ${token}`);

    // With running tool: tool identity preserved verbatim while phase is localized
    state = chatReducer(state, {
      type: 'EVENT_TOOL_EXECUTION_START',
      payload: {
        toolCallId: `subtool-${token}`,
        toolName: 'read',
      },
    });
    assert.equal(getAgentWorkingStatus(state, 'en'), `${en} - Read`);
    assert.equal(getAgentWorkingStatus(state, 'es'), `${es} - Read`);
  }
});

test('PRESERVE: prompt input retain composer accessibility and existing fallback when busy', async () => {
  const { getAgentWorkingStatus } = await loadStatusModule();

  // Baseline reducer preserves prompt submission and busy state transitions
  const connected = createConnectedState();
  const submitted = chatReducer(connected, {
    type: 'PROMPT_SUBMIT',
    payload: { id: 'p-preserve', message: 'Check preserve behavior' },
  });

  assert.equal(submitted.agentActivity, 'busy');
  assert.equal(submitted.pendingPromptId, 'p-preserve');
  assert.equal(submitted.messages.length, 1);
  assert.equal(submitted.messages[0].content, 'Check preserve behavior');

  // Working fallback remains non-empty string when busy
  const statusEn = getAgentWorkingStatus(submitted, 'en');
  const statusEs = getAgentWorkingStatus(submitted, 'es');
  assert.equal(statusEn, 'Working');
  assert.equal(statusEs, 'Trabajando');
});
