import assert from 'node:assert/strict';
import test from 'node:test';

import type { MessageBlock, ThinkingBlock, ToolCallBlock } from '@core/types/messages';
import { groupMessageBlocks, type ProcessGroup } from '@core/process-grouping';
import {
  extractAgentTargetFromArgs,
  extractOddDelegationSummary,
  isExplicitSubagentDispatch,
  mapOddRole,
} from '@features/chat/odd-agent-indicators';

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
  return { type: 'thinking', thinking: 'planning...', ...overrides };
}

function buildGroup(blocks: MessageBlock[]): ProcessGroup {
  const items = groupMessageBlocks(blocks);
  const group = items.find((i) => i.type === 'process_group');
  assert.ok(group, 'expected at least one process_group in fixture');
  return group as ProcessGroup;
}

test('odd-agent-indicators: returns hasDelegation=false and no indicators for ordinary tools', () => {
  const group = buildGroup([
    thinking(),
    tool('bash', { args: { command: 'git status' } }),
    tool('read', { args: { path: 'src/main.ts' } }),
    tool('write', { args: { path: 'src/main.ts', content: 'hello' } }),
    tool('edit', { args: { path: 'src/main.ts', oldText: 'a', newText: 'b' } }),
    tool('grep', { args: { pattern: 'TODO' } }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, false);
  assert.equal(summary.orchestrator, undefined);
  assert.deepEqual(summary.indicators, []);
});

test('odd-agent-indicators: returns hasDelegation=false for runner control, status, and messaging commands', () => {
  const nonDispatchTools = [
    'subagent_list_agents',
    'subagent_status',
    'subagent_result',
    'subagent_poll',
    'subagent_reply',
    'subagent_send_message',
    'subagent_continue',
    'agent_list',
    'agent_status',
    'agent_settings',
    'agent_config',
  ];

  for (const name of nonDispatchTools) {
    assert.equal(
      isExplicitSubagentDispatch(name, { id: 'task-1' }),
      false,
      `expected ${name} to NOT be an explicit subagent dispatch`
    );
  }

  const group = buildGroup(nonDispatchTools.map((name) => tool(name)));
  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, false);
  assert.equal(summary.orchestrator, undefined);
  assert.deepEqual(summary.indicators, []);
});

test('odd-agent-indicators: maps known roles accurately and conservatively with exact bounded tokens', () => {
  assert.equal(mapOddRole('gentle-ai-explore'), 'explore');
  assert.equal(mapOddRole('sdd-explorer'), 'explore');
  assert.equal(mapOddRole('explorador'), 'explore');

  assert.equal(mapOddRole('gentle-ai-verify'), 'verify');
  assert.equal(mapOddRole('sdd-verifier'), 'verify');
  assert.equal(mapOddRole('verificador'), 'verify');

  assert.equal(mapOddRole('gentle-ai-worker'), 'worker');
  assert.equal(mapOddRole('task'), 'worker');
  assert.equal(mapOddRole('sdd-worker'), 'worker');
  assert.equal(mapOddRole('trabajador'), 'worker');

  assert.equal(mapOddRole('jd-judge-a'), 'judge');
  assert.equal(mapOddRole('jd-judge-b'), 'judge');
  assert.equal(mapOddRole('juez'), 'judge');

  assert.equal(mapOddRole('review-risk'), 'review');
  assert.equal(mapOddRole('review-readability'), 'review');
  assert.equal(mapOddRole('review-reliability'), 'review');
  assert.equal(mapOddRole('review-resilience'), 'review');
  assert.equal(mapOddRole('security-auditor'), 'review');
  assert.equal(mapOddRole('revisor'), 'review');

  assert.equal(mapOddRole('jd-fix'), 'fix');
  assert.equal(mapOddRole('jd-fix-agent'), 'fix');
  assert.equal(mapOddRole('corrector'), 'fix');
});

test('odd-agent-indicators: eliminates substring stems - false-positive candidates must map to unknown', () => {
  const falsePositives = [
    'prefix-builder',
    'suffix-tool',
    'fixture-generator',
    'revision-tool',
    'git-revision',
    'revisit',
    'auditorium',
    'typewriter',
    'audit_log',
    'custom-synthesizer',
  ];

  for (const name of falsePositives) {
    assert.equal(mapOddRole(name), 'unknown', `expected ${name} to map to unknown`);
  }
});

test('odd-agent-indicators: rejects malformed JSON and bare opaque strings safely without throwing or regex recovery', () => {
  assert.equal(extractAgentTargetFromArgs('{ malformed json: agent: "test"'), null);
  assert.equal(extractAgentTargetFromArgs('{"agent": "incomplete'), null);
  assert.equal(extractAgentTargetFromArgs('git status'), null);
  assert.equal(extractAgentTargetFromArgs('opaque string'), null);
  assert.equal(extractAgentTargetFromArgs(42), null);
  assert.equal(extractAgentTargetFromArgs(undefined), null);

  // Structured objects and valid JSON string succeed
  assert.equal(extractAgentTargetFromArgs({ agent: 'gentle-ai-explore' }), 'gentle-ai-explore');
  assert.equal(extractAgentTargetFromArgs('{"agent": "gentle-ai-verify"}'), 'gentle-ai-verify');
});

test('odd-agent-indicators: detects explicit subagent dispatch and includes Orchestrator badge', () => {
  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'gentle-ai-explore', prompt: 'inspect files' },
      status: 'completed',
    }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  assert.ok(summary.orchestrator);
  assert.equal(summary.orchestrator?.role, 'orchestrator');
  assert.equal(summary.indicators.length, 1);
  assert.equal(summary.indicators[0].role, 'explore');
  assert.equal(summary.indicators[0].status, 'dispatched');
});

test('odd-agent-indicators: background dispatch success maps to neutral dispatched status, NOT running or completed', () => {
  const group = buildGroup([
    tool('subagent_spawn', {
      args: JSON.stringify({ agent: 'gentle-ai-verify' }),
      status: 'completed',
    }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  assert.equal(summary.indicators[0].status, 'dispatched');
});

test('odd-agent-indicators: running dispatch tool maps to dispatching status', () => {
  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'gentle-ai-worker' },
      status: 'running',
    }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  assert.equal(summary.indicators[0].status, 'dispatching');
  assert.equal(summary.orchestrator?.status, 'dispatching');
});

test('odd-agent-indicators: errored dispatch tool maps to error status', () => {
  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'jd-fix-agent' },
      status: 'error',
      isError: true,
    }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  assert.equal(summary.indicators[0].status, 'error');
  assert.equal(summary.orchestrator?.status, 'error');
});

test('odd-agent-indicators: error precedence with isError true must NOT become dispatching or running', () => {
  const group = buildGroup([
    tool('subagent_run', {
      args: { agent: 'gentle-ai-explore' },
      status: 'running',
      isError: true,
    }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  assert.equal(summary.indicators[0].status, 'error');
  assert.equal(summary.orchestrator?.status, 'error');
});

test('odd-agent-indicators: Orchestrator status derives from delegation calls ONLY, not unrelated group tool/thinking', () => {
  // Group has unrelated running bash and streaming thinking, but completed delegation
  const group = buildGroup([
    thinking({ isStreaming: true }),
    tool('bash', { args: { command: 'npm test' }, status: 'running' }),
    tool('read', { args: { path: 'a.ts' }, status: 'error', isError: true }),
    tool('subagent_run', { args: { agent: 'gentle-ai-verify' }, status: 'completed' }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  // Orchestrator status must be dispatched, ignoring unrelated running/error blocks
  assert.equal(summary.orchestrator?.status, 'dispatched');
  assert.equal(summary.indicators[0].status, 'dispatched');
});

test('odd-agent-indicators: unknown identity preserves full identifier without stripping prefixes and avoids conflation', () => {
  const group = buildGroup([
    tool('subagent_run', { args: { agent: 'gentle-ai-special' } }),
    tool('subagent_run', { args: { agent: 'special' } }),
    tool('subagent_run', { args: { agent: 'gentle-ai-special' } }),
  ]);

  const summary = extractOddDelegationSummary(group);
  assert.equal(summary.hasDelegation, true);
  assert.equal(summary.indicators.length, 2);

  assert.equal(summary.indicators[0].role, 'unknown');
  assert.equal(summary.indicators[0].rawName, 'gentle-ai-special');
  assert.equal(summary.indicators[0].customName, 'gentle-ai-special');
  assert.equal(summary.indicators[0].count, 2);

  assert.equal(summary.indicators[1].role, 'unknown');
  assert.equal(summary.indicators[1].rawName, 'special');
  assert.equal(summary.indicators[1].customName, 'special');
  assert.equal(summary.indicators[1].count, 1);
});

test('odd-agent-indicators: task tool requires explicit valid agent target string', () => {
  const noTargetTask = buildGroup([
    tool('task', { args: { id: 101, title: 'Clean room' } }),
  ]);
  assert.equal(extractOddDelegationSummary(noTargetTask).hasDelegation, false);

  const malformedTask = buildGroup([
    tool('task', { args: '{ malformed' }),
  ]);
  assert.equal(extractOddDelegationSummary(malformedTask).hasDelegation, false);

  const validTask = buildGroup([
    tool('task', { args: { agent: 'gentle-ai-worker' } }),
  ]);
  const summary = extractOddDelegationSummary(validTask);
  assert.equal(summary.hasDelegation, true);
  assert.equal(summary.indicators[0].role, 'worker');
});
