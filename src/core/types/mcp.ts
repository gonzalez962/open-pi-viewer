export type McpServerScope = 'global' | 'project';

export type McpServerType = 'stdio' | 'sse' | 'remote';

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  serverType: McpServerType;
  envKeys: string[];
  disabled: boolean;
  enabled: boolean;
  scope: McpServerScope;
  hasProjectOverride?: boolean;
  alwaysActive?: boolean;
  configPath: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpServersPayload {
  servers: McpServerConfig[];
}

export interface ToggleMcpServerPayload {
  name: string;
  enabled: boolean;
  cwd?: string;
  scope?: McpServerScope;
}

export interface ToggleMcpServerResult {
  success: boolean;
  name: string;
  enabled: boolean;
  path: string;
}

export interface SaveMcpServerPayload {
  name: string;
  oldName?: string;
  server: {
    command?: string;
    args?: string[];
    url?: string;
    type?: string;
    serverType?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    disabled?: boolean;
    enabled?: boolean;
    [key: string]: unknown;
  };
  cwd?: string;
  scope?: McpServerScope;
}

export interface SaveMcpServerResult {
  success: boolean;
  name: string;
  path: string;
}

export interface DeleteMcpServerPayload {
  name: string;
  cwd?: string;
  scope?: McpServerScope;
}

export interface DeleteMcpServerResult {
  success: boolean;
  name: string;
  path: string;
}

export type ResourceActivationKind = 'extension' | 'mcp';

export interface SetResourceActivationPayload {
  kind: ResourceActivationKind;
  identity: string;
  enabled: boolean;
  cwd?: string;
}

export interface SetResourceActivationResult {
  success: boolean;
}


