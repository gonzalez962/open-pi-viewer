export type SubagentStatus = 'running' | 'queued' | 'waiting' | 'completed' | 'failed';

export type SubagentThreadItem =
  | { kind: 'text' | 'thinking' | 'note'; text: string }
  | { kind: 'tool'; name: string; args: string; running: boolean; isError: boolean; output: string };

export interface SubagentThread {
  version: number;
  dropped: number;
  items: SubagentThreadItem[];
  viewerTruncated?: boolean;
}

/** Whitelisted live metadata and bounded publisher-provided activity. */
export interface SubagentTask {
  id: string;
  agent: string;
  label?: string;
  status: 'running' | 'queued' | 'waiting';
  lastStep?: string;
  thread?: SubagentThread;
  viewerTruncated?: boolean;
}

/** Normalized metadata from a Pi tool result or completion, not a live reading. */
export interface SubagentReport {
  id: string;
  agent: string;
  label?: string;
  completed: boolean;
  model?: string;
}

export type SubagentDetail = Omit<SubagentTask, 'status'> & {
  status: SubagentTask['status'] | 'completed';
  reportedModel?: string;
};

/**
 * Structured RPC payload carried in setWidget for gentle-agents.activity/v1.
 */
export interface AgentActivitySnapshot {
  schema: 'gentle-agents.activity/v1';
  summary?: {
    running?: number;
    queued?: number;
    waiting?: number;
    finished?: number;
  };
  tasks?: Array<{
    summary?: {
      id?: string;
      agent?: string;
      label?: string;
      prompt?: string;
      status?: string;
      createdAt?: number;
      startedAt?: number;
      endedAt?: number | null;
      lastStep?: string;
      lastActivityAt?: number;
      turns?: number;
      toolCalls?: number;
      error?: string | null;
    };
    thread?: unknown;
  }>;
}
