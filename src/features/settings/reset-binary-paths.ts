import {
  discoverEnvironmentPi,
  formatDiscoveryDiagnostic,
  type DiscoverEnvironmentPayload,
  type DiscoveredEnvironment,
} from '@infra/bridge';
import type { ConnectConfig } from '@core/types/connection';

/** Discover base binaries without trusting saved paths or changing any settings. */
export async function discoverBaseBinaryPaths(
  workingDirectory: string,
  discover: (payload?: DiscoverEnvironmentPayload) => Promise<DiscoveredEnvironment> = discoverEnvironmentPi,
): Promise<Pick<ConnectConfig, 'nodePath' | 'piEntrypoint'>> {
  const result = await discover({ preferredEntrypoint: null, preferredCwd: workingDirectory });
  if (result.entrypoint.status !== 'discovered' || !result.entrypoint.path?.trim() || !result.nodePath?.trim()) {
    throw new Error(result.entrypoint.message || formatDiscoveryDiagnostic(result) || 'Node or Pi CLI could not be discovered.');
  }
  return { nodePath: result.nodePath, piEntrypoint: result.entrypoint.path };
}
