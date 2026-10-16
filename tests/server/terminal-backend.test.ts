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

test('S1.1: Given project A, when its terminal opens and executes a cwd command, then output identifies A\'s working directory', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  t.after(() => manager.dispose());

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s11-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

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
  t.after(() => manager.dispose());

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s12-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s12-b-'));
  t.after(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
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
  t.after(() => manager.dispose());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s31-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const session1 = await manager.openSession({ cwd: dir });
  const marker = 'PERSIST_SESSION_' + Date.now();
  manager.writeSession({ id: session1.id, data: `echo ${marker}\r\n` });

  await waitFor(() => session1.replay?.includes(marker) || manager.getSession(session1.id)?.replay?.includes(marker) || false, 5000);

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
  t.after(() => manager.dispose());

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s32-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s32-b-'));
  t.after(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
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
  t.after(() => manager.dispose());

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s33-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-s33-b-'));
  t.after(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  const sessionA = await manager.openSession({ cwd: dirA });
  const sessionB = await manager.openSession({ cwd: dirB });

  // Explicit close of A
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

test('PRESERVE: terminal operations reject unknown session ids without spawning new sessions', async (t) => {
  const { createTerminalManager } = await import('@server/terminal/terminal-manager');
  const manager = createTerminalManager();
  t.after(() => manager.dispose());

  assert.throws(() => {
    manager.writeSession({ id: 'non-existent-session-id', data: 'ls\r\n' });
  }, /not found/i);

  assert.throws(() => {
    manager.resizeSession({ id: 'non-existent-session-id', cols: 120, rows: 40 });
  }, /not found/i);

  await assert.rejects(async () => {
    await manager.closeSession({ id: 'non-existent-session-id' });
  }, /not found/i);

  assert.strictEqual(manager.listSessions().length, 0, 'No sessions should be created for invalid ids');
});
