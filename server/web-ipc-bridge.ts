export type { SubprocessSpawner } from './bridge/state';
export {
  setSessionsRootDirForTest,
  getSessionsRootDir,
  setSubprocessSpawnerForTest,
  getSessionStatus,
  setSessionStatus,
  setSessionAliveChecker,
  sessionParseCache,
  invalidateSessionParseCache,
  getActiveThinkingLevel,
} from './bridge/state';

export { addSseClient, removeSseClient, broadcastSse } from './bridge/sse';
export { resolveCrossPlatformCwd, getAvailableDrives, getFilesystemShortcuts } from './bridge/paths';
export { getOrCreatePiRpc, resetPiRpcForTest } from './bridge/rpc';

export {
  resolveSessionsDir,
  discoverAllProjectsWithSessions,
  parseSessionFile,
  listSessions,
  calculateSessionStats,
} from './bridge/sessions';

export type { PiChainStep, PiChain } from './bridge/sdd';
export {
  discoverAgentDefinitions,
  getSddProfilesImpl,
  setActiveSddProfileImpl,
  discoverPiChains,
} from './bridge/sdd';

export {
  getEngramProjectImpl,
  getEngramCloudStatusImpl,
  enrollEngramProjectImpl,
  getEngramObservationsImpl,
  parseEngramProjectFromStats,
  parseEngramCloudStatus,
  clearEngramCacheForTest,
} from './bridge/engram';

export {
  getGithubAuthStatus,
  cloneGithubRepository,
  createGithubRepository,
  listGithubRepositories,
  setProcessRunnerForTest,
  parseGithubRepository,
  buildChildGitEnv,
  groupRepositoriesByOwner,
  parsePaginatedJsonArrays,
} from './bridge/github';

export {
  loadResourceActivationPolicy,
  saveResourceActivationPolicy,
  loadProjectResourceActivation,
  saveProjectResourceActivation,
  getProjectResourceActivationPath,
  setResourceActivation,
  normalizeProjectCwd,
  getEffectiveExtensionActivation,
  getEffectiveMcpActivation,
  materializeProjectMcpEnforcement,
  computeRpcStartupArgs,
  setPiAgentDirForTest,
  getPiAgentDir,
} from './bridge/resource-activation';

export {
  getMcpServersImpl,
  getPiResourcesImpl,
  getAvailableModelsImpl,
  handleGetEnabledModels,
  handleToggleMcpServer,
  handleTogglePiResource,
} from './bridge/models';

export {
  handleUpsertCustomProvider,
  handleDeleteCustomProvider,
} from './bridge/custom-providers';

import { handleDeleteMcpServer, handleDeletePiResource } from './bridge/resource-deletion';

import {
  handlePickDirectory,
  handleBrowseFilesystem,
  handleListWorkspaceDir,
  handleCreateWorkspaceDir,
  handleDeleteWorkspaceDir,
  handleReadWorkspaceFile,
  handleGetWorkspaceGitStatus,
  handleGetWorkspaceFileDiff,
  handleListWorkspaceBranches,
  handleSwitchWorkspaceBranch,
  handleCreateWorkspaceBranch,
  handleDeleteWorkspaceBranch,
  handlePublishWorkspaceBranch,
  handleListWorkspaceBranchCommits,
} from './bridge/paths';

import {
  handleDiscoverEnvironment,
  handleDetectGentleShell,
  handleSendPrompt,
  handleSendExtensionUiResponse,
  handleAbort,
  handleDisconnect,
  handleStopSession,
  handleGetBridgeState,
} from './bridge/rpc';

import {
  handleConnect,
  handleListSessions,
  handleSwitchSession,
  handleGetMessages,
  handleNewSession,
  handleDeleteSession,
  handleRenameSession,
  handleGetSessionStats,
  handleGetSessionPersistenceStatus,
  handleDiscoverAllProjects,
} from './bridge/sessions';

import {
  handleGetSddProfiles,
  handleSetActiveSddProfile,
  handleSaveSddProfile,
  handleDeleteSddProfile,
  handleGetPiChains,
} from './bridge/sdd';

import {
  handleGetEngramProject,
  handleGetEngramCloudStatus,
  handleEnrollEngramProject,
  handleGetEngramObservations,
} from './bridge/engram';

import {
  getGithubAuthStatus,
  cloneGithubRepository,
  createGithubRepository,
  listGithubRepositories,
} from './bridge/github';

import {
  handleGetAvailableModels,
  handleGetEnabledModels,
  handleSaveEnabledModels,
  handleSetModel,
  handleGetAvailableThinkingLevels,
  handleSetThinkingLevel,
  handleGetCustomProviders,
  handleSaveCustomProviders,
  handleGetModelThinkingLevels,
  handleSaveModelThinkingLevels,
  handleGetMcpServers,
  handleToggleMcpServer,
  handleGetPiResources,
  handleTogglePiResource,
} from './bridge/models';

import {
  handleUpsertCustomProvider,
  handleDeleteCustomProvider,
} from './bridge/custom-providers';

import {
  setResourceActivation,
} from './bridge/resource-activation';

import {
  loadViewerStorage,
  saveViewerStorage,
  updateViewerStorageKey,
} from './storage';
import {
  inspectOfficialPack,
  downloadOfficialPack,
  deleteOfficialPack,
  inspectCustomModel,
} from './bridge/speech';
import {
  synthesizeTts,
  transcribeStt,
} from './bridge/speech-runner';
import {
  checkWyomingHealth,
} from './bridge/wyoming-client';
import {
  manageDockerSpeechService,
  getDockerContainerInfo,
  type DockerSpeechService,
  type DockerSpeechAction,
} from './bridge/docker-speech';
import { broadcastSse } from './bridge/sse';
import {
  OFFICIAL_SPEECH_PACKS,
} from '../src/core/types/speech';

import { isOAuthCommand, OAUTH_UNAUTHORIZED_MESSAGE } from './bridge/oauth-access';
import { oauthManager } from './bridge/oauth';

// ---------------------------------------------------------------------------
// IPC Command Dispatcher
// ---------------------------------------------------------------------------

export interface WebIpcContext {
  oauthOwner?: string;
}

export async function handleIpcCommand(cmd: string, args: any = {}, context: WebIpcContext = {}) {
  if (isOAuthCommand(cmd) && !context.oauthOwner) {
    throw new Error(OAUTH_UNAUTHORIZED_MESSAGE);
  }
  switch (cmd) {
    case 'discover_environment':
      return handleDiscoverEnvironment();
    case 'detect_gentle_shell':
      return handleDetectGentleShell();
    case 'connect':
      return await handleConnect(args);
    case 'send_prompt':
      return await handleSendPrompt(args);
    case 'send_extension_ui_response':
      return await handleSendExtensionUiResponse(args);
    case 'abort':
      return await handleAbort(args);
    case 'disconnect':
      return handleDisconnect();
    case 'stop_session':
      return handleStopSession(args);
    case 'list_sessions':
      return handleListSessions(args);
    case 'switch_session':
      return handleSwitchSession(args);
    case 'get_messages':
      return handleGetMessages();
    case 'new_session':
      return handleNewSession();
    case 'delete_session':
      return handleDeleteSession(args);
    case 'rename_session':
      return await handleRenameSession(args);
    case 'get_sdd_profiles':
      return handleGetSddProfiles(args);
    case 'set_active_sdd_profile':
      return handleSetActiveSddProfile(args);
    case 'save_sdd_profile':
      return handleSaveSddProfile(args);
    case 'delete_sdd_profile':
      return handleDeleteSddProfile(args);
    case 'get_pi_chains':
      return handleGetPiChains();
    case 'get_available_models':
      return handleGetAvailableModels();
    case 'get_enabled_models':
      return handleGetEnabledModels();
    case 'save_enabled_models':
      return handleSaveEnabledModels(args.payload || args);
    case 'set_model':
      return await handleSetModel(args);
    case 'get_available_thinking_levels':
      return handleGetAvailableThinkingLevels();
    case 'set_thinking_level':
      return await handleSetThinkingLevel(args);
    case 'get_custom_providers':
      return handleGetCustomProviders();
    case 'save_custom_providers':
      return handleSaveCustomProviders(args);
    case 'upsert_custom_provider':
      return handleUpsertCustomProvider(args.payload || args);
    case 'delete_custom_provider':
      return handleDeleteCustomProvider(args.payload || args);
    case 'get_model_thinking_levels':
      return handleGetModelThinkingLevels();
    case 'save_model_thinking_levels':
      return handleSaveModelThinkingLevels(args);
    case 'get_mcp_servers':
      return handleGetMcpServers(args);
    case 'toggle_mcp_server':
      return await handleToggleMcpServer(args.payload || args);
    case 'delete_mcp_server':
      return handleDeleteMcpServer(args.payload || args);
    case 'get_pi_resources':
      return handleGetPiResources(args);
    case 'toggle_pi_resource':
      return await handleTogglePiResource(args.payload || args);
    case 'delete_pi_resource':
      return handleDeletePiResource(args.payload || args);
    case 'set_resource_activation':
      return await setResourceActivation(args.payload || args);
    case 'get_builtin_oauth_providers':
      return oauthManager.list(context.oauthOwner);
    case 'get_builtin_provider_catalog': {
      const rawPayload = args.payload ?? args;
      const providerId = typeof rawPayload === 'string' ? rawPayload : rawPayload?.providerId;
      if (!providerId || typeof providerId !== 'string' || !providerId.trim()) {
        throw new Error('Provider ID is required to query configuration catalog');
      }
      return await oauthManager.catalog(providerId.trim(), context.oauthOwner);
    }
    case 'start_oauth_login':
      return oauthManager.start(context.oauthOwner!, args.payload);
    case 'cancel_oauth_login':
      return oauthManager.cancel(context.oauthOwner!, args.payload);
    case 'send_oauth_prompt_response':
      return oauthManager.respond(context.oauthOwner!, args.payload);
    case 'logout_oauth_provider':
      return oauthManager.logout(context.oauthOwner!, args.payload);
    case 'get_engram_project':
      return handleGetEngramProject(args);
    case 'get_engram_cloud_status':
      return await handleGetEngramCloudStatus(args);
    case 'enroll_engram_project':
      return handleEnrollEngramProject(args);
    case 'get_engram_observations':
      return handleGetEngramObservations(args);
    case 'list_workspace_dir':
      return handleListWorkspaceDir(args);
    case 'create_workspace_dir':
      return handleCreateWorkspaceDir(args);
    case 'delete_workspace_dir':
      return handleDeleteWorkspaceDir(args);
    case 'read_workspace_file':
      return handleReadWorkspaceFile(args);
    case 'get_workspace_git_status':
      return handleGetWorkspaceGitStatus(args);
    case 'get_workspace_file_diff':
      return handleGetWorkspaceFileDiff(args);
    case 'list_workspace_branches':
      return handleListWorkspaceBranches(args);
    case 'switch_workspace_branch':
      return handleSwitchWorkspaceBranch(args);
    case 'create_workspace_branch':
      return handleCreateWorkspaceBranch(args);
    case 'delete_workspace_branch':
      return handleDeleteWorkspaceBranch(args);
    case 'publish_workspace_branch':
      return handlePublishWorkspaceBranch(args);
    case 'list_workspace_branch_commits':
      return handleListWorkspaceBranchCommits(args);
    case 'get_session_stats':
      return await handleGetSessionStats();
    case 'get_session_persistence_status':
      return handleGetSessionPersistenceStatus();
    case 'discover_all_projects':
      return handleDiscoverAllProjects();
    case 'pick_directory':
      return handlePickDirectory(args);
    case 'get_bridge_state':
      return handleGetBridgeState();
    case 'browse_filesystem':
      return handleBrowseFilesystem(args);
    case 'get_github_auth_status':
      return await getGithubAuthStatus();
    case 'list_github_repositories':
      return await listGithubRepositories(args.payload || args);
    case 'clone_github_repository':
      return await cloneGithubRepository(args.payload || args);
    case 'create_github_repository':
      return await createGithubRepository(args.payload || args);
    case 'get_viewer_storage':
      return loadViewerStorage();
    case 'save_viewer_storage':
      return saveViewerStorage(args.payload || args);
    case 'update_viewer_storage_key': {
      const payload = args.payload || args;
      return updateViewerStorageKey(payload.key, payload.value);
    }
    case 'get_speech_pack_status': {
      const payload = args.payload || args;
      const packId = payload?.packId;
      const pack = OFFICIAL_SPEECH_PACKS[packId];
      if (!pack) throw new Error(`Unknown pack ID: ${packId}`);
      return await inspectOfficialPack(pack);
    }
    case 'download_speech_pack': {
      const payload = args.payload || args;
      const packId = payload?.packId;
      return await downloadOfficialPack(packId, (progress) => {
        broadcastSse('speech://download_progress', progress);
      });
    }
    case 'delete_speech_pack': {
      const payload = args.payload || args;
      const packId = payload?.packId;
      return await deleteOfficialPack(packId);
    }
    case 'inspect_custom_speech_model': {
      const payload = args.payload || args;
      return await inspectCustomModel(payload);
    }
    case 'check_wyoming_service': {
      const payload = args.payload || args;
      const url = payload?.url || 'tcp://127.0.0.1:10200';
      return await checkWyomingHealth(url);
    }
    case 'synthesize_speech_tts': {
      const payload = args.payload || args;
      return await synthesizeTts(payload);
    }
    case 'transcribe_speech_stt': {
      const payload = args.payload || args;
      const audioBuffer = payload.audioBase64
        ? Buffer.from(payload.audioBase64, 'base64')
        : Buffer.from(payload.audioBuffer || '');
      return await transcribeStt({
        audioBuffer,
        mimeType: payload.mimeType,
        preferences: payload.preferences,
      });
    }
    case 'manage_docker_speech_service': {
      const payload = args.payload || args;
      const service = payload.service as DockerSpeechService;
      const action = payload.action as DockerSpeechAction;
      const preferences = payload.preferences;
      return await manageDockerSpeechService(service, action, preferences);
    }
    case 'get_docker_speech_status': {
      const payload = args.payload || args;
      const service = payload.service as DockerSpeechService;
      return await getDockerContainerInfo(service);
    }
    default:
      return null;
  }
}
