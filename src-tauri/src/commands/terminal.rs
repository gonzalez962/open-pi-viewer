use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::terminal::{TerminalPollResult, TerminalSessionDto};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenPayload {
    pub cwd: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWritePayload {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizePayload {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClosePayload {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPollPayload {
    pub id: String,
    pub cursor: Option<usize>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalGetPayload {
    pub id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSuccessResult {
    pub ok: bool,
}

#[tauri::command]
pub async fn terminal_open(
    payload: Option<TerminalOpenPayload>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    state: State<'_, AppState>,
) -> Result<TerminalSessionDto, String> {
    let open_cwd = payload
        .as_ref()
        .map(|p| p.cwd.clone())
        .or(cwd)
        .ok_or_else(|| "Working directory is required".to_string())?;
    let open_cols = payload.as_ref().and_then(|p| p.cols).or(cols);
    let open_rows = payload.as_ref().and_then(|p| p.rows).or(rows);

    state
        .terminal_manager
        .open_session(&open_cwd, open_cols, open_rows)
        .await
}

#[tauri::command]
pub async fn terminal_write(
    payload: Option<TerminalWritePayload>,
    id: Option<String>,
    data: Option<String>,
    state: State<'_, AppState>,
) -> Result<TerminalSuccessResult, String> {
    let write_id = payload
        .as_ref()
        .map(|p| p.id.clone())
        .or(id)
        .ok_or_else(|| "Session ID is required".to_string())?;
    let write_data = payload
        .as_ref()
        .map(|p| p.data.clone())
        .or(data)
        .ok_or_else(|| "Data is required".to_string())?;

    state
        .terminal_manager
        .write_session(&write_id, &write_data)
        .await?;
    Ok(TerminalSuccessResult { ok: true })
}

#[tauri::command]
pub async fn terminal_resize(
    payload: Option<TerminalResizePayload>,
    id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    state: State<'_, AppState>,
) -> Result<TerminalSuccessResult, String> {
    let resize_id = payload
        .as_ref()
        .map(|p| p.id.clone())
        .or(id)
        .ok_or_else(|| "Session ID is required".to_string())?;
    let resize_cols = payload
        .as_ref()
        .map(|p| p.cols)
        .or(cols)
        .ok_or_else(|| "Columns count is required".to_string())?;
    let resize_rows = payload
        .as_ref()
        .map(|p| p.rows)
        .or(rows)
        .ok_or_else(|| "Rows count is required".to_string())?;

    state
        .terminal_manager
        .resize_session(&resize_id, resize_cols, resize_rows)
        .await?;
    Ok(TerminalSuccessResult { ok: true })
}

#[tauri::command]
pub async fn terminal_close(
    payload: Option<TerminalClosePayload>,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<TerminalSuccessResult, String> {
    let close_id = payload
        .as_ref()
        .map(|p| p.id.clone())
        .or(id)
        .ok_or_else(|| "Session ID is required".to_string())?;

    state.terminal_manager.close_session(&close_id).await?;
    Ok(TerminalSuccessResult { ok: true })
}

#[tauri::command]
pub async fn terminal_poll(
    payload: Option<TerminalPollPayload>,
    id: Option<String>,
    cursor: Option<usize>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<TerminalPollResult, String> {
    let poll_id = payload
        .as_ref()
        .map(|p| p.id.clone())
        .or(id)
        .ok_or_else(|| "Session ID is required".to_string())?;
    let poll_cursor = payload.as_ref().and_then(|p| p.cursor).or(cursor).unwrap_or(0);
    let poll_timeout = payload
        .as_ref()
        .and_then(|p| p.timeout_ms)
        .or(timeout_ms)
        .unwrap_or(0);

    state
        .terminal_manager
        .poll_session(&poll_id, poll_cursor, poll_timeout)
        .await
}

#[tauri::command]
pub async fn terminal_get(
    payload: Option<TerminalGetPayload>,
    id: Option<String>,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<TerminalSessionDto>, String> {
    let get_id = payload.as_ref().and_then(|p| p.id.clone()).or(id);
    let get_cwd = payload.as_ref().and_then(|p| p.cwd.clone()).or(cwd);

    Ok(state
        .terminal_manager
        .get_session(get_id.as_deref(), get_cwd.as_deref())
        .await)
}

#[tauri::command]
pub async fn terminal_list(
    state: State<'_, AppState>,
) -> Result<Vec<TerminalSessionDto>, String> {
    Ok(state.terminal_manager.list_sessions().await)
}
