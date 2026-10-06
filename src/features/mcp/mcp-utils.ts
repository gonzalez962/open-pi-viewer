import type { McpServerConfig } from '@core/types/mcp';

/**
 * Compute total and active server counts.
 */
export function computeMcpServerCounts(servers: McpServerConfig[]): {
  total: number;
  active: number;
} {
  const total = servers.length;
  const active = servers.filter((server) => server.enabled).length;
  return { total, active };
}

/**
 * Immutably calculate state after toggling a server.
 */
export function calculateToggledServerState(
  servers: McpServerConfig[],
  toggledName: string,
  nextEnabled: boolean
): McpServerConfig[] {
  return servers.map((server) => {
    if (server.name === toggledName) {
      return {
        ...server,
        enabled: nextEnabled,
        disabled: !nextEnabled,
      };
    }
    return server;
  });
}
