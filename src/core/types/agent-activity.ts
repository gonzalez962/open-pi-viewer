export type SubagentStatus = 'running' | 'queued' | 'waiting' | 'completed' | 'failed';

/**
 * Minimal whitelisted public state retained for live subagents.
 * Never stores prompts, internal instructions, transcripts, or thread items.
 */
export interface SubagentTask {
  id: string;
  agent: string;
  label?: string;
  status: 'running' | 'queued' | 'waiting';
  lastStep?: string;
}

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
