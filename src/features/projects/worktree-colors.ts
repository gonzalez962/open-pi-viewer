import { isWindowsPath } from '@core/session';
import { normalizeProjectPath } from './projects';

const palette = ['var(--accent-primary)', 'var(--status-green)', 'var(--status-amber)', 'var(--status-red)', 'var(--border-active)'];

export function getWorktreeRepositoryColor(primaryPath: string): string {
  const normalized = normalizeProjectPath(primaryPath);
  const key = isWindowsPath(normalized) ? normalized.toLowerCase().replace(/\\/g, '/') : normalized;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return palette[(hash >>> 0) % palette.length];
}
