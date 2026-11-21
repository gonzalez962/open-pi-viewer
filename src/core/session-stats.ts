import type { SessionStats } from './types/models';

/**
 * Stats refresh after a successful session switch. The reducer clears `sessionStats` on
 * SWITCH_SESSION_SUCCESS, and nothing else re-fetches them until the next assistant turn,
 * so the context meter would read 0 for historical sessions. Stats that name a different
 * session (a later switch won the race) are discarded; a failed fetch is non-critical.
 */
export async function fetchSwitchedSessionStats(
  fetchStats: () => Promise<SessionStats | null>,
  expectedSessionId: string
): Promise<SessionStats | null> {
  try {
    const stats = await fetchStats();
    if (!stats) return null;
    if (stats.sessionId && stats.sessionId !== expectedSessionId) return null;
    return stats;
  } catch {
    return null;
  }
}
