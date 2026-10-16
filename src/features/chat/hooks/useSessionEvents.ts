import { useEffect, useRef } from 'react';
import {
  discoverEnvironmentPi,
  formatDiscoveryDiagnostic,
  getSessionStatsPi,
  getWorkspaceGitStatusPi,
  registerBridgeListeners,
  type DiscoveredEnvironment,
  type DiscoverEnvironmentPayload,
} from '@infra/bridge';
import { SessionEventController, shouldRefreshWorkspaceOnEvent } from '@features/chat/session-events';
import type { ExtensionUiDialogAdapter } from '@core/protocol';
import type { ChatAction } from '@core/reducer';
import type { ConnectConfig } from '@core/types/connection';
import type { ExtensionUiRequest } from '@core/types/events';
import { isWindowsPath, normalizeWorkingDirectory } from '@core/session';

export interface ProjectItem {
  id: string;
  path: string;
  customName?: string;
  createdAt?: string;
  lastOpenedAt?: string;
}

function isSameProjectPath(pathA: string, pathB: string): boolean {
  const normA = normalizeWorkingDirectory(pathA);
  const normB = normalizeWorkingDirectory(pathB);
  if (!normA && !normB) return true;
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (isWindowsPath(normA) && isWindowsPath(normB)) {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return false;
}

function findProjectByCwd(
  projects: ProjectItem[],
  cwd?: string | null
): ProjectItem | undefined {
  if (!cwd) return undefined;
  return projects.find((p) => isSameProjectPath(p.path, cwd));
}

/** Resolve the event's own project; a background project need not be in the workspace cache. */
export async function resolveNotificationOriginName(
  cwd: string,
  projects: ProjectItem[],
  getGitStatus = getWorkspaceGitStatusPi,
): Promise<string> {
  const customName = findProjectByCwd(projects, cwd)?.customName?.trim();
  if (customName) return customName;
  try {
    const status = await getGitStatus(cwd);
    if (status.isRepo && status.repoName?.trim()) return status.repoName.trim();
  } catch {
    // A missing Git executable or disconnected bridge must not suppress the alert.
  }
  return cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || cwd;
}

export interface UseSessionEventsOptions {
  /** Fresh every render; the controller reads it through a per-render mirror ref
   * (SessionEventController's getCurrentConfig() needs the current value, not a stale
   * closure - see the class doc comment in session-events.ts). */
  config: ConnectConfig;
  /** Fresh every render, same reasoning as `config`. */
  sessionId: string | null;
  projectSessionIds?: Record<string, string | null>;
  projects?: ProjectItem[];
  activeProjectId?: string | null;
  dispatch: (action: ChatAction & { targetProjectId?: string }) => void;
  /**
   * Real branching this hook must not import the workspace feature to perform (T5 plan:
   * "the session-events hook must take an onWorkspaceChanged callback"). App.tsx wires
   * this to useWorkspaceView's requestFileTreeRefresh.
   */
  onWorkspaceChanged: () => void;
  /** Forwarded to the connection cluster's setStorageWarning; this hook never imports it. */
  onStorageWarning: (warning: string) => void;
  /**
   * Imperative connection primitives from the connection cluster (useConnection),
   * injected rather than imported, since features must not import each other. This hook
   * owns the mount effect that registers bridge listeners AND kicks off automatic
   * startup, because both halves were already fused in the original code
   * (sessionEventControllerRef.asBridgeListeners() alongside startConnection/
   * cancelConnection) and splitting them would only have added a callback to shuttle
   * listeners through App.tsx for no behavior gain.
   */
  startConnection: (
    config: ConnectConfig,
    options?: { force?: boolean; freshSession?: boolean }
  ) => Promise<void>;
  cancelConnection: () => void;
  /** Optional React-backed dialog adapter for interactive select/input/confirm requests */
  dialogAdapter?: ExtensionUiDialogAdapter;
  /** Optional dependency-injected discovery function (defaults to discoverEnvironmentPi) */
  discoverEnvironmentFn?: (
    payload?: DiscoverEnvironmentPayload
  ) => Promise<DiscoveredEnvironment>;
  /** Optional readiness predicate override */
  isConfigReadyFn?: (cfg: ConnectConfig) => boolean;
  /** Optional callback fired when discovery finishes resolving an environment */
  onDiscoverySettled?: (
    discovered: DiscoveredEnvironment,
    resolvedConfig?: ConnectConfig
  ) => void;
  /**
   * Called when automatic startup cannot proceed due to missing or incomplete configuration.
   * Allows the application to open the Settings onboarding panel and prefill partial discovery results.
   */
  onMissingConfiguration?: (params: {
    diagnostic: string;
    partialConfig: Partial<ConnectConfig>;
    discovered?: DiscoveredEnvironment;
  }) => void;
}

export interface AutoStartResult {
  started: boolean;
  config?: ConnectConfig;
  error?: string;
  cancelled?: boolean;
  partialConfig?: Partial<ConnectConfig>;
}

/**
 * Default readiness checker when isConfigReadyFn is not injected.
 * Requires absolute paths for both JS entrypoint (.js, .mjs, .cjs) and working directory.
 */
export function isConfigReady(config: unknown): config is ConnectConfig {
  if (!config || typeof config !== 'object') return false;
  const raw = config as Record<string, unknown>;
  if (typeof raw.nodePath !== 'string' || !raw.nodePath.trim()) return false;
  if (typeof raw.piEntrypoint !== 'string' || !raw.piEntrypoint.trim()) return false;
  const entry = raw.piEntrypoint.trim();
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(entry)) return false;
  const extMatch = entry.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (ext !== 'js' && ext !== 'mjs' && ext !== 'cjs') return false;
  if (typeof raw.workingDirectory !== 'string' || !raw.workingDirectory.trim()) return false;
  const cwd = raw.workingDirectory.trim();
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(cwd)) return false;
  return true;
}

export async function executeAutoStart({
  config,
  isCancelled,
  isConfigReadyFn,
  discoverEnvironmentFn,
  startConnection,
  dispatch,
  targetProjectId,
  onDiscoverySettled,
  onMissingConfiguration,
}: {
  config: ConnectConfig;
  isCancelled: () => boolean;
  isConfigReadyFn?: (cfg: ConnectConfig) => boolean;
  discoverEnvironmentFn?: (payload?: DiscoverEnvironmentPayload) => Promise<DiscoveredEnvironment>;
  startConnection: (cfg: ConnectConfig) => Promise<void>;
  dispatch: (action: ChatAction & { targetProjectId?: string }) => void;
  targetProjectId?: string;
  onDiscoverySettled?: (discovered: DiscoveredEnvironment, resolvedConfig?: ConnectConfig) => void;
  onMissingConfiguration?: (params: {
    diagnostic: string;
    partialConfig: Partial<ConnectConfig>;
    discovered?: DiscoveredEnvironment;
  }) => void;
}): Promise<AutoStartResult> {
  // 1. If config already has valid paths (e.g. preserved saved settings), connect directly.
  const readyChecker = isConfigReadyFn ?? isConfigReady;
  const isReady = readyChecker(config);

  if (isReady) {
    if (!isCancelled()) {
      void startConnection(config);
      return { started: true, config };
    }
    return { started: false, cancelled: true };
  }

  // 2. Initial async discovery: resolve portable environment without guessing or fabricating paths.
  try {
    const discoverFn = discoverEnvironmentFn ?? discoverEnvironmentPi;
    const payload: DiscoverEnvironmentPayload = {
      preferredEntrypoint: config.piEntrypoint?.trim() || undefined,
      preferredCwd: config.workingDirectory?.trim() || undefined,
    };

    const discovered = await discoverFn(payload);

    if (isCancelled()) {
      return { started: false, cancelled: true };
    }

    // 3. Connect only if environment is fully ready with verified entrypoint and working directory.
    if (
      discovered.status === 'ready' &&
      discovered.entrypoint.status === 'discovered' &&
      discovered.entrypoint.path &&
      discovered.initialDirectory.status === 'discovered' &&
      discovered.initialDirectory.path
    ) {
      const readyConfig: ConnectConfig = {
        nodePath: discovered.nodePath || config.nodePath || 'node',
        piEntrypoint: discovered.entrypoint.path,
        workingDirectory: discovered.initialDirectory.path,
        fileTreeRefreshInterval: config.fileTreeRefreshInterval ?? 15,
      };

      // Validate returned readyConfig before connecting
      if (!readyChecker(readyConfig)) {
        const diagnostic = formatDiscoveryDiagnostic(discovered);
        if (!isCancelled()) {
          onDiscoverySettled?.(discovered);
          onMissingConfiguration?.({ diagnostic, partialConfig: {}, discovered });
          dispatch({
            type: 'CONNECT_FAIL',
            targetProjectId,
            payload: { error: diagnostic },
          });
          return { started: false, error: diagnostic, partialConfig: {} };
        }
        return { started: false, cancelled: true };
      }

      if (!isCancelled()) {
        onDiscoverySettled?.(discovered, readyConfig);
        void startConnection(readyConfig);
        return { started: true, config: readyConfig };
      }
      return { started: false, cancelled: true };
    }

    // 4. Incomplete or ambiguous environment: do NOT auto-connect to guessed location.
    // Build partial config from discovery to assist onboarding without overwriting user edits.
    const partialConfig: Partial<ConnectConfig> = {};
    if (discovered.nodePath) {
      partialConfig.nodePath = discovered.nodePath;
    }
    if (discovered.entrypoint.status === 'discovered' && discovered.entrypoint.path) {
      partialConfig.piEntrypoint = discovered.entrypoint.path;
    }
    if (discovered.initialDirectory.status === 'discovered' && discovered.initialDirectory.path) {
      partialConfig.workingDirectory = discovered.initialDirectory.path;
    }

    const diagnostic = formatDiscoveryDiagnostic(discovered);
    if (!isCancelled()) {
      onDiscoverySettled?.(discovered);
      onMissingConfiguration?.({ diagnostic, partialConfig, discovered });
      dispatch({
        type: 'CONNECT_FAIL',
        targetProjectId,
        payload: { error: diagnostic },
      });
      return { started: false, error: diagnostic, partialConfig };
    }
    return { started: false, cancelled: true };
  } catch (err) {
    if (isCancelled()) {
      return { started: false, cancelled: true };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    const diagnostic = `Environment discovery failed: ${errorMsg}`;
    onMissingConfiguration?.({ diagnostic, partialConfig: {} });
    dispatch({
      type: 'CONNECT_FAIL',
      targetProjectId,
      payload: { error: diagnostic },
    });
    return { started: false, error: diagnostic, partialConfig: {} };
  }
}

/**
 * Owns the session-events cluster: the SessionEventController instance (fresh-value
 * mirror refs, dispatch wrapping for workspace refresh), and the mount effect that
 * registers bridge listeners and starts the automatic connection.
 *
 * The controller itself is pure/framework-agnostic and already extensively tested in
 * tests/core/protocol.test.ts; this hook is thin React glue with no logic of its own
 * beyond wiring (see odd/tasks/architecture-restructure.md, T5 plan: pure controllers
 * plus thin hooks).
 */
export function useSessionEvents({
  config,
  sessionId,
  projectSessionIds,
  projects,
  activeProjectId,
  dispatch,
  onWorkspaceChanged,
  onStorageWarning,
  startConnection,
  cancelConnection,
  dialogAdapter,
  isConfigReadyFn,
  discoverEnvironmentFn,
  onDiscoverySettled,
  onMissingConfiguration,
}: UseSessionEventsOptions): (requests: ExtensionUiRequest[]) => void {
  // Dynamic references avoiding stale closures in bridge listeners.
  const configRef = useRef<ConnectConfig>(config);
  configRef.current = config;
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const projectSessionIdsRef = useRef(projectSessionIds);
  projectSessionIdsRef.current = projectSessionIds;
  const projectsRef = useRef<ProjectItem[]>(projects ?? []);
  projectsRef.current = projects ?? [];
  const activeProjectIdRef = useRef<string | null>(activeProjectId ?? null);
  activeProjectIdRef.current = activeProjectId ?? null;
  const dialogAdapterRef = useRef<ExtensionUiDialogAdapter | undefined>(dialogAdapter);
  dialogAdapterRef.current = dialogAdapter;

  // Wrapped event dispatcher to reactively trigger workspace updates upon tool completion.
  const handleEventDispatch = (action: ChatAction & { targetProjectId?: string }) => {
    dispatch(action);
    if (shouldRefreshWorkspaceOnEvent(action)) {
      onWorkspaceChanged();
    }
  };

  // Session event controller orchestrating RPC events and authoritative persistence checks.
  const sessionEventControllerRef = useRef<SessionEventController | null>(null);
  if (!sessionEventControllerRef.current) {
    sessionEventControllerRef.current = new SessionEventController({
      getCurrentConfig: () => configRef.current,
      getCurrentSessionId: () => sessionIdRef.current,
      resolveNotificationOriginName: (cwd) => resolveNotificationOriginName(cwd, projectsRef.current),
      getProjectSessionId: (projectId) => projectSessionIdsRef.current
        ? projectSessionIdsRef.current[projectId] ?? null
        : sessionIdRef.current,
      dispatch: handleEventDispatch,
      refreshSessionStatsFn: () => getSessionStatsPi(),
      onStorageWarning: (warning) => onStorageWarning(warning),
      dialogAdapter: {
        select: (req) =>
          dialogAdapterRef.current ? dialogAdapterRef.current.select(req) : null,
        input: (req) =>
          dialogAdapterRef.current ? dialogAdapterRef.current.input(req) : null,
        confirm: (req) =>
          dialogAdapterRef.current ? dialogAdapterRef.current.confirm(req) : null,
        cancelPending: (cwd, activeCwd) => {
          dialogAdapterRef.current?.cancelPending?.(cwd, activeCwd);
        },
      },
      resolveTargetProjectId: (cwd?: string) => {
        if (!cwd) return activeProjectIdRef.current ?? undefined;
        const matched = findProjectByCwd(projectsRef.current, cwd);
        return matched?.id ?? activeProjectIdRef.current ?? undefined;
      },
    });
  }

  // Automatic Pi startup with React StrictMode-safe listener registration and attempt
  // lifecycle. Empty dependency array: registers listeners and kicks off the connection
  // exactly once per mount, closing over whichever `config` value was current at that
  // first render (mount-only capture, unchanged from the pre-extraction behavior).
  useEffect(() => {
    let isCancelled = false;

    // Immediately register bridge listeners on mount so no events are dropped.
    const listeners = sessionEventControllerRef.current!.asBridgeListeners();
    const unlisten = registerBridgeListeners(listeners);

    // Avoid project identity mismatch: only target a project if config.workingDirectory matches a known project.
    // Never fall back to activeProjectId when workingDirectory is unconfigured or unmatched!
    const matchedProject = config.workingDirectory
      ? findProjectByCwd(projectsRef.current, config.workingDirectory)
      : undefined;
    const targetProjectId = matchedProject?.id;

    const initialConfig = config;
    // Guard against auto-discovery race: if user applies settings while discovery is in-flight, invalidate discovery
    const isDiscoveryCancelled = () =>
      isCancelled ||
      (configRef.current !== initialConfig &&
        (configRef.current.piEntrypoint !== initialConfig.piEntrypoint ||
          configRef.current.workingDirectory !== initialConfig.workingDirectory ||
          configRef.current.nodePath !== initialConfig.nodePath));

    void executeAutoStart({
      config,
      isCancelled: isDiscoveryCancelled,
      isConfigReadyFn,
      discoverEnvironmentFn,
      startConnection,
      dispatch,
      targetProjectId,
      onDiscoverySettled,
      onMissingConfiguration,
    });

    return () => {
      isCancelled = true;
      cancelConnection();
      unlisten();
      sessionEventControllerRef.current?.cancelPendingDialogRequests(undefined, Boolean((window as any).__IS_WEB_IPC__));
    };
    // Intentionally empty: mount-only registration/startup, matching the pre-extraction
    // effect exactly (this repository has no ESLint step to satisfy or suppress).
  }, []);

  return (requests) => {
    for (const request of requests) void sessionEventControllerRef.current?.handleExtensionUiRequest(request);
  };
}
