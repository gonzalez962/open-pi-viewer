import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createTerminalManager } from '@server/terminal/terminal-manager';
import { installWebApi, type Middleware, type MiddlewareApp } from '@server/web-api';
import { TERMINAL_COMMANDS } from '@core/terminal';

function createMiddlewareApp() {
  const handlers: Array<{ route: string; handler: Middleware }> = [];
  const app: MiddlewareApp = {
    use(routeOrHandler: string | Middleware, handler?: Middleware) {
      handlers.push(
        typeof routeOrHandler === 'string'
          ? { route: routeOrHandler, handler: handler! }
          : { route: '', handler: routeOrHandler }
      );
    },
  };
  const dispatch = (req: http.IncomingMessage, res: http.ServerResponse, fallback: () => void) => {
    let index = 0;
    const next = (error?: unknown) => {
      if (error) {
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal server error');
        return;
      }
      if (res.writableEnded) return;
      const item = handlers[index++];
      if (!item) {
        fallback();
        return;
      }
      const url = req.url || '/';
      const pathname = url.split('?')[0];
      if (item.route && pathname !== item.route && !pathname.startsWith(`${item.route}/`)) {
        next();
        return;
      }
      if (item.route) req.url = url.slice(item.route.length) || '/';
      let continued = false;
      const advance = (err?: unknown) => {
        if (continued) return;
        continued = true;
        req.url = url;
        next(err);
      };
      try {
        const result = item.handler(req, res, advance);
        if (result && typeof (result as any).catch === 'function') {
          void (result as any).catch(advance);
        }
      } catch (err) {
        advance(err);
      }
    };
    next();
  };
  return { app, dispatch };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessForcibly(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 2000,
      });
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function getDescendantPids(rootPid: number): number[] {
  if (process.platform === 'win32') {
    const res = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return [];
    try {
      const parsed = JSON.parse(res.stdout);
      const procs: Array<{ ProcessId: number; ParentProcessId: number }> = Array.isArray(parsed) ? parsed : [parsed];
      const childrenMap = new Map<number, number[]>();
      for (const p of procs) {
        if (!childrenMap.has(p.ParentProcessId)) {
          childrenMap.set(p.ParentProcessId, []);
        }
        childrenMap.get(p.ParentProcessId)!.push(p.ProcessId);
      }
      const descendants: number[] = [];
      const queue = [rootPid];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        const children = childrenMap.get(parent) || [];
        for (const child of children) {
          descendants.push(child);
          queue.push(child);
        }
      }
      return descendants;
    } catch {
      return [];
    }
  } else {
    try {
      const res = spawnSync('ps', ['-A', '-o', 'pid,ppid'], { encoding: 'utf8', timeout: 5000 });
      if (res.status !== 0 || !res.stdout) return [];
      const lines = res.stdout.trim().split('\n').slice(1);
      const procs = lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        return { ProcessId: parseInt(parts[0], 10), ParentProcessId: parseInt(parts[1], 10) };
      }).filter((p) => !isNaN(p.ProcessId) && !isNaN(p.ParentProcessId));
      const childrenMap = new Map<number, number[]>();
      for (const p of procs) {
        if (!childrenMap.has(p.ParentProcessId)) {
          childrenMap.set(p.ParentProcessId, []);
        }
        childrenMap.get(p.ParentProcessId)!.push(p.ProcessId);
      }
      const descendants: number[] = [];
      const queue = [rootPid];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        const children = childrenMap.get(parent) || [];
        for (const child of children) {
          descendants.push(child);
          queue.push(child);
        }
      }
      return descendants;
    } catch {
      return [];
    }
  }
}

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

test('Regression: Terminal manager closeSession terminates descendant process tree and does not orphan children', async (t) => {
  const manager = createTerminalManager();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-reg-tree-'));
  const trackedPids: number[] = [];

  t.after(async () => {
    // Ensure all spawned PIDs are cleaned on any test outcome
    for (const pid of trackedPids) {
      if (isProcessAlive(pid)) {
        killProcessForcibly(pid);
      }
    }
    await manager.dispose();
    await safeRmDir(fixtureDir);
  });

  const session = await manager.openSession({ cwd: fixtureDir });
  assert.ok(session.pid > 0, 'Session must have a valid PID');
  trackedPids.push(session.pid);

  // Write a script that spawns a detached grandchild process to form a deep tree
  const scriptPath = path.join(fixtureDir, 'worker.js');
  fs.writeFileSync(
    scriptPath,
    'const { spawn } = require("child_process"); const sub = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { detached: true, stdio: "ignore" }); sub.unref(); setInterval(()=>{}, 1000);'
  );

  const launchCmd = process.platform === 'win32' ? 'node worker.js\r\n' : 'node worker.js\n';
  manager.writeSession({ id: session.id, data: launchCmd });

  // Wait for descendants to appear and assert they are nonempty
  let descendants: number[] = [];
  await waitFor(() => {
    descendants = getDescendantPids(session.pid);
    return descendants.length >= 2;
  }, 5000);
  t.diagnostic(`Discovered descendants for PID ${session.pid}: ${JSON.stringify(descendants)}`);


  assert.ok(descendants.length > 0, 'Descendants must be nonempty before termination');
  for (const pid of descendants) {
    trackedPids.push(pid);
  }

  // Close session - must terminate root and all descendants
  await manager.closeSession({ id: session.id });

  // Wait with deadline for all descendants to terminate
  const startWait = Date.now();
  let aliveDescendants = descendants.filter((pid) => isProcessAlive(pid));
  while (aliveDescendants.length > 0 && Date.now() - startWait < 4000) {
    await new Promise((r) => setTimeout(r, 100));
    aliveDescendants = descendants.filter((pid) => isProcessAlive(pid));
  }

  assert.deepStrictEqual(
    aliveDescendants,
    [],
    `All descendant processes must be terminated. Still alive: ${aliveDescendants.join(', ')}`
  );
  assert.strictEqual(isProcessAlive(session.pid), false, 'Root shell process must be terminated');
});

test('Regression: Web API terminal poll stays pending without data, cancels on disconnect, and permits subsequent polls', async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-reg-poll-'));
  const { app, dispatch } = createMiddlewareApp();
  const server = http.createServer((req, res) => {
    dispatch(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  installWebApi(app, server, { enabled: false });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as { port: number };
  const port = addr.port;

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await safeRmDir(fixtureDir);
  });

  const sendIpc = (cmd: string, args: any = {}): Promise<{ status: number; body: any }> => {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ cmd, args });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/ipc',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode || 200, body: JSON.parse(data || '{}') });
            } catch {
              resolve({ status: res.statusCode || 200, body: data });
            }
          });
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  };

  // 1. Open a terminal session via real HTTP endpoint
  const openRes = await sendIpc(TERMINAL_COMMANDS.OPEN, { cwd: fixtureDir });
  assert.strictEqual(openRes.status, 200);
  assert.ok(openRes.body.result?.id, 'Session must have an ID');
  const sessionId = openRes.body.result.id;
  const initialCursor = openRes.body.result.cursor || 0;

  // Drain any initial shell banner output
  await new Promise((r) => setTimeout(r, 300));
  const drainRes = await sendIpc(TERMINAL_COMMANDS.POLL, { id: sessionId, cursor: initialCursor, timeoutMs: 0 });
  const activeCursor = drainRes.body.result?.cursor ?? initialCursor;

  // 2. Poll without new data: MUST stay pending, NOT return in <100ms
  const startPollTime = Date.now();
  const pollPromise = sendIpc(TERMINAL_COMMANDS.POLL, { id: sessionId, cursor: activeCursor, timeoutMs: 800 });

  // Check after 200ms that the poll is STILL pending (has not returned prematurely in 6ms due to req.close)
  let pollCompletedEarly = false;
  pollPromise.then(() => {
    pollCompletedEarly = true;
  });

  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(
    pollCompletedEarly,
    false,
    'Poll without new data must stay pending and not abort prematurely in <200ms'
  );

  const pollRes = await pollPromise;
  const elapsed = Date.now() - startPollTime;
  assert.ok(elapsed >= 700, `Poll must wait for timeoutMs (expected >=700ms, took ${elapsed}ms)`);
  assert.strictEqual(pollRes.body.result?.data, '', 'Poll with no data should return empty data on timeout');

  // 3. Client disconnect: start a long poll (timeout 5000ms), then abort client connection after 100ms
  const disconnectPostData = JSON.stringify({
    cmd: TERMINAL_COMMANDS.POLL,
    args: { id: sessionId, cursor: activeCursor, timeoutMs: 5000 },
  });
  const clientReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/api/ipc',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(disconnectPostData),
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    },
  });
  // Swallow expected client abort socket error
  clientReq.on('error', () => {});
  clientReq.write(disconnectPostData);
  clientReq.end();

  // Wait 100ms while poll is waiting, then disconnect
  await new Promise((r) => setTimeout(r, 100));
  clientReq.destroy();

  // Wait 100ms for server to process disconnect and release poll slot
  await new Promise((r) => setTimeout(r, 100));

  // 4. Verify no leaked poll slots: subsequent poll succeeds immediately
  const afterDisconnectPoll = await sendIpc(TERMINAL_COMMANDS.POLL, {
    id: sessionId,
    cursor: activeCursor,
    timeoutMs: 0,
  });
  assert.strictEqual(afterDisconnectPoll.status, 200);
  assert.strictEqual(afterDisconnectPoll.body.result?.id, sessionId);
  assert.strictEqual(typeof afterDisconnectPoll.body.error, 'undefined', 'Subsequent poll must not error');

  // Clean up terminal session
  await sendIpc(TERMINAL_COMMANDS.CLOSE, { id: sessionId });
});
