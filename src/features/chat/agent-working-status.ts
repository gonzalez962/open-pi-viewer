/**
 * Agent Working Status (T1 / S2): Pure derivation of current agent activity
 * and ODD phase presentation from session messages and tool events.
 *
 * Grounded in pi-notify reference pattern (lib/herdr.ts):
 * - Derives working text dynamically instead of a fixed "Working" string.
 * - Current gentle_odd_phase tool calls provide explicit phase evidence.
 * - Formatted running tool names are deduplicated, stripped of MCP prefixes,
 *   free of excluded control tools, and limited to 3 items plus overflow (+N).
 * - Distinguishes streaming thinking ("Thinking") from response generation ("Generating").
 * - Falls back to localized "Working" when evidence is absent, without reusing
 *   historical run state or queued prompts.
 * - Reports no working activity (null) when idle or disconnected.
 */

import type { ChatSessionState } from '@core/types/chat-state';
import type { ChatMessage } from '@core/types/messages';
import type { SupportedLocale, TranslationKey } from '@shared/i18n';
import { translate } from '@shared/i18n';

export type ActivityKind = 'phase' | 'tool' | 'thinking' | 'generating' | 'fallback';

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
  state: Pick<ChatSessionState, 'connectionStatus' | 'agentActivity' | 'messages' | 'activeAssistantMessageId'>,
  locale: SupportedLocale = 'en'
): AgentWorkingStatus {
  // S2.5: Idle agent or disconnected/error session reports no current working activity
  if (state.connectionStatus !== 'connected' || state.agentActivity !== 'busy') {
    return {
      isWorking: false,
      runningTools: [],
    };
  }

  const runMessages = getCurrentRunMessages(state.messages || []);

  let activePhase: string | undefined;
  const runningTools: string[] = [];
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
                activePhase = undefined;
              } else if (phase) {
                activePhase = phase;
              }
            }
          } else if (block.status === 'running') {
            if (!EXCLUDED_CONTROL_TOOLS.has(stripped)) {
              const formatted = formatToolName(block.name);
              if (!runningTools.includes(formatted)) {
                runningTools.push(formatted);
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

  let text = baseLabel;
  if (runningTools.length > 0) {
    let suffixItems = [...runningTools];
    if (suffixItems.length > 3) {
      suffixItems = [...suffixItems.slice(0, 3), `+${suffixItems.length - 3}`];
    }
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
  state: Pick<ChatSessionState, 'connectionStatus' | 'agentActivity' | 'messages' | 'activeAssistantMessageId'>,
  locale: SupportedLocale = 'en'
): string | null {
  const result = deriveAgentWorkingStatus(state, locale);
  return result.isWorking ? (result.text ?? null) : null;
}
