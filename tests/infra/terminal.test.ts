import test from 'node:test';
import assert from 'node:assert/strict';
import {
  terminalOpen,
  terminalWrite,
  terminalResize,
  terminalClose,
  terminalPoll,
  terminalGet,
  terminalList,
  createTerminalPoller,
} from '../../src/infra/terminal';
import type {
  TerminalSessionDto,
  TerminalPollResult,
} from '../../src/core/terminal';

test('S4.1: terminalOpen sends command with payload and args wrapper and returns session DTO', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const fakeSession: TerminalSessionDto = {
    id: 'term-proj-1',
    cwd: 'C:\\projects\\app1',
    canonicalCwd: 'C:\\projects\\app1',
    cols: 80,
    rows: 24,
    pid: 1234,
    running: true,
    createdAt: Date.now(),
    replay: 'Welcome to project 1\r\n',
    cursor: 23,
  };

  const fakeInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return fakeSession as unknown as T;
  };

  const result = await terminalOpen(
    { cwd: 'C:\\projects\\app1', cols: 80, rows: 24 },
    fakeInvoke
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'terminal_open');
  // Must provide payload wrapper for native Tauri (commands/terminal.rs) and flat args for web IPC
  const args = calls[0].args as any;
  assert.ok(args?.payload, 'must include payload wrapper for native Rust command deserializer');
  assert.equal(args.payload.cwd, 'C:\\projects\\app1');
  assert.equal(args.payload.cols, 80);
  assert.equal(args.payload.rows, 24);
  assert.equal(args.cwd, 'C:\\projects\\app1');
  assert.equal(result.id, 'term-proj-1');
  assert.equal(result.pid, 1234);
  assert.equal(result.running, true);
});

test('S4.1: terminalWrite, terminalResize, terminalClose send commands with payload wrappers', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const fakeInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return { ok: true } as unknown as T;
  };

  await terminalWrite({ id: 'term-1', data: 'ls -la\n' }, fakeInvoke);
  assert.equal(calls[0].cmd, 'terminal_write');
  assert.equal((calls[0].args as any).payload.id, 'term-1');
  assert.equal((calls[0].args as any).payload.data, 'ls -la\n');

  await terminalResize({ id: 'term-1', cols: 120, rows: 40 }, fakeInvoke);
  assert.equal(calls[1].cmd, 'terminal_resize');
  assert.equal((calls[1].args as any).payload.cols, 120);
  assert.equal((calls[1].args as any).payload.rows, 40);

  await terminalClose({ id: 'term-1' }, fakeInvoke);
  assert.equal(calls[2].cmd, 'terminal_close');
  assert.equal((calls[2].args as any).payload.id, 'term-1');
});

test('S4.1: terminalGet and terminalList query active session status', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const fakeInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === 'terminal_get') {
      return { id: 'term-1', cwd: '/app', canonicalCwd: '/app', pid: 10, running: true, cols: 80, rows: 24, createdAt: 1 } as unknown as T;
    }
    return [] as unknown as T;
  };

  const session = await terminalGet({ cwd: '/app' }, fakeInvoke);
  assert.equal(calls[0].cmd, 'terminal_get');
  assert.equal(session?.id, 'term-1');

  const list = await terminalList(fakeInvoke);
  assert.equal(calls[1].cmd, 'terminal_list');
  assert.deepEqual(list, []);
});

test('S4.1: invoke error propagation surfaces structured Error without swallowing', async () => {
  const failingInvoke = async () => {
    throw new Error('403 Forbidden: cross-origin terminal access rejected');
  };

  await assert.rejects(
    async () => {
      await terminalOpen({ cwd: '/unauthorized' }, failingInvoke);
    },
    { message: /403 Forbidden/ }
  );
});

test('S4.2: TerminalPoller enforces single active invoke per session (no concurrent polling leak)', async () => {
  let activeInvokes = 0;
  let maxConcurrentInvokes = 0;
  let pollCount = 0;

  const slowInvoke = async <T>(cmd: string, _args?: Record<string, unknown>): Promise<T> => {
    if (cmd === 'terminal_poll') {
      activeInvokes++;
      if (activeInvokes > maxConcurrentInvokes) {
        maxConcurrentInvokes = activeInvokes;
      }
      pollCount++;
      // Simulate network / native delay
      await new Promise((r) => setTimeout(r, 20));
      activeInvokes--;
      return {
        id: 'term-concur',
        data: `chunk-${pollCount}`,
        cursor: pollCount * 10,
        running: true,
      } as unknown as T;
    }
    return { ok: true } as unknown as T;
  };

  const poller = createTerminalPoller({
    id: 'term-concur',
    initialCursor: 0,
    timeoutMs: 100,
    invokeFn: slowInvoke,
  });

  poller.start();
  // Attempt concurrent start / ticks
  poller.start();

  await new Promise((r) => setTimeout(r, 60));
  poller.stop();

  assert.equal(maxConcurrentInvokes, 1, 'there must never be more than one active poll invoke at a time');
});

test('S4.2: TerminalPoller ignores stale native long-poll results after stop()', async () => {
  const receivedData: string[] = [];
  let finishPendingPoll: ((res: TerminalPollResult) => void) | null = null;

  const delayedInvoke = async <T>(_cmd: string): Promise<T> => {
    return new Promise<TerminalPollResult>((resolve) => {
      finishPendingPoll = resolve;
    }) as unknown as T;
  };

  const poller = createTerminalPoller({
    id: 'term-stale',
    initialCursor: 0,
    onData: (data) => receivedData.push(data),
    invokeFn: delayedInvoke,
  });

  poller.start();
  assert.equal(poller.isActive(), true);

  // Stop poller while invoke is still in-flight
  poller.stop();
  assert.equal(poller.isActive(), false);

  // In-flight invoke finishes after unmount/stop
  if (finishPendingPoll) {
    (finishPendingPoll as (res: TerminalPollResult) => void)({
      id: 'term-stale',
      data: 'stale-data-should-be-ignored',
      cursor: 100,
      running: true,
    });
  }

  // Yield to allow any resolution handlers to run
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(receivedData, [], 'stale poll output returned after stop must be discarded');
});

test('S3.1: TerminalPoller stop() cancels polling and timers but NEVER calls terminal_close', async () => {
  const calls: string[] = [];
  const fakeInvoke = async <T>(cmd: string): Promise<T> => {
    calls.push(cmd);
    return {
      id: 'term-safe-stop',
      data: '',
      cursor: 0,
      running: true,
    } as unknown as T;
  };

  const poller = createTerminalPoller({
    id: 'term-safe-stop',
    initialCursor: 0,
    invokeFn: fakeInvoke,
  });

  poller.start();
  await new Promise((r) => setTimeout(r, 15));
  poller.stop();

  assert.ok(calls.includes('terminal_poll'));
  assert.equal(calls.includes('terminal_close'), false, 'stop() must NEVER invoke terminal_close');
});

test('S3.1: Monotonic cursor management advances without duplicate data replay', async () => {
  const chunks: string[] = [];
  let pollStep = 0;

  const mockStreamInvoke = async <T>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
    pollStep++;
    const reqCursor = (args as any)?.payload?.cursor ?? (args as any)?.cursor ?? 0;
    if (pollStep === 1) {
      assert.equal(reqCursor, 50, 'initial poll must start from provided initialCursor');
      return {
        id: 'term-cursor',
        data: 'output-1;',
        cursor: 59,
        running: true,
      } as unknown as T;
    }
    assert.equal(reqCursor, 59, 'subsequent poll must use advanced monotonic cursor');
    return {
      id: 'term-cursor',
      data: 'output-2;',
      cursor: 68,
      running: true,
    } as unknown as T;
  };

  const poller = createTerminalPoller({
    id: 'term-cursor',
    initialCursor: 50,
    onData: (d) => chunks.push(d),
    invokeFn: mockStreamInvoke,
  });

  poller.start();
  await new Promise((r) => setTimeout(r, 30));
  poller.stop();

  assert.equal(poller.getCursor(), 68);
  assert.deepEqual(chunks, ['output-1;', 'output-2;']);
});

test('Natural exit: when poll returns running=false, reports exitCode and halts polling', async () => {
  let exitResult: { exitCode: number | null; signal?: number } | null = null;

  const exitInvoke = async <T>(_cmd: string): Promise<T> => {
    return {
      id: 'term-exit',
      data: 'logout\r\n',
      cursor: 10,
      running: false,
      exitCode: 0,
    } as unknown as T;
  };

  const poller = createTerminalPoller({
    id: 'term-exit',
    initialCursor: 0,
    onExit: (exitCode, signal) => {
      exitResult = { exitCode, signal };
    },
    invokeFn: exitInvoke,
  });

  poller.start();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(poller.isActive(), false, 'poller must stop after process exits naturally');
  assert.deepEqual(exitResult, { exitCode: 0, signal: undefined });
});
