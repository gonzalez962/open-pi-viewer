import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ConnectConfig, ConnectResult, ConnectSessionOptions } from '@core/types/connection';
import type { ModelInfo, ModelThinkingLevelsMap, SessionStats, ThinkingLevel } from '@core/types/models';
import type {
  ExtensionUiResponsePayload,
  RpcEventBase,
  SendExtensionUiResponseResult,
  SendPromptResult,
} from '@core/types/events';
import type {
  NewSessionResult,
  SessionPersistenceStatus,
  SessionSummary,
  SwitchSessionResult,
  DeleteSessionResult,
} from '@core/types/sessions';
import type {
  ListWorkspaceDirPayload,
  WorkspaceEntry,
  WorkspaceFileContent,
  ReadWorkspaceFilePayload,
  WorkspaceGitStatus,
  WorkspaceFileDiff,
} from '@core/types/workspace';
import type { CustomProviderConfig, CustomProvidersMap, ModelsConfigFile } from '@core/types/providers';
import type {
  DeleteMcpServerPayload,
  DeleteMcpServerResult,
  McpServerConfig,
  McpServerScope,
  McpServerType,
  McpServersPayload,
  SaveMcpServerPayload,
  SaveMcpServerResult,
  ToggleMcpServerPayload,
  ToggleMcpServerResult,
} from '@core/types/mcp';
import type {
  DeletePiResourcePayload,
  DeletePiResourceResult,
  PiResourceEntry,
  PiResourceScope,
  PiResourcesPayload,
  SavePiResourcePayload,
  SavePiResourceResult,
  TogglePiResourcePayload,
  TogglePiResourceResult,
} from '@core/types/extensions';
import {
  deriveResourceName,
  normalizeResourceId,
  normalizeTargetSource,
  resourceIdentitiesMatch,
  validateResourceSource,
} from '@core/types/extensions';
import type {
  Profile,
  ProfileScope,
  ProfilesPayload,
  ProfileSummary,
  SaveProfilePayload,
  SetActiveProfilePayload,
} from '@core/types/profiles';
import {
  buildDynamicCategories,
  resolveEffectiveProfile,
  sanitizeProfileName,
  isSyntheticAgentKey,
  type DiscoveredAgentMeta,
} from '@core/types/profiles';
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
} from '@core/types/oauth';
import { gentleMeshClient } from './mesh';

let activeConnectionType: 'local' | 'mesh' = 'local';

export interface BridgeStatusPayload {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  label: string;
  detail: string;
  model?: ModelInfo | null;
  cwd?: string | null;
}

export interface BridgeErrorPayload {
  error: string;
}

export interface BridgeEventListeners {
  onEvent: (event: RpcEventBase) => void;
  onStatusChange: (status: BridgeStatusPayload) => void;
  onError: (error: string) => void;
}

let bridgeListenersReady: Promise<void> = Promise.resolve();

/**
 * Await until registered bridge listeners have completed their IPC attachment.
 */
export function ensureBridgeListenersReady(): Promise<void> {
  return bridgeListenersReady;
}

/**
 * Connect to Pi RPC subprocess via Tauri IPC with optional session parameters.
 * Supports flexible parameter signatures for backward compatibility:
 * - connectPi(config, sessionOptions, invokeFn)
 * - connectPi(config, invokeFn)
 */
export async function connectPi(
  config: ConnectConfig,
  sessionOptionsOrInvokeFn?:
    | ConnectSessionOptions
    | (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>),
  invokeFnParam?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
): Promise<ConnectResult> {
  if (config.connectionType === 'mesh') {
    activeConnectionType = 'mesh';
    await ensureBridgeListenersReady();
    return await gentleMeshClient.connect(config);
  }
  activeConnectionType = 'local';

  let sessionOptions: ConnectSessionOptions | undefined;
  let invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> =
    invoke;

  if (typeof sessionOptionsOrInvokeFn === 'function') {
    invokeFn = sessionOptionsOrInvokeFn;
    sessionOptions = undefined;
  } else {
    sessionOptions = sessionOptionsOrInvokeFn;
    if (invokeFnParam) {
      invokeFn = invokeFnParam;
    }
  }

  if (!isTauri() && invokeFn === invoke) {
    throw new Error(
      'Desktop runtime unavailable: running in browser preview without Tauri bridge'
    );
  }

  // Ensure frontend event listeners are active before triggering backend connection
  await ensureBridgeListenersReady();

  const payload: Record<string, unknown> = {
    nodePath: config.nodePath,
    piEntrypoint: config.piEntrypoint,
    workingDirectory: config.workingDirectory,
  };
  if (sessionOptions?.sessionFile !== undefined) {
    payload.sessionFile = sessionOptions.sessionFile;
  }
  if (sessionOptions?.requireSessionFileExists !== undefined) {
    payload.requireSessionFileExists = sessionOptions.requireSessionFileExists;
  }

  return await invokeFn<ConnectResult>('connect', { payload });
}

/**
 * Disconnect from Pi RPC subprocess via Tauri IPC.
 */
export async function disconnectPi(
  workingDirectoryOrInvokeFn?:
    | string
    | (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>),
  invokeFnParam?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
): Promise<void> {
  if (activeConnectionType === 'mesh') {
    activeConnectionType = 'local';
    return await gentleMeshClient.disconnect();
  }

  let workingDirectory: string | undefined;
  let invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke;

  if (typeof workingDirectoryOrInvokeFn === 'function') {
    invokeFn = workingDirectoryOrInvokeFn;
  } else {
    workingDirectory = workingDirectoryOrInvokeFn;
    if (invokeFnParam) {
      invokeFn = invokeFnParam;
    }
  }

  if (!isTauri() && invokeFn === invoke) {
    return;
  }

  const payload = workingDirectory ? { workingDirectory } : undefined;
  await invokeFn('disconnect', payload ? { payload } : undefined);
}

export interface PromptImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface SendPromptPayload {
  id: string;
  message: string;
  images?: PromptImageAttachment[];
}

export interface SendPromptArgs {
  payload: SendPromptPayload;
}

/**
 * Pure payload builder for Tauri send_prompt IPC command.
 * Used authoritatively by sendPromptPi.
 */
export function buildSendPromptArgs(
  id: string,
  message: string,
  images?: PromptImageAttachment[]
): SendPromptArgs {
  return {
    payload: {
      id,
      message,
      ...(images && images.length > 0 ? { images } : {}),
    },
  };
}

/**
 * Send prompt message to Pi RPC subprocess via Tauri IPC.
 * Passes client-generated opaque prompt request ID explicitly.
 * Rejects silent fallback if backend response ID is missing or empty.
 */
export async function sendPromptPi(
  id: string,
  message: string,
  imagesOrInvokeFn?:
    | PromptImageAttachment[]
    | (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>),
  invokeFnParam?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
): Promise<SendPromptResult> {
  if (activeConnectionType === 'mesh') {
    return await gentleMeshClient.sendPrompt(id, message);
  }

  let images: PromptImageAttachment[] | undefined;
  let invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke;

  if (typeof imagesOrInvokeFn === 'function') {
    invokeFn = imagesOrInvokeFn;
    images = undefined;
  } else {
    images = imagesOrInvokeFn;
    if (invokeFnParam) {
      invokeFn = invokeFnParam;
    }
  }

  if (!isTauri() && invokeFn === invoke) {
    throw new Error('Desktop runtime unavailable: cannot send prompt outside Tauri');
  }

  const args = buildSendPromptArgs(id, message, images);
  const result = await invokeFn<SendPromptResult>(
    'send_prompt',
    args as unknown as Record<string, unknown>
  );

  if (!result || typeof result !== 'object' || !result.id) {
    throw new Error('Backend response missing required request ID');
  }

  return result;
}

/**
 * Send an extension UI dialog response to active Pi RPC session via Tauri IPC.
 * Validates non-empty request ID and method-specific response shape.
 */
export async function sendExtensionUiResponsePi(
  payload: ExtensionUiResponsePayload,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<SendExtensionUiResponseResult> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error(
      'Desktop runtime unavailable: cannot send extension UI response outside Tauri'
    );
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Extension UI response payload must be an object');
  }

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) {
    throw new Error('Extension UI response missing required request ID');
  }

  const result = await invokeFn<SendExtensionUiResponseResult>(
    'send_extension_ui_response',
    { payload }
  );

  if (!result || typeof result !== 'object' || !result.id) {
    throw new Error('Backend response missing required request ID');
  }

  return result;
}

/**
 * Abort active agent operation via Tauri IPC.
 */
export async function abortPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<void> {
  if (activeConnectionType === 'mesh') {
    return await gentleMeshClient.abort();
  }

  if (!isTauri() && invokeFn === invoke) {
    return;
  }

  await invokeFn('abort');
}

/**
 * Fetch messages from active Pi RPC session via Tauri IPC.
 */
export async function getMessagesPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<unknown[]> {
  if (!isTauri() && invokeFn === invoke) {
    return [];
  }

  const result = await invokeFn<unknown[]>('get_messages');
  return Array.isArray(result) ? result : [];
}

/**
 * Reset active Pi session to a new conversation via Tauri IPC.
 */
export async function newSessionPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<NewSessionResult> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error('Desktop runtime unavailable: cannot reset session outside Tauri');
  }

  return await invokeFn<NewSessionResult>('new_session');
}

/**
 * List previous sessions for the current workspace via Tauri IPC.
 */
export async function listSessionsPi(
  workingDirectory?: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<SessionSummary[]> {
  if (!isTauri() && invokeFn === invoke) {
    return [];
  }

  const payload = workingDirectory ? { workingDirectory } : undefined;
  const result = await invokeFn<SessionSummary[]>('list_sessions', payload ? { payload } : undefined);
  return Array.isArray(result) ? result : [];
}

/**
 * Switch active session to a different session file via Tauri IPC.
 */
export async function switchSessionPi(
  sessionPath: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<SwitchSessionResult> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error('Desktop runtime unavailable: cannot switch session outside Tauri');
  }

  return await invokeFn<SwitchSessionResult>('switch_session', {
    payload: { sessionPath },
  });
}

/**
 * Delete a session file from disk via Tauri IPC.
 */
export async function deleteSessionPi(
  sessionPath: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<DeleteSessionResult> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error('Desktop runtime unavailable: cannot delete session outside Tauri');
  }

  return await invokeFn<DeleteSessionResult>('delete_session', {
    payload: { sessionPath },
  });
}

/**
 * List files and directories in a workspace folder via Tauri IPC.
 */
export async function listWorkspaceDirPi(
  payload?: ListWorkspaceDirPayload,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<WorkspaceEntry[]> {
  if (activeConnectionType === 'mesh') {
    return await gentleMeshClient.listWorkspaceDir(payload?.relativePath);
  }

  if (!isTauri() && invokeFn === invoke) {
    return [];
  }

  const result = await invokeFn<WorkspaceEntry[]>('list_workspace_dir', payload ? { payload } : undefined);
  return Array.isArray(result) ? result : [];
}

/**
 * Read text content of a file in the workspace via Tauri IPC.
 */
export async function readWorkspaceFilePi(
  relativePath: string,
  workingDirectory?: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<WorkspaceFileContent> {
  if (activeConnectionType === 'mesh') {
    return await gentleMeshClient.readWorkspaceFile(relativePath);
  }

  if (!isTauri() && invokeFn === invoke) {
    throw new Error('Desktop runtime unavailable: cannot read workspace file outside Tauri');
  }

  const payload: ReadWorkspaceFilePayload = {
    relativePath,
    workingDirectory: workingDirectory || undefined,
  };

  return await invokeFn<WorkspaceFileContent>('read_workspace_file', { payload });
}

/**
 * Inspect workspace git status (branch, repo name, modified/added/untracked files) via Tauri IPC.
 */
export async function getWorkspaceGitStatusPi(
  workingDirectory?: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<WorkspaceGitStatus> {
  if (!isTauri() && invokeFn === invoke) {
    return {
      isRepo: false,
      repoName: null,
      branch: null,
      modifiedFiles: [],
      addedFiles: [],
      untrackedFiles: [],
    };
  }

  const payload = workingDirectory ? { workingDirectory } : undefined;
  return await invokeFn<WorkspaceGitStatus>('get_workspace_git_status', payload ? { payload } : undefined);
}

/**
 * Get git diff of a specific file in workspace via Tauri IPC.
 */
export async function getWorkspaceFileDiffPi(
  relativePath: string,
  workingDirectory?: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<WorkspaceFileDiff> {
  if (!isTauri() && invokeFn === invoke) {
    return {
      relativePath,
      hasDiff: false,
      diff: '',
    };
  }

  const payload = {
    relativePath,
    workingDirectory: workingDirectory || undefined,
  };
  return await invokeFn<WorkspaceFileDiff>('get_workspace_file_diff', { payload });
}



/**
 * Fetch available models from active Pi session via Tauri IPC.
 */
export async function getAvailableModelsPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ModelInfo[]> {
  if (!isTauri() && invokeFn === invoke) {
    return [];
  }

  const result = await invokeFn<{ models?: ModelInfo[] } | ModelInfo[]>('get_available_models');
  if (Array.isArray(result)) {
    return result;
  }
  return result?.models ?? [];
}

/**
 * Switch active model in Pi session via Tauri IPC.
 */
export async function setModelPi(
  provider: string,
  modelId: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ModelInfo> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error('Desktop runtime unavailable: cannot set model outside Tauri');
  }

  return await invokeFn<ModelInfo>('set_model', { provider, modelId });
}

/**
 * Fetch available thinking / reasoning levels for current model via Tauri IPC.
 */
export async function getAvailableThinkingLevelsPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ThinkingLevel[]> {
  if (!isTauri() && invokeFn === invoke) {
    return [];
  }

  const result = await invokeFn<{ levels?: ThinkingLevel[] } | ThinkingLevel[]>(
    'get_available_thinking_levels'
  );
  if (Array.isArray(result)) {
    return result;
  }
  return result?.levels ?? [];
}

/**
 * Set thinking / reasoning level in current Pi session via Tauri IPC.
 */
export async function setThinkingLevelPi(
  level: ThinkingLevel,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<void> {
  if (!isTauri() && invokeFn === invoke) {
    return;
  }

  await invokeFn('set_thinking_level', { level });
}

/**
 * Fetch session token usage, cost, and context metrics via Tauri IPC.
 */
export async function getSessionStatsPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<SessionStats | null> {
  if (!isTauri() && invokeFn === invoke) {
    return null;
  }

  const result = await invokeFn<SessionStats>('get_session_stats');
  return result || null;
}

/**
 * Inspect active Pi session persistence status via Tauri IPC.
 */
export async function getSessionPersistenceStatusPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<SessionPersistenceStatus> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error(
      'Desktop runtime unavailable: cannot check session persistence outside Tauri'
    );
  }

  return await invokeFn<SessionPersistenceStatus>(
    'get_session_persistence_status'
  );
}

/**
 * Register bridge event listeners with React StrictMode-safe cleanup.
 */
export function registerBridgeListeners(
  listeners: BridgeEventListeners
): () => void {
  gentleMeshClient.setCallbacks({
    onEvent: (event) => listeners.onEvent(event),
    onStatusChange: (s) =>
      listeners.onStatusChange({
        state: s.state,
        label: s.label,
        detail: s.detail,
        model: null,
        cwd: null,
      }),
    onError: (err) => listeners.onError(err),
  });

  if (!isTauri()) {
    return () => {};
  }

  let isCancelled = false;
  const unlistenFns: UnlistenFn[] = [];

  const attachListener = async <T>(
    eventName: string,
    handler: (payload: T) => void
  ) => {
    try {
      const unlisten = await listen<T>(eventName, (event) => {
        if (!isCancelled) {
          handler(event.payload);
        }
      });

      if (isCancelled) {
        unlisten();
      } else {
        unlistenFns.push(unlisten);
      }
    } catch (err) {
      console.warn(`Failed to register listener for ${eventName}:`, err);
    }
  };

  // Attach all bridge listeners and track readiness
  const p1 = attachListener<RpcEventBase>('pi://event', listeners.onEvent);
  const p2 = attachListener<BridgeStatusPayload>(
    'pi://status-change',
    listeners.onStatusChange
  );
  const p3 = attachListener<BridgeErrorPayload>('pi://error', (payload) => {
    listeners.onError(payload.error);
  });

  bridgeListenersReady = Promise.all([p1, p2, p3]).then(() => {});

  return () => {
    isCancelled = true;
    for (const unlisten of unlistenFns) {
      try {
        unlisten();
      } catch {
        // Safe cleanup
      }
    }
    unlistenFns.length = 0;
  };
}

/**
 * Request opening a safe external URL via bounded Tauri command.
 * Invokes custom Tauri command open_external_url without exposing opener plugin to WebView.
 */
export async function openExternalUrlPi(
  url: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<void> {
  if (!isTauri() && invokeFn === invoke) {
    throw new Error(
      'Desktop runtime unavailable: running in browser preview without Tauri bridge'
    );
  }

  await invokeFn('open_external_url', { url });
}

export const MOCK_CUSTOM_PROVIDERS_STORAGE_KEY = 'pi_viewer_custom_providers_mock';

/**
 * Fetch configured custom model providers from ~/.pi/agent/models.json via Tauri IPC.
 */
export async function getCustomProvidersPi(
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ModelsConfigFile> {
  if (!isTauri() && invokeFn === invoke) {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(MOCK_CUSTOM_PROVIDERS_STORAGE_KEY);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {
          // Fallback to empty mock
        }
      }
    }
    return { providers: {} };
  }

  return await invokeFn<ModelsConfigFile>('get_custom_providers');
}

/**
 * Save custom model providers to ~/.pi/agent/models.json via Tauri IPC.
 */
export async function saveCustomProvidersPi(
  providers: CustomProvidersMap,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ModelsConfigFile> {
  if (!isTauri() && invokeFn === invoke) {
    const config: ModelsConfigFile = { providers };
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(MOCK_CUSTOM_PROVIDERS_STORAGE_KEY, JSON.stringify(config));
    }
    return config;
  }

  return await invokeFn<ModelsConfigFile>('save_custom_providers', { providers });
}

/**
 * Upsert a single custom model provider to models.json and propagate to Gentle Shell custom home if configured.
 */
export async function upsertCustomProviderPi(
  provider: CustomProviderConfig,
  cwd?: string | null,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ModelsConfigFile> {
  if (!isTauri() && invokeFn === invoke) {
    let currentConfig: ModelsConfigFile = { providers: {} };
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(MOCK_CUSTOM_PROVIDERS_STORAGE_KEY);
      if (stored) {
        try {
          currentConfig = JSON.parse(stored);
        } catch {
          // ignore
        }
      }
    }
    const currentProviders = (currentConfig.providers && typeof currentConfig.providers === 'object')
      ? { ...currentConfig.providers }
      : {};
    const { id, ...providerData } = provider;
    currentProviders[id] = providerData;
    currentConfig.providers = currentProviders;
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(MOCK_CUSTOM_PROVIDERS_STORAGE_KEY, JSON.stringify(currentConfig));
    }
    return currentConfig;
  }

  return await invokeFn<ModelsConfigFile>('upsert_custom_provider', {
    provider,
    providerId: provider.id,
    cwd: cwd || null,
  });
}

/**
 * Delete a single custom model provider from main Pi models.json only (does not delete from Gentle Shell).
 */
export async function deleteCustomProviderPi(
  providerId: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<ModelsConfigFile> {
  if (!isTauri() && invokeFn === invoke) {
    let currentConfig: ModelsConfigFile = { providers: {} };
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(MOCK_CUSTOM_PROVIDERS_STORAGE_KEY);
      if (stored) {
        try {
          currentConfig = JSON.parse(stored);
        } catch {
          // ignore
        }
      }
    }
    const currentProviders = (currentConfig.providers && typeof currentConfig.providers === 'object')
      ? { ...currentConfig.providers }
      : {};
    delete currentProviders[providerId];
    currentConfig.providers = currentProviders;
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(MOCK_CUSTOM_PROVIDERS_STORAGE_KEY, JSON.stringify(currentConfig));
    }
    return currentConfig;
  }

  return await invokeFn<ModelsConfigFile>('delete_custom_provider', {
    providerId,
    id: providerId,
  });
}

export const MOCK_MODEL_THINKING_LEVELS_STORAGE_KEY = 'pi_viewer_model_thinking_levels_mock';

export async function getModelThinkingLevelsPi(
  invokeFn = invoke
): Promise<ModelThinkingLevelsMap> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const stored = localStorage.getItem(MOCK_MODEL_THINKING_LEVELS_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as ModelThinkingLevelsMap) : {};
    } catch {
      return {};
    }
  }
  return await invokeFn<ModelThinkingLevelsMap>('get_model_thinking_levels');
}

export async function saveModelThinkingLevelsPi(
  levels: Record<string, ThinkingLevel | null>,
  invokeFn = invoke
): Promise<ModelThinkingLevelsMap> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const current = await getModelThinkingLevelsPi(invokeFn);
      for (const [k, v] of Object.entries(levels)) {
        if (v === null) {
          delete current[k];
        } else {
          current[k] = v;
        }
      }
      localStorage.setItem(MOCK_MODEL_THINKING_LEVELS_STORAGE_KEY, JSON.stringify(current));
      return current;
    } catch {
      return {};
    }
  }
  return await invokeFn<ModelThinkingLevelsMap>('save_model_thinking_levels', { levels });
}

/**
 * Prompt user to select a directory via Tauri native dialog.
 * In non-Tauri preview environments, returns null or mock without throwing.
 */
export async function pickDirectoryPi(
  defaultPath?: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke
): Promise<string | null> {
  if (!isTauri() && invokeFn === invoke) {
    return null;
  }

  try {
    const result = await invokeFn<string | null | undefined>('pick_directory', {
      defaultPath: defaultPath || null,
    });
    return result || null;
  } catch {
    return null;
  }
}

export const MOCK_MCP_SERVERS_STORAGE_KEY = 'pi_viewer_mcp_servers_mock';

/**
 * Fetch configured MCP servers from global (~/.pi/agent/mcp.json) and/or project configs via Tauri IPC.
 * In non-Tauri preview environments, falls back to mock storage or empty servers list.
 */
export async function getMcpServersPi(
  cwd?: string,
  invokeFn = invoke
): Promise<McpServersPayload> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const storage =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : typeof localStorage !== 'undefined'
            ? localStorage
            : null;
      if (storage) {
        const stored = storage.getItem(MOCK_MCP_SERVERS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            return { servers: parsed };
          }
          if (parsed && Array.isArray(parsed.servers)) {
            return parsed as McpServersPayload;
          }
        }
      }
    } catch {
      // Fallback to empty mock
    }
    return { servers: [] };
  }

  return await invokeFn<McpServersPayload>('get_mcp_servers', { cwd });
}

/**
 * Toggle an MCP server's enabled/disabled state via Tauri IPC.
 * In non-Tauri preview environments, updates mock storage.
 */
export async function toggleMcpServerPi(
  payload: ToggleMcpServerPayload,
  invokeFn = invoke
): Promise<ToggleMcpServerResult> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const current = await getMcpServersPi(payload.cwd, invokeFn);
      const existing = current.servers.find((s) => s.name === payload.name);

      let configPath: string;
      if (existing) {
        existing.enabled = payload.enabled;
        existing.disabled = !payload.enabled;
        if (payload.scope === 'project' && existing.scope === 'global') {
          existing.hasProjectOverride = true;
        } else if (payload.scope) {
          existing.scope = payload.scope;
        }
        configPath = existing.configPath;
      } else {
        const scope = payload.scope || (payload.cwd ? 'project' : 'global');
        configPath =
          scope === 'project'
            ? `${payload.cwd || '.'}/.pi/agent/mcp.json`
            : '~/.pi/agent/mcp.json';

        current.servers.push({
          name: payload.name,
          serverType: 'stdio',
          envKeys: [],
          disabled: !payload.enabled,
          enabled: payload.enabled,
          scope,
          hasProjectOverride: payload.scope === 'project' ? true : undefined,
          configPath,
        });
      }

      const storage =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : typeof localStorage !== 'undefined'
            ? localStorage
            : null;
      if (storage) {
        storage.setItem(MOCK_MCP_SERVERS_STORAGE_KEY, JSON.stringify(current));
      }

      return {
        success: true,
        name: payload.name,
        enabled: payload.enabled,
        path: configPath,
      };
    } catch {
      return {
        success: false,
        name: payload.name,
        enabled: payload.enabled,
        path: '',
      };
    }
  }

  return await invokeFn<ToggleMcpServerResult>('toggle_mcp_server', {
    name: payload.name,
    enabled: payload.enabled,
    cwd: payload.cwd,
    scope: payload.scope,
  });
}

/**
 * Save or update an MCP server definition via Tauri IPC.
 * In non-Tauri preview environments, updates mock storage.
 */
export async function saveMcpServerPi(
  payload: SaveMcpServerPayload,
  invokeFn = invoke
): Promise<SaveMcpServerResult> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const current = await getMcpServersPi(payload.cwd, invokeFn);
      const targetName = payload.name.trim();
      const oldName = payload.oldName?.trim();

      let existingIndex = -1;
      if (oldName && oldName !== targetName) {
        existingIndex = current.servers.findIndex((s) => s.name === oldName);
        if (existingIndex < 0) {
          existingIndex = current.servers.findIndex((s) => s.name === targetName);
        }
      } else {
        existingIndex = current.servers.findIndex((s) => s.name === targetName);
      }

      const existing = existingIndex >= 0 ? current.servers[existingIndex] : undefined;

      const scope: McpServerScope =
        payload.scope || existing?.scope || (payload.cwd ? 'project' : 'global');
      const targetPath =
        payload.scope
          ? payload.scope === 'project'
            ? `${payload.cwd || '.'}/.pi/agent/mcp.json`
            : '~/.pi/agent/mcp.json'
          : existing?.configPath ||
            (scope === 'project'
              ? `${payload.cwd || '.'}/.pi/agent/mcp.json`
              : '~/.pi/agent/mcp.json');

      const rawType = payload.server.type || payload.server.serverType;
      let serverType: McpServerType;
      if (rawType === 'stdio' || rawType === 'sse' || rawType === 'remote') {
        serverType = rawType;
      } else if (payload.server.command) {
        serverType = 'stdio';
      } else if (payload.server.url) {
        serverType = 'sse';
      } else {
        serverType = existing?.serverType || 'stdio';
      }

      const isDisabled =
        typeof payload.server.disabled === 'boolean'
          ? payload.server.disabled
          : typeof payload.server.enabled === 'boolean'
            ? !payload.server.enabled
            : existing?.disabled ?? false;
      const isEnabled = !isDisabled;

      const env = payload.server.env !== undefined ? payload.server.env : existing?.env;
      const envKeys = env ? Object.keys(env).sort() : existing?.envKeys || [];
      const headers =
        payload.server.headers !== undefined ? payload.server.headers : existing?.headers;

      const serverConfig: McpServerConfig = {
        name: targetName,
        serverType,
        envKeys,
        disabled: isDisabled,
        enabled: isEnabled,
        scope,
        configPath: targetPath,
      };

      if (env) {
        serverConfig.env = env;
      }
      if (headers) {
        serverConfig.headers = headers;
      }

      if (payload.server.url) {
        serverConfig.url = payload.server.url;
        if (payload.server.command) {
          serverConfig.command = payload.server.command;
          if (payload.server.args !== undefined) {
            serverConfig.args = payload.server.args;
          } else if (existing?.args) {
            serverConfig.args = existing.args;
          }
        }
      } else if (payload.server.command) {
        serverConfig.command = payload.server.command;
        serverConfig.args =
          payload.server.args !== undefined ? payload.server.args : existing?.args;
      } else if (existing) {
        if (existing.command) serverConfig.command = existing.command;
        if (existing.args) serverConfig.args = existing.args;
        if (existing.url) serverConfig.url = existing.url;
      }

      if (existingIndex >= 0) {
        current.servers[existingIndex] = serverConfig;
        if (oldName && oldName !== targetName) {
          current.servers = current.servers.filter(
            (s, idx) => idx === existingIndex || s.name !== targetName
          );
        }
      } else {
        current.servers.push(serverConfig);
      }

      const storage =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : typeof localStorage !== 'undefined'
            ? localStorage
            : null;
      if (storage) {
        storage.setItem(MOCK_MCP_SERVERS_STORAGE_KEY, JSON.stringify(current));
      }

      return {
        success: true,
        name: payload.name,
        path: targetPath,
      };
    } catch {
      return {
        success: false,
        name: payload.name,
        path: '',
      };
    }
  }

  return await invokeFn<SaveMcpServerResult>('save_mcp_server', {
    name: payload.name,
    oldName: payload.oldName,
    server: payload.server,
    cwd: payload.cwd,
    scope: payload.scope,
  });
}

/**
 * Delete an MCP server definition via Tauri IPC.
 * In non-Tauri preview environments, updates mock storage.
 */
export async function deleteMcpServerPi(
  payload: DeleteMcpServerPayload,
  invokeFn = invoke
): Promise<DeleteMcpServerResult> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const current = await getMcpServersPi(payload.cwd, invokeFn);
      const targetName = payload.name.trim();

      const existing =
        current.servers.find((s) => {
          if (payload.scope) {
            return s.name === targetName && s.scope === payload.scope;
          }
          return s.name === targetName;
        }) || current.servers.find((s) => s.name === targetName);

      const scope: McpServerScope =
        payload.scope || existing?.scope || (payload.cwd ? 'project' : 'global');
      const targetPath =
        payload.scope
          ? payload.scope === 'project'
            ? `${payload.cwd || '.'}/.pi/agent/mcp.json`
            : '~/.pi/agent/mcp.json'
          : existing?.configPath ||
            (scope === 'project'
              ? `${payload.cwd || '.'}/.pi/agent/mcp.json`
              : '~/.pi/agent/mcp.json');

      current.servers = current.servers.filter((s) => {
        if (payload.scope) {
          return !(s.name === targetName && s.scope === payload.scope);
        }
        return s.name !== targetName;
      });

      const storage =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : typeof localStorage !== 'undefined'
            ? localStorage
            : null;
      if (storage) {
        storage.setItem(MOCK_MCP_SERVERS_STORAGE_KEY, JSON.stringify(current));
      }

      return {
        success: true,
        name: payload.name,
        path: targetPath,
      };
    } catch {
      return {
        success: false,
        name: payload.name,
        path: '',
      };
    }
  }

  return await invokeFn<DeleteMcpServerResult>('delete_mcp_server', {
    name: payload.name,
    cwd: payload.cwd,
    scope: payload.scope,
  });
}

export const MOCK_PI_RESOURCES_STORAGE_KEY = 'pi_viewer_pi_resources_mock';

function getRawMockPiResources(storage: Storage | null): PiResourceEntry[] {
  if (!storage) return [];
  const stored = storage.getItem(MOCK_PI_RESOURCES_STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.resources)) {
      return parsed.resources;
    }
  } catch {
    // Fallback to empty list
  }
  return [];
}

/**
 * Fetch configured Pi extensions and packages across global and project scopes via Tauri IPC.
 * In non-Tauri preview environments, falls back to mock storage or empty list.
 */
export async function getPiResources(
  cwd?: string,
  invokeFn = invoke
): Promise<PiResourcesPayload> {
  if (!isTauri() && invokeFn === invoke) {
    try {
      const storage =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : typeof localStorage !== 'undefined'
            ? localStorage
            : null;
      if (storage) {
        const raw = getRawMockPiResources(storage);
        const globalResources = raw.filter((r) => r.scope !== 'project');
        const projectResources = raw.filter((r) => r.scope === 'project');

        if (cwd) {
          const merged: PiResourceEntry[] = [];
          const matchedProjectIndices = new Set<number>();

          for (const g of globalResources) {
            const gCopy: PiResourceEntry = {
              ...g,
              globalEnabled: g.enabled,
              sourceScope: 'global',
            };

            const pIdx = projectResources.findIndex((p, idx) => {
              if (matchedProjectIndices.has(idx)) return false;
              return (
                p.kind === g.kind &&
                resourceIdentitiesMatch(g.kind, g.source, p.source)
              );
            });

            if (pIdx >= 0) {
              matchedProjectIndices.add(pIdx);
              const p = projectResources[pIdx];
              gCopy.hasProjectOverride = true;
              gCopy.enabled = p.enabled;
              const gIsFile =
                gCopy.configPath.endsWith('.ts') || gCopy.configPath.endsWith('.js');
              if (p.configPath && !gIsFile) {
                gCopy.configPath = p.configPath;
              }
              if (p.autoload !== undefined) gCopy.autoload = p.autoload;
              if (p.filters !== undefined) gCopy.filters = p.filters;
              merged.push(gCopy);
            } else {
              gCopy.hasProjectOverride = false;
              gCopy.enabled = g.enabled;
              merged.push(gCopy);
            }
          }

          for (let idx = 0; idx < projectResources.length; idx++) {
            if (!matchedProjectIndices.has(idx)) {
              const p = projectResources[idx];
              merged.push({
                ...p,
                scope: 'project',
                sourceScope: 'project',
                hasProjectOverride: false,
              });
            }
          }

          return { resources: merged };
        }

        return {
          resources: globalResources.map((g) => ({
            ...g,
            globalEnabled: g.enabled,
            sourceScope: 'global',
            hasProjectOverride: false,
          })),
        };
      }
    } catch {
      // Fallback to empty mock
    }
    return { resources: [] };
  }

  return await invokeFn<PiResourcesPayload>('get_pi_resources', { cwd });
}

/**
 * Add or edit a Pi extension or package via Tauri IPC.
 * In non-Tauri preview environments, updates mock storage.
 */
export async function savePiResource(
  payload: SavePiResourcePayload,
  invokeFn = invoke
): Promise<SavePiResourceResult> {
  if (!isTauri() && invokeFn === invoke) {
    const validation = validateResourceSource(payload.kind, payload.source);
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid resource source');
    }

    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;
    const raw = getRawMockPiResources(storage);

    const targetScope: PiResourceScope =
      payload.scope || (payload.cwd ? 'project' : 'global');
    const targetPath =
      targetScope === 'project'
        ? `${payload.cwd || '.'}/.pi/settings.json`
        : '~/.pi/agent/settings.json';

    let cleanSource: string;
    try {
      cleanSource = normalizeTargetSource(payload.kind, payload.source);
    } catch {
      cleanSource =
        payload.kind === 'extension' &&
        (payload.source.trim().startsWith('!') || payload.source.trim().startsWith('+'))
          ? payload.source.trim().slice(1).trim()
          : payload.source.trim();
    }

    const enabled =
      payload.enabled ??
      (payload.kind === 'extension'
        ? !payload.source.trim().startsWith('!')
        : true);

    const checkSource = payload.oldSource
      ? (() => {
          try {
            return normalizeTargetSource(payload.kind, payload.oldSource);
          } catch {
            return payload.oldSource.trim();
          }
        })()
      : cleanSource;

    const existingIndex = raw.findIndex(
      (r) =>
        r.kind === payload.kind &&
        r.scope === targetScope &&
        resourceIdentitiesMatch(payload.kind, r.source, checkSource)
    );

    const id = normalizeResourceId(targetScope, payload.kind, cleanSource);
    const updatedEntry: PiResourceEntry = {
      id,
      name: deriveResourceName(payload.kind, cleanSource),
      kind: payload.kind,
      source: cleanSource,
      scope: targetScope,
      enabled,
      configPath: targetPath,
      raw: payload.raw,
      autoload: payload.kind === 'package' ? enabled : undefined,
    };

    if (existingIndex >= 0) {
      raw[existingIndex] = updatedEntry;
    } else {
      raw.push(updatedEntry);
    }

    if (storage) {
      storage.setItem(
        MOCK_PI_RESOURCES_STORAGE_KEY,
        JSON.stringify({ resources: raw })
      );
    }

    return {
      success: true,
      id,
      kind: payload.kind,
      source: cleanSource,
      scope: targetScope,
      configPath: targetPath,
      requiresReload: true,
    };
  }

  return await invokeFn<SavePiResourceResult>('save_pi_resource', {
    cwd: payload.cwd,
    scope: payload.scope,
    kind: payload.kind,
    source: payload.source,
    oldSource: payload.oldSource,
    enabled: payload.enabled,
    raw: payload.raw,
  });
}

/**
 * Toggle a Pi extension or package enabled/disabled state via Tauri IPC.
 * In non-Tauri preview environments, updates mock storage.
 */
export async function togglePiResource(
  payload: TogglePiResourcePayload,
  invokeFn = invoke
): Promise<TogglePiResourceResult> {
  if (!isTauri() && invokeFn === invoke) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;
    const raw = getRawMockPiResources(storage);

    let cleanTarget: string;
    try {
      cleanTarget = normalizeTargetSource(payload.kind, payload.source);
    } catch {
      cleanTarget =
        payload.kind === 'extension' &&
        (payload.source.trim().startsWith('!') || payload.source.trim().startsWith('+'))
          ? payload.source.trim().slice(1).trim()
          : payload.source.trim();
    }

    if (payload.scope === 'project' && payload.cwd) {
      const existingProjectIndex = raw.findIndex(
        (r) =>
          r.scope === 'project' &&
          r.kind === payload.kind &&
          resourceIdentitiesMatch(payload.kind, r.source, cleanTarget)
      );

      let resultId: string;
      let resultConfigPath: string;

      if (existingProjectIndex >= 0) {
        const existingProject = raw[existingProjectIndex];
        const isAutoOrGlobal =
          cleanTarget.startsWith('extensions/') ||
          raw.some(
            (r) =>
              r.scope !== 'project' &&
              resourceIdentitiesMatch(payload.kind, r.source, cleanTarget)
          );

        if (
          payload.kind === 'extension' &&
          payload.enabled &&
          !existingProject.enabled &&
          isAutoOrGlobal
        ) {
          resultId = existingProject.id;
          resultConfigPath = existingProject.configPath;
          raw.splice(existingProjectIndex, 1);
        } else {
          existingProject.enabled = payload.enabled;
          if (payload.kind === 'package') {
            existingProject.autoload = payload.enabled;
          }
          existingProject.source = cleanTarget;
          existingProject.hasProjectOverride = true;
          resultId = existingProject.id;
          resultConfigPath = existingProject.configPath;
        }
      } else {
        const id = normalizeResourceId('project', payload.kind, cleanTarget);
        const configPath = `${payload.cwd}/.pi/settings.json`;
        const newProjectEntry: PiResourceEntry = {
          id,
          name: deriveResourceName(payload.kind, cleanTarget),
          kind: payload.kind,
          source: cleanTarget,
          scope: 'project',
          enabled: payload.enabled,
          configPath,
          autoload: payload.kind === 'package' ? payload.enabled : undefined,
          hasProjectOverride: true,
        };
        raw.push(newProjectEntry);
        resultId = id;
        resultConfigPath = configPath;
      }

      if (storage) {
        storage.setItem(
          MOCK_PI_RESOURCES_STORAGE_KEY,
          JSON.stringify({ resources: raw })
        );
      }

      return {
        success: true,
        id: resultId,
        kind: payload.kind,
        source: cleanTarget,
        scope: 'project',
        enabled: payload.enabled,
        configPath: resultConfigPath,
        requiresReload: true,
      };
    }

    const existing = raw.find(
      (r) =>
        r.kind === payload.kind &&
        resourceIdentitiesMatch(payload.kind, r.source, cleanTarget) &&
        (!payload.scope || r.scope === payload.scope)
    );

    if (!existing) {
      throw new Error(`Resource '${payload.source}' not found`);
    }

    existing.enabled = payload.enabled;
    if (payload.kind === 'package') {
      existing.autoload = payload.enabled;
    }
    existing.source = cleanTarget;

    if (storage) {
      storage.setItem(
        MOCK_PI_RESOURCES_STORAGE_KEY,
        JSON.stringify({ resources: raw })
      );
    }

    return {
      success: true,
      id: existing.id,
      kind: existing.kind,
      source: cleanTarget,
      scope: existing.scope,
      enabled: payload.enabled,
      configPath: existing.configPath,
      requiresReload: true,
    };
  }

  return await invokeFn<TogglePiResourceResult>('toggle_pi_resource', {
    cwd: payload.cwd,
    scope: payload.scope,
    kind: payload.kind,
    source: payload.source,
    enabled: payload.enabled,
  });
}

/**
 * Delete a Pi extension or package via Tauri IPC.
 * In non-Tauri preview environments, removes it from mock storage.
 */
export async function deletePiResource(
  payload: DeletePiResourcePayload,
  invokeFn = invoke
): Promise<DeletePiResourceResult> {
  if (!isTauri() && invokeFn === invoke) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;
    const raw = getRawMockPiResources(storage);

    let cleanTarget: string;
    try {
      cleanTarget = normalizeTargetSource(payload.kind, payload.source);
    } catch {
      cleanTarget =
        payload.kind === 'extension' &&
        (payload.source.trim().startsWith('!') || payload.source.trim().startsWith('+'))
          ? payload.source.trim().slice(1).trim()
          : payload.source.trim();
    }

    const index = raw.findIndex((r) => {
      if (r.kind !== payload.kind) return false;
      if (!resourceIdentitiesMatch(payload.kind, r.source, cleanTarget)) return false;
      if (payload.scope) {
        return r.scope === payload.scope;
      }
      return true;
    });

    if (index === -1) {
      throw new Error(`Resource '${payload.source}' not found`);
    }

    const [removed] = raw.splice(index, 1);

    if (storage) {
      storage.setItem(
        MOCK_PI_RESOURCES_STORAGE_KEY,
        JSON.stringify({ resources: raw })
      );
    }

    return {
      success: true,
      id: removed.id,
      kind: removed.kind,
      source: cleanTarget,
      scope: removed.scope,
      configPath: removed.configPath,
      requiresReload: true,
    };
  }

  return await invokeFn<DeletePiResourceResult>('delete_pi_resource', {
    cwd: payload.cwd,
    scope: payload.scope,
    kind: payload.kind,
    source: payload.source,
  });
}

export const MOCK_SDD_PROFILES_STORAGE_KEY = 'pi_viewer_sdd_profiles_mock';
export const MOCK_SDD_GLOBAL_ACTIVE_PROFILE_KEY = 'pi_viewer_sdd_global_active_profile_mock';
export const MOCK_SDD_PROJECT_ACTIVE_PROFILE_PREFIX = 'pi_viewer_sdd_project_active_profile_mock:';
export const MOCK_SDD_INSTALLED_AGENTS_KEY = 'pi_mock_installed_agents';

interface StoredMockProfile extends Profile {
  scope?: ProfileScope;
  cwd?: string;
  path?: string;
}

function getStoredMockProfiles(storage: Storage | null): StoredMockProfile[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(MOCK_SDD_PROFILES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Ignore JSON parse errors in mock storage
  }
  return [];
}

/**
 * Fetch SDD profiles (global, project) and discovered subagents via Tauri IPC.
 * In non-Tauri preview environments, uses localStorage (defaulting to empty array []),
 * supporting project vs global isolation and automatic fallback.
 */
export async function getSddProfilesPi(
  cwd?: string,
  invokeFn = invoke
): Promise<ProfilesPayload> {
  if (!isTauri() && invokeFn === invoke) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;

    const storedCustom = getStoredMockProfiles(storage);

    const globalActive = storage?.getItem(MOCK_SDD_GLOBAL_ACTIVE_PROFILE_KEY) || null;
    const projectActive =
      cwd && storage
        ? storage.getItem(`${MOCK_SDD_PROJECT_ACTIVE_PROFILE_PREFIX}${cwd}`) || null
        : null;

    // Global custom profiles
    const globalSummaries: ProfileSummary[] = storedCustom
      .filter((p) => p.scope !== 'project')
      .map((p) => ({
        name: p.name,
        description: p.description,
        default_model: p.default_model,
        default_effort: p.default_effort,
        agent_count: Object.keys(p.model_profiles || {}).filter((k) => !isSyntheticAgentKey(k)).length,
        scope: 'global',
        is_active: false,
        path: p.path || `~/.pi/agent/profiles/${sanitizeProfileName(p.name)}.json`,
        model_profiles: p.model_profiles,
      }));

    // Project custom profiles (if cwd matches)
    const projectSummaries: ProfileSummary[] = storedCustom
      .filter((p) => p.scope === 'project' && (!cwd || !p.cwd || p.cwd === cwd))
      .map((p) => ({
        name: p.name,
        description: p.description,
        default_model: p.default_model,
        default_effort: p.default_effort,
        agent_count: Object.keys(p.model_profiles || {}).filter((k) => !isSyntheticAgentKey(k)).length,
        scope: 'project',
        is_active: false,
        path: p.path || `${cwd || '.'}/.pi/profiles/${sanitizeProfileName(p.name)}.json`,
        model_profiles: p.model_profiles,
      }));

    const allSummaries: ProfileSummary[] = [
      ...globalSummaries,
      ...projectSummaries,
    ];

    const effective = resolveEffectiveProfile(projectActive, globalActive, allSummaries);
    const sanitizedEffective = effective.name ? sanitizeProfileName(effective.name) : null;

    // Determine active profile index
    let chosenIdx = -1;
    if (sanitizedEffective) {
      if (projectActive) {
        chosenIdx = allSummaries.findIndex(
          (s) => sanitizeProfileName(s.name) === sanitizedEffective && s.scope === 'project'
        );
      } else if (globalActive) {
        chosenIdx = allSummaries.findIndex(
          (s) => sanitizeProfileName(s.name) === sanitizedEffective && s.scope === 'global'
        );
      }

      if (chosenIdx === -1) {
        chosenIdx = allSummaries.findIndex(
          (s) => sanitizeProfileName(s.name) === sanitizedEffective
        );
      }
    }

    allSummaries.forEach((s, idx) => {
      const isActive = idx === chosenIdx;
      s.is_active = isActive;
      s.active_scope = isActive
        ? projectActive
          ? 'project'
          : globalActive
            ? 'global'
            : undefined
        : undefined;
    });

    // Browser preview/mock: derive installed agents strictly from simulated installed-agent config
    // Saved profiles alone are legacy references and MUST NOT make an agent appear installed.
    let simulatedAgents: Array<DiscoveredAgentMeta | string> = [];
    if (storage) {
      try {
        const rawSimulated = storage.getItem(MOCK_SDD_INSTALLED_AGENTS_KEY);
        if (rawSimulated) {
          const parsed = JSON.parse(rawSimulated);
          if (Array.isArray(parsed)) {
            simulatedAgents = parsed;
          }
        }
      } catch {
        simulatedAgents = [];
      }
    }

    const categories = buildDynamicCategories(simulatedAgents);
    const allAgents = categories.flatMap((c) => c.agents);

    return {
      profiles: allSummaries,
      projectActiveProfile: projectActive,
      globalActiveProfile: globalActive,
      effectiveActiveProfile: effective.name,
      effectiveScope: effective.scope,
      categories,
      allAgents,
    };
  }

  return await invokeFn<ProfilesPayload>('get_sdd_profiles', { cwd });
}

/**
 * Save or update an SDD profile via Tauri IPC.
 * In non-Tauri preview environments, persists to localStorage.
 */
export async function saveSddProfilePi(
  payload: SaveProfilePayload,
  invokeFn = invoke
): Promise<{ success: boolean; profile?: Profile; path?: string; message: string }> {
  if (!isTauri() && invokeFn === invoke) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;

    const name = payload.profile?.name?.trim();
    if (!name) {
      throw new Error('Profile name is required and cannot be empty');
    }
    const sanitized = sanitizeProfileName(name);
    if (!sanitized) {
      throw new Error('Profile name contains only invalid characters');
    }

    const scope = payload.scope || 'global';
    const now = new Date().toISOString();

    const stored = getStoredMockProfiles(storage);
    const existingIdx = stored.findIndex(
      (p) =>
        sanitizeProfileName(p.name) === sanitized &&
        p.scope === scope &&
        (scope !== 'project' || p.cwd === payload.cwd)
    );

    const savedProfile: StoredMockProfile = {
      ...payload.profile,
      name,
      scope,
      cwd: scope === 'project' ? payload.cwd : undefined,
      path:
        scope === 'project'
          ? `${payload.cwd || '.'}/.pi/profiles/${sanitized}.json`
          : `~/.pi/agent/profiles/${sanitized}.json`,
      created_at:
        existingIdx !== -1 && stored[existingIdx].created_at
          ? stored[existingIdx].created_at
          : now,
      updated_at: now,
    };

    if (existingIdx !== -1) {
      stored[existingIdx] = savedProfile;
    } else {
      stored.push(savedProfile);
    }

    if (storage) {
      storage.setItem(MOCK_SDD_PROFILES_STORAGE_KEY, JSON.stringify(stored));
    }

    return {
      success: true,
      profile: savedProfile,
      path: savedProfile.path,
      message: `Profile '${name}' saved successfully`,
    };
  }

  return await invokeFn<{ success: boolean; profile?: Profile; path?: string; message: string }>(
    'save_sdd_profile',
    {
      cwd: payload.cwd,
      scope: payload.scope,
      profile: payload.profile,
    }
  );
}

/**
 * Delete an SDD profile via Tauri IPC.
 * In non-Tauri preview environments, removes from localStorage and clears .active if matched.
 */
export async function deleteSddProfilePi(
  payload: { cwd?: string; scope?: string; name: string },
  invokeFn = invoke
): Promise<{ success: boolean; message: string }> {
  if (!isTauri() && invokeFn === invoke) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;

    const trimmed = payload.name?.trim();
    if (!trimmed) {
      throw new Error('Profile name is required');
    }
    const sanitized = sanitizeProfileName(trimmed);

    const stored = getStoredMockProfiles(storage);
    const scope = payload.scope || 'global';

    const index = stored.findIndex((p) => {
      const matchName = sanitizeProfileName(p.name) === sanitized || p.name === trimmed;
      if (!matchName) return false;
      if (payload.scope) {
        if (p.scope !== payload.scope) return false;
      }
      if (p.scope === 'project' && payload.cwd) {
        return p.cwd === payload.cwd;
      }
      return true;
    });

    if (index === -1) {
      throw new Error(`Profile '${trimmed}' not found`);
    }

    stored.splice(index, 1);
    if (storage) {
      storage.setItem(MOCK_SDD_PROFILES_STORAGE_KEY, JSON.stringify(stored));

      // Clear active profile if it matched
      if (scope === 'project' && payload.cwd) {
        const key = `${MOCK_SDD_PROJECT_ACTIVE_PROFILE_PREFIX}${payload.cwd}`;
        const current = storage.getItem(key);
        if (current && (sanitizeProfileName(current) === sanitized || current === trimmed)) {
          storage.removeItem(key);
        }
      } else {
        const current = storage.getItem(MOCK_SDD_GLOBAL_ACTIVE_PROFILE_KEY);
        if (current && (sanitizeProfileName(current) === sanitized || current === trimmed)) {
          storage.removeItem(MOCK_SDD_GLOBAL_ACTIVE_PROFILE_KEY);
        }
      }
    }

    return {
      success: true,
      message: `Profile '${trimmed}' deleted successfully`,
    };
  }

  return await invokeFn<{ success: boolean; message: string }>('delete_sdd_profile', {
    cwd: payload.cwd,
    scope: payload.scope,
    name: payload.name,
  });
}

/**
 * Set or clear the active SDD profile via Tauri IPC.
 * In non-Tauri preview environments, persists active selection to localStorage.
 * Setting name=null clears the selection for that scope, allowing project to fall back to global.
 */
export async function setActiveSddProfilePi(
  payload: SetActiveProfilePayload,
  invokeFn = invoke
): Promise<{ success: boolean; message: string }> {
  if (!isTauri() && invokeFn === invoke) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;

    const cleanName = payload.name?.trim() || null;

    if (cleanName) {
      const storedCustom = getStoredMockProfiles(storage);
      const sanitized = sanitizeProfileName(cleanName);
      const exists = storedCustom.some((p) => {
        const matchesName =
          p.name === cleanName ||
          sanitizeProfileName(p.name) === sanitized ||
          p.name.toLowerCase() === cleanName.toLowerCase();
        if (!matchesName) return false;
        if (payload.scope === 'project') {
          return (
            (p.scope === 'project' && (!payload.cwd || !p.cwd || p.cwd === payload.cwd)) ||
            p.scope === 'global'
          );
        }
        return p.scope === 'global';
      });

      if (!exists) {
        return {
          success: false,
          message: `Profile '${cleanName}' not found`,
        };
      }
    }

    if (payload.scope === 'project') {
      const key = `${MOCK_SDD_PROJECT_ACTIVE_PROFILE_PREFIX}${payload.cwd || 'default'}`;
      if (cleanName) {
        storage?.setItem(key, cleanName);
        return {
          success: true,
          message: `Active profile set to '${cleanName}'`,
        };
      } else {
        storage?.removeItem(key);
        return {
          success: true,
          message: 'Active profile cleared',
        };
      }
    } else {
      const key = MOCK_SDD_GLOBAL_ACTIVE_PROFILE_KEY;
      if (cleanName) {
        storage?.setItem(key, cleanName);
        return {
          success: true,
          message: `Active profile set to '${cleanName}'`,
        };
      } else {
        storage?.removeItem(key);
        return {
          success: true,
          message: 'Active profile cleared',
        };
      }
    }
  }

  return await invokeFn<{ success: boolean; message: string }>('set_active_sdd_profile', {
    cwd: payload.cwd,
    scope: payload.scope,
    name: payload.name,
  });
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export const defaultInvoke: InvokeFn = invoke;

/**
 * Detect the active Engram project for a working directory via Tauri IPC.
 * Gracefully returns null if Engram is not installed, fails, or has no project.
 * In non-Tauri preview environments, returns null without throwing.
 */
export async function getEngramProjectPi(
  cwd?: string,
  invokeFn: InvokeFn = defaultInvoke
): Promise<string | null> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return null;
  }
  try {
    const res = await invokeFn<string | null>('get_engram_project', { cwd });
    return res ?? null;
  } catch {
    // Fail closed/safe: return null if engram is not installed or command fails
    return null;
  }
}

export interface EngramCloudStatus {
  configured: boolean;
  serverUrl?: string | null;
  authReady: boolean;
  enrolled?: boolean | null;
  daemonRunning: boolean;
  daemonPort?: number | null;
  phase?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  reasonCode?: string | null;
  rawDetails?: string | null;
  cloudPermitted?: boolean | null;
  cloudPermissionMessage?: string | null;
}

/**
 * Query Engram Cloud sync status for a project or working directory via Tauri IPC.
 * Gracefully returns null if Engram is not installed, fails, or has no cloud status.
 * In non-Tauri preview environments, returns null without throwing.
 */
export async function getEngramCloudStatusPi(
  project?: string,
  cwd?: string,
  invokeFn: InvokeFn = defaultInvoke
): Promise<EngramCloudStatus | null> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return null;
  }
  try {
    const res = await invokeFn<EngramCloudStatus | null>('get_engram_cloud_status', { project, cwd });
    return res ?? null;
  } catch {
    // Fail closed/safe: return null if engram is not installed or command fails
    return null;
  }
}

/**
 * Enroll a project in Engram Cloud via Tauri IPC.
 * Returns true if enrollment succeeded, or false if it failed or engram is not installed.
 * In non-Tauri preview environments, returns false without throwing.
 */
export async function enrollEngramProjectPi(
  project: string,
  cwd?: string,
  invokeFn: InvokeFn = defaultInvoke
): Promise<boolean> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return false;
  }
  try {
    const res = await invokeFn<boolean>('enroll_engram_project', { project, cwd });
    return Boolean(res);
  } catch {
    return false;
  }
}

export type DiscoveryStatus = 'discovered' | 'missing' | 'ambiguous';
export type EnvironmentStatus = 'ready' | 'missing' | 'ambiguous';

export interface DiscoverEnvironmentPayload {
  preferredEntrypoint?: string | null;
  preferredCwd?: string | null;
}

export interface DiscoveredEntrypoint {
  status: DiscoveryStatus;
  path: string | null;
  candidates: string[];
  message?: string | null;
}

export interface DiscoveredDirectory {
  status: DiscoveryStatus;
  path: string | null;
  message?: string | null;
}

export interface DiscoveredEnvironment {
  status: EnvironmentStatus;
  entrypoint: DiscoveredEntrypoint;
  initialDirectory: DiscoveredDirectory;
  nodePath: string | null;
  issues: string[];
}

export interface DetectGentleShellPayload {
  cwd?: string | null;
  workingDirectory?: string | null;
}

export interface DetectGentleShellResult {
  status: DiscoveryStatus;
  path: string | null;
  entrypoint?: string | null;
  candidates: string[];
  message?: string | null;
}

/**
 * Detect configured Gentle Shell entrypoint from gentle-pi package metadata in Pi settings.
 * In non-Tauri preview environments, returns safe missing status.
 */
export async function detectGentleShellPi(
  payload?: DetectGentleShellPayload,
  invokeFn: InvokeFn = defaultInvoke
): Promise<DetectGentleShellResult> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return {
      status: 'missing',
      path: null,
      entrypoint: null,
      candidates: [],
      message: 'Desktop runtime unavailable: running in browser preview',
    };
  }

  return await invokeFn<DetectGentleShellResult>('detect_gentle_shell', {
    payload: payload || undefined,
  });
}

/**
 * Discover host environment for Pi connection via Tauri IPC.
 * Discovers the Pi CLI JavaScript entrypoint and verified initial working directory.
 * Returns explicit 'discovered', 'missing', or 'ambiguous' statuses instead of guessing.
 * In non-Tauri preview environments, returns safe missing/unspecified status.
 */
export async function discoverEnvironmentPi(
  payload?: DiscoverEnvironmentPayload,
  invokeFn: InvokeFn = defaultInvoke
): Promise<DiscoveredEnvironment> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return {
      status: 'missing',
      entrypoint: {
        status: 'missing',
        path: null,
        candidates: [],
        message: 'Desktop runtime unavailable: running in browser preview',
      },
      initialDirectory: {
        status: 'missing',
        path: null,
        message: 'Desktop runtime unavailable: running in browser preview',
      },
      nodePath: null,
      issues: ['Running in browser preview without Tauri bridge'],
    };
  }

  return await invokeFn<DiscoveredEnvironment>('discover_environment', {
    payload: payload || undefined,
  });
}

/**
 * Format an actionable diagnostic message from a discovered environment result.
 */
export function formatDiscoveryDiagnostic(discovered: DiscoveredEnvironment): string {
  if (discovered.issues && discovered.issues.length > 0) {
    return discovered.issues.join('; ');
  }
  if (discovered.entrypoint.status === 'missing') {
    return (
      discovered.entrypoint.message ||
      'Pi CLI JavaScript entrypoint was not found on system PATH or common global directories. Please configure in Settings.'
    );
  }
  if (discovered.entrypoint.status === 'ambiguous') {
    return (
      discovered.entrypoint.message ||
      'Multiple Pi CLI installations found on system PATH; please select one in Settings.'
    );
  }
  if (discovered.initialDirectory.status === 'missing') {
    return (
      discovered.initialDirectory.message ||
      'No verified project directory detected; please select a project folder in Settings.'
    );
  }
  if (discovered.status === 'missing') {
    return 'Pi host environment configuration is incomplete. Please configure connection settings.';
  }
  return 'Pi host environment is not ready. Please review connection settings.';
}

/**
 * Retrieve list of built-in OAuth providers and their authentication status from Pi.
 * In non-Tauri preview environments, returns an empty list safely without throwing.
 */
export async function getBuiltinOAuthProvidersPi(
  invokeFn: InvokeFn = defaultInvoke
): Promise<BuiltinOAuthProviderStatus[]> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return [];
  }
  try {
    const res = await invokeFn<BuiltinOAuthProviderStatus[]>('get_builtin_oauth_providers');
    return res ?? [];
  } catch (err) {
    console.error('Failed to query built-in OAuth providers:', err);
    throw err;
  }
}

/**
 * Start an interactive OAuth sign-in flow for a built-in provider.
 * The backend manages spawning the isolated helper process and opens the browser.
 */
export async function startOAuthLoginPi(
  payload: StartOAuthLoginPayload,
  invokeFn: InvokeFn = defaultInvoke
): Promise<StartOAuthLoginResult> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return {
      started: false,
      providerId: payload.providerId,
      message: 'Desktop runtime unavailable: running in browser preview',
    };
  }
  return await invokeFn<StartOAuthLoginResult>('start_oauth_login', { payload });
}

/**
 * Cancel an active in-flight OAuth sign-in process.
 */
export async function cancelOAuthLoginPi(
  payload?: CancelOAuthLoginPayload,
  invokeFn: InvokeFn = defaultInvoke
): Promise<CancelOAuthLoginResult> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return {
      cancelled: false,
      message: 'Desktop runtime unavailable: running in browser preview',
    };
  }
  return await invokeFn<CancelOAuthLoginResult>('cancel_oauth_login', {
    payload: payload ?? undefined,
  });
}

/**
 * Send user response to an interactive OAuth prompt (select, text, secret, or manual code).
 */
export async function sendOAuthPromptResponsePi(
  payload: SendOAuthPromptResponsePayload,
  invokeFn: InvokeFn = defaultInvoke
): Promise<SendOAuthPromptResponseResult> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return { sent: false };
  }
  return await invokeFn<SendOAuthPromptResponseResult>('send_oauth_prompt_response', { payload });
}

/**
 * Log out of a built-in OAuth provider, removing stored credentials.
 */
export async function logoutOAuthProviderPi(
  payload: LogoutOAuthProviderPayload,
  invokeFn: InvokeFn = defaultInvoke
): Promise<LogoutOAuthProviderResult> {
  if (!isTauri() && invokeFn === defaultInvoke) {
    return {
      success: false,
      providerId: payload.providerId,
      message: 'Desktop runtime unavailable: running in browser preview',
    };
  }
  return await invokeFn<LogoutOAuthProviderResult>('logout_oauth_provider', { payload });
}

/**
 * Listen to allowlisted safe OAuth events emitted by the backend on "pi://oauth-event".
 * Must be subscribed before invoking start_oauth_login.
 */
export async function listenOAuthEventsPi(
  onEvent: (envelope: OAuthEventEnvelope) => void,
  listenFn: typeof listen = listen
): Promise<UnlistenFn> {
  if (!isTauri() && listenFn === listen) {
    return () => {};
  }
  return await listenFn<OAuthEventEnvelope>('pi://oauth-event', (event) => {
    if (event?.payload) {
      onEvent(event.payload);
    }
  });
}
