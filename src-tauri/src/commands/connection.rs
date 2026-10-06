//! Connection and prompt lifecycle commands for Pi RPC bridge.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::process::{
    next_request_id, validate_paths, validate_prompt_id, ActiveSession, ConnectPayload,
    StatusChangePayload,
};

use super::AppState;

/// Maximum prompt message size in characters: 512 KB
pub const MAX_PROMPT_CHARS: usize = 512 * 1024;
/// Acceptance timeout waiting for prompt command response
pub const PROMPT_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Abort command response timeout
pub const ABORT_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum length in characters for extension UI request ID
pub const MAX_EXTENSION_UI_ID_CHARS: usize = 128;
/// Maximum length in characters for extension UI response value (512 KB)
pub const MAX_EXTENSION_UI_VALUE_CHARS: usize = 512 * 1024;

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
pub struct PromptImageAttachment {
    #[serde(rename = "type")]
    pub attachment_type: String,
    pub data: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

/// Payload for sending prompt
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
pub struct SendPromptPayload {
    pub id: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<PromptImageAttachment>>,
    /// Pi RPC `prompt` command field. `"followUp"` queues this prompt to run after the
    /// current turn finishes instead of interrupting it; `"steer"` redirects the running
    /// turn. Omitted entirely for an ordinary idle send.
    #[serde(default, rename = "streamingBehavior", skip_serializing_if = "Option::is_none")]
    pub streaming_behavior: Option<String>,
}

/// Validate `streaming_behavior` against the Pi RPC `prompt` command's accepted values.
fn validate_streaming_behavior(streaming_behavior: &Option<String>) -> Result<(), String> {
    match streaming_behavior.as_deref() {
        None | Some("steer") | Some("followUp") => Ok(()),
        Some(other) => Err(format!(
            "Invalid streamingBehavior '{}': must be 'steer' or 'followUp'",
            other
        )),
    }
}

/// Pure builder for the Pi RPC `prompt` command JSON, extracted so it can be unit tested
/// without a live Tauri `State`/`AppHandle`. Takes individual fields (rather than
/// `&SendPromptPayload`) so callers may partial-move `payload.message` into
/// `effective_msg` before building the command.
fn build_prompt_command(
    id: &str,
    images: &Option<Vec<PromptImageAttachment>>,
    streaming_behavior: &Option<String>,
    effective_msg: &str,
) -> Value {
    let mut prompt_cmd = serde_json::json!({
        "id": id,
        "type": "prompt",
        "message": effective_msg,
    });
    if let Some(ref imgs) = images {
        if !imgs.is_empty() {
            prompt_cmd["images"] =
                serde_json::to_value(imgs).unwrap_or(serde_json::Value::Array(vec![]));
        }
    }
    if let Some(ref sb) = streaming_behavior {
        prompt_cmd["streamingBehavior"] = serde_json::Value::String(sb.clone());
    }
    prompt_cmd
}


/// Result returned from prompt submission
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SendPromptResult {
    pub id: String,
    pub accepted: bool,
}

/// Payload received from frontend to respond to an extension UI dialog request
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUiResponsePayload {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Result returned from extension UI response submission
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendExtensionUiResponseResult {
    pub id: String,
    pub success: bool,
}


/// Result returned from new_session command
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResult {
    pub cancelled: bool,
    pub partial_reset: bool,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub error: Option<String>,
}


/// Payload received from frontend to disconnect from Pi RPC bridge
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectPayload {
    pub working_directory: Option<String>,
}

/// Establish connection to Pi RPC subprocess.
///
/// Ensures generation/lifecycle gating: any existing session or in-flight handshake
/// is cancelled, and only the latest generation publishes status and stores its session.
#[tauri::command]
pub async fn connect(
    payload: ConnectPayload,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Value, String> {
    // 1. Validate paths and executable
    let (node_path, entrypoint, cwd) =
        validate_paths(&payload.node_path, &payload.pi_entrypoint, &payload.working_directory)?;

    // Check if state.sessions already has an active session for cwd that is_alive()
    let existing_session = {
        let mut sessions = state.sessions.lock().await;
        if let Some(existing) = sessions.get(&cwd) {
            if existing.is_alive() {
                Some(existing.clone())
            } else {
                sessions.remove(&cwd);
                None
            }
        } else {
            None
        }
    };

    if let Some(existing) = existing_session {
        *state.active_cwd.lock().await = Some(cwd.clone());
        *state.session.lock().await = Some(existing.clone());

        let (model_info, session_id, session_file, messages) =
            existing.fetch_state_and_messages().await.unwrap_or_else(|_| {
                (serde_json::json!({}), None, None, Vec::new())
            });

        let total_count = messages.len() as u64;
        let (initial_messages, has_more) = crate::commands::sessions::window_messages(
            messages,
            payload.load_all,
            None,
            80,
        );

        return Ok(serde_json::json!({
            "connected": true,
            "model": model_info,
            "sessionId": session_id,
            "sessionFile": session_file,
            "messageCount": total_count,
            "canonicalCwd": cwd.to_string_lossy(),
            "messages": initial_messages,
            "hasMore": has_more,
        }));
    }

    // Validate optional session file reference
    let session_file_path: Option<PathBuf> = if let Some(ref sf) = payload.session_file {
        let trimmed = sf.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            // If historical session requires file existence, verify before spawning Node
            if payload.require_session_file_exists.unwrap_or(false) && !p.exists() {
                return Err(format!(
                    "Saved session file not found: '{}'. File may have been moved or deleted.",
                    p.display()
                ));
            }
            Some(p)
        } else {
            None
        }
    } else {
        None
    };

    // If entrypoint is Gentle Shell, run isolated-home migration preflight before spawning child
    if crate::process::is_gentle_shell_entrypoint(&entrypoint) {
        if let Err(e) = super::config_files::run_gentle_shell_migration_preflight(&state, Some(&cwd), None).await {
            return Err(format!("Gentle Shell home migration failed: {e}"));
        }
    }

    // 2. Allocate next generation, cancel in-flight handshake
    // When spawning ActiveSession::start, DO NOT disconnect sessions for other working directories!
    let (gen, cancel_rx) = {
        let mut cancel_guard = state.handshake_cancel_tx.lock().await;
        if let Some((_old_gen, old_cancel)) = cancel_guard.take() {
            let _ = old_cancel.send(());
        }

        let new_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        // Register cancellation token only if slot is empty or owned by an older generation
        let should_register = cancel_guard
            .as_ref()
            .map_or(true, |(owner_gen, _)| *owner_gen < new_gen);
        if should_register {
            *cancel_guard = Some((new_gen, tx));
        }
        (new_gen, rx)
    };

    // 3. Notify frontend of connecting state for this generation
    let _ = app_handle.emit(
        "pi://status-change",
        StatusChangePayload {
            state: "connecting".to_string(),
            label: "Connecting".to_string(),
            detail: format!("Spawning Node at {}", entrypoint.display()),
            model: None,
            cwd: Some(cwd.to_string_lossy().into_owned()),
        },
    );

    // 4. Start child process, wire framing, and perform handshake with cancellation support
    let start_res = ActiveSession::start(
        app_handle.clone(),
        &node_path,
        &entrypoint,
        &cwd,
        session_file_path.as_deref(),
        gen,
        state.generation.clone(),
        cancel_rx,
    )
    .await;

    // Clear cancellation sender only if it is still owned by our generation
    {
        let mut cancel_guard = state.handshake_cancel_tx.lock().await;
        if cancel_guard
            .as_ref()
            .map_or(false, |(owner_gen, _)| *owner_gen == gen)
        {
            *cancel_guard = None;
        }
    }

    let (session, model_info, session_id, session_file, message_count, messages) = match start_res {
        Ok(res) => res,
        Err(e) => {
            // If superseded by a newer connect/disconnect, do not emit error status
            if state.generation.load(Ordering::SeqCst) == gen {
                let _ = app_handle.emit(
                    "pi://status-change",
                    StatusChangePayload {
                        state: "error".to_string(),
                        label: "Connection Failed".to_string(),
                        detail: format!("Failed to connect: {e}"),
                        model: None,
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                    },
                );
            }
            return Err(e);
        }
    };

    // 5. Store active session only if this generation is still current
    {
        if state.generation.load(Ordering::SeqCst) == gen {
            state.sessions.lock().await.insert(cwd.clone(), session.clone());
            *state.session.lock().await = Some(session.clone());
            *state.active_cwd.lock().await = Some(cwd.clone());
        } else {
            // A newer connect or disconnect occurred while handshake was completing
            let stale = session;
            stale.disconnect().await;
            return Err("Connection superseded by a newer operation".to_string());
        }
    }

    let total_count = message_count;
    let (initial_messages, has_more) = crate::commands::sessions::window_messages(
        messages,
        payload.load_all,
        None,
        80,
    );

    Ok(serde_json::json!({
        "connected": true,
        "model": model_info,
        "sessionId": session_id,
        "sessionFile": session_file,
        "messageCount": total_count,
        "canonicalCwd": cwd.to_string_lossy(),
        "messages": initial_messages,
        "hasMore": has_more,
    }))
}

/// Explicitly disconnect from the Pi RPC subprocess.
///
/// If payload specifies a working directory, only disconnects that directory's session.
/// If no directory specified, disconnects the active session.
/// If no active session, disconnects all sessions.
#[tauri::command]
pub async fn disconnect(
    payload: Option<DisconnectPayload>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    // Invalidate generation and cancel any in-flight handshake under cancellation lock
    {
        let mut cancel_guard = state.handshake_cancel_tx.lock().await;
        state.generation.fetch_add(1, Ordering::SeqCst);
        if let Some((_owner_gen, cancel_tx)) = cancel_guard.take() {
            let _ = cancel_tx.send(());
        }
    }

    let target_cwd = payload
        .as_ref()
        .and_then(|p| p.working_directory.as_deref())
        .map(|s| dunce::canonicalize(s).unwrap_or_else(|_| PathBuf::from(s)));

    if let Some(cwd) = target_cwd {
        let removed = state.sessions.lock().await.remove(&cwd);
        if let Some(session) = removed {
            session.disconnect().await;
        }

        let mut active_cwd_guard = state.active_cwd.lock().await;
        if active_cwd_guard.as_ref() == Some(&cwd) {
            *active_cwd_guard = None;
            let mut session_guard = state.session.lock().await;
            *session_guard = None;
        }

        let _ = app_handle.emit(
            "pi://status-change",
            StatusChangePayload {
                state: "disconnected".to_string(),
                label: "Disconnected".to_string(),
                detail: "Disconnected by user".to_string(),
                model: None,
                cwd: Some(cwd.to_string_lossy().into_owned()),
            },
        );
    } else {
        let active_cwd = state.active_cwd.lock().await.take();
        if let Some(cwd) = active_cwd {
            let removed = state.sessions.lock().await.remove(&cwd);
            if let Some(session) = removed {
                session.disconnect().await;
            }
            let mut session_guard = state.session.lock().await;
            if let Some(session) = session_guard.take() {
                session.disconnect().await;
            }

            let _ = app_handle.emit(
                "pi://status-change",
                StatusChangePayload {
                    state: "disconnected".to_string(),
                    label: "Disconnected".to_string(),
                    detail: "Disconnected by user".to_string(),
                    model: None,
                    cwd: Some(cwd.to_string_lossy().into_owned()),
                },
            );
        } else {
            let drained: Vec<(PathBuf, ActiveSession)> = {
                let mut sessions = state.sessions.lock().await;
                sessions.drain().collect()
            };

            for (cwd, session) in drained {
                session.disconnect().await;
                let _ = app_handle.emit(
                    "pi://status-change",
                    StatusChangePayload {
                        state: "disconnected".to_string(),
                        label: "Disconnected".to_string(),
                        detail: "Disconnected by user".to_string(),
                        model: None,
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                    },
                );
            }

            let mut session_guard = state.session.lock().await;
            if let Some(session) = session_guard.take() {
                let cwd = session.cwd.clone();
                session.disconnect().await;
                let _ = app_handle.emit(
                    "pi://status-change",
                    StatusChangePayload {
                        state: "disconnected".to_string(),
                        label: "Disconnected".to_string(),
                        detail: "Disconnected by user".to_string(),
                        model: None,
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                    },
                );
            } else {
                let _ = app_handle.emit(
                    "pi://status-change",
                    StatusChangePayload {
                        state: "disconnected".to_string(),
                        label: "Disconnected".to_string(),
                        detail: "Disconnected by user".to_string(),
                        model: None,
                        cwd: None,
                    },
                );
            }
        }
    }

    Ok(())
}

/// Send a prompt message to Pi.
///
/// Bounded to MAX_PROMPT_CHARS. Awaits prompt command acceptance response.
/// On timeout or send failure, removes pending map entry to prevent memory leaks
/// and ambiguous accepted prompt states.


#[tauri::command]
pub async fn send_prompt(
    payload: SendPromptPayload,
    state: State<'_, AppState>,
) -> Result<SendPromptResult, String> {
    // 1. Validate prompt request ID: bounded, non-empty, and in accepted client namespace
    validate_prompt_id(&payload.id)?;
    validate_streaming_behavior(&payload.streaming_behavior)?;

    // 2. Validate message content bounds
    let trimmed = payload.message.trim();
    let has_images = payload.images.as_ref().map(|i| !i.is_empty()).unwrap_or(false);
    if trimmed.is_empty() && !has_images {
        return Err("Prompt message cannot be empty".to_string());
    }
    if payload.message.len() > MAX_PROMPT_CHARS {
        return Err(format!(
            "Prompt exceeds maximum character limit of {} characters",
            MAX_PROMPT_CHARS
        ));
    }

    // 3. Retrieve session via state.get_session(), check is_alive(), acquire channel references
    let session = state.get_session().await?;
    if !session.is_alive() {
        return Err("Pi RPC bridge is not connected".to_string());
    }
    let stdin_tx = session.stdin_tx.clone();
    let pending_responses = Arc::clone(&session.pending_responses);

    let (tx, rx) = oneshot::channel();

    // 4. Reject duplicate pending IDs without overwriting active sender
    {
        let mut pend = pending_responses.lock().await;
        if pend.contains_key(&payload.id) {
            return Err(format!(
                "Duplicate prompt request ID '{}' already has an active pending request",
                payload.id
            ));
        }
        pend.insert(payload.id.clone(), tx);
    }

    let effective_msg = if trimmed.is_empty() && has_images {
        "(see attached image)".to_string()
    } else {
        payload.message
    };

    let prompt_cmd = build_prompt_command(
        &payload.id,
        &payload.images,
        &payload.streaming_behavior,
        &effective_msg,
    );

    if let Err(_) = stdin_tx.send(prompt_cmd.to_string()).await {
        let mut pend = pending_responses.lock().await;
        pend.remove(&payload.id);
        return Err("Failed to send prompt: child process stdin closed".to_string());
    }

    // 5. Wait for prompt command acceptance response
    let response_result = tokio::time::timeout(PROMPT_ACCEPT_TIMEOUT, rx).await;
    let response_value = match response_result {
        Ok(Ok(val)) => val,
        Ok(Err(_)) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&payload.id);
            return Err("Prompt response channel closed before acceptance".to_string());
        }
        Err(_) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&payload.id);
            return Err("Timeout waiting for prompt acceptance response from Pi (30s)".to_string());
        }
    };

    let is_success = response_value
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !is_success {
        let err_msg = response_value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Prompt was rejected by agent");
        return Err(format!("Prompt rejected: {err_msg}"));
    }

    // 6. Echo authoritative client request ID in result
    Ok(SendPromptResult {
        id: payload.id,
        accepted: true,
    })
}

/// Validate extension UI response payload and build the exact JSON line for Pi RPC.
///
/// Ensures request ID is bounded and non-empty, validates method-specific response
/// constraints, and rejects invalid combinations to prevent arbitrary generic RPC writes.
pub fn validate_extension_ui_response(
    payload: &ExtensionUiResponsePayload,
) -> Result<serde_json::Value, String> {
    let id = payload.id.trim();
    if id.is_empty() {
        return Err("Extension UI request ID cannot be empty".to_string());
    }
    if payload.id != id {
        return Err("Extension UI request ID cannot contain leading or trailing whitespace".to_string());
    }
    if id.len() > MAX_EXTENSION_UI_ID_CHARS {
        return Err(format!(
            "Extension UI request ID exceeds maximum limit of {MAX_EXTENSION_UI_ID_CHARS} characters"
        ));
    }
    if id.contains('\n') || id.contains('\r') {
        return Err("Extension UI request ID cannot contain newline characters".to_string());
    }

    if let Some(ref cwd) = payload.cwd {
        let trimmed_cwd = cwd.trim();
        if trimmed_cwd.is_empty() {
            return Err("Extension UI response working directory cannot be empty".to_string());
        }
        if cwd.contains('\n') || cwd.contains('\r') {
            return Err("Extension UI response working directory cannot contain newline characters".to_string());
        }
    }

    // If method is provided, validate it is one of the supported dialog methods
    if let Some(ref m) = payload.method {
        let m_lower = m.trim().to_ascii_lowercase();
        if !matches!(m_lower.as_str(), "select" | "input" | "confirm") {
            return Err(format!("Unsupported extension UI dialog method: '{m}'"));
        }
    }

    // Cancellation: valid for all dialog methods
    if payload.cancelled == Some(true) {
        if payload.confirmed.is_some() {
            return Err("Cancelled extension UI response cannot specify 'confirmed'".to_string());
        }
        if payload.value.is_some() {
            return Err("Cancelled extension UI response cannot specify 'value'".to_string());
        }
        return Ok(serde_json::json!({
            "type": "extension_ui_response",
            "id": id,
            "cancelled": true,
        }));
    }

    // Disallow contradictory combinations
    if payload.confirmed.is_some() && payload.value.is_some() {
        return Err("Extension UI response cannot specify both 'confirmed' and 'value'".to_string());
    }

    let method_opt = payload.method.as_deref().map(|m| m.trim().to_ascii_lowercase());

    // Confirmed branch (for 'confirm' method)
    if let Some(confirmed) = payload.confirmed {
        if let Some(ref m) = method_opt {
            if m != "confirm" {
                return Err(format!("Method '{m}' does not accept 'confirmed' response"));
            }
        }
        return Ok(serde_json::json!({
            "type": "extension_ui_response",
            "id": id,
            "confirmed": confirmed,
        }));
    }

    // Value branch (for 'select' or 'input' method)
    if let Some(ref val) = payload.value {
        if val.len() > MAX_EXTENSION_UI_VALUE_CHARS {
            return Err(format!(
                "Extension UI response value exceeds maximum limit of {MAX_EXTENSION_UI_VALUE_CHARS} characters"
            ));
        }
        if let Some(ref m) = method_opt {
            if m != "select" && m != "input" {
                return Err(format!("Method '{m}' does not accept 'value' response"));
            }
        }
        return Ok(serde_json::json!({
            "type": "extension_ui_response",
            "id": id,
            "value": val,
        }));
    }

    Err("Extension UI response must specify either 'cancelled: true', 'confirmed', or 'value'".to_string())
}

/// Send an extension UI dialog response to the active Pi RPC session.
///
/// Bounded command that validates request ID and method-specific response shape.
/// When explicit cwd is provided, routes to the exact live session for that working directory
/// without falling back to the active session. Never permits arbitrary generic RPC writes.
#[tauri::command]
pub async fn send_extension_ui_response(
    payload: ExtensionUiResponsePayload,
    state: State<'_, AppState>,
) -> Result<SendExtensionUiResponseResult, String> {
    let rpc_line = validate_extension_ui_response(&payload)?;

    let session = if let Some(ref raw_cwd) = payload.cwd {
        let trimmed = raw_cwd.trim();
        if trimmed.is_empty() {
            return Err("Working directory cannot be empty".to_string());
        }
        let canonical = dunce::canonicalize(trimmed).unwrap_or_else(|_| PathBuf::from(trimmed));
        let sessions = state.sessions.lock().await;
        let session = sessions
            .get(&canonical)
            .cloned()
            .ok_or_else(|| format!("No active session found for working directory: {trimmed}"))?;
        if !session.is_alive() {
            return Err(format!("Pi RPC session for '{trimmed}' is not active"));
        }
        session
    } else {
        let session = state.get_session().await?;
        if !session.is_alive() {
            return Err("Pi RPC session is not active".to_string());
        }
        session
    };

    let id = payload.id.trim().to_string();
    session
        .stdin_tx
        .send(rpc_line.to_string())
        .await
        .map_err(|e| format!("Failed to send extension UI response to active session: {e}"))?;

    Ok(SendExtensionUiResponseResult {
        id,
        success: true,
    })
}

/// Abort current agent operation


#[tauri::command]
pub async fn abort(state: State<'_, AppState>) -> Result<(), String> {
    let session = state.get_session().await?;
    if !session.is_alive() {
        return Err("Pi RPC bridge is not connected".to_string());
    }
    let stdin_tx = session.stdin_tx.clone();
    let pending_responses = Arc::clone(&session.pending_responses);

    let req_id = next_request_id("abort");
    let (tx, rx) = oneshot::channel();

    {
        let mut pend = pending_responses.lock().await;
        pend.insert(req_id.clone(), tx);
    }

    let abort_cmd = serde_json::json!({
        "id": req_id,
        "type": "abort",
    });

    if let Err(_) = stdin_tx.send(abort_cmd.to_string()).await {
        let mut pend = pending_responses.lock().await;
        pend.remove(&req_id);
        return Err("Failed to send abort command: child stdin closed".to_string());
    }

    let res = tokio::time::timeout(ABORT_TIMEOUT, rx).await;
    if res.is_err() {
        let mut pend = pending_responses.lock().await;
        pend.remove(&req_id);
    }
    Ok(())
}

/// Check current bridge status


#[tauri::command]
pub async fn get_bridge_state(state: State<'_, AppState>) -> Result<Value, String> {
    let gen = state.generation.load(Ordering::SeqCst);
    if let Ok(session) = state.get_session().await {
        if session.is_alive() {
            return Ok(serde_json::json!({
                "connected": true,
                "childPid": session.child_pid,
                "generation": session.generation,
            }));
        }
    }
    Ok(serde_json::json!({
        "connected": false,
        "childPid": null,
        "generation": gen,
    }))
}

/// Fetch messages from active Pi RPC session


#[tauri::command]
pub async fn get_messages(state: State<'_, AppState>) -> Result<Value, String> {
    let session = state.get_session().await?;
    if !session.is_alive() {
        return Err("Pi RPC bridge is not connected".to_string());
    }
    let stdin_tx = session.stdin_tx.clone();
    let pending_responses = Arc::clone(&session.pending_responses);

    let req_id = next_request_id("get-messages");
    let (tx, rx) = oneshot::channel();

    {
        let mut pend = pending_responses.lock().await;
        pend.insert(req_id.clone(), tx);
    }

    let cmd = serde_json::json!({
        "id": req_id,
        "type": "get_messages",
    });

    if let Err(_) = stdin_tx.send(cmd.to_string()).await {
        let mut pend = pending_responses.lock().await;
        pend.remove(&req_id);
        return Err("Failed to send get_messages: child process stdin closed".to_string());
    }

    let response_result = tokio::time::timeout(Duration::from_secs(15), rx).await;
    let response_value = match response_result {
        Ok(Ok(val)) => val,
        Ok(Err(_)) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&req_id);
            return Err("get_messages response channel closed unexpectedly".to_string());
        }
        Err(_) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&req_id);
            return Err("Timeout waiting for get_messages response from Pi (15s)".to_string());
        }
    };

    let is_success = response_value
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !is_success {
        let err_msg = response_value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Failed to get messages from agent");
        return Err(format!("get_messages failed: {err_msg}"));
    }

    let msgs = response_value
        .get("data")
        .and_then(|d| d.get("messages"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));

    Ok(msgs)
}



/// Reset active Pi session to a new conversation atomically
#[tauri::command]
pub async fn new_session(state: State<'_, AppState>) -> Result<NewSessionResult, String> {
    let session = state.get_session().await?;
    if !session.is_alive() {
        return Err("Pi RPC bridge is not connected".to_string());
    }
    let stdin_tx = session.stdin_tx.clone();
    let pending_responses = Arc::clone(&session.pending_responses);

    // Step 1: Send new_session command
    let req_id = next_request_id("new-session");
    let (tx, rx) = oneshot::channel();

    {
        let mut pend = pending_responses.lock().await;
        pend.insert(req_id.clone(), tx);
    }

    let cmd = serde_json::json!({
        "id": req_id,
        "type": "new_session",
    });

    if let Err(_) = stdin_tx.send(cmd.to_string()).await {
        let mut pend = pending_responses.lock().await;
        pend.remove(&req_id);
        return Err("Failed to send new_session: child process stdin closed".to_string());
    }

    let response_result = tokio::time::timeout(Duration::from_secs(15), rx).await;
    let response_value = match response_result {
        Ok(Ok(val)) => val,
        Ok(Err(_)) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&req_id);
            return Err("new_session response channel closed unexpectedly".to_string());
        }
        Err(_) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&req_id);
            return Err("Timeout waiting for new_session response from Pi (15s)".to_string());
        }
    };

    let is_success = response_value
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !is_success {
        let err_msg = response_value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Failed to start new session");
        return Err(format!("new_session rejected: {err_msg}"));
    }

    let cancelled = response_value
        .get("data")
        .and_then(|d| d.get("cancelled"))
        .and_then(|c| c.as_bool())
        .unwrap_or(false);

    if cancelled {
        return Ok(NewSessionResult {
            cancelled: true,
            partial_reset: false,
            session_id: None,
            session_file: None,
            error: None,
        });
    }

    // Step 2: Fetch new session identity via get_state.
    // If this step fails, Pi has mutated but state reconciliation is incomplete.
    // Return partial_reset: true so frontend fails closed and blocks prompt sending.
    let state_id = next_request_id("get-state");
    let (state_tx, state_rx) = oneshot::channel();

    {
        let mut pend = pending_responses.lock().await;
        pend.insert(state_id.clone(), state_tx);
    }

    let state_cmd = serde_json::json!({
        "id": state_id,
        "type": "get_state",
    });

    if let Err(e) = stdin_tx.send(state_cmd.to_string()).await {
        let mut pend = pending_responses.lock().await;
        pend.remove(&state_id);
        return Ok(NewSessionResult {
            cancelled: false,
            partial_reset: true,
            session_id: None,
            session_file: None,
            error: Some(format!("Failed to send get_state after new_session: child stdin closed ({e})")),
        });
    }

    let state_res = tokio::time::timeout(Duration::from_secs(15), state_rx).await;
    let state_val = match state_res {
        Ok(Ok(val)) => val,
        Ok(Err(_)) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&state_id);
            return Ok(NewSessionResult {
                cancelled: false,
                partial_reset: true,
                session_id: None,
                session_file: None,
                error: Some("get_state response channel closed after new_session".to_string()),
            });
        }
        Err(_) => {
            let mut pend = pending_responses.lock().await;
            pend.remove(&state_id);
            return Ok(NewSessionResult {
                cancelled: false,
                partial_reset: true,
                session_id: None,
                session_file: None,
                error: Some("Timeout waiting for get_state after new_session (15s)".to_string()),
            });
        }
    };

    let state_success = state_val
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !state_success {
        let err_msg = state_val
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("get_state returned success: false");
        return Ok(NewSessionResult {
            cancelled: false,
            partial_reset: true,
            session_id: None,
            session_file: None,
            error: Some(format!("get_state failed after new_session: {err_msg}")),
        });
    }

    let session_id = state_val
        .get("data")
        .and_then(|d| d.get("sessionId"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    let session_file = state_val
        .get("data")
        .and_then(|d| d.get("sessionFile"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    if session_id.is_none() || session_file.is_none() {
        return Ok(NewSessionResult {
            cancelled: false,
            partial_reset: true,
            session_id: None,
            session_file: None,
            error: Some("get_state after new_session returned missing sessionId or sessionFile".to_string()),
        });
    }

    // Update active session identity
    {
        let mut cur_id = session.current_session_id.lock().await;
        *cur_id = session_id.clone();
        let mut cur_file = session.current_session_file.lock().await;
        *cur_file = session_file.clone();
    }

    Ok(NewSessionResult {
        cancelled: false,
        partial_reset: false,
        session_id,
        session_file,
        error: None,
    })
}



#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn test_cancellation_slot_owner_generation_clearing() {
        let state = AppState::new();

        // 1. Generation 1 registers cancellation sender
        let (tx1, rx1) = oneshot::channel();
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            *cancel_guard = Some((1, tx1));
        }

        // 2. Generation 2 cancels generation 1 and registers its own sender
        let (tx2, rx2) = oneshot::channel();
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            if let Some((_owner_gen, old_tx)) = cancel_guard.take() {
                let _ = old_tx.send(());
            }
            *cancel_guard = Some((2, tx2));
        }

        // Verify generation 1 received cancellation signal
        assert_eq!(rx1.await, Ok(()));

        // 3. Generation 1 finishes start and attempts to clear cancellation slot
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            if cancel_guard
                .as_ref()
                .map_or(false, |(owner_gen, _)| *owner_gen == 1)
            {
                *cancel_guard = None;
            }
        }

        // Verify generation 2's token was NOT cleared by generation 1
        {
            let cancel_guard = state.handshake_cancel_tx.lock().await;
            assert!(cancel_guard.is_some());
            assert_eq!(cancel_guard.as_ref().unwrap().0, 2);
        }

        // 4. Generation 2 clears its own token
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            if cancel_guard
                .as_ref()
                .map_or(false, |(owner_gen, _)| *owner_gen == 2)
            {
                *cancel_guard = None;
            }
        }

        // Verify slot is now None and rx2 was dropped without signal
        {
            let cancel_guard = state.handshake_cancel_tx.lock().await;
            assert!(cancel_guard.is_none());
        }
        assert!(rx2.await.is_err());
    }

    #[tokio::test]
    async fn test_cancellation_slot_disconnect_cancels_and_clears() {
        let state = AppState::new();

        let (tx, rx) = oneshot::channel();
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            *cancel_guard = Some((1, tx));
        }

        // Disconnect advances generation, takes slot, and signals cancellation
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            state.generation.fetch_add(1, Ordering::SeqCst);
            if let Some((_owner_gen, cancel_tx)) = cancel_guard.take() {
                let _ = cancel_tx.send(());
            }
        }

        assert_eq!(rx.await, Ok(()));

        // Attempting to clear old generation 1 leaves slot None
        {
            let mut cancel_guard = state.handshake_cancel_tx.lock().await;
            if cancel_guard
                .as_ref()
                .map_or(false, |(owner_gen, _)| *owner_gen == 1)
            {
                *cancel_guard = None;
            }
        }
        let cancel_guard = state.handshake_cancel_tx.lock().await;
        assert!(cancel_guard.is_none());
    }

    #[tokio::test]
    async fn test_duplicate_pending_id_rejected_without_overwriting_sender() {
        use std::collections::HashMap;

        let pending_map: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (tx1, rx1) = oneshot::channel();
        let prompt_id = "prompt-unique-uuid-1234".to_string();

        // 1. Register initial pending request
        {
            let mut pend = pending_map.lock().await;
            pend.insert(prompt_id.clone(), tx1);
        }

        // 2. Attempt to register duplicate with new sender
        let (tx2, rx2) = oneshot::channel();
        let insert_res: Result<(), String> = {
            let mut pend = pending_map.lock().await;
            if pend.contains_key(&prompt_id) {
                Err(format!(
                    "Duplicate prompt request ID '{prompt_id}' already has an active pending request"
                ))
            } else {
                pend.insert(prompt_id.clone(), tx2);
                Ok(())
            }
        };

        assert!(insert_res.is_err());
        assert!(insert_res
            .unwrap_err()
            .contains("Duplicate prompt request ID"));

        // 3. Verify original sender tx1 was NOT overwritten and receives response
        {
            let mut pend = pending_map.lock().await;
            let sender = pend.remove(&prompt_id);
            assert!(sender.is_some());
            let _ = sender.unwrap().send(serde_json::json!({
                "type": "response",
                "id": prompt_id,
                "success": true
            }));
        }

        let resp = rx1.await.expect("Original sender was dropped or overwritten!");
        assert_eq!(resp.get("success").and_then(|v| v.as_bool()), Some(true));

        // tx2 was not inserted; rx2 should be dropped without signal
        drop(rx2);
    }

    #[test]
    fn test_send_prompt_payload_and_result_contracts() {
        let payload = SendPromptPayload {
            id: "prompt-123e4567-e89b-12d3-a456-426614174000".to_string(),
            message: "Hello Pi".to_string(),
            images: None,
            streaming_behavior: None,
        };
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(serialized.contains("\"id\":\"prompt-123e4567-e89b-12d3-a456-426614174000\""));
        assert!(serialized.contains("\"message\":\"Hello Pi\""));
        assert!(!serialized.contains("\"images\""));

        let deserialized: SendPromptPayload = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.id, payload.id);
        assert_eq!(deserialized.message, payload.message);
        assert_eq!(deserialized.images, None);

        let payload_with_images = SendPromptPayload {
            id: "prompt-123e4567-e89b-12d3-a456-426614174001".to_string(),
            message: "".to_string(),
            images: Some(vec![PromptImageAttachment {
                attachment_type: "image".to_string(),
                data: "base64data".to_string(),
                mime_type: "image/png".to_string(),
            }]),
            streaming_behavior: None,
        };
        let serialized_img = serde_json::to_string(&payload_with_images).unwrap();
        assert!(serialized_img.contains("\"type\":\"image\""));
        assert!(serialized_img.contains("\"mimeType\":\"image/png\""));
        assert!(serialized_img.contains("\"data\":\"base64data\""));

        let deserialized_img: SendPromptPayload = serde_json::from_str(&serialized_img).unwrap();
        assert_eq!(deserialized_img.images, payload_with_images.images);

        let result = SendPromptResult {
            id: payload.id.clone(),
            accepted: true,
        };
        let res_json = serde_json::to_string(&result).unwrap();
        assert!(res_json.contains("\"id\":\"prompt-123e4567-e89b-12d3-a456-426614174000\""));
        assert!(res_json.contains("\"accepted\":true"));
    }

    #[test]
    fn test_send_prompt_payload_streaming_behavior_serde() {
        // Omitted entirely on an ordinary idle send
        let payload = SendPromptPayload {
            id: "prompt-1".to_string(),
            message: "Hi".to_string(),
            images: None,
            streaming_behavior: None,
        };
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(!serialized.contains("streamingBehavior"));

        // Present under the `streamingBehavior` wire name when queuing a follow-up
        let queued_payload = SendPromptPayload {
            id: "prompt-2".to_string(),
            message: "Follow up".to_string(),
            images: None,
            streaming_behavior: Some("followUp".to_string()),
        };
        let serialized_queued = serde_json::to_string(&queued_payload).unwrap();
        assert!(serialized_queued.contains("\"streamingBehavior\":\"followUp\""));

        let deserialized: SendPromptPayload = serde_json::from_str(
            r#"{"id":"prompt-3","message":"Hi","streamingBehavior":"steer"}"#,
        )
        .unwrap();
        assert_eq!(deserialized.streaming_behavior, Some("steer".to_string()));
    }

    #[test]
    fn test_validate_streaming_behavior_accepts_known_values_and_none() {
        assert!(validate_streaming_behavior(&None).is_ok());
        assert!(validate_streaming_behavior(&Some("steer".to_string())).is_ok());
        assert!(validate_streaming_behavior(&Some("followUp".to_string())).is_ok());
    }

    #[test]
    fn test_validate_streaming_behavior_rejects_unknown_values() {
        let err = validate_streaming_behavior(&Some("interrupt".to_string()))
            .expect_err("unknown streamingBehavior must be rejected");
        assert!(err.contains("interrupt"));
        assert!(err.contains("steer"));
        assert!(err.contains("followUp"));
    }

    #[test]
    fn test_build_prompt_command_omits_streaming_behavior_when_absent() {
        let cmd = build_prompt_command("prompt-1", &None, &None, "Hello");
        assert_eq!(cmd.get("id").and_then(|v| v.as_str()), Some("prompt-1"));
        assert_eq!(cmd.get("type").and_then(|v| v.as_str()), Some("prompt"));
        assert_eq!(cmd.get("message").and_then(|v| v.as_str()), Some("Hello"));
        assert!(cmd.get("streamingBehavior").is_none());
        assert!(cmd.get("images").is_none());
    }

    #[test]
    fn test_build_prompt_command_forwards_streaming_behavior_and_images() {
        let images = Some(vec![PromptImageAttachment {
            attachment_type: "image".to_string(),
            data: "base64data".to_string(),
            mime_type: "image/png".to_string(),
        }]);
        let streaming_behavior = Some("followUp".to_string());
        let cmd = build_prompt_command("prompt-2", &images, &streaming_behavior, "Follow up");
        assert_eq!(
            cmd.get("streamingBehavior").and_then(|v| v.as_str()),
            Some("followUp")
        );
        assert!(cmd.get("images").is_some());
        assert_eq!(
            cmd["images"][0].get("mimeType").and_then(|v| v.as_str()),
            Some("image/png")
        );
    }

    #[test]
    fn test_new_session_result_contract() {
        let res_active = NewSessionResult {
            cancelled: false,
            partial_reset: false,
            session_id: Some("session-abc".to_string()),
            session_file: Some("/path/to/session.jsonl".to_string()),
            error: None,
        };
        let json_active = serde_json::to_string(&res_active).unwrap();
        assert!(json_active.contains("\"cancelled\":false"));
        assert!(json_active.contains("\"partialReset\":false"));
        assert!(json_active.contains("\"sessionId\":\"session-abc\""));
        assert!(json_active.contains("\"sessionFile\":\"/path/to/session.jsonl\""));

        let res_cancelled = NewSessionResult {
            cancelled: true,
            partial_reset: false,
            session_id: None,
            session_file: None,
            error: None,
        };
        let json_cancelled = serde_json::to_string(&res_cancelled).unwrap();
        assert!(json_cancelled.contains("\"cancelled\":true"));
        assert!(json_cancelled.contains("\"partialReset\":false"));
        assert!(json_cancelled.contains("\"sessionId\":null"));

        let res_partial = NewSessionResult {
            cancelled: false,
            partial_reset: true,
            session_id: None,
            session_file: None,
            error: Some("get_state failed".to_string()),
        };
        let json_partial = serde_json::to_string(&res_partial).unwrap();
        assert!(json_partial.contains("\"partialReset\":true"));
        assert!(json_partial.contains("\"error\":\"get_state failed\""));

        let deserialized: NewSessionResult = serde_json::from_str(&json_active).unwrap();
        assert_eq!(deserialized, res_active);
    }

    #[test]
    fn test_connect_payload_session_continuity_fields() {
        let json = r#"{
            "nodePath": "node",
            "piEntrypoint": "C:\\pi\\cli.js",
            "workingDirectory": "C:\\project",
            "sessionFile": "C:\\sessions\\session1.jsonl",
            "requireSessionFileExists": true,
            "toolPolicy": "full",
            "requireApproval": true
        }"#;
        let payload: ConnectPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.node_path, "node");
        assert_eq!(
            payload.session_file,
            Some("C:\\sessions\\session1.jsonl".to_string())
        );
        assert_eq!(payload.require_session_file_exists, Some(true));
    }

    fn create_test_session(
        cwd: PathBuf,
        gen: u64,
    ) -> (ActiveSession, tokio::sync::mpsc::Receiver<String>) {
        use std::collections::HashMap;
        use std::sync::atomic::AtomicBool;
        use tokio::sync::mpsc;

        let (stdin_tx, stdin_rx) = mpsc::channel(16);
        let session = ActiveSession {
            child_pid: Some(1234),
            generation: gen,
            cwd,
            stdin_tx,
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(Mutex::new(None)),
            child_reap_rx: Arc::new(Mutex::new(None)),
            current_session_id: Arc::new(Mutex::new(Some("test-session-id".to_string()))),
            current_session_file: Arc::new(Mutex::new(Some("test-session.jsonl".to_string()))),
            is_alive: Arc::new(AtomicBool::new(true)),
        };
        (session, stdin_rx)
    }

    #[tokio::test]
    async fn test_multi_session_map_insertion_retrieval_and_switching() {
        let state = AppState::new();
        let path_a = dunce::canonicalize(".").unwrap();
        let path_b = dunce::canonicalize("..").unwrap();

        let (session_a, _rx_a) = create_test_session(path_a.clone(), 1);
        let (session_b, _rx_b) = create_test_session(path_b.clone(), 2);

        // Insert both into state.sessions
        state.sessions.lock().await.insert(path_a.clone(), session_a.clone());
        state.sessions.lock().await.insert(path_b.clone(), session_b.clone());

        // Set active_cwd to path_a
        *state.active_cwd.lock().await = Some(path_a.clone());
        *state.session.lock().await = Some(session_a.clone());

        let retrieved_a = state.get_session().await.expect("Failed to get session A");
        assert_eq!(retrieved_a.cwd, path_a);
        assert_eq!(retrieved_a.generation, 1);

        // Switch active_cwd to path_b
        *state.active_cwd.lock().await = Some(path_b.clone());
        *state.session.lock().await = Some(session_b.clone());

        let retrieved_b = state.get_session().await.expect("Failed to get session B");
        assert_eq!(retrieved_b.cwd, path_b);
        assert_eq!(retrieved_b.generation, 2);

        // Verify independent tracking: both sessions are still present in sessions map
        let sessions_guard = state.sessions.lock().await;
        assert_eq!(sessions_guard.len(), 2);
        assert!(sessions_guard.contains_key(&path_a));
        assert!(sessions_guard.contains_key(&path_b));
    }

    #[tokio::test]
    async fn test_multi_session_dead_session_fallback_and_handling() {
        let state = AppState::new();
        let path_a = dunce::canonicalize(".").unwrap();
        let path_b = dunce::canonicalize("..").unwrap();

        let (session_a, _rx_a) = create_test_session(path_a.clone(), 1);
        let (session_b, _rx_b) = create_test_session(path_b.clone(), 2);

        // Mark session_a as dead
        session_a.is_alive.store(false, Ordering::SeqCst);

        state.sessions.lock().await.insert(path_a.clone(), session_a.clone());
        state.sessions.lock().await.insert(path_b.clone(), session_b.clone());

        // When active_cwd is path_a (which is dead), get_session should fall back to any alive session (session_b)
        *state.active_cwd.lock().await = Some(path_a.clone());

        let retrieved = state.get_session().await.expect("Should fall back to alive session");
        assert_eq!(retrieved.cwd, path_b);
        assert_eq!(retrieved.generation, 2);

        // When both sessions are dead, get_session returns error
        session_b.is_alive.store(false, Ordering::SeqCst);
        let err_res = state.get_session().await;
        assert!(err_res.is_err());
        let err_msg = match err_res {
            Err(e) => e,
            Ok(_) => panic!("Expected error"),
        };
        assert!(err_msg.contains("Pi RPC bridge is not connected"));
    }

    #[test]
    fn test_disconnect_payload_deserialization() {
        let json = r#"{"workingDirectory":"C:\\project"}"#;
        let payload: DisconnectPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.working_directory, Some("C:\\project".to_string()));

        let json_empty = "{}";
        let payload_empty: DisconnectPayload = serde_json::from_str(json_empty).unwrap();
        assert_eq!(payload_empty.working_directory, None);
    }

    #[test]
    fn test_validate_extension_ui_response_valid_cases() {
        // 1. Confirm true
        let payload_conf_true = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("confirm".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        let res = validate_extension_ui_response(&payload_conf_true).unwrap();
        assert_eq!(res["type"], "extension_ui_response");
        assert_eq!(res["id"], "req-1");
        assert_eq!(res["confirmed"], true);

        // 2. Confirm false
        let payload_conf_false = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("confirm".to_string()),
            confirmed: Some(false),
            value: None,
            cancelled: None,
            cwd: None,
        };
        let res = validate_extension_ui_response(&payload_conf_false).unwrap();
        assert_eq!(res["confirmed"], false);

        // 3. Select with value
        let payload_select = ExtensionUiResponsePayload {
            id: "req-2".to_string(),
            method: Some("select".to_string()),
            value: Some("option-a".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: None,
        };
        let res = validate_extension_ui_response(&payload_select).unwrap();
        assert_eq!(res["value"], "option-a");

        // 4. Input with value
        let payload_input = ExtensionUiResponsePayload {
            id: "req-3".to_string(),
            method: Some("input".to_string()),
            value: Some("user text input".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: None,
        };
        let res = validate_extension_ui_response(&payload_input).unwrap();
        assert_eq!(res["value"], "user text input");

        // 5. Cancelled response with method
        let payload_cancelled = ExtensionUiResponsePayload {
            id: "req-4".to_string(),
            method: Some("select".to_string()),
            value: None,
            confirmed: None,
            cancelled: Some(true),
            cwd: None,
        };
        let res = validate_extension_ui_response(&payload_cancelled).unwrap();
        assert_eq!(res["cancelled"], true);

        // 6. Cancelled response without method
        let payload_cancelled_no_method = ExtensionUiResponsePayload {
            id: "req-5".to_string(),
            method: None,
            value: None,
            confirmed: None,
            cancelled: Some(true),
            cwd: None,
        };
        let res = validate_extension_ui_response(&payload_cancelled_no_method).unwrap();
        assert_eq!(res["cancelled"], true);
    }

    #[test]
    fn test_validate_extension_ui_response_invalid_cases() {
        // Empty ID
        let empty_id = ExtensionUiResponsePayload {
            id: "".to_string(),
            method: Some("confirm".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&empty_id).is_err());

        // Whitespace in ID
        let ws_id = ExtensionUiResponsePayload {
            id: "  req-1 ".to_string(),
            method: Some("confirm".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&ws_id).is_err());

        // Newline in ID
        let newline_id = ExtensionUiResponsePayload {
            id: "req-1\nnewline".to_string(),
            method: Some("confirm".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&newline_id).is_err());

        // ID exceeding max length
        let long_id = ExtensionUiResponsePayload {
            id: "a".repeat(MAX_EXTENSION_UI_ID_CHARS + 1),
            method: Some("confirm".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&long_id).is_err());

        // Unsupported method
        let unsupported_method = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("editor".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&unsupported_method).is_err());

        // Both confirmed and value
        let both_conf_and_val = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("confirm".to_string()),
            confirmed: Some(true),
            value: Some("val".to_string()),
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&both_conf_and_val).is_err());

        // Cancelled with value
        let cancel_with_val = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("select".to_string()),
            confirmed: None,
            value: Some("val".to_string()),
            cancelled: Some(true),
            cwd: None,
        };
        assert!(validate_extension_ui_response(&cancel_with_val).is_err());

        // Confirm method with value instead of confirmed
        let confirm_with_val = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("confirm".to_string()),
            confirmed: None,
            value: Some("yes".to_string()),
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&confirm_with_val).is_err());

        // Select method with confirmed instead of value
        let select_with_conf = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("select".to_string()),
            confirmed: Some(true),
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&select_with_conf).is_err());

        // No response specified
        let empty_resp = ExtensionUiResponsePayload {
            id: "req-1".to_string(),
            method: Some("select".to_string()),
            confirmed: None,
            value: None,
            cancelled: None,
            cwd: None,
        };
        assert!(validate_extension_ui_response(&empty_resp).is_err());
    }

    #[tokio::test]
    async fn test_send_extension_ui_response_command() {
        let state = AppState::new();
        let path = dunce::canonicalize(".").unwrap();
        let (session, mut rx) = create_test_session(path.clone(), 1);

        state.sessions.lock().await.insert(path.clone(), session.clone());
        *state.active_cwd.lock().await = Some(path.clone());
        *state.session.lock().await = Some(session.clone());

        let payload = ExtensionUiResponsePayload {
            id: "ui-dialog-123".to_string(),
            method: Some("select".to_string()),
            value: Some("Choice 1".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: None,
        };

        // Note: In tests we can invoke the handler logic directly
        let rpc_line = validate_extension_ui_response(&payload).unwrap();
        session.stdin_tx.send(rpc_line.to_string()).await.unwrap();

        let received = rx.recv().await.expect("Expected command on child stdin");
        let parsed: Value = serde_json::from_str(&received).unwrap();
        assert_eq!(parsed["type"], "extension_ui_response");
        assert_eq!(parsed["id"], "ui-dialog-123");
        assert_eq!(parsed["value"], "Choice 1");
    }

    #[tokio::test]
    async fn test_extension_ui_response_routing_isolation_on_a_b() {
        let app_state = AppState::new();
        let path_a = dunce::canonicalize(".").unwrap();
        let path_b = dunce::canonicalize("..").unwrap();

        let (session_a, mut rx_a) = create_test_session(path_a.clone(), 1);
        let (session_b, mut rx_b) = create_test_session(path_b.clone(), 2);

        app_state.sessions.lock().await.insert(path_a.clone(), session_a.clone());
        app_state.sessions.lock().await.insert(path_b.clone(), session_b.clone());

        // Active session is B!
        *app_state.active_cwd.lock().await = Some(path_b.clone());
        *app_state.session.lock().await = Some(session_b.clone());

        let state: State<'_, AppState> = unsafe { std::mem::transmute(&app_state) };

        // 1. Send extension UI response targeted at session A (even though active session is B)
        let payload_a = ExtensionUiResponsePayload {
            id: "dialog-a-1".to_string(),
            method: Some("select".to_string()),
            value: Some("Choice from A".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some(path_a.to_string_lossy().to_string()),
        };

        let res_a = send_extension_ui_response(payload_a, state.clone()).await.expect("Should route to session A");
        assert_eq!(res_a.id, "dialog-a-1");
        assert!(res_a.success);

        // Session A received the command
        let received_a = rx_a.recv().await.expect("Session A should have received stdin line");
        let parsed_a: Value = serde_json::from_str(&received_a).unwrap();
        assert_eq!(parsed_a["type"], "extension_ui_response");
        assert_eq!(parsed_a["id"], "dialog-a-1");
        assert_eq!(parsed_a["value"], "Choice from A");
        assert_eq!(parsed_a.get("cwd"), None, "Wire JSONL must NOT contain cwd");

        // Session B received NOTHING
        assert!(rx_b.try_recv().is_err(), "Session B must not receive session A's response");

        // 2. Send extension UI response targeted at session B
        let payload_b = ExtensionUiResponsePayload {
            id: "dialog-b-1".to_string(),
            method: Some("confirm".to_string()),
            value: None,
            confirmed: Some(true),
            cancelled: None,
            cwd: Some(path_b.to_string_lossy().to_string()),
        };

        let res_b = send_extension_ui_response(payload_b, state).await.expect("Should route to session B");
        assert_eq!(res_b.id, "dialog-b-1");
        assert!(res_b.success);

        // Session B received the command
        let received_b = rx_b.recv().await.expect("Session B should have received stdin line");
        let parsed_b: Value = serde_json::from_str(&received_b).unwrap();
        assert_eq!(parsed_b["type"], "extension_ui_response");
        assert_eq!(parsed_b["id"], "dialog-b-1");
        assert_eq!(parsed_b["confirmed"], true);
        assert_eq!(parsed_b.get("cwd"), None, "Wire JSONL must NOT contain cwd");

        // Session A received NOTHING more
        assert!(rx_a.try_recv().is_err(), "Session A must not receive session B's response");
    }

    #[tokio::test]
    async fn test_extension_ui_response_unknown_cwd_fails_closed() {
        let app_state = AppState::new();
        let path_b = dunce::canonicalize("..").unwrap();
        let (session_b, mut rx_b) = create_test_session(path_b.clone(), 2);

        app_state.sessions.lock().await.insert(path_b.clone(), session_b.clone());
        *app_state.active_cwd.lock().await = Some(path_b.clone());
        *app_state.session.lock().await = Some(session_b.clone());

        let state: State<'_, AppState> = unsafe { std::mem::transmute(&app_state) };

        let payload_unknown = ExtensionUiResponsePayload {
            id: "dialog-unknown".to_string(),
            method: Some("select".to_string()),
            value: Some("val".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some("/nonexistent/unknown/project/path".to_string()),
        };

        let err = send_extension_ui_response(payload_unknown, state).await.expect_err("Unknown cwd must fail closed");
        assert!(err.contains("No active session found"), "Error should report unknown session: {err}");

        // Active session B must NOT have received anything (no fallback to active!)
        assert!(rx_b.try_recv().is_err(), "Must not fall back to active session when cwd is unknown");
    }

    #[tokio::test]
    async fn test_extension_ui_response_dead_session_fails_closed() {
        use std::sync::atomic::Ordering;

        let app_state = AppState::new();
        let path_a = dunce::canonicalize(".").unwrap();
        let path_b = dunce::canonicalize("..").unwrap();

        let (session_a, mut rx_a) = create_test_session(path_a.clone(), 1);
        let (session_b, mut rx_b) = create_test_session(path_b.clone(), 2);

        // Mark session A as dead
        session_a.is_alive.store(false, Ordering::SeqCst);

        app_state.sessions.lock().await.insert(path_a.clone(), session_a.clone());
        app_state.sessions.lock().await.insert(path_b.clone(), session_b.clone());

        // Session B is alive and active
        *app_state.active_cwd.lock().await = Some(path_b.clone());
        *app_state.session.lock().await = Some(session_b.clone());

        let state: State<'_, AppState> = unsafe { std::mem::transmute(&app_state) };

        let payload = ExtensionUiResponsePayload {
            id: "dialog-dead".to_string(),
            method: Some("select".to_string()),
            value: Some("val".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some(path_a.to_string_lossy().to_string()),
        };

        let err = send_extension_ui_response(payload, state).await.expect_err("Dead session must fail closed");
        assert!(err.contains("not active"), "Error should report dead session: {err}");

        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err(), "Must not fall back to active session B");
    }

    #[tokio::test]
    async fn test_extension_ui_response_omitted_cwd_fallback() {
        let app_state = AppState::new();
        let path = dunce::canonicalize(".").unwrap();
        let (session, mut rx) = create_test_session(path.clone(), 1);

        app_state.sessions.lock().await.insert(path.clone(), session.clone());
        *app_state.active_cwd.lock().await = Some(path.clone());
        *app_state.session.lock().await = Some(session.clone());

        let state: State<'_, AppState> = unsafe { std::mem::transmute(&app_state) };

        let payload = ExtensionUiResponsePayload {
            id: "dialog-no-cwd".to_string(),
            method: Some("confirm".to_string()),
            value: None,
            confirmed: Some(false),
            cancelled: None,
            cwd: None,
        };

        let res = send_extension_ui_response(payload, state).await.expect("Omitted cwd should fall back to active session");
        assert_eq!(res.id, "dialog-no-cwd");
        assert!(res.success);

        let received = rx.recv().await.expect("Active session should have received stdin line");
        let parsed: Value = serde_json::from_str(&received).unwrap();
        assert_eq!(parsed["type"], "extension_ui_response");
        assert_eq!(parsed["id"], "dialog-no-cwd");
        assert_eq!(parsed["confirmed"], false);
        assert_eq!(parsed.get("cwd"), None);
    }

    #[test]
    fn test_extension_ui_validation_shape() {
        // Valid payload with cwd: cwd is stripped from wire output
        let payload_with_cwd = ExtensionUiResponsePayload {
            id: "dialog-shape-1".to_string(),
            method: Some("select".to_string()),
            value: Some("chosen-opt".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some("C:\\project\\path".to_string()),
        };
        let res = validate_extension_ui_response(&payload_with_cwd).unwrap();
        assert_eq!(res["type"], "extension_ui_response");
        assert_eq!(res["id"], "dialog-shape-1");
        assert_eq!(res["value"], "chosen-opt");
        assert_eq!(res.get("cwd"), None, "Wire output must not contain cwd");

        // Cancelled payload with cwd
        let payload_cancel_with_cwd = ExtensionUiResponsePayload {
            id: "dialog-shape-2".to_string(),
            method: Some("confirm".to_string()),
            value: None,
            confirmed: None,
            cancelled: Some(true),
            cwd: Some("/unix/project/path".to_string()),
        };
        let res = validate_extension_ui_response(&payload_cancel_with_cwd).unwrap();
        assert_eq!(res["type"], "extension_ui_response");
        assert_eq!(res["id"], "dialog-shape-2");
        assert_eq!(res["cancelled"], true);
        assert_eq!(res.get("cwd"), None, "Wire output must not contain cwd");

        // Empty cwd rejected
        let payload_empty_cwd = ExtensionUiResponsePayload {
            id: "dialog-shape-3".to_string(),
            method: Some("input".to_string()),
            value: Some("text".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some("".to_string()),
        };
        assert!(validate_extension_ui_response(&payload_empty_cwd).is_err());

        // Whitespace cwd rejected
        let payload_ws_cwd = ExtensionUiResponsePayload {
            id: "dialog-shape-4".to_string(),
            method: Some("input".to_string()),
            value: Some("text".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some("   ".to_string()),
        };
        assert!(validate_extension_ui_response(&payload_ws_cwd).is_err());

        // Newline in cwd rejected
        let payload_newline_cwd = ExtensionUiResponsePayload {
            id: "dialog-shape-5".to_string(),
            method: Some("input".to_string()),
            value: Some("text".to_string()),
            confirmed: None,
            cancelled: None,
            cwd: Some("path\nwith\nnewline".to_string()),
        };
        assert!(validate_extension_ui_response(&payload_newline_cwd).is_err());
    }

    #[tokio::test]
    async fn test_gentle_shell_preflight_in_connection_state() {
        let state = AppState::new();
        let home = PathBuf::from("/mock/isolated/home");

        // Initially empty
        {
            let declined = state.declined_migrations.lock().await;
            assert!(!declined.contains(&home));
        }

        // Inserting home
        {
            let mut declined = state.declined_migrations.lock().await;
            declined.insert(home.clone());
        }

        // Verify state retains declined home
        {
            let declined = state.declined_migrations.lock().await;
            assert!(declined.contains(&home));
        }
    }

    #[tokio::test]
    async fn test_gentle_shell_preflight_with_workspace_cwd() {
        let state = AppState::new();
        let workspace = PathBuf::from("/mock/workspace/project");
        let res = crate::commands::config_files::run_gentle_shell_migration_preflight(
            &state,
            Some(&workspace),
            None,
        ).await;
        assert!(res.is_ok());
    }
}
