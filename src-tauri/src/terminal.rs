//! Persistent Project Terminal Manager for native desktop (Tauri / portable-pty).
//!
//! Provides real PTY terminals per canonical project directory.
//! Supports minimize/continuity, bounded replay with absolute UTF-16 compatible cursors,
//! and clean process tree termination without orphaning descendants.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};

pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_MAX_REPLAY_BYTES: usize = 256 * 1024; // 256 KB bounded history
pub const MAX_CONCURRENT_POLLS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

    pub fn append(&mut self, _data: &str) {
        // STUB for RED phase
    }

    pub fn get_head_cursor(&self) -> usize {
        0 // STUB for RED phase
    }

    pub fn get_tail_cursor(&self) -> usize {
        0 // STUB for RED phase
    }

    pub fn read_from(&self, _cursor: usize) -> (String, usize) {
        (String::new(), 0) // STUB for RED phase
    }

    pub fn to_string(&self) -> String {
        String::new() // STUB for RED phase
    }

    pub fn clear(&mut self) {
        self.chunks.clear();
        self.total_utf16_len = 0;
        self.dropped_offset_utf16 = 0;
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
        _cwd: &str,
        _cols: Option<u16>,
        _rows: Option<u16>,
    ) -> Result<TerminalSessionDto, String> {
        Err("Not implemented: RED phase".to_string())
    }

    pub async fn write_session(&self, _id: &str, _data: &str) -> Result<(), String> {
        Err("Not implemented: RED phase".to_string())
    }

    pub async fn resize_session(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
        Err("Not implemented: RED phase".to_string())
    }

    pub async fn poll_session(
        &self,
        _id: &str,
        _cursor: usize,
        _timeout_ms: u64,
    ) -> Result<TerminalPollResult, String> {
        Err("Not implemented: RED phase".to_string())
    }

    pub async fn close_session(&self, _id: &str) -> Result<(), String> {
        Err("Not implemented: RED phase".to_string())
    }

    pub async fn get_session(&self, _id: Option<&str>, _cwd: Option<&str>) -> Option<TerminalSessionDto> {
        None
    }

    pub async fn list_sessions(&self) -> Vec<TerminalSessionDto> {
        Vec::new()
    }

    pub async fn dispose(&self) {}
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let unique = format!("pi-term-test-{}-{}-{}", prefix, std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("Failed to create temp test directory");
        dir
    }

    async fn wait_for<F>(mut condition: F, timeout_ms: u64) -> Result<(), String>
    where
        F: FnMut() -> bool,
    {
        let start = Instant::now();
        let timeout = Duration::from_millis(timeout_ms);
        while !condition() {
            if start.elapsed() > timeout {
                return Err(format!("Timed out after {}ms waiting for condition", timeout_ms));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
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

    #[cfg(windows)]
    fn is_process_alive(pid: u32) -> bool {
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
        while start.elapsed() < Duration::from_secs(5) {
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
        while start.elapsed() < Duration::from_secs(5) {
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
        while start.elapsed() < Duration::from_secs(5) {
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
        while start.elapsed() < Duration::from_secs(5) {
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
        while start.elapsed() < Duration::from_secs(6) {
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
        let mut alive: Vec<u32> = descendants.iter().copied().filter(|&p| is_process_alive(p)).collect();
        while !alive.is_empty() && start_wait.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(100)).await;
            alive = descendants.iter().copied().filter(|&p| is_process_alive(p)).collect();
        }

        assert!(alive.is_empty(), "All descendants must be terminated. Still alive: {:?}", alive);
        assert!(!is_process_alive(root_pid), "Root PID must be terminated");

        let _ = fs::remove_dir_all(&dir);
    }
}
