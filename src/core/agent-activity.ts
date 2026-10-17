import type { SubagentTask, AgentActivitySnapshot } from './types/agent-activity';

/**
 * Validates and safely parses a gentle-agents.activity/v1 setWidget payload.
 *
 * Applies conservative bounds and whitelists public metadata only:
 * - ID and agent <= 120 chars
 * - Label and lastStep <= 500 chars
 * - Retains only active tasks ('running' | 'queued' | 'waiting')
 * - Caps task count at 64
 * - Fails safely: returns null if the schema is missing or invalid.
 */
export function parseSubagentSnapshot(raw: unknown): SubagentTask[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as Partial<AgentActivitySnapshot>;
  if (snapshot.schema !== 'gentle-agents.activity/v1') return null;
  if (!Array.isArray(snapshot.tasks)) return null;

  const active: SubagentTask[] = [];
  const maxTasks = 64;

  for (const item of snapshot.tasks) {
    if (!item || typeof item !== 'object') continue;
    const s = item.summary;
    if (!s || typeof s !== 'object') continue;

    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id || id.length > 120) continue;

    const status = s.status;
    if (status !== 'running' && status !== 'queued' && status !== 'waiting') {
      // Completed, failed, or unrecognized statuses are terminal / inactive
      continue;
    }

    const rawAgent = typeof s.agent === 'string' && s.agent.trim() ? s.agent.trim() : 'subagent';
    const agent = rawAgent.length > 120 ? rawAgent.slice(0, 120) : rawAgent;

    const label = typeof s.label === 'string' && s.label.trim()
      ? (s.label.trim().length > 500 ? s.label.trim().slice(0, 500) : s.label.trim())
      : undefined;

    const lastStep = typeof s.lastStep === 'string' && s.lastStep.trim()
      ? (s.lastStep.trim().length > 500 ? s.lastStep.trim().slice(0, 500) : s.lastStep.trim())
      : undefined;

    active.push({
      id,
      agent,
      label,
      status,
      lastStep,
    });

    if (active.length >= maxTasks) break;
  }

  return active;
}
