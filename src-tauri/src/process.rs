//! Pi RPC Subprocess Manager.
//!
//! Spawns Node directly with argv arguments (no shell, no pi.cmd wrapper),
//! drains stdout with strict LF framing, drains stderr with bounded diagnostics,
//! correlates command responses, and cancels extension UI dialog requests.
//!
//! Enforces generation gating to prevent stale events from clobbering new sessions,
//! uses a single terminal authority (the reaper task) for process exit status,
//! prevents orphaned child processes via kill_on_drop and graceful reap, and avoids
//! leaking raw stderr strings across the IPC boundary.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::framing::JsonlFrameBuffer;

/// Maximum diagnostics buffer size for stderr (64 KB)
pub const MAX_STDERR_BYTES: usize = 64 * 1024;
/// Handshake timeout waiting for initial get_state response
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Counter for generating unique internal request IDs (handshake, abort)
static REQ_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Maximum length in characters for client-generated prompt request ID
pub const MAX_PROMPT_ID_CHARS: usize = 128;
/// Prefix required for prompt request IDs to stay disjoint from internal command IDs
pub const PROMPT_ID_PREFIX: &str = "prompt-";

/// Payload received from frontend to establish Pi connection
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectPayload {
    pub node_path: String,
    pub pi_entrypoint: String,
    pub working_directory: String,
    pub session_file: Option<String>,
    pub require_session_file_exists: Option<bool>,
    #[serde(default)]
    pub load_all: Option<bool>,
}

/// Bounded diagnostics collector for child stderr.
///
/// Retains the most recent bytes (up to max_bytes) in a circular buffer.
/// Decodes UTF-8 lossily for internal error diagnosis. Does not perform
/// regex sanitization or guarantee redaction of sensitive tokens; therefore,
/// raw excerpts are NOT forwarded across IPC to the UI.
#[derive(Debug)]
pub struct StderrCollector {
    buffer: VecDeque<u8>,
    max_bytes: usize,
}

impl StderrCollector {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(max_bytes.min(8192)),
            max_bytes,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if self.buffer.len() >= self.max_bytes {
                self.buffer.pop_front();
            }
            self.buffer.push_back(b);
        }
    }

    /// Decodes buffered stderr bytes lossily for internal inspection.
    /// Note: Does NOT guarantee secret or credential redaction.
    pub fn get_lossy_excerpt(&self) -> String {
        let (s1, s2) = self.buffer.as_slices();
        let mut v = Vec::with_capacity(s1.len() + s2.len());
        v.extend_from_slice(s1);
        v.extend_from_slice(s2);
        String::from_utf8_lossy(&v).into_owned()
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }
}

/// Validate paths provided by user
pub fn validate_paths(
    node_path: &str,
    pi_entrypoint: &str,
    working_directory: &str,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    // 1. Working directory validation
    let cwd_str = working_directory.trim();
    if cwd_str.is_empty() {
        return Err("Working directory path cannot be empty".to_string());
    }
    let cwd = PathBuf::from(cwd_str);
    if !cwd.exists() {
        return Err(format!("Working directory does not exist: {cwd_str}"));
    }
    if !cwd.is_dir() {
        return Err(format!("Working directory is not a directory: {cwd_str}"));
    }
    let canonical_cwd = dunce::canonicalize(&cwd)
        .map_err(|e| format!("Failed to canonicalize working directory '{cwd_str}': {e}"))?;

    // 2. Pi entrypoint validation
    let entry_str = pi_entrypoint.trim();
    if entry_str.is_empty() {
        return Err("Pi CLI JavaScript entrypoint path cannot be empty".to_string());
    }
    let entry = PathBuf::from(entry_str);
    if !entry.is_absolute() {
        return Err(format!(
            "Pi entrypoint must be an absolute path: '{entry_str}'"
        ));
    }
    if !entry.exists() {
        return Err(format!("Pi entrypoint file does not exist: '{entry_str}'"));
    }
    if !entry.is_file() {
        return Err(format!("Pi entrypoint is not a file: '{entry_str}'"));
    }

    let ext = entry
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "js" && ext != "mjs" && ext != "cjs" {
        return Err(format!(
            "Pi entrypoint must have a JavaScript extension (.js, .mjs, .cjs), got: '{entry_str}'"
        ));
    }
    let canonical_entry = dunce::canonicalize(&entry)
        .map_err(|e| format!("Failed to canonicalize Pi entrypoint '{entry_str}': {e}"))?;

    // 3. Node executable validation
    let node_str = node_path.trim();
    if node_str.is_empty() {
        return Err("Node executable path cannot be empty (default is 'node')".to_string());
    }

    let resolved_node = if node_str == "node" || node_str == "node.exe" {
        // Use direct executable name, resolved via PATH without shell
        PathBuf::from(node_str)
    } else {
        let p = PathBuf::from(node_str);
        if !p.exists() {
            return Err(format!("Node executable does not exist at: '{node_str}'"));
        }
        if !p.is_file() {
            return Err(format!("Node executable is not a file: '{node_str}'"));
        }
        dunce::canonicalize(&p)
            .map_err(|e| format!("Failed to canonicalize Node executable '{node_str}': {e}"))?
    };

    Ok((resolved_node, canonical_entry, canonical_cwd))
}

/// Representation of an active Pi RPC session
#[derive(Clone)]
pub struct ActiveSession {
    pub child_pid: Option<u32>,
    pub generation: u64,
    pub cwd: PathBuf,
    pub stdin_tx: mpsc::Sender<String>,
    pub pending_responses: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    pub stderr_collector: Arc<Mutex<StderrCollector>>,
    pub abort_kill_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    pub child_reap_rx: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
    pub current_session_id: Arc<Mutex<Option<String>>>,
    pub current_session_file: Arc<Mutex<Option<String>>>,
    pub is_alive: Arc<AtomicBool>,
}

/// Canonical validated execution paths retained from an active session
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionExecutionPaths {
    pub node_path: PathBuf,
    pub entrypoint: PathBuf,
    pub generation: u64,
}

static SESSION_PATHS: OnceLock<RwLock<HashMap<PathBuf, SessionExecutionPaths>>> = OnceLock::new();

fn session_paths_registry() -> &'static RwLock<HashMap<PathBuf, SessionExecutionPaths>> {
    SESSION_PATHS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Record validated execution paths for a session associated with a working directory.
pub fn record_session_paths(cwd: &Path, node_path: &Path, entrypoint: &Path, generation: u64) {
    if let Ok(mut lock) = session_paths_registry().write() {
        lock.insert(
            cwd.to_path_buf(),
            SessionExecutionPaths {
                node_path: node_path.to_path_buf(),
                entrypoint: entrypoint.to_path_buf(),
                generation,
            },
        );
    }
}

/// Get retained execution paths for a working directory and generation.
/// Strictly validates generation matching to prevent stale path reuse.
pub fn get_session_paths(cwd: &Path, generation: u64) -> Option<SessionExecutionPaths> {
    session_paths_registry()
        .read()
        .ok()
        .and_then(|lock| lock.get(cwd).cloned())
        .filter(|p| p.generation == generation)
}

/// Remove retained execution paths for a working directory if generation matches strictly.
pub fn remove_session_paths(cwd: &Path, generation: u64) {
    if let Ok(mut lock) = session_paths_registry().write() {
        if let Some(entry) = lock.get(cwd) {
            if entry.generation == generation {
                lock.remove(cwd);
            }
        }
    }
}

/// Status change notification emitted to frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusChangePayload {
    pub state: String,
    pub label: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Build command-line arguments for launching Pi in RPC mode as an unrestricted wrapper.
pub fn build_pi_args(
    entrypoint: &Path,
    session_file: Option<&Path>,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    args.push(entrypoint.as_os_str().to_os_string());
    args.push("--mode".into());
    args.push("rpc".into());
    args.push("--approve".into());

    if let Some(sf) = session_file {
        args.push("--session".into());
        args.push(sf.as_os_str().to_os_string());
    }

    args
}

/// Returns true if the entrypoint's basename is exactly gentle-shell.js,
/// gentle-shell.mjs, or gentle-shell.cjs (case-insensitive).
pub fn is_gentle_shell_entrypoint(entrypoint: &Path) -> bool {
    let Some(file_name) = entrypoint.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = file_name.to_ascii_lowercase();
    lower == "gentle-shell.js" || lower == "gentle-shell.mjs" || lower == "gentle-shell.cjs"
}

impl ActiveSession {
    /// Retrieve canonical validated Node executable path used to start this session.
    pub fn node_path(&self) -> Option<PathBuf> {
        get_session_paths(&self.cwd, self.generation).map(|p| p.node_path)
    }

    /// Retrieve canonical validated Pi entrypoint path used to start this session.
    pub fn entrypoint(&self) -> Option<PathBuf> {
        get_session_paths(&self.cwd, self.generation).map(|p| p.entrypoint)
    }

    /// Retrieve canonical validated (node_path, entrypoint) tuple.
    pub fn execution_paths(&self) -> Option<SessionExecutionPaths> {
        get_session_paths(&self.cwd, self.generation)
    }

    /// Spawn the Pi process, configure strict LF framing reader and stderr collector,
    /// perform the initial get_state handshake with cancellation support, and return
    /// the running session handle.
    pub async fn start<R: tauri::Runtime>(
        app_handle: tauri::AppHandle<R>,
        node_path: &Path,
        entrypoint: &Path,
        cwd: &Path,
        session_file: Option<&Path>,
        generation: u64,
        current_generation: Arc<AtomicU64>,
        mut cancel_rx: oneshot::Receiver<()>,
    ) -> Result<
        (
            Self,
            Value,
            Option<String>,
            Option<String>,
            u64,
            Vec<Value>,
        ),
        String,
    > {
        let mut cmd = tokio::process::Command::new(node_path);

        // Set kill_on_drop(true) as baseline defense against leaked child processes
        cmd.kill_on_drop(true);

        // Spawn Node directly with argv arguments (no shell, no pi.cmd shell-string workaround).
        // Unrestricted direct wrapper: node <entrypoint> --mode rpc --approve [--session <session_file>]
        let pi_args = build_pi_args(entrypoint, session_file);
        cmd.args(&pi_args);

        // Only for Gentle Shell entrypoints, signal that pi-viewer acts as an interactive RPC host.
        // Direct Pi entrypoints remain unchanged.
        if is_gentle_shell_entrypoint(entrypoint) {
            cmd.env("GENTLE_SHELL_INTERACTIVE_HOST", "1");
        } else {
            cmd.env_remove("GENTLE_SHELL_INTERACTIVE_HOST");
        }

        cmd.current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn Node executable '{}' with entrypoint '{}': {e}",
                node_path.display(),
                entrypoint.display()
            )
        })?;

        let child_pid = child.id();
        let mut stdin = child.stdin.take().ok_or("Failed to open child stdin")?;
        let mut stdout = child.stdout.take().ok_or("Failed to open child stdout")?;
        let mut stderr = child.stderr.take().ok_or("Failed to open child stderr")?;

        let pending_responses: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stderr_collector = Arc::new(Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

        // Channel for writing commands to child stdin
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(128);

        // Task 1: Stdin writer task
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                let mut data = line.into_bytes();
                if !data.ends_with(b"\n") {
                    data.push(b'\n');
                }
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // Task 2: Stderr reader task (draining with bounded ring buffer)
        let stderr_coll_clone = Arc::clone(&stderr_collector);
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let mut coll = stderr_coll_clone.lock().await;
                        coll.push(&buf[..n]);
                    }
                    Err(_) => break,
                }
            }
        });

        // Task 3: Stdout reader task with strict LF JSONL framing
        // Notice: NO mutex is held across blocking stdout read!
        // Notice: Stdout EOF does NOT emit a competing status; the reaper task is the sole terminal authority.
        let is_alive = Arc::new(AtomicBool::new(true));
        let is_alive_stdout = Arc::clone(&is_alive);
        let is_alive_monitor = Arc::clone(&is_alive);
        let is_alive_session = Arc::clone(&is_alive);
        let cwd_buf = cwd.to_path_buf();
        let cwd_stdout = cwd_buf.clone();
        let cwd_monitor = cwd_buf.clone();

        let pending_resp_clone = Arc::clone(&pending_responses);
        let app_handle_clone = app_handle.clone();
        let stdin_tx_clone = stdin_tx.clone();

        tokio::spawn(async move {
            let mut frame_buf = JsonlFrameBuffer::new();
            let mut read_chunk = [0u8; 8192];

            loop {
                if !is_alive_stdout.load(Ordering::SeqCst) {
                    break;
                }

                let read_res = stdout.read(&mut read_chunk).await;
                match read_res {
                    Ok(0) => {
                        // EOF on stdout: child closed output. Break loop without emitting competing
                        // status. The reaper task authoritatively handles terminal status.
                        break;
                    }
                    Ok(n) => {
                        if !is_alive_stdout.load(Ordering::SeqCst) {
                            break;
                        }
                        match frame_buf.push_bytes(&read_chunk[..n]) {
                            Ok(lines) => {
                                for line in lines {
                                    if !is_alive_stdout.load(Ordering::SeqCst) {
                                        break;
                                    }
                                    handle_rpc_line(
                                        &line,
                                        &pending_resp_clone,
                                        &stdin_tx_clone,
                                        &app_handle_clone,
                                        &cwd_stdout,
                                    )
                                    .await;
                                }
                            }
                            Err(framing_err) => {
                                let _ = app_handle_clone.emit(
                                    "pi://error",
                                    serde_json::json!({
                                        "error": framing_err,
                                        "cwd": cwd_stdout.to_string_lossy(),
                                    }),
                                );
                                break;
                            }
                        }
                    }
                    Err(read_err) => {
                        let _ = app_handle_clone.emit(
                            "pi://error",
                            serde_json::json!({
                                "error": format!("Stdout read error: {read_err}"),
                                "cwd": cwd_stdout.to_string_lossy(),
                            }),
                        );
                        break;
                    }
                }
            }
        });

        // Task 4: Child reaper & monitor task
        // Serves as the single terminal authority per generation to avoid competing status emissions.
        let (abort_kill_tx, abort_kill_rx) = oneshot::channel::<()>();
        let (reap_done_tx, reap_done_rx) = oneshot::channel::<()>();
        let app_handle_monitor = app_handle.clone();
        let pending_resp_monitor = Arc::clone(&pending_responses);
        let terminal_emitted = Arc::new(AtomicBool::new(false));
        let terminal_emitted_clone = Arc::clone(&terminal_emitted);

        tokio::spawn(async move {
            tokio::select! {
                _ = abort_kill_rx => {
                    is_alive_monitor.store(false, Ordering::SeqCst);
                    remove_session_paths(&cwd_monitor, generation);
                    // Explicit abort/disconnect requested
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    let _ = reap_done_tx.send(());
                    // Explicit disconnect handles its own user notification
                }
                exit_status = child.wait() => {
                    is_alive_monitor.store(false, Ordering::SeqCst);
                    remove_session_paths(&cwd_monitor, generation);
                    let _ = reap_done_tx.send(());

                    // Spontaneous exit: Sole terminal authority for this session
                    if !terminal_emitted_clone.swap(true, Ordering::SeqCst)
                    {
                        let (is_clean_exit, exit_desc) = match &exit_status {
                            Ok(st) => {
                                if st.success() {
                                    (true, "exited normally".to_string())
                                } else {
                                    (false, format!("exited with {st}"))
                                }
                            }
                            Err(e) => (false, format!("wait error: {e}")),
                        };

                        let (state, label, detail) = if is_clean_exit {
                            (
                                "disconnected".to_string(),
                                "Disconnected".to_string(),
                                "Pi RPC process terminated cleanly".to_string(),
                            )
                        } else {
                            // Safe generic exit status without leaking raw stderr diagnostics to UI
                            (
                                "error".to_string(),
                                "Process Exited".to_string(),
                                format!("Pi RPC process terminated unexpectedly ({exit_desc})"),
                            )
                        };

                        let _ = app_handle_monitor.emit(
                            "pi://status-change",
                            StatusChangePayload {
                                state,
                                label,
                                detail,
                                model: None,
                                cwd: Some(cwd_monitor.to_string_lossy().into_owned()),
                            },
                        );

                        // Clear any pending requests with an error
                        let mut pend = pending_resp_monitor.lock().await;
                        for (_, sender) in pend.drain() {
                            let _ = sender.send(serde_json::json!({
                                "type": "response",
                                "success": false,
                                "error": format!("Child process terminated unexpectedly ({exit_desc})")
                            }));
                        }
                    }
                }
            }
        });

        // Initial Handshake: send get_state with timeout and cancellation support
        let handshake_id = format!("handshake-{}", REQ_COUNTER.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        {
            let mut pend = pending_responses.lock().await;
            pend.insert(handshake_id.clone(), tx);
        }

        let get_state_cmd = serde_json::json!({
            "id": handshake_id,
            "type": "get_state"
        });

        if let Err(_) = stdin_tx.send(get_state_cmd.to_string()).await {
            let mut pend = pending_responses.lock().await;
            pend.remove(&handshake_id);
            let _ = abort_kill_tx.send(());
            return Err("Failed to write get_state command to child stdin".to_string());
        }

        let response_value = tokio::select! {
            _ = &mut cancel_rx => {
                let mut pend = pending_responses.lock().await;
                pend.remove(&handshake_id);
                let _ = abort_kill_tx.send(());
                return Err("Connection cancelled while waiting for handshake".to_string());
            }
            handshake_result = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx) => {
                match handshake_result {
                    Ok(Ok(val)) => val,
                    Ok(Err(_)) => {
                        let mut pend = pending_responses.lock().await;
                        pend.remove(&handshake_id);
                        let _ = abort_kill_tx.send(());
                        return Err("Connection handshake failed: response channel closed before get_state reply".to_string());
                    }
                    Err(_) => {
                        let mut pend = pending_responses.lock().await;
                        pend.remove(&handshake_id);
                        let _ = abort_kill_tx.send(());
                        return Err("Connection handshake timed out waiting for get_state response (15s)".to_string());
                    }
                }
            }
        };

        let is_success = response_value
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !is_success {
            let _ = abort_kill_tx.send(());
            let err_msg = response_value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("get_state returned success: false");
            return Err(format!("Handshake failed from Pi RPC: {err_msg}"));
        }

        // Verify generation has not been superseded
        if current_generation.load(Ordering::SeqCst) != generation {
            let _ = abort_kill_tx.send(());
            return Err("Connection superseded by a newer operation".to_string());
        }

        let data = response_value.get("data");
        let model_info = data
            .and_then(|d| d.get("model"))
            .cloned()
            .unwrap_or(Value::Null);

        let session_id = data
            .and_then(|d| d.get("sessionId"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());

        let session_file_returned = data
            .and_then(|d| d.get("sessionFile"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());

        let message_count = data
            .and_then(|d| d.get("messageCount"))
            .and_then(|c| c.as_u64())
            .unwrap_or(0);

        let mut initial_messages: Vec<Value> = Vec::new();

        // If Pi reports historical messages in this session, hydrate them via get_messages.
        // Fail closed: a historical session must NEVER connect with empty messages if hydration
        // fails due to timeout, transport error, or malformed shape.
        if message_count > 0 {
            let msg_req_id = format!("init-msgs-{}", REQ_COUNTER.fetch_add(1, Ordering::SeqCst));
            let (msg_tx, msg_rx) = oneshot::channel();
            {
                let mut pend = pending_responses.lock().await;
                pend.insert(msg_req_id.clone(), msg_tx);
            }

            let get_msgs_cmd = serde_json::json!({
                "id": msg_req_id,
                "type": "get_messages"
            });

            if let Err(_) = stdin_tx.send(get_msgs_cmd.to_string()).await {
                let mut pend = pending_responses.lock().await;
                pend.remove(&msg_req_id);
                let _ = abort_kill_tx.send(());
                return Err("Failed to send get_messages command to child stdin".to_string());
            }

            let msgs_val = tokio::select! {
                _ = &mut cancel_rx => {
                    let mut pend = pending_responses.lock().await;
                    pend.remove(&msg_req_id);
                    let _ = abort_kill_tx.send(());
                    return Err("Connection cancelled while waiting for message hydration".to_string());
                }
                msg_res = tokio::time::timeout(HANDSHAKE_TIMEOUT, msg_rx) => {
                    match msg_res {
                        Ok(Ok(val)) => val,
                        Ok(Err(_)) => {
                            let mut pend = pending_responses.lock().await;
                            pend.remove(&msg_req_id);
                            let _ = abort_kill_tx.send(());
                            return Err("Message hydration failed: response channel closed unexpectedly".to_string());
                        }
                        Err(_) => {
                            let mut pend = pending_responses.lock().await;
                            pend.remove(&msg_req_id);
                            let _ = abort_kill_tx.send(());
                            return Err("Timeout waiting for message hydration from Pi RPC (15s)".to_string());
                        }
                    }
                }
            };

            let msgs_success = msgs_val
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !msgs_success {
                let _ = abort_kill_tx.send(());
                let err_msg = msgs_val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("get_messages returned success: false");
                return Err(format!("Message hydration failed from Pi RPC: {err_msg}"));
            }

            let msgs_arr = match msgs_val
                .get("data")
                .and_then(|d| d.get("messages"))
                .and_then(|m| m.as_array())
            {
                Some(arr) => arr,
                None => {
                    let _ = abort_kill_tx.send(());
                    return Err(
                        "Message hydration failed: response missing valid data.messages array"
                            .to_string(),
                    );
                }
            };

            initial_messages = msgs_arr.clone();
        }

        // Handshake succeeded: notify frontend
        let _ = app_handle.emit(
            "pi://status-change",
            StatusChangePayload {
                state: "connected".to_string(),
                label: "Connected".to_string(),
                detail: "Pi RPC session active (persisted chat mode)".to_string(),
                model: Some(model_info.clone()),
                cwd: Some(cwd.to_string_lossy().into_owned()),
            },
        );

        let session = Self {
            child_pid,
            generation,
            cwd: cwd.to_path_buf(),
            stdin_tx,
            pending_responses,
            stderr_collector,
            abort_kill_tx: Arc::new(Mutex::new(Some(abort_kill_tx))),
            child_reap_rx: Arc::new(Mutex::new(Some(reap_done_rx))),
            current_session_id: Arc::new(Mutex::new(session_id.clone())),
            current_session_file: Arc::new(Mutex::new(session_file_returned.clone())),
            is_alive: is_alive_session,
        };

        // Retain canonical validated Node executable and Pi entrypoint for this session
        record_session_paths(cwd, node_path, entrypoint, generation);

        Ok((
            session,
            model_info,
            session_id,
            session_file_returned,
            message_count,
            initial_messages,
        ))
    }

    /// Terminate and await graceful reap of child process with bounded timeout
    pub async fn terminate_and_reap(&self) {
        self.is_alive.store(false, Ordering::SeqCst);
        remove_session_paths(&self.cwd, self.generation);
        let kill_tx = {
            let mut guard = self.abort_kill_tx.lock().await;
            guard.take()
        };
        if let Some(tx) = kill_tx {
            let _ = tx.send(());
        }

        let reap_rx = {
            let mut guard = self.child_reap_rx.lock().await;
            guard.take()
        };
        if let Some(rx) = reap_rx {
            let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
        }

        let mut pend = self.pending_responses.lock().await;
        for (_, sender) in pend.drain() {
            let _ = sender.send(serde_json::json!({
                "type": "response",
                "success": false,
                "error": "Session terminated"
            }));
        }
    }

    /// Explicitly disconnect and terminate the child process cleanly
    pub async fn disconnect(&self) {
        self.terminate_and_reap().await;
    }

    /// Whether this session's child process is alive and active
    pub fn is_alive(&self) -> bool {
        self.is_alive.load(Ordering::SeqCst)
    }

    /// Query current model, session ID, session file, and messages from this active session
    pub async fn fetch_state_and_messages(
        &self,
    ) -> Result<(Value, Option<String>, Option<String>, Vec<Value>), String> {
        let req_id = format!("get-state-{}", REQ_COUNTER.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        {
            let mut pend = self.pending_responses.lock().await;
            pend.insert(req_id.clone(), tx);
        }
        let get_state_cmd = serde_json::json!({
            "id": req_id,
            "type": "get_state"
        });
        if self.stdin_tx.send(get_state_cmd.to_string()).await.is_err() {
            let mut pend = self.pending_responses.lock().await;
            pend.remove(&req_id);
            return Err("Failed to send get_state to Pi RPC".to_string());
        }
        let state_val = match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(val)) => val,
            _ => {
                let mut pend = self.pending_responses.lock().await;
                pend.remove(&req_id);
                return Err("Timeout waiting for get_state response".to_string());
            }
        };
        let model_info = state_val
            .get("data")
            .and_then(|d| d.get("model"))
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let session_id = state_val
            .get("data")
            .and_then(|d| d.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let session_file = state_val
            .get("data")
            .and_then(|d| d.get("sessionFile"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let msg_req_id = format!("get-msgs-{}", REQ_COUNTER.fetch_add(1, Ordering::SeqCst));
        let (tx_m, rx_m) = oneshot::channel();
        {
            let mut pend = self.pending_responses.lock().await;
            pend.insert(msg_req_id.clone(), tx_m);
        }
        let get_msgs_cmd = serde_json::json!({
            "id": msg_req_id,
            "type": "get_messages"
        });
        if self.stdin_tx.send(get_msgs_cmd.to_string()).await.is_err() {
            let mut pend = self.pending_responses.lock().await;
            pend.remove(&msg_req_id);
            return Err("Failed to send get_messages to Pi RPC".to_string());
        }
        let msgs_val = match tokio::time::timeout(Duration::from_secs(10), rx_m).await {
            Ok(Ok(val)) => val,
            _ => {
                let mut pend = self.pending_responses.lock().await;
                pend.remove(&msg_req_id);
                return Err("Timeout waiting for get_messages response".to_string());
            }
        };
        let messages = msgs_val
            .get("data")
            .and_then(|d| d.get("messages"))
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();

        Ok((model_info, session_id, session_file, messages))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExtensionUiAction {
    ForwardDialog { req_id: String },
    CancelDialog { req_id: String },
    FireAndForget,
    Ignored,
}

pub fn decide_extension_ui_action(value: &Value) -> ExtensionUiAction {
    let req_id = match value.get("id").and_then(|v| v.as_str()) {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => return ExtensionUiAction::Ignored,
    };
    let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");

    if matches!(
        method,
        "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"
    ) {
        ExtensionUiAction::FireAndForget
    } else if matches!(method, "select" | "input" | "confirm") {
        // Forward supported interactive dialogs to frontend instead of auto-cancelling
        ExtensionUiAction::ForwardDialog { req_id }
    } else {
        // editor and any unknown methods continue to be auto-cancelled to avoid hangs
        ExtensionUiAction::CancelDialog { req_id }
    }
}

/// Process a single incoming JSON line from Pi RPC stdout
async fn handle_rpc_line<R: tauri::Runtime>(
    line: &str,
    pending_responses: &Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    stdin_tx: &mpsc::Sender<String>,
    app_handle: &tauri::AppHandle<R>,
    cwd: &Path,
) {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        // Emit malformed frame error for bounded diagnostics
        let _ = app_handle.emit(
            "pi://error",
            serde_json::json!({
                "error": format!("Malformed JSON line from Pi: {line}"),
                "cwd": cwd.to_string_lossy(),
            }),
        );
        return;
    };

    if let Value::Object(ref mut map) = value {
        map.insert("cwd".to_string(), Value::String(cwd.to_string_lossy().into_owned()));
    }

    let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // 1. Correlate command responses
    if msg_type == "response" {
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            let mut pend = pending_responses.lock().await;
            if let Some(sender) = pend.remove(id) {
                let _ = sender.send(value.clone());
            }
        }
    }

    // 2. Extension UI dialog requests (forward supported dialogs, cancel unsupported to prevent hangs, allow fire-and-forget)
    if msg_type == "extension_ui_request" {
        match decide_extension_ui_action(&value) {
            ExtensionUiAction::CancelDialog { req_id } => {
                let cancel_response = serde_json::json!({
                    "type": "extension_ui_response",
                    "id": req_id,
                    "cancelled": true
                });
                let _ = stdin_tx.send(cancel_response.to_string()).await;
            }
            ExtensionUiAction::ForwardDialog { .. }
            | ExtensionUiAction::FireAndForget
            | ExtensionUiAction::Ignored => {}
        }
    }

    // 3. Emit all RPC events to frontend with cwd attached
    let _ = app_handle.emit("pi://event", value);
}

/// Validate that a client-provided prompt request ID is bounded, non-empty,
/// and belongs to the accepted client namespace ("prompt-*").
pub fn validate_prompt_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Prompt request ID cannot be empty".to_string());
    }
    if id != trimmed {
        return Err("Prompt request ID cannot contain leading or trailing whitespace".to_string());
    }
    if id.len() > MAX_PROMPT_ID_CHARS {
        return Err(format!(
            "Prompt request ID exceeds maximum limit of {MAX_PROMPT_ID_CHARS} characters"
        ));
    }
    if !id.starts_with(PROMPT_ID_PREFIX) || id.len() <= PROMPT_ID_PREFIX.len() {
        return Err(format!(
            "Prompt request ID must start with prefix '{PROMPT_ID_PREFIX}' followed by a non-empty identifier"
        ));
    }
    // Reject invalid characters: ensure safe ASCII alphanumeric, hyphen, or underscore
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Prompt request ID contains invalid characters (allowed: ASCII alphanumeric, '-', '_')".to_string());
    }
    Ok(())
}

/// Generate next unique internal command request ID (e.g. handshake, abort)
pub fn next_request_id(prefix: &str) -> String {
    format!("{prefix}-{}", REQ_COUNTER.fetch_add(1, Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stderr_collector_bounds_and_decoding() {
        let mut collector = StderrCollector::new(10);
        assert!(collector.is_empty());

        collector.push(b"hello");
        assert_eq!(collector.len(), 5);
        assert_eq!(collector.get_lossy_excerpt(), "hello");

        // Exceed max_bytes -> ring buffer drops oldest
        collector.push(b" world!!");
        assert_eq!(collector.len(), 10);
        assert_eq!(collector.get_lossy_excerpt(), "lo world!!");
    }

    #[test]
    fn test_stderr_collector_lossy_utf8() {
        let mut collector = StderrCollector::new(20);
        // Invalid UTF-8 byte
        collector.push(&[0xff, 0xfe, b'a', b'b']);
        let excerpt = collector.get_lossy_excerpt();
        assert!(excerpt.contains("ab"));
    }

    #[test]
    fn test_next_request_id_uniqueness() {
        let id1 = next_request_id("abort");
        let id2 = next_request_id("abort");
        assert_ne!(id1, id2);
        assert!(id1.starts_with("abort-"));
        assert!(id2.starts_with("abort-"));
    }

    #[test]
    fn test_validate_prompt_id_valid() {
        assert!(validate_prompt_id("prompt-123e4567-e89b-12d3-a456-426614174000").is_ok());
        assert!(validate_prompt_id("prompt-custom_id-123").is_ok());
    }

    #[test]
    fn test_validate_prompt_id_empty_and_whitespace() {
        assert!(validate_prompt_id("").is_err());
        assert!(validate_prompt_id("   ").is_err());
        assert!(validate_prompt_id(" prompt-123").is_err());
        assert!(validate_prompt_id("prompt-123 ").is_err());
    }

    #[test]
    fn test_validate_prompt_id_namespace_prefix() {
        assert!(validate_prompt_id("internal-123").is_err());
        assert!(validate_prompt_id("abort-1").is_err());
        assert!(validate_prompt_id("handshake-1").is_err());
        assert!(validate_prompt_id("prompt-").is_err());
    }

    #[test]
    fn test_validate_prompt_id_length_limit() {
        let long_id = format!("prompt-{}", "a".repeat(MAX_PROMPT_ID_CHARS));
        assert!(validate_prompt_id(&long_id).is_err());
    }

    #[test]
    fn test_validate_prompt_id_invalid_characters() {
        assert!(validate_prompt_id("prompt-test\n123").is_err());
        assert!(validate_prompt_id("prompt-test;drop").is_err());
        assert!(validate_prompt_id("prompt-test/slash").is_err());
        assert!(validate_prompt_id("prompt-test space").is_err());
    }

    #[test]
    fn test_validate_paths_empty_inputs() {
        assert!(validate_paths("", "C:\\pi\\cli.js", "C:\\dir").is_err());
        assert!(validate_paths("node", "", "C:\\dir").is_err());
        assert!(validate_paths("node", "C:\\pi\\cli.js", "").is_err());
    }

    #[test]
    fn test_validate_paths_non_absolute_entrypoint() {
        assert!(validate_paths("node", "relative/cli.js", ".").is_err());
    }

    #[test]
    fn test_validate_paths_invalid_extension() {
        assert!(validate_paths("node", "C:\\pi\\cli.py", ".").is_err());
    }

    #[test]
    fn test_dunce_canonicalize_strips_verbatim_prefix() {
        let current = std::env::current_dir().unwrap();
        let canonical = dunce::canonicalize(&current).unwrap();
        let s = canonical.to_str().unwrap();
        assert!(
            !s.starts_with(r"\\?\"),
            "Canonical path must not retain verbatim UNC prefix (\\?\\): {s}"
        );
    }

    #[test]
    fn test_hydration_fail_closed_validation() {
        // 1. success: false must be rejected
        let failure_resp = serde_json::json!({
            "type": "response",
            "command": "get_messages",
            "success": false,
            "error": "Session storage read error"
        });
        let is_success = failure_resp
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        assert!(!is_success);

        // 2. Malformed shape (messages not an array) must be rejected
        let malformed_resp = serde_json::json!({
            "type": "response",
            "command": "get_messages",
            "success": true,
            "data": {
                "messages": "not an array"
            }
        });
        let msgs_arr = malformed_resp
            .get("data")
            .and_then(|d| d.get("messages"))
            .and_then(|m| m.as_array());
        assert!(msgs_arr.is_none());

        // 3. Missing data field must be rejected
        let missing_data_resp = serde_json::json!({
            "type": "response",
            "command": "get_messages",
            "success": true
        });
        let msgs_arr2 = missing_data_resp
            .get("data")
            .and_then(|d| d.get("messages"))
            .and_then(|m| m.as_array());
        assert!(msgs_arr2.is_none());

        // 4. Valid historical messages must parse correctly
        let valid_resp = serde_json::json!({
            "type": "response",
            "command": "get_messages",
            "success": true,
            "data": {
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}
                ]
            }
        });
        let valid_arr = valid_resp
            .get("data")
            .and_then(|d| d.get("messages"))
            .and_then(|m| m.as_array())
            .unwrap();
        assert_eq!(valid_arr.len(), 2);
    }

    #[tokio::test]
    async fn test_pending_response_timeout_cleanup() {
        // Verify that on timeout, the pending responses map removes the request ID
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let req_id = "test-msg-req-123".to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pend = pending.lock().await;
            pend.insert(req_id.clone(), tx);
        }

        // Simulate timeout
        let res = tokio::time::timeout(Duration::from_millis(10), rx).await;
        assert!(res.is_err(), "Expected timeout");

        // Clean up pending entry
        {
            let mut pend = pending.lock().await;
            pend.remove(&req_id);
        }

        {
            let pend = pending.lock().await;
            assert!(!pend.contains_key(&req_id));
        }
    }

    #[test]
    fn test_build_pi_args_unrestricted_wrapper() {
        let entrypoint = Path::new("/mock/path/cli.js");

        // Without session
        let args = build_pi_args(entrypoint, None);
        let args_str: Vec<String> = args
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert_eq!(args_str[0], "/mock/path/cli.js");
        assert!(args_str.contains(&"--mode".to_string()));
        assert!(args_str.contains(&"rpc".to_string()));
        assert!(args_str.contains(&"--approve".to_string()));

        // Crucial: unrestricted direct wrapper must NOT include guards, tool policies, or restriction flags
        assert!(!args_str.contains(&"--no-extensions".to_string()));
        assert!(!args_str.contains(&"--no-skills".to_string()));
        assert!(!args_str.contains(&"--no-prompt-templates".to_string()));
        assert!(!args_str.contains(&"--no-context-files".to_string()));
        assert!(!args_str.contains(&"--no-approve".to_string()));
        assert!(!args_str.contains(&"--tools".to_string()));
        assert!(!args_str.contains(&"--exclude-tools".to_string()));
        assert!(!args_str.contains(&"-e".to_string()));
        assert!(!args_str.contains(&"--session".to_string()));

        // With session
        let session = Path::new("/home/user/.pi/session.json");
        let args_with_session = build_pi_args(entrypoint, Some(session));
        let args_session_str: Vec<String> = args_with_session
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert_eq!(args_session_str[0], "/mock/path/cli.js");
        assert!(args_session_str.contains(&"--mode".to_string()));
        assert!(args_session_str.contains(&"rpc".to_string()));
        assert!(args_session_str.contains(&"--approve".to_string()));

        let s_idx = args_session_str
            .iter()
            .position(|s| s == "--session")
            .expect("--session must be present");
        assert_eq!(args_session_str[s_idx + 1], "/home/user/.pi/session.json");

        assert!(!args_session_str.contains(&"--no-extensions".to_string()));
        assert!(!args_session_str.contains(&"--no-skills".to_string()));
        assert!(!args_session_str.contains(&"--no-prompt-templates".to_string()));
        assert!(!args_session_str.contains(&"--no-context-files".to_string()));
        assert!(!args_session_str.contains(&"--no-approve".to_string()));
        assert!(!args_session_str.contains(&"--tools".to_string()));
        assert!(!args_session_str.contains(&"--exclude-tools".to_string()));
        assert!(!args_session_str.contains(&"-e".to_string()));
    }

    #[test]
    fn test_is_gentle_shell_entrypoint() {
        // Supported extensions: .js, .mjs, .cjs (case-insensitive)
        assert!(is_gentle_shell_entrypoint(Path::new("/usr/local/bin/gentle-shell.js")));
        assert!(is_gentle_shell_entrypoint(Path::new("/usr/local/bin/gentle-shell.mjs")));
        assert!(is_gentle_shell_entrypoint(Path::new("/usr/local/bin/gentle-shell.cjs")));
        assert!(is_gentle_shell_entrypoint(Path::new("C:\\tools\\GENTLE-SHELL.JS")));
        assert!(is_gentle_shell_entrypoint(Path::new("C:\\tools\\Gentle-Shell.MJS")));
        assert!(is_gentle_shell_entrypoint(Path::new("gentle-shell.cjs")));

        // Non-gentle-shell entrypoints must return false
        assert!(!is_gentle_shell_entrypoint(Path::new("/usr/local/bin/cli.js")));
        assert!(!is_gentle_shell_entrypoint(Path::new("/usr/local/bin/pi.js")));
        assert!(!is_gentle_shell_entrypoint(Path::new("/usr/local/bin/not-gentle-shell.js")));
        assert!(!is_gentle_shell_entrypoint(Path::new("/usr/local/bin/gentle-shell.ts")));
        assert!(!is_gentle_shell_entrypoint(Path::new("/usr/local/bin/gentle-shell.js.bak")));
        assert!(!is_gentle_shell_entrypoint(Path::new("")));
    }

    #[test]
    fn test_decide_extension_ui_action() {
        // 1. Supported interactive dialog methods (select, input, confirm) -> ForwardDialog
        let supported_dialog_methods = ["select", "input", "confirm"];
        for method in supported_dialog_methods {
            let val = serde_json::json!({
                "id": format!("req-dialog-{method}"),
                "method": method,
                "title": "Some Dialog Title",
            });
            assert_eq!(
                decide_extension_ui_action(&val),
                ExtensionUiAction::ForwardDialog {
                    req_id: format!("req-dialog-{method}")
                },
                "Method {method} should resolve to ForwardDialog"
            );
        }

        // 2. Unsupported dialog methods (editor, unknown_method) -> CancelDialog
        let unsupported_dialog_methods = ["editor", "unknown_method", "custom_dialog"];
        for method in unsupported_dialog_methods {
            let val = serde_json::json!({
                "id": format!("req-unsupported-{method}"),
                "method": method,
                "title": "Some Dialog Title",
            });
            assert_eq!(
                decide_extension_ui_action(&val),
                ExtensionUiAction::CancelDialog {
                    req_id: format!("req-unsupported-{method}")
                },
                "Method {method} should resolve to CancelDialog"
            );
        }

        // 3. Fire-and-forget methods (notify, setStatus, setWidget, setTitle, set_editor_text) -> FireAndForget
        let faf_methods = [
            "notify",
            "setStatus",
            "setWidget",
            "setTitle",
            "set_editor_text",
        ];
        for method in faf_methods {
            let val = serde_json::json!({
                "id": format!("req-faf-{method}"),
                "method": method,
                "title": "Status Update",
                "message": "Working..."
            });
            assert_eq!(
                decide_extension_ui_action(&val),
                ExtensionUiAction::FireAndForget,
                "Method {method} should resolve to FireAndForget"
            );
        }

        // 4. Missing or empty id -> Ignored
        let missing_id = serde_json::json!({
            "method": "confirm",
            "title": "Some confirmation"
        });
        assert_eq!(
            decide_extension_ui_action(&missing_id),
            ExtensionUiAction::Ignored
        );

        let empty_id = serde_json::json!({
            "id": "",
            "method": "select",
            "title": "Choose an option"
        });
        assert_eq!(
            decide_extension_ui_action(&empty_id),
            ExtensionUiAction::Ignored
        );

        let whitespace_id = serde_json::json!({
            "id": "   ",
            "method": "notify",
            "message": "Notification"
        });
        assert_eq!(
            decide_extension_ui_action(&whitespace_id),
            ExtensionUiAction::Ignored
        );

        let non_string_id = serde_json::json!({
            "id": 12345,
            "method": "setStatus",
            "message": "Status"
        });
        assert_eq!(
            decide_extension_ui_action(&non_string_id),
            ExtensionUiAction::Ignored
        );
    }

    #[test]
    fn test_session_execution_paths_registry_and_active_session_methods() {
        let cwd = dunce::canonicalize(".").unwrap();
        let node = PathBuf::from("node");
        let entry = cwd.join("fake-entry.js");

        record_session_paths(&cwd, &node, &entry, 42);
        let paths = get_session_paths(&cwd, 42).expect("Paths should be recorded");
        assert_eq!(paths.node_path, node);
        assert_eq!(paths.entrypoint, entry);
        assert_eq!(paths.generation, 42);

        // Mismatched generation returns None (no generation==0 bypass)
        assert!(get_session_paths(&cwd, 0).is_none());
        assert!(get_session_paths(&cwd, 99).is_none());

        // Mismatched generation removal does not delete
        remove_session_paths(&cwd, 99);
        assert!(get_session_paths(&cwd, 42).is_some());

        // Matching generation removal deletes
        remove_session_paths(&cwd, 42);
        assert!(get_session_paths(&cwd, 42).is_none());
    }
}
