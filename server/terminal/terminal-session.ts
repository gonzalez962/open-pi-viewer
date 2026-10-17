import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import type { TerminalSessionDto } from '../../src/core/terminal';
import { BoundedBuffer } from './bounded-buffer';
import { DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_MAX_REPLAY_BYTES, resolveDefaultShell } from './types';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

export interface TerminalSessionOptions {
  cwd: string;
  canonicalCwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
  maxReplayBytes?: number;
  owner?: string;
}

export class TerminalSession {
  readonly id: string;
  readonly cwd: string;
  readonly canonicalCwd: string;
  cols: number;
  rows: number;
  pid: number;
  running: boolean;
  exitCode: number | null = null;
  exitSignal?: number;
  readonly createdAt: number;
  readonly owner?: string;

  private readonly ptyProcess: any;
  private readonly buffer: BoundedBuffer;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null, signal?: number) => void>();
  private readonly exitPromise: Promise<{ exitCode: number | null; signal?: number }>;
  private resolveExit!: (res: { exitCode: number | null; signal?: number }) => void;
  private activePolls = 0;
  private static readonly MAX_CONCURRENT_POLLS = 16;

  constructor(options: TerminalSessionOptions) {
    this.id = `term_${randomUUID()}`;
    this.cwd = options.cwd;
    this.canonicalCwd = options.canonicalCwd;
    this.cols = options.cols && options.cols > 0 ? options.cols : DEFAULT_COLS;
    this.rows = options.rows && options.rows > 0 ? options.rows : DEFAULT_ROWS;
    this.createdAt = Date.now();
    this.owner = options.owner;
    this.buffer = new BoundedBuffer(options.maxReplayBytes || DEFAULT_MAX_REPLAY_BYTES);

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    const shell = options.shell || resolveDefaultShell();

    const ptySpawn = pty.spawn || pty.default?.spawn;
    if (typeof ptySpawn !== 'function') {
      throw new Error('node-pty spawn function not found');
    }

    this.ptyProcess = ptySpawn(shell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.canonicalCwd,
      env: process.env,
    });

    this.pid = this.ptyProcess.pid || 0;
    this.running = true;

    // Swallow pipe cleanup errors (EPIPE) when terminal is terminated
    const swallow = () => {};
    if (typeof this.ptyProcess.on === 'function') {
      this.ptyProcess.on('error', swallow);
      this.ptyProcess.on('error', swallow);
    }
    if (this.ptyProcess._socket && typeof this.ptyProcess._socket.on === 'function') {
      this.ptyProcess._socket.on('error', swallow);
    }
    const agent = this.ptyProcess._agent;
    if (agent) {
      if (agent.inSocket && typeof agent.inSocket.on === 'function') {
        agent.inSocket.on('error', swallow);
      }
      if (agent._inSocket && typeof agent._inSocket.on === 'function') {
        agent._inSocket.on('error', swallow);
      }
      if (agent.outSocket && typeof agent.outSocket.on === 'function') {
        agent.outSocket.on('error', swallow);
      }
      if (agent._outSocket && typeof agent._outSocket.on === 'function') {
        agent._outSocket.on('error', swallow);
      }
    }

    this.ptyProcess.onData((data: string) => {
      this.buffer.append(data);
      for (const listener of this.dataListeners) {
        try {
          listener(data);
        } catch {
          // ignore listener errors
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.running = false;
      this.exitCode = exitCode ?? null;
      this.exitSignal = signal;
      this.resolveExit({ exitCode: this.exitCode, signal: this.exitSignal });
      for (const listener of this.exitListeners) {
        try {
          listener(this.exitCode, signal);
        } catch {
          // ignore listener errors
        }
      }
      this.cleanup();
    });
  }

  write(data: string): void {
    if (!this.running) {
      throw new Error(`Cannot write to terminated terminal session: ${this.id}`);
    }
    try {
      this.ptyProcess.write(data);
    } catch {
      // ignore write errors if socket closed
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.running) {
      throw new Error(`Cannot resize terminated terminal session: ${this.id}`);
    }
    const safeCols = Math.max(1, Math.min(cols, 1000));
    const safeRows = Math.max(1, Math.min(rows, 500));
    this.cols = safeCols;
    this.rows = safeRows;
    this.ptyProcess.resize(safeCols, safeRows);
  }

  readOutput(cursor: number = 0): { data: string; nextCursor: number } {
    return this.buffer.readFrom(cursor);
  }

  async waitForOutput(
    cursor: number = 0,
    timeoutMs: number = 0,
    signal?: AbortSignal
  ): Promise<{ data: string; nextCursor: number }> {
    const initial = this.readOutput(cursor);
    if (initial.data.length > 0 || !this.running || timeoutMs <= 0 || signal?.aborted) {
      return initial;
    }

    if (this.activePolls >= TerminalSession.MAX_CONCURRENT_POLLS) {
      throw new Error('Too many concurrent poll requests for terminal session');
    }

    this.activePolls++;

    return new Promise<{ data: string; nextCursor: number }>((resolve) => {
      let unlistenData: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      let isDone = false;

      const finish = () => {
        if (isDone) return;
        isDone = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', finish);
        if (unlistenData) {
          unlistenData();
          unlistenData = undefined;
        }
        if (unlistenExit) {
          unlistenExit();
          unlistenExit = undefined;
        }
        this.activePolls = Math.max(0, this.activePolls - 1);
        resolve(this.readOutput(cursor));
      };

      if (signal) {
        signal.addEventListener('abort', finish, { once: true });
      }

      unlistenData = this.onData(() => finish());
      unlistenExit = this.onExit(() => finish());
      timer = setTimeout(finish, timeoutMs);
    });
  }

  private forceTerminateProcess(): void {
    const pid = this.pid;
    if (!pid || pid <= 0) return;

    if (process.platform === 'win32') {
      // Execute process tree termination first so descendant processes are not orphaned
      const res = spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2000,
      });

      if (res.error) {
        throw new Error(`Failed to execute taskkill for PID ${pid}: ${res.error.message}`);
      }
      // Status 0: success, status 128: process not found (already terminated)
      if (res.status !== 0 && res.status !== 128) {
        const stderr = res.stderr ? res.stderr.toString().trim() : '';
        throw new Error(`taskkill failed for PID ${pid} with exit code ${res.status}: ${stderr}`);
      }

      // Fallback cleanup in case root process handle is still open
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    } else {
      let pgidKilled = false;
      try {
        process.kill(-pid, 'SIGKILL');
        pgidKilled = true;
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err: any) {
        if (!pgidKilled && err?.code !== 'ESRCH') {
          throw new Error(`Failed to kill process PID ${pid}: ${err?.message || String(err)}`);
        }
      }
    }
  }

  async kill(signal?: string, timeoutMs = 3000): Promise<{ exitCode: number | null; signal?: number }> {
    if (!this.running) {
      return { exitCode: this.exitCode, signal: this.exitSignal };
    }

    // On Windows ConPTY, node-pty's kill agent attempts AttachConsole and can block 5s.
    // Terminating the process tree directly with taskkill/SIGKILL avoids this hang cleanly.
    if (process.platform === 'win32') {
      if (this.ptyProcess) {
        try { this.ptyProcess._deferreds = []; } catch {}
        try { this.ptyProcess._doWrite = () => {}; } catch {}
        try { this.ptyProcess.write = () => {}; } catch {}
        try { this.ptyProcess._write = () => {}; } catch {}
      }
      this.forceTerminateProcess();
      const agent = this.ptyProcess?._agent;
      const swallow = () => {};
      if (agent) {
        if (agent._conoutSocketWorker?._worker) {
          try { void agent._conoutSocketWorker._worker.terminate(); } catch {}
        }
        try { agent.inSocket?.on('error', swallow); } catch {}
        try { agent._inSocket?.on('error', swallow); } catch {}
        try { agent.outSocket?.on('error', swallow); } catch {}
        try { agent._outSocket?.on('error', swallow); } catch {}
        try { agent._inSocket?.destroy(); } catch {}
        try { agent._outSocket?.destroy(); } catch {}
        if (agent._ptyNative && agent._pty !== undefined) {
          try { agent._ptyNative.kill(agent._pty, agent._useConptyDll); } catch {}
        }
      }
      try { this.ptyProcess?._socket?.on('error', swallow); } catch {}
      try { this.ptyProcess?._socket?.destroy(); } catch {}
      try { this.ptyProcess?._close?.(); } catch {}
      this.running = false;
      this.exitCode = this.exitCode ?? 0;
      this.resolveExit({ exitCode: this.exitCode, signal: this.exitSignal });
    } else {
      try {
        process.kill(-this.pid, (signal as NodeJS.Signals) || 'SIGHUP');
      } catch {}
      try {
        this.ptyProcess.kill(signal);
      } catch {}
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ timedOut: boolean; exitCode: number | null; signal?: number }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, exitCode: null, signal: undefined }), timeoutMs);
    });

    const outcome = await Promise.race([
      this.exitPromise.then((res) => ({ timedOut: false, ...res })),
      timeoutPromise,
    ]);

    if (timer) clearTimeout(timer);

    if (outcome.timedOut) {
      this.forceTerminateProcess();
      this.running = false;
      this.exitCode = this.exitCode ?? -1;
    }

    // Bounded wait on Windows to ensure OS process handle is fully released
    if (this.pid > 0) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 500) {
        try {
          process.kill(this.pid, 0);
          await new Promise((r) => setTimeout(r, 25));
        } catch {
          break;
        }
      }
    }

    this.cleanup();
    return { exitCode: this.exitCode, signal: this.exitSignal };
  }

  private cleanup(): void {
    this.running = false;
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  getReplay(): string {
    return this.buffer.toString();
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null, signal?: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  toDto(includeReplay = false): TerminalSessionDto {
    return {
      id: this.id,
      cwd: this.cwd,
      canonicalCwd: this.canonicalCwd,
      cols: this.cols,
      rows: this.rows,
      pid: this.pid,
      running: this.running,
      createdAt: this.createdAt,
      replay: includeReplay ? this.getReplay() : undefined,
      cursor: this.buffer.getHeadCursor(),
    };
  }
}
