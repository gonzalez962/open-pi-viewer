import { invoke } from '@tauri-apps/api/core';
import {
  TERMINAL_COMMANDS,
  type TerminalOpenArgs,
  type TerminalWriteArgs,
  type TerminalResizeArgs,
  type TerminalCloseArgs,
  type TerminalPollArgs,
  type TerminalPollResult,
  type TerminalGetArgs,
  type TerminalSessionDto,
} from '@core/terminal';

export type TerminalInvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TerminalPollerOptions {
  id: string;
  initialCursor?: number;
  timeoutMs?: number;
  onData?: (data: string) => void;
  onExit?: (exitCode: number | null, signal?: number) => void;
  onError?: (err: Error) => void;
  invokeFn?: TerminalInvokeFn;
}

export interface TerminalPoller {
  start(): void;
  stop(): void;
  isActive(): boolean;
  getCursor(): number;
}

/**
 * Open or reattach to a persistent project terminal session.
 * Supplies both payload wrapper (for native Tauri commands/terminal.rs)
 * and flat fields (for web IPC bridge).
 */
export async function terminalOpen(
  args: TerminalOpenArgs,
  invokeFn: TerminalInvokeFn = invoke
): Promise<TerminalSessionDto> {
  const payload = {
    cwd: args.cwd,
    cols: args.cols,
    rows: args.rows,
  };
  return invokeFn<TerminalSessionDto>(TERMINAL_COMMANDS.OPEN, {
    payload,
    ...payload,
  });
}

/**
 * Write input data to the running terminal process.
 */
export async function terminalWrite(
  args: TerminalWriteArgs,
  invokeFn: TerminalInvokeFn = invoke
): Promise<{ ok: boolean }> {
  const payload = {
    id: args.id,
    data: args.data,
  };
  return invokeFn<{ ok: boolean }>(TERMINAL_COMMANDS.WRITE, {
    payload,
    ...payload,
  });
}

/**
 * Resize the running terminal PTY viewport.
 */
export async function terminalResize(
  args: TerminalResizeArgs,
  invokeFn: TerminalInvokeFn = invoke
): Promise<{ ok: boolean }> {
  const payload = {
    id: args.id,
    cols: args.cols,
    rows: args.rows,
  };
  return invokeFn<{ ok: boolean }>(TERMINAL_COMMANDS.RESIZE, {
    payload,
    ...payload,
  });
}

/**
 * Explicitly close and terminate the running terminal session and child processes.
 */
export async function terminalClose(
  args: TerminalCloseArgs,
  invokeFn: TerminalInvokeFn = invoke
): Promise<{ ok: boolean }> {
  const payload = {
    id: args.id,
  };
  return invokeFn<{ ok: boolean }>(TERMINAL_COMMANDS.CLOSE, {
    payload,
    ...payload,
  });
}

/**
 * Poll incremental terminal output using monotonic cursor offsets.
 */
export async function terminalPoll(
  args: TerminalPollArgs,
  invokeFn: TerminalInvokeFn = invoke
): Promise<TerminalPollResult> {
  const payload = {
    id: args.id,
    cursor: args.cursor,
    timeoutMs: args.timeoutMs,
  };
  return invokeFn<TerminalPollResult>(TERMINAL_COMMANDS.POLL, {
    payload,
    ...payload,
    timeout_ms: args.timeoutMs,
  });
}

/**
 * Retrieve active session details by session ID or directory.
 */
export async function terminalGet(
  args: TerminalGetArgs,
  invokeFn: TerminalInvokeFn = invoke
): Promise<TerminalSessionDto | null> {
  const payload = {
    id: args.id,
    cwd: args.cwd,
  };
  return invokeFn<TerminalSessionDto | null>(TERMINAL_COMMANDS.GET, {
    payload,
    ...payload,
  });
}

/**
 * List all running terminal sessions belonging to the caller.
 */
export async function terminalList(
  invokeFn: TerminalInvokeFn = invoke
): Promise<TerminalSessionDto[]> {
  return invokeFn<TerminalSessionDto[]>(TERMINAL_COMMANDS.LIST, {});
}

/**
 * Creates an authorized background poller for streaming incremental terminal output.
 * Guarantees:
 * - Single active invoke per session (no concurrent polling leaks)
 * - Stale invoke results received after stop() or UI unmount are safely discarded
 * - stop() halts polling and clears timers, but NEVER issues terminal_close
 * - Monotonic cursor tracking ensures no duplicated output across reattachments
 */
export function createTerminalPoller(options: TerminalPollerOptions): TerminalPoller {
  const invokeFn = options.invokeFn ?? invoke;
  let stopped = true;
  let inFlight = false;
  let currentCursor = options.initialCursor ?? 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      const result = await terminalPoll(
        {
          id: options.id,
          cursor: currentCursor,
          timeoutMs: options.timeoutMs ?? 15000,
        },
        invokeFn
      );

      inFlight = false;

      // Discard stale response if stopped while invoke was in flight
      if (stopped) return;

      if (result.data && result.data.length > 0) {
        options.onData?.(result.data);
      }

      currentCursor = result.cursor;

      if (!result.running) {
        stopped = true;
        options.onExit?.(result.exitCode ?? null, result.signal);
        return;
      }

      // Continue polling immediately when running
      if (!stopped) {
        scheduleNext(0);
      }
    } catch (err) {
      inFlight = false;
      if (stopped) return;

      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);

      // Back off before retrying
      if (!stopped) {
        scheduleNext(2000);
      }
    }
  };

  const scheduleNext = (delayMs: number) => {
    clearPendingTimer();
    if (stopped) return;
    timerId = setTimeout(() => {
      timerId = null;
      void tick();
    }, Math.max(0, delayMs));
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      scheduleNext(0);
    },
    stop(): void {
      stopped = true;
      clearPendingTimer();
      // Notice: stop() NEVER invokes terminal_close
    },
    isActive(): boolean {
      return !stopped;
    },
    getCursor(): number {
      return currentCursor;
    },
  };
}
