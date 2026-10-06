export interface ViewerSessionRecord {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  hasMessages: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewSessionResult {
  cancelled: boolean;
  partialReset?: boolean;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
}

export interface SessionPersistenceStatus {
  sessionId: string;
  sessionFile: string;
  canonicalCwd: string;
  generation: number;
  messageCount: number;
  fileExists: boolean;
}

export type SessionRuntimeStatus = 'working' | 'completed' | 'waiting';

export interface SessionSummary {
  id: string;
  path: string;
  createdAt?: string;
  modifiedAt?: string;
  firstMessage: string;
  messageCount: number;
  isActive: boolean;
  customTitle?: string;
  status?: SessionRuntimeStatus;
}

export interface SwitchSessionResult {
  cancelled: boolean;
  sessionId?: string;
  sessionFile?: string;
  messageCount: number;
  messages: unknown[];
  hasMore?: boolean;
  status?: SessionRuntimeStatus;
  error?: string;
}

export interface DeleteSessionResult {
  success: boolean;
  wasActive: boolean;
  newSession?: NewSessionResult;
}
