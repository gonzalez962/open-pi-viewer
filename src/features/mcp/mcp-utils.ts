import type { McpServerConfig } from '@core/types/mcp';

export function computeMcpServerCounts(servers: McpServerConfig[]): {
  total: number;
  active: number;
} {
  const total = servers.length;
  const active = servers.filter((server) => server.enabled).length;
  return { total, active };
}

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
