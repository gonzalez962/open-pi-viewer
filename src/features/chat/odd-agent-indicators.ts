/**
 * ODD Agent Indicators (Issue #22): Pure helper for extracting explicit subagent
 * delegation evidence and conservative role mapping.
 *
 * Grounded constraints:
 * - Orchestrator badge is shown ONLY when explicit delegation exists.
 * - Exact allowlist of dispatch tool names; no wildcard prefixes or loose substrings.
 * - Roles (explore, verify, worker, judge, review, fix, unknown) use exact bounded tokens.
 * - Unknown agents preserve full identifier without stripping prefixes.
 * - Lifecycle: in-flight dispatch tool maps to 'dispatching', success to neutral 'dispatched',
 *   and error to 'error' (error takes precedence). Orchestrator derives from delegation calls only.
 */

import type { ToolCallBlock, ToolExecutionStatus } from '@core/types/messages';
import type { ProcessGroup } from '@core/process-grouping';

export type OddRole =
  | 'explore'
  | 'verify'
  | 'worker'
  | 'judge'
  | 'review'
  | 'fix'
  | 'unknown';

export type AgentIndicatorStatus = 'dispatching' | 'dispatched' | 'error';

export interface DelegatedAgentIndicator {
  id: string;
  role: OddRole;
  rawName: string;
  customName?: string;
  status: AgentIndicatorStatus;
  count: number;
}

export interface OddDelegationSummary {
  hasDelegation: boolean;
  orchestrator?: {
    role: 'orchestrator';
    status: AgentIndicatorStatus;
  };
  indicators: DelegatedAgentIndicator[];
}

/**
 * Small documented exact allowlist of dispatch tool names grounded in supported contracts.
 * Runner controls, queries, status checks, and messaging tools are excluded.
 */
export const EXACT_DISPATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'subagent_run',
  'subagent_spawn',
  'subagent_dispatch',
  'subagent_start',
  'subagent_exec',
  'agent_run',
  'agent_spawn',
  'agent_dispatch',
  'subagent',
]);

/**
 * Safely extracts the target agent identifier from tool arguments.
 * Supports structured objects and valid JSON strings.
 * Rejects invalid/truncated JSON safely without guessing or regex recovery.
 * Rejects bare opaque strings safely.
 */
export function extractAgentTargetFromArgs(args: unknown): string | null {
  if (args === null || args === undefined) return null;

  let parsed: unknown = args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Reject malformed or truncated JSON safely without regex guessing
        return null;
      }
    } else {
      // Reject bare opaque strings
      return null;
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const candidateKeys = [
      'agent',
      'subagent',
      'agent_name',
      'subagent_name',
      'target',
      'role',
    ];
    for (const key of candidateKeys) {
      const val = record[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    }
  }

  return null;
}

/**
 * Checks whether a tool call represents an explicit subagent dispatch.
 * Requires exact allowlist match, or 'task' with an explicit valid agent target string.
 */
export function isExplicitSubagentDispatch(toolName: unknown, args: unknown): boolean {
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    return false;
  }
  const name = toolName.trim().toLowerCase();

  if (EXACT_DISPATCH_TOOL_NAMES.has(name)) {
    return true;
  }

  // Tool named 'task' requires an explicit valid agent target string
  if (name === 'task') {
    const target = extractAgentTargetFromArgs(args);
    return target !== null && target.length > 0;
  }

  return false;
}

/**
 * Conservative mapping from agent identifier to semantic ODD role.
 * Uses exact bounded tokens; eliminates loose substring stems (fix, revis, audit, writer, etc.).
 * Non-matching tokens map to 'unknown' without speculative guessing.
 */
export function mapOddRole(rawIdentifier: string): OddRole {
  if (!rawIdentifier || typeof rawIdentifier !== 'string') {
    return 'unknown';
  }
  const id = rawIdentifier.trim().toLowerCase();
  if (!id) return 'unknown';

  // 1. Explore
  if (
    id === 'explore' ||
    id === 'explorer' ||
    id === 'gentle-ai-explore' ||
    id === 'gentle-ai-explorer' ||
    id === 'sdd-explore' ||
    id === 'sdd-explorer' ||
    id === 'explorador' ||
    id === 'exploracion'
  ) {
    return 'explore';
  }

  // 2. Verify
  if (
    id === 'verify' ||
    id === 'verifier' ||
    id === 'gentle-ai-verify' ||
    id === 'gentle-ai-verifier' ||
    id === 'sdd-verify' ||
    id === 'sdd-verifier' ||
    id === 'verificador' ||
    id === 'verificacion'
  ) {
    return 'verify';
  }

  // 3. Worker
  if (
    id === 'worker' ||
    id === 'task' ||
    id === 'gentle-ai-worker' ||
    id === 'sdd-worker' ||
    id === 'trabajador' ||
    id === 'tarea'
  ) {
    return 'worker';
  }

  // 4. Judge
  if (
    id === 'judge' ||
    id === 'jd-judge' ||
    id === 'jd-judge-a' ||
    id === 'jd-judge-b' ||
    id === 'juez'
  ) {
    return 'judge';
  }

  // 5. Review
  if (
    id === 'review' ||
    id === 'reviewer' ||
    id === 'gentle-ai-review' ||
    id === 'gentle-ai-reviewer' ||
    id === 'review-risk' ||
    id === 'review-readability' ||
    id === 'review-reliability' ||
    id === 'review-resilience' ||
    id === 'review-quality' ||
    id === 'security-auditor' ||
    id === 'revisor' ||
    id === 'revision'
  ) {
    return 'review';
  }

  // 6. Fix
  if (
    id === 'fix' ||
    id === 'fixer' ||
    id === 'jd-fix' ||
    id === 'jd-fix-agent' ||
    id === 'corrector' ||
    id === 'correccion'
  ) {
    return 'fix';
  }

  return 'unknown';
}

/**
 * Resolves indicator status from tool call status.
 * Error precedence is preserved: isError true resolves to 'error'.
 * Ongoing execution resolves to 'dispatching', completed success to neutral 'dispatched'.
 */
export function resolveAgentStatus(
  status: ToolExecutionStatus,
  isError?: boolean
): AgentIndicatorStatus {
  if (isError || status === 'error') {
    return 'error';
  }
  if (status === 'running') {
    return 'dispatching';
  }
  return 'dispatched';
}

/**
 * Extracts explicit subagent delegation summary from a ProcessGroup.
 * Returns hasDelegation: false if no explicit delegation occurred.
 * Orchestrator status is derived from delegation tool calls ONLY.
 */
export function extractOddDelegationSummary(group: ProcessGroup): OddDelegationSummary {
  const blocks = group.blocks;
  const dispatchToolBlocks: ToolCallBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'tool_call' && isExplicitSubagentDispatch(block.name, block.args)) {
      dispatchToolBlocks.push(block);
    }
  }

  if (dispatchToolBlocks.length === 0) {
    return {
      hasDelegation: false,
      indicators: [],
    };
  }

  // Orchestrator status derives from delegation tool calls ONLY (error precedence over running)
  const anyDelegationError = dispatchToolBlocks.some(
    (b) => b.isError || b.status === 'error'
  );
  const anyDelegationRunning = dispatchToolBlocks.some(
    (b) => b.status === 'running' && !b.isError
  );

  const orchStatus: AgentIndicatorStatus = anyDelegationError
    ? 'error'
    : anyDelegationRunning
      ? 'dispatching'
      : 'dispatched';

  const order: string[] = [];
  const indicatorMap = new Map<
    string,
    {
      role: OddRole;
      rawName: string;
      customName?: string;
      statuses: AgentIndicatorStatus[];
      count: number;
    }
  >();

  for (const tool of dispatchToolBlocks) {
    const rawName = extractAgentTargetFromArgs(tool.args) ?? '';
    const role = mapOddRole(rawName);
    const status = resolveAgentStatus(tool.status, tool.isError);

    // Deduping key: for known roles, dedupe by role.
    // For unknown roles, dedupe by normalized exact rawName to avoid conflating distinct identities.
    const dedupeKey =
      role === 'unknown'
        ? rawName
          ? `unknown:${rawName.toLowerCase()}`
          : 'unknown'
        : role;

    let existing = indicatorMap.get(dedupeKey);
    if (!existing) {
      let customName: string | undefined = undefined;
      if (role === 'unknown' && rawName) {
        // Preserve full identifier without stripping prefixes
        customName = rawName;
      }
      existing = {
        role,
        rawName,
        customName,
        statuses: [],
        count: 0,
      };
      indicatorMap.set(dedupeKey, existing);
      order.push(dedupeKey);
    }

    existing.statuses.push(status);
    existing.count += 1;
  }

  const indicators: DelegatedAgentIndicator[] = order.map((key) => {
    const item = indicatorMap.get(key)!;
    // Status precedence: error > dispatching > dispatched
    let finalStatus: AgentIndicatorStatus = 'dispatched';
    if (item.statuses.includes('error')) {
      finalStatus = 'error';
    } else if (item.statuses.includes('dispatching')) {
      finalStatus = 'dispatching';
    }

    return {
      id: `odd-agent-${key}`,
      role: item.role,
      rawName: item.rawName,
      customName: item.customName,
      status: finalStatus,
      count: item.count,
    };
  });

  return {
    hasDelegation: true,
    orchestrator: {
      role: 'orchestrator',
      status: orchStatus,
    },
    indicators,
  };
}
