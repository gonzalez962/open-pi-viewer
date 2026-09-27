//! Tauri IPC command handlers for Pi RPC bridge, organized by domain.
//!
//! Generic RPC input is NOT exposed to the frontend:
//! only bounded commands are allowed.
//!
//! Employs generation gating so concurrent connects/disconnects cancel in-flight handshakes,
//! stale sessions are terminated, and only the current generation publishes status or events.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

use crate::process::ActiveSession;

/// Shared application state managed by Tauri
pub struct AppState {
    pub session: Arc<Mutex<Option<ActiveSession>>>,
    pub sessions: Arc<Mutex<HashMap<PathBuf, ActiveSession>>>,
    pub active_cwd: Arc<Mutex<Option<PathBuf>>>,
    pub generation: Arc<AtomicU64>,
    pub handshake_cancel_tx: Arc<Mutex<Option<(u64, oneshot::Sender<()>)>>>,
    pub declined_migrations: Arc<Mutex<HashSet<PathBuf>>>,
    pub active_oauth_login: Arc<Mutex<Option<oauth::ActiveOAuthSession>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            active_cwd: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            handshake_cancel_tx: Arc::new(Mutex::new(None)),
            declined_migrations: Arc::new(Mutex::new(HashSet::new())),
            active_oauth_login: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_session(&self) -> Result<ActiveSession, String> {
        let active_cwd = self.active_cwd.lock().await.clone();
        if let Some(cwd) = active_cwd {
            let sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(&cwd) {
                if session.is_alive() {
                    return Ok(session.clone());
                }
            }
        }

        let legacy = self.session.lock().await;
        if let Some(session) = legacy.as_ref() {
            if session.is_alive() {
                return Ok(session.clone());
            }
        }

        let sessions = self.sessions.lock().await;
        for session in sessions.values() {
            if session.is_alive() {
                return Ok(session.clone());
            }
        }

        Err("Pi RPC bridge is not connected".to_string())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}


pub mod config_files;
pub mod connection;
pub mod discovery;
pub mod external;
pub mod models;
pub mod oauth;
pub mod sessions;
pub mod workspace;

pub use connection::{
    abort,
    __cmd__abort,
    __tauri_command_name_abort,
    connect,
    __cmd__connect,
    __tauri_command_name_connect,
    disconnect,
    __cmd__disconnect,
    __tauri_command_name_disconnect,
    DisconnectPayload,
    get_bridge_state,
    __cmd__get_bridge_state,
    __tauri_command_name_get_bridge_state,
    get_messages,
    __cmd__get_messages,
    __tauri_command_name_get_messages,
    new_session,
    __cmd__new_session,
    __tauri_command_name_new_session,
    send_prompt,
    __cmd__send_prompt,
    __tauri_command_name_send_prompt,
    send_extension_ui_response,
    __cmd__send_extension_ui_response,
    __tauri_command_name_send_extension_ui_response,
    ExtensionUiResponsePayload,
    NewSessionResult,
    SendExtensionUiResponseResult,
    SendPromptPayload,
    SendPromptResult,
    validate_extension_ui_response,
    ABORT_TIMEOUT,
    MAX_EXTENSION_UI_ID_CHARS,
    MAX_EXTENSION_UI_VALUE_CHARS,
    MAX_PROMPT_CHARS,
    PROMPT_ACCEPT_TIMEOUT
};

pub use models::{
    get_available_models,
    __cmd__get_available_models,
    __tauri_command_name_get_available_models,
    get_available_thinking_levels,
    __cmd__get_available_thinking_levels,
    __tauri_command_name_get_available_thinking_levels,
    get_session_stats,
    __cmd__get_session_stats,
    __tauri_command_name_get_session_stats,
    set_model,
    __cmd__set_model,
    __tauri_command_name_set_model,
    set_thinking_level,
    __cmd__set_thinking_level,
    __tauri_command_name_set_thinking_level,
    get_available_models_impl,
    get_available_thinking_levels_impl,
    get_session_stats_impl,
    set_model_impl,
    set_thinking_level_impl
};

pub use config_files::{
    get_custom_providers,
    __cmd__get_custom_providers,
    __tauri_command_name_get_custom_providers,
    get_model_thinking_levels,
    __cmd__get_model_thinking_levels,
    __tauri_command_name_get_model_thinking_levels,
    save_custom_providers,
    __cmd__save_custom_providers,
    __tauri_command_name_save_custom_providers,
    upsert_custom_provider,
    __cmd__upsert_custom_provider,
    __tauri_command_name_upsert_custom_provider,
    delete_custom_provider,
    __cmd__delete_custom_provider,
    __tauri_command_name_delete_custom_provider,
    save_model_thinking_levels,
    __cmd__save_model_thinking_levels,
    __tauri_command_name_save_model_thinking_levels,
    get_mcp_servers,
    __cmd__get_mcp_servers,
    __tauri_command_name_get_mcp_servers,
    toggle_mcp_server,
    __cmd__toggle_mcp_server,
    __tauri_command_name_toggle_mcp_server,
    save_mcp_server,
    __cmd__save_mcp_server,
    __tauri_command_name_save_mcp_server,
    delete_mcp_server,
    __cmd__delete_mcp_server,
    __tauri_command_name_delete_mcp_server,
    get_pi_resources,
    __cmd__get_pi_resources,
    __tauri_command_name_get_pi_resources,
    save_pi_resource,
    __cmd__save_pi_resource,
    __tauri_command_name_save_pi_resource,
    toggle_pi_resource,
    __cmd__toggle_pi_resource,
    __tauri_command_name_toggle_pi_resource,
    delete_pi_resource,
    __cmd__delete_pi_resource,
    __tauri_command_name_delete_pi_resource,
    get_sdd_profiles,
    __cmd__get_sdd_profiles,
    __tauri_command_name_get_sdd_profiles,
    save_sdd_profile,
    __cmd__save_sdd_profile,
    __tauri_command_name_save_sdd_profile,
    delete_sdd_profile,
    __cmd__delete_sdd_profile,
    __tauri_command_name_delete_sdd_profile,
    set_active_sdd_profile,
    __cmd__set_active_sdd_profile,
    __tauri_command_name_set_active_sdd_profile,
    get_engram_project,
    __cmd__get_engram_project,
    __tauri_command_name_get_engram_project,
    get_engram_project_impl,
    parse_engram_project_from_stats,
    get_engram_cloud_status,
    __cmd__get_engram_cloud_status,
    __tauri_command_name_get_engram_cloud_status,
    get_engram_cloud_status_impl,
    parse_engram_cloud_status,
    enroll_engram_project,
    __cmd__enroll_engram_project,
    __tauri_command_name_enroll_engram_project,
    enroll_engram_project_impl,
    EngramCloudStatus,
    resolve_engram_bin,
    resolve_global_profiles_dir,
    resolve_project_profiles_dir,
    resolve_global_subagents_path,
    resolve_project_subagents_path,
    sanitize_profile_name,
    resolve_effective_pi_home,
    is_synthetic_agent_key,
    apply_profile_to_subagents_file,
    read_active_file,
    get_custom_providers_impl,
    get_mcp_servers_impl,
    get_model_thinking_levels_impl,
    get_pi_resources_impl,
    save_pi_resource_impl,
    toggle_pi_resource_impl,
    delete_pi_resource_impl,
    resolve_global_mcp_config_path,
    resolve_models_config_path,
    resolve_project_mcp_config_path,
    resolve_project_settings_config_path,
    resolve_settings_config_path,
    save_custom_providers_impl,
    upsert_custom_provider_impl,
    delete_custom_provider_impl,
    resolve_gentle_shell_custom_home_for_sync,
    resolve_gentle_shell_custom_home_for_sync_impl,
    propagate_provider_upsert_to_gentle_shell,
    save_model_thinking_levels_impl,
    save_mcp_server_impl,
    delete_mcp_server_impl,
    toggle_mcp_server_impl,
    validate_and_extract_providers,
    parse_pi_resources_from_file,
    atomic_write_json,
    validate_extension_source,
    validate_package_source,
    derive_resource_name,
    normalize_resource_id,
    GentleShellHomeMode,
    ResolvedGentleShellHomes,
    ConfigFileStatus,
    MigrationInspection,
    resolve_user_home,
    resolve_gentle_shell_homes_impl,
    resolve_gentle_shell_homes,
    should_skip_gentle_shell_migration,
    inspect_models_content_status,
    inspect_models_file_status,
    inspect_auth_content_status,
    inspect_auth_file_status,
    check_migration_eligibility,
    atomic_copy_config_file,
    execute_gentle_shell_migration,
    show_native_migration_dialog,
    prompt_migration_confirmation,
    run_gentle_shell_migration_preflight_for_homes,
    run_gentle_shell_migration_preflight,
    MigrationDialogFn
};

pub use sessions::{
    delete_session,
    __cmd__delete_session,
    __tauri_command_name_delete_session,
    get_session_persistence_status,
    __cmd__get_session_persistence_status,
    __tauri_command_name_get_session_persistence_status,
    list_sessions,
    __cmd__list_sessions,
    __tauri_command_name_list_sessions,
    rename_session,
    __cmd__rename_session,
    __tauri_command_name_rename_session,
    switch_session,
    __cmd__switch_session,
    __tauri_command_name_switch_session,
    append_session_info_entry,
    build_session_info_entry,
    generate_short_id,
    last_entry_id,
    list_sessions_from_dir,
    parse_session_file,
    resolve_sessions_dir,
    session_matches_active,
    system_time_to_rfc3339,
    validate_switch_session_path,
    DeleteSessionPayload,
    DeleteSessionResult,
    ListSessionsPayload,
    RenameSessionPayload,
    SessionPersistenceStatus,
    SessionSummary,
    SwitchSessionPayload,
    SwitchSessionResult
};

pub use workspace::{
    get_workspace_file_diff,
    __cmd__get_workspace_file_diff,
    __tauri_command_name_get_workspace_file_diff,
    get_workspace_git_status,
    __cmd__get_workspace_git_status,
    __tauri_command_name_get_workspace_git_status,
    list_workspace_dir,
    __cmd__list_workspace_dir,
    __tauri_command_name_list_workspace_dir,
    read_workspace_file,
    __cmd__read_workspace_file,
    __tauri_command_name_read_workspace_file,
    compute_relative_posix_path,
    resolve_canonical_workspace_root,
    validate_and_resolve_child_path,
    GetWorkspaceFileDiffPayload,
    GetWorkspaceGitStatusPayload,
    ListWorkspaceDirPayload,
    ReadWorkspaceFilePayload,
    WorkspaceEntry,
    WorkspaceFileContent,
    WorkspaceFileDiff,
    WorkspaceGitStatus,
    IGNORED_DIR_NAMES,
    MAX_WORKSPACE_FILE_READ_BYTES
};

pub use external::{
    open_external_url,
    __cmd__open_external_url,
    __tauri_command_name_open_external_url,
    pick_directory,
    __cmd__pick_directory,
    __tauri_command_name_pick_directory,
    coordinate_open_url,
    format_picked_directory,
    open_external_url_with_opener,
    pick_directory_with_dialog,
    validate_external_url,
    CLAIMED_COMPLETION_TIMEOUT,
    MAX_EXTERNAL_URL_LENGTH,
    OPENER_STATE_CANCELLED,
    OPENER_STATE_CLAIMED,
    OPENER_STATE_QUEUED,
    OPEN_URL_TIMEOUT
};

pub use discovery::{
    discover_environment,
    __cmd__discover_environment,
    __tauri_command_name_discover_environment,
    detect_gentle_shell,
    __cmd__detect_gentle_shell,
    __tauri_command_name_detect_gentle_shell,
    detect_gentle_shell_impl,
    validate_gentle_shell_candidate,
    discover_environment_impl,
    is_credible_pi_entrypoint,
    is_verified_project_dir,
    extract_js_from_shim,
    search_path_for_pi,
    discover_node_path,
    has_js_extension,
    DiscoverEnvironmentPayload,
    DiscoveredDirectory,
    DiscoveredEntrypoint,
    DiscoveredEnvironment,
    DiscoveryStatus,
    EnvironmentStatus,
    DetectGentleShellPayload,
    DetectGentleShellResult,
};

pub use oauth::{
    get_builtin_oauth_providers,
    __cmd__get_builtin_oauth_providers,
    __tauri_command_name_get_builtin_oauth_providers,
    start_oauth_login,
    __cmd__start_oauth_login,
    __tauri_command_name_start_oauth_login,
    cancel_oauth_login,
    __cmd__cancel_oauth_login,
    __tauri_command_name_cancel_oauth_login,
    send_oauth_prompt_response,
    __cmd__send_oauth_prompt_response,
    __tauri_command_name_send_oauth_prompt_response,
    logout_oauth_provider,
    __cmd__logout_oauth_provider,
    __tauri_command_name_logout_oauth_provider,
    get_builtin_oauth_providers_impl,
    logout_oauth_provider_impl,
    resolve_oauth_helper_path,
    resolve_oauth_execution_environment,
    validate_provider_id,
    validate_prompt_id,
    validate_prompt_response,
    validate_oauth_url,
    sanitize_oauth_text,
    ActiveOAuthSession,
    BuiltinOAuthProviderStatus,
    CancelOAuthLoginPayload,
    CancelOAuthLoginResult,
    GetBuiltinOAuthProvidersPayload,
    LogoutOAuthProviderPayload,
    LogoutOAuthProviderResult,
    SendOAuthPromptResponsePayload,
    SendOAuthPromptResponseResult,
    StartOAuthLoginPayload,
    StartOAuthLoginResult,
    FrameAction,
    KNOWN_BUILTIN_OAUTH_PROVIDERS,
    OAUTH_COMMAND_TIMEOUT,
    OAUTH_KILL_GRACE_PERIOD,
    OAUTH_LOGIN_TIMEOUT,
};
