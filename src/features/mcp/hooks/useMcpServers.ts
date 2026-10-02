import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  McpServerConfig,
  McpServerScope,
  ToggleMcpServerPayload,
  ToggleMcpServerResult,
} from '@core/types/mcp';
import { getMcpServersPi, toggleMcpServerPi } from '@infra/bridge';
import { calculateToggledServerState, computeMcpServerCounts } from '../mcp-utils';

export interface UseMcpServersOptions {
  cwd?: string;
}

export interface UseMcpServersResult {
  servers: McpServerConfig[];
  isLoading: boolean;
  activeCount: number;
  totalCount: number;
  handleToggleServer: (server: McpServerConfig, enabled: boolean, scope?: McpServerScope) => Promise<void>;
  handleToggleProjectServer: (server: McpServerConfig, enabled: boolean) => Promise<void>;
  refreshServers: () => Promise<void>;
}

/**
 * Optimistically toggles a server in the servers list.
 */
export function applyOptimisticToggle(
  servers: McpServerConfig[],
  serverName: string,
  enabled: boolean
): McpServerConfig[] {
  return calculateToggledServerState(servers, serverName, enabled);
}

/**
 * Reverts an optimistic toggle back to its original state.
 */
export function revertOptimisticToggle(
  servers: McpServerConfig[],
  serverName: string,
  originalEnabled: boolean
): McpServerConfig[] {
  return calculateToggledServerState(servers, serverName, originalEnabled);
}

export interface ExecuteMcpToggleOptions {
  servers: McpServerConfig[];
  server: McpServerConfig;
  enabled: boolean;
  cwd?: string;
  scope?: McpServerScope;
  toggleFn?: (payload: ToggleMcpServerPayload) => Promise<ToggleMcpServerResult>;
}

export interface ExecuteMcpToggleResult {
  nextServers: McpServerConfig[];
  success: boolean;
  error?: string;
}

/**
 * Core toggle workflow: applies optimistic update, calls bridge toggle,
 * and rolls back if bridge reports failure or throws.
 */
export async function executeMcpToggle({
  servers,
  server,
  enabled,
  cwd,
  scope,
  toggleFn = toggleMcpServerPi,
}: ExecuteMcpToggleOptions): Promise<ExecuteMcpToggleResult> {
  const optimisticServers = applyOptimisticToggle(servers, server.name, enabled);

  try {
    const res = await toggleFn({
      name: server.name,
      enabled,
      cwd,
      scope: scope || server.scope,
    });

    if (!res.success) {
      const reverted = revertOptimisticToggle(servers, server.name, server.enabled);
      return {
        nextServers: reverted,
        success: false,
        error: `Failed to toggle MCP server "${server.name}"`,
      };
    }

    return {
      nextServers: optimisticServers,
      success: true,
    };
  } catch (err) {
    const reverted = revertOptimisticToggle(servers, server.name, server.enabled);
    const message = err instanceof Error ? err.message : String(err);
    return {
      nextServers: reverted,
      success: false,
      error: message,
    };
  }
}

/**
 * Hook to manage MCP servers: loads servers on mount or cwd changes,
 * provides active/total server counts, optimistic toggle with rollback,
 * and manual refresh.
 */
export function useMcpServers({ cwd }: UseMcpServersOptions = {}): UseMcpServersResult {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshServers = useCallback(async () => {
    setIsLoading(true);
    try {
      const payload = await getMcpServersPi(cwd);
      setServers(payload.servers || []);
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
    } finally {
      setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const handleToggleServer = useCallback(
    async (server: McpServerConfig, enabled: boolean, scope?: McpServerScope) => {
      // Apply optimistic update immediately
      setServers((prev) => applyOptimisticToggle(prev, server.name, enabled));

      try {
        const res = await toggleMcpServerPi({
          name: server.name,
          enabled,
          cwd,
          scope: scope || server.scope,
        });

        if (!res.success) {
          // Revert optimistic update
          setServers((prev) => revertOptimisticToggle(prev, server.name, server.enabled));
          throw new Error(`Failed to toggle MCP server "${server.name}"`);
        }
      } catch (err) {
        // Revert optimistic update on exception
        setServers((prev) => revertOptimisticToggle(prev, server.name, server.enabled));
        throw err;
      }
    },
    [cwd]
  );

  const handleToggleProjectServer = useCallback(
    async (server: McpServerConfig, enabled: boolean) => {
      return handleToggleServer(server, enabled, cwd ? 'project' : server.scope);
    },
    [handleToggleServer, cwd]
  );

  const { total: totalCount, active: activeCount } = useMemo(
    () => computeMcpServerCounts(servers),
    [servers]
  );

  return {
    servers,
    isLoading,
    activeCount,
    totalCount,
    handleToggleServer,
    handleToggleProjectServer,
    refreshServers,
  };
}
