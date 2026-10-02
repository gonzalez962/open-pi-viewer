import type { TranslationKey } from '@shared/i18n';
import {
  categorizeProcess,
  type ProcessCategory,
  type ProcessItem,
  type RenderableChatItem,
} from '@core/process-grouping';

export interface DiscoveredSubagent {
  name: string;
  displayName?: string;
  type?: OddAgentType;
  status: 'running' | 'completed' | 'error';
}

export type OddAgentType =
  | 'orchestrator'
  | 'explore'
  | 'verify'
  | 'worker'
  | 'judge'
  | 'fix'
  | 'review'
  | 'other';

/**
 * Maps subagent name to its semantic ODD agent category for incandescent color rendering.
 */
export function getOddAgentType(name: string): OddAgentType {
  const lower = name.toLowerCase().trim();
  if (
    lower.includes('orchestrat') ||
    lower.includes('orquestad') ||
    lower === 'host' ||
    lower === 'main'
  ) {
    return 'orchestrator';
  }
  if (lower.includes('explore') || lower.includes('explorad')) return 'explore';
  if (lower.includes('verify') || lower.includes('verifier') || lower.includes('verificad')) return 'verify';
  if (lower.includes('worker') || lower.includes('task') || lower.includes('trabajad')) return 'worker';
  if (lower.includes('judge') || lower.includes('juez') || lower.includes('judgment')) return 'judge';
  if (lower.includes('fix')) return 'fix';
  if (lower.includes('review') || lower.includes('revis')) return 'review';
  return 'other';
}

/**
 * Maps technical agent identifiers to concise, capitalized display names
 * (e.g. 'gentle-ai-explore' -> 'Explorer', 'gentle-ai-verify' -> 'Verify', 'gentle-ai-worker' -> 'Task', 'orchestrator' -> 'Orquestador').
 */
export function getAgentDisplayName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (
    lower.includes('orchestrat') ||
    lower.includes('orquestad') ||
    lower === 'host' ||
    lower === 'main'
  ) {
    return 'Orquestador';
  }
  if (lower.includes('explore') || lower.includes('explorad')) {
    return 'Explorer';
  }
  if (lower.includes('verify') || lower.includes('verifier') || lower.includes('verificad')) {
    return 'Verify';
  }
  if (lower.includes('worker') || lower.includes('task') || lower.includes('trabajad')) {
    return 'Task';
  }
  if (lower.includes('judge') || lower.includes('juez') || lower.includes('judgment')) {
    return 'Judge';
  }
  if (lower.includes('fix')) {
    return 'Fix';
  }
  if (lower.includes('review') || lower.includes('revis')) {
    return 'Review';
  }

  // Remove gentle-ai- prefix if present, capitalize first letter
  const cleaned = name.replace(/^gentle-ai-/, '').replace(/[-_]/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Extracts distinct discovered subagents from process items, determining if any instance is currently running.
 * Filters out internal runner commands (like subagent_list_agents, subagent_status, subagent_result).
 * When includeOrchestrator is true:
 * - If subagents are present, prepends Orquestador as the parent coordinator.
 * - If no subagents are present, attributes the direct tool executions to Orquestador.
 */
export function extractDiscoveredSubagents(
  items: ProcessItem[],
  options?: { includeOrchestrator?: boolean }
): DiscoveredSubagent[] {
  const agentMap = new Map<string, 'running' | 'completed' | 'error'>();
  let hasRunning = false;
  let hasErrors = false;

  for (const it of items) {
    if (it.block.type !== 'tool_call') {
      if (it.block.type === 'thinking' && it.block.isStreaming) {
        hasRunning = true;
      }
      continue;
    }
    const b = it.block;
    if (b.status === 'running') hasRunning = true;
    if (b.status === 'error' || b.isError) hasErrors = true;

    let agentName: string | null = null;
    let parsedArgs = b.args;
    if (typeof parsedArgs === 'string') {
      try {
        parsedArgs = JSON.parse(parsedArgs);
      } catch {}
    }

    if (parsedArgs && typeof parsedArgs === 'object' && typeof (parsedArgs as any).agent === 'string') {
      agentName = (parsedArgs as any).agent.trim();
    } else if (typeof b.args === 'string') {
      const match = b.args.match(/"agent"\s*:\s*"([^"]+)"/) || b.args.match(/(?:["']?agent["']?)\s*:\s*["']([^"']+)["']/);
      if (match && match[1]) {
        agentName = match[1].trim();
      }
    }

    if (
      !agentName &&
      b.name &&
      !b.name.startsWith('subagent_') &&
      b.name !== 'subagent' &&
      b.name !== 'agent' &&
      (it.category === 'agents' || b.name.startsWith('gentle-ai') || b.name.includes('explore') || b.name.includes('verify') || b.name.includes('worker'))
    ) {
      agentName = b.name.trim();
    }

    if (!agentName) continue;

    const currentStatus = agentMap.get(agentName);
    const itemStatus = b.status === 'running' ? 'running' : (b.status === 'error' || b.isError ? 'error' : 'completed');

    if (itemStatus === 'running') {
      agentMap.set(agentName, 'running');
    } else if (itemStatus === 'error') {
      if (currentStatus !== 'running') {
        agentMap.set(agentName, 'error');
      }
    } else if (!currentStatus) {
      agentMap.set(agentName, itemStatus);
    }
  }

  const subagents = Array.from(agentMap.entries()).map(([name, status]) => ({
    name,
    displayName: getAgentDisplayName(name),
    type: getOddAgentType(name),
    status,
  }));

  if (options?.includeOrchestrator) {
    const orchStatus: 'running' | 'completed' | 'error' = hasRunning
      ? 'running'
      : hasErrors
        ? 'error'
        : 'completed';

    const orchestratorEntry: DiscoveredSubagent = {
      name: 'Orquestador',
      displayName: 'Orquestador',
      type: 'orchestrator',
      status: orchStatus,
    };

    return [orchestratorEntry, ...subagents];
  }

  return subagents;
}

/**
 * Extracts any discovered ODD subagents directly from a ChatMessage's blocks.
 */
export function extractOddAgentsFromMessage(msg?: { blocks?: unknown[] } | null): DiscoveredSubagent[] {
  if (!msg?.blocks || !Array.isArray(msg.blocks)) return [];
  const items: ProcessItem[] = [];
  for (let i = 0; i < msg.blocks.length; i++) {
    const b = msg.blocks[i] as any;
    if (b && (b.type === 'tool_call' || b.type === 'toolCall')) {
      const cat = categorizeProcess(b);
      // Only consider if it is categorized as agents or has agent in arguments
      if (cat === 'agents' || b.name?.startsWith('subagent') || b.args?.agent) {
        items.push({
          id: b.id || `tool-${i}`,
          category: 'agents',
          block: b,
          messageId: '',
        });
      }
    }
  }
  return extractDiscoveredSubagents(items);
}

/**
 * Extracts all distinct ODD subagents that participated in the assistant turn
 * corresponding to the message at currentIndex. Scans backwards across process groups
 * and assistant messages up to the turn's user prompt.
 */
export function getTurnOddAgents(
  items: RenderableChatItem[],
  currentIndex: number
): DiscoveredSubagent[] {
  const currentItem = items[currentIndex];
  if (currentItem.type !== 'message' || currentItem.message.role !== 'assistant') {
    return [];
  }

  const seen = new Set<string>();
  const turnAgents: DiscoveredSubagent[] = [];

  const direct = extractOddAgentsFromMessage(currentItem.message);
  for (const a of direct) {
    if (!seen.has(a.name)) {
      seen.add(a.name);
      turnAgents.push(a);
    }
  }

  for (let i = currentIndex - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'message' && it.message.role === 'user') {
      break;
    }
    if (it.type === 'process_group') {
      const fromGroup = extractDiscoveredSubagents(it.items);
      for (const a of fromGroup) {
        if (!seen.has(a.name)) {
          seen.add(a.name);
          turnAgents.push(a);
        }
      }
    } else if (it.type === 'message' && it.message.role === 'assistant') {
      const fromPrev = extractOddAgentsFromMessage(it.message);
      for (const a of fromPrev) {
        if (!seen.has(a.name)) {
          seen.add(a.name);
          turnAgents.push(a);
        }
      }
    }
  }

  return turnAgents;
}

/**
 * Returns accessible localized labels and Nerd Font glyphs for process categories.
 */
export function getCategoryDetails(
  category: ProcessCategory,
  count: number,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
): { label: string; countLabel: string; glyph: string } {
  switch (category) {
    case 'bash':
      return {
        label: 'bash',
        countLabel: count === 1 ? t('process.count_execution_one') : t('process.count_executions', { count }),
        glyph: '',
      };
    case 'edit':
      return {
        label: 'edit',
        countLabel: count === 1 ? t('process.count_edit_one') : t('process.count_edits', { count }),
        glyph: '󰈙',
      };
    case 'read':
      return {
        label: 'read',
        countLabel: count === 1 ? t('process.count_file_one') : t('process.count_files', { count }),
        glyph: '',
      };
    case 'write':
      return {
        label: 'write',
        countLabel: count === 1 ? t('process.count_write_one') : t('process.count_writes', { count }),
        glyph: '󰏫',
      };
    case 'search':
      return {
        label: 'search',
        countLabel: count === 1 ? t('process.count_search_one') : t('process.count_searches', { count }),
        glyph: '󰍉',
      };
    case 'agents': {
      return {
        label: 'agentes',
        countLabel: count === 1 ? t('process.count_agent_one') : t('process.count_agents', { count }),
        glyph: '󰚩',
      };
    }
    case 'thinking':
      return {
        label: 'pensamiento',
        countLabel: count === 1 ? t('process.count_thought_one') : t('process.count_thoughts', { count }),
        glyph: '󰌠',
      };
    default:
      return {
        label: 'otros',
        countLabel: count === 1 ? t('process.count_tool_one') : t('process.count_tools', { count }),
        glyph: '⚙',
      };
  }
}
