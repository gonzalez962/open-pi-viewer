import type { SubagentTask, AgentActivitySnapshot, SubagentDetail, SubagentReport, SubagentThread, SubagentThreadItem } from './types/agent-activity';
import type { ChatSessionState } from './types/chat-state';
import type { ChatTranscript } from './types/messages';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, limit: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= limit ? text : undefined;
}

/** Read only Pi-owned structured task metadata; output text and tool args are not evidence. */
export function parseSubagentReport(toolName: unknown, value: unknown, isError?: unknown): SubagentReport | undefined {
  if (toolName !== 'subagent_run' && toolName !== 'subagent_continue' && toolName !== 'subagent_status' && toolName !== 'subagent_result') return;
  if (isError || asRecord(value)?.isError) return;
  return readTaskReport(asRecord(value)?.details);
}

export function parseSubagentCompletion(value: unknown): SubagentReport | undefined {
  const message = asRecord(value);
  if (message?.role !== 'custom' || message.customType !== 'gentle-agents.result') return;
  return readTaskReport(message.details);
}

function readTaskReport(value: unknown): SubagentReport | undefined {
  const details = asRecord(value);
  if (details?.error) return;
  const task = asRecord(details?.gentleAgents);
  const id = boundedString(task?.taskId, 120);
  if (!id) return;
  const model = boundedString(task?.model, 500);
  const label = boundedString(task?.label, 500);
  const completed = task?.status === 'completed';
  const concrete = model && model.toLowerCase() !== 'default' && !/[\x00-\x1f\x7f]/.test(model) ? model : undefined;
  if (!concrete && !completed) return;
  return { id, agent: boundedString(task?.agent, 120) ?? 'subagent', label, completed, model: concrete };
}

/** Fold reports in observation order without letting placeholders erase concrete evidence. */
export function rememberSubagentReport(reports: Map<string, SubagentReport>, report: SubagentReport): void {
  const previous = reports.get(report.id);
  reports.set(report.id, previous ? {
    ...report,
    label: report.label ?? previous.label,
    completed: previous.completed || report.completed,
    model: report.model ?? previous.model,
  } : report);
}

export function subagentReportOwner(sessionId?: string | null, sessionFile?: string | null): string | undefined {
  return sessionId && sessionFile ? JSON.stringify([sessionId, sessionFile]) : undefined;
}

export function* subagentReportsFromHistory(messages: ChatTranscript): Iterable<SubagentReport> {
  yield* messages.unattachedSubagentReports ?? [];
  for (const message of messages) yield* message.subagentReports ?? [];
}

/** The modal includes finished reports; the live widget list remains unchanged. */
export function getSubagentDetails({ subagents, messages, sessionId, sessionFile, subagentReportsBySession }: Pick<ChatSessionState, 'subagents' | 'messages' | 'sessionId' | 'sessionFile' | 'subagentReportsBySession'>): SubagentDetail[] {
  const reports = new Map<string, SubagentReport>();
  for (const report of subagentReportsFromHistory(messages)) rememberSubagentReport(reports, report);
  const owner = subagentReportOwner(sessionId, sessionFile);
  if (owner) {
    for (const report of subagentReportsBySession?.get(owner)?.values() ?? []) rememberSubagentReport(reports, report);
  }
  const tasks: SubagentDetail[] = subagents.map(task => {
    const report = reports.get(task.id);
    reports.delete(task.id);
    return report ? { ...task, status: report.completed ? 'completed' : task.status, reportedModel: report.model } : task;
  });
  for (const report of reports.values()) {
    if (report.completed) tasks.push({ id: report.id, agent: report.agent, label: report.label, status: 'completed', reportedModel: report.model });
  }
  return tasks;
}

function parseThread(raw: unknown): SubagentThread | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 0 ||
      !Number.isSafeInteger(value.dropped) || (value.dropped as number) < 0 || !Array.isArray(value.items)) return undefined;
  const items: SubagentThreadItem[] = [];
  let viewerTruncated = value.items.length > 40;
  const bounded = (text: string, limit: number) => {
    if (text.length > limit) viewerTruncated = true;
    return text.slice(0, limit);
  };
  for (const rawItem of value.items.slice(-40)) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    if ((item.kind === 'text' || item.kind === 'thinking' || item.kind === 'note') && typeof item.text === 'string') {
      items.push({ kind: item.kind, text: bounded(item.text, 2000) });
    } else if (item.kind === 'tool' && typeof item.name === 'string' && typeof item.args === 'string' &&
      typeof item.running === 'boolean' && typeof item.isError === 'boolean' && typeof item.output === 'string') {
      items.push({ kind: 'tool', name: bounded(item.name, 120), args: bounded(item.args, 500), running: item.running, isError: item.isError, output: bounded(item.output, 500) });
    }
  }
  return { version: value.version as number, dropped: value.dropped as number, items, ...(viewerTruncated ? { viewerTruncated: true } : {}) };
}

/**
 * Validates and safely parses a gentle-agents.activity/v1 setWidget payload.
 *
 * Applies conservative bounds and whitelists public metadata and thread items:
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

    const thread = parseThread(item.thread);
    active.push({
      id,
      agent,
      label,
      status,
      lastStep,
      ...(thread ? { thread } : {}),
      ...((rawAgent.length > 120 || (typeof s.label === 'string' && s.label.trim().length > 500) || (typeof s.lastStep === 'string' && s.lastStep.trim().length > 500)) ? { viewerTruncated: true } : {}),
    });

    if (active.length >= maxTasks) break;
  }

  return active;
}
