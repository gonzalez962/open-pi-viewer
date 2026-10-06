import {
  getSessionPersistenceStatusPi,
  sendExtensionUiResponsePi,
  type BridgeEventListeners,
  type BridgeStatusPayload,
} from '@infra/bridge';
import {
  notifyAppEvent,
  type NotifyAppEventParams,
} from '@infra/notifications';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@core/notifications';
import { loadUiPreferences, type UiPreferences } from '@infra/preferences';
import { DEFAULT_LOCALE, translate } from '@shared/i18n';
import {
  defaultDialogAdapter,
  extractChatTextDelta,
  extractThinkingDelta,
  extractToolOutput,
  isSupportedDialogExtensionUiRequest,
  type ExtensionUiDialogAdapter,
} from '@core/protocol';
import type { ChatAction } from '@core/reducer';
import { normalizeWorkingDirectory, updateSessionHasMessages } from '@core/session';
import type {
  AssistantMessageDelta,
  AuthoritativeMessage,
  ExtensionUiRequest,
  ExtensionUiResponsePayload,
  RpcEventBase,
  SendExtensionUiResponseResult,
} from '@core/types/events';
import type { ConnectConfig } from '@core/types/connection';
import type { SessionPersistenceStatus } from '@core/types/sessions';
import type { SessionStats } from '@core/types/models';

export interface SessionEventControllerOptions {
  getCurrentConfig: () => ConnectConfig;
  getCurrentSessionId: () => string | null;
  dispatch: (action: ChatAction & { targetProjectId?: string }) => void;
  resolveTargetProjectId?: (cwd?: string) => string | undefined;
  checkPersistenceFn?: () => Promise<SessionPersistenceStatus>;
  refreshSessionStatsFn?: () => Promise<SessionStats | null>;
  updateSessionMarkerFn?: (
    cwd: string,
    hasMessages: boolean
  ) => { success: boolean; error?: string };
  onStorageWarning?: (warning: string) => void;
  dialogAdapter?: ExtensionUiDialogAdapter;
  sendExtensionUiResponseFn?: (
    payload: ExtensionUiResponsePayload
  ) => Promise<SendExtensionUiResponseResult>;
  getPreferences?: () => UiPreferences;
  notifyAppEventFn?: (params: NotifyAppEventParams) => void;
}

interface PendingDialogRequest {
  id: string;
  cwd?: string;
  method?: string;
}

/**
 * SessionEventController coordinates Pi RPC streaming events with authoritative
 * session persistence verification:
 *
 * 1. Decouples event handling from React closures so working directory (Settings A->B)
 *    and active session identity are always read dynamically via getters.
 * 2. On assistant completion (message_end for assistant role and agent_settled),
 *    triggers an authoritative native check rather than assuming outward events imply disk flush.
 * 3. Enforces correlation identity: ignores deferred/stale native responses if the session
 *    or working directory changed while the check was in flight.
 * 4. Verifies actual file existence on disk via native Pi state before marking durable identity.
 * 5. Never lowers an existing true marker; surfaces storage warnings honestly.
 */
export class SessionEventController {
  private readonly options: SessionEventControllerOptions;
  private readonly dialogAdapter: ExtensionUiDialogAdapter;
  private readonly sendExtensionUiResponseFn: (
    payload: ExtensionUiResponsePayload
  ) => Promise<SendExtensionUiResponseResult>;
  private readonly notifyAppEventFn: (params: NotifyAppEventParams) => void;
  private readonly pendingDialogRequests = new Map<string, PendingDialogRequest>();

  constructor(options: SessionEventControllerOptions) {
    this.options = options;
    this.dialogAdapter = options.dialogAdapter ?? defaultDialogAdapter;
    this.sendExtensionUiResponseFn =
      options.sendExtensionUiResponseFn ??
      ((payload) => sendExtensionUiResponsePi(payload));
    this.notifyAppEventFn = options.notifyAppEventFn ?? notifyAppEvent;
  }

  private resolveTargetProjectId(cwd?: string): string | undefined {
    return this.options.resolveTargetProjectId
      ? this.options.resolveTargetProjectId(cwd)
      : undefined;
  }

  /**
   * Handle incoming Pi RPC events.
   */
  public handleEvent(event: RpcEventBase): void {
    const eventType = event.type;
    const targetProjectId = this.resolveTargetProjectId(event.cwd as string | undefined);

    const currentSessionId = this.options.getCurrentSessionId();
    const eventSessionId = (event as any).sessionId;
    const isCurrentSession = !eventSessionId || !currentSessionId || eventSessionId === currentSessionId;

    if (eventType === 'session_status_changed') {
      const payload = event as any;
      if (payload.status) {
        this.options.dispatch({
          type: 'UPDATE_SESSION_STATUS',
          payload: {
            sessionPath: payload.sessionPath,
            sessionId: payload.sessionId,
            status: payload.status,
          },
          targetProjectId,
        });
      }
      return;
    }

    if (!isCurrentSession) {
      if (eventType === 'message_start' || eventType === 'message_update') {
        this.options.dispatch({
          type: 'UPDATE_SESSION_STATUS',
          payload: {
            sessionPath: (event as any).sessionFile,
            sessionId: (event as any).sessionId,
            status: 'working',
          },
          targetProjectId,
        });
      } else if (eventType === 'agent_end' || eventType === 'agent_settled') {
        this.options.dispatch({
          type: 'UPDATE_SESSION_STATUS',
          payload: {
            sessionPath: (event as any).sessionFile,
            sessionId: (event as any).sessionId,
            status: 'completed',
          },
          targetProjectId,
        });
      } else if (eventType === 'extension_ui_request') {
        this.options.dispatch({
          type: 'UPDATE_SESSION_STATUS',
          payload: {
            sessionPath: (event as any).sessionFile,
            sessionId: (event as any).sessionId,
            status: 'waiting',
          },
          targetProjectId,
        });
      }
      return;
    }

    if (eventType === 'message_start') {
      const msg = event.message as AuthoritativeMessage;
      if (msg) {
        this.options.dispatch({
          type: 'EVENT_MESSAGE_START',
          payload: { message: msg },
          targetProjectId,
        });
      }
    } else if (eventType === 'message_update') {
      const deltaObj = event.assistantMessageEvent as AssistantMessageDelta;
      const textDelta = extractChatTextDelta(deltaObj);
      if (textDelta) {
        this.options.dispatch({
          type: 'EVENT_MESSAGE_UPDATE',
          payload: {
            delta: textDelta,
            contentIndex: deltaObj?.contentIndex,
          },
          targetProjectId,
        });
      }
      const thinkingDelta = extractThinkingDelta(deltaObj);
      if (thinkingDelta) {
        this.options.dispatch({
          type: 'EVENT_THINKING_UPDATE',
          payload: { delta: thinkingDelta },
          targetProjectId,
        });
      }
    } else if (eventType === 'tool_execution_start') {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const toolName = typeof event.toolName === 'string' ? event.toolName : '';
      if (toolCallId) {
        this.options.dispatch({
          type: 'EVENT_TOOL_EXECUTION_START',
          payload: {
            toolCallId,
            toolName,
            args: (event.args as Record<string, unknown> | string) ?? undefined,
          },
          targetProjectId,
        });
      }
    } else if (eventType === 'tool_execution_update') {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (toolCallId) {
        const output = extractToolOutput(event.partialResult);
        this.options.dispatch({
          type: 'EVENT_TOOL_EXECUTION_UPDATE',
          payload: { toolCallId, output },
          targetProjectId,
        });
      }
    } else if (eventType === 'tool_execution_end') {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (toolCallId) {
        const output = extractToolOutput(event.result);
        this.options.dispatch({
          type: 'EVENT_TOOL_EXECUTION_END',
          payload: {
            toolCallId,
            output,
            isError: Boolean(event.isError),
          },
          targetProjectId,
        });
      }
    } else if (eventType === 'message_end') {
      const msg = event.message as AuthoritativeMessage;
      if (msg) {
        this.options.dispatch({
          type: 'EVENT_MESSAGE_END',
          payload: { message: msg },
          targetProjectId,
        });

        // Trigger native persistence check and stats refresh only when an assistant message completed
        if (msg.role === 'assistant') {
          void this.verifyAndPersistCurrentSession();
          void this.refreshSessionStats();
        }
      }
    } else if (eventType === 'agent_end') {
      this.options.dispatch({
        type: 'EVENT_AGENT_END',
        payload: { willRetry: Boolean(event.willRetry) },
        targetProjectId,
      });
    } else if (eventType === 'agent_settled') {
      this.options.dispatch({ type: 'EVENT_AGENT_SETTLED', targetProjectId });
      // When agent settled, run verification to ensure any completed turns are persisted and stats updated
      void this.verifyAndPersistCurrentSession();
      void this.refreshSessionStats();

      const prefs = this.options.getPreferences
        ? this.options.getPreferences()
        : loadUiPreferences().preferences;
      const notificationPrefs =
        prefs?.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;
      const locale = prefs?.language ?? DEFAULT_LOCALE;

      this.notifyAppEventFn({
        eventType: 'task_complete',
        title: translate(locale, 'notifications.task_complete_title'),
        body: translate(locale, 'notifications.task_complete_body'),
        preferences: notificationPrefs,
      });
    } else if (eventType === 'extension_ui_request') {
      const req = event as unknown as ExtensionUiRequest;
      if (req && isSupportedDialogExtensionUiRequest(req)) {
        void this.handleExtensionUiRequest(req);

        const prefs = this.options.getPreferences
          ? this.options.getPreferences()
          : loadUiPreferences().preferences;
        const notificationPrefs =
          prefs?.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;
        const locale = prefs?.language ?? DEFAULT_LOCALE;

        this.notifyAppEventFn({
          eventType: 'waiting_input',
          title: translate(locale, 'notifications.waiting_input_title'),
          body: translate(locale, 'notifications.waiting_input_body'),
          preferences: notificationPrefs,
        });
      }
    }
  }

  /**
   * Handle incoming Pi bridge status changes.
   */
  public handleStatusChange(status: BridgeStatusPayload): void {
    const targetProjectId = this.resolveTargetProjectId(status.cwd ?? undefined);
    if (status.state === 'connected') {
      this.options.dispatch({
        type: 'CONNECT_SUCCESS',
        payload: { model: status.model, detail: status.detail },
        targetProjectId,
      });
    } else if (status.state === 'connecting') {
      this.options.dispatch({
        type: 'CONNECT_START',
        payload: { detail: status.detail },
        targetProjectId,
      });
    } else if (status.state === 'disconnected') {
      this.cancelPendingDialogRequests(status.cwd ?? undefined);
      this.options.dispatch({
        type: 'DISCONNECT',
        payload: { detail: status.detail },
        targetProjectId,
      });
    } else if (status.state === 'error') {
      this.cancelPendingDialogRequests(status.cwd ?? undefined);
      this.options.dispatch({
        type: 'PROCESS_EXIT',
        payload: { error: status.detail },
        targetProjectId,
      });
    }
  }

  /**
   * Handle incoming bridge error.
   */
  public handleError(error: string): void {
    this.cancelPendingDialogRequests();
    const targetProjectId = this.resolveTargetProjectId(undefined);
    this.options.dispatch({
      type: 'CONNECT_FAIL',
      payload: { error },
      targetProjectId,
    });
  }

  /**
   * Cancel any pending dialog requests on disconnect or fatal bridge error.
   * If cwd is provided, only pending dialogs matching that working directory are cancelled.
   * If cwd is omitted, all pending dialogs are cancelled.
   */
  public cancelPendingDialogRequests(cwd?: string): void {
    const targetNorm = cwd ? normalizeWorkingDirectory(cwd) : undefined;
    const activeCwd = this.options.getCurrentConfig().workingDirectory;
    const activeNorm = activeCwd ? normalizeWorkingDirectory(activeCwd) : undefined;
    const isTargetActive = Boolean(targetNorm && activeNorm && targetNorm === activeNorm);
    const toCancel: PendingDialogRequest[] = [];

    for (const [key, req] of this.pendingDialogRequests.entries()) {
      if (!targetNorm) {
        toCancel.push(req);
        this.pendingDialogRequests.delete(key);
      } else {
        const reqNorm = req.cwd ? normalizeWorkingDirectory(req.cwd) : undefined;
        const shouldCancel = reqNorm ? reqNorm === targetNorm : isTargetActive;
        if (shouldCancel) {
          toCancel.push(req);
          this.pendingDialogRequests.delete(key);
        }
      }
    }

    for (const req of toCancel) {
      void this.sendExtensionUiResponseFn({
        id: req.id,
        cancelled: true,
        ...(req.cwd ? { cwd: req.cwd } : {}),
      }).catch(() => {});
    }

    if (typeof this.dialogAdapter.cancelPending === 'function') {
      try {
        this.dialogAdapter.cancelPending(cwd, activeCwd);
      } catch {
        // Safe adapter execution
      }
    }
  }

  /**
   * Handle an interactive extension UI dialog request (select, input, confirm).
   * Prompts the user through the dialog adapter and sends the response back to Pi RPC.
   * If any failure occurs, safely attempts cancellation so Pi is not left blocked.
   */
  public async handleExtensionUiRequest(request: ExtensionUiRequest): Promise<void> {
    const id = typeof request.id === 'string' ? request.id.trim() : '';
    if (!id) {
      return;
    }
    const reqCwd =
      typeof request.cwd === 'string' && request.cwd.trim()
        ? request.cwd.trim()
        : undefined;
    const normCwd = reqCwd ? normalizeWorkingDirectory(reqCwd) : '';
    const key = `${normCwd}\0${id}`;

    if (this.pendingDialogRequests.has(key)) {
      return;
    }
    this.pendingDialogRequests.set(key, { id, cwd: reqCwd, method: request.method });

    try {
      let responsePayload: ExtensionUiResponsePayload;

      if (request.method === 'select') {
        const choice = await this.dialogAdapter.select(request);
        if (choice === null || choice === undefined) {
          responsePayload = {
            id,
            method: 'select',
            cancelled: true,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          };
        } else {
          responsePayload = {
            id,
            method: 'select',
            value: choice,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          };
        }
      } else if (request.method === 'input') {
        const val = await this.dialogAdapter.input(request);
        if (val === null || val === undefined) {
          responsePayload = {
            id,
            method: 'input',
            cancelled: true,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          };
        } else {
          responsePayload = {
            id,
            method: 'input',
            value: val,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          };
        }
      } else if (request.method === 'confirm') {
        const conf = await this.dialogAdapter.confirm(request);
        if (conf === null || conf === undefined) {
          responsePayload = {
            id,
            method: 'confirm',
            cancelled: true,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          };
        } else {
          responsePayload = {
            id,
            method: 'confirm',
            confirmed: conf,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          };
        }
      } else {
        responsePayload = {
          id,
          method: request.method,
          cancelled: true,
          ...(reqCwd ? { cwd: reqCwd } : {}),
        };
      }

      // Check if session was disconnected while dialog was awaiting user input
      if (!this.pendingDialogRequests.has(key)) {
        return;
      }
      this.pendingDialogRequests.delete(key);
      await this.sendExtensionUiResponseFn(responsePayload);
    } catch {
      // Async failure occurred during dialog interaction or response dispatch:
      // Ensure async failures do not silently leave Pi blocked—attempt cancellation on failure
      if (this.pendingDialogRequests.has(key)) {
        this.pendingDialogRequests.delete(key);
        try {
          await this.sendExtensionUiResponseFn({
            id,
            method: request.method,
            cancelled: true,
            ...(reqCwd ? { cwd: reqCwd } : {}),
          });
        } catch {
          // Best-effort cancellation attempted
        }
      }
    }
  }

  /**
   * Create BridgeEventListeners interface bound dynamically to this controller.
   */
  public asBridgeListeners(): BridgeEventListeners {
    return {
      onEvent: (event: RpcEventBase) => this.handleEvent(event),
      onStatusChange: (status: BridgeStatusPayload) =>
        this.handleStatusChange(status),
      onError: (error: string) => this.handleError(error),
    };
  }

  /**
   * Refresh session token and context statistics from Pi RPC.
   */
  public async refreshSessionStats(): Promise<void> {
    if (!this.options.refreshSessionStatsFn) return;
    try {
      const stats = await this.options.refreshSessionStatsFn();
      if (stats) {
        this.options.dispatch({
          type: 'SET_SESSION_STATS',
          payload: { stats },
        });
      }
    } catch {
      // Non-critical background metric fetch failure
    }
  }

  /**
   * Authoritatively verify active session persistence via native check and update durable marker:
   * 1. Captures expected session ID and working directory at dispatch time.
   * 2. Queues get_state to Pi RPC through native backend, establishing execution ordering after message_end.
   * 3. Native command confirms the actual existence of the session file on disk.
   * 4. Correlates returned identity against expected identity: if cwd, session ID, or generation changed,
   *    or if the result belongs to a stale/different session, the async result is ignored.
   * 5. If file_exists is confirmed, marks durable storage with hasMessages: true (never lowering a true marker).
   * 6. Surfacing any storage warnings to the user honestly.
   */
  public async verifyAndPersistCurrentSession(): Promise<boolean> {
    const expectedConfig = this.options.getCurrentConfig();
    const expectedCwd = expectedConfig.workingDirectory;
    const expectedSessionId = this.options.getCurrentSessionId();

    // If there is no active session ID yet, we cannot verify persistence
    if (!expectedSessionId) {
      return false;
    }

    const checkFn =
      this.options.checkPersistenceFn ?? getSessionPersistenceStatusPi;
    const updateMarker =
      this.options.updateSessionMarkerFn ?? updateSessionHasMessages;

    try {
      const status = await checkFn();

      // 1. Session ID correlation: Has session ID changed (e.g. New conversation reset)?
      const currentSessionId = this.options.getCurrentSessionId();
      if (
        currentSessionId !== expectedSessionId ||
        status.sessionId !== expectedSessionId
      ) {
        return false; // Discard deferred/stale response for superseded session
      }

      // 2. Working directory correlation: Has Settings cwd changed (e.g. A -> B)?
      const currentConfig = this.options.getCurrentConfig();
      const currentNorm = normalizeWorkingDirectory(currentConfig.workingDirectory);
      const expectedNorm = normalizeWorkingDirectory(expectedCwd);
      const statusNorm = normalizeWorkingDirectory(status.canonicalCwd);

      if (currentNorm !== expectedNorm) {
        return false; // Discard stale result from previous working directory
      }

      // Native canonical cwd must match current directory
      if (
        statusNorm !== currentNorm &&
        statusNorm.toLowerCase() !== currentNorm.toLowerCase()
      ) {
        return false;
      }

      // 3. File existence verification: Did native confirm file actually exists on disk?
      if (!status.fileExists) {
        return false;
      }

      // 4. Update durable storage marker for expectedCwd (never lowers existing true marker)
      const saveRes = updateMarker(expectedCwd, true);
      if (!saveRes.success && saveRes.error) {
        this.options.onStorageWarning?.(saveRes.error);
      }

      return true;
    } catch {
      // Native check failed or bridge error: do not speculate or set marker
      return false;
    }
  }
}

/**
 * Whether a dispatched chat action should also trigger a workspace/file-tree refresh.
 * Extracted from App.tsx's former inline `handleEventDispatch`, which fused this decision
 * with the dispatch call itself (odd/tasks/architecture-restructure.md, T5d: the
 * session-events hook takes an `onWorkspaceChanged` callback instead of importing the
 * workspace feature directly). A completed tool execution or the agent settling after a
 * turn are the two events that can plausibly have altered files on disk.
 */
export function shouldRefreshWorkspaceOnEvent(
  action: ChatAction & { targetProjectId?: string }
): boolean {
  return action.type === 'EVENT_TOOL_EXECUTION_END' || action.type === 'EVENT_AGENT_SETTLED';
}
