import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getBridgeConfig, getAgnosticExecEnv } from '../config';
import { broadcastSse } from './sse';
import { resolveCrossPlatformCwd } from './paths';
import {
  setSessionStatus,
  invalidateSessionParseCache,
  sessionStatusMap,
  getSubprocessSpawner,
  setSessionAliveChecker,
  getActiveCwd,
  getActiveSessionFile,
  setActiveSessionFile,
  getActiveSessionId,
  setActiveSessionId,
} from './state';

export class PiRpcSession {
  private child: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timer: any }>();
  private stdoutBuffer = '';
  public cwd: string = getBridgeConfig().baseWorkspace || process.cwd();
  public sessionFile: string | null = null;
  public sessionId: string | null = null;
  public modelInfo: any = null;

  public isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  public kill() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`Subprocess terminated for request ${id}`));
    }
    this.pending.clear();
  }

  public async ensureRunning(cwd: string, sessionFile?: string | null): Promise<void> {
    const resolvedCwd = resolveCrossPlatformCwd(cwd);
    if (this.isAlive() && this.cwd === resolvedCwd && (sessionFile ? this.sessionFile === sessionFile : true)) {
      return;
    }

    this.kill();
    this.cwd = resolvedCwd;
    this.sessionFile = sessionFile || null;

    const cfg = getBridgeConfig();
    const nodePath = cfg.nodeExecutable;
    const entrypoint = cfg.piCliPath;

    let childProc: ChildProcess | null = null;
    const env = getAgnosticExecEnv();
    const customSpawner = getSubprocessSpawner();

    if (customSpawner) {
      const args = ['--mode', 'rpc', '--approve'];
      if (this.sessionFile && fs.existsSync(this.sessionFile)) {
        args.push('--session', this.sessionFile);
      }
      try {
        childProc = customSpawner(nodePath, args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } catch (err) {
        console.warn('[Pi RPC spawn error]:', err);
        childProc = null;
      }
    } else if (entrypoint && fs.existsSync(entrypoint)) {
      const args = [entrypoint, '--mode', 'rpc', '--approve'];
      if (this.sessionFile && fs.existsSync(this.sessionFile)) {
        args.push('--session', this.sessionFile);
      }
      try {
        childProc = spawn(nodePath, args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } catch (err) {
        console.warn('[Pi RPC spawn error]:', err);
        childProc = null;
      }
    } else {
      const args = ['--mode', 'rpc', '--approve'];
      if (this.sessionFile && fs.existsSync(this.sessionFile)) {
        args.push('--session', this.sessionFile);
      }
      try {
        childProc = spawn('pi', args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          env,
        });
      } catch (err) {
        console.warn('[Pi RPC spawn error]:', err);
        childProc = null;
      }
    }

    if (!childProc) {
      this.child = null;
      return;
    }
    this.child = childProc;

    this.child.stdout?.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          this.handleStdoutLine(parsed);
        } catch {
          // Ignore non-JSON line
        }
      }
    });

    this.child.stderr?.on('data', (chunk) => {
      // Strip terminal OSC title and control codes that Pi CLI emits for terminal window title
      const cleaned = chunk.toString().replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '').trim();
      if (cleaned) {
        console.warn('[Pi CLI stderr]:', cleaned);
      }
    });

    this.child.on('exit', (code, signal) => {
      console.log(`[Pi CLI exit] code: ${code}, signal: ${signal}`);
      if (this.sessionFile) {
        const norm = path.resolve(this.sessionFile);
        const currentStat = sessionStatusMap.get(norm);
        if (currentStat === 'working' || currentStat === 'waiting') {
          setSessionStatus(this.sessionFile, 'completed', this.sessionId);
        }
      }
      this.child = null;
    });

    // Initial get_state handshake with 25s timeout (allows extension loading on cold start)
    const reqId = `init-${Date.now()}`;
    try {
      const stateRes = await this.sendCommand({ id: reqId, type: 'get_state' }, 25000);
      if (stateRes?.data) {
        this.sessionId = stateRes.data.sessionId || null;
        this.sessionFile = stateRes.data.sessionFile || null;
        this.modelInfo = stateRes.data.model || null;
      }
    } catch (e) {
      console.warn('[Pi CLI get_state handshake warning]:', e);
    }
  }

  public async sendCommand(cmd: any, timeoutMs = 15000): Promise<any> {
    if (!this.isAlive() || !this.child?.stdin) {
      throw new Error('Pi CLI subprocess is not running');
    }

    const id = cmd.id || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    cmd.id = id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${cmd.type || id} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify(cmd) + '\n');
    });
  }

  public sendRaw(obj: any): boolean {
    if (!this.isAlive() || !this.child?.stdin) {
      return false;
    }
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private handleStdoutLine(data: any) {
    // 1. If it has an id matching pending request, resolve it
    if (data.id && this.pending.has(data.id)) {
      const p = this.pending.get(data.id)!;
      clearTimeout(p.timer);
      this.pending.delete(data.id);
      p.resolve(data);
      return;
    }

    // 2. If it's an event (type: message_start, message_update, tool_*, agent_*, etc.), broadcast to SSE!
    if (data.type) {
      if (!data.cwd) {
        data.cwd = this.cwd;
      }
      data.sessionFile = this.sessionFile;
      data.sessionId = this.sessionId;

      if (data.type === 'message_start') {
        if (this.sessionFile) {
          setSessionStatus(this.sessionFile, 'working', this.sessionId);
        }
      } else if (data.type === 'extension_ui_request') {
        const method = data.method;
        if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
          if (this.sessionFile) {
            setSessionStatus(this.sessionFile, 'waiting', this.sessionId);
          }
        }
      } else if (data.type === 'extension_ui_response') {
        if (this.sessionFile) {
          setSessionStatus(this.sessionFile, 'working', this.sessionId);
        }
      }

      broadcastSse('pi://event', data);

      // When Pi CLI finishes a turn (agent_end without willRetry), also emit agent_settled
      // so the frontend reducer transitions agentActivity from 'busy' back to 'idle'.
      if (data.type === 'agent_end' && !data.willRetry) {
        if (this.sessionFile) {
          setSessionStatus(this.sessionFile, 'completed', this.sessionId);
          invalidateSessionParseCache(this.sessionFile);
        }
        broadcastSse('pi://event', {
          type: 'agent_settled',
          cwd: this.cwd,
          sessionFile: this.sessionFile,
          sessionId: this.sessionId,
        });
      }
    }
  }
}

export const sessionPool = new Map<string, PiRpcSession>();

setSessionAliveChecker((norm) => {
  const rpc = sessionPool.get(norm);
  return rpc ? rpc.isAlive() : false;
});

export async function getOrCreatePiRpc(cwd: string, sessionFile?: string | null): Promise<PiRpcSession> {
  const normFile = sessionFile ? path.resolve(sessionFile) : null;
  if (normFile) {
    const existing = sessionPool.get(normFile);
    if (existing && existing.isAlive()) {
      return existing;
    }
  }

  // Pool management: prune dead or completed idle processes if pool size >= 4
  if (sessionPool.size >= 4) {
    for (const [sFile, rpc] of sessionPool.entries()) {
      if (sFile !== normFile && sessionStatusMap.get(sFile) !== 'working') {
        rpc.kill();
        sessionPool.delete(sFile);
        if (sessionStatusMap.get(sFile) !== 'waiting') {
          sessionStatusMap.set(sFile, 'unloaded');
        }
        break;
      }
    }
  }

  const rpc = new PiRpcSession();
  await rpc.ensureRunning(resolveCrossPlatformCwd(cwd), normFile);
  if (normFile) {
    sessionPool.set(normFile, rpc);
  }
  return rpc;
}

export function getActiveRpc(): PiRpcSession | null {
  const activeSessionFile = getActiveSessionFile();
  if (!activeSessionFile) {
    return null;
  }
  const norm = path.resolve(activeSessionFile);
  const rpc = sessionPool.get(norm);
  return rpc && rpc.isAlive() ? rpc : null;
}

export function resetPiRpcForTest(): void {
  for (const rpc of sessionPool.values()) {
    rpc.kill();
  }
  sessionPool.clear();
  setActiveSessionFile(null);
  setActiveSessionId(null);
}

export const piRpc = {
  get sessionFile() {
    return getActiveSessionFile();
  },
  set sessionFile(v: string | null) {
    setActiveSessionFile(v);
  },
  get sessionId() {
    return getActiveSessionId();
  },
  set sessionId(v: string | null) {
    setActiveSessionId(v);
  },
  isAlive() {
    return getActiveRpc()?.isAlive() ?? false;
  },
  get modelInfo() {
    return getActiveRpc()?.modelInfo ?? null;
  },
  kill() {
    for (const rpc of sessionPool.values()) {
      rpc.kill();
    }
    sessionPool.clear();
  },
  async sendCommand(cmd: any, timeoutMs?: number) {
    const rpc = await getOrCreatePiRpc(getActiveCwd(), getActiveSessionFile());
    return rpc.sendCommand(cmd, timeoutMs);
  },
  async ensureRunning(cwd: string, sessionFile?: string | null) {
    await getOrCreatePiRpc(cwd, sessionFile);
  },
};

export function handleDiscoverEnvironment() {
  const cfg = getBridgeConfig();
  const nodePath = cfg.nodeExecutable;
  const piCli = cfg.piCliPath;
  const isDiscovered = Boolean(piCli && fs.existsSync(piCli));

  return {
    status: isDiscovered ? 'ready' : 'missing',
    entrypoint: {
      status: isDiscovered ? 'discovered' : 'missing',
      path: piCli,
      candidates: piCli ? [piCli] : [],
      message: isDiscovered ? null : 'Pi CLI entrypoint not detected. Configure piCliPath in server/config.json or install globally.',
    },
    initialDirectory: {
      status: 'discovered',
      path: getActiveCwd(),
      message: null,
    },
    nodePath,
    issues: isDiscovered ? [] : ['missing_entrypoint'],
  };
}

export function handleDetectGentleShell() {
  return {
    status: 'missing',
    path: null,
    entrypoint: null,
    candidates: [],
    message: null,
  };
}

export async function handleSendPrompt(args: any = {}) {
  const payload = args.payload || {};
  const id = payload.id;
  const message = payload.message;
  const images = payload.images;
  const streamingBehavior = payload.streamingBehavior || 'followUp';
  const targetSessionFile = payload.sessionFile || getActiveSessionFile();

  if (!id || !message) {
    throw new Error('Prompt ID and message are required');
  }

  const rpc = await getOrCreatePiRpc(getActiveCwd(), targetSessionFile);
  if (rpc.sessionFile) {
    setSessionStatus(rpc.sessionFile, 'working', rpc.sessionId);
  }

  const res = await rpc.sendCommand({
    id,
    type: 'prompt',
    message,
    images,
    streamingBehavior,
  });

  if (res && res.success === false && res.error) {
    if (rpc.sessionFile) {
      setSessionStatus(rpc.sessionFile, 'completed', rpc.sessionId);
    }
    throw new Error(res.error);
  }

  return { id };
}

export async function handleSendExtensionUiResponse(args: any = {}) {
  const payload = args.payload || {};
  const id = payload.id;
  if (!id) {
    throw new Error('Extension UI response missing required request ID');
  }

  const responseObj: any = {
    type: 'extension_ui_response',
    id,
  };

  if (payload.cancelled) {
    responseObj.cancelled = true;
  } else if (typeof payload.confirmed === 'boolean') {
    responseObj.confirmed = payload.confirmed;
  } else if (payload.value !== undefined) {
    responseObj.value = payload.value;
  } else {
    responseObj.cancelled = true;
  }

  const targetCwd = payload.cwd ? resolveCrossPlatformCwd(payload.cwd) : getActiveCwd();
  const targetSessionFile = payload.sessionFile || getActiveSessionFile();
  const rpc = await getOrCreatePiRpc(targetCwd, targetSessionFile);

  if (!rpc || !rpc.isAlive()) {
    throw new Error('Pi RPC session is not active');
  }

  const written = rpc.sendRaw(responseObj);
  if (!written) {
    throw new Error('Failed to write extension UI response to Pi CLI stdin');
  }

  if (rpc.sessionFile) {
    setSessionStatus(rpc.sessionFile, 'working', rpc.sessionId);
  }

  return {
    id,
    success: true,
  };
}

export async function handleAbort() {
  if (piRpc.isAlive()) {
    await piRpc.sendCommand({ id: `abort-${Date.now()}`, type: 'abort' }, 5000);
  }
  return null;
}

export function handleDisconnect() {
  piRpc.kill();
  return null;
}

export function handleGetBridgeState() {
  return {
    connected: true,
    cwd: getActiveCwd(),
    sessionId: piRpc.sessionId,
  };
}
