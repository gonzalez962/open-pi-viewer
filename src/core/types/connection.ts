import type { ModelInfo } from './models';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BridgeStatus {
  state: ConnectionState;
  label: string;
  detail: string;
  model?: ModelInfo | null;
}

export type ConnectionType = 'local' | 'mesh';

export interface ConnectConfig {
  nodePath: string;
  piEntrypoint: string;
  workingDirectory: string;
  fileTreeRefreshInterval?: number;
  connectionType?: ConnectionType;
  meshCoordinatorUrl?: string;
  meshToken?: string;
}

export interface ConnectSessionOptions {
  sessionFile?: string;
  requireSessionFileExists?: boolean;
}

export interface ConnectResult {
  connected: boolean;
  model: ModelInfo | null;
  sessionId?: string;
  sessionFile?: string;
  messageCount?: number;
  canonicalCwd?: string;
  messages?: unknown[];
}
