import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatToolPrimaryArg } from '@features/chat/ActivityBlocks';
import {
  extractDiscoveredSubagents,
  getOddAgentType,
  extractOddAgentsFromMessage,
} from '@features/chat/process-utils';
import { ProcessGroupCard } from '@features/chat/components/ProcessGroupCard';
import { categorizeProcess, createProcessGroup, type ProcessItem } from '@core/process-grouping';
import enJson from '@shared/locales/en.json';

const tEn = (key: any, params?: any) => {
  let str = (enJson as any)[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
};

test('Subagents: formatToolPrimaryArg extracts agent name and label cleanly', () => {
  // Case 1: Agent with label
  const arg1 = { agent: 'gentle-ai-worker', label: 'refactor tokens css' };
  assert.strictEqual(formatToolPrimaryArg('subagent_run', arg1), 'gentle-ai-worker · refactor tokens css');

  // Case 2: Agent with long task fallback
  const arg2 = { agent: 'sdd-verifier', task: 'verify strict architectural boundaries in project' };
  assert.strictEqual(formatToolPrimaryArg('subagent_run', arg2), 'sdd-verifier · verify strict architectural boundaries i');

  // Case 3: Agent without label or task
  const arg3 = { agent: 'gentle-ai-explore' };
  assert.strictEqual(formatToolPrimaryArg('subagent_run', arg3), 'gentle-ai-explore');

  // Case 4: Non-agent tool keeps existing behavior
  assert.strictEqual(formatToolPrimaryArg('read', { path: 'src/app.ts' }), 'src/app.ts');
  assert.strictEqual(formatToolPrimaryArg('bash', { command: 'npm test' }), 'npm test');
});

test('Subagents: categorizeProcess categorizes subagent tools under agents', () => {
  const block1: any = { type: 'tool_call', name: 'subagent_run' };
  const block2: any = { type: 'tool_call', name: 'subagent_status' };
  const block3: any = { type: 'tool_call', name: 'agent' };

  assert.strictEqual(categorizeProcess(block1), 'agents');
  assert.strictEqual(categorizeProcess(block2), 'agents');
  assert.strictEqual(categorizeProcess(block3), 'agents');
});

test('Subagents: ProcessGroup collects subagents into byCategory.agents', () => {
  const items: ProcessItem[] = [
    {
      id: 'p-1',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-1',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-worker', label: 'build UI' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'p-2',
      category: 'bash',
      block: {
        type: 'tool_call',
        id: 'c-2',
        name: 'bash',
        args: { command: 'git status' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const group = createProcessGroup('grp-1', items, '12:00:00');

  assert.strictEqual(group.byCategory.agents.length, 1);
  assert.strictEqual(group.byCategory.bash.length, 1);
  assert.deepStrictEqual(group.categoriesPresent, ['agents', 'bash']);
});

test('Subagents: extractDiscoveredSubagents extracts agents, ignores internal subagent tools, and computes working/idle status', () => {
  const items: ProcessItem[] = [
    {
      id: 'i-1',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-1',
        name: 'subagent_list_agents', // should be ignored
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-2',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-2',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-explore', label: 'explore tokens' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-3',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-3',
        name: 'subagent_status', // should be ignored
        args: { task_id: 'task-123' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-4',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-4',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-verify', label: 'run checks' },
        status: 'running', // active!
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const discovered = extractDiscoveredSubagents(items);

  // Exactly two subagents discovered, ignoring subagent_list_agents and subagent_status
  assert.strictEqual(discovered.length, 2);

  const explore = discovered.find((a) => a.name === 'gentle-ai-explore');
  assert.ok(explore);
  assert.strictEqual(explore.status, 'completed'); // not running -> idle/completed (gray)

  const verify = discovered.find((a) => a.name === 'gentle-ai-verify');
  assert.ok(verify);
  assert.strictEqual(verify.status, 'running'); // running -> working (green)
});

test('Subagents: extractDiscoveredSubagents updates status on error and does not mask with previous completion', () => {
  // Case 1: First item completed, second item has error -> status must be error (not masked)
  const itemsMasking: ProcessItem[] = [
    {
      id: 'i-1',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-1',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-worker' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-2',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-2',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-worker' },
        status: 'error',
        isError: true,
      },
      messageId: 'm-1',
    },
  ];

  const discovered1 = extractDiscoveredSubagents(itemsMasking);
  assert.strictEqual(discovered1.length, 1);
  assert.strictEqual(discovered1[0].name, 'gentle-ai-worker');
  assert.strictEqual(discovered1[0].status, 'error');

  // Case 2: First item error, second item completed -> status must remain error
  const itemsPreserveError: ProcessItem[] = [
    {
      id: 'i-3',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-3',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-researcher' },
        status: 'error',
        isError: true,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-4',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-4',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-researcher' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const discovered2 = extractDiscoveredSubagents(itemsPreserveError);
  assert.strictEqual(discovered2.length, 1);
  assert.strictEqual(discovered2[0].name, 'gentle-ai-researcher');
  assert.strictEqual(discovered2[0].status, 'error');

  // Case 3: Error present but another instance is actively running -> running takes precedence
  const itemsActiveRunning: ProcessItem[] = [
    {
      id: 'i-5',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-5',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-builder' },
        status: 'error',
        isError: true,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-6',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-6',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-builder' },
        status: 'running',
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const discovered3 = extractDiscoveredSubagents(itemsActiveRunning);
  assert.strictEqual(discovered3.length, 1);
  assert.strictEqual(discovered3[0].name, 'gentle-ai-builder');
  assert.strictEqual(discovered3[0].status, 'running');
});

test('Subagents: extractDiscoveredSubagents extracts agent name from string block.args with regex even if invalid JSON', () => {
  const items: ProcessItem[] = [
    {
      id: 'i-1',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-1',
        name: 'subagent_run',
        // Malformed / incomplete JSON
        args: '{"agent": "gentle-ai-planner", "task": "plan out features unclosed...',
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-2',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-2',
        name: 'subagent_run',
        // Raw substring with spaces
        args: 'prefix "agent" : "custom-analyst" suffix',
        status: 'running',
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const discovered = extractDiscoveredSubagents(items);
  assert.strictEqual(discovered.length, 2);

  const planner = discovered.find((a) => a.name === 'gentle-ai-planner');
  assert.ok(planner);
  assert.strictEqual(planner.status, 'completed');

  const analyst = discovered.find((a) => a.name === 'custom-analyst');
  assert.ok(analyst);
  assert.strictEqual(analyst.status, 'running');
});

test('Subagents: ProcessGroupCard renders subagent pills with status-error, status-working, and status-idle', () => {
  const items: ProcessItem[] = [
    {
      id: 'i-1',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-1',
        name: 'subagent_run',
        args: { agent: 'agent-working' },
        status: 'running',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-2',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-2',
        name: 'subagent_run',
        args: { agent: 'agent-failed' },
        status: 'error',
        isError: true,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-3',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-3',
        name: 'subagent_run',
        args: { agent: 'agent-done' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const group = createProcessGroup('g-1', items, '12:00:00');
  const html = renderToStaticMarkup(
    React.createElement(ProcessGroupCard, {
      group,
      t: tEn,
    })
  );

  // Active / running pill: status-working (green)
  assert.ok(html.includes('subagent-pill status-working'));
  assert.ok(html.includes('dot-working'));
  assert.ok(html.includes('agent-working (Running)'));

  // Error pill: status-error (red indicator) with failed tooltip Notice
  assert.ok(html.includes('subagent-pill status-error'));
  assert.ok(html.includes('dot-error'));
  assert.ok(html.includes('agent-failed (Notice)'));

  // Completed pill: status-idle (gray)
  assert.ok(html.includes('subagent-pill status-idle'));
  assert.ok(html.includes('dot-idle'));
  assert.ok(html.includes('agent-done (Completed)'));
});

test('Subagents: getOddAgentType correctly maps agent names to incandescent ODD categories', () => {
  assert.strictEqual(getOddAgentType('gentle-ai-explore'), 'explore');
  assert.strictEqual(getOddAgentType('explore'), 'explore');
  assert.strictEqual(getOddAgentType('gentle-ai-verify'), 'verify');
  assert.strictEqual(getOddAgentType('sdd-verifier'), 'verify');
  assert.strictEqual(getOddAgentType('gentle-ai-worker'), 'worker');
  assert.strictEqual(getOddAgentType('worker'), 'worker');
  assert.strictEqual(getOddAgentType('task-runner'), 'worker');
  assert.strictEqual(getOddAgentType('jd-judge-a'), 'judge');
  assert.strictEqual(getOddAgentType('jd-fix-agent'), 'fix');
  assert.strictEqual(getOddAgentType('review-readability'), 'review');
  assert.strictEqual(getOddAgentType('arbitrary-agent'), 'other');
});

test('Subagents: extractOddAgentsFromMessage discovers ODD subagents directly from message blocks', () => {
  const msg: any = {
    role: 'assistant',
    blocks: [
      {
        type: 'tool_call',
        id: 'tc-1',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-explore', task: 'map tokens' },
        status: 'completed',
      },
      {
        type: 'tool_call',
        id: 'tc-2',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-verify' },
        status: 'running',
      },
      {
        type: 'tool_call',
        id: 'tc-3',
        name: 'bash',
        args: { command: 'npm test' },
      },
    ],
  };

  const discovered = extractOddAgentsFromMessage(msg);
  assert.strictEqual(discovered.length, 2);
  assert.strictEqual(discovered[0].name, 'gentle-ai-explore');
  assert.strictEqual(discovered[0].status, 'completed');
  assert.strictEqual(discovered[1].name, 'gentle-ai-verify');
  assert.strictEqual(discovered[1].status, 'running');
});

test('Subagents: ProcessGroupCard renders glowing incandescent ovals in header for discovered ODD agents', () => {
  const items: ProcessItem[] = [
    {
      id: 'i-1',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-1',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-explore' },
        status: 'completed',
        isError: false,
      },
      messageId: 'm-1',
    },
    {
      id: 'i-2',
      category: 'agents',
      block: {
        type: 'tool_call',
        id: 'c-2',
        name: 'subagent_run',
        args: { agent: 'gentle-ai-verify' },
        status: 'running',
        isError: false,
      },
      messageId: 'm-1',
    },
  ];

  const group = createProcessGroup('g-odd-1', items, '12:00:00');
  const html = renderToStaticMarkup(
    React.createElement(ProcessGroupCard, {
      group,
      t: tEn,
    })
  );

  // Header should contain the glowing incandescent ovals
  assert.ok(html.includes('process-group-header-odd-agents'));
  assert.ok(html.includes('odd-agent-oval agent-explore'));
  assert.ok(html.includes('odd-agent-oval agent-verify is-running'));
  assert.ok(html.includes('gentle-ai-explore'));
  assert.ok(html.includes('gentle-ai-verify'));
});
