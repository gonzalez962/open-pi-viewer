import type { SessionStats } from '@core/types/models';
import type { DeleteSessionResult, NewSessionResult, SessionSummary } from '@core/types/sessions';

/**
 * Real branching for App.tsx's former inline `handleSelectSession`, extracted so it can be
 * exercised directly instead of hand-reimplemented in a test (see
 * tests/features/sessions/sidebar.test.ts, which used to copy this logic rather than test
 * it - odd/tasks/architecture-restructure.md, T5d).
 *
 * Two independent decisions collapse into one guard chain in the original code:
 * 1. Blocked while a switch is already in flight or the agent is busy.
 * 2. Clicking the already-active session never switches; it only closes the settings
 *    panel if it happened to be open.
 * 3. Otherwise the caller proceeds to close settings (unconditionally) and switch.
 */
export type SelectSessionDecision =
  | { action: 'blocked' }
  | { action: 'already-current'; closeSettings: boolean }
  | { action: 'switch' };

export function decideSelectSession(
  session: SessionSummary,
  sessionState: { isSwitchingSession: boolean; sessionId: string | null; sessionFile: string | null },
  isBusy: boolean,
  showSettings: boolean
): SelectSessionDecision {
  if (sessionState.isSwitchingSession || isBusy) {
    return { action: 'blocked' };
  }

  const isCurrentSession =
    session.isActive ||
    Boolean(sessionState.sessionId && session.id === sessionState.sessionId) ||
    Boolean(sessionState.sessionFile && session.path === sessionState.sessionFile);

  if (isCurrentSession) {
    return { action: 'already-current', closeSettings: showSettings };
  }

  return { action: 'switch' };
}

/** Guard shared by handleDeleteSession: no delete while busy or mid-switch. */
export function canDeleteSession(isBusy: boolean, isSwitchingSession: boolean): boolean {
  return !isBusy && !isSwitchingSession;
}

/**
 * Real branching for App.tsx's former inline `handleDeleteSession` result handling: what
 * happens when the deleted session was the active one. The backend always reports
 * `wasActive`/`newSession` together when a replacement session was created server-side;
 * this only decides how the frontend reacts, mirroring the original nested-if exactly
 * (the record is only saved when the replacement carries both identifiers, but the
 * NEW_CONVERSATION_SUCCESS dispatch happens whenever `wasActive && newSession` is truthy,
 * even if one of those identifiers is missing).
 */
export type DeleteSessionOutcome =
  | { kind: 'failed' }
  | { kind: 'success' }
  | {
      kind: 'active-replaced';
      shouldSaveRecord: boolean;
      sessionId?: string;
      sessionFile?: string;
    };

export function decideDeleteOutcome(res: DeleteSessionResult): DeleteSessionOutcome {
  if (!res.success) {
    return { kind: 'failed' };
  }

  if (res.wasActive && res.newSession) {
    return {
      kind: 'active-replaced',
      shouldSaveRecord: Boolean(res.newSession.sessionId && res.newSession.sessionFile),
      sessionId: res.newSession.sessionId,
      sessionFile: res.newSession.sessionFile,
    };
  }

  return { kind: 'success' };
}

/** Guard shared by handleNewConversation: no reset while busy, connecting, or already resetting. */
export function canStartNewConversation(
  isBusy: boolean,
  isConnecting: boolean,
  isResetting: boolean
): boolean {
  return !isBusy && !isConnecting && !isResetting;
}

/**
 * Real branching for App.tsx's former inline `handleNewConversation`'s online-path result
 * handling: cancelled, a fail-closed partial reset (Pi reset but state reconciliation
 * failed), or a genuine success (only then is the session record optionally saved).
 */
export type NewConversationOutcome =
  | { kind: 'cancelled' }
  | { kind: 'partial-reset'; error: string }
  | { kind: 'success'; shouldSaveRecord: boolean; sessionId?: string; sessionFile?: string };

export function decideNewConversationOutcome(res: NewSessionResult): NewConversationOutcome {
  if (res.cancelled) {
    return { kind: 'cancelled' };
  }

  if (res.partialReset) {
    return {
      kind: 'partial-reset',
      error:
        res.error ||
        'Session reset partially completed in Pi, but state reconciliation failed',
    };
  }

  return {
    kind: 'success',
    shouldSaveRecord: Boolean(res.sessionId && res.sessionFile),
    sessionId: res.sessionId,
    sessionFile: res.sessionFile,
  };
}

/**
 * Real branching for the `prevBusyRef` effect: sessions are reloaded only on the exact
 * busy -> idle transition while connected, not on every render where those three values
 * happen to be in that state.
 */
export function shouldReloadSessionsOnIdle(
  wasBusy: boolean,
  isBusy: boolean,
  isConnected: boolean
): boolean {
  return wasBusy && !isBusy && isConnected;
}

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
