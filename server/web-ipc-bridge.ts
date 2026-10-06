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

export { getMcpServersImpl, getPiResourcesImpl, getAvailableModelsImpl } from './bridge/models';

import {
  handlePickDirectory,
  handleBrowseFilesystem,
  handleListWorkspaceDir,
  handleReadWorkspaceFile,
  handleGetWorkspaceGitStatus,
} from './bridge/paths';

import {
  handleDiscoverEnvironment,
  handleDetectGentleShell,
  handleSendPrompt,
  handleSendExtensionUiResponse,
  handleAbort,
  handleDisconnect,
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
  handleGetBuiltinOAuthProviders,
} from './bridge/models';

// ---------------------------------------------------------------------------
// IPC Command Dispatcher
// ---------------------------------------------------------------------------

export async function handleIpcCommand(cmd: string, args: any = {}) {
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
      return await handleAbort();
    case 'disconnect':
      return handleDisconnect();
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
    case 'get_model_thinking_levels':
      return handleGetModelThinkingLevels();
    case 'save_model_thinking_levels':
      return handleSaveModelThinkingLevels(args);
    case 'get_mcp_servers':
      return handleGetMcpServers(args);
    case 'toggle_mcp_server':
      return handleToggleMcpServer(args);
    case 'get_pi_resources':
      return handleGetPiResources(args);
    case 'get_builtin_oauth_providers':
      return handleGetBuiltinOAuthProviders();
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
