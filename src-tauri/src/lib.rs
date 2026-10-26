mod background;
mod tray;
mod tray_activity;
pub mod commands;
pub mod framing;
pub mod process;
pub mod resource_activation;
pub mod terminal;

use std::sync::atomic::{AtomicBool, Ordering};

use commands::AppState;
use tauri::Manager;

static IS_EXITING: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();
    let session_for_exit = app_state.session.clone();
    let sessions_for_exit = app_state.sessions.clone();
    let oauth_for_exit = app_state.active_oauth_login.clone();
    let terminal_for_exit = app_state.terminal_manager.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            if let Err(error) = tray::setup(app) {
                // Keep ordinary window close/cleanup if no reopen affordance exists.
                eprintln!("System tray unavailable; close will exit Pi Viewer: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let action = background::close_action(
                    tray::available(window.app_handle()),
                    IS_EXITING.load(Ordering::SeqCst),
                );
                if action == background::CloseAction::Hide {
                    // Prevent destruction even if hiding fails: keep sessions and window alive.
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Unable to hide Pi Viewer: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::disconnect,
            commands::send_prompt,
            commands::send_extension_ui_response,
            commands::abort,
            commands::get_bridge_state,
            commands::get_messages,
            commands::new_session,
            commands::get_session_persistence_status,
            commands::open_external_url,
            commands::list_sessions,
            commands::switch_session,
            commands::delete_session,
            commands::rename_session,
            commands::list_workspace_dir,
            commands::create_workspace_dir,
            commands::delete_workspace_dir,
            commands::read_workspace_file,
            commands::kanban::get_project_kanban,
            commands::kanban::save_project_kanban,
            commands::get_workspace_git_status,
            commands::get_workspace_file_diff,
            commands::list_workspace_branches,
            commands::switch_workspace_branch,
            commands::create_workspace_branch,
            commands::delete_workspace_branch,
            commands::publish_workspace_branch,
            commands::list_workspace_branch_commits,
            commands::get_available_models,
            commands::set_model,
            commands::get_available_thinking_levels,
            commands::set_thinking_level,
            commands::get_session_stats,
            commands::get_custom_providers,
            commands::get_enabled_models,
            commands::save_enabled_models,
            commands::save_custom_providers,
            commands::upsert_custom_provider,
            commands::delete_custom_provider,
            commands::get_model_thinking_levels,
            commands::save_model_thinking_levels,
            commands::get_mcp_servers,
            commands::toggle_mcp_server,
            commands::save_mcp_server,
            commands::delete_mcp_server,
            commands::get_pi_resources,
            commands::save_pi_resource,
            commands::toggle_pi_resource,
            commands::delete_pi_resource,
            commands::set_resource_activation,
            commands::pick_directory,
            commands::browse_filesystem,
            commands::get_sdd_profiles,
            commands::save_sdd_profile,
            commands::delete_sdd_profile,
            commands::set_active_sdd_profile,
            commands::get_engram_project,
            commands::get_engram_cloud_status,
            commands::enroll_engram_project,
            commands::discover_environment,
            commands::detect_gentle_shell,
            commands::get_builtin_oauth_providers,
            commands::get_builtin_provider_catalog,
            commands::start_oauth_login,
            commands::cancel_oauth_login,
            commands::send_oauth_prompt_response,
            commands::logout_oauth_provider,
            commands::save_conversation_export,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::terminal_poll,
            commands::terminal_get,
            commands::terminal_list,
            commands::get_github_auth_status,
            commands::clone_github_repository,
            commands::create_github_repository,
            commands::list_github_repositories,
            commands::get_viewer_storage,
            commands::save_viewer_storage,
            commands::update_viewer_storage_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if !IS_EXITING.swap(true, Ordering::SeqCst) {
                // Prevent immediate exit to allow graceful asynchronous child cleanup
                api.prevent_exit();
                let session = session_for_exit.clone();
                let sessions = sessions_for_exit.clone();
                let oauth = oauth_for_exit.clone();
                let terminal = terminal_for_exit.clone();
                let app_handle_for_exit = app_handle.clone();
                let exit_code = code.unwrap_or(0);

                tauri::async_runtime::spawn(async move {
                    terminal.dispose().await;

                    let mut oauth_guard = oauth.lock().await;
                    if let Some(mut active) = oauth_guard.take() {
                        active.cancel_and_terminate().await;
                    }

                    let drained: Vec<process::ActiveSession> = {
                        let mut guard = sessions.lock().await;
                        guard.drain().map(|(_, s)| s).collect()
                    };
                    for active in drained {
                        active.terminate_and_reap().await;
                    }

                    let mut guard = session.lock().await;
                    if let Some(active) = guard.take() {
                        active.terminate_and_reap().await;
                    }
                    app_handle_for_exit.exit(exit_code);
                });
            }
        }
    });
}
