import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function safeRmDir(dir: string, retries = 15, delayMs = 100): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

test('S1.1: Given project A, when its terminal opens and executes a cwd command, then output identifies A\'s working directory', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s11-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(fixtureDir);
  });

  const session = await manager.openSession({ cwd: fixtureDir });
  assert.ok(session.id);
  assert.strictEqual(session.running, true);
  assert.ok(session.pid > 0);

  let output = '';
  manager.onSessionData(session.id, (data: string) => {
    output += data;
  });

  const cwdCmd = process.platform === 'win32' ? 'cd\r\n' : 'pwd\r\n';
  manager.writeSession({ id: session.id, data: cwdCmd });

  const canonical = fs.realpathSync.native(fixtureDir);
  await waitFor(
    () =>
      output.toLowerCase().includes(canonical.toLowerCase()) ||
      output.toLowerCase().includes(fixtureDir.toLowerCase()),
    5000
  );

  assert.ok(
    output.toLowerCase().includes(canonical.toLowerCase()) ||
      output.toLowerCase().includes(fixtureDir.toLowerCase()),
    `Output must identify working directory. Got: ${output}`
  );
});

test('S1.2: Given running terminals for projects A and B, when input is sent to A, then only A receives the command and B\'s process remains independent', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s12-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s12-b-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dirA);
    await safeRmDir(dirB);
  });

  const sessionA = await manager.openSession({ cwd: dirA });
  const sessionB = await manager.openSession({ cwd: dirB });

  assert.notStrictEqual(sessionA.id, sessionB.id);
  assert.notStrictEqual(sessionA.pid, sessionB.pid);

  let outputA = '';
  let outputB = '';
  manager.onSessionData(sessionA.id, (d: string) => {
    outputA += d;
  });
  manager.onSessionData(sessionB.id, (d: string) => {
    outputB += d;
  });

  const markerA = 'MARKER_AAA_' + Date.now();
  manager.writeSession({ id: sessionA.id, data: `echo ${markerA}\r\n` });

  await waitFor(() => outputA.includes(markerA), 5000);
  assert.ok(outputA.includes(markerA), 'Terminal A must receive command');

  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!outputB.includes(markerA), 'Terminal B must not receive input sent to A');
});

test('S3.1: Given a running terminal, when minimized and reopened, then the same process and output remain available', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s31-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dir);
  });

  const session1 = await manager.openSession({ cwd: dir });
  const marker = 'PERSIST_SESSION_' + Date.now();
  manager.writeSession({ id: session1.id, data: `echo ${marker}\r\n` });

  // Await updated buffer from manager instead of checking stale initial DTO
  await waitFor(() => manager.getSession(session1.id)?.replay?.includes(marker) ?? false, 5000);

  // Simulate minimize and reopen by calling openSession for the same directory
  const session2 = await manager.openSession({ cwd: dir });

  assert.strictEqual(session2.id, session1.id, 'Session ID must remain identical on reopen');
  assert.strictEqual(session2.pid, session1.pid, 'Process PID must remain identical on reopen');
  assert.strictEqual(session2.running, true, 'Process must still be running');
  assert.ok(session2.replay?.includes(marker), 'Buffered output must remain available');
});

test('S3.2: Given terminals A and B, when switching projects or disconnecting and reconnecting a client, then both processes survive and reattachment restores the selected terminal\'s buffered output', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s32-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s32-b-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dirA);
    await safeRmDir(dirB);
  });

  const sessionA = await manager.openSession({ cwd: dirA });
  const sessionB = await manager.openSession({ cwd: dirB });

  const markerA = 'DATA_A_' + Date.now();
  const markerB = 'DATA_B_' + Date.now();
  manager.writeSession({ id: sessionA.id, data: `echo ${markerA}\r\n` });
  manager.writeSession({ id: sessionB.id, data: `echo ${markerB}\r\n` });

  await waitFor(
    () =>
      (manager.getSession(sessionA.id)?.replay?.includes(markerA) ?? false) &&
      (manager.getSession(sessionB.id)?.replay?.includes(markerB) ?? false),
    5000
  );

  // Client disconnects and reattaches to A
  const reattachA = await manager.openSession({ cwd: dirA });
  assert.strictEqual(reattachA.id, sessionA.id);
  assert.strictEqual(reattachA.pid, sessionA.pid);
  assert.ok(reattachA.replay?.includes(markerA), 'Reattachment to A restores buffered output');

  // Switch to B
  const reattachB = await manager.openSession({ cwd: dirB });
  assert.strictEqual(reattachB.id, sessionB.id);
  assert.strictEqual(reattachB.pid, sessionB.pid);
  assert.ok(reattachB.replay?.includes(markerB), 'Reattachment to B restores buffered output');
});

test('S3.3: Given terminals A and B, when the user confirms closing A, then A terminates, B remains live, and reopening A creates a new session', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s33-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s33-b-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dirA);
    await safeRmDir(dirB);
  });

  const sessionA = await manager.openSession({ cwd: dirA });
  const sessionB = await manager.openSession({ cwd: dirB });

  // Explicit close of A awaits process exit
  await manager.closeSession({ id: sessionA.id });

  assert.strictEqual(manager.getSession(sessionA.id), null, 'Terminated session A must be removed');

  // Terminal B remains live
  const activeB = manager.getSession(sessionB.id);
  assert.ok(activeB, 'Session B must remain active');
  assert.strictEqual(activeB.running, true);

  const markerB = 'ALIVE_B_' + Date.now();
  manager.writeSession({ id: sessionB.id, data: `echo ${markerB}\r\n` });
  await waitFor(() => manager.getSession(sessionB.id)?.replay?.includes(markerB) ?? false, 5000);

  // Reopening A creates a brand new session
  const newSessionA = await manager.openSession({ cwd: dirA });
  assert.notStrictEqual(newSessionA.id, sessionA.id, 'New session A must have a new id');
  assert.notStrictEqual(newSessionA.pid, sessionA.pid, 'New session A must have a new pid');
  assert.strictEqual(newSessionA.running, true);
});

test('S4.1: Dedicated authorized poll transport returns incremental data and tracks cursor progression', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-poll-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dir);
  });

  const session = await manager.openSession({ cwd: dir });
  const marker = 'POLL_TEST_' + Date.now();
  manager.writeSession({ id: session.id, data: `echo ${marker}\r\n` });

  // Initial poll with cursor 0
  await waitFor(() => manager.getSession(session.id)?.replay?.includes(marker) ?? false, 5000);
  const poll1 = await manager.pollSession({ id: session.id, cursor: 0, timeoutMs: 2000 });
  assert.strictEqual(poll1.id, session.id);
  assert.ok(poll1.data.includes(marker), `Poll output must include marker. Got: ${poll1.data}`);
  assert.ok(poll1.cursor > 0, 'Cursor must advance');

  // Next poll from advanced cursor returns incremental output without assuming shell silence
  const poll2 = await manager.pollSession({ id: session.id, cursor: poll1.cursor, timeoutMs: 50 });
  const transcriptAfterPoll2 = manager.getSession(session.id)?.replay ?? '';
  assert.ok(poll2.cursor >= poll1.cursor, 'Cursor must advance monotonically from previous position');
  assert.strictEqual(
    poll2.cursor,
    poll1.cursor + poll2.data.length,
    'Cursor must equal previous cursor plus incremental data length'
  );
  assert.strictEqual(
    poll2.data,
    transcriptAfterPoll2.slice(poll1.cursor, poll2.cursor),
    'Incremental poll data must match slice of recorded transcript'
  );
  assert.ok(
    !poll2.data.includes(marker),
    'Poll from advanced cursor must not duplicate already-delivered marker'
  );
  assert.strictEqual(
    poll1.data + poll2.data,
    transcriptAfterPoll2.slice(0, poll2.cursor),
    'Cumulative poll output must match recorded transcript up to current cursor'
  );

  // New write must be captured incrementally from previous cursor
  const marker2 = 'POLL_INCREMENTAL_' + Date.now();
  manager.writeSession({ id: session.id, data: `echo ${marker2}\r\n` });
  const poll3 = await manager.pollSession({ id: session.id, cursor: poll2.cursor, timeoutMs: 4000 });
  const transcriptAfterPoll3 = manager.getSession(session.id)?.replay ?? '';
  assert.ok(poll3.data.includes(marker2), 'Incremental poll must contain new data');
  assert.ok(
    !poll3.data.includes(marker),
    'Incremental poll must not duplicate first marker'
  );
  assert.ok(poll3.cursor > poll2.cursor, 'Cursor must advance past previous cursor on new output');
  assert.strictEqual(
    poll3.cursor,
    poll2.cursor + poll3.data.length,
    'Cursor must advance by length of new data'
  );
  assert.strictEqual(
    poll3.data,
    transcriptAfterPoll3.slice(poll2.cursor, poll3.cursor),
    'Poll data must match slice of recorded transcript'
  );
  assert.strictEqual(
    poll1.data + poll2.data + poll3.data,
    transcriptAfterPoll3.slice(0, poll3.cursor),
    'Cumulative output across all polls must match recorded transcript up to cursor'
  );
});

test('S4.1: Initial open returns absolute buffer cursor to avoid duplicated replay on poll', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-cursor-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dir);
  });

  const session1 = await manager.openSession({ cwd: dir });
  const marker = 'CURSOR_DEDUP_' + Date.now();
  manager.writeSession({ id: session1.id, data: `echo ${marker}\r\n` });
  await waitFor(() => manager.getSession(session1.id)?.replay?.includes(marker) ?? false, 5000);

  // Reopening existing session returns updated cursor matching replay
  const session2 = await manager.openSession({ cwd: dir });
  assert.strictEqual(typeof session2.cursor, 'number', 'openSession must return absolute head cursor');
  assert.ok(session2.cursor! > 0);
  assert.ok(session2.replay?.includes(marker));

  // Polling with that cursor immediately must NOT contain already replayed marker
  const poll = await manager.pollSession({ id: session2.id, cursor: session2.cursor, timeoutMs: 50 });
  assert.ok(!poll.data.includes(marker), 'Polling with reattachment cursor must not duplicate replay');
  assert.strictEqual(poll.cursor, session2.cursor);
});

test('S4.1: Long poll aborts immediately when signal is cancelled', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-abort-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dir);
  });

  const session = await manager.openSession({ cwd: dir });
  // Read up to current head cursor so no new data is pending
  const initial = await manager.pollSession({ id: session.id, cursor: 0, timeoutMs: 1000 });
  const headCursor = initial.cursor;

  const ac = new AbortController();
  const start = Date.now();
  const pollPromise = manager.pollSession(
    { id: session.id, cursor: headCursor, timeoutMs: 10000 },
    undefined,
    ac.signal
  );

  setTimeout(() => ac.abort(), 100);
  const result = await pollPromise;
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `Long poll should abort within 2s, took ${elapsed}ms`);
  assert.strictEqual(result.id, session.id);
});

test('S1.1: Terminal open ignores arbitrary shell / shellArgs payload to enforce platform default shell', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-shell-'));
  t.after(async () => {
    await manager.dispose();
    await safeRmDir(dir);
  });

  // Attempt to pass arbitrary shell executable
  const maliciousArgs = {
    cwd: dir,
    shell: 'malicious_executable_xyz_never_exist',
    shellArgs: ['--exploit'],
  } as any;

  const session = await manager.openSession(maliciousArgs);
  assert.ok(session.running, 'Session must open using platform default shell despite malicious shell args');
});

test('PRESERVE: terminal operations reject unknown session ids and invalid arguments without spawning new sessions', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  t.after(async () => {
    await manager.dispose();
  });

  assert.throws(() => {
    manager.writeSession({ id: 'non-existent-session-id', data: 'ls\r\n' });
  }, /not found/i);

  assert.throws(() => {
    manager.resizeSession({ id: 'non-existent-session-id', cols: 120, rows: 40 });
  }, /not found/i);

  await assert.rejects(async () => {
    await manager.closeSession({ id: 'non-existent-session-id' });
  }, /not found/i);

  await assert.rejects(async () => {
    await manager.pollSession({ id: 'non-existent-session-id' });
  }, /not found/i);

  assert.throws(() => {
    manager.writeSession({ id: '', data: 'test' });
  }, /required/i);

  assert.strictEqual(manager.listSessions().length, 0, 'No sessions should be created for invalid ids');
});
