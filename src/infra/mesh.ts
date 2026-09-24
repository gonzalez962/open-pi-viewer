import type { ConnectConfig, ConnectResult } from '@core/types/connection';
import type { RpcEventBase, SendPromptResult } from '@core/types/events';
import type { WorkspaceEntry, WorkspaceFileContent } from '@core/types/workspace';

export interface MeshEventCallbacks {
  onEvent?: (event: RpcEventBase) => void;
  onStatusChange?: (status: {
    state: 'disconnected' | 'connecting' | 'connected' | 'error';
    label: string;
    detail: string;
  }) => void;
  onError?: (error: string) => void;
}

/**
 * GentleMeshClient connects open-pi-viewer directly to a remote Gentle Mesh Coordinator
 * via HTTP REST and SSE streaming, eliminating the need for a local Node.js subprocess.
 */
export class GentleMeshClient {
  private coordinatorUrl: string = 'http://localhost:8080';
  private token: string = '';
  private activeTaskId: string | null = null;
  private abortController: AbortController | null = null;
  private callbacks: MeshEventCallbacks = {};
  private isConnected: boolean = false;
  private activeCwd: string = '.';

  constructor(callbacks: MeshEventCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: MeshEventCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public getCoordinatorUrl(): string {
    return this.coordinatorUrl;
  }

  public setCoordinatorUrl(url: string): void {
    this.coordinatorUrl = url.trim().replace(/\/+$/, '');
  }

  public setToken(token: string): void {
    this.token = token.trim();
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Healthcheck the remote Gentle Mesh coordinator.
   */
  public async checkHealth(): Promise<{ ok: boolean; statusText?: string }> {
    try {
      const res = await fetch(`${this.coordinatorUrl}/healthz`, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      return { ok: res.ok, statusText: res.statusText };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, statusText: msg };
    }
  }

  /**
   * Connect to Gentle Mesh Coordinator.
   */
  public async connect(config: ConnectConfig): Promise<ConnectResult> {
    if (config.meshCoordinatorUrl) {
      this.setCoordinatorUrl(config.meshCoordinatorUrl);
    }
    if (config.meshToken !== undefined) {
      this.setToken(config.meshToken);
    }
    this.activeCwd = config.workingDirectory || '.';

    this.callbacks.onStatusChange?.({
      state: 'connecting',
      label: 'Connecting to Gentle Mesh',
      detail: `Reaching coordinator at ${this.coordinatorUrl}...`,
    });

    const health = await this.checkHealth();
    if (!health.ok) {
      const errMsg = `Failed to reach Gentle Mesh coordinator at ${this.coordinatorUrl}: ${health.statusText || 'offline'}`;
      this.callbacks.onStatusChange?.({
        state: 'error',
        label: 'Gentle Mesh Offline',
        detail: errMsg,
      });
      this.callbacks.onError?.(errMsg);
      throw new Error(errMsg);
    }

    this.isConnected = true;

    // Fetch radar or nodes info if available
    let radarSummary = 'Gentle Mesh Cluster';
    try {
      const radarRes = await fetch(`${this.coordinatorUrl}/v1/mesh/radar`, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      if (radarRes.ok) {
        const radar = await radarRes.json();
        if (radar && radar.summary) {
          radarSummary = `Gentle Mesh (${radar.summary.online_workers || 0} workers online)`;
        }
      }
    } catch {
      // Non-fatal if radar is disabled
    }

    this.callbacks.onStatusChange?.({
      state: 'connected',
      label: 'Connected (Mesh)',
      detail: `${this.coordinatorUrl} - ${radarSummary}`,
    });

    return {
      connected: true,
      model: {
        id: 'gentle-mesh-cluster',
        name: radarSummary,
        provider: 'gentle-mesh',
      },
      sessionId: `mesh-session-${Date.now()}`,
      canonicalCwd: this.activeCwd,
      messageCount: 0,
      messages: [],
    };
  }

  /**
   * Disconnect from Gentle Mesh.
   */
  public async disconnect(): Promise<void> {
    await this.abort();
    this.isConnected = false;
    this.callbacks.onStatusChange?.({
      state: 'disconnected',
      label: 'Disconnected',
      detail: 'Disconnected from Gentle Mesh',
    });
  }

  /**
   * Submit prompt to Gentle Mesh coordinator and stream SSE events back to the viewer.
   */
  public async sendPrompt(
    id: string,
    message: string
  ): Promise<SendPromptResult> {
    if (!this.isConnected) {
      throw new Error('Cannot send prompt: Gentle Mesh client is disconnected');
    }

    // Cancel any previous in-flight task
    await this.abort();

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // 1. Dispatch prompt start to reducer
    this.callbacks.onEvent?.({
      type: 'message_start',
      message: {
        id: `msg-${id}`,
        role: 'assistant',
        content: [],
      },
      cwd: this.activeCwd,
    });

    // 2. Dispatch task to coordinator
    const taskPayload = {
      prompt: message,
      session_id: id,
      agent: 'worker',
      tags: ['fast'],
      workspace_root: this.activeCwd !== '.' ? this.activeCwd : undefined,
    };

    let taskId: string;
    try {
      const res = await fetch(`${this.coordinatorUrl}/v1/tasks`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(taskPayload),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Coordinator returned ${res.status}: ${errText}`);
      }

      const taskData = await res.json();
      taskId = taskData.task_id;
      this.activeTaskId = taskId;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.(msg);
      throw err;
    }

    // 3. Stream SSE events asynchronously
    void this.streamEvents(taskId, id, signal);

    return { id, accepted: true };
  }

  /**
   * Abort the active task on the coordinator.
   */
  public async abort(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.activeTaskId) {
      const tid = this.activeTaskId;
      this.activeTaskId = null;
      try {
        await fetch(`${this.coordinatorUrl}/v1/tasks/${tid}/cancel`, {
          method: 'POST',
          headers: this.getHeaders(),
        });
      } catch {
        // Safe to ignore cancel errors on abort
      }
    }
  }

  /**
   * Read remote directory entries.
   */
  public async listWorkspaceDir(subpath?: string): Promise<WorkspaceEntry[]> {
    const qPath = subpath ? `?path=${encodeURIComponent(subpath)}` : '';
    const res = await fetch(`${this.coordinatorUrl}/v1/workspace/tree${qPath}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    if (!data || !Array.isArray(data.entries)) {
      return [];
    }

    return data.entries.map((e: { name: string; path: string; is_dir: boolean; size: number; mod_time: number }) => ({
      name: e.name,
      relativePath: e.path,
      isDir: e.is_dir,
      size: e.size,
      lastModified: e.mod_time,
    }));
  }

  /**
   * Read remote file content.
   */
  public async readWorkspaceFile(relativePath: string): Promise<WorkspaceFileContent> {
    const res = await fetch(`${this.coordinatorUrl}/v1/workspace/file?path=${encodeURIComponent(relativePath)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Failed to read file ${relativePath}: HTTP ${res.status}`);
    }

    const data = await res.json();
    const filePath = data.path || relativePath;
    const fileName = filePath.split('/').pop() || filePath;
    const fileExt = fileName.includes('.') ? fileName.split('.').pop() || null : null;

    return {
      relativePath: filePath,
      name: fileName,
      content: data.content || '',
      isBinary: false,
      size: data.size || 0,
      extension: fileExt,
    };
  }

  /**
   * Internal SSE streaming consumer.
   */
  private async streamEvents(taskId: string, promptId: string, signal: AbortSignal): Promise<void> {
    try {
      const sseHeaders: Record<string, string> = {
        Accept: 'text/event-stream',
      };
      if (this.token) {
        sseHeaders['Authorization'] = `Bearer ${this.token}`;
      }

      const res = await fetch(`${this.coordinatorUrl}/v1/tasks/${taskId}/events`, {
        method: 'GET',
        headers: sseHeaders,
        signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE stream failed with status ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulatedText = '';

      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = 'message';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            currentEvent = 'message';
            continue;
          }

          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim();
            continue;
          }

          if (trimmed.startsWith('data:')) {
            const rawData = trimmed.slice(5).trim();
            try {
              const payload = JSON.parse(rawData);
              this.handleParsedEvent(currentEvent, payload, accumulatedText, (textDelta) => {
                accumulatedText += textDelta;
              });
            } catch {
              // Ignore non-json lines (e.g. heartbeat comments)
            }
          }
        }
      }

      // Stream settled
      this.callbacks.onEvent?.({
        type: 'agent_settled',
        cwd: this.activeCwd,
      });
      this.callbacks.onEvent?.({
        type: 'message_end',
        message: {
          id: `msg-${promptId}`,
          role: 'assistant',
          content: accumulatedText,
        },
        cwd: this.activeCwd,
      });
    } catch (err: unknown) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.(`Stream error: ${msg}`);
      this.callbacks.onEvent?.({
        type: 'agent_settled',
        cwd: this.activeCwd,
      });
    } finally {
      if (this.activeTaskId === taskId) {
        this.activeTaskId = null;
      }
    }
  }

  /**
   * Map Gentle Mesh SSE events to open-pi-viewer RpcEventBase formats.
   */
  private handleParsedEvent(
    eventType: string,
    rawPayload: Record<string, unknown>,
    _accumulatedText: string,
    appendDelta: (text: string) => void
  ): void {
    const cwd = this.activeCwd;
    // Unwrap nested protocol payload envelope if present (e.g. { type: "...", payload: { ... } })
    const payload = (rawPayload.payload && typeof rawPayload.payload === 'object')
      ? (rawPayload.payload as Record<string, unknown>)
      : rawPayload;

    switch (eventType) {
      case 'thought': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        this.callbacks.onEvent?.({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            delta: text,
          },
          cwd,
        });
        break;
      }

      case 'token':
      case 'text': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text) {
          appendDelta(text);
          this.callbacks.onEvent?.({
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              delta: text,
            },
            cwd,
          });
        }
        break;
      }

      case 'tool_call': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        const tool = typeof payload.tool === 'string' ? payload.tool : '';
        const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
        this.callbacks.onEvent?.({
          type: 'tool_execution_start',
          toolCallId: callId,
          toolName: tool,
          args,
          cwd,
        });
        break;
      }

      case 'tool_result': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output || '');
        const isError = Boolean(payload.is_error);
        this.callbacks.onEvent?.({
          type: 'tool_execution_end',
          toolCallId: callId,
          result: output,
          isError,
          cwd,
        });
        break;
      }

      case 'completion': {
        const text = typeof payload.text === 'string'
          ? payload.text
          : typeof payload.result === 'string'
            ? payload.result
            : '';
        if (text && !_accumulatedText) {
          appendDelta(text);
          this.callbacks.onEvent?.({
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              delta: text,
            },
            cwd,
          });
        }
        break;
      }

      case 'status': {
        const status = typeof payload.status === 'string' ? payload.status : '';
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          this.callbacks.onEvent?.({
            type: 'agent_settled',
            cwd,
          });
        }
        break;
      }

      default:
        break;
    }
  }
}

/** Global singleton instance */
export const gentleMeshClient = new GentleMeshClient();
