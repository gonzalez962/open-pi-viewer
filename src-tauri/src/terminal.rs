//! Persistent Project Terminal Manager for native desktop (Tauri / portable-pty).
//!
//! Provides real PTY terminals per canonical project directory.
//! Supports minimize/continuity, bounded replay with absolute UTF-16 compatible cursors,
//! and clean process tree termination without orphaning descendants.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};

pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_MAX_REPLAY_BYTES: usize = 256 * 1024; // 256 KB bounded history
pub const MAX_CONCURRENT_POLLS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionDto {
    pub id: String,
    pub cwd: String,
    pub canonical_cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: u32,
    pub running: bool,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPollResult {
    pub id: String,
    pub data: String,
    pub cursor: usize,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

#[derive(Debug)]
pub struct BoundedBuffer {
    chunks: VecDeque<String>,
    total_utf16_len: usize,
    dropped_offset_utf16: usize,
    max_capacity_utf16: usize,
}

impl BoundedBuffer {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_utf16_len: 0,
            dropped_offset_utf16: 0,
            max_capacity_utf16: max_capacity.max(1024),
        }
    }

    pub fn append(&mut self, data: &str) {
        if data.is_empty() {
            return;
        }
        let utf16_len = data.encode_utf16().count();
        self.chunks.push_back(data.to_string());
        self.total_utf16_len += utf16_len;

        while self.total_utf16_len > self.max_capacity_utf16 && !self.chunks.is_empty() {
            let overflow = self.total_utf16_len - self.max_capacity_utf16;
            let first_len = self.chunks[0].encode_utf16().count();
            if first_len <= overflow {
                self.total_utf16_len -= first_len;
                self.dropped_offset_utf16 += first_len;
                self.chunks.pop_front();
            } else {
                let first = self.chunks.pop_front().unwrap();
                let mut drop_units = 0;
                let mut byte_idx = 0;
                for c in first.chars() {
                    if drop_units >= overflow {
                        break;
                    }
                    drop_units += c.len_utf16();
                    byte_idx += c.len_utf8();
                }
                let remaining = &first[byte_idx..];
                self.total_utf16_len -= drop_units;
                self.dropped_offset_utf16 += drop_units;
                self.chunks.push_front(remaining.to_string());
                break;
            }
        }
    }

    pub fn get_head_cursor(&self) -> usize {
        self.dropped_offset_utf16 + self.total_utf16_len
    }

    pub fn get_tail_cursor(&self) -> usize {
        self.dropped_offset_utf16
    }

    pub fn read_from(&self, cursor: usize) -> (String, usize) {
        let head = self.get_head_cursor();
        if cursor >= head {
            return (String::new(), head);
        }
        let effective_start = cursor.saturating_sub(self.dropped_offset_utf16);
        let full = self.to_string();
        let mut current_utf16 = 0;
        let mut byte_idx = 0;
        for c in full.chars() {
            if current_utf16 >= effective_start {
                break;
            }
            current_utf16 += c.len_utf16();
            byte_idx += c.len_utf8();
        }
        (full[byte_idx..].to_string(), head)
    }

    pub fn to_string(&self) -> String {
        let mut out = String::with_capacity(self.chunks.iter().map(|c| c.len()).sum());
        for chunk in &self.chunks {
            out.push_str(chunk);
        }
        out
    }

    pub fn clear(&mut self) {
        self.chunks.clear();
        self.total_utf16_len = 0;
        self.dropped_offset_utf16 = 0;
    }
}

pub fn resolve_default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

pub fn resolve_canonical_cwd(raw_path: &str) -> Result<(String, String), String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Working directory is required".to_string());
    }
    let p = Path::new(trimmed);
    let canonical = dunce::canonicalize(p)
        .map_err(|e| format!("Target directory does not exist or is invalid: {}: {}", trimmed, e))?;
    if !canonical.is_dir() {
        return Err(format!("Target directory is not a directory: {}", trimmed));
    }
    let canonical_str = canonical.to_string_lossy().to_string();
    let key = if cfg!(windows) {
        canonical_str.to_lowercase()
    } else {
        canonical_str.clone()
    };
    Ok((canonical_str, key))
}

pub fn terminate_process_tree(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Ok(());
    }

    #[cfg(windows)]
    {
        // Execute process tree termination FIRST so descendant processes are not orphaned
        let output = std::process::Command::new("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to execute taskkill for PID {}: {}", pid, e))?;

        let status = output.status.code().unwrap_or(-1);
        // Status 0: success, status 128: process not found (already terminated)
        if status != 0 && status != 128 {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "taskkill failed for PID {} with exit code {}: {}",
                pid, status, stderr.trim()
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .output();
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
        Ok(())
    }
}

pub struct TerminalSession {
    pub id: String,
    pub cwd: String,
    pub canonical_cwd: String,
    pub cols: Arc<AtomicU16>,
    pub rows: Arc<AtomicU16>,
    pub pid: u32,
    pub is_running: Arc<AtomicBool>,
    pub exit_code: Arc<std::sync::Mutex<Option<i32>>>,
    pub exit_signal: Arc<std::sync::Mutex<Option<i32>>>,
    pub created_at: u64,
    pub buffer: Arc<std::sync::Mutex<BoundedBuffer>>,
    pub notify: Arc<Notify>,

    pub master: Arc<std::sync::Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<std::sync::Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<std::sync::Mutex<Box<dyn Child + Send + Sync>>>,
    pub active_polls: Arc<AtomicUsize>,
}

impl TerminalSession {
    pub fn new(
        cwd: &str,
        canonical_cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to create PTY: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to acquire PTY writer: {}", e))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to acquire PTY reader: {}", e))?;

        let shell = resolve_default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(canonical_cwd);

        if let Some(ref pat) = crate::commands::config_files::get_viewer_storage_github_pat() {
            cmd.env("GH_TOKEN", pat);
            cmd.env("GITHUB_TOKEN", pat);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell '{}': {}", shell, e))?;

        let pid = child.process_id().unwrap_or(0);
        let id = format!("term_{}", uuid::Uuid::new_v4());
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let buffer = Arc::new(std::sync::Mutex::new(BoundedBuffer::new(DEFAULT_MAX_REPLAY_BYTES)));
        let notify = Arc::new(Notify::new());
        let is_running = Arc::new(AtomicBool::new(true));
        let exit_code = Arc::new(std::sync::Mutex::new(None));
        let exit_signal = Arc::new(std::sync::Mutex::new(None));
        let child_arc = Arc::new(std::sync::Mutex::new(child));
        let master_arc = Arc::new(std::sync::Mutex::new(pair.master));
        let writer_arc = Arc::new(std::sync::Mutex::new(writer));

        let buffer_clone = Arc::clone(&buffer);
        let notify_clone = Arc::clone(&notify);
        let is_running_clone = Arc::clone(&is_running);
        let exit_code_clone = Arc::clone(&exit_code);
        let child_clone = Arc::clone(&child_arc);

        std::thread::Builder::new()
            .name(format!("pty-reader-{}", pid))
            .spawn(move || {
                let mut remainder = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            remainder.extend_from_slice(&buf[..n]);
                            match std::str::from_utf8(&remainder) {
                                Ok(valid_str) => {
                                    if !valid_str.is_empty() {
                                        {
                                            let mut b = buffer_clone.lock().unwrap();
                                            b.append(valid_str);
                                        }
                                        notify_clone.notify_waiters();
                                    }
                                    remainder.clear();
                                }
                                Err(e) => {
                                    let valid_up_to = e.valid_up_to();
                                    if valid_up_to > 0 {
                                        let valid_str = std::str::from_utf8(&remainder[..valid_up_to]).unwrap_or("");
                                        if !valid_str.is_empty() {
                                            {
                                                let mut b = buffer_clone.lock().unwrap();
                                                b.append(valid_str);
                                            }
                                            notify_clone.notify_waiters();
                                        }
                                    }
                                    if let Some(err_len) = e.error_len() {
                                        {
                                            let mut b = buffer_clone.lock().unwrap();
                                            b.append("\u{FFFD}");
                                        }
                                        notify_clone.notify_waiters();
                                        remainder.drain(..valid_up_to + err_len);
                                    } else {
                                        remainder.drain(..valid_up_to);
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                if !remainder.is_empty() {
                    let s = String::from_utf8_lossy(&remainder);
                    {
                        let mut b = buffer_clone.lock().unwrap();
                        b.append(&s);
                    }
                    notify_clone.notify_waiters();
                }

                is_running_clone.store(false, Ordering::SeqCst);
                if let Ok(mut c) = child_clone.lock() {
                    if let Ok(Some(status)) = c.try_wait() {
                        if let Ok(mut ec) = exit_code_clone.lock() {
                            *ec = Some(status.exit_code() as i32);
                        }
                    }
                }
                notify_clone.notify_waiters();
            })
            .map_err(|e| format!("Failed to spawn reader thread: {}", e))?;

        Ok(Self {
            id,
            cwd: cwd.to_string(),
            canonical_cwd: canonical_cwd.to_string(),
            cols: Arc::new(AtomicU16::new(cols)),
            rows: Arc::new(AtomicU16::new(rows)),
            pid,
            is_running,
            exit_code,
            exit_signal,
            created_at,
            buffer,
            notify,
            master: master_arc,
            writer: writer_arc,
            child: child_arc,
            active_polls: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn check_running(&self) -> bool {
        if !self.is_running.load(Ordering::SeqCst) {
            return false;
        }
        if let Ok(mut child) = self.child.try_lock() {
            if let Ok(Some(status)) = child.try_wait() {
                self.is_running.store(false, Ordering::SeqCst);
                if let Ok(mut ec) = self.exit_code.lock() {
                    *ec = Some(status.exit_code() as i32);
                }
                self.notify.notify_waiters();
                return false;
            }
        }
        self.is_running.load(Ordering::SeqCst)
    }

    pub fn write(&self, data: &str) -> Result<(), String> {
        if !self.check_running() {
            return Err(format!("Cannot write to terminated terminal session: {}", self.id));
        }
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(data.as_bytes()).map_err(|e| format!("Failed to write to terminal: {}", e))?;
        writer.flush().map_err(|e| format!("Failed to flush terminal writer: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if !self.check_running() {
            return Err(format!("Cannot resize terminated terminal session: {}", self.id));
        }
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| format!("Failed to resize PTY: {}", e))?;
        self.cols.store(cols, Ordering::SeqCst);
        self.rows.store(rows, Ordering::SeqCst);
        Ok(())
    }

    pub async fn poll(&self, cursor: usize, timeout_ms: u64) -> Result<TerminalPollResult, String> {
        let initial_read = {
            let buf = self.buffer.lock().unwrap();
            buf.read_from(cursor)
        };
        let is_running = self.check_running();

        if !initial_read.0.is_empty() || !is_running || timeout_ms == 0 {
            let exit_code = *self.exit_code.lock().unwrap();
            let signal = *self.exit_signal.lock().unwrap();
            return Ok(TerminalPollResult {
                id: self.id.clone(),
                data: initial_read.0,
                cursor: initial_read.1,
                running: is_running,
                exit_code,
                signal,
            });
        }

        let current_polls = self.active_polls.fetch_add(1, Ordering::SeqCst);
        if current_polls >= MAX_CONCURRENT_POLLS {
            self.active_polls.fetch_sub(1, Ordering::SeqCst);
            return Err("Too many concurrent poll requests for terminal session".to_string());
        }

        let _ = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.notify.notified(),
        ).await;

        self.active_polls.fetch_sub(1, Ordering::SeqCst);

        let final_read = {
            let buf = self.buffer.lock().unwrap();
            buf.read_from(cursor)
        };
        let running = self.check_running();
        let exit_code = *self.exit_code.lock().unwrap();
        let signal = *self.exit_signal.lock().unwrap();

        Ok(TerminalPollResult {
            id: self.id.clone(),
            data: final_read.0,
            cursor: final_read.1,
            running,
            exit_code,
            signal,
        })
    }

    pub fn kill(&self) -> Result<(), String> {
        // Execute process tree termination FIRST (before root exit)
        terminate_process_tree(self.pid)?;

        // Now kill the child handle
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }

        self.is_running.store(false, Ordering::SeqCst);
        if let Ok(mut ec) = self.exit_code.lock() {
            if ec.is_none() {
                *ec = Some(0);
            }
        }
        self.notify.notify_waiters();

        // Bounded wait on Windows to ensure OS process handle is fully released
        #[cfg(windows)]
        {
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(500) {
                if !is_process_alive_quick(self.pid) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }

        Ok(())
    }

    pub fn to_dto(&self, include_replay: bool) -> TerminalSessionDto {
        let (replay, cursor) = if include_replay {
            let buf = self.buffer.lock().unwrap();
            (Some(buf.to_string()), Some(buf.get_head_cursor()))
        } else {
            let buf = self.buffer.lock().unwrap();
            (None, Some(buf.get_head_cursor()))
        };
        TerminalSessionDto {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            canonical_cwd: self.canonical_cwd.clone(),
            cols: self.cols.load(Ordering::SeqCst),
            rows: self.rows.load(Ordering::SeqCst),
            pid: self.pid,
            running: self.check_running(),
            created_at: self.created_at,
            replay,
            cursor,
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if self.is_running.load(Ordering::SeqCst) {
            let _ = self.kill();
        }
    }
}

#[cfg(windows)]
fn is_process_alive_quick(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .output();
    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        text.contains(&pid.to_string())
    } else {
        false
    }
}

pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    by_id: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            by_id: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open_session(
        &self,
        cwd: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSessionDto, String> {
        let trimmed = cwd.trim();
        if trimmed.is_empty() {
            return Err("Working directory is required".to_string());
        }
        if let Some(0) = cols {
            return Err("Columns must be greater than zero".to_string());
        }
        if let Some(0) = rows {
            return Err("Rows must be greater than zero".to_string());
        }

        let (canonical_cwd, cwd_key) = resolve_canonical_cwd(trimmed)?;

        let mut sessions_guard = self.sessions.lock().await;

        let existing = sessions_guard.get(&cwd_key).cloned();
        if let Some(existing) = existing {
            if existing.check_running() {
                return Ok(existing.to_dto(true));
            }
            // Dead process: clean up before respawning
            let mut by_id_guard = self.by_id.lock().await;
            by_id_guard.remove(&existing.id);
            sessions_guard.remove(&cwd_key);
            let _ = existing.kill();
        }

        let initial_cols = cols.unwrap_or(DEFAULT_COLS);
        let initial_rows = rows.unwrap_or(DEFAULT_ROWS);

        let session = TerminalSession::new(trimmed, &canonical_cwd, initial_cols, initial_rows)?;
        let session_arc = Arc::new(session);

        sessions_guard.insert(cwd_key, Arc::clone(&session_arc));
        self.by_id.lock().await.insert(session_arc.id.clone(), Arc::clone(&session_arc));

        Ok(session_arc.to_dto(true))
    }

    pub async fn write_session(&self, id: &str, data: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("Session ID is required".to_string());
        }
        let session = {
            let by_id_guard = self.by_id.lock().await;
            by_id_guard.get(id).cloned()
        };
        let session = session.ok_or_else(|| format!("Terminal session not found: {}", id))?;
        session.write(data)
    }

    pub async fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("Session ID is required".to_string());
        }
        if cols == 0 || rows == 0 {
            return Err("Columns and rows must be greater than zero".to_string());
        }
        let session = {
            let by_id_guard = self.by_id.lock().await;
            by_id_guard.get(id).cloned()
        };
        let session = session.ok_or_else(|| format!("Terminal session not found: {}", id))?;
        session.resize(cols, rows)
    }

    pub async fn poll_session(
        &self,
        id: &str,
        cursor: usize,
        timeout_ms: u64,
    ) -> Result<TerminalPollResult, String> {
        if id.trim().is_empty() {
            return Err("Session ID is required".to_string());
        }
        let session = {
            let by_id_guard = self.by_id.lock().await;
            by_id_guard.get(id).cloned()
        };
        let session = session.ok_or_else(|| format!("Terminal session not found: {}", id))?;
        session.poll(cursor, timeout_ms.min(30_000)).await
    }

    pub async fn close_session(&self, id: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("Session ID is required".to_string());
        }
        let session = {
            let mut by_id_guard = self.by_id.lock().await;
            by_id_guard.remove(id)
        };
        let session = session.ok_or_else(|| format!("Terminal session not found: {}", id))?;
        {
            let mut sessions_guard = self.sessions.lock().await;
            let key = if cfg!(windows) {
                session.canonical_cwd.to_lowercase()
            } else {
                session.canonical_cwd.clone()
            };
            sessions_guard.remove(&key);
        }
        session.kill()
    }

    pub async fn get_session(&self, id: Option<&str>, cwd: Option<&str>) -> Option<TerminalSessionDto> {
        if let Some(id_str) = id {
            let by_id_guard = self.by_id.lock().await;
            return by_id_guard.get(id_str).map(|s| s.to_dto(true));
        }
        if let Some(cwd_str) = cwd {
            if let Ok((_, key)) = resolve_canonical_cwd(cwd_str) {
                let sessions_guard = self.sessions.lock().await;
                return sessions_guard.get(&key).map(|s| s.to_dto(true));
            }
        }
        None
    }

    pub async fn list_sessions(&self) -> Vec<TerminalSessionDto> {
        let by_id_guard = self.by_id.lock().await;
        by_id_guard.values().map(|s| s.to_dto(false)).collect()
    }

    pub async fn dispose(&self) {
        let sessions: Vec<Arc<TerminalSession>> = {
            let mut s = self.sessions.lock().await;
            s.drain().map(|(_, v)| v).collect()
        };
        {
            let mut by_id = self.by_id.lock().await;
            by_id.clear();
        }
        for session in sessions {
            let _ = session.kill();
        }
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let unique = format!(
            "pi-term-test-{}-{}-{}",
            prefix,
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("Failed to create temp test directory");
        dir
    }

    #[cfg(windows)]
    fn get_descendant_pids(root_pid: u32) -> Vec<u32> {
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
            ])
            .output();
        let Ok(output) = output else { return vec![]; };
        if !output.status.success() { return vec![]; }
        let Ok(text) = String::from_utf8(output.stdout) else { return vec![]; };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![]; };
        let list = match val {
            serde_json::Value::Array(arr) => arr,
            single @ serde_json::Value::Object(_) => vec![single],
            _ => return vec![],
        };
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        for item in list {
            if let (Some(pid), Some(ppid)) = (
                item.get("ProcessId").and_then(|v| v.as_u64()),
                item.get("ParentProcessId").and_then(|v| v.as_u64()),
            ) {
                children_map.entry(ppid as u32).or_default().push(pid as u32);
            }
        }
        let mut descendants = Vec::new();
        let mut queue = vec![root_pid];
        while let Some(parent) = queue.pop() {
            if let Some(children) = children_map.get(&parent) {
                for &child in children {
                    descendants.push(child);
                    queue.push(child);
                }
            }
        }
        descendants
    }

    #[test]
    fn test_utf16_cursor_progression_with_multibyte_characters() {
        let mut buf = BoundedBuffer::new(1024);

        // Standard ASCII
        buf.append("Hello ");
        assert_eq!(buf.get_head_cursor(), 6);

        // Multibyte rocket emoji (4 UTF-8 bytes, 2 UTF-16 code units)
        buf.append("🚀");
        assert_eq!(buf.get_head_cursor(), 8);

        // Box drawing character (3 UTF-8 bytes, 1 UTF-16 code unit)
        buf.append("─");
        assert_eq!(buf.get_head_cursor(), 9);

        // Incremental reads using UTF-16 cursor
        let (d1, c1) = buf.read_from(0);
        assert_eq!(d1, "Hello 🚀─");
        assert_eq!(c1, 9);

        let (d2, c2) = buf.read_from(6);
        assert_eq!(d2, "🚀─");
        assert_eq!(c2, 9);

        let (d3, c3) = buf.read_from(8);
        assert_eq!(d3, "─");
        assert_eq!(c3, 9);

        let (d4, c4) = buf.read_from(9);
        assert_eq!(d4, "");
        assert_eq!(c4, 9);
    }

    #[test]
    fn test_buffer_eviction_and_cursor_monotonicity() {
        let mut buf = BoundedBuffer::new(1024);

        let chunk = "A".repeat(500);
        buf.append(&chunk); // total: 500, head: 500
        assert_eq!(buf.get_head_cursor(), 500);
        assert_eq!(buf.get_tail_cursor(), 0);

        buf.append(&chunk); // total: 1000, head: 1000
        assert_eq!(buf.get_head_cursor(), 1000);
        assert_eq!(buf.get_tail_cursor(), 0);

        // Adding 200 more bytes exceeds 1024 capacity
        buf.append(&"B".repeat(200)); // total: 1200 -> evicts 176 from front
        assert_eq!(buf.get_head_cursor(), 1200);
        assert!(buf.get_tail_cursor() > 0, "Tail cursor must advance on eviction");
        assert!(buf.to_string().len() <= 1024, "Buffer capacity must remain bounded");

        let (read_data, next_c) = buf.read_from(0);
        assert_eq!(next_c, 1200);
        assert!(read_data.ends_with(&"B".repeat(200)));
    }

    #[test]
    fn test_ipc_serde_camel_case_contracts() {
        let dto = TerminalSessionDto {
            id: "term_test_123".to_string(),
            cwd: "C:\\test".to_string(),
            canonical_cwd: "C:\\test".to_string(),
            cols: 80,
            rows: 24,
            pid: 1234,
            running: true,
            created_at: 1700000000000,
            replay: Some("test replay".to_string()),
            cursor: Some(42),
        };

        let json = serde_json::to_string(&dto).expect("Serialization failed");
        assert!(json.contains("\"canonicalCwd\":"), "Must serialize canonicalCwd");
        assert!(json.contains("\"createdAt\":"), "Must serialize createdAt");
        assert!(json.contains("\"term_test_123\""));

        let deserialized: TerminalSessionDto = serde_json::from_str(&json).expect("Deserialization failed");
        assert_eq!(deserialized, dto);

        let poll_res = TerminalPollResult {
            id: "term_test_123".to_string(),
            data: "out".to_string(),
            cursor: 100,
            running: false,
            exit_code: Some(0),
            signal: None,
        };
        let poll_json = serde_json::to_string(&poll_res).expect("Poll serialization failed");
        assert!(poll_json.contains("\"exitCode\":0"));
    }

    #[tokio::test]
    async fn test_s1_1_cwd_identifies_working_directory() {
        // S1.1: Given project A, when its terminal opens and executes a cwd command, then output identifies A's working directory.
        let manager = TerminalManager::new();
        let dir = temp_test_dir("s1-1");
        let dir_str = dir.to_string_lossy().to_string();

        let session = manager.open_session(&dir_str, None, None).await
            .expect("Failed to open terminal session for project A");
        assert!(!session.id.is_empty());
        assert!(session.running);
        assert!(session.pid > 0);

        let cwd_cmd = if cfg!(windows) { "cd\r\n" } else { "pwd\n" };
        manager.write_session(&session.id, cwd_cmd).await.expect("Failed to write cwd command");

        let canonical = dunce::canonicalize(&dir).unwrap().to_string_lossy().to_string();
        let mut found = false;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            let poll = manager.poll_session(&session.id, 0, 100).await.expect("Poll failed");
            if poll.data.to_lowercase().contains(&canonical.to_lowercase())
                || poll.data.to_lowercase().contains(&dir_str.to_lowercase())
            {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        manager.close_session(&session.id).await.ok();
        let _ = fs::remove_dir_all(&dir);

        assert!(found, "Output must identify working directory. Canonical: {}", canonical);
    }

    #[tokio::test]
    async fn test_s1_2_process_isolation_between_projects() {
        // S1.2: Given running terminals for projects A and B, when input is sent to A, then only A receives the command and B's process remains independent.
        let manager = TerminalManager::new();
        let dir_a = temp_test_dir("s1-2-a");
        let dir_b = temp_test_dir("s1-2-b");

        let session_a = manager.open_session(&dir_a.to_string_lossy(), None, None).await.expect("Open A failed");
        let session_b = manager.open_session(&dir_b.to_string_lossy(), None, None).await.expect("Open B failed");

        assert_ne!(session_a.id, session_b.id, "Session IDs must be distinct");
        assert_ne!(session_a.pid, session_b.pid, "Process PIDs must be distinct");

        let marker_a = format!("MARKER_AAA_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis());
        let cmd = format!("echo {}\r\n", marker_a);
        manager.write_session(&session_a.id, &cmd).await.expect("Write A failed");

        let mut found_a = false;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            let poll_a = manager.poll_session(&session_a.id, 0, 100).await.expect("Poll A failed");
            if poll_a.data.contains(&marker_a) {
                found_a = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(found_a, "Terminal A must receive and output its marker");

        tokio::time::sleep(Duration::from_millis(200)).await;
        let poll_b = manager.poll_session(&session_b.id, 0, 0).await.expect("Poll B failed");
        assert!(!poll_b.data.contains(&marker_a), "Terminal B must NOT receive input sent to A");

        manager.close_session(&session_a.id).await.ok();
        manager.close_session(&session_b.id).await.ok();
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[tokio::test]
    async fn test_s3_1_minimize_and_reopen_persists_process_and_output() {
        // S3.1: Given a running terminal, when minimized and reopened, then the same process and output remain available.
        let manager = TerminalManager::new();
        let dir = temp_test_dir("s3-1");
        let dir_str = dir.to_string_lossy().to_string();

        let session1 = manager.open_session(&dir_str, None, None).await.expect("Open session failed");
        let marker = format!("PERSIST_S31_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis());
        let cmd = format!("echo {}\r\n", marker);
        manager.write_session(&session1.id, &cmd).await.expect("Write failed");

        let mut output_received = false;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            if let Some(dto) = manager.get_session(Some(&session1.id), None).await {
                if dto.replay.as_deref().unwrap_or("").contains(&marker) {
                    output_received = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(output_received, "Output must be captured in replay buffer");

        // Reopening for the same directory simulates reopening after minimize
        let session2 = manager.open_session(&dir_str, None, None).await.expect("Reopen session failed");
        assert_eq!(session2.id, session1.id, "Session ID must remain identical on reopen");
        assert_eq!(session2.pid, session1.pid, "PID must remain identical on reopen");
        assert!(session2.running, "Process must remain running");
        assert!(session2.replay.as_deref().unwrap_or("").contains(&marker), "Buffered output must be preserved");

        manager.close_session(&session1.id).await.ok();
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_s3_2_switching_projects_and_disconnect_preserves_buffered_output() {
        // S3.2: Given terminals A and B, when switching projects or disconnecting and reconnecting a client, then both processes survive and reattachment restores buffered output.
        let manager = TerminalManager::new();
        let dir_a = temp_test_dir("s3-2-a");
        let dir_b = temp_test_dir("s3-2-b");

        let session_a = manager.open_session(&dir_a.to_string_lossy(), None, None).await.expect("Open A failed");
        let session_b = manager.open_session(&dir_b.to_string_lossy(), None, None).await.expect("Open B failed");

        let marker_a = format!("DATA_A_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis());
        let marker_b = format!("DATA_B_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis());

        manager.write_session(&session_a.id, &format!("echo {}\r\n", marker_a)).await.expect("Write A");
        manager.write_session(&session_b.id, &format!("echo {}\r\n", marker_b)).await.expect("Write B");

        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            let has_a = manager.get_session(Some(&session_a.id), None).await.and_then(|s| s.replay).map(|r| r.contains(&marker_a)).unwrap_or(false);
            let has_b = manager.get_session(Some(&session_b.id), None).await.and_then(|s| s.replay).map(|r| r.contains(&marker_b)).unwrap_or(false);
            if has_a && has_b { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Client reconnects / reattaches to A
        let reattach_a = manager.open_session(&dir_a.to_string_lossy(), None, None).await.expect("Reattach A");
        assert_eq!(reattach_a.id, session_a.id);
        assert_eq!(reattach_a.pid, session_a.pid);
        assert!(reattach_a.replay.as_deref().unwrap_or("").contains(&marker_a), "Reattachment to A restores buffer");

        // Client switches to B
        let reattach_b = manager.open_session(&dir_b.to_string_lossy(), None, None).await.expect("Reattach B");
        assert_eq!(reattach_b.id, session_b.id);
        assert_eq!(reattach_b.pid, session_b.pid);
        assert!(reattach_b.replay.as_deref().unwrap_or("").contains(&marker_b), "Reattachment to B restores buffer");

        manager.close_session(&session_a.id).await.ok();
        manager.close_session(&session_b.id).await.ok();
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[tokio::test]
    async fn test_s3_3_explicit_close_terminates_and_reopen_creates_new_session() {
        // S3.3: Given terminals A and B, when the user confirms closing A, then A terminates, B remains live, and reopening A creates a new session.
        let manager = TerminalManager::new();
        let dir_a = temp_test_dir("s3-3-a");
        let dir_b = temp_test_dir("s3-3-b");

        let session_a = manager.open_session(&dir_a.to_string_lossy(), None, None).await.expect("Open A failed");
        let session_b = manager.open_session(&dir_b.to_string_lossy(), None, None).await.expect("Open B failed");

        // Explicit close of A
        manager.close_session(&session_a.id).await.expect("Close A failed");

        assert!(manager.get_session(Some(&session_a.id), None).await.is_none(), "Terminated session A must be removed");

        // Terminal B remains live
        let active_b = manager.get_session(Some(&session_b.id), None).await.expect("Session B must remain active");
        assert!(active_b.running, "Session B must still be running");

        // Reopening A creates a new session
        let new_a = manager.open_session(&dir_a.to_string_lossy(), None, None).await.expect("Reopen A failed");
        assert_ne!(new_a.id, session_a.id, "New session A must have a new id");
        assert_ne!(new_a.pid, session_a.pid, "New session A must have a new pid");
        assert!(new_a.running, "New session A must be running");

        manager.close_session(&session_b.id).await.ok();
        manager.close_session(&new_a.id).await.ok();
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[tokio::test]
    async fn test_s4_2_invalid_operations_leave_sessions_unchanged() {
        // S4.2: Invalid operations leave sessions unchanged.
        let manager = TerminalManager::new();
        let dir = temp_test_dir("s4-2");
        let session = manager.open_session(&dir.to_string_lossy(), None, None).await.expect("Valid open failed");

        // Empty cwd rejected
        assert!(manager.open_session("", None, None).await.is_err());
        assert!(manager.open_session("   ", None, None).await.is_err());

        // Nonexistent cwd rejected
        let fake_path = dir.join("nonexistent_subfolder_xyz");
        assert!(manager.open_session(&fake_path.to_string_lossy(), None, None).await.is_err());

        // Invalid session ID rejected
        assert!(manager.write_session("invalid-session-id", "test").await.is_err());
        assert!(manager.resize_session("invalid-session-id", 80, 24).await.is_err());
        assert!(manager.poll_session("invalid-session-id", 0, 0).await.is_err());
        assert!(manager.close_session("invalid-session-id").await.is_err());

        // Zero dimensions rejected
        assert!(manager.resize_session(&session.id, 0, 24).await.is_err());
        assert!(manager.resize_session(&session.id, 80, 0).await.is_err());

        // Valid session is still alive and unchanged
        let current = manager.get_session(Some(&session.id), None).await.expect("Session still exists");
        assert!(current.running);
        assert_eq!(current.id, session.id);

        manager.close_session(&session.id).await.ok();
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_regression_tree_termination_kills_descendants() {
        // Regression: Explicit close terminates shell AND descendant process tree without orphaning children
        let manager = TerminalManager::new();
        let dir = temp_test_dir("reg-tree");

        let worker_script = dir.join("worker.js");
        fs::write(
            &worker_script,
            r#"const { spawn } = require("child_process");
const sub = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { detached: true, stdio: "ignore" });
sub.unref();
setInterval(()=>{}, 1000);"#,
        ).expect("Failed to write worker script");

        let session = manager.open_session(&dir.to_string_lossy(), None, None).await.expect("Open failed");
        let root_pid = session.pid;
        assert!(root_pid > 0);

        manager.write_session(&session.id, "node worker.js\r\n").await.expect("Write failed");

        // Wait for descendants to appear
        let mut descendants = Vec::new();
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            descendants = get_descendant_pids(root_pid);
            if descendants.len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        assert!(descendants.len() >= 2, "Descendants must be spawned. Found: {:?}", descendants);

        // Explicit close
        manager.close_session(&session.id).await.expect("Close failed");

        // Verify with deadline that all descendants and root shell are terminated
        let start_wait = Instant::now();
        let mut alive: Vec<u32> = descendants.iter().copied().filter(|&p| is_process_alive_quick(p)).collect();
        while !alive.is_empty() && start_wait.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(100)).await;
            alive = descendants.iter().copied().filter(|&p| is_process_alive_quick(p)).collect();
        }

        assert!(alive.is_empty(), "All descendants must be terminated. Still alive: {:?}", alive);
        assert!(!is_process_alive_quick(root_pid), "Root PID must be terminated");

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_terminal_session_pat_propagation() {
        let _guard = crate::commands::config_files::VIEWER_STORAGE_TEST_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = temp_test_dir("pat-prop");
        let config_file = dir.join("open-pi-viewer.json");

        crate::commands::config_files::set_viewer_storage_path_override_for_test(Some(
            config_file.clone(),
        ));

        // S2.2: When githubPat is set in storage, terminal session gets GH_TOKEN and GITHUB_TOKEN
        fs::write(
            &config_file,
            r#"{"version": 1, "githubPat": "ghp_termToken456"}"#,
        )
        .expect("Failed to write config");

        let manager = TerminalManager::new();
        let session = manager
            .open_session(&dir.to_string_lossy(), None, None)
            .await
            .expect("Open failed");

        let probe_script = dir.join("probe.js");
        fs::write(
            &probe_script,
            "const fs = require('fs'); fs.writeFileSync('env_out.txt', (process.env.GH_TOKEN||'') + '|' + (process.env.GITHUB_TOKEN||''));\n",
        )
        .expect("Failed to write probe script");

        // Small sleep to ensure shell prompt is ready to receive input
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager
            .write_session(&session.id, "node probe.js\r\n")
            .await
            .expect("Write failed");

        let out_file = dir.join("env_out.txt");
        let start = Instant::now();
        let mut content = String::new();
        while start.elapsed() < Duration::from_secs(5) {
            if let Ok(c) = fs::read_to_string(&out_file) {
                if !c.is_empty() {
                    content = c;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        manager.close_session(&session.id).await.ok();

        assert_eq!(
            content,
            "ghp_termToken456|ghp_termToken456",
            "Terminal session process should inherit GH_TOKEN and GITHUB_TOKEN"
        );

        // Negative check: when githubPat is empty whitespace, terminal does not inject synthetic tokens
        let _ = fs::remove_file(&out_file);
        fs::write(&config_file, r#"{"version": 1, "githubPat": "   "}"#)
            .expect("Failed to write empty config");

        let session2 = manager
            .open_session(&dir.to_string_lossy(), None, None)
            .await
            .expect("Open session 2 failed");

        tokio::time::sleep(Duration::from_millis(200)).await;
        manager
            .write_session(&session2.id, "node probe.js\r\n")
            .await
            .expect("Write 2 failed");

        let start2 = Instant::now();
        let mut content2 = String::new();
        while start2.elapsed() < Duration::from_secs(5) {
            if let Ok(c) = fs::read_to_string(&out_file) {
                content2 = c;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        manager.close_session(&session2.id).await.ok();
        crate::commands::config_files::set_viewer_storage_path_override_for_test(None);

        assert_eq!(
            content2, "|",
            "Terminal session must not inject GH_TOKEN or GITHUB_TOKEN when githubPat is whitespace"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
