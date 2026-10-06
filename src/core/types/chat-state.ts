import type { ConnectionState } from './connection';
import type { AgentActivity, ChatMessage } from './messages';
import type { ModelInfo, SessionStats, ThinkingLevel } from './models';
import type { SessionSummary } from './sessions';

export interface ChatSessionState {
  connectionStatus: ConnectionState;
  agentActivity: AgentActivity;
  statusLabel: string;
  statusDetail: string;
  modelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  isModelsLoading: boolean;
  thinkingLevel: ThinkingLevel | null;
  availableThinkingLevels: ThinkingLevel[];
  isChangingModel: boolean;
  sessionStats: SessionStats | null;
  modelStats: Record<string, SessionStats>;
  messages: ChatMessage[];
  hasMoreMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  activeAssistantMessageId: string | null;
  pendingPromptId: string | null;
  lastError: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  isHydrated: boolean;
  isResetting: boolean;
  sessions: SessionSummary[];
  isSessionsLoading: boolean;
  sessionsError: string | null;
  isSwitchingSession: boolean;
  isSidebarOpen: boolean;
  pendingApprovals?: unknown[];
}
