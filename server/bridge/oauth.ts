import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { getBridgeConfig } from '../config';
import { PI_AGENT_DIR } from './state';
import { broadcastSse } from './sse';
import type {
  BuiltinOAuthProviderStatus,
  StartOAuthLoginPayload,
  StartOAuthLoginResult,
  CancelOAuthLoginPayload,
  CancelOAuthLoginResult,
  SendOAuthPromptResponsePayload,
  SendOAuthPromptResponseResult,
  LogoutOAuthProviderPayload,
  LogoutOAuthProviderResult,
  OAuthEventEnvelope,
  OAuthSafeEvent,
  OAuthSafePrompt,
  OAuthPromptOption,
  OAuthPromptCancelledEvent,
  OAuthStatusEvent,
} from '../../src/core/types/oauth';

// ---------------------------------------------------------------------------
// Constants & Bounded Invariants
// ---------------------------------------------------------------------------

export const MAX_OAUTH_FRAME_BYTES = 64 * 1024; // 64 KB per line frame
export const MAX_TOTAL_OUTPUT_BYTES = 512 * 1024; // 512 KB total output per run

export const DEFAULT_SHORT_TIMEOUT_MS = 20_000; // 20 seconds for short commands (list, logout)
export const DEFAULT_LOGIN_TIMEOUT_MS = 600_000; // 600 seconds (10 min) for login flows
export const DEFAULT_KILL_GRACE_MS = 3_000; // 3 seconds escalation before SIGKILL

export const KNOWN_BUILTIN_OAUTH_PROVIDERS = new Set<string>([
  'anthropic',
  'github-copilot',
  'kimi-coding',
  'meta',
  'openai-codex',
  'openrouter',
  'radius',
  'xai',
]);

// ---------------------------------------------------------------------------
// Sanitization & Projection Utilities
// ---------------------------------------------------------------------------

function sanitizeText(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(
      /(?:bearer\s+|token[=:]\s*|secret[=:]\s*|access_token[=:]\s*|refresh_token[=:]\s*|api_key[=:]\s*)[\w\-._~+/]+=*/gi,
      (match) => {
        const prefix = match.split(/[:=\s]+/)[0];
        return match.includes('=')
          ? `${prefix}=[REDACTED]`
          : match.includes(':')
            ? `${prefix}: [REDACTED]`
            : `${prefix} [REDACTED]`;
      }
    )
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|github_pat|sk|xox[baprs])_[A-Za-z0-9_]{16,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
    .slice(0, 500);
}

function sanitizeError(err: unknown): string {
  if (!err) return 'Authentication operation failed';
  const raw = typeof err === 'string' ? err : (err as any).message || String(err);
  return sanitizeText(raw);
}

function isSafeUrl(raw: unknown): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

function sanitizeUrl(raw: string): string | null {
  if (!isSafeUrl(raw)) return null;
  try {
    const parsed = new URL(raw.trim());
    const sensitiveKeys = new Set([
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
      'secret',
      'token',
      'code_verifier',
      'api_key',
      'apikey',
      'auth_token',
      'user_token',
      'session_token',
      'password',
    ]);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    if (parsed.hash) {
      const hashContent = parsed.hash.replace(/^#/, '');
      const hasSensitive = hashContent.split('&').some((pair) => {
        const key = pair.split('=')[0].trim().toLowerCase();
        return sensitiveKeys.has(key);
      });
      if (hasSensitive) {
        parsed.hash = '';
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function projectSafeAuthEvent(event: any): OAuthSafeEvent | null {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '');
  if (type === 'auth_url') {
    const safeUrl = sanitizeUrl(event.url);
    if (!safeUrl) return null;
    return {
      type: 'auth_url',
      url: safeUrl,
      instructions: typeof event.instructions === 'string' ? sanitizeText(event.instructions) : null,
    };
  }
  if (type === 'device_code') {
    const safeUri = sanitizeUrl(event.verificationUri);
    if (!safeUri) return null;
    return {
      type: 'device_code',
      userCode: typeof event.userCode === 'string' ? sanitizeText(event.userCode) : '',
      verificationUri: safeUri,
      intervalSeconds: typeof event.intervalSeconds === 'number' ? event.intervalSeconds : null,
      expiresInSeconds: typeof event.expiresInSeconds === 'number' ? event.expiresInSeconds : null,
    };
  }
  if (type === 'progress') {
    return {
      type: 'progress',
      message: typeof event.message === 'string' ? sanitizeText(event.message) : '',
    };
  }
  if (type === 'info') {
    const links = Array.isArray(event.links)
      ? event.links
          .filter((l: any) => l && typeof l === 'object' && isSafeUrl(l.url))
          .map((l: any) => ({
            url: sanitizeUrl(l.url)!,
            label: typeof l.label === 'string' ? sanitizeText(l.label) : null,
          }))
          .filter((l: any) => Boolean(l.url))
      : null;
    return {
      type: 'info',
      message: typeof event.message === 'string' ? sanitizeText(event.message) : '',
      links,
    };
  }
  return null;
}

function projectSafePrompt(prompt: any): OAuthSafePrompt {
  const allowedTypes = ['select', 'text', 'secret', 'manual_code'];
  const rawType = prompt?.promptType || prompt?.type;
  const promptType = allowedTypes.includes(rawType) ? rawType : 'text';
  const options: OAuthPromptOption[] | null = Array.isArray(prompt?.options)
    ? prompt.options
        .filter((o: any) => o && typeof o === 'object' && typeof o.id === 'string' && typeof o.label === 'string')
        .map((o: any) => ({
          id: String(o.id).slice(0, 64),
          label: sanitizeText(String(o.label)),
          description: typeof o.description === 'string' ? sanitizeText(o.description) : null,
        }))
    : null;

  return {
    promptId: String(prompt?.promptId || '').slice(0, 64),
    promptType,
    message: typeof prompt?.message === 'string' ? sanitizeText(prompt.message) : '',
    placeholder: typeof prompt?.placeholder === 'string' ? sanitizeText(prompt.placeholder) : null,
    options,
  };
}

function isValidProviderId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.startsWith('-') || trimmed.length > 64) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

export interface OAuthTimeouts {
  shortCommandMs?: number;
  loginMs?: number;
  killGraceMs?: number;
}

export interface OAuthManagerOptions {
  helperPath?: string;
  nodePath?: string;
  entrypoint?: string | null;
  agentHome?: string;
  emit?: (owner: string, event: OAuthEventEnvelope) => void;
  timeouts?: OAuthTimeouts;
  onDispose?: () => void;
}

export interface BuiltinCatalogModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  input?: string[];
  input_modalities?: string[];
  reasoningEfforts?: string[];
  thinkingLevelMap?: Record<string, string | null>;
}

export interface OAuthManager {
  list(owner?: string): Promise<BuiltinOAuthProviderStatus[]>;
  catalog(providerId: string, owner?: string): Promise<BuiltinCatalogModel[]>;
  start(owner: string, payload: StartOAuthLoginPayload): Promise<StartOAuthLoginResult>;
  cancel(owner: string, payload?: CancelOAuthLoginPayload): Promise<CancelOAuthLoginResult>;
  respond(owner: string, payload: SendOAuthPromptResponsePayload): Promise<SendOAuthPromptResponseResult>;
  logout(owner: string, payload: LogoutOAuthProviderPayload): Promise<LogoutOAuthProviderResult>;
  dispose(): Promise<void>;
}

interface ActiveLoginState {
  owner: string;
  providerId: string;
  child: ChildProcess;
  startedAt: number;
  pendingPrompt?: OAuthSafePrompt | null;
  loginTimeoutTimer?: NodeJS.Timeout;
  killEscalationTimer?: NodeJS.Timeout;
  terminalHandled: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

interface InFlightHelper {
  child: ChildProcess;
  abort: (reason: Error) => void;
  donePromise: Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation Class
// ---------------------------------------------------------------------------

class DefaultOAuthManager implements OAuthManager {
  private helperPath: string;
  private nodePath?: string;
  private entrypoint?: string | null;
  private agentHome?: string;
  private emitFn: (owner: string, event: OAuthEventEnvelope) => void;
  private timeouts: Required<OAuthTimeouts>;
  private onDisposeCallback?: () => void;

  private activeLogin: ActiveLoginState | null = null;
  private isStartingLogin = false;
  private inFlightHelpers = new Set<InFlightHelper>();
  private discoveredProviderIds = new Set<string>();
  private isDisposed = false;

  constructor(options?: OAuthManagerOptions) {
    this.helperPath =
      options?.helperPath ||
      process.env.PI_OAUTH_HELPER_PATH ||
      path.resolve(process.cwd(), 'src-tauri', 'pi-oauth-helper.mjs');

    this.nodePath = options?.nodePath;
    this.entrypoint = options?.entrypoint;
    this.agentHome = options?.agentHome;
    this.onDisposeCallback = options?.onDispose;

    this.emitFn =
      options?.emit ||
      ((owner: string, event: OAuthEventEnvelope) => {
        broadcastSse('pi://oauth-event', event, owner);
      });

    this.timeouts = {
      shortCommandMs: options?.timeouts?.shortCommandMs ?? DEFAULT_SHORT_TIMEOUT_MS,
      loginMs: options?.timeouts?.loginMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      killGraceMs: options?.timeouts?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    };
  }

  private resolveExecutionEnvironment(): {
    nodeExecutable: string;
    entrypointPath: string;
    effectiveHome: string;
  } {
    const config = getBridgeConfig();

    const nodeExecutable = this.nodePath || config.nodeExecutable || process.execPath;

    const entrypointPath =
      this.entrypoint !== undefined
        ? this.entrypoint
        : config.piCliPath;

    if (!entrypointPath) {
      throw new Error('Pi CLI entrypoint not found');
    }

    const effectiveHome =
      this.agentHome ||
      (process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim()
        ? process.env.PI_CODING_AGENT_DIR.trim()
        : PI_AGENT_DIR);

    return {
      nodeExecutable,
      entrypointPath,
      effectiveHome,
    };
  }

  private emitSafe(owner: string, envelope: OAuthEventEnvelope): void {
    if (this.isDisposed) return;
    try {
      this.emitFn(owner, envelope);
    } catch {
      // Do not throw on emit failure
    }
  }

  private async isSupportedProvider(providerId: string): Promise<boolean> {
    if (KNOWN_BUILTIN_OAUTH_PROVIDERS.has(providerId)) return true;
    if (this.discoveredProviderIds.has(providerId)) return true;

    // Refresh dynamic list once
    try {
      await this.list();
      return this.discoveredProviderIds.has(providerId);
    } catch {
      return false;
    }
  }

  public async list(_owner?: string): Promise<BuiltinOAuthProviderStatus[]> {
    void _owner;
    if (this.isDisposed) {
      throw new Error('OAuth manager is disposed');
    }

    const { nodeExecutable, entrypointPath, effectiveHome } = this.resolveExecutionEnvironment();

    if (!fs.existsSync(this.helperPath)) {
      throw new Error('Pi OAuth helper script was not found');
    }

    return new Promise<BuiltinOAuthProviderStatus[]>((resolve, reject) => {
      let resolved = false;
      let totalBytes = 0;
      let stdoutAcc = '';

      const child = spawn(
        nodeExecutable,
        [this.helperPath, 'list', '--entrypoint', entrypointPath, '--home', effectiveHome],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'], // Stderr never forwarded
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: effectiveHome,
          },
        }
      );

      let resolveDone!: () => void;
      const donePromise = new Promise<void>((r) => {
        resolveDone = r;
      });

      const inFlightEntry: InFlightHelper = {
        child,
        abort: (reason: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try {
              child.kill('SIGKILL');
            } catch {}
            reject(reason);
          }
        },
        donePromise,
      };
      this.inFlightHelpers.add(inFlightEntry);

      const cleanupInFlight = () => {
        this.inFlightHelpers.delete(inFlightEntry);
        resolveDone();
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanupInFlight();
          try {
            child.kill('SIGKILL');
          } catch {}
          reject(new Error('OAuth list operation timed out'));
        }
      }, this.timeouts.shortCommandMs);

      child.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_TOTAL_OUTPUT_BYTES) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            cleanupInFlight();
            try {
              child.kill('SIGKILL');
            } catch {}
            reject(new Error('OAuth helper output exceeded maximum bounded size'));
          }
          return;
        }
        stdoutAcc += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanupInFlight();
          reject(new Error(`Failed to execute OAuth helper: ${sanitizeError(err)}`));
        }
      });

      child.on('close', (code) => {
        if (resolved) {
          cleanupInFlight();
          return;
        }
        resolved = true;
        clearTimeout(timer);
        cleanupInFlight();

        if (this.isDisposed) {
          reject(new Error('OAuth manager is disposed'));
          return;
        }

        const lines = stdoutAcc
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const lastLine = lines[lines.length - 1];

        if (!lastLine) {
          reject(new Error(`OAuth helper exited with code ${code} without output`));
          return;
        }

        try {
          const parsed = JSON.parse(lastLine);
          if (parsed.status === 'ok' && Array.isArray(parsed.providers)) {
            const results: BuiltinOAuthProviderStatus[] = [];
            for (const p of parsed.providers) {
              if (!p || typeof p !== 'object' || !p.id) continue;
              const providerId = String(p.id);
              this.discoveredProviderIds.add(providerId);

              results.push({
                id: providerId,
                name: sanitizeText(p.name || providerId),
                oauthName: p.oauthName ? sanitizeText(p.oauthName) : null,
                loginLabel: p.loginLabel ? sanitizeText(p.loginLabel) : null,
                isSubscription: Boolean(p.isSubscription),
                configured: Boolean(p.configured),
                hasStoredOAuth: Boolean(p.hasStoredOAuth),
                oauthReady: Boolean(p.oauthReady),
                ambientApiKey: Boolean(p.ambientApiKey),
                source: p.source ? sanitizeText(p.source) : null,
                status: typeof p.status === 'string' ? p.status : 'unconfigured',
              });
            }
            resolve(results);
          } else {
            reject(new Error(sanitizeError(parsed.error || 'Failed to list OAuth providers')));
          }
        } catch {
          reject(new Error('Malformed response from OAuth helper'));
        }
      });
    });
  }

  public async catalog(providerId: string, _owner?: string): Promise<BuiltinCatalogModel[]> {
    void _owner;
    if (this.isDisposed) {
      throw new Error('OAuth manager is disposed');
    }

    const cleanProviderId = (providerId || '').trim();
    if (!cleanProviderId) {
      throw new Error('Provider ID is required to query configuration catalog');
    }

    const { nodeExecutable, entrypointPath, effectiveHome } = this.resolveExecutionEnvironment();

    if (!fs.existsSync(this.helperPath)) {
      throw new Error('Pi OAuth helper script was not found');
    }

    return new Promise<BuiltinCatalogModel[]>((resolve, reject) => {
      let resolved = false;
      let totalBytes = 0;
      let stdoutAcc = '';

      const child = spawn(
        nodeExecutable,
        [
          this.helperPath,
          'catalog',
          '--entrypoint',
          entrypointPath,
          '--home',
          effectiveHome,
          '--provider',
          cleanProviderId,
        ],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'], // Stderr never forwarded
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: effectiveHome,
          },
        }
      );

      let resolveDone!: () => void;
      const donePromise = new Promise<void>((r) => {
        resolveDone = r;
      });

      const inFlightEntry: InFlightHelper = {
        child,
        abort: (reason: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try {
              child.kill('SIGKILL');
            } catch {}
            reject(reason);
          }
        },
        donePromise,
      };
      this.inFlightHelpers.add(inFlightEntry);

      const cleanupInFlight = () => {
        this.inFlightHelpers.delete(inFlightEntry);
        resolveDone();
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanupInFlight();
          try {
            child.kill('SIGKILL');
          } catch {}
          reject(new Error('OAuth catalog operation timed out'));
        }
      }, this.timeouts.shortCommandMs);

      child.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_TOTAL_OUTPUT_BYTES) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            cleanupInFlight();
            try {
              child.kill('SIGKILL');
            } catch {}
            reject(new Error('OAuth helper output exceeded maximum bounded size'));
          }
          return;
        }
        stdoutAcc += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanupInFlight();
          reject(new Error(`Failed to execute OAuth helper: ${sanitizeError(err)}`));
        }
      });

      child.on('close', (code) => {
        if (resolved) {
          cleanupInFlight();
          return;
        }
        resolved = true;
        clearTimeout(timer);
        cleanupInFlight();

        if (this.isDisposed) {
          reject(new Error('OAuth manager is disposed'));
          return;
        }

        const lines = stdoutAcc
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const lastLine = lines[lines.length - 1];

        if (!lastLine) {
          reject(new Error(`OAuth helper exited with code ${code} without output`));
          return;
        }

        try {
          const parsed = JSON.parse(lastLine);
          if (parsed.status === 'ok' && Array.isArray(parsed.models)) {
            const results: BuiltinCatalogModel[] = [];
            for (const m of parsed.models) {
              if (!m || typeof m !== 'object' || !m.id) continue;
              const id = sanitizeText(String(m.id));
              const name = m.name ? sanitizeText(String(m.name)) : id;
              const provider = m.provider ? sanitizeText(String(m.provider)) : cleanProviderId;
              const contextWindow = typeof m.contextWindow === 'number' ? m.contextWindow : undefined;
              const maxTokens = typeof m.maxTokens === 'number' ? m.maxTokens : undefined;
              const reasoning = Boolean(m.reasoning);

              let input: string[] | undefined;
              if (Array.isArray(m.input)) {
                input = m.input.filter((item: any) => typeof item === 'string').map((s: string) => sanitizeText(s));
              }

              let reasoningEfforts: string[] | undefined;
              if (Array.isArray(m.reasoningEfforts)) {
                reasoningEfforts = m.reasoningEfforts.filter((item: any) => typeof item === 'string').map((s: string) => sanitizeText(s));
              }

              let thinkingLevelMap: Record<string, string | null> | undefined;
              if (m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object') {
                thinkingLevelMap = {};
                for (const [k, v] of Object.entries(m.thinkingLevelMap)) {
                  if (typeof v === 'string' || v === null) {
                    thinkingLevelMap[sanitizeText(k)] = typeof v === 'string' ? sanitizeText(v) : null;
                  }
                }
              }

              const safeModel: BuiltinCatalogModel = {
                id,
                name,
                provider,
                reasoning,
              };
              if (contextWindow !== undefined) safeModel.contextWindow = contextWindow;
              if (maxTokens !== undefined) safeModel.maxTokens = maxTokens;
              if (input !== undefined) {
                safeModel.input = input;
                safeModel.input_modalities = input;
              }
              if (reasoningEfforts !== undefined) safeModel.reasoningEfforts = reasoningEfforts;
              if (thinkingLevelMap !== undefined) safeModel.thinkingLevelMap = thinkingLevelMap;

              results.push(safeModel);
            }
            resolve(results);
          } else {
            reject(new Error(sanitizeError(parsed.error || 'Failed to query provider catalog')));
          }
        } catch {
          reject(new Error('Failed to parse OAuth helper catalog response'));
        }
      });
    });
  }

  public async start(owner: string, payload: StartOAuthLoginPayload): Promise<StartOAuthLoginResult> {
    if (this.isDisposed) {
      return {
        started: false,
        providerId: payload?.providerId || '',
        message: 'OAuth manager is disposed',
      };
    }

    if (!owner || typeof owner !== 'string' || !owner.trim()) {
      return {
        started: false,
        providerId: payload?.providerId || '',
        message: 'Invalid or missing session owner',
      };
    }

    const providerId = payload?.providerId;
    if (!isValidProviderId(providerId)) {
      return {
        started: false,
        providerId: typeof providerId === 'string' ? providerId : '',
        message: 'Invalid provider identifier',
      };
    }

    // Single active login globally - synchronous reservation check
    if (this.activeLogin !== null || this.isStartingLogin) {
      return {
        started: false,
        providerId,
        message: 'Another OAuth login is already in progress',
      };
    }
    this.isStartingLogin = true;

    let isSupported = false;
    try {
      isSupported = await this.isSupportedProvider(providerId);
    } catch (err) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: `Failed to validate provider: ${sanitizeError(err)}`,
      };
    }

    // Guard: verify not disposed while waiting for async provider validation
    if (this.isDisposed) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: 'OAuth manager is disposed',
      };
    }

    // Guard: recheck active login after async provider validation
    if (this.activeLogin !== null) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: 'Another OAuth login is already in progress',
      };
    }

    if (!isSupported) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: `Unknown or unsupported OAuth provider '${providerId}'`,
      };
    }

    let envPaths;
    try {
      envPaths = this.resolveExecutionEnvironment();
    } catch (err) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: sanitizeError(err),
      };
    }

    if (!fs.existsSync(this.helperPath)) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: 'Pi OAuth helper script was not found',
      };
    }

    let child: ChildProcess;
    try {
      child = spawn(
        envPaths.nodeExecutable,
        [
          this.helperPath,
          'login',
          '--entrypoint',
          envPaths.entrypointPath,
          '--home',
          envPaths.effectiveHome,
          '--provider',
          providerId,
        ],
        {
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'], // Stderr never forwarded
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: envPaths.effectiveHome,
          },
        }
      );
    } catch (err) {
      this.isStartingLogin = false;
      return {
        started: false,
        providerId,
        message: `Failed to spawn OAuth helper: ${sanitizeError(err)}`,
      };
    }

    this.isStartingLogin = false;

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => {
      resolveExit = r;
    });

    const activeState: ActiveLoginState = {
      owner,
      providerId,
      child,
      startedAt: Date.now(),
      pendingPrompt: null,
      terminalHandled: false,
      exitPromise,
      resolveExit,
    };
    this.activeLogin = activeState;

    // Attach child.stdin error listener immediately on spawn to handle async EPIPE/pipe errors
    child.stdin?.on('error', (err: any) => {
      // Ignore if expected cancellation, completed shutdown, or already handled
      if (activeState.terminalHandled || this.isDisposed) return;
      activeState.terminalHandled = true;
      this.emitSafe(owner, {
        providerId,
        kind: 'status',
        data: {
          state: 'failed',
          error: sanitizeError(err),
        } as OAuthStatusEvent,
      });
      this.escalateKill(activeState);
    });

    // Emit initial status starting
    this.emitSafe(owner, {
      providerId,
      kind: 'status',
      data: {
        state: 'starting',
        message: 'Starting authentication flow',
      } as OAuthStatusEvent,
    });

    // Login timeout
    activeState.loginTimeoutTimer = setTimeout(() => {
      if (!activeState.terminalHandled) {
        activeState.terminalHandled = true;
        this.emitSafe(owner, {
          providerId,
          kind: 'status',
          data: {
            state: 'failed',
            error: 'Authentication timed out',
          } as OAuthStatusEvent,
        });
      }
      this.escalateKill(activeState);
    }, this.timeouts.loginMs);

    let totalOutputBytes = 0;
    const rl = createInterface({ input: child.stdout!, terminal: false });

    rl.on('line', (line) => {
      if (line.length > MAX_OAUTH_FRAME_BYTES) {
        if (!activeState.terminalHandled) {
          activeState.terminalHandled = true;
          this.emitSafe(owner, {
            providerId,
            kind: 'status',
            data: {
              state: 'failed',
              error: 'OAuth frame buffer exceeded maximum allowed limit',
            } as OAuthStatusEvent,
          });
        }
        this.escalateKill(activeState);
        return;
      }

      totalOutputBytes += line.length;
      if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) {
        if (!activeState.terminalHandled) {
          activeState.terminalHandled = true;
          this.emitSafe(owner, {
            providerId,
            kind: 'status',
            data: {
              state: 'failed',
              error: 'OAuth overall output buffer exceeded limit',
            } as OAuthStatusEvent,
          });
        }
        this.escalateKill(activeState);
        return;
      }

      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed);
        this.handleHelperMessage(activeState, msg);
      } catch {
        // Ignore unparseable non-terminal lines
      }
    });

    child.on('error', (err) => {
      if (!activeState.terminalHandled) {
        activeState.terminalHandled = true;
        this.emitSafe(owner, {
          providerId,
          kind: 'status',
          data: {
            state: 'failed',
            error: sanitizeError(err),
          } as OAuthStatusEvent,
        });
      }
    });

    child.on('close', () => {
      if (activeState.loginTimeoutTimer) clearTimeout(activeState.loginTimeoutTimer);
      if (activeState.killEscalationTimer) clearTimeout(activeState.killEscalationTimer);

      if (!activeState.terminalHandled) {
        activeState.terminalHandled = true;
        this.emitSafe(owner, {
          providerId,
          kind: 'status',
          data: {
            state: 'failed',
            error: 'Authentication helper terminated unexpectedly',
          } as OAuthStatusEvent,
        });
      }

      // Retain session until child exit
      activeState.resolveExit();
      if (this.activeLogin === activeState) {
        this.activeLogin = null;
      }
    });

    return {
      started: true,
      providerId,
    };
  }

  private handleHelperMessage(activeState: ActiveLoginState, msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    const { owner, providerId } = activeState;

    if (msg.type === 'event') {
      const safeEvent = projectSafeAuthEvent(msg.event);
      if (safeEvent) {
        this.emitSafe(owner, {
          providerId,
          kind: 'event',
          data: safeEvent,
        });
      }
    } else if (msg.type === 'prompt') {
      const safePrompt = projectSafePrompt(msg.prompt);
      activeState.pendingPrompt = safePrompt;
      this.emitSafe(owner, {
        providerId,
        kind: 'prompt',
        data: safePrompt,
      });
    } else if (msg.type === 'prompt_cancelled') {
      if (activeState.pendingPrompt?.promptId === msg.promptId) {
        activeState.pendingPrompt = null;
      }
      this.emitSafe(owner, {
        providerId,
        kind: 'prompt_cancelled',
        data: {
          promptId: String(msg.promptId || '').slice(0, 64),
        } as OAuthPromptCancelledEvent,
      });
    } else if (msg.type === 'success') {
      if (!activeState.terminalHandled) {
        activeState.terminalHandled = true;
        this.emitSafe(owner, {
          providerId,
          kind: 'status',
          data: {
            state: 'completed',
            message: 'Authentication completed successfully',
          } as OAuthStatusEvent,
        });
      }
    } else if (msg.type === 'cancelled') {
      if (!activeState.terminalHandled) {
        activeState.terminalHandled = true;
        this.emitSafe(owner, {
          providerId,
          kind: 'status',
          data: {
            state: 'cancelled',
            message: 'Authentication flow cancelled',
          } as OAuthStatusEvent,
        });
      }
    } else if (msg.type === 'error') {
      if (!activeState.terminalHandled) {
        activeState.terminalHandled = true;
        this.emitSafe(owner, {
          providerId,
          kind: 'status',
          data: {
            state: 'failed',
            error: sanitizeError(msg.error),
          } as OAuthStatusEvent,
        });
      }
    }
  }

  private escalateKill(activeState: ActiveLoginState): void {
    const { child } = activeState;
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n', () => {
          // write error or completion handled silently
        });
      }
    } catch {
      // write error ignored silently
    }

    const termDelay = Math.min(500, Math.max(50, Math.floor(this.timeouts.killGraceMs / 2)));
    const termTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}

      activeState.killEscalationTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, this.timeouts.killGraceMs);
    }, termDelay);

    activeState.exitPromise.finally(() => {
      clearTimeout(termTimer);
      if (activeState.killEscalationTimer) clearTimeout(activeState.killEscalationTimer);
    });
  }

  public async cancel(owner: string, payload?: CancelOAuthLoginPayload): Promise<CancelOAuthLoginResult> {
    if (!this.activeLogin) {
      return {
        cancelled: false,
        message: 'No active OAuth login process found',
      };
    }

    if (this.activeLogin.owner !== owner) {
      return {
        cancelled: false,
        message: 'Unauthorized: only the session owner can cancel login',
      };
    }

    if (payload?.providerId && payload.providerId !== this.activeLogin.providerId) {
      return {
        cancelled: false,
        message: `Provider mismatch: active login is for '${this.activeLogin.providerId}'`,
      };
    }

    const current = this.activeLogin;
    this.escalateKill(current);

    return {
      cancelled: true,
    };
  }

  public async respond(
    owner: string,
    payload: SendOAuthPromptResponsePayload
  ): Promise<SendOAuthPromptResponseResult> {
    if (!this.activeLogin) {
      return {
        sent: false,
        message: 'No active OAuth login process',
      };
    }

    if (this.activeLogin.owner !== owner) {
      return {
        sent: false,
        message: 'Unauthorized: only the session owner can respond to prompt',
      };
    }

    if (!payload?.promptId || !this.activeLogin.pendingPrompt) {
      return {
        sent: false,
        message: 'No active interactive prompt waiting for response',
      };
    }

    if (this.activeLogin.pendingPrompt.promptId !== payload.promptId) {
      return {
        sent: false,
        message: 'Invalid or expired prompt ID',
      };
    }

    // Validate select values
    if (this.activeLogin.pendingPrompt.promptType === 'select') {
      const options = this.activeLogin.pendingPrompt.options || [];
      const isValid = options.some((opt) => opt.id === payload.response);
      if (!isValid) {
        return {
          sent: false,
          message: `Invalid selection option: '${sanitizeText(payload.response)}'`,
        };
      }
    }

    const { child } = this.activeLogin;
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      return {
        sent: false,
        message: 'Child process stdin is closed or unavailable',
      };
    }

    return new Promise<SendOAuthPromptResponseResult>((resolve) => {
      child.stdin!.write(
        JSON.stringify({
          type: 'prompt_response',
          promptId: payload.promptId,
          value: payload.response,
        }) + '\n',
        (err) => {
          if (err) {
            // Keep pendingPrompt on failed write! Do not clear prompt state
            resolve({
              sent: false,
              message: `Failed to write prompt response: ${sanitizeError(err)}`,
            });
          } else {
            // Clear pendingPrompt only upon successful write delivery
            if (this.activeLogin?.pendingPrompt?.promptId === payload.promptId) {
              this.activeLogin.pendingPrompt = null;
            }
            resolve({ sent: true });
          }
        }
      );
    });
  }

  public async logout(owner: string, payload: LogoutOAuthProviderPayload): Promise<LogoutOAuthProviderResult> {
    if (!owner || typeof owner !== 'string' || !owner.trim()) {
      return {
        success: false,
        providerId: payload?.providerId || '',
        message: 'Invalid or missing session owner',
      };
    }

    if (this.isDisposed) {
      return {
        success: false,
        providerId: payload?.providerId || '',
        message: 'OAuth manager is disposed',
      };
    }

    const providerId = payload?.providerId;
    if (!isValidProviderId(providerId)) {
      return {
        success: false,
        providerId: typeof providerId === 'string' ? providerId : '',
        message: 'Invalid provider identifier',
      };
    }

    const isSupported = await this.isSupportedProvider(providerId);
    if (this.isDisposed) {
      return {
        success: false,
        providerId,
        message: 'OAuth manager is disposed',
      };
    }
    if (!isSupported) {
      return {
        success: false,
        providerId,
        message: `Unknown or unsupported OAuth provider '${providerId}'`,
      };
    }

    let envPaths;
    try {
      envPaths = this.resolveExecutionEnvironment();
    } catch (err) {
      return {
        success: false,
        providerId,
        message: sanitizeError(err),
      };
    }

    if (!fs.existsSync(this.helperPath)) {
      return {
        success: false,
        providerId,
        message: 'Pi OAuth helper script was not found',
      };
    }

    return new Promise<LogoutOAuthProviderResult>((resolve) => {
      let resolved = false;
      let totalBytes = 0;
      let stdoutAcc = '';

      const child = spawn(
        envPaths.nodeExecutable,
        [
          this.helperPath,
          'logout',
          '--entrypoint',
          envPaths.entrypointPath,
          '--home',
          envPaths.effectiveHome,
          '--provider',
          providerId,
        ],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'], // Stderr never forwarded
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: envPaths.effectiveHome,
          },
        }
      );

      let resolveDone!: () => void;
      const donePromise = new Promise<void>((r) => {
        resolveDone = r;
      });

      const inFlightEntry: InFlightHelper = {
        child,
        abort: (reason: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve({
              success: false,
              providerId,
              message: reason.message,
            });
          }
        },
        donePromise,
      };
      this.inFlightHelpers.add(inFlightEntry);

      const cleanupInFlight = () => {
        this.inFlightHelpers.delete(inFlightEntry);
        resolveDone();
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanupInFlight();
          try {
            child.kill('SIGKILL');
          } catch {}
          resolve({
            success: false,
            providerId,
            message: 'Logout operation timed out',
          });
        }
      }, this.timeouts.shortCommandMs);

      child.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_TOTAL_OUTPUT_BYTES) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            cleanupInFlight();
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve({
              success: false,
              providerId,
              message: 'OAuth helper output exceeded maximum bounded size',
            });
          }
          return;
        }
        stdoutAcc += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanupInFlight();
          resolve({
            success: false,
            providerId,
            message: `Failed to execute OAuth logout: ${sanitizeError(err)}`,
          });
        }
      });

      child.on('close', (code) => {
        if (resolved) {
          cleanupInFlight();
          return;
        }
        resolved = true;
        clearTimeout(timer);
        cleanupInFlight();

        if (this.isDisposed) {
          resolve({
            success: false,
            providerId,
            message: 'OAuth manager is disposed',
          });
          return;
        }

        const lines = stdoutAcc
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const lastLine = lines[lines.length - 1];

        if (!lastLine) {
          resolve({
            success: false,
            providerId,
            message: `OAuth helper exited with code ${code} without output`,
          });
          return;
        }

        try {
          const parsed = JSON.parse(lastLine);
          if (parsed.status === 'ok') {
            resolve({
              success: true,
              providerId,
            });
          } else {
            resolve({
              success: false,
              providerId,
              message: sanitizeError(parsed.error || 'Logout failed'),
            });
          }
        } catch {
          resolve({
            success: false,
            providerId,
            message: 'Malformed response from OAuth helper',
          });
        }
      });
    });
  }

  public async dispose(): Promise<void> {
    this.isDisposed = true;
    if (this.onDisposeCallback) {
      this.onDisposeCallback();
      this.onDisposeCallback = undefined;
    }

    const tasks: Promise<unknown>[] = [];

    if (this.activeLogin) {
      const current = this.activeLogin;
      this.escalateKill(current);
      tasks.push(current.exitPromise);
      this.activeLogin = null;
    }

    const disposeErr = new Error('OAuth manager is disposed');
    for (const helper of Array.from(this.inFlightHelpers)) {
      helper.abort(disposeErr);
      tasks.push(helper.donePromise);
    }
    this.inFlightHelpers.clear();

    await Promise.allSettled(tasks);
  }
}

// ---------------------------------------------------------------------------
// Factory & Singleton
// ---------------------------------------------------------------------------

export function createOAuthManager(options?: OAuthManagerOptions): OAuthManager {
  return new DefaultOAuthManager(options);
}

let productionOAuthManager: OAuthManager | null = null;

let singletonFactory: () => OAuthManager = () => {
  let instance: OAuthManager;
  instance = createOAuthManager({
    onDispose: () => {
      if (productionOAuthManager === instance) {
        productionOAuthManager = null;
      }
    },
  });
  return instance;
};

export function setOAuthManagerFactoryForTest(factory: (() => OAuthManager) | null): void {
  singletonFactory =
    factory ||
    (() => {
      let instance: OAuthManager;
      instance = createOAuthManager({
        onDispose: () => {
          if (productionOAuthManager === instance) {
            productionOAuthManager = null;
          }
        },
      });
      return instance;
    });
}

export function resetOAuthManagerForTest(): void {
  productionOAuthManager = null;
}

export function getOAuthManager(): OAuthManager {
  if (!productionOAuthManager) {
    productionOAuthManager = singletonFactory();
  }
  return productionOAuthManager;
}

export const oauthManager: OAuthManager = {
  list(owner?: string) {
    return getOAuthManager().list(owner);
  },
  catalog(providerId: string, owner?: string) {
    return getOAuthManager().catalog(providerId, owner);
  },
  start(owner: string, payload: StartOAuthLoginPayload) {
    return getOAuthManager().start(owner, payload);
  },
  cancel(owner: string, payload?: CancelOAuthLoginPayload) {
    return getOAuthManager().cancel(owner, payload);
  },
  respond(owner: string, payload: SendOAuthPromptResponsePayload) {
    return getOAuthManager().respond(owner, payload);
  },
  logout(owner: string, payload: LogoutOAuthProviderPayload) {
    return getOAuthManager().logout(owner, payload);
  },
  async dispose() {
    const current = productionOAuthManager;
    if (current) {
      if (productionOAuthManager === current) {
        productionOAuthManager = null;
      }
      await current.dispose();
    }
  },
};
