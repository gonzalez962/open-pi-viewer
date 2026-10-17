//! Built-in Pi OAuth backend commands and process lifecycle host.
//!
//! Spawns and coordinates an isolated, bounded Node.js helper (`pi-oauth-helper.mjs`)
//! tied to Pi's installed SDK entrypoint and effective home.
//!
//! Security invariants:
//! - Credentials, access tokens, and refresh tokens are managed by Pi SDK in `auth.json`.
//! - Secrets and tokens are NEVER exposed to the frontend / WebView.
//! - Frontend cannot supply arbitrary shell commands, executables, or arbitrary provider names.
//! - Events and prompts strictly project allowlisted fields; provider raw JSON is never forwarded.
//! - Processes are bounded with timeouts and guaranteed termination on cancellation and app exit.
//! - Single-login concurrent policy prevents conflicting in-flight authentication operations.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::commands::config_files::{resolve_gentle_shell_homes, resolve_user_home};
use crate::commands::AppState;
use crate::framing::JsonlFrameBuffer;
use crate::process::{validate_paths, ActiveSession, StderrCollector, MAX_STDERR_BYTES};

/// Maximum execution timeout for short-lived commands (list, logout)
pub const OAUTH_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// Global timeout for interactive login flow (10 minutes)
pub const OAUTH_LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
/// Grace period for child termination after cancellation signal
pub const OAUTH_KILL_GRACE_PERIOD: Duration = Duration::from_millis(500);
/// Maximum single line frame size in bytes (64 KB) to prevent unbounded memory allocation
pub const MAX_OAUTH_FRAME_BYTES: usize = 64 * 1024;

/// Built-in Pi OAuth provider IDs supported by Pi 0.86.1 SDK
pub const KNOWN_BUILTIN_OAUTH_PROVIDERS: &[&str] = &[
    "anthropic",
    "github-copilot",
    "kimi-coding",
    "meta",
    "openai-codex",
    "openrouter",
    "radius",
    "xai",
];

/// Status of a built-in Pi OAuth provider
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinOAuthProviderStatus {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_label: Option<String>,
    pub is_subscription: bool,
    pub configured: bool,
    #[serde(rename = "hasStoredOAuth")]
    pub has_stored_oauth: bool,
    #[serde(rename = "oauthReady")]
    pub oauth_ready: bool,
    #[serde(rename = "ambientApiKey")]
    pub ambient_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub status: String,
}

/// Allowlisted safe auth events emitted to frontend
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OAuthSafeEvent {
    AuthUrl {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
    },
    DeviceCode {
        #[serde(rename = "userCode")]
        user_code: String,
        #[serde(rename = "verificationUri")]
        verification_uri: String,
        #[serde(rename = "intervalSeconds", skip_serializing_if = "Option::is_none")]
        interval_seconds: Option<u64>,
        #[serde(rename = "expiresInSeconds", skip_serializing_if = "Option::is_none")]
        expires_in_seconds: Option<u64>,
    },
    Progress {
        message: String,
    },
    Info {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        links: Option<Vec<OAuthSafeInfoLink>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSafeInfoLink {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSafePromptOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSafePrompt {
    pub prompt_id: String,
    pub prompt_type: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<OAuthSafePromptOption>>,
}

/// Sink trait to abstract event emitting for production Tauri and unit test isolation
pub trait OAuthEventSink: Send + Sync + 'static {
    fn emit_event(&self, provider_id: &str, kind: &str, data: Value);
    fn emit_status(&self, provider_id: &str, state: &str, message: Option<&str>, error: Option<&str>);
    fn open_url(&self, url: &str);
}

pub struct TauriOAuthEventSink {
    pub app_handle: AppHandle,
}

impl OAuthEventSink for TauriOAuthEventSink {
    fn emit_event(&self, provider_id: &str, kind: &str, data: Value) {
        let _ = self.app_handle.emit(
            "pi://oauth-event",
            serde_json::json!({
                "providerId": provider_id,
                "kind": kind,
                "data": data,
            }),
        );
    }

    fn emit_status(&self, provider_id: &str, state: &str, message: Option<&str>, error: Option<&str>) {
        let mut payload = serde_json::json!({
            "providerId": provider_id,
            "state": state,
        });
        if let Some(msg) = message {
            payload["message"] = Value::String(msg.to_string());
        }
        if let Some(err) = error {
            payload["error"] = Value::String(err.to_string());
        }
        let _ = self.app_handle.emit("pi://oauth-status", payload);
    }

    fn open_url(&self, url: &str) {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    }
}

/// Payload for querying built-in OAuth providers
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GetBuiltinOAuthProvidersPayload {}

/// Payload for starting an OAuth login
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartOAuthLoginPayload {
    pub provider_id: String,
}

/// Result returned from `start_oauth_login`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartOAuthLoginResult {
    pub started: bool,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload for cancelling an active OAuth login
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelOAuthLoginPayload {
    pub provider_id: Option<String>,
}

/// Result returned from `cancel_oauth_login`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelOAuthLoginResult {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload for responding to an OAuth prompt
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendOAuthPromptResponsePayload {
    pub prompt_id: String,
    pub response: String,
}

/// Result returned from `send_oauth_prompt_response`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendOAuthPromptResponseResult {
    pub sent: bool,
}

/// Payload for logging out of an OAuth provider
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogoutOAuthProviderPayload {
    pub provider_id: String,
}

/// Allowlisted safe catalog model metadata projected to frontend
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinCatalogModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<String>>,
    #[serde(rename = "input_modalities", skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(rename = "reasoningEfforts", skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
    #[serde(rename = "thinkingLevelMap", skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<HashMap<String, Option<String>>>,
}

/// Payload for querying built-in provider model catalog
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GetBuiltinCatalogPayload {
    #[serde(alias = "providerId", alias = "provider_id", alias = "provider")]
    pub provider_id: String,
}

/// Result returned from `logout_oauth_provider`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogoutOAuthProviderResult {
    pub success: bool,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

static NEXT_OAUTH_SESSION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn next_oauth_session_id() -> u64 {
    NEXT_OAUTH_SESSION_ID.fetch_add(1, Ordering::Relaxed)
}

/// State of an active OAuth login process
#[derive(Clone)]
pub struct ActiveOAuthSession {
    pub session_id: u64,
    pub provider_id: String,
    pub effective_home: PathBuf,
    pub child_pid: Option<u32>,
    pub stdin_tx: mpsc::Sender<String>,
    pub cancel_tx: Arc<tokio::sync::Mutex<Option<oneshot::Sender<()>>>>,
    pub is_alive: Arc<AtomicBool>,
    pub terminal_emitted: Arc<AtomicBool>,
}

impl ActiveOAuthSession {
    pub async fn cancel_and_terminate(&mut self) -> bool {
        if !self.is_alive.swap(false, Ordering::SeqCst) {
            return false;
        }
        let mut guard = self.cancel_tx.lock().await;
        if let Some(cancel_tx) = guard.take() {
            let _ = cancel_tx.send(());
        }
        let _ = self.stdin_tx.send("{\"type\":\"cancel\"}\n".to_string()).await;
        true
    }
}

/// Validate and sanitize provider-supplied URLs.
/// Enforces http/https schemes, forbids control chars/whitespace/credentials,
/// and scrubs token-exposing query parameters and fragments so WebView never sees raw tokens.
pub fn validate_oauth_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    if trimmed.len() > 2048 {
        return Err("URL exceeds maximum length of 2048 characters".to_string());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("URL contains control characters".to_string());
    }
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("URL contains whitespace".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("Disallowed URL scheme: only http and https are permitted".to_string());
    }

    let mut parsed = url::Url::parse(trimmed)
        .map_err(|e| format!("Malformed URL: {e}"))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Disallowed URL scheme '{scheme}'"));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs containing user credentials are not allowed".to_string());
    }

    if parsed.host_str().map_or(true, |h| h.trim().is_empty()) {
        return Err("URL must have a valid host".to_string());
    }

    // Scrub token-exposing query parameters
    let sensitive_keys = [
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
        "secret",
        "token",
        "code_verifier",
        "api_key",
        "apikey",
        "auth_token",
        "user_token",
        "session_token",
        "password",
    ];

    let has_sensitive_query = parsed.query_pairs().any(|(k, _)| {
        let k_lower = k.to_ascii_lowercase();
        sensitive_keys.iter().any(|&s| k_lower == s)
    });

    if has_sensitive_query {
        let cleaned_pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| {
                let k_lower = k.to_ascii_lowercase();
                if sensitive_keys.iter().any(|&s| k_lower == s) {
                    (k.to_string(), "REDACTED".to_string())
                } else {
                    (k.to_string(), v.to_string())
                }
            })
            .collect();
        parsed.query_pairs_mut().clear().extend_pairs(cleaned_pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }

    // Strip fragment if it contains sensitive tokens
    if let Some(fragment) = parsed.fragment() {
        let has_sensitive_frag = fragment.split('&').any(|pair| {
            let key = pair.split('=').next().unwrap_or("").trim().to_ascii_lowercase();
            sensitive_keys.iter().any(|&s| key == s)
        });
        if has_sensitive_frag {
            parsed.set_fragment(None);
        }
    }

    Ok(parsed.to_string())
}

/// Sanitize text to prevent leaking tokens or unsafe HTML/control text to WebView
pub fn sanitize_oauth_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // 1. Filter out control characters except standard whitespace
    let mut cleaned: String = trimmed
        .chars()
        .filter(|&c| !c.is_control() || c == '\n' || c == '\r' || c == '\t')
        .collect();

    // 2. Strip HTML tags to prevent XSS / markup injection in WebView
    while let Some(open) = cleaned.find('<') {
        if let Some(close) = cleaned[open..].find('>') {
            let end = open + close + 1;
            cleaned.replace_range(open..end, "");
        } else {
            break;
        }
    }

    // 3. Redact Bearer tokens, JWTs, API keys, and secret values
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    let mut redacted_words: Vec<String> = Vec::with_capacity(words.len());

    let mut i = 0;
    while i < words.len() {
        let word = words[i];
        let lower = word.to_ascii_lowercase();

        // Check "Bearer <token>"
        if (lower == "bearer" || lower == "bearer:") && i + 1 < words.len() {
            redacted_words.push(word.to_string());
            redacted_words.push("[REDACTED]".to_string());
            i += 2;
            continue;
        }

        // Check key-value assignments: access_token=..., token:..., secret=...
        let sensitive_prefixes = [
            "access_token",
            "refresh_token",
            "id_token",
            "client_secret",
            "secret",
            "token",
            "api_key",
            "password",
        ];

        let mut matched_kv = false;
        for pref in sensitive_prefixes {
            if lower.starts_with(pref) {
                if let Some(eq_pos) = word.find('=') {
                    if eq_pos <= pref.len() + 2 {
                        let key_part = &word[..=eq_pos];
                        redacted_words.push(format!("{key_part}[REDACTED]"));
                        matched_kv = true;
                        break;
                    }
                } else if let Some(col_pos) = word.find(':') {
                    if col_pos <= pref.len() + 2 {
                        let key_part = &word[..=col_pos];
                        redacted_words.push(format!("{key_part}[REDACTED]"));
                        matched_kv = true;
                        break;
                    }
                }
            }
        }
        if matched_kv {
            i += 1;
            continue;
        }

        // Check token prefixes: ghp_, gho_, github_pat_, sk-, xox[baprs]-
        if lower.starts_with("ghp_")
            || lower.starts_with("gho_")
            || lower.starts_with("github_pat_")
            || lower.starts_with("sk-")
            || lower.starts_with("xoxb-")
            || lower.starts_with("xoxp-")
            || lower.starts_with("xoxa-")
            || lower.starts_with("xoxr-")
        {
            redacted_words.push("[REDACTED]".to_string());
            i += 1;
            continue;
        }

        // Check JWT token: 3 segments separated by dots, starting with ey
        if lower.starts_with("ey") && word.split('.').count() == 3 {
            let segments: Vec<&str> = word.split('.').collect();
            if segments.iter().all(|s| s.len() >= 6) {
                redacted_words.push("[REDACTED]".to_string());
                i += 1;
                continue;
            }
        }

        // Check long high-entropy tokens (>= 32 chars of alphanumeric / - / _ containing digits and letters)
        if word.len() >= 32
            && word.chars().any(|c| c.is_ascii_digit())
            && word.chars().any(|c| c.is_ascii_alphabetic())
            && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !word.contains("http://")
            && !word.contains("https://")
        {
            redacted_words.push("[REDACTED]".to_string());
            i += 1;
            continue;
        }

        redacted_words.push(word.to_string());
        i += 1;
    }

    let mut result = redacted_words.join(" ");
    if result.len() > 500 {
        result.truncate(500);
    }
    result
}

/// Helper to strip leading and trailing punctuation delimiters (quotes, parens, brackets, colons).
pub fn strip_path_delimiters(s: &str) -> (&str, &str, &str) {
    let bytes = s.as_bytes();
    let mut start = 0;
    while start < bytes.len() && matches!(bytes[start], b'\'' | b'"' | b'(' | b'[' | b'{' | b'<' | b'`') {
        start += 1;
    }
    let mut end = bytes.len();
    while end > start && matches!(bytes[end - 1], b'\'' | b'"' | b')' | b']' | b'}' | b'>' | b'`' | b',' | b';' | b':') {
        end -= 1;
    }
    (&s[..start], &s[start..end], &s[end..])
}

/// Strip trailing line and column numbers like `:12:34` or `:12` from file path candidates.
pub fn strip_line_col_suffix(s: &str) -> &str {
    let mut cur = s;
    for _ in 0..2 {
        if let Some(colon_pos) = cur.rfind(':') {
            let suffix = &cur[colon_pos + 1..];
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
                cur = &cur[..colon_pos];
            } else {
                break;
            }
        } else {
            break;
        }
    }
    cur
}

/// Check if a candidate string looks like an absolute filesystem path.
/// Matches Windows drive-letter paths (C:\..., d:/...), Windows UNC paths (\\server\..., \\?\...),
/// and Unix absolute paths (/Users/..., /home/..., /tmp/..., etc.).
/// Excludes web URLs (http://, https://).
pub fn is_absolute_path(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("mailto:")
    {
        return false;
    }
    let bytes = trimmed.as_bytes();
    // Windows drive-letter path: e.g. C:\... or C:/...
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // Windows UNC / verbatim path: \\server\share or \\?\...
    if bytes.len() >= 3 && bytes[0] == b'\\' && bytes[1] == b'\\' {
        return true;
    }
    // Unix absolute path: starts with /
    if bytes[0] == b'/' && bytes.len() >= 2 {
        if trimmed[1..].contains('/') {
            return true;
        }
        let known_roots = [
            "/home", "/Users", "/usr", "/etc", "/var", "/tmp", "/private", "/opt", "/bin", "/lib",
        ];
        if known_roots.iter().any(|&root| trimmed.starts_with(root)) {
            return true;
        }
    }
    false
}

/// Detect lines that are part of a stack trace or source location dump rather than actionable error text.
pub fn is_stack_trace_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    // V8 / Node / Python stack frames
    if trimmed.starts_with("at ") || trimmed == "at" || trimmed.starts_with("at\t") {
        return true;
    }
    // Node.js require stack header
    if trimmed.eq_ignore_ascii_case("require stack:")
        || trimmed.to_ascii_lowercase().starts_with("require stack:")
    {
        return true;
    }
    // Require stack list items: "- /path/to/file.js"
    if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
        let item = trimmed[2..].trim();
        let (_pre, inner, _suf) = strip_path_delimiters(item);
        let cleaned = strip_line_col_suffix(inner);
        if is_absolute_path(cleaned) {
            return true;
        }
    }
    // Caret pointer lines: "^", "   ^"
    if trimmed.chars().all(|c| c == '^' || c == '~' || c == ' ') {
        return true;
    }
    // Node internals frame header
    if trimmed.starts_with("(node:") || trimmed.starts_with("node:internal") {
        return true;
    }
    // Standalone file location lines printed before unhandled exceptions:
    // e.g. "/Users/alice/app.js:10" or "C:\Users\alice\app.js:10:20"
    let (_pre, inner, _suf) = strip_path_delimiters(trimmed);
    let stripped = strip_line_col_suffix(inner);
    if is_absolute_path(stripped) && (inner != stripped || !trimmed.contains(' ')) {
        return true;
    }

    false
}

/// Redact absolute filesystem paths from an error string.
/// Protects Unix absolute paths, Windows absolute paths, UNC paths, and paths in quotes/parentheses.
pub fn redact_absolute_paths(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    // Pass 1: redact quoted and parenthesized absolute paths
    let mut pass1 = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\'' || ch == '"' || ch == '`' {
            let quote = ch;
            let mut inner = String::new();
            let mut closed = false;
            while let Some(&next_ch) = chars.peek() {
                chars.next();
                if next_ch == quote {
                    closed = true;
                    break;
                }
                inner.push(next_ch);
            }
            let stripped = strip_line_col_suffix(inner.trim());
            if is_absolute_path(stripped) {
                pass1.push(quote);
                pass1.push_str("[REDACTED]");
                if closed {
                    pass1.push(quote);
                }
            } else {
                pass1.push(quote);
                pass1.push_str(&inner);
                if closed {
                    pass1.push(quote);
                }
            }
        } else if ch == '(' {
            let mut inner = String::new();
            let mut closed = false;
            while let Some(&next_ch) = chars.peek() {
                chars.next();
                if next_ch == ')' {
                    closed = true;
                    break;
                }
                inner.push(next_ch);
            }
            let stripped = strip_line_col_suffix(inner.trim());
            if is_absolute_path(stripped) {
                pass1.push('(');
                pass1.push_str("[REDACTED]");
                if closed {
                    pass1.push(')');
                }
            } else {
                pass1.push('(');
                pass1.push_str(&inner);
                if closed {
                    pass1.push(')');
                }
            }
        } else {
            pass1.push(ch);
        }
    }

    // Pass 2: tokenize whitespace-separated words and redact any unquoted absolute paths
    let words: Vec<&str> = pass1.split_whitespace().collect();
    let mut redacted_words: Vec<String> = Vec::with_capacity(words.len());

    for word in words {
        let (prefix, inner, suffix) = strip_path_delimiters(word);
        let stripped = strip_line_col_suffix(inner);
        if is_absolute_path(stripped) {
            redacted_words.push(format!("{prefix}[REDACTED]{suffix}"));
        } else {
            redacted_words.push(word.to_string());
        }
    }

    redacted_words.join(" ")
}

/// Sanitize error messages to prevent leaking tokens, stack frames, or absolute filesystem paths to frontend
pub fn sanitize_oauth_error(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "Authentication operation failed".to_string();
    }

    // Filter out stack trace lines, caret lines, and file location lines
    let non_stack_lines: Vec<&str> = trimmed
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !is_stack_trace_line(l))
        .collect();

    // If all lines were stack trace frames or locations, fail closed
    if non_stack_lines.is_empty() {
        return "Authentication operation failed".to_string();
    }

    // Pick the most relevant error message line.
    // In Node / stderr outputs, prefer the last non-stack line (e.g. "Error: ..."),
    // but if an earlier line specifically starts with an error indicator, keep that.
    let chosen_line = non_stack_lines
        .iter()
        .rev()
        .find(|l| {
            let lower = l.to_ascii_lowercase();
            lower.starts_with("error:") || lower.contains("error") || lower.contains("failed")
        })
        .copied()
        .unwrap_or_else(|| *non_stack_lines.last().unwrap());

    // Redact absolute paths so filesystem paths are never exposed to frontend
    let path_redacted = redact_absolute_paths(chosen_line);

    let mut msg = path_redacted.trim().to_string();
    if msg.len() > 300 {
        let mut end = 300;
        while !msg.is_char_boundary(end) {
            end -= 1;
        }
        msg.truncate(end);
    }

    let sanitized = sanitize_oauth_text(&msg);
    if sanitized.is_empty() || sanitized == "[REDACTED]" {
        "Authentication operation failed".to_string()
    } else {
        sanitized
    }
}

/// Validate provider ID against format rules.
/// Must be non-empty, alphanumeric with '-' or '_', 1..=64 characters.
pub fn validate_provider_id(provider_id: &str) -> Result<String, String> {
    let trimmed = provider_id.trim();
    if trimmed.is_empty() {
        return Err("Provider ID cannot be empty".to_string());
    }
    if trimmed.len() > 64 {
        return Err("Provider ID exceeds maximum length of 64 characters".to_string());
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!(
            "Provider ID '{}' contains invalid characters. Use letters, digits, '-', or '_'",
            trimmed
        ));
    }
    Ok(trimmed.to_string())
}

/// Validate prompt ID format.
/// Must be non-empty, start with "prompt-", length <= 64, alphanumeric or hyphen.
pub fn validate_prompt_id(prompt_id: &str) -> Result<String, String> {
    let trimmed = prompt_id.trim();
    if trimmed.is_empty() {
        return Err("Prompt ID cannot be empty".to_string());
    }
    if trimmed.len() > 64 {
        return Err("Prompt ID exceeds maximum length of 64 characters".to_string());
    }
    if !trimmed.starts_with("prompt-") {
        return Err("Prompt ID must start with 'prompt-'".to_string());
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Prompt ID contains invalid characters".to_string());
    }
    Ok(trimmed.to_string())
}

/// Validate prompt response string.
/// Length <= 8192, no null bytes.
pub fn validate_prompt_response(response: &str) -> Result<String, String> {
    if response.len() > 8192 {
        return Err("Prompt response exceeds maximum length of 8192 characters".to_string());
    }
    if response.contains('\0') {
        return Err("Prompt response contains null bytes".to_string());
    }
    Ok(response.to_string())
}

/// Resolves the filesystem location of `pi-oauth-helper.mjs`.
pub fn resolve_oauth_helper_path(app_handle: Option<&AppHandle>) -> Result<PathBuf, String> {
    // 1. Explicit env override
    if let Ok(env_path) = std::env::var("PI_OAUTH_HELPER_PATH") {
        let p = PathBuf::from(env_path.trim());
        if p.is_file() {
            return dunce::canonicalize(&p)
                .map_err(|e| format!("Failed to canonicalize PI_OAUTH_HELPER_PATH: {e}"));
        }
    }

    // 2. Tauri resource directory (bundled package)
    if let Some(app) = app_handle {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let candidates = [
                resource_dir.join("pi-oauth-helper.mjs"),
                resource_dir.join("src-tauri").join("pi-oauth-helper.mjs"),
                resource_dir.join("resources").join("pi-oauth-helper.mjs"),
            ];
            for c in candidates {
                if c.is_file() {
                    return dunce::canonicalize(&c)
                        .map_err(|e| format!("Failed to canonicalize helper in resource_dir: {e}"));
                }
            }
        }
    }

    // 3. Relative to current executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("pi-oauth-helper.mjs"),
                exe_dir.join("src-tauri").join("pi-oauth-helper.mjs"),
                exe_dir.join("../../../src-tauri/pi-oauth-helper.mjs"),
                exe_dir.join("../pi-oauth-helper.mjs"),
                exe_dir.join("resources").join("pi-oauth-helper.mjs"),
            ];
            for c in candidates {
                if c.is_file() {
                    return dunce::canonicalize(&c)
                        .map_err(|e| format!("Failed to canonicalize helper near executable: {e}"));
                }
            }
        }
    }

    // 4. Relative to current working directory (dev & testing)
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("src-tauri").join("pi-oauth-helper.mjs"),
            cwd.join("pi-oauth-helper.mjs"),
            cwd.join("..").join("src-tauri").join("pi-oauth-helper.mjs"),
            cwd.join("resources").join("pi-oauth-helper.mjs"),
            cwd.join("..").join("resources").join("pi-oauth-helper.mjs"),
        ];
        for c in candidates {
            if c.is_file() {
                return dunce::canonicalize(&c)
                    .map_err(|e| format!("Failed to canonicalize helper in cwd: {e}"));
            }
        }
    }

    Err("Pi OAuth helper script (pi-oauth-helper.mjs) was not found".to_string())
}

/// Helper to read a trusted string setting from a JSON config file
fn read_trusted_setting_from_file(path: &Path, keys: &[&str]) -> Option<String> {
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(Value::Object(map)) = serde_json::from_str(&content) {
            for key in keys {
                if let Some(Value::String(s)) = map.get(*key) {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Bind credentials to the validated executable, not to Gentle Shell installation alone.
/// A direct Pi session must never silently write its OAuth credentials to an isolated home.
fn oauth_home_for_entrypoint(
    entrypoint: &Path,
    homes: &super::config_files::ResolvedGentleShellHomes,
) -> PathBuf {
    if crate::process::is_gentle_shell_entrypoint(entrypoint) {
        homes.effective_home.clone()
    } else {
        homes.main_pi_home.clone()
    }
}

fn resolve_oauth_home(entrypoint: &Path, cwd: &Path) -> PathBuf {
    if let Some(homes) = resolve_gentle_shell_homes(Some(cwd)) {
        oauth_home_for_entrypoint(entrypoint, &homes)
    } else {
        resolve_user_home()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".pi")
            .join("agent")
    }
}

/// Resolves Node runtime path, Pi CLI entrypoint path, and matching credential home.
/// Derives paths strictly from active validated session, trusted settings, or system discovery.
/// Frontend-supplied executable and home overrides are strictly removed.
pub async fn resolve_oauth_execution_environment(
    state: &AppState,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let active_cwd = state.active_cwd.lock().await.clone();

    // 1. Determine target working directory and whether a live session specifically matches it
    let (target_cwd, live_session) = if let Some(selected_cwd) = active_cwd {
        // Active working directory is explicitly selected (Project A).
        // Find if selected_cwd SPECIFICALLY has an active live session.
        // We do NOT fall back to other projects' sessions.
        let live_for_selected = {
            let sessions = state.sessions.lock().await;
            if let Some(s) = sessions.get(&selected_cwd) {
                if s.is_alive() {
                    Some(s.clone())
                } else {
                    None
                }
            } else {
                let legacy = state.session.lock().await;
                if let Some(ref s) = *legacy {
                    if s.cwd == selected_cwd && s.is_alive() {
                        Some(s.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };

        (selected_cwd, live_for_selected)
    } else {
        // No active cwd is currently selected.
        // Check all live sessions across the state.
        let alive_sessions: Vec<ActiveSession> = {
            let mut map: HashMap<PathBuf, ActiveSession> = HashMap::new();
            let sessions = state.sessions.lock().await;
            for (k, v) in sessions.iter() {
                if v.is_alive() {
                    map.insert(k.clone(), v.clone());
                }
            }
            let legacy = state.session.lock().await;
            if let Some(ref s) = *legacy {
                if s.is_alive() {
                    map.entry(s.cwd.clone()).or_insert_with(|| s.clone());
                }
            }
            map.into_values().collect()
        };

        if alive_sessions.len() == 1 {
            // Exactly one unambiguous live session: use it
            let unambiguous = alive_sessions.into_iter().next().unwrap();
            let cwd = unambiguous.cwd.clone();
            (cwd, Some(unambiguous))
        } else if alive_sessions.len() > 1 {
            // Multiple live sessions exist but no project is selected: fail closed
            return Err("Multiple active Pi sessions exist but no project is currently selected. Please select a project.".to_string());
        } else {
            // No live sessions exist: fall back to current directory
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            (cwd, None)
        }
    };

    // 2. If a live session matched our target, strictly require its execution provenance.
    if let Some(session) = live_session {
        let paths = session.execution_paths().ok_or_else(|| {
            "Active Pi session does not have validated execution provenance for OAuth. Please reconnect the session."
                .to_string()
        })?;

        if !paths.entrypoint.is_file() {
            return Err("Active Pi session entrypoint file no longer exists. Please reconnect the session.".to_string());
        }

        let effective_home = resolve_oauth_home(&paths.entrypoint, &target_cwd);
        return Ok((paths.node_path, paths.entrypoint, effective_home));
    }

    // 3. Fallback: target_cwd lacks a live session.
    // Derive paths for target_cwd strictly from target_cwd's trusted settings or real OS PATH.
    // Cross-project sessions are NEVER touched.
    let project_settings = crate::commands::config_files::resolve_project_settings_config_path(&target_cwd);
    let global_settings = crate::commands::config_files::resolve_settings_config_path();

    let entry_keys = &["piEntrypoint", "pi_entrypoint", "entrypoint"];
    let node_keys = &["nodePath", "node_path"];

    let setting_entry = read_trusted_setting_from_file(&project_settings, entry_keys)
        .or_else(|| global_settings.as_ref().and_then(|p| read_trusted_setting_from_file(p, entry_keys)));

    let setting_node = read_trusted_setting_from_file(&project_settings, node_keys)
        .or_else(|| global_settings.as_ref().and_then(|p| read_trusted_setting_from_file(p, node_keys)));

    let os_path = std::env::var("PATH").ok();
    let discovered = crate::commands::discovery::discover_environment_impl(
        os_path.as_deref(),
        Some(&target_cwd),
        None,
    );

    // Verify real Node executable discovery
    let node_candidate = setting_node
        .or(discovered.node_path)
        .ok_or_else(|| {
            "Node.js runtime executable was not found on system PATH. Please install Node.js or configure nodePath in trusted settings."
                .to_string()
        })?;

    let entrypoint_candidate = setting_entry
        .or(discovered.entrypoint.path)
        .ok_or_else(|| {
            "Pi CLI entrypoint not found. Please install Pi CLI or configure it in trusted settings."
                .to_string()
        })?;

    let cwd_str = target_cwd.to_string_lossy().to_string();
    let (node_path, canonical_entry, _) = validate_paths(&node_candidate, &entrypoint_candidate, &cwd_str)
        .map_err(|e| redact_absolute_paths(&e))?;

    let effective_home = resolve_oauth_home(&canonical_entry, &target_cwd);
    Ok((node_path, canonical_entry, effective_home))
}

/// Helper to execute non-interactive helper commands and parse JSON result
pub async fn run_oauth_helper_json(
    node_path: &Path,
    helper_path: &Path,
    action: &str,
    entrypoint: &Path,
    effective_home: &Path,
    extra_args: &[(&str, &str)],
) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(node_path);
    cmd.arg(helper_path)
        .arg(action)
        .arg("--entrypoint")
        .arg(entrypoint)
        .arg("--home")
        .arg(effective_home);

    for (flag, val) in extra_args {
        cmd.arg(flag).arg(val);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = timeout(OAUTH_COMMAND_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("Timeout executing OAuth {action}"))?
        .map_err(|e| format!("Failed to spawn Pi OAuth helper: {e}"))?;

    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let stderr_text = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        if let Ok(parsed) = serde_json::from_str::<Value>(stdout_text.trim()) {
            if let Some(err_msg) = parsed.get("error").and_then(|v| v.as_str()) {
                return Err(format!("OAuth helper failed: {}", sanitize_oauth_error(err_msg)));
            }
        }
        let fallback_err = if !stderr_text.trim().is_empty() {
            sanitize_oauth_error(&stderr_text)
        } else {
            sanitize_oauth_error(&stdout_text)
        };
        return Err(format!("OAuth helper failed: {fallback_err}"));
    }

    let parsed: Value = serde_json::from_str(stdout_text.trim())
        .map_err(|e| format!("Failed to parse JSON from OAuth helper: {e}"))?;

    if parsed.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let err = parsed.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown error");
        return Err(format!("OAuth helper failed: {}", sanitize_oauth_error(err)));
    }

    Ok(parsed)
}

/// Pure implementation for listing built-in OAuth providers via helper subprocess
pub async fn get_builtin_oauth_providers_impl(
    node_path: &Path,
    helper_path: &Path,
    entrypoint: &Path,
    effective_home: &Path,
) -> Result<Vec<BuiltinOAuthProviderStatus>, String> {
    let parsed = run_oauth_helper_json(node_path, helper_path, "list", entrypoint, effective_home, &[]).await?;
    let providers_val = parsed
        .get("providers")
        .ok_or_else(|| "OAuth helper response missing 'providers' field".to_string())?;

    serde_json::from_value(providers_val.clone())
        .map_err(|e| format!("Failed to deserialize provider list: {e}"))
}

/// Pure implementation for querying built-in provider model catalog via helper subprocess
pub async fn get_builtin_provider_catalog_impl(
    node_path: &Path,
    helper_path: &Path,
    entrypoint: &Path,
    effective_home: &Path,
    provider_id: &str,
) -> Result<Vec<BuiltinCatalogModel>, String> {
    let parsed = run_oauth_helper_json(
        node_path,
        helper_path,
        "catalog",
        entrypoint,
        effective_home,
        &[("--provider", provider_id)],
    )
    .await?;

    let models_val = parsed
        .get("models")
        .ok_or_else(|| "OAuth helper response missing 'models' field".to_string())?;

    serde_json::from_value(models_val.clone())
        .map_err(|e| format!("Failed to deserialize catalog models: {e}"))
}

/// Pure implementation for logging out of an OAuth provider via helper subprocess
pub async fn logout_oauth_provider_impl(
    node_path: &Path,
    helper_path: &Path,
    entrypoint: &Path,
    effective_home: &Path,
    provider_id: &str,
) -> Result<LogoutOAuthProviderResult, String> {
    run_oauth_helper_json(
        node_path,
        helper_path,
        "logout",
        entrypoint,
        effective_home,
        &[("--provider", provider_id)],
    )
    .await?;

    Ok(LogoutOAuthProviderResult {
        success: true,
        provider_id: provider_id.to_string(),
        message: None,
    })
}

/// Frame action returned from parsing an OAuth helper JSON line
#[derive(Debug, PartialEq, Eq)]
pub enum FrameAction {
    Continue,
    Success,
    Cancelled,
    Error(String),
}

/// Parses and projects allowlisted fields from an OAuth frame line.
/// Validates URL schemes strictly, redacts token-bearing parameters, sanitizes messages,
/// and delegates terminal status to the supervisor after child exit.
pub async fn handle_safe_oauth_frame<S: OAuthEventSink>(
    line: &str,
    sink: &S,
    provider_id: &str,
) -> FrameAction {
    let parsed: Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => return FrameAction::Continue,
    };

    let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match msg_type {
        "event" => {
            if let Some(event_val) = parsed.get("event") {
                if let Ok(mut safe_event) = serde_json::from_value::<OAuthSafeEvent>(event_val.clone()) {
                    match safe_event {
                        OAuthSafeEvent::AuthUrl { ref mut url, ref mut instructions } => {
                            match validate_oauth_url(url) {
                                Ok(validated) => {
                                    *url = validated.clone();
                                    *instructions = instructions.as_ref().map(|i| sanitize_oauth_text(i));
                                    sink.open_url(&validated);
                                    let safe_json = serde_json::to_value(&safe_event).unwrap_or(Value::Null);
                                    sink.emit_event(provider_id, "event", safe_json);
                                }
                                Err(_) => {
                                    // Drop unsafe scheme URL - do not open or emit to WebView
                                }
                            }
                        }
                        OAuthSafeEvent::DeviceCode { ref mut user_code, ref mut verification_uri, .. } => {
                            match validate_oauth_url(verification_uri) {
                                Ok(validated) => {
                                    *verification_uri = validated;
                                    *user_code = sanitize_oauth_text(user_code);
                                    let safe_json = serde_json::to_value(&safe_event).unwrap_or(Value::Null);
                                    sink.emit_event(provider_id, "event", safe_json);
                                }
                                Err(_) => {
                                    // Drop unsafe scheme verification URI
                                }
                            }
                        }
                        OAuthSafeEvent::Progress { ref mut message } => {
                            *message = sanitize_oauth_text(message);
                            let safe_json = serde_json::to_value(&safe_event).unwrap_or(Value::Null);
                            sink.emit_event(provider_id, "event", safe_json);
                        }
                        OAuthSafeEvent::Info { ref mut message, ref mut links } => {
                            *message = sanitize_oauth_text(message);
                            if let Some(links_vec) = links {
                                let mut valid_links = Vec::new();
                                for mut link in links_vec.drain(..) {
                                    if let Ok(val_url) = validate_oauth_url(&link.url) {
                                        link.url = val_url;
                                        link.label = link.label.map(|l| sanitize_oauth_text(&l));
                                        valid_links.push(link);
                                    }
                                }
                                *links = if valid_links.is_empty() { None } else { Some(valid_links) };
                            }
                            let safe_json = serde_json::to_value(&safe_event).unwrap_or(Value::Null);
                            sink.emit_event(provider_id, "event", safe_json);
                        }
                    }
                }
            }
            FrameAction::Continue
        }
        "prompt" => {
            if let Some(prompt_val) = parsed.get("prompt") {
                if let Ok(mut safe_prompt) = serde_json::from_value::<OAuthSafePrompt>(prompt_val.clone()) {
                    safe_prompt.message = sanitize_oauth_text(&safe_prompt.message);
                    safe_prompt.placeholder = safe_prompt.placeholder.as_ref().map(|p| sanitize_oauth_text(p));
                    if let Some(ref mut opts) = safe_prompt.options {
                        for opt in opts.iter_mut() {
                            opt.label = sanitize_oauth_text(&opt.label);
                            opt.description = opt.description.as_ref().map(|d| sanitize_oauth_text(d));
                        }
                    }
                    let safe_json = serde_json::to_value(&safe_prompt).unwrap_or(Value::Null);
                    sink.emit_event(provider_id, "prompt", safe_json);
                }
            }
            FrameAction::Continue
        }
        "prompt_cancelled" => {
            if let Some(prompt_id) = parsed.get("promptId").and_then(|p| p.as_str()) {
                if let Ok(valid_id) = validate_prompt_id(prompt_id) {
                    sink.emit_event(provider_id, "prompt_cancelled", serde_json::json!({ "promptId": valid_id }));
                }
            }
            FrameAction::Continue
        }
        "success" => FrameAction::Success,
        "cancelled" => FrameAction::Cancelled,
        "error" => {
            let err_raw = parsed.get("error").and_then(|e| e.as_str()).unwrap_or("Authentication failed");
            FrameAction::Error(sanitize_oauth_error(err_raw))
        }
        _ => FrameAction::Continue,
    }
}

/// Supervises child login execution with strict select-driven timeout, cancel_rx, and bounded framing.
/// Emits terminal status (completed, cancelled, failed) ONLY after the helper process has exited,
/// and guards status emissions so cancellation and terminal transitions fire exactly once.
pub async fn supervise_oauth_login_child<S: OAuthEventSink>(
    mut child: tokio::process::Child,
    mut stdout: tokio::process::ChildStdout,
    mut cancel_rx: oneshot::Receiver<()>,
    login_timeout: Duration,
    sink: Arc<S>,
    provider_id: String,
    is_alive: Arc<AtomicBool>,
    terminal_emitted: Arc<AtomicBool>,
    stderr_collector: Arc<tokio::sync::Mutex<StderrCollector>>,
) -> (bool, Option<String>) {
    let mut chunk_buf = [0u8; 4096];
    let mut frame_buf = JsonlFrameBuffer::new();
    let deadline = tokio::time::Instant::now() + login_timeout;
    let mut helper_action: Option<FrameAction> = None;

    // Check if cancellation was already triggered before loop started
    if cancel_rx.try_recv().is_ok() {
        is_alive.store(false, Ordering::SeqCst);
        let _ = tokio::time::timeout(OAUTH_KILL_GRACE_PERIOD, child.wait()).await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        if !terminal_emitted.swap(true, Ordering::SeqCst) {
            sink.emit_status(&provider_id, "cancelled", Some("Authentication was cancelled by user"), None);
            sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "cancelled" }));
        }
        return (true, None);
    }

    loop {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                is_alive.store(false, Ordering::SeqCst);
                let _ = tokio::time::timeout(OAUTH_KILL_GRACE_PERIOD, child.wait()).await;
                let _ = child.kill().await;
                let _ = child.wait().await;
                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                    sink.emit_status(&provider_id, "cancelled", Some("Authentication was cancelled by user"), None);
                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "cancelled" }));
                }
                return (true, None);
            }
            _ = tokio::time::sleep_until(deadline) => {
                is_alive.store(false, Ordering::SeqCst);
                let _ = child.kill().await;
                let _ = child.wait().await;
                let err_msg = "Authentication process timed out";
                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                    sink.emit_status(&provider_id, "failed", None, Some(err_msg));
                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": err_msg }));
                }
                return (false, Some(err_msg.to_string()));
            }
            read_res = stdout.read(&mut chunk_buf) => {
                match read_res {
                    Ok(0) => break,
                    Ok(n) => {
                        if frame_buf.pending_bytes() + n > MAX_OAUTH_FRAME_BYTES {
                            is_alive.store(false, Ordering::SeqCst);
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                            let err_msg = "OAuth helper frame exceeded maximum allowed buffer size";
                            if !terminal_emitted.swap(true, Ordering::SeqCst) {
                                sink.emit_status(&provider_id, "failed", None, Some(err_msg));
                                sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": err_msg }));
                            }
                            return (false, Some(err_msg.to_string()));
                        }

                        match frame_buf.push_bytes(&chunk_buf[..n]) {
                            Ok(lines) => {
                                for line in lines {
                                    let action = handle_safe_oauth_frame(&line, sink.as_ref(), &provider_id).await;
                                    if action != FrameAction::Continue {
                                        helper_action = Some(action);
                                        break;
                                    }
                                }
                                if helper_action.is_some() {
                                    break;
                                }
                            }
                            Err(e) => {
                                is_alive.store(false, Ordering::SeqCst);
                                let _ = child.kill().await;
                                let _ = child.wait().await;
                                let err_msg = format!("OAuth framing error: {e}");
                                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                                    sink.emit_status(&provider_id, "failed", None, Some(&err_msg));
                                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": err_msg.clone() }));
                                }
                                return (false, Some(err_msg));
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    is_alive.store(false, Ordering::SeqCst);

    // Wait for the child process to exit cleanly before emitting terminal status
    let child_status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => status,
        _ => {
            let _ = child.kill().await;
            child.wait().await.unwrap_or_else(|_| std::process::ExitStatus::default())
        }
    };

    match helper_action {
        Some(FrameAction::Success) => {
            if child_status.success() {
                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                    sink.emit_status(&provider_id, "completed", Some("Authentication completed successfully"), None);
                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "completed" }));
                }
                (true, None)
            } else {
                let stderr_msg = stderr_collector.lock().await.get_lossy_excerpt();
                let display_err = if !stderr_msg.trim().is_empty() {
                    sanitize_oauth_error(&stderr_msg)
                } else {
                    format!("OAuth helper exited with error code: {}", child_status.code().unwrap_or(-1))
                };
                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                    sink.emit_status(&provider_id, "failed", None, Some(&display_err));
                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": display_err.clone() }));
                }
                (false, Some(display_err))
            }
        }
        Some(FrameAction::Cancelled) => {
            if !terminal_emitted.swap(true, Ordering::SeqCst) {
                sink.emit_status(&provider_id, "cancelled", Some("Authentication was cancelled"), None);
                sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "cancelled" }));
            }
            (true, None)
        }
        Some(FrameAction::Error(err_msg)) => {
            if !terminal_emitted.swap(true, Ordering::SeqCst) {
                sink.emit_status(&provider_id, "failed", None, Some(&err_msg));
                sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": err_msg.clone() }));
            }
            (false, Some(err_msg))
        }
        Some(FrameAction::Continue) | None => {
            if child_status.success() {
                let err_msg = "OAuth helper exited unexpectedly without completion frame".to_string();
                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                    sink.emit_status(&provider_id, "failed", None, Some(&err_msg));
                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": err_msg.clone() }));
                }
                (false, Some(err_msg))
            } else {
                let stderr_msg = stderr_collector.lock().await.get_lossy_excerpt();
                let display_err = sanitize_oauth_error(&stderr_msg);
                if !terminal_emitted.swap(true, Ordering::SeqCst) {
                    sink.emit_status(&provider_id, "failed", None, Some(&display_err));
                    sink.emit_event(&provider_id, "status", serde_json::json!({ "state": "failed", "error": display_err.clone() }));
                }
                (false, Some(display_err))
            }
        }
    }
}

/// Tauri command to list built-in OAuth providers and their configuration status
#[tauri::command]
pub async fn get_builtin_oauth_providers(
    _payload: Option<GetBuiltinOAuthProvidersPayload>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Vec<BuiltinOAuthProviderStatus>, String> {
    let (node_path, entrypoint, effective_home) = resolve_oauth_execution_environment(&state)
        .await
        .map_err(|e| redact_absolute_paths(&e))?;
    let helper_path = resolve_oauth_helper_path(Some(&app_handle))
        .map_err(|e| redact_absolute_paths(&e))?;
    get_builtin_oauth_providers_impl(&node_path, &helper_path, &entrypoint, &effective_home).await
}

/// Tauri command to query read-only model catalog for a specific built-in provider
#[tauri::command]
pub async fn get_builtin_provider_catalog(
    payload: GetBuiltinCatalogPayload,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Vec<BuiltinCatalogModel>, String> {
    let provider_id = payload.provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider ID is required".to_string());
    }

    let (node_path, entrypoint, effective_home) = resolve_oauth_execution_environment(&state)
        .await
        .map_err(|e| redact_absolute_paths(&e))?;
    let helper_path = resolve_oauth_helper_path(Some(&app_handle))
        .map_err(|e| redact_absolute_paths(&e))?;

    get_builtin_provider_catalog_impl(
        &node_path,
        &helper_path,
        &entrypoint,
        &effective_home,
        provider_id,
    )
    .await
}

/// Tauri command to start an interactive OAuth sign-in flow.
/// Ensures atomic session registration while holding the lock across check and process spawn.
#[tauri::command]
pub async fn start_oauth_login(
    payload: StartOAuthLoginPayload,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<StartOAuthLoginResult, String> {
    let provider_id = validate_provider_id(&payload.provider_id)
        .map_err(|e| redact_absolute_paths(&e))?;
    let (node_path, entrypoint, effective_home) = resolve_oauth_execution_environment(&state)
        .await
        .map_err(|e| redact_absolute_paths(&e))?;
    let helper_path = resolve_oauth_helper_path(Some(&app_handle))
        .map_err(|e| redact_absolute_paths(&e))?;

    // Atomic concurrent session check and registration
    let (child, stdout, stderr, _stdin_tx, cancel_rx, is_alive, terminal_emitted, session_id) = {
        let mut active_guard = state.active_oauth_login.lock().await;
        if let Some(ref current) = *active_guard {
            if current.is_alive.load(Ordering::SeqCst) {
                if current.provider_id == provider_id {
                    return Err(format!(
                        "OAuth login is already in progress for provider '{}'. Please complete or cancel it.",
                        provider_id
                    ));
                } else {
                    return Err(format!(
                        "Another OAuth login is already in progress for provider '{}'. Please complete or cancel it first.",
                        current.provider_id
                    ));
                }
            }
        }

        let mut cmd = tokio::process::Command::new(&node_path);
        cmd.arg(&helper_path)
            .arg("login")
            .arg("--entrypoint")
            .arg(&entrypoint)
            .arg("--home")
            .arg(&effective_home)
            .arg("--provider")
            .arg(&provider_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            let raw = format!("Failed to spawn OAuth login helper: {e}");
            redact_absolute_paths(&raw)
        })?;
        let child_pid = child.id();
        let stdin = child.stdin.take().ok_or_else(|| "Failed to capture child stdin".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "Failed to capture child stdout".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "Failed to capture child stderr".to_string())?;

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(32);
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let cancel_tx_holder = Arc::new(tokio::sync::Mutex::new(Some(cancel_tx)));
        let is_alive = Arc::new(AtomicBool::new(true));
        let terminal_emitted = Arc::new(AtomicBool::new(false));

        let session_id = next_oauth_session_id();
        let active_session = ActiveOAuthSession {
            session_id,
            provider_id: provider_id.clone(),
            effective_home: effective_home.clone(),
            child_pid,
            stdin_tx: stdin_tx.clone(),
            cancel_tx: cancel_tx_holder,
            is_alive: is_alive.clone(),
            terminal_emitted: terminal_emitted.clone(),
        };

        *active_guard = Some(active_session);

        // Stdin forwarder task
        let is_alive_stdin = is_alive.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(msg) = stdin_rx.recv().await {
                if !is_alive_stdin.load(Ordering::SeqCst) {
                    break;
                }
                if stdin.write_all(msg.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        (child, stdout, stderr, stdin_tx, cancel_rx, is_alive, terminal_emitted, session_id)
    };

    // Stderr collector task (bounded diagnostics buffer)
    let stderr_collector = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));
    let stderr_collector_clone = stderr_collector.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut guard = stderr_collector_clone.lock().await;
            guard.push(&buf[..n]);
        }
    });

    // Emit initial status notification
    let sink = Arc::new(TauriOAuthEventSink { app_handle });
    sink.emit_status(
        &provider_id,
        "starting",
        Some(&format!("Starting OAuth sign-in for {}", provider_id)),
        None,
    );

    let active_login_ref = state.active_oauth_login.clone();
    let provider_id_clone = provider_id.clone();
    let is_alive_supervisor = is_alive.clone();

    tokio::spawn(async move {
        supervise_oauth_login_child(
            child,
            stdout,
            cancel_rx,
            OAUTH_LOGIN_TIMEOUT,
            sink,
            provider_id_clone.clone(),
            is_alive_supervisor.clone(),
            terminal_emitted,
            stderr_collector,
        )
        .await;

        let mut guard = active_login_ref.lock().await;
        if let Some(ref current) = *guard {
            if current.session_id == session_id && Arc::ptr_eq(&current.is_alive, &is_alive_supervisor) {
                *guard = None;
            }
        }
    });

    Ok(StartOAuthLoginResult {
        started: true,
        provider_id,
        message: None,
    })
}

/// Tauri command to cancel an active OAuth login process.
/// Guarantees cancellation triggers at most once and emits terminal status only via supervisor.
#[tauri::command]
pub async fn cancel_oauth_login(
    payload: Option<CancelOAuthLoginPayload>,
    state: State<'_, AppState>,
    _app_handle: AppHandle,
) -> Result<CancelOAuthLoginResult, String> {
    let mut guard = state.active_oauth_login.lock().await;
    if let Some(ref mut active) = *guard {
        if let Some(ref req_provider) = payload.as_ref().and_then(|p| p.provider_id.as_ref()) {
            if active.provider_id != **req_provider {
                return Ok(CancelOAuthLoginResult {
                    cancelled: false,
                    message: Some("Active OAuth login is for a different provider".to_string()),
                });
            }
        }

        let cancelled = active.cancel_and_terminate().await;
        if !cancelled {
            return Ok(CancelOAuthLoginResult {
                cancelled: false,
                message: Some("OAuth login is already cancelled or finished".to_string()),
            });
        }

        Ok(CancelOAuthLoginResult {
            cancelled: true,
            message: None,
        })
    } else {
        Ok(CancelOAuthLoginResult {
            cancelled: false,
            message: Some("No active OAuth login process to cancel".to_string()),
        })
    }
}

/// Tauri command to forward user response to an in-flight OAuth prompt
#[tauri::command]
pub async fn send_oauth_prompt_response(
    payload: SendOAuthPromptResponsePayload,
    state: State<'_, AppState>,
) -> Result<SendOAuthPromptResponseResult, String> {
    let prompt_id = validate_prompt_id(&payload.prompt_id)?;
    let response = validate_prompt_response(&payload.response)?;

    let guard = state.active_oauth_login.lock().await;
    if let Some(ref active) = *guard {
        if !active.is_alive.load(Ordering::SeqCst) {
            return Err("OAuth login process is no longer active".to_string());
        }

        let msg = serde_json::json!({
            "type": "prompt_response",
            "promptId": prompt_id,
            "value": response,
        });

        let line = format!("{}\n", serde_json::to_string(&msg).map_err(|e| e.to_string())?);
        active.stdin_tx.send(line).await
            .map_err(|_| "Failed to send response to OAuth helper: stdin closed".to_string())?;

        Ok(SendOAuthPromptResponseResult { sent: true })
    } else {
        Err("No active OAuth login process awaiting prompt response".to_string())
    }
}

/// Validate whether an OAuth logout is permitted given active login state.
/// Rejects with an actionable error if any OAuth login is actively in progress,
/// preventing concurrent processes from racing writes to `auth.json`.
pub fn ensure_logout_allowed(
    active_session: Option<&ActiveOAuthSession>,
    logout_provider_id: &str,
) -> Result<(), String> {
    if let Some(current) = active_session {
        if current.is_alive.load(Ordering::SeqCst) {
            if current.provider_id == logout_provider_id {
                return Err(format!(
                    "Cannot log out while an OAuth login is in progress for provider '{}'. Please complete or cancel it first.",
                    logout_provider_id
                ));
            } else {
                return Err(format!(
                    "Cannot log out of provider '{}' while an OAuth login is in progress for provider '{}'. Please complete or cancel it first.",
                    logout_provider_id, current.provider_id
                ));
            }
        }
    }
    Ok(())
}

/// Tauri command to logout of an OAuth provider
#[tauri::command]
pub async fn logout_oauth_provider(
    payload: LogoutOAuthProviderPayload,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<LogoutOAuthProviderResult, String> {
    let provider_id = validate_provider_id(&payload.provider_id)
        .map_err(|e| redact_absolute_paths(&e))?;
    let (node_path, entrypoint, effective_home) = resolve_oauth_execution_environment(&state)
        .await
        .map_err(|e| redact_absolute_paths(&e))?;
    let helper_path = resolve_oauth_helper_path(Some(&app_handle))
        .map_err(|e| redact_absolute_paths(&e))?;

    // Prevent concurrent login and logout racing auth.json writes
    let active_login_lock = state.active_oauth_login.clone();
    let _active_guard = {
        let active_guard = active_login_lock.lock().await;
        ensure_logout_allowed(active_guard.as_ref(), &provider_id)?;
        active_guard
    };

    logout_oauth_provider_impl(&node_path, &helper_path, &entrypoint, &effective_home, &provider_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MockOAuthEventSink {
        events: Arc<tokio::sync::Mutex<Vec<(String, String, Value)>>>,
        statuses: Arc<tokio::sync::Mutex<Vec<(String, String, Option<String>, Option<String>)>>>,
        opened_urls: Arc<tokio::sync::Mutex<Vec<String>>>,
    }

    impl OAuthEventSink for MockOAuthEventSink {
        fn emit_event(&self, provider_id: &str, kind: &str, data: Value) {
            let events = self.events.clone();
            let p = provider_id.to_string();
            let k = kind.to_string();
            tokio::spawn(async move {
                events.lock().await.push((p, k, data));
            });
        }

        fn emit_status(&self, provider_id: &str, state: &str, message: Option<&str>, error: Option<&str>) {
            let statuses = self.statuses.clone();
            let p = provider_id.to_string();
            let s = state.to_string();
            let m = message.map(|x| x.to_string());
            let e = error.map(|x| x.to_string());
            tokio::spawn(async move {
                statuses.lock().await.push((p, s, m, e));
            });
        }

        fn open_url(&self, url: &str) {
            let urls = self.opened_urls.clone();
            let u = url.to_string();
            tokio::spawn(async move {
                urls.lock().await.push(u);
            });
        }
    }

    #[test]
    fn test_validate_provider_id_valid() {
        for id in KNOWN_BUILTIN_OAUTH_PROVIDERS {
            assert_eq!(validate_provider_id(id).unwrap(), *id);
        }
        assert_eq!(validate_provider_id("  anthropic  ").unwrap(), "anthropic");
        assert_eq!(validate_provider_id("custom_test-123").unwrap(), "custom_test-123");
    }

    #[test]
    fn test_catalog_model_projection_deserializes_safe_metadata_only() {
        let json_data = serde_json::json!({
            "id": "claude-3-5-sonnet",
            "name": "Claude 3.5 Sonnet",
            "provider": "anthropic",
            "contextWindow": 200000,
            "maxTokens": 8192,
            "reasoning": true,
            "input": ["text", "image"],
            "input_modalities": ["text", "image"],
            "reasoningEfforts": ["low", "medium", "high"],
            "thinkingLevelMap": { "off": null, "high": "high" },
            // Extra dangerous fields that must be ignored by serde
            "baseUrl": "https://api.anthropic.com",
            "apiKey": "sk-ant-secret",
            "cost": { "input": 3, "output": 15 }
        });

        let model: BuiltinCatalogModel = serde_json::from_value(json_data).unwrap();
        assert_eq!(model.id, "claude-3-5-sonnet");
        assert_eq!(model.name, "Claude 3.5 Sonnet");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.context_window, Some(200000));
        assert_eq!(model.max_tokens, Some(8192));
        assert!(model.reasoning);
        assert_eq!(model.input, Some(vec!["text".to_string(), "image".to_string()]));

        let serialized = serde_json::to_string(&model).unwrap();
        assert!(!serialized.contains("baseUrl"));
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("cost"));
        assert!(!serialized.contains("sk-ant-secret"));
    }

    #[test]
    fn test_catalog_payload_deserializes_flexible_field_names() {
        let payload1: GetBuiltinCatalogPayload = serde_json::from_str(r#"{"providerId":"anthropic"}"#).unwrap();
        assert_eq!(payload1.provider_id, "anthropic");

        let payload2: GetBuiltinCatalogPayload = serde_json::from_str(r#"{"provider_id":"openai-codex"}"#).unwrap();
        assert_eq!(payload2.provider_id, "openai-codex");

        let payload3: GetBuiltinCatalogPayload = serde_json::from_str(r#"{"provider":"openai"}"#).unwrap();
        assert_eq!(payload3.provider_id, "openai");
    }

    #[test]
    fn test_validate_provider_id_invalid() {
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("   ").is_err());
        assert!(validate_provider_id("../etc/passwd").is_err());
        assert!(validate_provider_id("provider/sub").is_err());
        assert!(validate_provider_id("provider\\sub").is_err());
        assert!(validate_provider_id("provider with space").is_err());
        assert!(validate_provider_id("provider;rm").is_err());
        assert!(validate_provider_id("provider$var").is_err());

        let long_id = "a".repeat(65);
        assert!(validate_provider_id(&long_id).is_err());
    }

    #[test]
    fn test_validate_prompt_id() {
        assert_eq!(validate_prompt_id("prompt-1").unwrap(), "prompt-1");
        assert_eq!(validate_prompt_id("prompt-select-42").unwrap(), "prompt-select-42");
        assert_eq!(validate_prompt_id("  prompt-abc  ").unwrap(), "prompt-abc");

        assert!(validate_prompt_id("").is_err());
        assert!(validate_prompt_id("   ").is_err());
        assert!(validate_prompt_id("input-1").is_err());
        assert!(validate_prompt_id("prompt_1").is_err());
        assert!(validate_prompt_id("prompt-1;bad").is_err());
        let long_prompt = format!("prompt-{}", "a".repeat(60));
        assert!(validate_prompt_id(&long_prompt).is_err());
    }

    #[test]
    fn test_validate_prompt_response() {
        assert_eq!(validate_prompt_response("option-1").unwrap(), "option-1");
        assert_eq!(validate_prompt_response("").unwrap(), "");
        assert_eq!(validate_prompt_response("some-oauth-code-12345").unwrap(), "some-oauth-code-12345");

        let null_resp = "hello\0world";
        assert!(validate_prompt_response(null_resp).is_err());

        let long_resp = "a".repeat(8193);
        assert!(validate_prompt_response(&long_resp).is_err());
    }

    #[test]
    fn test_sanitize_oauth_error() {
        assert_eq!(sanitize_oauth_error(""), "Authentication operation failed");
        assert_eq!(sanitize_oauth_error("Failed to authenticate"), "Failed to authenticate");
        assert_eq!(
            sanitize_oauth_error("Line 1\nLine 2: error occurred"),
            "Line 2: error occurred"
        );
        let long_err = "a".repeat(400);
        assert_eq!(sanitize_oauth_error(&long_err).len(), 300);
    }

    #[test]
    fn test_status_distinguishes_stored_oauth_from_readiness_and_ambient() {
        let status = BuiltinOAuthProviderStatus {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            oauth_name: Some("Anthropic (Claude Pro/Max)".to_string()),
            login_label: Some("Sign in with Claude".to_string()),
            is_subscription: true,
            configured: false,
            has_stored_oauth: false,
            oauth_ready: false,
            ambient_api_key: true,
            source: Some("ANTHROPIC_API_KEY".to_string()),
            status: "ambient_api_key".to_string(),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"ambientApiKey\":true"));
        assert!(json.contains("\"configured\":false"));
        assert!(json.contains("\"hasStoredOAuth\":false"));
        let roundtrip: BuiltinOAuthProviderStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip, status);
    }

    #[test]
    fn test_oauth_safe_event_projection_drops_unallowlisted_fields() {
        let raw_json = serde_json::json!({
            "type": "auth_url",
            "url": "https://accounts.google.com/oauth",
            "instructions": "Open link in browser",
            "access_token": "secret_access_token_leak",
            "refresh_token": "secret_refresh_token_leak"
        });

        let safe_event: OAuthSafeEvent = serde_json::from_value(raw_json).unwrap();
        match safe_event {
            OAuthSafeEvent::AuthUrl { ref url, ref instructions } => {
                assert_eq!(url, "https://accounts.google.com/oauth");
                assert_eq!(instructions.as_deref(), Some("Open link in browser"));
            }
            _ => panic!("Expected AuthUrl variant"),
        }

        let serialized = serde_json::to_string(&safe_event).unwrap();
        assert!(!serialized.contains("secret_access_token_leak"));
        assert!(!serialized.contains("secret_refresh_token_leak"));
        assert!(!serialized.contains("access_token"));
    }

    #[test]
    fn test_oauth_safe_prompt_projection_drops_unallowlisted_fields() {
        let raw_json = serde_json::json!({
            "promptId": "prompt-1",
            "promptType": "select",
            "message": "Choose account",
            "placeholder": null,
            "options": [
                { "id": "1", "label": "Personal", "internal_secret": "drop_me" }
            ],
            "internal_provider_state": "should_be_dropped"
        });

        let safe_prompt: OAuthSafePrompt = serde_json::from_value(raw_json).unwrap();
        assert_eq!(safe_prompt.prompt_id, "prompt-1");
        assert_eq!(safe_prompt.options.as_ref().unwrap()[0].id, "1");

        let serialized = serde_json::to_string(&safe_prompt).unwrap();
        assert!(!serialized.contains("internal_provider_state"));
        assert!(!serialized.contains("internal_secret"));
    }

    #[test]
    fn test_resolve_oauth_helper_path_env_override() {
        let temp_dir = std::env::temp_dir();
        let fake_helper = temp_dir.join("pi-oauth-helper-test-fake.mjs");
        std::fs::write(&fake_helper, "// fake helper").unwrap();

        std::env::set_var("PI_OAUTH_HELPER_PATH", &fake_helper);
        let resolved = resolve_oauth_helper_path(None).unwrap();
        assert_eq!(dunce::canonicalize(&fake_helper).unwrap(), resolved);

        std::env::remove_var("PI_OAUTH_HELPER_PATH");
        let _ = std::fs::remove_file(fake_helper);
    }

    #[tokio::test]
    async fn test_active_oauth_session_cancel() {
        let (stdin_tx, mut stdin_rx) = mpsc::channel(10);
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        let is_alive = Arc::new(AtomicBool::new(true));

        let mut session = ActiveOAuthSession {
            session_id: 1,
            provider_id: "anthropic".to_string(),
            effective_home: PathBuf::from("/test/home"),
            child_pid: Some(1234),
            stdin_tx,
            cancel_tx: Arc::new(tokio::sync::Mutex::new(Some(cancel_tx))),
            is_alive: is_alive.clone(),
            terminal_emitted: Arc::new(AtomicBool::new(false)),
        };

        assert!(session.is_alive.load(Ordering::SeqCst));
        assert!(session.cancel_and_terminate().await);
        assert!(!session.is_alive.load(Ordering::SeqCst));
        // Cancellation once: second call returns false
        assert!(!session.cancel_and_terminate().await);

        assert!(cancel_rx.try_recv().is_ok());
        let msg = stdin_rx.recv().await.unwrap();
        assert_eq!(msg, "{\"type\":\"cancel\"}\n");
    }

    #[tokio::test]
    async fn test_concurrent_login_policy() {
        let (stdin_tx, _) = mpsc::channel(1);
        let (cancel_tx, _) = oneshot::channel();
        let is_alive = Arc::new(AtomicBool::new(true));

        let state = AppState::new();
        *state.active_oauth_login.lock().await = Some(ActiveOAuthSession {
            session_id: 1,
            provider_id: "anthropic".to_string(),
            effective_home: PathBuf::from("/test/home"),
            child_pid: Some(4321),
            stdin_tx,
            cancel_tx: Arc::new(tokio::sync::Mutex::new(Some(cancel_tx))),
            is_alive,
            terminal_emitted: Arc::new(AtomicBool::new(false)),
        });

        {
            let guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *guard {
                if current.is_alive.load(Ordering::SeqCst) {
                    assert_eq!(current.provider_id, "anthropic");
                }
            }
        }

        {
            let guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *guard {
                current.is_alive.store(false, Ordering::SeqCst);
            }
        }

        {
            let guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *guard {
                assert!(!current.is_alive.load(Ordering::SeqCst));
            }
        }
    }

    #[tokio::test]
    async fn test_silent_helper_cancellation() {
        let temp_dir = std::env::temp_dir();
        let silent_script = temp_dir.join("silent-oauth-cancel-test.mjs");
        std::fs::write(&silent_script, "setInterval(() => {}, 10000);").unwrap();

        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(&silent_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().expect("Spawn silent helper");
        let stdout = child.stdout.take().expect("Child stdout");

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let sink = Arc::new(MockOAuthEventSink::default());
        let is_alive = Arc::new(AtomicBool::new(true));
        let stderr_collector = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

        let terminal_emitted = Arc::new(AtomicBool::new(false));

        // Fire cancel_tx shortly after spawn while child is completely silent on stdout
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = cancel_tx.send(());
        });

        let (success, err) = supervise_oauth_login_child(
            child,
            stdout,
            cancel_rx,
            Duration::from_secs(10),
            sink.clone(),
            "anthropic".to_string(),
            is_alive.clone(),
            terminal_emitted.clone(),
            stderr_collector,
        )
        .await;

        assert!(success);
        assert!(err.is_none());
        assert!(!is_alive.load(Ordering::SeqCst));

        let _ = std::fs::remove_file(silent_script);
    }

    #[tokio::test]
    async fn test_silent_helper_timeout() {
        let temp_dir = std::env::temp_dir();
        let silent_script = temp_dir.join("silent-oauth-timeout-test.mjs");
        std::fs::write(&silent_script, "setInterval(() => {}, 10000);").unwrap();

        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(&silent_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().expect("Spawn silent helper");
        let stdout = child.stdout.take().expect("Child stdout");

        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let sink = Arc::new(MockOAuthEventSink::default());
        let is_alive = Arc::new(AtomicBool::new(true));
        let terminal_emitted = Arc::new(AtomicBool::new(false));
        let stderr_collector = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

        let (success, err) = supervise_oauth_login_child(
            child,
            stdout,
            cancel_rx,
            Duration::from_millis(50), // Short timeout
            sink.clone(),
            "anthropic".to_string(),
            is_alive.clone(),
            terminal_emitted.clone(),
            stderr_collector,
        )
        .await;

        assert!(!success);
        assert!(err.unwrap().contains("timed out"));
        assert!(!is_alive.load(Ordering::SeqCst));

        let _ = std::fs::remove_file(silent_script);
    }

    #[tokio::test]
    async fn test_get_builtin_oauth_providers_impl_mock_success_and_errors() {
        let temp_dir = std::env::temp_dir();
        let mock_helper = temp_dir.join("pi-oauth-mock-helper.mjs");

        let success_script = r#"
            const args = process.argv.slice(2);
            if (args.includes('list')) {
                console.log(JSON.stringify({
                    status: 'ok',
                    providers: [
                        {
                            id: 'anthropic',
                            name: 'Anthropic',
                            oauthName: 'Anthropic (Claude Pro/Max)',
                            loginLabel: null,
                            isSubscription: true,
                            configured: false,
                            hasStoredOAuth: false,
                            oauthReady: false,
                            ambientApiKey: false,
                            hasStoredOAuth: false,
                            oauthReady: false,
                            ambientApiKey: false,
                            source: null,
                            status: 'unconfigured'
                        }
                    ]
                }));
                process.exit(0);
            }
            process.exit(1);
        "#;
        std::fs::write(&mock_helper, success_script).unwrap();

        let node = PathBuf::from("node");
        let fake_entry = temp_dir.join("fake-entry.js");
        let fake_home = temp_dir.join("fake-home");

        let res = get_builtin_oauth_providers_impl(&node, &mock_helper, &fake_entry, &fake_home).await;
        assert!(res.is_ok(), "Mock list should succeed: {:?}", res.err());
        let list = res.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "anthropic");
        assert_eq!(list[0].name, "Anthropic");
        assert!(!list[0].configured);

        let error_script = r#"
            console.log(JSON.stringify({ status: 'error', error: 'Missing SDK' }));
            process.exit(1);
        "#;
        std::fs::write(&mock_helper, error_script).unwrap();
        let res_err = get_builtin_oauth_providers_impl(&node, &mock_helper, &fake_entry, &fake_home).await;
        assert!(res_err.is_err());
        assert!(res_err.unwrap_err().contains("Missing SDK"));

        let malformed_script = r#"
            console.log("Not JSON at all!");
            process.exit(0);
        "#;
        std::fs::write(&mock_helper, malformed_script).unwrap();
        let res_malformed = get_builtin_oauth_providers_impl(&node, &mock_helper, &fake_entry, &fake_home).await;
        assert!(res_malformed.is_err());

        let _ = std::fs::remove_file(mock_helper);
    }

    #[tokio::test]
    async fn test_logout_oauth_provider_impl_mock_success_and_error() {
        let temp_dir = std::env::temp_dir();
        let mock_helper = temp_dir.join("pi-oauth-mock-logout-helper.mjs");

        let success_script = r#"
            const args = process.argv.slice(2);
            if (args.includes('logout')) {
                console.log(JSON.stringify({ status: 'ok', providerId: 'anthropic' }));
                process.exit(0);
            }
            process.exit(1);
        "#;
        std::fs::write(&mock_helper, success_script).unwrap();

        let node = PathBuf::from("node");
        let fake_entry = temp_dir.join("fake-entry.js");
        let fake_home = temp_dir.join("fake-home");

        let res = logout_oauth_provider_impl(&node, &mock_helper, &fake_entry, &fake_home, "anthropic").await;
        assert!(res.is_ok());
        let logout_res = res.unwrap();
        assert!(logout_res.success);
        assert_eq!(logout_res.provider_id, "anthropic");

        let error_script = r#"
            console.log(JSON.stringify({ error: 'Storage locked' }));
            process.exit(1);
        "#;
        std::fs::write(&mock_helper, error_script).unwrap();
        let res_err = logout_oauth_provider_impl(&node, &mock_helper, &fake_entry, &fake_home, "anthropic").await;
        assert!(res_err.is_err());
        assert!(res_err.unwrap_err().contains("Storage locked"));

        let _ = std::fs::remove_file(mock_helper);
    }

    #[tokio::test]
    async fn test_live_helper_list_if_environment_discovered() {
        let discovered = crate::commands::discovery::discover_environment_impl(None, None, None);
        if let (Some(node_str), Some(entry_str)) = (discovered.node_path, discovered.entrypoint.path) {
            let helper_res = resolve_oauth_helper_path(None);
            if let Ok(helper_path) = helper_res {
                let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-{}", std::process::id()));
                let _ = std::fs::create_dir_all(&temp_dir);

                let node = PathBuf::from(node_str);
                let entry = PathBuf::from(entry_str);

                let providers = get_builtin_oauth_providers_impl(&node, &helper_path, &entry, &temp_dir).await;
                assert!(providers.is_ok(), "Live helper query should succeed: {:?}", providers.err());
                let list = providers.unwrap();
                assert!(!list.is_empty(), "Should discover built-in OAuth providers in Pi SDK");

                let ids: Vec<String> = list.iter().map(|p| p.id.clone()).collect();
                assert!(ids.contains(&"anthropic".to_string()));
                assert!(ids.contains(&"openai-codex".to_string()));
                assert!(ids.contains(&"github-copilot".to_string()));

                for p in &list {
                    assert!(!p.configured);
                    assert!(!p.has_stored_oauth);
                    assert!(!p.oauth_ready);
                }

                let _ = std::fs::remove_dir_all(temp_dir);
            }
        }
    }

    #[tokio::test]
    async fn test_live_helper_login_cancellation() {
        let discovered = crate::commands::discovery::discover_environment_impl(None, None, None);
        if let (Some(node_str), Some(entry_str)) = (discovered.node_path, discovered.entrypoint.path) {
            let helper_res = resolve_oauth_helper_path(None);
            if let Ok(helper_path) = helper_res {
                let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-cancel-{}", std::process::id()));
                let _ = std::fs::create_dir_all(&temp_dir);

                let mut cmd = tokio::process::Command::new(node_str);
                cmd.arg(helper_path)
                    .arg("login")
                    .arg("--entrypoint")
                    .arg(entry_str)
                    .arg("--home")
                    .arg(&temp_dir)
                    .arg("--provider")
                    .arg("anthropic")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                let mut child = cmd.spawn().expect("Spawn live login helper");
                let mut stdin = child.stdin.take().expect("Child stdin");
                let stdout = child.stdout.take().expect("Child stdout");

                let (_cancel_tx, cancel_rx) = oneshot::channel();
                let sink = Arc::new(MockOAuthEventSink::default());
                let is_alive = Arc::new(AtomicBool::new(true));
                let terminal_emitted = Arc::new(AtomicBool::new(false));
                let stderr_collector = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

                tokio::spawn(async move {
                    // Send cancel signal via stdin after short delay
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _ = stdin.write_all(b"{\"type\":\"cancel\"}\n").await;
                    let _ = stdin.flush().await;
                });

                let (success, _) = supervise_oauth_login_child(
                    child,
                    stdout,
                    cancel_rx,
                    Duration::from_secs(10),
                    sink.clone(),
                    "anthropic".to_string(),
                    is_alive.clone(),
                    terminal_emitted.clone(),
                    stderr_collector,
                )
                .await;

                assert!(success);
                let _ = std::fs::remove_dir_all(temp_dir);
            }
        }
    }

    #[test]
    fn test_validate_oauth_url_safe_schemes() {
        let valid_https = "https://accounts.google.com/o/oauth2/v2/auth?client_id=123&redirect_uri=http%3A%2F%2Flocalhost%3A8080";
        assert_eq!(validate_oauth_url(valid_https).unwrap(), valid_https);

        let valid_http_local = "http://localhost:8080/callback?state=xyz";
        assert_eq!(validate_oauth_url(valid_http_local).unwrap(), valid_http_local);

        let valid_ip = "http://127.0.0.1:3000/auth";
        assert_eq!(validate_oauth_url(valid_ip).unwrap(), valid_ip);
    }

    #[test]
    fn test_validate_oauth_url_unsafe_schemes_rejected() {
        assert!(validate_oauth_url("javascript:alert(1)").is_err());
        assert!(validate_oauth_url("javascript:window.open('evil')").is_err());
        assert!(validate_oauth_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(validate_oauth_url("file:///etc/passwd").is_err());
        assert!(validate_oauth_url("file://C:/Windows/System32").is_err());
        assert!(validate_oauth_url("mailto:attacker@example.com").is_err());
        assert!(validate_oauth_url("vbscript:msgbox(1)").is_err());
        assert!(validate_oauth_url("blob:https://example.com/uuid").is_err());
        assert!(validate_oauth_url("ftp://example.com/file").is_err());
        assert!(validate_oauth_url("").is_err());
        assert!(validate_oauth_url("   ").is_err());
    }

    #[test]
    fn test_validate_oauth_url_redacts_tokens_and_fragments() {
        let url_with_token = "https://auth.example.com/oauth?client_id=myclient&access_token=secret_val_123&refresh_token=secret_val_456&state=safe_state#access_token=frag_secret";
        let cleaned = validate_oauth_url(url_with_token).unwrap();

        assert!(!cleaned.contains("secret_val_123"));
        assert!(!cleaned.contains("secret_val_456"));
        assert!(!cleaned.contains("frag_secret"));
        assert!(cleaned.contains("access_token=REDACTED"));
        assert!(cleaned.contains("refresh_token=REDACTED"));
        assert!(cleaned.contains("client_id=myclient"));
        assert!(cleaned.contains("state=safe_state"));
        // Fragment containing token should be stripped
        assert!(!cleaned.contains("#access_token"));
    }

    #[test]
    fn test_validate_oauth_url_forbids_credentials_and_controls() {
        assert!(validate_oauth_url("https://user:pass@example.com/auth").is_err());
        assert!(validate_oauth_url("https://example.com/auth\0bad").is_err());
        assert!(validate_oauth_url("https://example.com/auth with space").is_err());
    }

    #[test]
    fn test_validate_oauth_url_preserves_id_token_add_organizations_parameter() {
        // Deterministic regression test for Pi OpenAI Codex OAuth URL mangling defect:
        // Query param id_token_add_organizations=true must be preserved and not redacted.
        let codex_auth_url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=PKCE_CHALLENGE_256&code_challenge_method=S256&state=state_secret_nonce&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=pi";
        let validated = validate_oauth_url(codex_auth_url).expect("Valid OpenAI Codex OAuth URL");

        assert!(
            validated.contains("id_token_add_organizations=true"),
            "id_token_add_organizations=true must be preserved exactly, got: {validated}"
        );
        assert!(!validated.contains("id_token_add_organizations=REDACTED"));
        assert!(!validated.contains("id_token_add_organizations=%5BREDACTED%5D"));
        assert!(validated.contains("response_type=code"));
        assert!(validated.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(validated.contains("codex_cli_simplified_flow=true"));
        assert!(validated.contains("originator=pi"));

        // Confirm that actual sensitive keys are still redacted while preserving id_token_add_organizations
        let mixed_url = "https://auth.openai.com/oauth/authorize?client_id=safe&client_secret=leak_secret_123&id_token_add_organizations=true";
        let mixed_validated = validate_oauth_url(mixed_url).expect("Valid URL with secret parameter");
        assert!(mixed_validated.contains("id_token_add_organizations=true"));
        assert!(!mixed_validated.contains("leak_secret_123"));
        assert!(mixed_validated.contains("client_secret=REDACTED"));
    }

    #[test]
    fn test_sanitize_oauth_text_redacts_tokens_and_html() {
        // Bearer token
        let bearer_text = "Authorization failed with Bearer ghp_1234567890abcdef1234567890abcdef";
        let sanitized = sanitize_oauth_text(bearer_text);
        assert!(!sanitized.contains("ghp_1234567890abcdef1234567890abcdef"));
        assert!(sanitized.contains("[REDACTED]"));

        // Key-value assignment
        let kv_text = "Details: access_token=my_secret_token_12345 and secret:shh_secret_value";
        let sanitized_kv = sanitize_oauth_text(kv_text);
        assert!(!sanitized_kv.contains("my_secret_token_12345"));
        assert!(!sanitized_kv.contains("shh_secret_value"));
        assert!(sanitized_kv.contains("[REDACTED]"));

        // JWT token
        let jwt_text = "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c expired";
        let sanitized_jwt = sanitize_oauth_text(jwt_text);
        assert!(!sanitized_jwt.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
        assert!(sanitized_jwt.contains("[REDACTED]"));

        // HTML tags
        let html_text = "<b>Notice:</b> Please visit <script>alert('bad')</script> to continue";
        let sanitized_html = sanitize_oauth_text(html_text);
        assert!(!sanitized_html.contains("<script>"));
        assert!(!sanitized_html.contains("<b>"));
        assert!(sanitized_html.contains("Notice: Please visit alert('bad') to continue"));
    }

    #[tokio::test]
    async fn test_handle_safe_oauth_frame_drops_unsafe_urls_and_redacts_messages() {
        let sink = MockOAuthEventSink::default();

        // 1. Unsafe javascript scheme AuthUrl -> dropped, not opened, not emitted
        let unsafe_frame = serde_json::json!({
            "type": "event",
            "event": {
                "type": "auth_url",
                "url": "javascript:window.open('https://attacker.com')",
                "instructions": "Click here"
            }
        });
        let action = handle_safe_oauth_frame(&unsafe_frame.to_string(), &sink, "anthropic").await;
        assert_eq!(action, FrameAction::Continue);
        assert!(sink.opened_urls.lock().await.is_empty());
        assert!(sink.events.lock().await.is_empty());

        // 2. Safe AuthUrl with sensitive token param -> opened with redaction, emitted with redaction
        let safe_with_token_frame = serde_json::json!({
            "type": "event",
            "event": {
                "type": "auth_url",
                "url": "https://accounts.google.com/oauth?client_id=safe&access_token=secret_leak",
                "instructions": "Sign in with access_token=secret_leak"
            }
        });
        let action2 = handle_safe_oauth_frame(&safe_with_token_frame.to_string(), &sink, "anthropic").await;
        assert_eq!(action2, FrameAction::Continue);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let opened = sink.opened_urls.lock().await.clone();
        assert_eq!(opened.len(), 1);
        assert!(!opened[0].contains("secret_leak"));
        assert!(opened[0].contains("REDACTED"));

        let events = sink.events.lock().await.clone();
        assert_eq!(events.len(), 1);
        let event_str = serde_json::to_string(&events[0].2).unwrap();
        assert!(!event_str.contains("secret_leak"));
        assert!(event_str.contains("[REDACTED]"));

        // 3. DeviceCode with file scheme -> dropped
        let bad_device_code = serde_json::json!({
            "type": "event",
            "event": {
                "type": "device_code",
                "userCode": "1234",
                "verificationUri": "file:///etc/hosts"
            }
        });
        sink.events.lock().await.clear();
        let action3 = handle_safe_oauth_frame(&bad_device_code.to_string(), &sink, "anthropic").await;
        assert_eq!(action3, FrameAction::Continue);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sink.events.lock().await.is_empty());

        // 4. Info event with unsafe link -> unsafe link filtered out
        let info_frame = serde_json::json!({
            "type": "event",
            "event": {
                "type": "info",
                "message": "Auth instructions Bearer secret_bearer_token",
                "links": [
                    { "url": "javascript:alert(1)", "label": "Evil link" },
                    { "url": "https://safe.example.com", "label": "Safe link" }
                ]
            }
        });
        sink.events.lock().await.clear();
        let action4 = handle_safe_oauth_frame(&info_frame.to_string(), &sink, "anthropic").await;
        assert_eq!(action4, FrameAction::Continue);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let events4 = sink.events.lock().await.clone();
        assert_eq!(events4.len(), 1);
        let info_str = serde_json::to_string(&events4[0].2).unwrap();
        assert!(!info_str.contains("secret_bearer_token"));
        assert!(!info_str.contains("javascript:alert(1)"));
        assert!(info_str.contains("https://safe.example.com"));

        // 5. Prompt with sensitive token in message -> redacted
        let prompt_frame = serde_json::json!({
            "type": "prompt",
            "prompt": {
                "promptId": "prompt-1",
                "promptType": "text",
                "message": "Enter code for access_token=secret_val"
            }
        });
        sink.events.lock().await.clear();
        let action5 = handle_safe_oauth_frame(&prompt_frame.to_string(), &sink, "anthropic").await;
        assert_eq!(action5, FrameAction::Continue);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let events5 = sink.events.lock().await.clone();
        assert_eq!(events5.len(), 1);
        let prompt_str = serde_json::to_string(&events5[0].2).unwrap();
        assert!(!prompt_str.contains("secret_val"));
        assert!(prompt_str.contains("[REDACTED]"));
    }

    #[tokio::test]
    async fn test_handle_safe_oauth_frame_preserves_openai_codex_url_semantics() {
        let sink = MockOAuthEventSink::default();
        let codex_url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=xyz&code_challenge_method=S256&state=abc&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=pi";
        let frame = serde_json::json!({
            "type": "event",
            "event": {
                "type": "auth_url",
                "url": codex_url,
                "instructions": "A browser window should open. Complete login to finish."
            }
        });

        let action = handle_safe_oauth_frame(&frame.to_string(), &sink, "openai-codex").await;
        assert_eq!(action, FrameAction::Continue);
        tokio::time::sleep(Duration::from_millis(50)).await;

        let opened = sink.opened_urls.lock().await.clone();
        assert_eq!(opened.len(), 1);
        assert!(
            opened[0].contains("id_token_add_organizations=true"),
            "Browser URL opened by Rust host must preserve id_token_add_organizations=true, got: {}",
            opened[0]
        );
        assert!(!opened[0].contains("id_token_add_organizations=REDACTED"));

        let events = sink.events.lock().await.clone();
        assert_eq!(events.len(), 1);
        let event_json = serde_json::to_string(&events[0].2).unwrap();
        assert!(
            event_json.contains("id_token_add_organizations=true"),
            "Emitted UI event must preserve id_token_add_organizations=true, got: {event_json}"
        );
        assert!(!event_json.contains("id_token_add_organizations=REDACTED"));
    }

    #[tokio::test]
    async fn test_handle_safe_oauth_frame_terminal_does_not_emit_status_prematurely() {
        let sink = MockOAuthEventSink::default();

        let success_action = handle_safe_oauth_frame(
            "{\"type\":\"success\",\"providerId\":\"anthropic\"}",
            &sink,
            "anthropic",
        )
        .await;
        assert_eq!(success_action, FrameAction::Success);
        // Status must NOT be emitted yet (waits for supervisor child exit)
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sink.statuses.lock().await.is_empty());

        let cancel_action = handle_safe_oauth_frame(
            "{\"type\":\"cancelled\",\"providerId\":\"anthropic\"}",
            &sink,
            "anthropic",
        )
        .await;
        assert_eq!(cancel_action, FrameAction::Cancelled);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sink.statuses.lock().await.is_empty());

        let error_action = handle_safe_oauth_frame(
            "{\"type\":\"error\",\"error\":\"Invalid Bearer secret_token\",\"providerId\":\"anthropic\"}",
            &sink,
            "anthropic",
        )
        .await;
        match error_action {
            FrameAction::Error(err) => {
                assert!(!err.contains("secret_token"));
                assert!(err.contains("[REDACTED]"));
            }
            _ => panic!("Expected FrameAction::Error"),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sink.statuses.lock().await.is_empty());
    }

    #[tokio::test]
    async fn test_terminal_status_only_after_successful_helper_exit() {
        let temp_dir = std::env::temp_dir();

        // 1. Success frame AND exit code 0 -> completed status emitted
        let success_script = temp_dir.join("test-helper-success-exit0.mjs");
        std::fs::write(&success_script, "console.log(JSON.stringify({ type: 'success', providerId: 'anthropic' })); process.exit(0);").unwrap();

        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(&success_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().expect("Spawn success exit 0 helper");
        let stdout = child.stdout.take().expect("Child stdout");

        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let sink = Arc::new(MockOAuthEventSink::default());
        let is_alive = Arc::new(AtomicBool::new(true));
        let terminal_emitted = Arc::new(AtomicBool::new(false));
        let stderr_collector = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

        let (success, err) = supervise_oauth_login_child(
            child,
            stdout,
            cancel_rx,
            Duration::from_secs(10),
            sink.clone(),
            "anthropic".to_string(),
            is_alive.clone(),
            terminal_emitted.clone(),
            stderr_collector,
        )
        .await;

        assert!(success);
        assert!(err.is_none());
        tokio::time::sleep(Duration::from_millis(50)).await;
        let statuses = sink.statuses.lock().await.clone();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].1, "completed");

        let _ = std::fs::remove_file(success_script);

        // 2. Success frame BUT exit code 1 (helper crash/failure) -> failed status, NEVER completed
        let crash_script = temp_dir.join("test-helper-success-crash-exit1.mjs");
        std::fs::write(&crash_script, "console.log(JSON.stringify({ type: 'success', providerId: 'anthropic' })); process.stderr.write('Fatal crash during auth write'); process.exit(1);").unwrap();

        let mut cmd2 = tokio::process::Command::new("node");
        cmd2.arg(&crash_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child2 = cmd2.spawn().expect("Spawn crash exit 1 helper");
        let stdout2 = child2.stdout.take().expect("Child stdout");
        let stderr2 = child2.stderr.take().expect("Child stderr");

        let (_cancel_tx2, cancel_rx2) = oneshot::channel();
        let sink2 = Arc::new(MockOAuthEventSink::default());
        let is_alive2 = Arc::new(AtomicBool::new(true));
        let terminal_emitted2 = Arc::new(AtomicBool::new(false));
        let stderr_collector2 = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

        let stderr_collector_clone2 = stderr_collector2.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr2);
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut guard = stderr_collector_clone2.lock().await;
                guard.push(&buf[..n]);
            }
        });

        let (success2, err2) = supervise_oauth_login_child(
            child2,
            stdout2,
            cancel_rx2,
            Duration::from_secs(10),
            sink2.clone(),
            "anthropic".to_string(),
            is_alive2.clone(),
            terminal_emitted2.clone(),
            stderr_collector2,
        )
        .await;

        assert!(!success2);
        assert!(err2.is_some());
        tokio::time::sleep(Duration::from_millis(50)).await;
        let statuses2 = sink2.statuses.lock().await.clone();
        assert_eq!(statuses2.len(), 1);
        assert_eq!(statuses2[0].1, "failed");
        assert!(statuses2[0].3.as_ref().unwrap().contains("Fatal crash"));

        let _ = std::fs::remove_file(crash_script);
    }

    #[test]
    fn test_payloads_do_not_contain_frontend_overrides() {
        // Payload structs must not accept or expose executable/home override fields
        let start_json = r#"{"providerId":"anthropic"}"#;
        let parsed_start: StartOAuthLoginPayload = serde_json::from_str(start_json).unwrap();
        assert_eq!(parsed_start.provider_id, "anthropic");

        let list_json = r#"{}"#;
        let parsed_list: GetBuiltinOAuthProvidersPayload = serde_json::from_str(list_json).unwrap();
        assert_eq!(parsed_list, GetBuiltinOAuthProvidersPayload {});

        let logout_json = r#"{"providerId":"anthropic"}"#;
        let parsed_logout: LogoutOAuthProviderPayload = serde_json::from_str(logout_json).unwrap();
        assert_eq!(parsed_logout.provider_id, "anthropic");
    }

    #[tokio::test]
    async fn test_cancellation_emitted_once_guard() {
        let (stdin_tx, _) = mpsc::channel(10);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let is_alive = Arc::new(AtomicBool::new(true));
        let terminal_emitted = Arc::new(AtomicBool::new(false));

        let mut session = ActiveOAuthSession {
            session_id: 1,
            provider_id: "anthropic".to_string(),
            effective_home: PathBuf::from("/test/home"),
            child_pid: Some(1234),
            stdin_tx,
            cancel_tx: Arc::new(tokio::sync::Mutex::new(Some(cancel_tx))),
            is_alive: is_alive.clone(),
            terminal_emitted: terminal_emitted.clone(),
        };

        // First cancellation succeeds
        assert!(session.cancel_and_terminate().await);
        // Second cancellation returns false (cancellation once)
        assert!(!session.cancel_and_terminate().await);

        // Supervisor with cancel_rx triggered emits status exactly once
        let temp_dir = std::env::temp_dir();
        let silent_script = temp_dir.join("test-cancel-once.mjs");
        std::fs::write(&silent_script, "setInterval(() => {}, 1000);").unwrap();

        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(&silent_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().expect("Spawn helper");
        let stdout = child.stdout.take().expect("Child stdout");
        let sink = Arc::new(MockOAuthEventSink::default());
        let stderr_collector = Arc::new(tokio::sync::Mutex::new(StderrCollector::new(MAX_STDERR_BYTES)));

        let (success, _) = supervise_oauth_login_child(
            child,
            stdout,
            cancel_rx,
            Duration::from_secs(5),
            sink.clone(),
            "anthropic".to_string(),
            is_alive.clone(),
            terminal_emitted.clone(),
            stderr_collector,
        )
        .await;

        assert!(success);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let statuses = sink.statuses.lock().await.clone();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].1, "cancelled");

        let _ = std::fs::remove_file(silent_script);
    }

    #[tokio::test]
    async fn test_concurrent_start_policy_with_app_state() {
        let state = AppState::new();
        let (stdin_tx, _) = mpsc::channel(1);
        let (cancel_tx, _) = oneshot::channel();
        let is_alive = Arc::new(AtomicBool::new(true));

        *state.active_oauth_login.lock().await = Some(ActiveOAuthSession {
            session_id: 1,
            provider_id: "anthropic".to_string(),
            effective_home: PathBuf::from("/test/home"),
            child_pid: Some(9999),
            stdin_tx,
            cancel_tx: Arc::new(tokio::sync::Mutex::new(Some(cancel_tx))),
            is_alive: is_alive.clone(),
            terminal_emitted: Arc::new(AtomicBool::new(false)),
        });

        // Simulating the check inside start_oauth_login
        let provider_id = "anthropic";
        let check_result = {
            let active_guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *active_guard {
                if current.is_alive.load(Ordering::SeqCst) {
                    if current.provider_id == provider_id {
                        Err(format!(
                            "OAuth login is already in progress for provider '{}'. Please complete or cancel it.",
                            provider_id
                        ))
                    } else {
                        Err(format!(
                            "Another OAuth login is already in progress for provider '{}'. Please complete or cancel it first.",
                            current.provider_id
                        ))
                    }
                } else {
                    Ok(())
                }
            } else {
                Ok(())
            }
        };

        assert!(check_result.is_err());
        assert!(check_result.unwrap_err().contains("already in progress for provider 'anthropic'"));

        // Another provider
        let other_provider_id = "github-copilot";
        let check_other = {
            let active_guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *active_guard {
                if current.is_alive.load(Ordering::SeqCst) {
                    if current.provider_id == other_provider_id {
                        Err(format!(
                            "OAuth login is already in progress for provider '{}'. Please complete or cancel it.",
                            other_provider_id
                        ))
                    } else {
                        Err(format!(
                            "Another OAuth login is already in progress for provider '{}'. Please complete or cancel it first.",
                            current.provider_id
                        ))
                    }
                } else {
                    Ok(())
                }
            } else {
                Ok(())
            }
        };

        assert!(check_other.is_err());
        assert!(check_other.unwrap_err().contains("Another OAuth login is already in progress for provider 'anthropic'"));
    }

    #[test]
    fn test_oauth_home_follows_validated_entrypoint_not_gentle_shell_installation() {
        let main = PathBuf::from("main-pi-home");
        let isolated = PathBuf::from("isolated-gentle-home");
        let homes = super::super::config_files::ResolvedGentleShellHomes {
            main_pi_home: main.clone(),
            effective_home: isolated.clone(),
            default_isolated_home: isolated.clone(),
            mode: super::super::config_files::GentleShellHomeMode::Isolated,
        };
        assert_eq!(oauth_home_for_entrypoint(Path::new("pi-entry.js"), &homes), main);
        assert_eq!(oauth_home_for_entrypoint(Path::new("gentle-shell.js"), &homes), isolated);
        assert_eq!(oauth_home_for_entrypoint(Path::new("gentle-shell.mjs"), &homes), isolated);

        let linked = super::super::config_files::ResolvedGentleShellHomes {
            effective_home: main.clone(),
            mode: super::super::config_files::GentleShellHomeMode::Link,
            ..homes
        };
        assert_eq!(oauth_home_for_entrypoint(Path::new("gentle-shell.cjs"), &linked), main);
    }

    #[tokio::test]
    async fn test_resolve_oauth_execution_environment_derives_from_session_and_settings() {
        let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-env-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let state = AppState::new();
        *state.active_cwd.lock().await = Some(temp_dir.clone());

        let fake_entry = temp_dir.join("pi-entry.js");
        std::fs::write(&fake_entry, "// console.log('pi');").unwrap();

        // Write trusted settings in <cwd>/.pi/settings.json
        let dot_pi = temp_dir.join(".pi");
        let _ = std::fs::create_dir_all(&dot_pi);
        let settings_file = dot_pi.join("settings.json");
        let settings_content = serde_json::json!({
            "piEntrypoint": fake_entry.to_string_lossy(),
            "nodePath": "node"
        });
        std::fs::write(&settings_file, settings_content.to_string()).unwrap();

        let resolved = resolve_oauth_execution_environment(&state).await;
        assert!(resolved.is_ok(), "Environment resolution should succeed: {:?}", resolved.err());
        let (node_path, entrypoint, home) = resolved.unwrap();
        assert_eq!(dunce::canonicalize(&fake_entry).unwrap(), entrypoint);
        assert!(!node_path.as_os_str().is_empty());
        assert!(!home.as_os_str().is_empty());

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn test_resolve_oauth_prefers_live_session_paths_without_pi_on_path_regression() {
        let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-live-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let fake_entry = temp_dir.join("live-pi-entry.js");
        std::fs::write(&fake_entry, "// live pi entry").unwrap();

        let state = AppState::new();
        let (stdin_tx, _stdin_rx) = mpsc::channel(16);
        let session = crate::process::ActiveSession {
            child_pid: Some(1111),
            generation: 1,
            cwd: temp_dir.clone(),
            stdin_tx,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("test-session".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(true)),
        };

        // Record execution paths exactly as ActiveSession::start does
        crate::process::record_session_paths(&temp_dir, Path::new("node"), &fake_entry, 1);

        state.sessions.lock().await.insert(temp_dir.clone(), session.clone());
        *state.active_cwd.lock().await = Some(temp_dir.clone());
        *state.session.lock().await = Some(session);

        // Note: No settings file exists in temp_dir (.pi/settings.json is absent),
        // and PATH does not contain our fake entrypoint.
        // Under the PRIOR behavior, discovery passed None for PATH and ignored
        // the active session, returning "Pi CLI entrypoint not found".
        // Now, it resolves directly from the live session.
        let resolved = resolve_oauth_execution_environment(&state).await;
        assert!(resolved.is_ok(), "Live session paths should resolve: {:?}", resolved.err());
        let (node_path, entrypoint, home) = resolved.unwrap();
        assert_eq!(entrypoint, fake_entry);
        assert_eq!(node_path, PathBuf::from("node"));
        assert!(!home.as_os_str().is_empty());

        // Prior behavior check: verify that when an active session is live but lacks provenance,
        // it fails closed with the expected error rather than silently switching SDK packages.
        crate::process::remove_session_paths(&temp_dir, 1);
        let unprovenanced_res = resolve_oauth_execution_environment(&state).await;
        assert!(unprovenanced_res.is_err(), "Live session without provenance must fail closed");
        assert!(
            unprovenanced_res.unwrap_err().contains("Active Pi session does not have validated execution provenance"),
            "Error must report missing provenance for live session"
        );

        // Fallback check: when NO live session exists at all and no PATH/settings exist,
        // discovery fails closed with "Pi CLI entrypoint not found" or "Node.js runtime executable was not found".
        let empty_state = AppState::new();
        *empty_state.active_cwd.lock().await = Some(temp_dir.clone());
        let fallback_without_pi = resolve_oauth_execution_environment(&empty_state).await;
        if fallback_without_pi.is_err() {
            let err = fallback_without_pi.unwrap_err();
            assert!(
                err.contains("Pi CLI entrypoint not found") || err.contains("Node.js runtime executable was not found"),
                "Fallback without live session should report missing entrypoint or Node: {err}"
            );
        }

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn test_resolve_oauth_fails_closed_when_live_session_lacks_provenance() {
        let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-unprov-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let state = AppState::new();
        let (stdin_tx, _) = mpsc::channel(16);
        let session = crate::process::ActiveSession {
            child_pid: Some(9999),
            generation: 1,
            cwd: temp_dir.clone(),
            stdin_tx,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("unprov-sess".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(true)),
        };

        // Note: record_session_paths is deliberately NOT called here.
        state.sessions.lock().await.insert(temp_dir.clone(), session.clone());
        *state.active_cwd.lock().await = Some(temp_dir.clone());
        *state.session.lock().await = Some(session);

        let res = resolve_oauth_execution_environment(&state).await;
        assert!(res.is_err(), "Must fail closed when live session has no provenance");
        let err = res.unwrap_err();
        assert!(
            err.contains("Active Pi session does not have validated execution provenance"),
            "Error should report missing provenance: {err}"
        );

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn test_resolve_oauth_multi_project_sessions_resolve_correct_paths() {
        let temp_dir_a = std::env::temp_dir().join(format!("pi-test-oauth-proj-a-{}", std::process::id()));
        let temp_dir_b = std::env::temp_dir().join(format!("pi-test-oauth-proj-b-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir_a);
        let _ = std::fs::create_dir_all(&temp_dir_b);

        let fake_entry_a = temp_dir_a.join("pi-a.js");
        let fake_entry_b = temp_dir_b.join("pi-b.js");
        std::fs::write(&fake_entry_a, "// entry A").unwrap();
        std::fs::write(&fake_entry_b, "// entry B").unwrap();

        let state = AppState::new();
        let (stdin_tx_a, _) = mpsc::channel(16);
        let (stdin_tx_b, _) = mpsc::channel(16);

        let session_a = crate::process::ActiveSession {
            child_pid: Some(1001),
            generation: 1,
            cwd: temp_dir_a.clone(),
            stdin_tx: stdin_tx_a,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("sess-a".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(true)),
        };

        let session_b = crate::process::ActiveSession {
            child_pid: Some(1002),
            generation: 2,
            cwd: temp_dir_b.clone(),
            stdin_tx: stdin_tx_b,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("sess-b".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(true)),
        };

        crate::process::record_session_paths(&temp_dir_a, Path::new("node-a"), &fake_entry_a, 1);
        crate::process::record_session_paths(&temp_dir_b, Path::new("node-b"), &fake_entry_b, 2);

        state.sessions.lock().await.insert(temp_dir_a.clone(), session_a.clone());
        state.sessions.lock().await.insert(temp_dir_b.clone(), session_b.clone());

        // Focus Project A
        *state.active_cwd.lock().await = Some(temp_dir_a.clone());
        *state.session.lock().await = Some(session_a);
        let res_a = resolve_oauth_execution_environment(&state).await.expect("Project A should resolve");
        assert_eq!(res_a.0, PathBuf::from("node-a"));
        assert_eq!(res_a.1, fake_entry_a);

        // Switch focus to Project B
        *state.active_cwd.lock().await = Some(temp_dir_b.clone());
        *state.session.lock().await = Some(session_b);
        let res_b = resolve_oauth_execution_environment(&state).await.expect("Project B should resolve");
        assert_eq!(res_b.0, PathBuf::from("node-b"));
        assert_eq!(res_b.1, fake_entry_b);

        crate::process::remove_session_paths(&temp_dir_a, 1);
        crate::process::remove_session_paths(&temp_dir_b, 2);
        let _ = std::fs::remove_dir_all(temp_dir_a);
        let _ = std::fs::remove_dir_all(temp_dir_b);
    }

    #[tokio::test]
    async fn test_resolve_oauth_fallback_to_os_path_when_no_live_session() {
        let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-fallback-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let state = AppState::new();
        *state.active_cwd.lock().await = Some(temp_dir.clone());

        let res = resolve_oauth_execution_environment(&state).await;
        // Either succeeds (if Pi and Node are on system PATH) or returns honest error without absolute paths
        match res {
            Ok((node, entry, home)) => {
                assert!(!node.as_os_str().is_empty());
                assert!(entry.is_file());
                assert!(!home.as_os_str().is_empty());
            }
            Err(e) => {
                assert!(
                    e.contains("Pi CLI entrypoint not found")
                        || e.contains("trusted settings")
                        || e.contains("Node.js runtime executable was not found"),
                    "Error must be an informative diagnostic: {e}"
                );
                assert!(!is_absolute_path(&e), "Error should not expose raw absolute paths: {e}");
            }
        }

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn test_resolve_oauth_disconnected_a_does_not_fall_back_to_live_b() {
        let temp_dir_a = std::env::temp_dir().join(format!("pi-test-oauth-disc-a-{}", std::process::id()));
        let temp_dir_b = std::env::temp_dir().join(format!("pi-test-oauth-disc-b-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir_a);
        let _ = std::fs::create_dir_all(&temp_dir_b);

        let fake_entry_a = temp_dir_a.join("pi-a.js");
        let fake_entry_b = temp_dir_b.join("pi-b.js");
        std::fs::write(&fake_entry_a, "// entry A").unwrap();
        std::fs::write(&fake_entry_b, "// entry B").unwrap();

        // Write Project A settings so Project A can be resolved when disconnected
        let dot_pi_a = temp_dir_a.join(".pi");
        let _ = std::fs::create_dir_all(&dot_pi_a);
        let settings_file_a = dot_pi_a.join("settings.json");
        let settings_content_a = serde_json::json!({
            "piEntrypoint": fake_entry_a.to_string_lossy(),
            "nodePath": "node"
        });
        std::fs::write(&settings_file_a, settings_content_a.to_string()).unwrap();

        let state = AppState::new();
        let (stdin_tx_a, _) = mpsc::channel(16);
        let (stdin_tx_b, _) = mpsc::channel(16);

        // Session A is DISCONNECTED (is_alive = false)
        let session_a = crate::process::ActiveSession {
            child_pid: Some(2001),
            generation: 1,
            cwd: temp_dir_a.clone(),
            stdin_tx: stdin_tx_a,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("sess-a-dead".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(false)),
        };

        // Session B is ALIVE (is_alive = true)
        let session_b = crate::process::ActiveSession {
            child_pid: Some(2002),
            generation: 2,
            cwd: temp_dir_b.clone(),
            stdin_tx: stdin_tx_b,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("sess-b-live".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(true)),
        };

        // Record execution paths for Session B
        crate::process::record_session_paths(&temp_dir_b, Path::new("node-b"), &fake_entry_b, 2);

        state.sessions.lock().await.insert(temp_dir_a.clone(), session_a);
        state.sessions.lock().await.insert(temp_dir_b.clone(), session_b.clone());

        // Target project A is explicitly selected
        *state.active_cwd.lock().await = Some(temp_dir_a.clone());

        // Note: AppState::get_session() would fall back to Session B because Session A is dead.
        // However, resolve_oauth_execution_environment MUST NOT cross-route to Project B's session or home!
        let res = resolve_oauth_execution_environment(&state).await.expect("Resolution for A should succeed via A's settings");
        let (_node, entry, home) = res;

        // Verify entrypoint is A's entrypoint, NOT B's entrypoint
        assert_eq!(entry, dunce::canonicalize(&fake_entry_a).unwrap());
        assert_ne!(entry, fake_entry_b, "Must NOT cross-route to Project B's entrypoint");

        // Verify effective home is A's home, NOT B's home
        let expected_home_a = resolve_oauth_home(&fake_entry_a, &temp_dir_a);
        let expected_home_b = resolve_oauth_home(&fake_entry_b, &temp_dir_b);
        assert_eq!(home, expected_home_a);
        if expected_home_a != expected_home_b {
            assert_ne!(home, expected_home_b, "Must NOT cross-route to Project B's effective home");
        }

        // Also verify: if Project A has neither settings nor live session,
        // it resolves via system PATH for A or fails closed, but NEVER routes to Project B.
        let _ = std::fs::remove_file(&settings_file_a);
        let fallback_res = resolve_oauth_execution_environment(&state).await;
        match fallback_res {
            Ok((_n, entry, home)) => {
                assert_ne!(entry, fake_entry_b, "Must NOT cross-route to Project B's entrypoint");
                assert_eq!(home, expected_home_a, "Must use Project A's effective home");
            }
            Err(err_text) => {
                assert!(
                    err_text.contains("Pi CLI entrypoint not found") || err_text.contains("Node.js runtime executable was not found"),
                    "Error should reflect A's missing environment, got: {err_text}"
                );
            }
        }

        crate::process::remove_session_paths(&temp_dir_b, 2);
        let _ = std::fs::remove_dir_all(temp_dir_a);
        let _ = std::fs::remove_dir_all(temp_dir_b);
    }

    #[tokio::test]
    async fn test_resolve_oauth_unambiguous_live_session_when_no_active_cwd() {
        let temp_dir_b = std::env::temp_dir().join(format!("pi-test-oauth-unamb-b-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir_b);
        let fake_entry_b = temp_dir_b.join("pi-b.js");
        std::fs::write(&fake_entry_b, "// entry B").unwrap();

        let state = AppState::new();
        let (stdin_tx_b, _) = mpsc::channel(16);
        let session_b = crate::process::ActiveSession {
            child_pid: Some(3002),
            generation: 2,
            cwd: temp_dir_b.clone(),
            stdin_tx: stdin_tx_b,
            pending_responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stderr_collector: Arc::new(tokio::sync::Mutex::new(crate::process::StderrCollector::new(1024))),
            abort_kill_tx: Arc::new(tokio::sync::Mutex::new(None)),
            child_reap_rx: Arc::new(tokio::sync::Mutex::new(None)),
            current_session_id: Arc::new(tokio::sync::Mutex::new(Some("sess-b-unamb".to_string()))),
            current_session_file: Arc::new(tokio::sync::Mutex::new(None)),
            is_alive: Arc::new(AtomicBool::new(true)),
        };

        crate::process::record_session_paths(&temp_dir_b, Path::new("node-b"), &fake_entry_b, 2);
        state.sessions.lock().await.insert(temp_dir_b.clone(), session_b.clone());

        // active_cwd is explicitly None
        *state.active_cwd.lock().await = None;

        // Exactly one live session exists -> resolves Session B
        let res = resolve_oauth_execution_environment(&state).await.expect("Unambiguous live session should resolve");
        assert_eq!(res.1, fake_entry_b);

        crate::process::remove_session_paths(&temp_dir_b, 2);
        let _ = std::fs::remove_dir_all(temp_dir_b);
    }

    #[tokio::test]
    async fn test_resolve_oauth_error_redacts_absolute_paths() {
        let temp_dir = std::env::temp_dir().join(format!("pi-test-oauth-redact-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let state = AppState::new();
        *state.active_cwd.lock().await = Some(temp_dir.clone());

        // Write an invalid entrypoint path (non-existent file with .js extension) in settings
        let dot_pi = temp_dir.join(".pi");
        let _ = std::fs::create_dir_all(&dot_pi);
        let settings_file = dot_pi.join("settings.json");
        let non_existent_entry = temp_dir.join("non_existent_entry.js");
        let settings_content = serde_json::json!({
            "piEntrypoint": non_existent_entry.to_string_lossy(),
            "nodePath": "node"
        });
        std::fs::write(&settings_file, settings_content.to_string()).unwrap();

        let res = resolve_oauth_execution_environment(&state).await;
        assert!(res.is_err());
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("[REDACTED]"), "Error should redact absolute path: {err_msg}");
        assert!(
            !err_msg.contains(&non_existent_entry.to_string_lossy().to_string()),
            "Error must not leak raw absolute path: {err_msg}"
        );

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn test_stale_supervisor_cleanup_does_not_clobber_new_session() {
        let state = AppState::new();
        let (_stdin_tx1, _) = mpsc::channel::<String>(1);
        let (_cancel_tx1, _) = oneshot::channel::<()>();
        let is_alive1 = Arc::new(AtomicBool::new(false)); // Old session ended
        let session_id1 = next_oauth_session_id();

        let (stdin_tx2, _) = mpsc::channel::<String>(1);
        let (cancel_tx2, _) = oneshot::channel::<()>();
        let is_alive2 = Arc::new(AtomicBool::new(true)); // New session actively running
        let session_id2 = next_oauth_session_id();
        assert_ne!(session_id1, session_id2);

        // Session 2 is currently registered in state
        *state.active_oauth_login.lock().await = Some(ActiveOAuthSession {
            session_id: session_id2,
            provider_id: "anthropic".to_string(),
            effective_home: PathBuf::from("/test/home"),
            child_pid: Some(2222),
            stdin_tx: stdin_tx2,
            cancel_tx: Arc::new(tokio::sync::Mutex::new(Some(cancel_tx2))),
            is_alive: is_alive2.clone(),
            terminal_emitted: Arc::new(AtomicBool::new(false)),
        });

        // Stale supervisor for Session 1 attempts cleanup
        {
            let mut guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *guard {
                if current.session_id == session_id1 && Arc::ptr_eq(&current.is_alive, &is_alive1) {
                    *guard = None;
                }
            }
        }

        // Verify that Session 2 was NOT clobbered by Session 1's supervisor cleanup
        {
            let guard = state.active_oauth_login.lock().await;
            assert!(guard.is_some(), "Session 2 must NOT be clobbered by stale supervisor cleanup");
            let current = guard.as_ref().unwrap();
            assert_eq!(current.session_id, session_id2);
            assert_eq!(current.provider_id, "anthropic");
            assert!(current.is_alive.load(Ordering::SeqCst));
        }

        // Now supervisor for Session 2 performs cleanup
        {
            let mut guard = state.active_oauth_login.lock().await;
            if let Some(ref current) = *guard {
                if current.session_id == session_id2 && Arc::ptr_eq(&current.is_alive, &is_alive2) {
                    *guard = None;
                }
            }
        }

        // Verify that Session 2 is now cleanly removed
        {
            let guard = state.active_oauth_login.lock().await;
            assert!(guard.is_none(), "Session 2 should be cleaned up by its own supervisor");
        }
    }

    #[tokio::test]
    async fn test_logout_during_login_raced_writes_prevented() {
        let (stdin_tx, _) = mpsc::channel::<String>(1);
        let (cancel_tx, _) = oneshot::channel();
        let is_alive = Arc::new(AtomicBool::new(true));

        let active_session = ActiveOAuthSession {
            session_id: 100,
            provider_id: "anthropic".to_string(),
            effective_home: PathBuf::from("/test/home"),
            child_pid: Some(3333),
            stdin_tx,
            cancel_tx: Arc::new(tokio::sync::Mutex::new(Some(cancel_tx))),
            is_alive: is_alive.clone(),
            terminal_emitted: Arc::new(AtomicBool::new(false)),
        };

        // 1. Same-provider logout rejected while login is active
        let err_same = ensure_logout_allowed(Some(&active_session), "anthropic").unwrap_err();
        assert!(
            err_same.contains("Cannot log out while an OAuth login is in progress for provider 'anthropic'"),
            "Expected same-provider rejection message, got: {err_same}"
        );

        // 2. Different-provider logout rejected while login is active to prevent racing auth.json writes
        let err_diff = ensure_logout_allowed(Some(&active_session), "github-copilot").unwrap_err();
        assert!(
            err_diff.contains("Cannot log out of provider 'github-copilot' while an OAuth login is in progress for provider 'anthropic'"),
            "Expected diff-provider rejection message, got: {err_diff}"
        );

        // 3. When login has completed (is_alive = false), logout is allowed
        is_alive.store(false, Ordering::SeqCst);
        let ok_dead = ensure_logout_allowed(Some(&active_session), "anthropic");
        assert!(ok_dead.is_ok(), "Logout should be allowed when session is no longer alive");

        // 4. When no login session exists, logout is allowed
        let ok_none = ensure_logout_allowed(None, "anthropic");
        assert!(ok_none.is_ok(), "Logout should be allowed when no active session exists");
    }

    #[test]
    fn test_sanitize_oauth_error_redacts_stack_and_absolute_paths() {
        // Node.js stack trace with absolute paths should discard stack frames and keep only error
        let v8_stack = "Error: OAuth token exchange failed\n    at Object.<anonymous> (/Users/username/pi/dist/oauth-client.js:142:15)\n    at async runLogin (/Users/username/pi/pi-oauth-helper.mjs:350:5)";
        let sanitized = sanitize_oauth_error(v8_stack);
        assert_eq!(sanitized, "Error: OAuth token exchange failed");
        assert!(!sanitized.contains("/Users/username"));
        assert!(!sanitized.contains("at Object."));

        // Node.js unhandled crash format (file location, code snippet, caret, error, stack)
        let unhandled_crash = "/Users/alice/projects/pi/pi-oauth-helper.mjs:42\nthrow new Error('EACCES: permission denied');\n^\n\nError: EACCES: permission denied\n    at run (/Users/alice/projects/pi/pi-oauth-helper.mjs:42:11)";
        let sanitized_crash = sanitize_oauth_error(unhandled_crash);
        assert_eq!(sanitized_crash, "Error: EACCES: permission denied");
        assert!(!sanitized_crash.contains("/Users/alice"));

        // Stack-only trace should fail closed to default message
        let stack_only = "    at /Users/username/pi/dist/index.js:12:34\n    at Module._compile (internal/modules/cjs/loader.js:723:30)";
        assert_eq!(sanitize_oauth_error(stack_only), "Authentication operation failed");

        // Windows absolute paths in error messages must be redacted
        let win_err = "Error: EACCES: permission denied, open 'C:\\Users\\Bob\\AppData\\Local\\pi\\auth.json'";
        let sanitized_win = sanitize_oauth_error(win_err);
        assert_eq!(sanitized_win, "Error: EACCES: permission denied, open '[REDACTED]'");
        assert!(!sanitized_win.contains("C:\\Users\\Bob"));

        // Unix absolute path in error messages must be redacted
        let unix_err = "Error: Cannot find module '/Users/carol/projects/pi/pi-oauth-helper.mjs'";
        let sanitized_unix = sanitize_oauth_error(unix_err);
        assert_eq!(sanitized_unix, "Error: Cannot find module '[REDACTED]'");
        assert!(!sanitized_unix.contains("/Users/carol"));

        // Unquoted paths must be redacted
        let unquoted_err = "Failed to open /var/log/pi/auth.json: permission denied";
        let sanitized_unquoted = sanitize_oauth_error(unquoted_err);
        assert_eq!(sanitized_unquoted, "Failed to open [REDACTED]: permission denied");
        assert!(!sanitized_unquoted.contains("/var/log"));

        // Require stack format
        let require_stack = "Error: Cannot find module 'dep'\nRequire stack:\n- /home/dan/pi/helper.mjs\n- /home/dan/pi/index.js";
        let sanitized_req = sanitize_oauth_error(require_stack);
        assert_eq!(sanitized_req, "Error: Cannot find module 'dep'");
        assert!(!sanitized_req.contains("/home/dan"));

        // Windows UNC path
        let unc_err = "Error: Failed to access \\\\server\\share\\pi\\auth.json";
        let sanitized_unc = sanitize_oauth_error(unc_err);
        assert_eq!(sanitized_unc, "Error: Failed to access [REDACTED]");

        // Preserves HTTP URLs without redacting them as file paths
        let url_err = "Error: Request to https://accounts.google.com/o/oauth2/token timed out";
        let sanitized_url = sanitize_oauth_error(url_err);
        assert!(sanitized_url.contains("https://accounts.google.com/o/oauth2/token"));
    }

    #[test]
    fn test_redact_absolute_paths_various_formats() {
        assert_eq!(is_absolute_path("/Users/alice/app.js"), true);
        assert_eq!(is_absolute_path("C:\\Users\\Bob\\app.js"), true);
        assert_eq!(is_absolute_path("c:/users/bob/app.js"), true);
        assert_eq!(is_absolute_path("\\\\server\\share\\file.js"), true);
        assert_eq!(is_absolute_path("\\\\?\\C:\\Users\\Bob\\file.js"), true);
        assert_eq!(is_absolute_path("https://example.com/file"), false);
        assert_eq!(is_absolute_path("relative/path/file.js"), false);
        assert_eq!(is_absolute_path("anthropic"), false);

        assert_eq!(is_stack_trace_line("    at Object.<anonymous> (/app.js:1:2)"), true);
        assert_eq!(is_stack_trace_line("at Module._compile (loader.js:10:5)"), true);
        assert_eq!(is_stack_trace_line("Require stack:"), true);
        assert_eq!(is_stack_trace_line("- /Users/alice/app.js"), true);
        assert_eq!(is_stack_trace_line("   ^"), true);
        assert_eq!(is_stack_trace_line("/Users/alice/app.js:10"), true);
        assert_eq!(is_stack_trace_line("C:\\Users\\alice\\app.js:10:20"), true);
        assert_eq!(is_stack_trace_line("Line 1"), false);
        assert_eq!(is_stack_trace_line("Error: Something failed"), false);
    }
}
