//! External URL validation and opening, and native directory selection.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::oneshot;

/// Maximum permitted length for external URL strings (2 KB)
pub const MAX_EXTERNAL_URL_LENGTH: usize = 2048;

/// Default timeout for external URL handler execution
pub const OPEN_URL_TIMEOUT: Duration = Duration::from_secs(5);

/// State of external URL opener execution in coordinator
pub const OPENER_STATE_QUEUED: u8 = 0;
pub const OPENER_STATE_CLAIMED: u8 = 1;
pub const OPENER_STATE_CANCELLED: u8 = 2;

/// Secondary timeout if execution was already claimed when initial timeout expired
pub const CLAIMED_COMPLETION_TIMEOUT: Duration = Duration::from_secs(5);

/// Validates an external URL against defense-in-depth security policy:
/// - Bounded length (<= 2048 characters)
/// - Rejects control characters and whitespace
/// - Parses URL case-insensitively via `url::Url`
/// - Permitted schemes strictly limited to `http`, `https`, and `mailto`
/// - Rejects user credentials (username/password) to ensure visible destination
/// - For http/https: requires valid non-empty host
/// - For mailto: rejects query parameters and fragments (header injection prevention);
///   requires non-empty simple recipient email address(es)
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    if raw.len() > MAX_EXTERNAL_URL_LENGTH {
        return Err(format!(
            "URL length ({} bytes) exceeds maximum limit of {} bytes",
            raw.len(),
            MAX_EXTERNAL_URL_LENGTH
        ));
    }
    // Control characters anywhere in the input (newlines, tabs, null bytes) are strictly rejected
    if raw.chars().any(|c| c.is_control()) {
        return Err("URL contains control characters".to_string());
    }

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty or whitespace only".to_string());
    }
    // Whitespace inside URL is disallowed
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("URL contains whitespace".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("file:")
        || lower.starts_with("tauri:")
        || lower.starts_with("vbscript:")
    {
        return Err("URL scheme is forbidden".to_string());
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|e| format!("Malformed URL: {}", e))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" && scheme != "mailto" {
        return Err(format!(
            "Disallowed scheme '{}': only http, https, and mailto are allowed",
            scheme
        ));
    }

    // User credentials (username / password) are strictly forbidden to prevent destination spoofing
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs containing user credentials (username/password) are disallowed".to_string());
    }

    if scheme == "http" || scheme == "https" {
        if parsed.cannot_be_a_base() {
            return Err("HTTP/HTTPS URL cannot be base-less".to_string());
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| "HTTP/HTTPS URL must have a valid host".to_string())?;
        if host.trim().is_empty() {
            return Err("HTTP/HTTPS URL host cannot be empty".to_string());
        }
    } else if scheme == "mailto" {
        if parsed.query().is_some() {
            return Err("Mailto headers or query parameters are not permitted".to_string());
        }
        if parsed.fragment().is_some() {
            return Err("Mailto fragments are not permitted".to_string());
        }
        let path = parsed.path().trim();
        if path.is_empty() {
            return Err("Mailto URL requires a recipient".to_string());
        }
        // Reject percent-encoded recipient content entirely for MVP
        if path.contains('%') {
            return Err("Mailto recipient containing percent-encoded characters is not permitted".to_string());
        }
        // Simple one-recipient policy: reject commas / multiple recipients
        if path.contains(',') {
            return Err("Multiple recipients are not permitted in mailto URLs".to_string());
        }
        let recipient = path;
        let (local, domain) = recipient.split_once('@').ok_or_else(|| {
            format!("Mailto recipient '{}' missing '@'", recipient)
        })?;
        if local.is_empty() || domain.is_empty() {
            return Err(format!("Invalid mailto recipient format '{}'", recipient));
        }
        if local.contains('@') || domain.contains('@') {
            return Err(format!("Invalid mailto recipient format '{}'", recipient));
        }
        if recipient.chars().any(|c| {
            c.is_ascii_whitespace()
                || c.is_ascii_control()
                || matches!(
                    c,
                    '%' | ',' | '/' | '\\' | '?' | '#' | '"' | '\'' | '<' | '>' | ':' | ';' | '[' | ']' | '{' | '}' | '|' | '`' | '^'
                )
        }) {
            return Err(format!("Mailto recipient '{}' contains invalid characters", recipient));
        }
        if domain.starts_with('.') || domain.ends_with('.') || !domain.contains('.') {
            return Err(format!("Mailto recipient domain '{}' is invalid", domain));
        }
        if domain.split('.').any(|label| label.is_empty()) {
            return Err(format!("Mailto recipient domain '{}' has empty label", domain));
        }
    }

    Ok(parsed.to_string())
}

/// Pure coordinator for external URL opening:
/// 1. Validates the external URL against the strict defense-in-depth policy
/// 2. Creates a bounded oneshot channel and shared atomic state (QUEUED / CLAIMED / CANCELLED)
/// 3. Hands the opener execution closure to the scheduler (e.g. main thread dispatcher)
/// 4. Enforces mutual exclusion: exactly one of main closure or timeout cancellation claims execution
/// 5. If main closure claims before timeout, awaits result with secondary fail-safe without false-negative timeout
/// 6. Awaits the result on Tokio with bounded timeout, returning sanitized actionable errors
///    on validation failure, scheduling failure, opener failure, channel disconnect, or timeout.
pub async fn coordinate_open_url<S, O>(
    url: &str,
    timeout: Duration,
    scheduler: S,
    opener: O,
) -> Result<(), String>
where
    S: FnOnce(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String>,
    O: FnOnce(&str) -> Result<(), String> + Send + 'static,
{
    let validated = validate_external_url(url)?;
    let (tx, rx) = oneshot::channel();
    let validated_target = validated.clone();

    let state = Arc::new(AtomicU8::new(OPENER_STATE_QUEUED));
    let state_for_task = Arc::clone(&state);

    let scheduled_task = Box::new(move || {
        // Atomically claim execution: QUEUED -> CLAIMED
        if state_for_task
            .compare_exchange(
                OPENER_STATE_QUEUED,
                OPENER_STATE_CLAIMED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            // Execution claimed before cancellation. Invoke opener!
            let res = opener(&validated_target);
            let _ = tx.send(res);
        }
        // If state was already CANCELLED, closure aborts without calling opener!
    });

    if let Err(e) = scheduler(scheduled_task) {
        state.store(OPENER_STATE_CANCELLED, Ordering::SeqCst);
        return Err(format!("Failed to schedule URL open on main thread: {}", e));
    }

    tokio::pin!(rx);

    match tokio::time::timeout(timeout, &mut rx).await {
        Ok(Ok(open_res)) => open_res,
        Ok(Err(_)) => {
            let _ = state.compare_exchange(
                OPENER_STATE_QUEUED,
                OPENER_STATE_CANCELLED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            Err("Open URL channel closed before completion".to_string())
        }
        Err(_) => {
            // Initial timeout expired!
            // Attempt to cancel: QUEUED -> CANCELLED
            match state.compare_exchange(
                OPENER_STATE_QUEUED,
                OPENER_STATE_CANCELLED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    // Successfully cancelled! Closure will never invoke opener.
                    let timeout_str = if timeout.as_millis() < 1000 {
                        format!("{}ms", timeout.as_millis())
                    } else {
                        format!("{}s", timeout.as_secs())
                    };
                    Err(format!(
                        "Timeout waiting for external handler to open URL ({})",
                        timeout_str
                    ))
                }
                Err(_) => {
                    // State was already CLAIMED! The main closure claimed execution just before timeout.
                    // Await real result with secondary completion fail-safe.
                    match tokio::time::timeout(CLAIMED_COMPLETION_TIMEOUT, &mut rx).await {
                        Ok(Ok(open_res)) => open_res,
                        Ok(Err(_)) => Err("Open URL channel closed before completion".to_string()),
                        Err(_) => Err(
                            "Timeout waiting for external handler completion after execution was claimed".to_string(),
                        ),
                    }
                }
            }
        }
    }
}

/// Open a validated external URL in the system default external application handler.
///
/// Bounded to http, https, and mailto schemes with strict host/recipient validation.
/// Dispatches the official Tauri opener plugin onto the main thread via `run_on_main_thread`
/// and awaits the result on Tokio worker with a bounded oneshot channel and timeout,
/// ensuring the main thread is never blocked waiting on itself.
#[tauri::command]
pub async fn open_external_url(
    url: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    let app = app_handle.clone();
    let scheduler = move |task: Box<dyn FnOnce() + Send + 'static>| {
        app_handle
            .run_on_main_thread(move || {
                task();
            })
            .map_err(|e| format!("Failed to schedule URL open on main thread: {}", e))
    };

    let opener = move |target: &str| {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(target, None::<&str>)
            .map_err(|e| format!("Failed to open URL in default external handler: {}", e))
    };

    coordinate_open_url(&url, OPEN_URL_TIMEOUT, scheduler, opener).await
}

/// Injectable opener executor for unit testing validation and handler invocation without OS side effects.
pub fn open_external_url_with_opener<F>(
    url: &str,
    opener: F,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let validated = validate_external_url(url)?;
    opener(&validated)
}

/// Prompt the user to pick a project directory via the native OS file dialog.
///
/// Runs the file dialog on a dedicated blocking thread via `tokio::task::spawn_blocking`.
/// If `default_path` is given and non-empty, sets the initial directory on the dialog.
/// If a folder is picked, canonicalizes it with `dunce` and returns `Ok(Some(path_str))`.
/// If the user cancels, returns `Ok(None)`.
/// If the blocking task join fails, returns an honest error string.
#[tauri::command]
pub async fn pick_directory(default_path: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Select Project Directory");
        if let Some(ref dp) = default_path {
            let trimmed = dp.trim();
            if !trimmed.is_empty() {
                dialog = dialog.set_directory(trimmed);
            }
        }
        let picked = dialog.pick_folder();
        picked.map(|p| {
            let canonical = dunce::canonicalize(&p).unwrap_or(p);
            canonical.to_string_lossy().to_string()
        })
    })
    .await
    .map_err(|e| format!("Failed to run file dialog: {e}"))
}

/// Helper to format and canonicalize a picked folder path using dunce.
pub fn format_picked_directory(path: PathBuf) -> String {
    let canonical = dunce::canonicalize(&path).unwrap_or(path);
    canonical.to_string_lossy().to_string()
}

/// Mockable runner for pick_directory logic used in unit tests without invoking OS file dialogs.
pub async fn pick_directory_with_dialog<F>(
    default_path: Option<String>,
    dialog_fn: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(Option<PathBuf>) -> Option<PathBuf> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let initial_dir = default_path
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);

        let picked = dialog_fn(initial_dir);
        picked.map(format_picked_directory)
    })
    .await
    .map_err(|e| format!("Failed to run file dialog: {e}"))
}

/// Payload for browsing filesystem directories
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseFilesystemPayload {
    pub path: Option<String>,
}

/// A directory folder item in browse result
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseFolderItem {
    pub name: String,
    pub full_path: String,
    pub windows_path: Option<String>,
}

/// A shortcut entry in browse result
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseShortcutItem {
    pub name: String,
    pub path: String,
    pub windows_path: Option<String>,
}

/// Result returned from browse_filesystem
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseFilesystemResult {
    pub current_path: String,
    pub windows_path: Option<String>,
    pub parent_path: Option<String>,
    pub folders: Vec<BrowseFolderItem>,
    pub shortcuts: Vec<BrowseShortcutItem>,
    pub error: Option<String>,
}

/// Resolves user home directory from USERPROFILE or HOME environment variables.
pub fn get_user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Builds dynamic desktop shortcuts: workspace cwd, user home, and platform roots/drives.
pub fn get_desktop_shortcuts(home: Option<&PathBuf>) -> Vec<BrowseShortcutItem> {
    let mut shortcuts = Vec::new();

    // 1. Current working directory
    if let Ok(cwd) = std::env::current_dir() {
        let canonical_cwd = dunce::canonicalize(&cwd).unwrap_or(cwd);
        let cwd_str = canonical_cwd.to_string_lossy().to_string();
        let name = canonical_cwd
            .file_name()
            .map(|n| format!("Workspace ({})", n.to_string_lossy()))
            .unwrap_or_else(|| "Workspace".to_string());
        shortcuts.push(BrowseShortcutItem {
            name,
            path: cwd_str.clone(),
            windows_path: if cfg!(windows) { Some(cwd_str) } else { None },
        });
    }

    // 2. User Home
    if let Some(h) = home {
        let canonical_home = dunce::canonicalize(h).unwrap_or_else(|_| h.clone());
        let home_str = canonical_home.to_string_lossy().to_string();
        shortcuts.push(BrowseShortcutItem {
            name: "Home".to_string(),
            path: home_str.clone(),
            windows_path: if cfg!(windows) { Some(home_str) } else { None },
        });
    }

    // 3. Platform-specific: Drives on Windows, Root on POSIX
    if cfg!(windows) {
        for letter in b'C'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            let path = PathBuf::from(&root);
            if path.exists() {
                shortcuts.push(BrowseShortcutItem {
                    name: format!("Drive ({root})"),
                    path: root.clone(),
                    windows_path: Some(root),
                });
            }
        }
    } else {
        shortcuts.push(BrowseShortcutItem {
            name: "Root (/)".to_string(),
            path: "/".to_string(),
            windows_path: None,
        });
    }

    shortcuts
}

/// Core filesystem browser logic with path resolution and folder listing.
pub fn browse_filesystem_internal(requested_path: Option<String>) -> BrowseFilesystemResult {
    let home = get_user_home_dir();
    let shortcuts = get_desktop_shortcuts(home.as_ref());

    let target_path = match requested_path {
        Some(ref p) if !p.trim().is_empty() => {
            let trimmed = p.trim();
            if trimmed == "~" {
                home.clone().unwrap_or_else(|| PathBuf::from("."))
            } else if trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
                if let Some(ref h) = home {
                    h.join(&trimmed[2..])
                } else {
                    PathBuf::from(trimmed)
                }
            } else {
                PathBuf::from(trimmed)
            }
        }
        _ => std::env::current_dir()
            .ok()
            .or_else(|| home.clone())
            .unwrap_or_else(|| PathBuf::from(".")),
    };

    let dir = if target_path.exists() {
        if target_path.is_file() {
            target_path.parent().map(|p| p.to_path_buf()).unwrap_or(target_path)
        } else {
            target_path
        }
    } else if let Some(ref h) = home {
        if h.exists() {
            h.clone()
        } else {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };

    let canonical_dir = dunce::canonicalize(&dir).unwrap_or(dir);
    let current_path_str = canonical_dir.to_string_lossy().to_string();

    let parent_path = canonical_dir.parent().map(|p| {
        let canon = dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        canon.to_string_lossy().to_string()
    });

    let windows_path = if cfg!(windows) {
        Some(current_path_str.clone())
    } else {
        None
    };

    let mut folders = Vec::new();
    let mut read_error = None;

    match std::fs::read_dir(&canonical_dir) {
        Ok(read_dir) => {
            for entry_res in read_dir {
                if let Ok(entry) = entry_res {
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if file_name.starts_with('.') && file_name != ".gentle-ai" {
                        continue;
                    }
                    if file_name == "node_modules"
                        || file_name == "target"
                        || file_name == "dist"
                        || file_name == ".git"
                    {
                        continue;
                    }

                    if let Ok(file_type) = entry.file_type() {
                        if file_type.is_dir() {
                            let full_path = entry.path();
                            let canon_entry = dunce::canonicalize(&full_path).unwrap_or(full_path);
                            let full_path_str = canon_entry.to_string_lossy().to_string();

                            folders.push(BrowseFolderItem {
                                name: file_name,
                                full_path: full_path_str.clone(),
                                windows_path: if cfg!(windows) {
                                    Some(full_path_str)
                                } else {
                                    None
                                },
                            });
                        }
                    }
                }
            }
            folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        }
        Err(err) => {
            read_error = Some(format!("Failed to read directory: {err}"));
        }
    }

    BrowseFilesystemResult {
        current_path: current_path_str,
        windows_path,
        parent_path,
        folders,
        shortcuts,
        error: read_error,
    }
}

/// Browse filesystem directories and subfolders with shortcut resolution for folder picker modal.
#[tauri::command]
pub async fn browse_filesystem(
    payload: Option<BrowseFilesystemPayload>,
) -> Result<BrowseFilesystemResult, String> {
    tokio::task::spawn_blocking(move || {
        let requested = payload.and_then(|p| p.path);
        browse_filesystem_internal(requested)
    })
    .await
    .map_err(|e| format!("Failed to browse filesystem: {e}"))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_external_url_safe_schemes() {
        // Valid http
        let res = validate_external_url("http://example.com/path?query=1#frag");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), "http://example.com/path?query=1#frag");

        // Valid https
        let res = validate_external_url("https://gentle.ai/docs/intro");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), "https://gentle.ai/docs/intro");

        // Case-insensitivity normalization
        let res = validate_external_url("HTTPS://GENTLE.AI/DOCS");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), "https://gentle.ai/DOCS");

        // Valid mailto
        let res = validate_external_url("mailto:dev@gentle.ai");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), "mailto:dev@gentle.ai");

        // Standard percent-encoded path/query in http/https is preserved and allowed
        let res = validate_external_url("https://example.com/path%20encoded?foo=bar#frag");
        assert!(res.is_ok());

        // Ports and IPv6 allowed for http/https
        assert!(validate_external_url("http://localhost:3000/api").is_ok());
        assert!(validate_external_url("http://[::1]:8080/test").is_ok());
    }

    #[test]
    fn test_validate_external_url_rejected_schemes() {
        let forbidden = [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "file://C:/Windows/System32/calc.exe",
            "tauri://localhost",
            "vbscript:msgbox",
            "custom-app://action",
            "ssh://user@host",
            "ftp://ftp.example.com",
            "tel:+1234567890",
        ];
        for url in forbidden {
            let res = validate_external_url(url);
            assert!(res.is_err(), "Expected {} to be rejected", url);
        }
    }

    #[test]
    fn test_validate_external_url_credentials_rejected() {
        let cred_urls = [
            "http://user:pass@example.com",
            "https://user@example.com",
            "https://admin:secret@sub.domain.org/path",
            "http://foo:bar@legit.com@phishing.com",
        ];
        for url in cred_urls {
            let res = validate_external_url(url);
            assert!(res.is_err(), "Expected credentials in {} to be rejected", url);
            assert!(res.unwrap_err().contains("user credentials"));
        }
    }

    #[test]
    fn test_validate_external_url_control_chars_and_whitespace() {
        let bad_urls = [
            "https://example.com/path\n",
            "https://example.com/path\r\n",
            "https://example.com/\0",
            "https://example.com/with space",
            "https://example.com/\tpath",
        ];
        for url in bad_urls {
            let res = validate_external_url(url);
            assert!(res.is_err(), "Expected control/whitespace in {} to be rejected", url);
        }
    }

    #[test]
    fn test_validate_external_url_mailto_policy() {
        // Mailto with query parameters / headers must be rejected
        let res = validate_external_url("mailto:user@example.com?subject=Hello");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("query parameters"));

        // Mailto with fragment must be rejected
        let res = validate_external_url("mailto:user@example.com#frag");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fragments"));

        // Empty recipient
        let res = validate_external_url("mailto:");
        assert!(res.is_err());

        // Malformed recipient missing @
        let res = validate_external_url("mailto:notanemail");
        assert!(res.is_err());

        // Missing domain
        let res = validate_external_url("mailto:user@");
        assert!(res.is_err());

        // Missing local part
        let res = validate_external_url("mailto:@domain.com");
        assert!(res.is_err());

        // Invalid domain (no dot)
        let res = validate_external_url("mailto:user@domain");
        assert!(res.is_err());

        // Recipient containing illegal characters
        let res = validate_external_url("mailto:user\"evil\"@domain.com");
        assert!(res.is_err());

        // Multiple recipients rejected (single recipient policy)
        let res = validate_external_url("mailto:alice@example.com,bob@domain.org");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Multiple recipients"));

        // Percent-encoded recipient content strictly rejected
        let res_crlf = validate_external_url("mailto:user%0d%0a@example.com");
        assert!(res_crlf.is_err());
        assert!(res_crlf.unwrap_err().contains("percent-encoded"));

        let res_space = validate_external_url("mailto:user%20name@example.com");
        assert!(res_space.is_err());
        assert!(res_space.unwrap_err().contains("percent-encoded"));

        let res_at = validate_external_url("mailto:user%40example.com");
        assert!(res_at.is_err());
        assert!(res_at.unwrap_err().contains("percent-encoded"));

        let res_punct = validate_external_url("mailto:user%2ename@example.com");
        assert!(res_punct.is_err());
        assert!(res_punct.unwrap_err().contains("percent-encoded"));
    }

    #[test]
    fn test_validate_external_url_bounds_and_relative() {
        // Empty
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("   ").is_err());

        // Too long (> 2048 chars)
        let long_url = format!("https://example.com/{}", "a".repeat(2048));
        let long_res = validate_external_url(&long_url);
        assert!(long_res.is_err());
        assert!(long_res.unwrap_err().contains("bytes"));

        // Relative paths
        assert!(validate_external_url("/local/file").is_err());
        assert!(validate_external_url("index.html").is_err());
        assert!(validate_external_url("../parent").is_err());
        assert!(validate_external_url("//protocol-relative.com").is_err());

        // Missing host
        assert!(validate_external_url("http://").is_err());
        assert!(validate_external_url("https://").is_err());
    }

    #[test]
    fn test_open_external_url_mockable_invokes_opener_only_when_valid() {
        let mut called = false;
        let mut target_url = String::new();

        let res = open_external_url_with_opener("https://gentle.ai", |v| {
            called = true;
            target_url = v.to_string();
            Ok(())
        });

        assert!(res.is_ok());
        assert!(called);
        assert_eq!(target_url, "https://gentle.ai/");

        // Disallowed scheme must NOT invoke opener callback
        let mut bad_called = false;
        let bad_res = open_external_url_with_opener("javascript:alert(1)", |_| {
            bad_called = true;
            Ok(())
        });
        assert!(bad_res.is_err());
        assert!(!bad_called);
    }

    #[tokio::test]
    async fn test_coordinate_open_url_success() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let opener_invoked = Arc::new(AtomicBool::new(false));
        let invoked_clone = opener_invoked.clone();

        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_secs(1),
            |task| {
                // Simulates main thread running the scheduled task
                task();
                Ok(())
            },
            move |validated| {
                assert_eq!(validated, "https://gentle.ai/");
                invoked_clone.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(res.is_ok());
        assert!(opener_invoked.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_coordinate_open_url_callback_failure() {
        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_secs(1),
            |task| {
                task();
                Ok(())
            },
            |_validated| Err("Failed to launch OS browser: 404".to_string()),
        )
        .await;

        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err(),
            "Failed to launch OS browser: 404"
        );
    }

    #[tokio::test]
    async fn test_coordinate_open_url_scheduling_failure() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let opener_invoked = Arc::new(AtomicBool::new(false));
        let invoked_clone = opener_invoked.clone();

        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_secs(1),
            |_task| Err("Main event loop is terminated".to_string()),
            move |_validated| {
                invoked_clone.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("Failed to schedule URL open on main thread: Main event loop is terminated"));
        assert!(!opener_invoked.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_coordinate_open_url_timeout_before_closure_opener_never_runs() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let opener_invoked = Arc::new(AtomicBool::new(false));
        let opener_clone = opener_invoked.clone();

        let (task_tx, task_rx) = oneshot::channel::<Box<dyn FnOnce() + Send + 'static>>();

        // Coordinator runs with a very short timeout of 20ms
        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_millis(20),
            move |task| {
                // Task is queued but NOT run before coordinator times out
                let _ = task_tx.send(task);
                Ok(())
            },
            move |_validated| {
                opener_clone.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("Timeout waiting for external handler to open URL"));
        assert!(!opener_invoked.load(Ordering::SeqCst));

        // Now simulate main thread eventually executing the queued task after timeout
        let queued_task = task_rx.await.expect("Task was sent to scheduler");
        queued_task();

        // Atomically verified: opener must NEVER be invoked after cancellation
        assert!(
            !opener_invoked.load(Ordering::SeqCst),
            "Opener must NEVER be called after timeout has cancelled execution"
        );
    }

    #[tokio::test]
    async fn test_coordinate_open_url_closure_claims_before_timeout_returns_real_result() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let opener_invoked = Arc::new(AtomicBool::new(false));
        let opener_clone = opener_invoked.clone();

        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_millis(20),
            |task| {
                // Task starts and claims immediately, but opener takes 40ms to simulate slow OS call
                tokio::spawn(async move {
                    task();
                });
                Ok(())
            },
            move |validated| {
                assert_eq!(validated, "https://gentle.ai/");
                opener_clone.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(40));
                Ok(())
            },
        )
        .await;

        // Since closure claimed before timeout, coordinator waited for generous completion and got real result
        assert!(res.is_ok(), "Expected success once claimed, got: {:?}", res);
        assert!(opener_invoked.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_coordinate_open_url_retry_no_duplicate() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let opener_calls = Arc::new(AtomicUsize::new(0));

        // Attempt 1: times out while queued
        let (task1_tx, task1_rx) = oneshot::channel::<Box<dyn FnOnce() + Send + 'static>>();
        let calls_clone1 = opener_calls.clone();

        let res1 = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_millis(15),
            move |task| {
                let _ = task1_tx.send(task);
                Ok(())
            },
            move |_| {
                calls_clone1.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(res1.is_err());
        assert_eq!(opener_calls.load(Ordering::SeqCst), 0);

        // Attempt 2 (retry): succeeds immediately
        let calls_clone2 = opener_calls.clone();
        let res2 = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_secs(1),
            |task| {
                task();
                Ok(())
            },
            move |_| {
                calls_clone2.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(res2.is_ok());
        assert_eq!(opener_calls.load(Ordering::SeqCst), 1);

        // Now attempt 1's delayed task runs on the main thread queue
        let delayed_task1 = task1_rx.await.unwrap();
        delayed_task1();

        // Must STILL be exactly 1 call (no duplicate invocation from delayed task 1)
        assert_eq!(
            opener_calls.load(Ordering::SeqCst),
            1,
            "Delayed task must not produce a duplicate open after retry"
        );
    }

    #[tokio::test]
    async fn test_coordinate_open_url_receiver_timeout() {
        let (_task_holder_tx, _task_holder_rx) = oneshot::channel();
        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_millis(30),
            |task| {
                // Retain task so sender is not dropped immediately, triggering actual timeout
                let _ = _task_holder_tx.send(task);
                Ok(())
            },
            |_validated| Ok(()),
        )
        .await;

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("Timeout waiting for external handler to open URL"));
        assert!(err.contains("30ms"));
    }

    #[tokio::test]
    async fn test_coordinate_open_url_receiver_disconnect() {
        let res = coordinate_open_url(
            "https://gentle.ai",
            Duration::from_secs(1),
            |task| {
                // Task is dropped without executing (e.g. main thread worker panicked or abandoned closure)
                drop(task);
                Ok(())
            },
            |_validated| Ok(()),
        )
        .await;

        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err(),
            "Open URL channel closed before completion"
        );
    }

    #[tokio::test]
    async fn test_coordinate_open_url_validation_rejection_prevents_scheduling() {
        let mut scheduler_called = false;
        let res = coordinate_open_url(
            "javascript:alert(1)",
            Duration::from_secs(1),
            |_task| {
                scheduler_called = true;
                Ok(())
            },
            |_validated| Ok(()),
        )
        .await;

        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "URL scheme is forbidden");
        assert!(!scheduler_called, "Scheduler must not be called for invalid URL");
    }


    #[tokio::test]
    async fn test_pick_directory_mock_cancel() {
        let res = pick_directory_with_dialog(None, |_| None).await;
        assert_eq!(res, Ok(None));

        let res_with_path = pick_directory_with_dialog(Some("C:\\test".to_string()), |_| None).await;
        assert_eq!(res_with_path, Ok(None));
    }

    #[tokio::test]
    async fn test_pick_directory_mock_success_and_canonicalization() {
        struct TempDirGuard {
            path: PathBuf,
        }
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }

        let temp_root = std::env::temp_dir().join(format!(
            "test_pick_dir_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();
        let _guard = TempDirGuard {
            path: temp_root.clone(),
        };

        let temp_dir_clone = temp_root.clone();
        let res = pick_directory_with_dialog(None, move |_| Some(temp_dir_clone)).await;
        assert!(res.is_ok());
        let picked_str = res.unwrap().expect("Should return path");
        let expected = dunce::canonicalize(&temp_root).unwrap().to_string_lossy().to_string();
        assert_eq!(picked_str, expected);
    }

    #[tokio::test]
    async fn test_pick_directory_mock_default_path_trimming() {
        // Empty string should yield None as initial dir
        let res_empty = pick_directory_with_dialog(Some("   ".to_string()), |init| {
            assert!(init.is_none());
            None
        })
        .await;
        assert_eq!(res_empty, Ok(None));

        // Non-empty string should yield Some(PathBuf)
        let res_non_empty = pick_directory_with_dialog(Some("  some/path  ".to_string()), |init| {
            assert_eq!(init, Some(PathBuf::from("some/path")));
            None
        })
        .await;
        assert_eq!(res_non_empty, Ok(None));
    }

    #[tokio::test]
    async fn test_pick_directory_mock_panic_returns_honest_error() {
        let res = pick_directory_with_dialog(None, |_| {
            panic!("Simulated dialog thread panic");
        })
        .await;

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("Failed to run file dialog"));
    }

    #[test]
    fn test_browse_filesystem_empty_path_returns_valid_result() {
        let res = browse_filesystem_internal(None);
        assert!(!res.current_path.is_empty());
        assert!(!res.shortcuts.is_empty());
        assert!(res.error.is_none());
    }

    #[test]
    fn test_browse_filesystem_discovers_subfolders_and_filters_ignored() {
        struct TempDirGuard {
            path: PathBuf,
        }
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }

        let temp_root = std::env::temp_dir().join(format!(
            "test_browse_fs_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();
        let _guard = TempDirGuard {
            path: temp_root.clone(),
        };

        // Create allowed directories
        std::fs::create_dir_all(temp_root.join("alpha")).unwrap();
        std::fs::create_dir_all(temp_root.join("beta")).unwrap();
        std::fs::create_dir_all(temp_root.join(".gentle-ai")).unwrap();

        // Create ignored directories
        std::fs::create_dir_all(temp_root.join("node_modules")).unwrap();
        std::fs::create_dir_all(temp_root.join(".git")).unwrap();
        std::fs::create_dir_all(temp_root.join(".hidden")).unwrap();

        // Create a regular file (should not be listed in folders)
        std::fs::write(temp_root.join("file.txt"), "hello").unwrap();

        let res = browse_filesystem_internal(Some(temp_root.to_string_lossy().to_string()));
        assert!(res.error.is_none());

        let folder_names: Vec<String> = res.folders.into_iter().map(|f| f.name).collect();
        assert!(folder_names.contains(&"alpha".to_string()));
        assert!(folder_names.contains(&"beta".to_string()));
        assert!(folder_names.contains(&".gentle-ai".to_string()));

        assert!(!folder_names.contains(&"node_modules".to_string()));
        assert!(!folder_names.contains(&".git".to_string()));
        assert!(!folder_names.contains(&".hidden".to_string()));
        assert!(!folder_names.contains(&"file.txt".to_string()));
    }

}
