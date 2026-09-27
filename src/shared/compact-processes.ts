/**
 * Persistence for the "compact processes" chat toolbar toggle (Issue #8): whether
 * consecutive process (thinking/tool_call) blocks render as compact `ProcessGroup` cards
 * instead of one card per block. Follows the same safe-storage pattern
 * as `src/infra/preferences.ts` (try/catch around every localStorage access, honest
 * fallback on failure), but stays a plain boolean flag in `shared/` since it carries no
 * app-preference schema of its own.
 */

export const COMPACT_PROCESSES_STORAGE_KEY = 'pi_viewer_compact_processes';

/**
 * Safely accesses the browser's localStorage or returns null in non-browser environments.
 */
function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage access may throw SecurityError in restricted iframes or disabled cookies
  }
  return null;
}

/**
 * Loads the compact-processes preference. Defaults to `true` (compact view on) whenever
 * storage is unavailable, empty, or holds an unrecognized value; only an explicit
 * `'false'` written by the toolbar toggle turns it off.
 */
export function loadCompactProcessesPreference(
  storage: Storage | null = getSafeStorage()
): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(COMPACT_PROCESSES_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Persists the compact-processes preference. Never throws; returns whether the write
 * succeeded so callers can surface a diagnostic without crashing the toggle interaction.
 */
export function saveCompactProcessesPreference(
  value: boolean,
  storage: Storage | null = getSafeStorage()
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(COMPACT_PROCESSES_STORAGE_KEY, value ? 'true' : 'false');
    return true;
  } catch {
    return false;
  }
}
