export type AgentActivity = 'idle' | 'busy';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  isStreaming?: boolean;
}

export type ToolExecutionStatus = 'running' | 'completed' | 'error';

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  args?: Record<string, unknown> | string;
  status: ToolExecutionStatus;
  output?: string;
  isError?: boolean;
}

export type MessageBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  isCancelled?: boolean;
  /**
   * Set on a user message sent via `PROMPT_QUEUED` while the agent is busy. Cleared once
   * Pi starts processing the follow-up turn (a user-role `message_start` event), or on
   * abort, since Pi discards its queue at that point.
   */
  isQueued?: boolean;
  blocks?: MessageBlock[];
}
