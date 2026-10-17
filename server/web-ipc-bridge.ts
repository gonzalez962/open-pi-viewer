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
  handleReadWorkspaceFile,
  handleGetWorkspaceGitStatus,
  handleGetWorkspaceFileDiff,
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
  handleGetAvailableModels,
  handleGetEnabledModels,
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
    case 'read_workspace_file':
      return handleReadWorkspaceFile(args);
    case 'get_workspace_git_status':
      return handleGetWorkspaceGitStatus(args);
    case 'get_workspace_file_diff':
      return handleGetWorkspaceFileDiff(args);
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
    default:
      return null;
  }
}
