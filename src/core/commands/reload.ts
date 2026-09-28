/**
 * Real outcome of a "/reload" reconnect attempt (Issue #9 T6), as reported by the
 * connection lifecycle once the attempt settled — never inferred from the attempt's
 * promise merely resolving:
 * - 'success': the connect callback fired for this attempt.
 * - 'error': the connect failed; `error` is the reported message.
 * - 'cancelled': the attempt was superseded or cancelled before it could settle.
 */
export type ReloadOutcome =
  | { status: 'success' }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

/**
 * What happened when "/reload" was requested: either a reconnect was already running
 * ('busy', nothing new was started) or a new attempt was started and `result` settles
 * with its real outcome.
 */
export type ReloadRequest =
  | { status: 'busy' }
  | { status: 'started'; result: Promise<ReloadOutcome> };

export type ReloadNoticeKey =
  | 'command_palette.reload_success'
  | 'command_palette.reload_failed'
  | 'command_palette.reload_superseded'
  | 'command_palette.reload_busy';

/** Localizable notice (translation key + interpolation params) to append to the chat. */
export interface ReloadNotice {
  key: ReloadNoticeKey;
  params?: { error: string };
}

/**
 * Maps a "/reload" outcome to the chat notice that reports it. Pure: returns a translation
 * key (plus the error message for failures) so the caller localizes it.
 */
export function describeReloadOutcome(
  outcome: ReloadOutcome | { status: 'busy' }
): ReloadNotice {
  switch (outcome.status) {
    case 'success':
      return { key: 'command_palette.reload_success' };
    case 'error': {
      const error = outcome.error.trim() || 'unknown error';
      return { key: 'command_palette.reload_failed', params: { error } };
    }
    case 'cancelled':
      return { key: 'command_palette.reload_superseded' };
    case 'busy':
      return { key: 'command_palette.reload_busy' };
  }
}
