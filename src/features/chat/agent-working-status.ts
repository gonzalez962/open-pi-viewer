/**
 * Agent Working Status (T1 / S2, T2 / S3): Pure derivation of current agent activity
 * and ODD phase presentation from session messages, tool events, and subagent telemetry.
 *
 * Grounded in pi-notify reference pattern (lib/herdr.ts):
 * - Derives working text dynamically instead of a fixed "Working" string.
 * - Current gentle_odd_phase tool calls provide explicit phase evidence.
 * - Infers exploration, implementation, or checking phases from common tools and explicit validation commands.
 * - Formatted running tool names are deduplicated, stripped of MCP prefixes,
 *   free of excluded control tools, and limited to 3 items plus overflow (+N).
 * - Distinguishes streaming thinking ("Thinking") from response generation ("Generating").
 * - Reflects live subagent state (queued, running, waiting) across main agent lifecycle boundaries.
 * - Prioritizes waiting subagents.
 * - Falls back to localized "Working" when evidence is absent, without reusing
 *   historical run state or queued prompts.
 * - Reports no working activity (null) when idle or disconnected.
 */

import type { SubagentTask } from '@core/types/agent-activity';
import type { ChatSessionState } from '@core/types/chat-state';
import type { ChatMessage } from '@core/types/messages';
import type { SupportedLocale, TranslationKey } from '@shared/i18n';
import { translate } from '@shared/i18n';

export type ActivityKind = 'phase' | 'tool' | 'thinking' | 'generating' | 'fallback' | 'waiting';

export interface AgentWorkingStatus {
  isWorking: boolean;
  text?: string;
  phase?: string;
  runningTools: string[];
  activityKind?: ActivityKind;
}

/**
 * Pi-notify control and phase reporting tools that are excluded from
 * the execution work suffix.
 */
export const EXCLUDED_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'subagent_run',
  'subagent',
  'gentle_odd_phase',
  'ask_user_choice',
  'ask_user_question',
]);

/**
 * Standard ODD phases recognized by the system.
 */
export const KNOWN_ODD_PHASES: ReadonlySet<string> = new Set([
  'authorizing',
  'exploring',
  'researching',
  'deciding',
  'planning',
  'implementing',
  'checking',
  'closing',
]);

/**
 * Common read and search tools that convey the exploration phase.
 */
export const EXPLORATION_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'find',
  'search',
  'code_search',
  'file_search',
  'view',
  'read_file',
]);

/**
 * Common write and edit tools that convey the implementation phase.
 */
export const IMPLEMENTATION_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'patch',
  'apply_patch',
  'replace',
  'write_file',
]);

/**
 * Shell execution tools that may convey checking when executing explicit validation commands.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'exec',
  'terminal',
  'command',
]);

/**
 * Strips MCP runtime namespace prefix (mcp__<server>__).
 */
export function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/u, '');
}

/**
 * Capitalizes the first character of a string.
 */
export function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/**
 * Formats a tool name for display: strips MCP prefix, replaces underscores
 * with hyphens, and capitalizes the leading letter.
 */
export function formatToolName(name: string): string {
  const stripped = stripMcpPrefix(name);
  return capitalize(stripped.replace(/_/gu, '-'));
}

/**
 * Safely extracts the phase token from gentle_odd_phase tool arguments.
 * Handles structured objects and JSON strings.
 */
export function extractPhaseFromArgs(args: unknown): string | null {
  if (args === null || args === undefined) return null;

  let parsed: unknown = args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
    } else {
      parsed = { phase: trimmed };
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const rawPhase = record.phase;
    if (typeof rawPhase === 'string' && rawPhase.trim().length > 0) {
      return rawPhase.replace(/(?:…|\.\.\.)+$/u, '').trim().toLowerCase();
    }
  }

  return null;
}

/**
 * Safely extracts a bash command string from tool execution arguments.
 */
export function extractBashCommand(args: unknown): string | null {
  if (args === null || args === undefined) return null;

  let parsed: unknown = args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    } else {
      return trimmed;
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const cmd = record.command ?? record.cmd ?? record.script;
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
      return cmd.trim();
    }
  }

  return null;
}

/**
 * Checks if a shell command explicitly represents a test, build, or verification check.
 * Conservative: never matches arbitrary shell text like `ls`, `git status`, or generic utilities.
 */
export function isValidationCommand(cmd: string): boolean {
  const normalized = cmd.trim();
  if (!normalized) return false;

  // Explicit test runners: vitest, jest, pytest, ctest, cargo test, go test, npm test, tsx --test
  if (
    /^(?:(?:npx|pnpm|yarn|npm|bun)\s+)?(?:vitest|jest|pytest|ctest)\b/i.test(normalized) ||
    /^(?:cargo|go)\s+test\b/i.test(normalized) ||
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|t)\b/i.test(normalized) ||
    /^(?:npx\s+)?tsx\s+(?:.*--test\b)/i.test(normalized) ||
    /^(?:python(?:3)?\s+-m\s+)?pytest\b/i.test(normalized)
  ) {
    return true;
  }

  // Explicit build commands: npm run build, cargo build, go build, vite build
  if (
    /^(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i.test(normalized) ||
    /^(?:cargo|go)\s+build\b/i.test(normalized) ||
    /^vite\s+build\b/i.test(normalized)
  ) {
    return true;
  }

  // Explicit check / lint commands: npm run check, npm run lint, npm run typecheck, npx tsc, eslint, check:arch
  if (
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|check|lint|typecheck)(?::\S+)?\b/i.test(normalized) ||
    /^(?:npx\s+)?(?:eslint|tsc)\b/i.test(normalized) ||
    /^check:arch\b/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

/**
 * Infers an ODD phase from common tool names and validation commands (S3.4).
 * Common read/search tools convey exploration, write/edit convey implementation,
 * and bash validation commands convey checking. Unknown commands remain conservative (null).
 */
export function inferPhaseFromTool(toolName: string, args?: unknown): string | null {
  const stripped = stripMcpPrefix(toolName).toLowerCase();

  if (EXPLORATION_TOOLS.has(stripped)) {
    return 'exploring';
  }

  if (IMPLEMENTATION_TOOLS.has(stripped)) {
    return 'implementing';
  }

  if (SHELL_TOOLS.has(stripped)) {
    const cmd = extractBashCommand(args);
    if (cmd && isValidationCommand(cmd)) {
      return 'checking';
    }
  }

  return null;
}

/**
 * Extracts messages belonging strictly to the current active run.
 * Historical settled turns and queued follow-up prompts are excluded.
 */
export function getCurrentRunMessages(messages: ChatMessage[]): ChatMessage[] {
  let lastNonQueuedUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.isQueued) {
      lastNonQueuedUserIndex = i;
      break;
    }
  }

  const startIdx = lastNonQueuedUserIndex >= 0 ? lastNonQueuedUserIndex : 0;
  const currentRun: ChatMessage[] = [];
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && m.isQueued) {
      continue;
    }
    currentRun.push(m);
  }
  return currentRun;
}

/**
 * Localizes an ODD phase token according to UI preferences.
 * Unknown or custom phase tokens fall back to capitalized display.
 */
function localizePhase(phase: string, locale: SupportedLocale): string {
  if (KNOWN_ODD_PHASES.has(phase)) {
    const key = `agent_working_status.phase_${phase}` as TranslationKey;
    const translated = translate(locale, key);
    if (translated && translated !== (key as string)) {
      return translated;
    }
  }
  return capitalize(phase);
}

/**
 * Pure derivation of structured agent working status from chat state.
 */
export function deriveAgentWorkingStatus(
  state: Pick<
    ChatSessionState,
    'connectionStatus' | 'agentActivity' | 'messages' | 'activeAssistantMessageId'
  > & {
    subagents?: SubagentTask[];
  },
  locale: SupportedLocale = 'en'
): AgentWorkingStatus {
  // S2.5: Idle agent or disconnected/error session reports no current working activity
  if (state.connectionStatus !== 'connected') {
    return {
      isWorking: false,
      runningTools: [],
    };
  }

  const subagents = (state.subagents || []).filter(
    (s) => s.status === 'running' || s.status === 'queued' || s.status === 'waiting'
  );

  // S3.2: Prioritize waiting subagents
  const waitingSub = subagents.find(
    (s) => s.status === 'waiting' || (s.lastStep && s.lastStep.toLowerCase().startsWith('asked'))
  );

  if (waitingSub) {
    const waitingLabel = translate(locale, 'agent_working_status.waiting_response');
    const text = `${capitalize(waitingSub.agent)}: ${waitingLabel}`;
    return {
      isWorking: true,
      text,
      runningTools: [],
      activityKind: 'waiting',
    };
  }

  const isMainBusy = state.agentActivity === 'busy';
  const hasLiveSubagents = subagents.length > 0;

  if (!isMainBusy && !hasLiveSubagents) {
    return {
      isWorking: false,
      runningTools: [],
    };
  }

  const runMessages = isMainBusy ? getCurrentRunMessages(state.messages || []) : [];

  let explicitPhase: string | undefined;
  const runningTools: string[] = [];
  const runningToolEntries: Array<{ toolName: string; args?: unknown }> = [];
  let hasStreamingThinking = false;
  let hasStreamingText = false;

  for (const msg of runMessages) {
    if (msg.role !== 'assistant') continue;

    if (msg.blocks && msg.blocks.length > 0) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_call') {
          const stripped = stripMcpPrefix(block.name).toLowerCase();
          if (stripped === 'gentle_odd_phase') {
            if (!block.isError && block.status !== 'error') {
              const phase = extractPhaseFromArgs(block.args);
              if (phase === 'clear') {
                explicitPhase = undefined;
              } else if (phase) {
                explicitPhase = phase;
              }
            }
          } else if (block.status === 'running') {
            if (!EXCLUDED_CONTROL_TOOLS.has(stripped)) {
              const formatted = formatToolName(block.name);
              if (!runningTools.includes(formatted)) {
                runningTools.push(formatted);
                runningToolEntries.push({
                  toolName: block.name,
                  args: block.args,
                });
              }
            }
          }
        } else if (block.type === 'thinking') {
          if (block.isStreaming) {
            hasStreamingThinking = true;
          }
        }
      }
    }

    // Inspect active assistant message for streaming thinking or text
    const activeAssistant = state.activeAssistantMessageId
      ? runMessages.find((m) => m.id === state.activeAssistantMessageId)
      : [...runMessages].reverse().find((m) => m.role === 'assistant');

    if (activeAssistant && activeAssistant.isStreaming) {
      const lastBlock = activeAssistant.blocks && activeAssistant.blocks.length > 0
        ? activeAssistant.blocks[activeAssistant.blocks.length - 1]
        : undefined;

      if (lastBlock?.type === 'thinking' && lastBlock.isStreaming) {
        hasStreamingThinking = true;
      } else if (lastBlock?.type === 'text') {
        hasStreamingText = true;
      } else if (!lastBlock && activeAssistant.content && activeAssistant.content.trim().length > 0) {
        hasStreamingText = true;
      }
    }
  }

  // S3.4: Explicit phase retains precedence over inferred tool phases
  let activePhase = explicitPhase;
  if (!activePhase && runningToolEntries.length > 0) {
    for (const entry of runningToolEntries) {
      const inferred = inferPhaseFromTool(entry.toolName, entry.args);
      if (inferred) {
        activePhase = inferred;
        break;
      }
    }
  }

  const fallbackLabel = translate(locale, 'agent_working_status.fallback');
  let baseLabel: string;
  let activityKind: ActivityKind;

  if (activePhase) {
    baseLabel = localizePhase(activePhase, locale);
    activityKind = 'phase';
  } else if (runningTools.length > 0) {
    baseLabel = fallbackLabel;
    activityKind = 'tool';
  } else if (hasStreamingThinking) {
    baseLabel = translate(locale, 'agent_working_status.thinking');
    activityKind = 'thinking';
  } else if (hasStreamingText) {
    baseLabel = translate(locale, 'agent_working_status.generating');
    activityKind = 'generating';
  } else {
    baseLabel = fallbackLabel;
    activityKind = 'fallback';
  }

  // Combine running tools and active subagents (pi-notify herdr.ts convention)
  const items: string[] = [];
  for (const tool of runningTools) {
    items.push(tool);
  }
  for (const sub of subagents) {
    items.push(capitalize(sub.agent));
  }

  let suffixItems = items;
  if (items.length === 1 && subagents.length === 1 && items[0] === capitalize(subagents[0]!.agent)) {
    const step = subagents[0]!.lastStep;
    if (step && !['queued', 'starting', 'done'].includes(step.toLowerCase())) {
      suffixItems = [`${capitalize(subagents[0]!.agent)}: ${step}`];
    }
  }

  if (suffixItems.length > 3) {
    suffixItems = [...suffixItems.slice(0, 3), `+${suffixItems.length - 3}`];
  }

  let text = baseLabel;
  if (suffixItems.length > 0) {
    text = `${baseLabel} - ${suffixItems.join('/')}`;
  }

  return {
    isWorking: true,
    text,
    phase: activePhase,
    runningTools,
    activityKind,
  };
}

/**
 * Returns formatted working status display string, or null if the agent
 * is idle or disconnected.
 */
export function getAgentWorkingStatus(
  state: Pick<
    ChatSessionState,
    'connectionStatus' | 'agentActivity' | 'messages' | 'activeAssistantMessageId'
  > & {
    subagents?: SubagentTask[];
  },
  locale: SupportedLocale = 'en'
): string | null {
  const result = deriveAgentWorkingStatus(state, locale);
  return result.isWorking ? (result.text ?? null) : null;
}
