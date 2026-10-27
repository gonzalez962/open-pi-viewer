import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  getCustomProvidersPi,
  disconnectPi,
  getSddProfilesPi,
  saveMcpServerPi,
  deleteMcpServerPi,
} from '@infra/bridge';
import { ProjectDock } from '@features/projects/ProjectDock';
import type { ThinkingLevel } from '@core/types/models';
import { mapProvidersToArray, resolveModelDefaultThinkingLevel } from '@features/providers/providers';
import { isConfigReady, validateConnectConfig } from '@features/settings/config';
import { canRetryConnection, shouldShowHeaderStatus } from '@features/settings/connection';
import {
  formatLocalizedDiagnostic,
  formatLocalizedStatus,
  type TranslationKey,
} from '@shared/i18n';
import { preserveScrollOnPrepend } from '@shared/scroll';
import {
  computeWorkAnimationStyles,
  type AppearancePreferences,
} from '@infra/preferences';
import { ProcessGroupCard } from '@features/chat/ProcessGroupCard';
import { MessageSpeechButton } from '@features/chat/components/MessageSpeechButton';
import { PromptMicButton } from '@features/chat/components/PromptMicButton';
import { MessageImageThumbnails } from '@features/chat/components/MessageImageThumbnails';
import { UserMessageContent } from '@features/chat/components/UserMessageContent';
import {
  MarkdownContent,
  shouldRenderAsMarkdown,
} from '@features/chat/MarkdownContent';
import { groupMessageBlocks, mergeConsecutiveAssistantMessages } from '@core/process-grouping';
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
import { FileTree } from '@features/workspace/FileTree';
import {
  applyProfileRuntime,
  resolveProfileModel,
  PROFILE_ACTIVATED_EVENT,
  PROFILE_CLEARED_EVENT,
  type ProfileSummary,
  type ProfileActivationEventDetail,
} from '@core/types/profiles';
import { useProfiles } from '@features/profiles/hooks/useProfiles';
import { useProfileRuntime } from '@features/profiles/hooks/useProfileRuntime';
import {
  loadSessionProfileSnapshot,
  updateSessionProfileSnapshotManualSelection,
  updateSessionProfileSnapshotExplicitProfile,
} from '@features/profiles/lib/sessionProfileSnapshot';
import {
  TerminalOverlay,
  TerminateConfirmationModal,
  useTerminal,
} from '@features/terminal';

const SettingsView = React.lazy(() =>
  import('@features/settings/SettingsView').then((m) => ({ default: m.SettingsView }))
);
const FileViewerModal = React.lazy(() =>
  import('@features/workspace/FileViewerModal').then((m) => ({ default: m.FileViewerModal }))
);
const ProfileModal = React.lazy(() =>
  import('@features/profiles/components/ProfileModal').then((m) => ({ default: m.ProfileModal }))
);
const FolderPickerModal = React.lazy(() =>
  import('@features/projects/components/FolderPickerModal').then((m) => ({
    default: m.FolderPickerModal,
  }))
);
const DefaultDirectorySetupModal = React.lazy(() =>
  import('@features/projects/components/DefaultDirectorySetupModal').then((m) => ({
    default: m.DefaultDirectorySetupModal,
  }))
);
const GitHubCloneModal = React.lazy(() =>
  import('@features/projects/components/GitHubCloneModal').then((m) => ({
    default: m.GitHubCloneModal,
  }))
);
const GitHubCreateModal = React.lazy(() =>
  import('@features/projects/components/GitHubCreateModal').then((m) => ({
    default: m.GitHubCreateModal,
  }))
);
const ProfilesView = React.lazy(() =>
  import('@features/profiles/ProfilesView').then((m) => ({ default: m.ProfilesView }))
);
const ProvidersView = React.lazy(() =>
  import('@features/providers/ProvidersView').then((m) => ({ default: m.ProvidersView }))
);
const McpView = React.lazy(() =>
  import('@features/mcp/McpView').then((m) => ({ default: m.McpView }))
);
const ExtensionsView = React.lazy(() =>
  import('@features/extensions/ExtensionsView').then((m) => ({ default: m.ExtensionsView }))
);
import { STATUS_CONFIG, type AppStatusState } from '@core/icon-status';
import {
  triggerTauriWindowAttention,
  updateFavicon,
  updateWindowTitle,
} from '@infra/icon-status';
import type { ConnectConfig, ConnectResult } from '@core/types/connection';
import { buildCommandCatalog, filterVisibleCommands, type ReloadRequest } from '@core/commands';
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
import { useWebPush } from '@features/settings/hooks/useWebPush';
import { useWebPushPrompt } from '@features/settings/hooks/useWebPushPrompt';
import { WebPushInvitation } from '@features/settings/components/WebPushInvitation';
import '@features/settings/components/web-push-invitation.css';
import { isWebShim } from '@infra/web-oauth-access';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@core/notifications';
import { useConnection } from '@features/settings/hooks/useConnection';
import { computeWallpaperStyles } from '@features/settings/wallpaper';
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
import { useConversationExport } from '@features/chat/hooks/useConversationExport';
import { ExportToast } from '@features/chat/components/ExportToast';
import { resolveExportTitle } from '@features/chat/conversation-export';
import { useCommandPalette } from '@features/chat/hooks/useCommandPalette';
import { CommandPalettePopover } from '@features/chat/components/CommandPalettePopover';
import { getAgentWorkingStatus } from '@features/chat/agent-working-status';
import { useModels } from '@features/providers/hooks/useModels';
import { useMcpServers } from '@features/mcp/hooks/useMcpServers';
import { usePiResources } from '@features/extensions/hooks/usePiResources';
import {
  determineZenFocusTarget,
  hasActiveModalOrOverlay,
  resolveZenKeyboardAction,
  ZEN_MODE_CONTAINER_CLASS,
} from './zen-mode';
import { MobileNavigation } from './MobileNavigation';
import { useWebLogoutControl } from './WebLogoutContext';
import {
  DRAWER_ID,
  MOBILE_BREAKPOINT,
  checkIsMobileViewport,
  resolveMobileBrandTitle,
} from './mobile-navigation';

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
  const webLogoutControl = useWebLogoutControl();
  const isReadyToSend = isConnected && state.isHydrated && !isBusy && !state.isResetting;
  // Separate readiness for queuing a follow-up while the agent is busy: same connection/
  // hydration/reset guards as isReadyToSend, but requires isBusy instead of excluding it.
  const canQueue = isConnected && state.isHydrated && isBusy && !state.isResetting;
  const { isHighContext } = calculateContextMetrics(state.sessionStats, state.modelInfo, state.availableModels);

  // Separate Settings draft state for connection configuration. settingsDraft's initial
  // value depends on `config`, which now comes from useConnection below, so its
  // declaration moves there too; the other settings-panel state is independent and stays.
  const [showSettings, setShowSettings] = useState(false);
  const [isZenMode, setIsZenMode] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const mobileMenuToggleRef = useRef<HTMLButtonElement>(null);
  const zenToggleRef = useRef<HTMLButtonElement>(null);
  const floatingExitRef = useRef<HTMLButtonElement>(null);
  const prevZenModeRef = useRef<boolean | undefined>(undefined);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStorageNotice, setSettingsStorageNotice] = useState<string | null>(null);

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
        const shouldActivate = !projectsRegistryRef.current.activeProjectId;
        addProjectForPath(res.canonicalCwd, { activate: shouldActivate });
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
          res.activity === undefined &&
          targetState?.isHydrated === true &&
          (targetState.messages.length > 0 || targetState.agentActivity === 'busy')
        ) {
          if (targetState.connectionStatus !== 'connected') {
            dispatch({
              type: 'CONNECT_SUCCESS',
              targetProjectId,
              payload: { model: res.model },
            });
          } else if (res.model && res.model.id && targetState.modelInfo?.id !== res.model.id) {
            dispatch({
              type: 'MODEL_CHANGE_SUCCESS',
              targetProjectId,
              payload: {
                model: res.model,
                thinkingLevel: (res.model.defaultThinkingLevel as ThinkingLevel) ?? null,
                availableThinkingLevels: targetState.availableThinkingLevels,
              },
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
          hasMore: res.hasMore,
          activity: res.activity,
          detail:
            hydrated.length > 0
              ? `Resumed session (${hydrated.length} messages)`
              : 'Connected to fresh session',
        },
      });
      restoreExtensionPrompts(res.pendingExtensionPrompts ?? []);
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
    setCustomCommands,
    setHiddenCommandIds,
    setDefaultProjectsDirectory,
    setSpeechPreferences,
    appearanceController,
    t,
  } = usePreferences();

  const derivedWorkingStatus = getAgentWorkingStatus(state, preferences.language);
  const workingStatusText = isBusy
    ? (derivedWorkingStatus ?? t('agent_working_status.fallback'))
    : derivedWorkingStatus;
  const isIndicatorActive = Boolean(workingStatusText);

  // Subscribes to effective appearance via central controller for live background & working animation
  const [effectiveAppearance, setEffectiveAppearance] = useState<AppearancePreferences>(() =>
    appearanceController.getEffectiveAppearance()
  );
  useEffect(() => {
    return appearanceController.subscribe((controllerState) => {
      setEffectiveAppearance(controllerState.effectiveAppearance);
    });
  }, [appearanceController]);

  const runtimeWorkStyles = useMemo(
    () => computeWorkAnimationStyles(effectiveAppearance.workAnimation),
    [effectiveAppearance.workAnimation]
  );

  const activeBackground = effectiveAppearance.customBackground;
  const activeWallpaperStyles = useMemo(
    () => computeWallpaperStyles(activeBackground?.image),
    [activeBackground?.image]
  );

  // Slash command catalog (Issue #9 T7): built-ins first (they keep precedence), then the
  // user's custom commands registered in Settings. Shared by the palette and the dispatcher.
  const customCommands = preferences.customCommands;
  const commandCatalog = useMemo(
    () => buildCommandCatalog(customCommands ?? []),
    [customCommands]
  );
  // Commands the user hid in Settings (Issue #9 T8) are left out of the palette and "/help"
  // only; dispatch keeps the full catalog so typing a hidden command still works.
  const hiddenCommandIds = preferences.hiddenCommandIds;
  const visibleCommandCatalog = useMemo(
    () => filterVisibleCommands(commandCatalog, hiddenCommandIds ?? []),
    [commandCatalog, hiddenCommandIds]
  );

  // Projects cluster: registry state and handlers. Real decision logic (already-active/
  // isBusy no-op guard, and whether removing the active project should switch the working
  // directory) lives in the pure decideSelectProject/decideRemoveProject; this hook is
  // thin glue delegating the actual working-directory switch to the connection cluster's
  // applyWorkingDirectory (the inversion this slice exists to make).
  const handleActivateProject = useCallback(
    (projectId: string) => {
      dispatch({ type: 'SET_ACTIVE_PROJECT', payload: { projectId } });
    },
    [dispatch]
  );

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
    onActivateProject: handleActivateProject,
  });

  const webPush = useWebPush({
    preferences: preferences.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES,
    language: preferences.language,
    projects: projectsRegistry.projects,
  });

  const webPushPrompt = useWebPushPrompt({
    webPush,
    notificationsEnabled: (preferences.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES).enabled,
    isWeb: isWebShim(),
  });
  const handleSystemNotificationsToggle = async (enabled: boolean) => {
    const result = await (enabled ? webPush.enable() : webPush.disable());
    if (!result.ok && result.status !== 'unsupported' && result.status !== 'unavailable') {
      throw new Error(result.error || t('settings.web_push_error'));
    }
  };

  const handleEnrollBrowser = async () => {
    const result = await webPush.enable();
    if (!result.ok || result.status !== 'subscribed') {
      throw new Error(result.error || t(`settings.web_push_${result.status}`));
    }
  };

  const projectsRegistryRef = useRef(projectsRegistry);
  projectsRegistryRef.current = projectsRegistry;
  const multiProjectStateRef = useRef(multiProjectState);
  multiProjectStateRef.current = multiProjectState;

  const handleSelectProjectAndSync = useCallback(
    (project: ProjectItem) => {
      setIsMobileNavOpen(false);
      handleSelectProject(project);
    },
    [handleSelectProject]
  );

  const handleRemoveProjectAndSync = useCallback(
    (projectId: string) => {
      dispatch({ type: 'REMOVE_PROJECT_STATE', payload: { projectId } });
      handleRemoveProject(projectId);
    },
    [dispatch, handleRemoveProject]
  );

  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isGitHubCloneOpen, setIsGitHubCloneOpen] = useState(false);
  const [isGitHubCreateOpen, setIsGitHubCreateOpen] = useState(false);
  const [isDefaultDirSetupOpen, setIsDefaultDirSetupOpen] = useState(false);
  const [pendingActionAfterDefaultDir, setPendingActionAfterDefaultDir] = useState<'add_project' | 'github_clone' | 'github_create' | null>(null);
  const returnToCloneOnCancelRef = useRef(false);
  const cachedCloneRepoStateRef = useRef<any>(null);
  const addProjectTriggerRef = useRef<HTMLElement | null>(null);
  const gitHubCloneTriggerRef = useRef<HTMLElement | null>(null);
  const gitHubCreateTriggerRef = useRef<HTMLElement | null>(null);

  const handleOpenAddProject = useCallback(() => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      addProjectTriggerRef.current = document.activeElement;
    }
    // Close mobile drawer first if open to avoid conflicting modal traps and keep 1 active aria-modal
    if (isMobileNavOpen) {
      setIsMobileNavOpen(false);
    }
    if (!preferences.defaultProjectsDirectory) {
      setPendingActionAfterDefaultDir('add_project');
      setIsDefaultDirSetupOpen(true);
      return;
    }
    setIsFolderPickerOpen(true);
  }, [isMobileNavOpen, preferences.defaultProjectsDirectory]);

  const handleCloseFolderPicker = useCallback(() => {
    setIsFolderPickerOpen(false);
    if (returnToCloneOnCancelRef.current) {
      returnToCloneOnCancelRef.current = false;
      setIsGitHubCloneOpen(true);
      return;
    }
    const trigger = addProjectTriggerRef.current;
    if (trigger && typeof trigger.focus === 'function' && typeof document !== 'undefined' && document.contains(trigger)) {
      if (!trigger.closest?.('[inert], [aria-hidden="true"], .is-closed')) {
        trigger.focus();
      } else if (mobileMenuToggleRef.current && typeof mobileMenuToggleRef.current.focus === 'function') {
        mobileMenuToggleRef.current.focus();
      }
    }
    addProjectTriggerRef.current = null;
  }, []);

  const handleOpenGitHubClone = useCallback(() => {
    cachedCloneRepoStateRef.current = null;
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      gitHubCloneTriggerRef.current = document.activeElement;
    }
    if (isMobileNavOpen) {
      setIsMobileNavOpen(false);
    }
    if (!preferences.defaultProjectsDirectory) {
      setPendingActionAfterDefaultDir('github_clone');
      setIsDefaultDirSetupOpen(true);
      return;
    }
    setIsGitHubCloneOpen(true);
  }, [isMobileNavOpen, preferences.defaultProjectsDirectory]);

  const handleOpenGitHubCreate = useCallback(() => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      gitHubCreateTriggerRef.current = document.activeElement;
    }
    if (isMobileNavOpen) {
      setIsMobileNavOpen(false);
    }
    if (!preferences.defaultProjectsDirectory) {
      setPendingActionAfterDefaultDir('github_create');
      setIsDefaultDirSetupOpen(true);
      return;
    }
    setIsGitHubCreateOpen(true);
  }, [isMobileNavOpen, preferences.defaultProjectsDirectory]);

  const handleConfirmDefaultDirectory = useCallback(
    (directory: string) => {
      setDefaultProjectsDirectory(directory);
      setIsDefaultDirSetupOpen(false);
      const pending = pendingActionAfterDefaultDir;
      setPendingActionAfterDefaultDir(null);
      if (pending === 'add_project') {
        setIsFolderPickerOpen(true);
      } else if (pending === 'github_clone') {
        setIsGitHubCloneOpen(true);
      } else if (pending === 'github_create') {
        setIsGitHubCreateOpen(true);
      }
    },
    [pendingActionAfterDefaultDir, setDefaultProjectsDirectory]
  );

  const handleCloseDefaultDirSetup = useCallback(() => {
    setIsDefaultDirSetupOpen(false);
    setPendingActionAfterDefaultDir(null);
    returnToCloneOnCancelRef.current = false;
  }, []);

  const handleCloseGitHubClone = useCallback(() => {
    returnToCloneOnCancelRef.current = false;
    cachedCloneRepoStateRef.current = null;
    setIsGitHubCloneOpen(false);
    const trigger = gitHubCloneTriggerRef.current;
    if (trigger && typeof trigger.focus === 'function' && typeof document !== 'undefined' && document.contains(trigger)) {
      if (!trigger.closest?.('[inert], [aria-hidden="true"], .is-closed')) {
        trigger.focus();
      } else if (mobileMenuToggleRef.current && typeof mobileMenuToggleRef.current.focus === 'function') {
        mobileMenuToggleRef.current.focus();
      }
    }
    gitHubCloneTriggerRef.current = null;
  }, []);

  const handleCloseGitHubCreate = useCallback(() => {
    setIsGitHubCreateOpen(false);
    if (returnToCloneOnCancelRef.current) {
      returnToCloneOnCancelRef.current = false;
      setIsGitHubCloneOpen(true);
      return;
    }
    const trigger = gitHubCreateTriggerRef.current;
    if (trigger && typeof trigger.focus === 'function' && typeof document !== 'undefined' && document.contains(trigger)) {
      if (!trigger.closest?.('[inert], [aria-hidden="true"], .is-closed')) {
        trigger.focus();
      } else if (mobileMenuToggleRef.current && typeof mobileMenuToggleRef.current.focus === 'function') {
        mobileMenuToggleRef.current.focus();
      }
    }
    gitHubCreateTriggerRef.current = null;
  }, []);

  const handleAddProjectRef = useRef(handleAddProject);
  handleAddProjectRef.current = handleAddProject;

  const handleCloneSuccess = useCallback(
    (clonedPath: string) => {
      cachedCloneRepoStateRef.current = null;
      handleAddProjectRef.current(clonedPath);
      handleCloseGitHubClone();
    },
    [handleCloseGitHubClone]
  );

  const handleCreateSuccess = useCallback(
    (result: { path?: string }) => {
      returnToCloneOnCancelRef.current = false;
      if (result.path) {
        handleAddProjectRef.current(result.path);
      }
      handleCloseGitHubCreate();
    },
    [handleCloseGitHubCreate]
  );

  const handleConfirmAddProject = useCallback(
    (folderPath: string, customName?: string) => {
      returnToCloneOnCancelRef.current = false;
      handleAddProject(folderPath, customName);
      handleCloseFolderPicker();
    },
    [handleAddProject, handleCloseFolderPicker]
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
  const restoreExtensionPrompts = useSessionEvents({
    config,
    sessionId: state.sessionId,
    projectSessionIds: Object.fromEntries(Object.entries(multiProjectState.projects).map(([id, project]) => [id, project.sessionId])),
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

  // Explicit retry without replaying prompts. Reports whether a new attempt was started
  // (or one was already running) and, when started, the attempt's real outcome - used by
  // the "/reload" slash command (Issue #9 T6) to tell the user whether it worked.
  const requestRetry = (): ReloadRequest => {
    if (isConnecting || state.isResetting) return { status: 'busy' };
    dispatch({ type: 'CLEAR_ERROR' });
    return { status: 'started', result: retryConnection(config) };
  };

  const handleRetry = () => {
    requestRetry();
  };

  // Sessions-list cluster: loadSessions, the load-on-connect and busy->idle reload
  // effects, and the three session handlers. Real decision logic (the active-session
  // early return, the busy/switching guards, and what happens when a delete or a reset
  // targets the active session) lives in the pure, tested functions in
  // features/sessions/session-actions.ts.
  const {
    handleSelectSession,
    handleDeleteSession,
    handleRenameSession,
    handleNewConversation,
    handleLoadOlderMessages: triggerLoadOlderMessages,
  } = useSessions({
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

  const handleLoadOlderMessages = useCallback(async () => {
    const viewport = chatViewportRef.current;
    const prevScrollHeight = viewport ? viewport.scrollHeight : 0;
    await triggerLoadOlderMessages();
    if (viewport && prevScrollHeight > 0) {
      requestAnimationFrame(() => {
        preserveScrollOnPrepend(viewport, prevScrollHeight);
      });
    }
  }, [triggerLoadOlderMessages]);

  // Active session title for export (customTitle wins, falls back to firstMessage)
  const activeSession = useMemo(
    () => state.sessions.find((s) => s.id === state.sessionId),
    [state.sessions, state.sessionId]
  );
  const activeSessionTitle = resolveExportTitle(activeSession);

  const handleToggleZenModeRef = useRef<() => void>(() => {});

  const {
    handleExport,
    toast: exportToast,
    dismissToast: dismissExportToast,
  } = useConversationExport({
    messages: state.messages,
    sessionTitle: activeSessionTitle,
    language: preferences.language,
    dispatch,
  });

  // Prompt cluster: draft text, send/abort, and the Enter-to-send binding. Declared here
  // (rather than near useChatScroll, where it originally lived) because the Issue #9 slash
  // command dispatcher it now owns needs onReload (handleRetry) and onNewConversation
  // (useSessions.handleNewConversation), both declared just above. `pinAndJumpToBottom` is
  // T5a's scroll primitive, injected here rather than imported by the hook itself.
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
    language: preferences.language,
    onNewConversation: handleNewConversation,
    onReload: requestRetry,
    onExport: handleExport,
    onZenToggle: () => handleToggleZenModeRef.current(),
    commands: commandCatalog,
    helpCommands: visibleCommandCatalog,
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

  // Slash command palette (Issue #9): open/filter/navigation state derived from the live
  // prompt draft. Purely a typing aid at this point — selecting a command autocompletes
  // the draft to "/<name> "; whether that command then runs client-side or is forwarded to
  // Pi as-is is decided by the dispatcher wired into handleSend.
  const commandPalette = useCommandPalette({
    prompt,
    setPrompt,
    commands: visibleCommandCatalog,
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

  const resolveSessionSnapshot = useCallback((targetCwd: string, targetSessionId: string) => {
    return loadSessionProfileSnapshot(targetCwd, targetSessionId).snapshot;
  }, []);

  // Models cluster: thinking-level overrides map, model/thinking-level selection,
  // manual refresh, and the connect-time effect that fetches available models, thinking
  // levels, session stats, custom providers and the thinking-level overrides map.
  const {
    modelThinkingLevels,
    handleSelectModel,
    handleSelectThinkingLevel,
    handleRefreshModels,
    isSessionInitialized,
  } = useModels({
    connectionStatus: state.connectionStatus,
    sessionId: state.sessionId,
    projectId: projectsRegistry.activeProjectId ?? undefined,
    cwd: config.workingDirectory,
    modelInfo: state.modelInfo,
    availableModels: state.availableModels,
    dispatch,
    resolveSessionSnapshot,
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
      // Reconnecting the same hydrated session may not trigger useModels' effect.
      await handleRefreshModels();
    } finally {
      providerRefreshInFlight.current = false;
    }
  }, [state.connectionStatus, isBusy, config, startConnection, handleRefreshModels]);

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

  const profileRuntime = useProfileRuntime({
    cwd: config.workingDirectory,
    sessionId: state.sessionId,
    isConnected,
    isBusy,
    isSessionInitialized,
    isProfilesLoaded: profilesHook.isProfilesLoaded,
    loadedCwd: profilesHook.loadedCwd,
    effectiveProfile: profilesHook.effectiveProfile,
    availableModels: state.availableModels,
    onSelectModel: handleSelectModel,
    onSelectThinkingLevel: handleSelectThinkingLevel,
  });

  const effectiveModelInfo = useMemo(() => {
    if (state.modelInfo) return state.modelInfo;
    if (config.workingDirectory && state.sessionId) {
      const snap = loadSessionProfileSnapshot(config.workingDirectory, state.sessionId).snapshot;
      if (snap?.modelId) {
        return {
          id: snap.modelId,
          provider: snap.provider || '',
          name: snap.modelId,
        };
      }
    }
    return null;
  }, [state.modelInfo, config.workingDirectory, state.sessionId]);

  const handleManualSelectModel = useCallback(
    async (provider: string, modelId: string) => {
      profileRuntime.recordManualSelection();
      if (config.workingDirectory && state.sessionId) {
        updateSessionProfileSnapshotManualSelection(
          config.workingDirectory,
          state.sessionId,
          { provider, modelId }
        );
      }
      try {
        await handleSelectModel(provider, modelId);
      } catch (err) {
        console.warn('Manual model selection failed:', err);
      }
    },
    [profileRuntime, handleSelectModel, config.workingDirectory, state.sessionId]
  );

  const handleManualSelectThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      profileRuntime.recordManualSelection();
      if (config.workingDirectory && state.sessionId) {
        updateSessionProfileSnapshotManualSelection(
          config.workingDirectory,
          state.sessionId,
          { reasoningEffort: level }
        );
      }
      await handleSelectThinkingLevel(level);
    },
    [profileRuntime, handleSelectThinkingLevel, config.workingDirectory, state.sessionId]
  );

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
        profileRuntime.resetManualSelection();
        if (config.workingDirectory && state.sessionId) {
          const resolvedModel = resolveProfileModel(
            activatedProfile.default_model,
            state.availableModels
          );
          updateSessionProfileSnapshotExplicitProfile(
            config.workingDirectory,
            state.sessionId,
            {
              profileName: activatedProfile.name,
              profileScope: activatedProfile.scope,
              modelId: resolvedModel?.modelId ?? activatedProfile.default_model ?? null,
              provider: resolvedModel?.provider || null,
              reasoningEffort: activatedProfile.default_effort ?? null,
            }
          );
        }
        try {
          await applyProfileRuntime(activatedProfile, {
            isConnected,
            availableModels: state.availableModels,
            onSelectModel: handleSelectModel,
            onSelectThinkingLevel: handleSelectThinkingLevel,
          });
        } catch (err) {
          console.warn('Profile activation failed to apply runtime model:', err);
        }
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
            try {
              await applyProfileRuntime(globalProf, {
                isConnected,
                availableModels: state.availableModels,
                onSelectModel: handleSelectModel,
                onSelectThinkingLevel: handleSelectThinkingLevel,
              });
            } catch (err) {
              console.warn('Fallback profile activation failed to apply runtime model:', err);
            }
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
    setIsMobileNavOpen(false);
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

  const handleToggleMobileNav = useCallback(() => {
    setIsMobileNavOpen((prev) => !prev);
  }, []);

  const handleCloseMobileNav = useCallback(() => {
    setIsMobileNavOpen(false);
  }, []);

  // Viewport tracking: automatically dismiss open mobile navigation on resize to desktop (>768px)
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      if (!checkIsMobileViewport() && isMobileNavOpen) {
        setIsMobileNavOpen(false);
      }
    };

    if (typeof window.matchMedia === 'function') {
      const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
      const handleMql = (e: MediaQueryListEvent) => {
        if (!e.matches && isMobileNavOpen) {
          setIsMobileNavOpen(false);
        }
      };
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', handleMql);
        return () => mql.removeEventListener('change', handleMql);
      }
    }

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMobileNavOpen]);

  const handleToggleZenMode = useCallback(() => {
    const hasOpenModal = Boolean(
      viewingFile ||
      profilesHook.isModalOpen ||
      isFolderPickerOpen ||
      isGitHubCloneOpen ||
      isGitHubCreateOpen ||
      commandPalette.isOpen ||
      activeDialog ||
      hasActiveModalOrOverlay(typeof document !== 'undefined' ? document : null)
    );
    if (hasOpenModal) {
      return;
    }
    if (showSettings) {
      setShowSettings(false);
    }
    setIsZenMode((prev) => !prev);
  }, [
    showSettings,
    viewingFile,
    profilesHook.isModalOpen,
    commandPalette.isOpen,
    activeDialog,
  ]);
  handleToggleZenModeRef.current = handleToggleZenMode;

  const handleExitZenMode = useCallback(() => {
    setIsZenMode(false);
  }, []);

  useEffect(() => {
    if (prevZenModeRef.current === undefined) {
      prevZenModeRef.current = isZenMode;
      return;
    }

    const prev = prevZenModeRef.current;
    prevZenModeRef.current = isZenMode;

    if (prev === isZenMode) {
      return;
    }

    const hasOpenModal = Boolean(
      viewingFile ||
      profilesHook.isModalOpen ||
      isFolderPickerOpen ||
      isGitHubCloneOpen ||
      showSettings ||
      commandPalette.isOpen ||
      activeDialog ||
      hasActiveModalOrOverlay(typeof document !== 'undefined' ? document : null)
    );

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isInputOrTextarea =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;

    const target = determineZenFocusTarget({
      isZenMode,
      prevZenMode: prev,
      hasOpenModal,
      activeElementIsInputOrTextarea: isInputOrTextarea,
    });

    if (target === 'floating-exit') {
      floatingExitRef.current?.focus();
    } else if (target === 'header-toggle') {
      zenToggleRef.current?.focus();
    }
  }, [
    isZenMode,
    viewingFile,
    profilesHook.isModalOpen,
    showSettings,
    commandPalette.isOpen,
    activeDialog,
  ]);

  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      const hasOpenModal = Boolean(
        viewingFile ||
        profilesHook.isModalOpen ||
        isFolderPickerOpen ||
        isGitHubCloneOpen ||
        showSettings ||
        commandPalette.isOpen ||
        isMobileNavOpen ||
        activeDialog ||
        hasActiveModalOrOverlay(typeof document !== 'undefined' ? document : null)
      );

      const action = resolveZenKeyboardAction(e, {
        isZenMode,
        hasOpenModal,
      });

      if (action === 'toggle') {
        e.preventDefault();
        handleToggleZenMode();
      } else if (action === 'exit') {
        e.preventDefault();
        handleExitZenMode();
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [
    isZenMode,
    viewingFile,
    profilesHook.isModalOpen,
    showSettings,
    commandPalette.isOpen,
    isMobileNavOpen,
    activeDialog,
    handleToggleZenMode,
    handleExitZenMode,
  ]);


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

  const terminal = useTerminal({
    activeProjectCwd: activeProject?.path ?? config.workingDirectory ?? null,
    activeProjectName: activeProjectName || 'Project',
  });

  // Localized presentation mappings preserving reducer contracts
  const localizedStatusLabel = formatLocalizedStatus(
    state.connectionStatus,
    state.agentActivity,
    preferences.language
  );

  return (
    <div className={`app-container ${isZenMode ? ZEN_MODE_CONTAINER_CLASS : ''}`}>
      {activeWallpaperStyles && (
        <div
          className="app-custom-background-layer"
          style={activeWallpaperStyles as React.CSSProperties}
          aria-hidden="true"
        />
      )}
      <header className="app-header" role="banner">
        <div className="header-brand">
          <button
            ref={mobileMenuToggleRef}
            type="button"
            className="btn-mobile-menu-toggle"
            onClick={handleToggleMobileNav}
            title={t('sidebar.toggle')}
            aria-label={t('sidebar.toggle')}
            aria-expanded={isMobileNavOpen}
            aria-controls={DRAWER_ID}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
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
            <h1 className="brand-title">
              <span className="brand-title-desktop">{t('app.title')}</span>
              <span
                className="brand-title-mobile"
                title={resolveMobileBrandTitle(activeProjectName, t('app.title'))}
              >
                {resolveMobileBrandTitle(activeProjectName, t('app.title'))}
              </span>
            </h1>
            <span className="brand-version">{t('app.version')}</span>
          </div>
        </div>

        <div className="header-controls">
          {shouldShowHeaderStatus(state.connectionStatus) && (
            <div className="header-status" role="status" aria-live="polite">
              <span
                className={`status-indicator status-${state.connectionStatus}`}
                aria-hidden="true"
              />
              <span className="status-label">{localizedStatusLabel}</span>
            </div>
          )}

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

          <button
            type="button"
            className={`btn-terminal-toggle ${terminal.isOpen ? 'is-active' : ''}`}
            onClick={terminal.isOpen ? terminal.minimizeTerminal : terminal.openTerminal}
            title={terminal.isOpen ? t('terminal.minimize') : t('terminal.open')}
            aria-label={t('terminal.title')}
            aria-pressed={terminal.isOpen}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="terminal-toggle-text">{t('terminal.title')}</span>
          </button>

          <button
            ref={zenToggleRef}
            type="button"
            className="btn-zen-toggle"
            onClick={handleToggleZenMode}
            title={isZenMode ? t('zen.exit_title') : t('zen.enter_title')}
            aria-label={isZenMode ? t('zen.exit_title') : t('zen.enter_title')}
            aria-pressed={isZenMode}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
            <span className="zen-toggle-text">{t('zen.toggle_button')}</span>
          </button>
        </div>
      </header>

      {/* Workspace Layout: Navigation Drawer + Main Content */}
      <div className="app-workspace">
        <MobileNavigation
          isOpen={isMobileNavOpen}
          onClose={handleCloseMobileNav}
          activeProjectName={activeProjectName}
          locale={preferences.language}
          triggerRef={mobileMenuToggleRef}
          restoreFocusOnClose={!isFolderPickerOpen && !isGitHubCloneOpen && !isGitHubCreateOpen}
        >
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
            onOpenAddProject={handleOpenAddProject}
            onOpenGitHubClone={handleOpenGitHubClone}
            footerControl={webLogoutControl}
          />

          {(state.isSidebarOpen || isMobileNavOpen) && (
            <SessionSidebar
              projectName={activeProjectName}
              sessions={state.sessions}
              isLoading={state.isSessionsLoading}
              isSwitching={state.isSwitchingSession}
              error={state.sessionsError}
              activeSessionId={state.sessionId}
              activeSessionFile={state.sessionFile}
              onSelectSession={(session) => {
                handleCloseMobileNav();
                handleSelectSession(session);
              }}
              onNewSession={() => {
                handleCloseMobileNav();
                handleNewConversation();
              }}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onClose={() => {
                if (isMobileNavOpen) {
                  handleCloseMobileNav();
                } else {
                  dispatch({ type: 'TOGGLE_SIDEBAR', payload: { isOpen: false } });
                }
              }}
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
                  isAgentWorking={isBusy}
                />
              }
            />
          )}
        </MobileNavigation>

        <main className="workspace-main" role="main">
          {isZenMode && (
            <button
              ref={floatingExitRef}
              type="button"
              className="btn-zen-floating-exit"
              onClick={handleExitZenMode}
              title={t('zen.exit_title')}
              aria-label={t('zen.exit_title')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
              <span>{t('zen.exit_button')}</span>
            </button>
          )}
          {showSettings ? (
            <React.Suspense fallback={<div className="settings-loading-pane">{t('settings.loading')}</div>}>
              <SettingsView
                config={config}
                settingsDraft={settingsDraft}
                setSettingsDraft={setSettingsDraft}
                preferences={preferences}
                onThemeChange={handleThemeChange}
                onLanguageChange={handleLanguageChange}
                onNotificationsChange={setNotifications}
                onSystemNotificationsToggle={handleSystemNotificationsToggle}
                onEnrollBrowser={handleEnrollBrowser}
                webPushStatus={webPush.isSupported ? webPush.status : undefined}
                onCustomCommandsChange={setCustomCommands}
                onHiddenCommandIdsChange={setHiddenCommandIds}
                onDefaultProjectsDirectoryChange={setDefaultProjectsDirectory}
                onSpeechPreferencesChange={setSpeechPreferences}
                appearanceController={appearanceController}
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
                  <React.Suspense fallback={null}>
                    <ProfilesView
                      cwd={config.workingDirectory}
                      availableModels={state.availableModels}
                      isBusy={isBusy}
                      onClose={onBackToSettings}
                    />
                  </React.Suspense>
                )}
                renderProviders={() => (
                  <React.Suspense fallback={null}>
                    <ProvidersView
                      onRefreshModels={handleProviderModelsChanged}
                      t={t}
                      language={preferences.language}
                      isBusy={isBusy}
                    />
                  </React.Suspense>
                )}
                renderMcp={() => (
                  <React.Suspense fallback={null}>
                    <McpView
                      servers={globalMcp.servers}
                      onToggleServer={async (server, enabled) => {
                        await globalMcp.handleToggleServer(server, enabled, 'global');
                        void projectMcp.refreshServers();
                      }}
                      onToggleAlwaysActive={async (server, alwaysActive) => {
                        await globalMcp.handleToggleAlwaysActive(server, alwaysActive);
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
                  </React.Suspense>
                )}
                renderExtensions={() => (
                  <React.Suspense fallback={null}>
                    <ExtensionsView
                      resources={globalPiResources.resources}
                      onToggleResource={async (resource, enabled) => {
                        await globalPiResources.handleToggleResource(resource, enabled, 'global');
                        void projectPiResources.refreshResources();
                      }}
                      onToggleAlwaysActive={async (resource, alwaysActive) => {
                        await globalPiResources.handleToggleAlwaysActive(resource, alwaysActive);
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
                  </React.Suspense>
                )}
              />
            </React.Suspense>
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

        <div className="chat-file-drop-zone" data-file-drop-zone>
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
              {state.hasMoreMessages && (
                <li className="load-older-messages-item">
                  <button
                    type="button"
                    className="load-older-messages-btn"
                    onClick={handleLoadOlderMessages}
                    disabled={state.isLoadingOlderMessages}
                    aria-label={t('chat.load_older_messages')}
                  >
                    {state.isLoadingOlderMessages ? (
                      <span className="load-older-spinner" aria-hidden="true" />
                    ) : null}
                    <span>
                      {state.isLoadingOlderMessages
                        ? t('chat.loading_older_messages')
                        : t('chat.load_older_messages')}
                    </span>
                  </button>
                </li>
              )}
              {mergeConsecutiveAssistantMessages(
                state.messages.filter((msg) => !isMessageEmpty(msg))
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
                        {groupMessageBlocks(msg.blocks).map((item, iIndex) => {
                          if (item.type === 'process_group') {
                            return (
                              <ProcessGroupCard key={item.id} group={item} t={t} />
                            );
                          }
                          const block = item.block;
                          if (block.type === 'text') {
                            return (
                              <div key={`text-${iIndex}`} style={{ display: 'flex', flexDirection: 'column' }}>
                                <MarkdownContent
                                  content={block.text}
                                  t={t}
                                  onInsertCode={insertCodeIntoPrompt}
                                />
                                {preferences.speech?.ttsEnabled && (
                                  <div style={{ marginTop: '4px', alignSelf: 'flex-start' }}>
                                    <MessageSpeechButton text={block.text} preferences={preferences.speech} />
                                  </div>
                                )}
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    ) : shouldRenderAsMarkdown(msg.role) ? (
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <MarkdownContent content={msg.content} t={t} onInsertCode={insertCodeIntoPrompt} />
                        {preferences.speech?.ttsEnabled && msg.role !== 'user' && (
                          <div style={{ marginTop: '4px', alignSelf: 'flex-start' }}>
                            <MessageSpeechButton text={msg.content} preferences={preferences.speech} />
                          </div>
                        )}
                      </div>
                    ) : msg.role === 'user' ? (
                      <>
                        {msg.images && msg.images.length > 0 && (
                          <MessageImageThumbnails images={msg.images} t={t} />
                        )}
                        <UserMessageContent content={msg.content} />
                      </>
                    ) : (
                      <>
                        {msg.images && msg.images.length > 0 && (
                          <MessageImageThumbnails images={msg.images} t={t} />
                        )}
                        <div className="message-literal">{msg.content}</div>
                      </>
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
                {isIndicatorActive && (
                  <span
                    className={runtimeWorkStyles.className}
                    style={runtimeWorkStyles.style as React.CSSProperties}
                    aria-hidden="true"
                  >
                    <span className="loader">
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                        <span
                          key={`wdot-1-${i}`}
                          className="dot"
                          style={{ '--i': i } as React.CSSProperties}
                        />
                      ))}
                    </span>
                    <span className="working-text">{workingStatusText}</span>
                    <span className="loader">
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                        <span
                          key={`wdot-2-${i}`}
                          className="dot"
                          style={{ '--i': i } as React.CSSProperties}
                        />
                      ))}
                    </span>
                  </span>
                )}
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

            <div style={{ position: 'relative', width: '100%' }}>
              <textarea
                id="prompt-input"
                name="prompt"
                aria-label={t('prompt.label')}
                className={`prompt-textarea ${isHighContext ? 'context-pulse-red' : ''}`}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (commandPalette.handleKeyDown(e)) return;
                  handleKeyDown(e);
                }}
                role="combobox"
                aria-expanded={commandPalette.isOpen}
                aria-controls={commandPalette.isOpen ? 'command-palette-listbox' : undefined}
                aria-autocomplete="list"
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
                style={{ paddingLeft: preferences.speech?.sttEnabled ? '46px' : undefined }}
              />

              {preferences.speech?.sttEnabled && (
                <div
                  style={{
                    position: 'absolute',
                    left: '10px',
                    bottom: '12px',
                    zIndex: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'auto',
                  }}
                >
                  <PromptMicButton
                    preferences={preferences.speech}
                    onTranscription={(transcribedText) => {
                      setPrompt((prev) => (prev ? `${prev} ${transcribedText}` : transcribedText));
                    }}
                    disabled={isBusy}
                  />
                </div>
              )}
            </div>

            {commandPalette.isOpen && (
              <CommandPalettePopover
                commands={commandPalette.filteredCommands}
                selectedIndex={commandPalette.selectedIndex}
                onSelect={commandPalette.select}
                onHoverIndex={commandPalette.setSelectedIndex}
                language={preferences.language}
                t={t}
              />
            )}

            <PromptControls
              modelInfo={effectiveModelInfo}
              speechPreferences={preferences.speech}
              onTranscription={(transcribedText) => {
                setPrompt((prev) => (prev ? `${prev} ${transcribedText}` : transcribedText));
              }}
              availableModels={state.availableModels}
              isChangingModel={state.isChangingModel}
              thinkingLevel={state.thinkingLevel}
              defaultThinkingLevel={resolveModelDefaultThinkingLevel(effectiveModelInfo, modelThinkingLevels, state.availableThinkingLevels)}
              availableThinkingLevels={state.availableThinkingLevels}
              sessionStats={state.sessionStats}
              isHighContext={isHighContext}
              isConnected={isConnected}
              isBusy={isBusy}
              canSend={(isReadyToSend || canQueue) && (prompt.trim().length > 0 || attachedFiles.length > 0)}
              attachedFiles={attachedFiles}
              onAttachFiles={addAttachedFiles}
              onAbort={handleAbort}
              onSelectModel={handleManualSelectModel}
              onSelectThinkingLevel={handleManualSelectThinkingLevel}
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
        </div>
            </>
          )}
        </main>
      </div>

      {viewingFile && (
        <React.Suspense fallback={null}>
          <FileViewerModal
            file={viewingFile}
            workingDirectory={config.workingDirectory}
            onClose={closeFile}
            locale={preferences.language}
          />
        </React.Suspense>
      )}

      {profilesHook.isModalOpen && (
        <React.Suspense fallback={null}>
          <ProfileModal
            isOpen={profilesHook.isModalOpen}
            isEditing={profilesHook.isEditing}
            isSaving={profilesHook.isSaving}
            formData={profilesHook.formData}
            error={profilesHook.modalError}
            availableModels={profilesHook.availableModels}
            categories={profilesHook.categories}
            agentMeta={profilesHook.agentMeta}
            cwd={config.workingDirectory}
            onClose={profilesHook.closeModal}
            onChangeField={profilesHook.updateFormField}
            onChangeAgentModel={profilesHook.updateAgentModel}
            onRemoveAgentOverride={profilesHook.removeAgentOverride}
            onSave={async (e) => {
              await profilesHook.handleSaveProfile(e);
            }}
          />
        </React.Suspense>
      )}

      {isFolderPickerOpen && (
        <React.Suspense fallback={null}>
          <FolderPickerModal
            isOpen={isFolderPickerOpen}
            initialPath={
              preferences.defaultProjectsDirectory ||
              projectsRegistry.projects.find((p) => p.id === projectsRegistry.activeProjectId)?.path ||
              config.workingDirectory
            }
            onClose={handleCloseFolderPicker}
            onSelectFolder={handleConfirmAddProject}
            locale={preferences.language}
          />
        </React.Suspense>
      )}

      {isGitHubCloneOpen && (
        <React.Suspense fallback={null}>
          <GitHubCloneModal
            isOpen={isGitHubCloneOpen}
            initialDestinationPath={
              preferences.defaultProjectsDirectory ||
              projectsRegistry.projects.find((p) => p.id === projectsRegistry.activeProjectId)?.path ||
              config.workingDirectory
            }
            initialRepoState={cachedCloneRepoStateRef.current ?? undefined}
            onRepoStateChange={(state) => {
              cachedCloneRepoStateRef.current = state;
            }}
            onClose={handleCloseGitHubClone}
            onCloneSuccess={handleCloneSuccess}
            onOpenLocalFolder={() => {
              returnToCloneOnCancelRef.current = true;
              setIsGitHubCloneOpen(false);
              handleOpenAddProject();
            }}
            onOpenCreateRepo={() => {
              returnToCloneOnCancelRef.current = true;
              setIsGitHubCloneOpen(false);
              handleOpenGitHubCreate();
            }}
            locale={preferences.language}
          />
        </React.Suspense>
      )}

      {isGitHubCreateOpen && (
        <React.Suspense fallback={null}>
          <GitHubCreateModal
            isOpen={isGitHubCreateOpen}
            initialDestinationPath={
              preferences.defaultProjectsDirectory ||
              projectsRegistry.projects.find((p) => p.id === projectsRegistry.activeProjectId)?.path ||
              config.workingDirectory
            }
            onClose={handleCloseGitHubCreate}
            onCreateSuccess={handleCreateSuccess}
            locale={preferences.language}
          />
        </React.Suspense>
      )}

      {isDefaultDirSetupOpen && (
        <React.Suspense fallback={null}>
          <DefaultDirectorySetupModal
            isOpen={isDefaultDirSetupOpen}
            initialPath={
              preferences.defaultProjectsDirectory ||
              projectsRegistry.projects.find((p) => p.id === projectsRegistry.activeProjectId)?.path ||
              config.workingDirectory
            }
            onClose={handleCloseDefaultDirSetup}
            onConfirm={handleConfirmDefaultDirectory}
            locale={preferences.language}
          />
        </React.Suspense>
      )}

      <ExportToast
        toast={exportToast}
        onDismiss={dismissExportToast}
        closeAriaLabel={t('command_palette.toast_close')}
      />

      <WebPushInvitation
        isOpen={webPushPrompt.isOpen}
        isPending={webPushPrompt.isPending}
        error={webPushPrompt.error}
        onAccept={webPushPrompt.accept}
        onDecline={webPushPrompt.decline}
        t={t}
      />

      <TerminalOverlay
        isOpen={terminal.isOpen}
        projectName={activeProjectName || 'Project'}
        projectCwd={activeProject?.path ?? config.workingDirectory ?? ''}
        session={terminal.currentSession}
        locale={preferences.language}
        status={terminal.status}
        errorMessage={terminal.errorMessage}
        exitCode={terminal.exitCode}
        isMobile={checkIsMobileViewport()}
        onMinimize={terminal.minimizeTerminal}
        onTerminate={terminal.requestTerminate}
        onRetry={terminal.retryConnection}
        onInput={terminal.handleInput}
        onResize={terminal.handleResize}
        terminalInstanceRef={terminal.terminalInstanceRef}
      />

      <TerminateConfirmationModal
        isOpen={terminal.isTerminateConfirmOpen}
        projectName={activeProjectName || 'Project'}
        locale={preferences.language}
        onConfirm={terminal.confirmTerminate}
        onCancel={terminal.cancelTerminate}
      />
    </div>
  );
};
