import { parseSubagentSnapshot } from './agent-activity';
import { applyJobChange, parseJobChange } from './job-activity';
import type { AgentOutcome } from './agent-outcome';

type Event = { type: string; [key: string]: any };
type State = { jobs: string[]; children: number; pending?: Event; settled: boolean; explicitTurn: boolean; file?: string };

/** Notification state is independent of the selected conversation. */
export class CompletionNotifications {
  private readonly sessions = new Map<string, State>();

  private key(event: Event): string {
    return JSON.stringify([event.cwd ?? '', event.sessionId ?? event.sessionFile ?? '']);
  }

  clear(event: Event): void {
    if (event.sessionId || event.sessionFile) {
      this.sessions.delete(this.key(event));
      return;
    }
    for (const key of this.sessions.keys()) {
      const [cwd] = JSON.parse(key) as [string, string];
      if (!event.cwd || cwd === event.cwd) this.sessions.delete(key);
    }
  }

  observe(event: Event, outcome: AgentOutcome | undefined): Event | undefined {
    const key = this.key(event);
    let state = this.sessions.get(key);
    if (!state) {
      if (this.sessions.size >= 256) this.sessions.delete(this.sessions.keys().next().value!);
      state = { jobs: [], children: 0, settled: false, explicitTurn: false };
      this.sessions.set(key, state);
    }
    if (event.type === 'agent_start') {
      state.pending = undefined;
      state.settled = false;
      state.explicitTurn = true;
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') state.settled = false;
    if (event.type === 'runtime_snapshot') {
      if ((state.file && event.sessionFile && state.file !== event.sessionFile) || (!state.file && event.sessionFile && Array.isArray(event.activeJobs) && state.pending)) {
        state.pending = undefined;
        state.settled = true;
        state.children = 0;
      }
      if (typeof event.sessionFile === 'string') state.file = event.sessionFile;
      if (Array.isArray(event.activeJobs)) state.jobs = event.activeJobs.filter((id: unknown): id is string => typeof id === 'string');
    }
    const job = parseJobChange(event);
    if (job) state.jobs = applyJobChange(state.jobs, job);
    if (event.type === 'extension_ui_request' && event.method === 'setWidget' && event.widgetKey === 'gentle-agents' && Array.isArray(event.widgetLines)) {
      const line = event.widgetLines[0];
      if (typeof line === 'string' && line.length <= 262144) {
        try {
          const children = parseSubagentSnapshot(JSON.parse(line));
          if (children !== null) state.children = children.length;
        } catch { /* Keep the last valid snapshot. */ }
      }
    }
    if (event.type === 'agent_settled') {
      if (state.settled && state.explicitTurn) return undefined;
      state.settled = true;
      if (outcome === null) {
        state.pending = undefined;
        return undefined;
      }
      if (outcome !== undefined && outcome !== 'task_complete') return event;
      state.pending = event;
    }
    if (state.pending && !state.jobs.length && !state.children) {
      const ready = state.pending;
      state.pending = undefined;
      return ready;
    }
    return undefined;
  }
}
