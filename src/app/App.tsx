import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  getCustomProvidersPi,
  disconnectPi,
  getSddProfilesPi,
  saveMcpServerPi,
  deleteMcpServerPi,
} from '@infra/bridge';
import { ProjectDock } from '@features/projects/ProjectDock';
import { mapProvidersToArray, resolveModelDefaultThinkingLevel } from '@features/providers/providers';
import { isConfigReady, validateConnectConfig } from '@features/settings/config';
import { canRetryConnection } from '@features/settings/connection';
import {
  formatLocalizedDiagnostic,
  formatLocalizedStatus,
  formatLocalizedStatusDetail,
  type TranslationKey,
} from '@shared/i18n';
import {
  ThinkingCard,
  ToolCard,
} from '@features/chat/ActivityBlocks';
import { ProcessGroupCard } from '@features/chat/ProcessGroupCard';
import {
  MarkdownContent,
  shouldRenderAsMarkdown,
} from '@features/chat/MarkdownContent';
import { groupMessageBlocks, mergeConsecutiveAssistantMessages } from '@core/process-grouping';
import {
  loadCompactProcessesPreference,
  saveCompactProcessesPreference,
} from '@shared/compact-processes';
import { PromptControls } from '@features/chat/PromptControls';
import {
  isMessageEmpty,
  calculateContextMetrics,
  buildInsertCodeDraft,
} from '@core/prompt-controls-utils';
import {
  multiProjectChatReducer,
  createInitialMultiProjectState,
  getActiveProjectState,
} from '@core/reducer';
import { hydrateChatMessages } from '@core/session';
import { SessionSidebar } from '@features/sessions/SessionSidebar';
import { SettingsView } from '@features/settings/SettingsView';
import { FileTree } from '@features/workspace/FileTree';
import { FileViewerModal } from '@features/workspace/FileViewerModal';
import { ProvidersView } from '@features/providers/ProvidersView';
import { McpView } from '@features/mcp/McpView';
import { ExtensionsView } from '@features/extensions/ExtensionsView';
import { ProfilesView } from '@features/profiles/ProfilesView';
import {
  applyProfileRuntime,
  PROFILE_ACTIVATED_EVENT,
  PROFILE_CLEARED_EVENT,
  type ProfileSummary,
  type ProfileActivationEventDetail,
} from '@core/types/profiles';
import { ProfileModal } from '@features/profiles/components/ProfileModal';
import { useProfiles } from '@features/profiles/hooks/useProfiles';
import { STATUS_CONFIG, type AppStatusState } from '@core/icon-status';
import {
  triggerTauriWindowAttention,
  updateFavicon,
  updateWindowTitle,
} from '@infra/icon-status';
import type { ConnectConfig, ConnectResult } from '@core/types/connection';
import { useWorkspaceView } from '@features/workspace/hooks/useWorkspaceView';
import { normalizeWorkspaceKey } from '@features/workspace/workspace-cache';
import { useChatScroll } from '@features/chat/hooks/useChatScroll';
import { useSessionEvents } from '@features/chat/hooks/useSessionEvents';
import { useEngramProject } from '@features/chat/hooks/useEngramProject';
import {
  useExtensionUiDialog,
  type AnsweredQuestionRecord,
} from '@features/chat/hooks/useExtensionUiDialog';
import { ExtensionUiPromptBar } from '@features/chat/components/ExtensionUiPromptBar';
import { usePreferences } from '@features/settings/hooks/usePreferences';
import { useConnection } from '@features/settings/hooks/useConnection';
import { useProjects } from '@features/projects/hooks/useProjects';
import {
  findProjectByCwd,
  getProjectDisplayName,
  type ProjectItem,
  type ProjectStatusInfo,
  loadProjectsRegistry,
} from '@features/projects/projects';
import { useSessions } from '@features/sessions/hooks/useSessions';
import { usePromptState } from '@features/chat/hooks/usePromptState';
import { useModels } from '@features/providers/hooks/useModels';
import { useMcpServers } from '@features/mcp/hooks/useMcpServers';
import { usePiResources } from '@features/extensions/hooks/usePiResources';

export const App: React.FC = () => {
  const [multiProjectState, multiDispatch] = useReducer(
    multiProjectChatReducer,
    loadProjectsRegistry(undefined, undefined).registry.activeProjectId,
    createInitialMultiProjectState
  );
  const state = getActiveProjectState(multiProjectState);
  const dispatch = multiDispatch;

  // Moved up from its original position (still right after useChatScroll in behavior
  // terms - these are plain derived consts, not hooks, so relocating them earlier has no
  // effect on hook or effect registration order) so `isBusy` is available for useProjects
  // below without forcing useProjects to depend on the reducer directly.
  const isConnected = state.connectionStatus === 'connected';
  const isConnecting = state.connectionStatus === 'connecting';
  const isBusy = state.agentActivity === 'busy';
  const isReadyToSend = isConnected && state.isHydrated && !isBusy && !state.isResetting;
  // Separate readiness for queuing a follow-up while the agent is busy: same connection/
  // hydration/reset guards as isReadyToSend, but requires isBusy instead of excluding it.
  const canQueue = isConnected && state.isHydrated && isBusy && !state.isResetting;
  const { isHighContext } = calculateContextMetrics(state.sessionStats, state.modelInfo, state.availableModels);

  // Separate Settings draft state for connection configuration. settingsDraft's initial
  // value depends on `config`, which now comes from useConnection below, so its
  // declaration moves there too; the other settings-panel state is independent and stays.
  const [showSettings, setShowSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStorageNotice, setSettingsStorageNotice] = useState<string | null>(null);

  // Compact process view toggle (Issue #8): when on, consecutive thinking/tool_call
  // blocks within an assistant turn render as a single ProcessGroupCard instead of one
  // card per block. Persisted to localStorage; read lazily so it survives reloads.
  const [compactProcesses, setCompactProcesses] = useState<boolean>(() =>
    loadCompactProcessesPreference()
  );
  const handleToggleCompactProcesses = useCallback(() => {
    setCompactProcesses((prev) => {
      const next = !prev;
      saveCompactProcessesPreference(next);
      return next;
    });
  }, []);

  const {
    chatViewportRef,
    showScrollBottom,
    handleViewportScroll,
    handleScrollToBottom,
    pinAndHide,
    scrollToBottomNextFrame,
    pinAndJumpToBottom,
  } = useChatScroll({
    messages: state.messages,
    sessionId: state.sessionId,
    showSettings,
  });

  // Prompt cluster: draft text, send/abort, and the Enter-to-send binding.
  // `pinAndJumpToBottom` is T5a's scroll primitive, injected here rather
  // than imported by the hook itself.
  const {
    prompt,
    setPrompt,
    attachedFiles,
    addAttachedFiles,
    removeAttachedFile,
    handleSend,
    handleAbort,
    handleKeyDown,
  } = usePromptState({
    isReadyToSend,
    isBusy,
    canQueue,
    pendingPromptId: state.pendingPromptId,
    dispatch,
    pinAndJumpToBottom,
    messages: state.messages,
  });

  // Pure wrapper handing MarkdownContent's per-code-card "Insert into prompt" button a way
  // to append a fenced snippet to the prompt draft (Issue #7); the actual wrap/append logic
  // is core-pure (`buildInsertCodeDraft`).
  const insertCodeIntoPrompt = useCallback(
    (code: string, language?: string) => {
      setPrompt((prev) => buildInsertCodeDraft(prev, code, language));
    },
    [setPrompt]
  );

  // Connection cluster: persisted ConnectConfig, the connection-load storage warning, and
  // the StartupManager instance (attempt lifecycle, coalescing, retry). The onConnect*
  // callbacks are captured once by useConnection at first construction, exactly matching
  // this component's previous mount-frozen closures over `dispatch`/`pinAndJumpToBottom`.
  const {
    config,
    storageWarning,
    setStorageWarning,
    startConnection,
    cancelConnection,
    retryConnection,
    applyConfig,
    applyWorkingDirectory,
  } = useConnection({
    onConnectStart: (cfg: ConnectConfig) => {
      const matched = cfg.workingDirectory
        ? findProjectByCwd(projectsRegistryRef.current.projects, cfg.workingDirectory)
        : undefined;
      const targetProjectId = matched?.id;

      if (targetProjectId) {
        const targetState = multiProjectStateRef.current.projects[targetProjectId];
        if (targetState?.connectionStatus === 'connected' && targetState?.isHydrated === true) {
          return;
        }
      }

      dispatch({
        type: 'CONNECT_START',
        targetProjectId,
      });
    },
    onConnectSuccess: (res: ConnectResult) => {
      const matched = res.canonicalCwd
        ? findProjectByCwd(projectsRegistryRef.current.projects, res.canonicalCwd)
        : undefined;
      let targetProjectId = matched?.id;

      if (!targetProjectId && res.canonicalCwd) {
        addProjectForPath(res.canonicalCwd);
        const recheck = findProjectByCwd(
          projectsRegistryRef.current.projects,
          res.canonicalCwd
        );
        targetProjectId = recheck?.id ?? projectsRegistryRef.current.activeProjectId ?? undefined;
      } else if (!targetProjectId) {
        targetProjectId = projectsRegistryRef.current.activeProjectId ?? undefined;
      }

      if (targetProjectId) {
        const targetState = multiProjectStateRef.current.projects[targetProjectId];
        if (
          targetState?.isHydrated === true &&
          (targetState.messages.length > 0 || targetState.agentActivity === 'busy')
        ) {
          if (targetState.connectionStatus !== 'connected') {
            dispatch({
              type: 'CONNECT_SUCCESS',
              targetProjectId,
              payload: { model: res.model },
            });
          }
          return;
        }
      }

      const hydrated = hydrateChatMessages(res.messages ?? []);
      dispatch({
        type: 'SESSION_READY',
        targetProjectId,
        payload: {
          sessionId: res.sessionId,
          sessionFile: res.sessionFile,
          messages: hydrated,
          model: res.model,
          detail:
            hydrated.length > 0
              ? `Resumed session (${hydrated.length} messages)`
              : 'Connected to fresh session',
        },
      });
      if (targetProjectId === projectsRegistryRef.current.activeProjectId) {
        pinAndJumpToBottom();
      }
    },
    onConnectError: (err: string, cfg?: ConnectConfig) => {
      const matched = cfg?.workingDirectory
        ? findProjectByCwd(projectsRegistryRef.current.projects, cfg.workingDirectory)
        : undefined;
      const targetProjectId = matched?.id;
      dispatch({
        type: 'CONNECT_FAIL',
        targetProjectId,
        payload: { error: err },
      });
    },
    onConfigApplied: (updatedConfig, outcome) => {
      setSettingsDraft(updatedConfig);
      setSettingsError(null);
      setShowSettings(false);
      setSettingsStorageNotice(outcome.settingsStorageNotice);
    },
  });

  const {
    viewingFile,
    openFile,
    closeFile,
    fileTreeRefreshTrigger,
    requestFileTreeRefresh,
    gitChangesCount,
    handleGitStatusChange,
  } = useWorkspaceView({
    workingDirectory: config.workingDirectory,
    refreshInterval: config.fileTreeRefreshInterval,
  });

  // settingsDraft's initial value depends on `config`, now sourced from useConnection above.
  const [settingsDraft, setSettingsDraft] = useState<ConnectConfig>(config);

  // UI preferences (Language & Theme), separate from connection settings.
  // Owns preferences state, the document-language and theme-sync effects,
  // the PreferencesController wiring, and the `t` translate helper.
  const {
    preferences,
    preferencesWarning,
    dismissPreferencesWarning,
    handleThemeChange,
    handleLanguageChange,
    setNotifications,
    t,
  } = usePreferences();

  // Projects cluster: registry state and handlers. Real decision logic (already-active/
  // isBusy no-op guard, and whether removing the active project should switch the working
  // directory) lives in the pure decideSelectProject/decideRemoveProject; this hook is
  // thin glue delegating the actual working-directory switch to the connection cluster's
  // applyWorkingDirectory (the inversion this slice exists to make).
  const {
    projectsRegistry,
    handleSelectProject,
    handleAddProject,
    handleRenameProject,
    handleRemoveProject,
    addProjectForPath,
  } = useProjects({
    workingDirectory: config.workingDirectory,
    isBusy,
    applyWorkingDirectory,
  });

  const projectsRegistryRef = useRef(projectsRegistry);
  projectsRegistryRef.current = projectsRegistry;
  const multiProjectStateRef = useRef(multiProjectState);
  multiProjectStateRef.current = multiProjectState;

  const handleSelectProjectAndSync = useCallback(
    (project: ProjectItem) => {
      dispatch({ type: 'SET_ACTIVE_PROJECT', payload: { projectId: project.id } });
      handleSelectProject(project);
    },
    [dispatch, handleSelectProject]
  );

  const handleRemoveProjectAndSync = useCallback(
    (projectId: string) => {
      dispatch({ type: 'REMOVE_PROJECT_STATE', payload: { projectId } });
      handleRemoveProject(projectId);
    },
    [dispatch, handleRemoveProject]
  );

  const projectStatusMap: Record<string, ProjectStatusInfo> = useMemo(() => {
    const map: Record<string, ProjectStatusInfo> = {};
    for (const project of projectsRegistry.projects) {
      const projState = multiProjectState.projects[project.id];
      if (projState) {
        map[project.id] = {
          connectionState: projState.connectionStatus,
          agentActivity: projState.agentActivity,
          isBusy: projState.agentActivity === 'busy',
        };
      } else {
        map[project.id] = {
          connectionState: 'disconnected',
          agentActivity: 'idle',
          isBusy: false,
        };
      }
    }
    return map;
  }, [projectsRegistry.projects, multiProjectState.projects]);

  // Global extension UI dialog queue visible across project switches
  const {
    activeDialog,
    pendingCount: dialogPendingCount,
    dialogAdapter,
    canGoBack,
    flowAnswers,
    handleSelect: handleDialogSelect,
    handleMultiSelectSubmit: handleDialogMultiSelectSubmit,
    handleInput: handleDialogInput,
    handleConfirm: handleDialogConfirm,
    handleCancel: handleDialogCancel,
    handleBack,
  } = useExtensionUiDialog();

  const handleDialogBack = useCallback(
    (
      itemKey: string,
      targetStep?: number,
      currentDraft?: Partial<AnsweredQuestionRecord>
    ) => {
      handleBack(itemKey, targetStep, currentDraft);
    },
    [handleBack]
  );

  // Session-events cluster: SessionEventController wiring (fresh-value mirror refs,
  // dispatch wrapping for the workspace refresh) and the mount effect that registers
  // bridge listeners and starts the automatic connection. Fused in the original code
  // (sessionEventControllerRef.asBridgeListeners() alongside startConnection/
  // cancelConnection) and kept fused here rather than split across a callback, since
  // requestFileTreeRefresh (workspace), setStorageWarning (connection) and
  // startConnection/cancelConnection (connection) all cross feature lines and arrive as
  // injected callbacks - the hook itself imports none of those features.
  useSessionEvents({
    config,
    sessionId: state.sessionId,
    projects: projectsRegistry.projects,
    activeProjectId: projectsRegistry.activeProjectId,
    dispatch,
    onWorkspaceChanged: requestFileTreeRefresh,
    onStorageWarning: setStorageWarning,
    startConnection,
    cancelConnection,
    dialogAdapter,
    isConfigReadyFn: isConfigReady,
    onMissingConfiguration: ({ diagnostic, partialConfig }) => {
      setShowSettings(true);
      setSettingsError(diagnostic);
      setSettingsDraft((prev) => ({
        ...prev,
        nodePath: prev.nodePath?.trim() ? prev.nodePath : (partialConfig.nodePath || prev.nodePath),
        piEntrypoint: prev.piEntrypoint?.trim() ? prev.piEntrypoint : (partialConfig.piEntrypoint || prev.piEntrypoint),
        workingDirectory: prev.workingDirectory?.trim() ? prev.workingDirectory : (partialConfig.workingDirectory || prev.workingDirectory),
      }));
    },
  });

  // Explicit retry without replaying prompts
  const handleRetry = () => {
    if (isConnecting || state.isResetting) return;
    dispatch({ type: 'CLEAR_ERROR' });
    void retryConnection(config);
  };

  // Sessions-list cluster: loadSessions, the load-on-connect and busy->idle reload
  // effects, and the three session handlers. Real decision logic (the active-session
  // early return, the busy/switching guards, and what happens when a delete or a reset
  // targets the active session) lives in the pure, tested functions in
  // features/sessions/session-actions.ts.
  const { handleSelectSession, handleDeleteSession, handleRenameSession, handleNewConversation } = useSessions({
      activeProjectId: projectsRegistry.activeProjectId,
      connectionStatus: state.connectionStatus,
      config,
      isBusy,
      isConnected,
      isConnecting,
      isResetting: state.isResetting,
      isSwitchingSession: state.isSwitchingSession,
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
      showSettings,
      setShowSettings,
      dispatch,
      t,
      requestFileTreeRefresh,
      pinAndHide,
      scrollToBottomNextFrame,
      startConnection,
    });

  // Dynamic application status and window title / favicon updater
  const appStatus: AppStatusState = useMemo(() => {
    if (activeDialog) {
      return 'waiting';
    }
    if (isBusy) {
      return 'busy';
    }
    if (isConnected) {
      return 'idle';
    }
    if (state.connectionStatus === 'error') {
      return 'error';
    }
    return 'disconnected';
  }, [activeDialog, isBusy, isConnected, state.connectionStatus]);

  const prevStatusRef = useRef<AppStatusState>(appStatus);

  useEffect(() => {
    updateFavicon(appStatus);
    const label = t(STATUS_CONFIG[appStatus].labelKey as TranslationKey);
    updateWindowTitle(appStatus, label);

    if (
      prevStatusRef.current !== appStatus &&
      (appStatus === 'waiting' || appStatus === 'idle')
    ) {
      void triggerTauriWindowAttention(appStatus);
    }
    prevStatusRef.current = appStatus;
  }, [appStatus, t]);

  // Models cluster: thinking-level overrides map, model/thinking-level selection,
  // manual refresh, and the connect-time effect that fetches available models, thinking
  // levels, session stats, custom providers and the thinking-level overrides map.
  const {
    modelThinkingLevels,
    handleSelectModel,
    handleSelectThinkingLevel,
  } = useModels({
    connectionStatus: state.connectionStatus,
    sessionId: state.sessionId,
    modelInfo: state.modelInfo,
    availableModels: state.availableModels,
    dispatch,
  });

  // The OAuth helper updates auth.json outside Pi RPC. Its model-list command reads
  // a snapshot, so refreshing it requires replacing this project's idle process.
  const providerRefreshInFlight = useRef(false);
  const providerRefreshPending = useRef(false);
  const handleProviderModelsChanged = useCallback(async () => {
    if (state.connectionStatus !== 'connected') return;
    if (isBusy || providerRefreshInFlight.current) {
      // A login can finish during a response. Refresh once the session is idle.
      providerRefreshPending.current = true;
      return;
    }
    providerRefreshPending.current = false;
    providerRefreshInFlight.current = true;
    try {
      await disconnectPi(config.workingDirectory);
      await startConnection(config, { force: true });
    } finally {
      providerRefreshInFlight.current = false;
    }
  }, [state.connectionStatus, isBusy, config, startConnection]);

  useEffect(() => {
    if (!isBusy && state.connectionStatus === 'connected' && providerRefreshPending.current) {
      void handleProviderModelsChanged();
    }
  }, [isBusy, state.connectionStatus, handleProviderModelsChanged]);

  // Global MCP servers managed exclusively in Settings (~/.pi/agent/mcp.json)
  const globalMcp = useMcpServers();

  // Project MCP servers with global defaults & project overrides for the chat prompt bar
  const projectMcp = useMcpServers({ cwd: config.workingDirectory });

  // Global Pi resources managed exclusively in Settings (~/.pi/agent/settings.json)
  const globalPiResources = usePiResources();

  // Project Pi resources with global defaults & project overrides for the chat prompt bar
  const projectPiResources = usePiResources({ cwd: config.workingDirectory });

  // Profiles hook for project-scoped profile selector & global settings
  const profilesHook = useProfiles({
    cwd: config.workingDirectory,
    availableModels: state.availableModels,
  });

  // Engram project detection for current working directory
  const {
    engramProject,
    cloudStatus,
    isCheckingCloud,
    checkCloudStatus,
    isEnrolling,
    enrollProject,
  } = useEngramProject({ cwd: config.workingDirectory });

  const handleSelectProfile = useCallback(
    async (profile: ProfileSummary | null) => {
      if (!profile) {
        await profilesHook.handleClearProjectActive();
      } else {
        await profilesHook.handleActivateProfile(profile, 'project');
      }
    },
    [profilesHook]
  );

  // Profile runtime synchronization: listen for profile activations / clears across
  // PromptControls and Settings ProfilesView and live-apply default_model and
  // default_effort to the connected session without restart.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onProfileActivated = async (e: Event) => {
      const customEvent = e as CustomEvent<ProfileActivationEventDetail>;
      const activatedProfile = customEvent.detail?.profile;
      if (!activatedProfile) return;

      if (isConnected && !isBusy) {
        await applyProfileRuntime(activatedProfile, {
          isConnected,
          availableModels: state.availableModels,
          onSelectModel: handleSelectModel,
          onSelectThinkingLevel: handleSelectThinkingLevel,
        });
      }

      void profilesHook.refreshProfiles();
    };

    const onProfileCleared = async () => {
      const data = await getSddProfilesPi(config.workingDirectory).catch(() => null);
      await profilesHook.refreshProfiles();

      if (isConnected && !isBusy && data) {
        const globalName = data.globalActiveProfile;
        if (globalName) {
          const globalProf =
            data.profiles.find((p) => p.name === globalName && p.scope === 'global') ||
            data.profiles.find((p) => p.name === globalName);
          if (globalProf) {
            await applyProfileRuntime(globalProf, {
              isConnected,
              availableModels: state.availableModels,
              onSelectModel: handleSelectModel,
              onSelectThinkingLevel: handleSelectThinkingLevel,
            });
          }
        }
      }
    };

    window.addEventListener(PROFILE_ACTIVATED_EVENT, onProfileActivated);
    window.addEventListener(PROFILE_CLEARED_EVENT, onProfileCleared);

    return () => {
      window.removeEventListener(PROFILE_ACTIVATED_EVENT, onProfileActivated);
      window.removeEventListener(PROFILE_CLEARED_EVENT, onProfileCleared);
    };
  }, [
    isConnected,
    isBusy,
    config.workingDirectory,
    state.availableModels,
    handleSelectModel,
    handleSelectThinkingLevel,
    profilesHook,
  ]);

  const handleOpenSettings = () => {
    setSettingsDraft(config);
    setSettingsError(null);
    setSettingsStorageNotice(null);
    setShowSettings(true);
  };

  const handleToggleSettings = () => {
    if (showSettings) {
      handleCancelSettings();
    } else {
      handleOpenSettings();
    }
  };

  const handleCancelSettings = () => {
    setSettingsDraft(config);
    setSettingsError(null);
    setSettingsStorageNotice(null);
    setShowSettings(false);
  };


  const handleSaveAndApplySettings = (e: React.FormEvent) => {
    e.preventDefault();

    // Prevent applying settings during active generation
    if (isBusy) {
      setSettingsError('Cannot apply configuration while response generation is active');
      return;
    }

    // Validate fields before persisting
    const validation = validateConnectConfig(settingsDraft);
    if (!validation.valid || !validation.config) {
      setSettingsError(validation.error || 'Invalid configuration');
      return;
    }

    const validConfig = validation.config;

    if (validConfig.workingDirectory !== config.workingDirectory) {
      addProjectForPath(validConfig.workingDirectory);
    }

    // Display storage failures honestly without crashing; apply configuration and
    // restart connection (saveConnectConfig + notice/warning decision + setConfig +
    // forced StartupManager.start now live in useConnection's applyConfig).
    const outcome = applyConfig(validConfig);
    setSettingsStorageNotice(outcome.settingsStorageNotice);
    setSettingsError(null);
    setShowSettings(false);
  };


  const activeProject = projectsRegistry.projects.find(
    (p) => p.id === projectsRegistry.activeProjectId
  );
  const activeProjectName = activeProject ? getProjectDisplayName(activeProject) : undefined;

  // Localized presentation mappings preserving reducer contracts
  const localizedStatusLabel = formatLocalizedStatus(
    state.connectionStatus,
    state.agentActivity,
    preferences.language
  );
  const localizedStatusDetail = formatLocalizedStatusDetail(
    state.statusDetail,
    preferences.language
  );

  return (
    <div className="app-container">
      <header className="app-header" role="banner">
        <div className="header-brand">
          <button
            type="button"
            className="btn-sidebar-toggle"
            onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
            title={t('sidebar.toggle')}
            aria-label={t('sidebar.toggle')}
            aria-expanded={state.isSidebarOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <div className="brand-mark" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div className="brand-text">
            <h1 className="brand-title">{t('app.title')}</h1>
            <span className="brand-version">{t('app.version')}</span>
          </div>
        </div>

        <div className="header-controls">
          <div className="header-status" role="status" aria-live="polite">
            <span
              className={`status-indicator status-${state.connectionStatus}`}
              aria-hidden="true"
            />
            <span className="status-label">{localizedStatusLabel}</span>
          </div>

          {canRetryConnection(state.connectionStatus) && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleRetry}
              disabled={isConnecting || state.isResetting}
              title={t('header.retry_title')}
            >
              {t('action.retry')}
            </button>
          )}
        </div>
      </header>

      {/* Workspace Layout: Sidebar + Main Content */}
      <div className="app-workspace">
        <ProjectDock
          projects={projectsRegistry.projects}
          activeProjectId={projectsRegistry.activeProjectId}
          connectionState={state.connectionStatus}
          agentActivity={state.agentActivity}
          isBusy={isBusy}
          locale={preferences.language}
          onSelectProject={handleSelectProjectAndSync}
          onAddProject={handleAddProject}
          onRenameProject={handleRenameProject}
          onRemoveProject={handleRemoveProjectAndSync}
          projectStatusMap={projectStatusMap}
          isSettingsOpen={showSettings}
          onOpenSettings={handleToggleSettings}
        />

        {state.isSidebarOpen && (
          <SessionSidebar
            projectName={activeProjectName}
            sessions={state.sessions}
            isLoading={state.isSessionsLoading}
            isSwitching={state.isSwitchingSession}
            error={state.sessionsError}
            activeSessionId={state.sessionId}
            activeSessionFile={state.sessionFile}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewConversation}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
            onClose={() => dispatch({ type: 'TOGGLE_SIDEBAR', payload: { isOpen: false } })}
            locale={preferences.language}
            filesChangesCount={gitChangesCount}
            filesPanel={
              <FileTree
                key={config.workingDirectory ? normalizeWorkspaceKey(config.workingDirectory) : 'empty'}
                workingDirectory={config.workingDirectory}
                locale={preferences.language}
                onOpenFile={openFile}
                refreshInterval={config.fileTreeRefreshInterval}
                refreshTrigger={fileTreeRefreshTrigger}
                onGitStatusChange={handleGitStatusChange}
              />
            }
          />
        )}

        <main className="workspace-main" role="main">
          {showSettings ? (
            <SettingsView
              config={config}
              settingsDraft={settingsDraft}
              setSettingsDraft={setSettingsDraft}
              preferences={preferences}
              onThemeChange={handleThemeChange}
              onLanguageChange={handleLanguageChange}
              onNotificationsChange={setNotifications}
              settingsError={settingsError}
              settingsStorageNotice={settingsStorageNotice}
              isBusy={isBusy}
              onSaveAndApply={handleSaveAndApplySettings}
              onClose={handleCancelSettings}
              t={t}
              activeProfileName={profilesHook.effectiveActiveProfile}
              activeProfileScope={profilesHook.effectiveScope}
              loadCustomProviders={async () =>
                mapProvidersToArray((await getCustomProvidersPi()).providers || {})
              }
              renderProfiles={(onBackToSettings) => (
                <ProfilesView
                  cwd={config.workingDirectory}
                  isBusy={isBusy}
                  onClose={onBackToSettings}
                />
              )}
              renderProviders={() => (
                <ProvidersView
                  onRefreshModels={handleProviderModelsChanged}
                  t={t}
                  language={preferences.language}
                  isBusy={isBusy}
                />
              )}
              renderMcp={() => (
                <McpView
                  servers={globalMcp.servers}
                  onToggleServer={async (server, enabled) => {
                    await globalMcp.handleToggleServer(server, enabled, 'global');
                    void projectMcp.refreshServers();
                  }}
                  onRefresh={async () => {
                    await globalMcp.refreshServers();
                    void projectMcp.refreshServers();
                  }}
                  onSaveServer={async (payload) => {
                    const res = await saveMcpServerPi({
                      ...payload,
                      scope: 'global',
                      cwd: undefined,
                    });
                    if (res.success) {
                      await globalMcp.refreshServers();
                      void projectMcp.refreshServers();
                      return true;
                    }
                    return false;
                  }}
                  onDeleteServer={async (server) => {
                    const res = await deleteMcpServerPi({
                      name: server.name,
                      scope: 'global',
                      cwd: undefined,
                    });
                    if (res.success) {
                      await globalMcp.refreshServers();
                      void projectMcp.refreshServers();
                      return true;
                    }
                    return false;
                  }}
                  t={t}
                  language={preferences.language}
                  isBusy={isBusy}
                />
              )}
              renderExtensions={() => (
                <ExtensionsView
                  resources={globalPiResources.resources}
                  onToggleResource={async (resource, enabled) => {
                    await globalPiResources.handleToggleResource(resource, enabled, 'global');
                    void projectPiResources.refreshResources();
                  }}
                  onRefresh={async () => {
                    await globalPiResources.refreshResources();
                    void projectPiResources.refreshResources();
                  }}
                  onSaveResource={async (payload, original) => {
                    const ok = await globalPiResources.handleSaveResource(
                      { ...payload, scope: 'global', cwd: undefined },
                      original
                    );
                    if (ok) {
                      void projectPiResources.refreshResources();
                    }
                    return ok;
                  }}
                  onDeleteResource={async (resource) => {
                    const ok = await globalPiResources.handleDeleteResource(resource);
                    if (ok) {
                      void projectPiResources.refreshResources();
                    }
                    return ok;
                  }}
                  t={t}
                  language={preferences.language}
                  isBusy={isBusy}
                />
              )}
            />
          ) : (
            <>
              {/* Connection Storage Diagnostic Banner */}
        {storageWarning && (
          <aside className="storage-warning-banner" role="status">
            <span>{formatLocalizedDiagnostic(storageWarning, preferences.language)}</span>
            <button
              type="button"
              className="btn-dismiss"
              onClick={() => setStorageWarning(null)}
              aria-label={t('action.dismiss_warning')}
            >
              ×
            </button>
          </aside>
        )}

        {/* UI Preferences Diagnostic Banner (Globally exposed on startup and runtime) */}
        {preferencesWarning && (
          <aside className="storage-warning-banner" role="status">
            <span>{formatLocalizedDiagnostic(preferencesWarning, preferences.language)}</span>
            <button
              type="button"
              className="btn-dismiss"
              onClick={dismissPreferencesWarning}
              aria-label={t('action.dismiss_warning')}
            >
              ×
            </button>
          </aside>
        )}

        {/* Error Diagnostics Banner */}
        {state.lastError && (
          <aside className="error-banner" role="alert">
            <div className="error-banner-content">
              <strong>{t('error.prefix')}</strong> {state.lastError}
            </div>
            <div className="error-banner-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleRetry}
                disabled={isConnecting || state.isResetting}
              >
                {t('action.retry')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleNewConversation}
                disabled={isConnecting || isBusy || state.isResetting}
              >
                {t('action.new_conversation')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleOpenSettings}
              >
                {t('action.settings')}
              </button>
              <button
                type="button"
                className="btn-dismiss"
                onClick={() => dispatch({ type: 'CLEAR_ERROR' })}
                aria-label={t('action.dismiss_error')}
              >
                ×
              </button>
            </div>
          </aside>
        )}

        {/* Chat Toolbar: compact process view toggle (Issue #8) */}
        {state.messages.length > 0 && (
          <div className="chat-toolbar-container" role="toolbar" aria-label={t('process_group.toggle_compact_view_aria')}>
            <button
              type="button"
              className={`compact-processes-toggle${compactProcesses ? ' is-active' : ''}`}
              onClick={handleToggleCompactProcesses}
              aria-pressed={compactProcesses}
              title={t('process_group.toggle_compact_view')}
            >
              {t('process_group.toggle_compact_view')}
            </button>
          </div>
        )}

        {/* Chat History Viewport */}
        <div className="chat-container">
          <section
            ref={chatViewportRef}
            onScroll={handleViewportScroll}
            className={`chat-viewport ${state.messages.length === 0 ? 'is-empty' : 'has-messages'}`}
            aria-label={t('empty.history_label')}
            tabIndex={0}
          >
          {state.messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon" aria-hidden="true">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h3 className="empty-state-title">
                {isConnected
                  ? t('empty.connected_title')
                  : isConnecting
                    ? t('empty.connecting_title')
                    : state.connectionStatus === 'error'
                      ? t('empty.error_title')
                      : t('empty.offline_title')}
              </h3>
              <p className="empty-state-description">
                {isConnected
                  ? t('empty.connected_desc')
                  : isConnecting
                    ? t('empty.connecting_desc')
                    : state.connectionStatus === 'error'
                      ? state.lastError || t('empty.error_desc_fallback')
                      : t('empty.offline_desc')}
              </p>
              {canRetryConnection(state.connectionStatus) && (
                <div className="empty-state-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleRetry}
                    disabled={isConnecting}
                  >
                    {t('empty.retry_button')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleOpenSettings}
                  >
                    {t('empty.configure_button')}
                  </button>
                </div>
              )}
              <div className="empty-state-meta">
                <span className="meta-badge">{t('empty.meta_strict_lf')}</span>
                <span className="meta-badge">{t('empty.meta_direct_argv')}</span>
                <span className="meta-badge">{t('empty.meta_plain_text')}</span>
                <span className="meta-badge">{t('empty.meta_auto_lifecycle')}</span>
              </div>
            </div>
          ) : (
            <ul className="message-list">
              {(compactProcesses
                ? mergeConsecutiveAssistantMessages(
                    state.messages.filter((msg) => !isMessageEmpty(msg))
                  )
                : state.messages.filter((msg) => !isMessageEmpty(msg))
              ).map((msg) => (
                <li
                  key={msg.id}
                  className={`message-item message-${msg.role}${msg.isCancelled ? ' message-cancelled' : ''}`}
                >
                  <div className="message-header">
                    <span className="message-role">
                      {msg.role === 'user'
                        ? t('message.role_user')
                        : msg.role === 'assistant'
                          ? t('message.role_assistant')
                          : t('message.role_system')}
                    </span>
                    {msg.isCancelled && (
                      <span className="message-badge-cancelled">
                        {t('message.status_cancelled')}
                      </span>
                    )}
                    {msg.isQueued && (
                      <span className="message-badge-queued">
                        {t('message.status_queued')}
                      </span>
                    )}
                    <span className="message-time">{msg.timestamp}</span>
                  </div>
                  <div className={`message-content message-content-${msg.role}`}>
                    {msg.role === 'assistant' && msg.blocks && msg.blocks.length > 0 ? (
                      <div className="activity-blocks">
                        {compactProcesses
                          ? groupMessageBlocks(msg.blocks).map((item, iIndex) => {
                              if (item.type === 'process_group') {
                                return (
                                  <ProcessGroupCard key={item.id} group={item} t={t} />
                                );
                              }
                              const block = item.block;
                              if (block.type === 'text') {
                                return (
                                  <MarkdownContent
                                    key={`text-${iIndex}`}
                                    content={block.text}
                                    t={t}
                                    onInsertCode={insertCodeIntoPrompt}
                                  />
                                );
                              }
                              return null;
                            })
                          : msg.blocks.map((block, bIndex) => {
                              if (block.type === 'thinking') {
                                return (
                                  <ThinkingCard
                                    key={`thinking-${bIndex}`}
                                    block={block}
                                    t={t}
                                  />
                                );
                              }
                              if (block.type === 'tool_call') {
                                return (
                                  <ToolCard
                                    key={block.id || `tool-${bIndex}`}
                                    block={block}
                                    t={t}
                                  />
                                );
                              }
                              if (block.type === 'text') {
                                return (
                                  <MarkdownContent
                                    key={`text-${bIndex}`}
                                    content={block.text}
                                    t={t}
                                    onInsertCode={insertCodeIntoPrompt}
                                  />
                                );
                              }
                              return null;
                            })}
                      </div>
                    ) : shouldRenderAsMarkdown(msg.role) ? (
                      <MarkdownContent content={msg.content} t={t} onInsertCode={insertCodeIntoPrompt} />
                    ) : (
                      <div className="message-literal">{msg.content}</div>
                    )}
                    {msg.isStreaming && (
                      <span
                        className="streaming-dot"
                        aria-label={t('message.generating')}
                      />
                    )}
                    {msg.isCancelled && (
                      <div className="message-cancelled-notice">
                        <span aria-hidden="true">⏹</span>
                        <span>{t('message.cancelled_note')}</span>
                      </div>
                    )}
                  </div>
                </li>
              ))}
              <li className="scroll-anchor" aria-hidden="true" />
            </ul>
          )}
        </section>

        {showScrollBottom && state.messages.length > 0 && (
          <button
            type="button"
            className="btn-scroll-bottom"
            onClick={handleScrollToBottom}
            title={t('chat.scroll_to_bottom')}
            aria-label={t('chat.scroll_to_bottom')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

        <footer className="app-footer" role="contentinfo">
          {activeDialog ? (
            <ExtensionUiPromptBar
              key="active-extension-ui-prompt"
              dialog={activeDialog}
              pendingCount={dialogPendingCount}
              canGoBack={canGoBack}
              flowAnswers={flowAnswers}
              onBack={handleDialogBack}
              onSelect={handleDialogSelect}
              onMultiSelectSubmit={handleDialogMultiSelectSubmit}
              onInput={handleDialogInput}
              onConfirm={handleDialogConfirm}
              onCancel={handleDialogCancel}
            />
          ) : (
            <form className="prompt-form" onSubmit={handleSend}>
          <div className="prompt-field-group">
            <div className="prompt-header-row">
              <div className="prompt-label-wrapper">
                <label htmlFor="prompt-input" className="prompt-label">
                  {t('prompt.label')}
                </label>
                <span
                  className={`prompt-status-dot status-${state.connectionStatus} ${isBusy ? 'is-busy' : ''}`}
                  title={localizedStatusDetail || localizedStatusLabel}
                  aria-label={t('prompt.status_dot_aria', { status: localizedStatusLabel })}
                />
              </div>
              <span id="prompt-status-hint" className="prompt-hint">
                {isBusy
                  ? t('prompt.hint_busy')
                  : state.isResetting
                    ? t('prompt.hint_resetting')
                    : !state.isHydrated && isConnected
                      ? t('prompt.hint_hydrating')
                      : isConnected
                        ? t('prompt.hint_ready')
                        : isConnecting
                          ? t('prompt.hint_connecting')
                          : t('prompt.hint_disabled')}
              </span>
            </div>

            {attachedFiles.length > 0 && (
              <div className="prompt-attachments-list">
                {attachedFiles.map((file) => (
                  <div key={file.id} className="prompt-attachment-chip">
                    {file.type === 'video' ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                      </svg>
                    ) : file.type === 'audio' ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18V5l12-2v13" />
                        <circle cx="6" cy="18" r="3" />
                        <circle cx="18" cy="16" r="3" />
                      </svg>
                    ) : file.type === 'image' && file.previewUrl ? (
                      <img src={file.previewUrl} alt={file.name} className="attachment-thumb" />
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                        <polyline points="13 2 13 9 20 9" />
                      </svg>
                    )}
                    <span className="attachment-name" title={file.name}>{file.name}</span>
                    <button
                      type="button"
                      className="btn-remove-attachment"
                      onClick={() => removeAttachedFile(file.id)}
                      title={t('prompt_controls.remove_attachment')}
                      aria-label={t('prompt_controls.remove_attachment')}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              id="prompt-input"
              name="prompt"
              className={`prompt-textarea ${isHighContext ? 'context-pulse-red' : ''}`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isConnecting
                  ? t('prompt.placeholder_connecting')
                  : state.isResetting
                    ? t('prompt.placeholder_resetting')
                    : !state.isHydrated && isConnected
                      ? t('prompt.placeholder_hydrating')
                      : state.connectionStatus === 'error'
                        ? t('prompt.placeholder_error')
                        : !isConnected
                          ? t('prompt.placeholder_offline')
                          : isBusy
                            ? t('prompt.placeholder_busy')
                            : t('prompt.placeholder_ready')
              }
              disabled={!isReadyToSend && !canQueue}
              aria-disabled={!isReadyToSend && !canQueue}
              aria-describedby="prompt-status-hint"
              rows={3}
            />

            <PromptControls
              modelInfo={state.modelInfo}
              availableModels={state.availableModels}
              isChangingModel={state.isChangingModel}
              thinkingLevel={state.thinkingLevel}
              defaultThinkingLevel={resolveModelDefaultThinkingLevel(state.modelInfo, modelThinkingLevels, state.availableThinkingLevels)}
              availableThinkingLevels={state.availableThinkingLevels}
              sessionStats={state.sessionStats}
              isHighContext={isHighContext}
              isConnected={isConnected}
              isBusy={isBusy}
              canSend={(isReadyToSend || canQueue) && (prompt.trim().length > 0 || attachedFiles.length > 0)}
              attachedFiles={attachedFiles}
              onAttachFiles={addAttachedFiles}
              onAbort={handleAbort}
              onSelectModel={handleSelectModel}
              onSelectThinkingLevel={handleSelectThinkingLevel}
              mcpServers={projectMcp.servers}
              mcpActiveCount={projectMcp.activeCount}
              mcpTotalCount={projectMcp.totalCount}
              onToggleMcpServer={projectMcp.handleToggleProjectServer}
              piResources={projectPiResources.resources}
              piActiveCount={projectPiResources.activeCount}
              piTotalCount={projectPiResources.totalCount}
              onTogglePiResource={projectPiResources.handleToggleProjectResource}
              engramProject={engramProject}
              cloudStatus={cloudStatus}
              isCheckingCloud={isCheckingCloud}
              onCheckCloudStatus={checkCloudStatus}
              isEnrolling={isEnrolling}
              onEnrollProject={enrollProject}
              profiles={profilesHook.profiles}
              activeProfileName={profilesHook.effectiveActiveProfile}
              effectiveScope={profilesHook.effectiveScope}
              isChangingProfile={profilesHook.activatingName !== null}
              onSelectProfile={handleSelectProfile}
              onCreateProfile={profilesHook.openCreateModal}
              t={t}
            />
          </div>
        </form>
          )}
      </footer>
            </>
          )}
        </main>
      </div>

      {viewingFile && (
        <FileViewerModal
          file={viewingFile}
          workingDirectory={config.workingDirectory}
          onClose={closeFile}
          locale={preferences.language}
        />
      )}

      {profilesHook.isModalOpen && (
        <ProfileModal
          isOpen={profilesHook.isModalOpen}
          isEditing={profilesHook.isEditing}
          isSaving={profilesHook.isSaving}
          formData={profilesHook.formData}
          error={profilesHook.modalError}
          availableModels={profilesHook.availableModels}
          categories={profilesHook.categories}
          cwd={config.workingDirectory}
          onClose={profilesHook.closeModal}
          onChangeField={profilesHook.updateFormField}
          onChangeAgentModel={profilesHook.updateAgentModel}
          onRemoveAgentOverride={profilesHook.removeAgentOverride}
          onSave={async (e) => {
            await profilesHook.handleSaveProfile(e);
          }}
        />
      )}
    </div>
  );
};
