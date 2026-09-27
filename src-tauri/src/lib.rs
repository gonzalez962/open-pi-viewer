pub mod commands;
pub mod framing;
pub mod process;

use std::sync::atomic::{AtomicBool, Ordering};

use commands::AppState;

static IS_EXITING: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();
    let session_for_exit = app_state.session.clone();
    let sessions_for_exit = app_state.sessions.clone();
    let oauth_for_exit = app_state.active_oauth_login.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
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
            commands::read_workspace_file,
            commands::get_workspace_git_status,
            commands::get_workspace_file_diff,
            commands::get_available_models,
            commands::set_model,
            commands::get_available_thinking_levels,
            commands::set_thinking_level,
            commands::get_session_stats,
            commands::get_custom_providers,
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
            commands::pick_directory,
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
            commands::start_oauth_login,
            commands::cancel_oauth_login,
            commands::send_oauth_prompt_response,
            commands::logout_oauth_provider,
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
                let app_handle_for_exit = app_handle.clone();
                let exit_code = code.unwrap_or(0);

                tauri::async_runtime::spawn(async move {
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
