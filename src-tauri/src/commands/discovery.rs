//! Host environment discovery for Pi connection startup.
//!
//! Discovers the actual Pi CLI JavaScript entrypoint and verified initial working directory.
//! Operates cross-platform without invoking a shell or assuming hardcoded per-user paths.
//! Uses bounded PATH resolution and explicit package installation evidence; returns
//! explicit 'discovered', 'missing', or 'ambiguous' status instead of guessing.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Status for individual discovered components
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryStatus {
    Discovered,
    Missing,
    Ambiguous,
}

/// Overall environment readiness status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentStatus {
    Ready,
    Missing,
    Ambiguous,
}

/// Optional input payload for environment discovery
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverEnvironmentPayload {
    pub preferred_entrypoint: Option<String>,
    pub preferred_cwd: Option<String>,
}

/// Discovered Pi CLI JavaScript entrypoint details
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredEntrypoint {
    pub status: DiscoveryStatus,
    pub path: Option<String>,
    pub candidates: Vec<String>,
    pub message: Option<String>,
}

/// Discovered initial working directory details
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDirectory {
    pub status: DiscoveryStatus,
    pub path: Option<String>,
    pub message: Option<String>,
}

/// Result for detecting Gentle Shell from gentle-pi package metadata
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectGentleShellResult {
    pub status: DiscoveryStatus,
    pub path: Option<String>,
    pub entrypoint: Option<String>,
    pub candidates: Vec<String>,
    pub message: Option<String>,
}

/// Optional input payload for Gentle Shell detection
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectGentleShellPayload {
    pub cwd: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
}

/// Complete discovered environment result
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredEnvironment {
    pub status: EnvironmentStatus,
    pub entrypoint: DiscoveredEntrypoint,
    pub initial_directory: DiscoveredDirectory,
    pub node_path: Option<String>,
    pub issues: Vec<String>,
}

/// Check if a path has a JavaScript extension (.js, .mjs, .cjs)
pub fn has_js_extension(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ext == "js" || ext == "mjs" || ext == "cjs"
}

/// Verify if a path represents a credible Pi CLI entrypoint.
/// Requires existing file with JS extension and corroborating package evidence.
pub fn is_credible_pi_entrypoint(path: &Path) -> bool {
    if !path.exists() || !path.is_file() || !has_js_extension(path) {
        return false;
    }

    // Path string evidence
    let path_str = path.to_string_lossy().to_ascii_lowercase();
    if path_str.contains("@earendil-works/pi-coding-agent")
        || path_str.contains("@earendil-works\\pi-coding-agent")
        || path_str.contains("@earendil-works+pi-coding-agent")
        || path_str.contains("pi-coding-agent")
    {
        return true;
    }

    // Parent directory package.json evidence (up to 3 levels)
    let mut curr = path.parent();
    for _ in 0..3 {
        if let Some(dir) = curr {
            let pkg_path = dir.join("package.json");
            if pkg_path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&pkg_path) {
                    if content.contains("\"@earendil-works/pi-coding-agent\"")
                        || content.contains("\"pi-coding-agent\"")
                    {
                        return true;
                    }
                }
            }
            curr = dir.parent();
        } else {
            break;
        }
    }

    false
}

/// Resolve a candidate string from a shim relative to the shim's directory.
/// Normalizes Windows/POSIX separators safely without OS-dependent string slicing.
fn resolve_shim_target(shim_dir: &Path, raw: &str) -> Option<PathBuf> {
    let clean = raw.trim().trim_matches('"').trim_matches('\'');
    if clean.is_empty() {
        return None;
    }
    let normalized = clean.replace('\\', "/");
    let rel_target = normalized
        .trim_start_matches("%~dp0/")
        .trim_start_matches("%dp0%/")
        .trim_start_matches("$basedir_win/")
        .trim_start_matches("$basedir/")
        .trim_start_matches("$(dirname \"$0\")/");

    let candidate = PathBuf::from(rel_target);
    if candidate.is_absolute() {
        Some(candidate)
    } else {
        Some(shim_dir.join(candidate))
    }
}

/// Extract candidate JS entrypoint path from a shim or wrapper script.
pub fn extract_js_from_shim(shim_path: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(shim_path).ok()?;
    if bytes.len() > 32 * 1024 {
        return None;
    }
    let content = String::from_utf8_lossy(&bytes);
    let shim_dir = shim_path.parent().unwrap_or_else(|| Path::new("."));

    // 1. Check for explicit cmd-shim-target comment (npm/pnpm/yarn convention)
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(target_raw) = trimmed.strip_prefix("# cmd-shim-target=") {
            if let Some(p) = resolve_shim_target(shim_dir, target_raw) {
                if is_credible_pi_entrypoint(&p) {
                    return dunce::canonicalize(&p).ok();
                }
            }
        }
    }

    // 2. Scan lines containing pi-coding-agent for quoted or whitespace-delimited tokens
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.contains("pi-coding-agent") {
            continue;
        }

        // Check double and single quoted strings
        for quote_char in ['"', '\''] {
            let parts: Vec<&str> = trimmed.split(quote_char).collect();
            for (idx, part) in parts.iter().enumerate() {
                if idx % 2 == 1 && has_js_extension(Path::new(part)) {
                    if let Some(p) = resolve_shim_target(shim_dir, part) {
                        if is_credible_pi_entrypoint(&p) {
                            return dunce::canonicalize(&p).ok();
                        }
                    }
                }
            }
        }

        // Check whitespace-separated words
        for word in trimmed.split_whitespace() {
            let clean = word.trim_matches('"').trim_matches('\'');
            if has_js_extension(Path::new(clean)) {
                if let Some(p) = resolve_shim_target(shim_dir, clean) {
                    if is_credible_pi_entrypoint(&p) {
                        return dunce::canonicalize(&p).ok();
                    }
                }
            }
        }
    }

    None
}

/// Search bounded PATH entries for Pi CLI candidates
pub fn search_path_for_pi(path_var: Option<&str>) -> Vec<PathBuf> {
    let Some(raw_path) = path_var else {
        return Vec::new();
    };

    #[cfg(windows)]
    let candidate_names = &["pi.cmd", "pi.exe", "pi.bat", "pi.ps1", "pi"];
    #[cfg(all(not(windows), test))]
    let candidate_names = &["pi", "pi.cmd", "pi.exe", "pi.bat", "pi.ps1"];
    #[cfg(all(not(windows), not(test)))]
    let candidate_names = &["pi"];

    let mut found = Vec::new();
    for dir in std::env::split_paths(raw_path).take(64) {
        if !dir.is_dir() {
            continue;
        }
        for &name in candidate_names {
            let file = dir.join(name);
            if !file.is_file() {
                continue;
            }

            // Direct JS file or symlink to JS file
            if let Ok(canon) = dunce::canonicalize(&file) {
                if has_js_extension(&canon) && is_credible_pi_entrypoint(&canon) {
                    found.push(canon);
                    continue;
                }
            }

            // Script shim pointing to JS file
            if let Some(target) = extract_js_from_shim(&file) {
                found.push(target);
            }
        }
    }
    found
}

/// Verify if a directory contains credible project markers (git, package.json, Cargo.toml, .pi)
pub fn is_verified_project_dir(dir: &Path) -> bool {
    if !dir.exists() || !dir.is_dir() {
        return false;
    }
    dir.join(".git").exists()
        || dir.join(".pi").is_dir()
        || dir.join("package.json").is_file()
        || dir.join("Cargo.toml").is_file()
        || dir.join("pyproject.toml").is_file()
        || dir.join("go.mod").is_file()
}

/// Discover node executable on PATH
pub fn discover_node_path(path_var: Option<&str>) -> Option<String> {
    let raw = path_var?;
    #[cfg(windows)]
    let names = &["node.exe", "node.cmd", "node.bat"];
    #[cfg(all(not(windows), test))]
    let names = &["node", "node.exe", "node.cmd", "node.bat"];
    #[cfg(all(not(windows), not(test)))]
    let names = &["node"];

    for dir in std::env::split_paths(raw).take(64) {
        for &name in names {
            if dir.join(name).is_file() {
                return Some("node".to_string());
            }
        }
    }
    None
}

/// Resolve Pi CLI entrypoint candidate or report explicit missing/ambiguous status
fn resolve_entrypoint(
    preferred_entrypoint: Option<&str>,
    path_var: Option<&str>,
) -> DiscoveredEntrypoint {
    // 1. Explicitly preferred entrypoint
    if let Some(pref) = preferred_entrypoint {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.is_absolute() && is_credible_pi_entrypoint(&p) {
                let canon = dunce::canonicalize(&p).unwrap_or(p);
                let path_str = canon.to_string_lossy().to_string();
                return DiscoveredEntrypoint {
                    status: DiscoveryStatus::Discovered,
                    path: Some(path_str.clone()),
                    candidates: vec![path_str],
                    message: None,
                };
            }
            return DiscoveredEntrypoint {
                status: DiscoveryStatus::Missing,
                path: None,
                candidates: Vec::new(),
                message: Some(format!("Specified Pi CLI entrypoint is invalid: {trimmed}")),
            };
        }
    }

    // 2. Discover candidates from system PATH
    let raw_candidates = search_path_for_pi(path_var);
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for c in raw_candidates {
        let path_str = dunce::canonicalize(&c).unwrap_or(c).to_string_lossy().to_string();
        if seen.insert(path_str.clone()) {
            deduped.push(path_str);
        }
    }

    match deduped.len() {
        0 => DiscoveredEntrypoint {
            status: DiscoveryStatus::Missing,
            path: None,
            candidates: Vec::new(),
            message: Some("Pi CLI was not found on system PATH".to_string()),
        },
        1 => DiscoveredEntrypoint {
            status: DiscoveryStatus::Discovered,
            path: Some(deduped[0].clone()),
            candidates: deduped,
            message: None,
        },
        _ => DiscoveredEntrypoint {
            status: DiscoveryStatus::Ambiguous,
            path: None,
            candidates: deduped,
            message: Some("Multiple Pi CLI installations found on PATH; please select one".to_string()),
        },
    }
}

/// Resolve initial working directory or report explicit missing status (no guessing)
fn resolve_initial_directory(
    preferred_cwd: Option<&str>,
    current_dir: Option<&Path>,
) -> DiscoveredDirectory {
    // 1. Explicitly preferred directory
    if let Some(pref) = preferred_cwd {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.exists() && p.is_dir() {
                let canon = dunce::canonicalize(&p).unwrap_or(p);
                return DiscoveredDirectory {
                    status: DiscoveryStatus::Discovered,
                    path: Some(canon.to_string_lossy().to_string()),
                    message: None,
                };
            }
            return DiscoveredDirectory {
                status: DiscoveryStatus::Missing,
                path: None,
                message: Some(format!("Specified working directory does not exist: {trimmed}")),
            };
        }
    }

    // 2. Verified current_dir (strictly requires explicit project markers)
    if let Some(cwd) = current_dir {
        if is_verified_project_dir(cwd) {
            let canon = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
            return DiscoveredDirectory {
                status: DiscoveryStatus::Discovered,
                path: Some(canon.to_string_lossy().to_string()),
                message: None,
            };
        }
    }

    // 3. Explicit missing
    DiscoveredDirectory {
        status: DiscoveryStatus::Missing,
        path: None,
        message: Some("No verified project directory detected; please select a project folder".to_string()),
    }
}

/// Pure environment discovery implementation without OS side effects or shell execution
pub fn discover_environment_impl(
    path_var: Option<&str>,
    current_dir: Option<&Path>,
    payload: Option<&DiscoverEnvironmentPayload>,
) -> DiscoveredEnvironment {
    let mut issues = Vec::new();

    let pref_entry = payload.and_then(|p| p.preferred_entrypoint.as_deref());
    let entrypoint = resolve_entrypoint(pref_entry, path_var);
    if entrypoint.status == DiscoveryStatus::Missing {
        if let Some(msg) = &entrypoint.message {
            issues.push(msg.clone());
        }
    }

    let pref_cwd = payload.and_then(|p| p.preferred_cwd.as_deref());
    let initial_directory = resolve_initial_directory(pref_cwd, current_dir);
    if initial_directory.status == DiscoveryStatus::Missing {
        if let Some(msg) = &initial_directory.message {
            issues.push(msg.clone());
        }
    }

    let node_path = discover_node_path(path_var);
    if node_path.is_none() {
        issues.push("Node.js runtime executable was not found on system PATH".to_string());
    }

    let status = match (&entrypoint.status, &initial_directory.status) {
        (DiscoveryStatus::Ambiguous, _) | (_, DiscoveryStatus::Ambiguous) => EnvironmentStatus::Ambiguous,
        (DiscoveryStatus::Missing, _) | (_, DiscoveryStatus::Missing) => EnvironmentStatus::Missing,
        (DiscoveryStatus::Discovered, DiscoveryStatus::Discovered) => {
            if node_path.is_some() {
                EnvironmentStatus::Ready
            } else {
                EnvironmentStatus::Missing
            }
        }
    };

    DiscoveredEnvironment {
        status,
        entrypoint,
        initial_directory,
        node_path,
        issues,
    }
}

/// Tauri command to discover host environment for Pi connection startup
#[tauri::command]
pub async fn discover_environment(
    payload: Option<DiscoverEnvironmentPayload>,
) -> Result<DiscoveredEnvironment, String> {
    tokio::task::spawn_blocking(move || {
        let path_var = std::env::var("PATH").ok();
        let current_dir = std::env::current_dir().ok();

        discover_environment_impl(
            path_var.as_deref(),
            current_dir.as_deref(),
            payload.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("Discovery task failed: {e}"))
}

/// Resolves Pi agent directory given optional environment override and user home directory.
/// Precedence: PI_CODING_AGENT_DIR if non-empty, otherwise <user_home>/.pi/agent.
pub fn resolve_pi_agent_dir_from(
    env_pi_dir: Option<&str>,
    user_home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(val) = env_pi_dir {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    user_home.map(|h| h.join(".pi").join("agent"))
}

/// Resolves active Pi agent directory using system environment and user home.
pub fn resolve_pi_agent_dir() -> Option<PathBuf> {
    let env_pi = std::env::var("PI_CODING_AGENT_DIR").ok();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    resolve_pi_agent_dir_from(env_pi.as_deref(), home.as_deref())
}

/// Parse package source strings from a Pi settings.json file.
fn parse_packages_from_settings(settings_path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(settings_path) else {
        return Vec::new();
    };
    if bytes.len() > 1024 * 1024 {
        return Vec::new();
    }
    let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    val.get("packages")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| match item {
                    serde_json::Value::String(s) => Some(s.trim().to_string()),
                    serde_json::Value::Object(obj) => {
                        let is_disabled = obj.get("disabled") == Some(&serde_json::Value::Bool(true))
                            || obj.get("enabled") == Some(&serde_json::Value::Bool(false))
                            || obj.get("autoload") == Some(&serde_json::Value::Bool(false));
                        if is_disabled {
                            return None;
                        }
                        obj.get("source").and_then(|s| s.as_str()).map(|s| s.trim().to_string())
                    }
                    _ => None,
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Validate candidate directory as a valid gentle-pi installation with gentle-shell bin entrypoint.
/// Requires package.json name "gentle-pi", relative bin["gentle-shell"], existing file,
/// canonical directory containment, and exact basename gentle-shell.(js|mjs|cjs).
pub fn validate_gentle_shell_candidate(candidate_dir: &Path) -> Option<PathBuf> {
    if !candidate_dir.is_dir() {
        return None;
    }
    let bytes = std::fs::read(candidate_dir.join("package.json")).ok()?;
    if bytes.len() > 1024 * 1024 {
        return None;
    }
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if val.get("name").and_then(|v| v.as_str()) != Some("gentle-pi") {
        return None;
    }

    let rel_str = val.get("bin")?.get("gentle-shell")?.as_str()?.trim();
    let rel_path = Path::new(rel_str);
    if rel_path.is_absolute() || rel_str.contains(':') {
        return None;
    }

    let target = candidate_dir.join(rel_path);
    if !target.is_file() {
        return None;
    }

    let canon_dir = dunce::canonicalize(candidate_dir).ok()?;
    let canon_target = dunce::canonicalize(&target).ok()?;
    if !canon_target.starts_with(&canon_dir) {
        return None;
    }

    let fname = canon_target.file_name()?.to_str()?.to_ascii_lowercase();
    if !matches!(fname.as_str(), "gentle-shell.js" | "gentle-shell.mjs" | "gentle-shell.cjs") {
        return None;
    }

    Some(canon_target)
}

/// Resolves a Pi package source specifier to a potential candidate directory.
/// - npm: only recognizes "npm:gentle-pi" or "npm:gentle-pi@<version>" (never scoped)
/// - git: rejects git: prefix and raw git URLs (https://, http://, ssh://, git://)
/// - path: resolves relative to agentDir, matching Pi loader semantics
fn resolve_gentle_pi_source_candidate(source: &str, agent_dir: &Path) -> Option<PathBuf> {
    let trimmed = source.trim();
    if let Some(spec) = trimmed.strip_prefix("npm:") {
        if spec == "gentle-pi" || spec.starts_with("gentle-pi@") {
            return Some(agent_dir.join("npm").join("node_modules").join("gentle-pi"));
        }
        return None;
    }

    if trimmed.starts_with("git:")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("ssh://")
        || trimmed.starts_with("git://")
    {
        return None;
    }

    let path_str = trimmed
        .strip_prefix("file://")
        .or_else(|| trimmed.strip_prefix("file:"))
        .unwrap_or(trimmed);

    let raw = Path::new(path_str);
    let resolved = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        agent_dir.join(raw)
    };

    if resolved.is_file() && resolved.file_name().and_then(|n| n.to_str()) == Some("package.json") {
        resolved.parent().map(|p| p.to_path_buf())
    } else {
        Some(resolved)
    }
}

/// Pure detection implementation of configured Gentle Shell from global Pi settings.
pub fn detect_gentle_shell_impl(agent_dir: Option<&Path>) -> DetectGentleShellResult {
    let Some(agent) = agent_dir else {
        return DetectGentleShellResult {
            status: DiscoveryStatus::Missing,
            path: None,
            entrypoint: None,
            candidates: Vec::new(),
            message: Some("Pi agent directory could not be resolved".to_string()),
        };
    };

    let packages = parse_packages_from_settings(&agent.join("settings.json"));
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for pkg_src in packages {
        if let Some(cand_dir) = resolve_gentle_pi_source_candidate(&pkg_src, agent) {
            if let Some(validated) = validate_gentle_shell_candidate(&cand_dir) {
                let s = validated.to_string_lossy().to_string();
                if seen.insert(s.clone()) {
                    candidates.push(s);
                }
            }
        }
    }

    match candidates.len() {
        0 => DetectGentleShellResult {
            status: DiscoveryStatus::Missing,
            path: None,
            entrypoint: None,
            candidates: Vec::new(),
            message: Some("No configured gentle-pi package found in Pi settings".to_string()),
        },
        1 => {
            let path = candidates[0].clone();
            DetectGentleShellResult {
                status: DiscoveryStatus::Discovered,
                path: Some(path.clone()),
                entrypoint: Some(path),
                candidates,
                message: None,
            }
        }
        _ => DetectGentleShellResult {
            status: DiscoveryStatus::Ambiguous,
            path: None,
            entrypoint: None,
            candidates,
            message: Some("Multiple gentle-pi packages configured in Pi settings".to_string()),
        },
    }
}

/// Tauri command to detect configured Gentle Shell entrypoint from gentle-pi package metadata
#[tauri::command]
pub async fn detect_gentle_shell(
    _payload: Option<DetectGentleShellPayload>,
) -> Result<DetectGentleShellResult, String> {
    tokio::task::spawn_blocking(|| {
        let agent_dir = resolve_pi_agent_dir();
        detect_gentle_shell_impl(agent_dir.as_deref())
    })
    .await
    .map_err(|e| format!("Detection task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirGuard {
        path: PathBuf,
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn create_test_temp_dir(prefix: &str) -> (TempDirGuard, PathBuf) {
        let temp = std::env::temp_dir().join(format!(
            "pi_test_{prefix}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        (TempDirGuard { path: temp.clone() }, temp)
    }

    #[test]
    fn test_discovery_missing_when_no_path() {
        let res = discover_environment_impl(None, None, None);
        assert_eq!(res.status, EnvironmentStatus::Missing);
        assert_eq!(res.entrypoint.status, DiscoveryStatus::Missing);
        assert_eq!(res.entrypoint.path, None);
        assert!(res.entrypoint.candidates.is_empty());
        assert_eq!(res.initial_directory.status, DiscoveryStatus::Missing);
        assert_eq!(res.initial_directory.path, None);
        assert_eq!(res.node_path, None);
    }

    #[test]
    fn test_discovery_valid_from_cmd_shim() {
        let (_guard, temp_root) = create_test_temp_dir("cmd");
        let bin_dir = temp_root.join("bin");
        let pkg_dir = temp_root.join("pkg/@earendil-works/pi-coding-agent/dist/bundle");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&pkg_dir).unwrap();

        let cli_file = pkg_dir.join("cli.js");
        std::fs::write(&cli_file, "#!/usr/bin/env node\n").unwrap();
        std::fs::write(
            temp_root.join("pkg/@earendil-works/pi-coding-agent/package.json"),
            r#"{"name": "@earendil-works/pi-coding-agent"}"#,
        ).unwrap();

        let shim = bin_dir.join("pi.cmd");
        std::fs::write(
            &shim,
            "@SETLOCAL\r\nnode \"%~dp0\\..\\pkg\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\" %*\r\n",
        ).unwrap();

        let path_str = bin_dir.to_string_lossy().to_string();
        let res = discover_environment_impl(Some(&path_str), None, None);

        assert_eq!(res.entrypoint.status, DiscoveryStatus::Discovered);
        let expected = dunce::canonicalize(&cli_file).unwrap().to_string_lossy().to_string();
        assert_eq!(res.entrypoint.path.as_deref(), Some(expected.as_str()));
        assert_eq!(res.entrypoint.candidates.len(), 1);
    }

    #[test]
    fn test_discovery_valid_from_unix_shim() {
        let (_guard, temp_root) = create_test_temp_dir("unix");
        let bin_dir = temp_root.join("bin");
        let pkg_dir = temp_root.join("pkg/@earendil-works/pi-coding-agent/dist");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&pkg_dir).unwrap();

        let cli_file = pkg_dir.join("cli.js");
        std::fs::write(&cli_file, "#!/usr/bin/env node\n").unwrap();
        std::fs::write(
            temp_root.join("pkg/@earendil-works/pi-coding-agent/package.json"),
            r#"{"name": "@earendil-works/pi-coding-agent"}"#,
        ).unwrap();

        let shim = bin_dir.join("pi");
        std::fs::write(
            &shim,
            format!("#!/bin/sh\n# cmd-shim-target={}\nexec node \"$basedir/../pkg/@earendil-works/pi-coding-agent/dist/cli.js\" \"$@\"\n", cli_file.to_string_lossy()),
        ).unwrap();

        let path_str = bin_dir.to_string_lossy().to_string();
        let res = discover_environment_impl(Some(&path_str), None, None);

        assert_eq!(res.entrypoint.status, DiscoveryStatus::Discovered);
        let expected = dunce::canonicalize(&cli_file).unwrap().to_string_lossy().to_string();
        assert_eq!(res.entrypoint.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn test_discovery_ambiguous_when_multiple_candidates() {
        let (_guard, temp_root) = create_test_temp_dir("ambig");
        let bin1 = temp_root.join("bin1");
        let bin2 = temp_root.join("bin2");
        let pkg1 = temp_root.join("pkg1/@earendil-works/pi-coding-agent/dist");
        let pkg2 = temp_root.join("pkg2/@earendil-works/pi-coding-agent/dist");
        std::fs::create_dir_all(&bin1).unwrap();
        std::fs::create_dir_all(&bin2).unwrap();
        std::fs::create_dir_all(&pkg1).unwrap();
        std::fs::create_dir_all(&pkg2).unwrap();

        let cli1 = pkg1.join("cli.js");
        let cli2 = pkg2.join("cli.js");
        std::fs::write(&cli1, "").unwrap();
        std::fs::write(&cli2, "").unwrap();
        std::fs::write(temp_root.join("pkg1/@earendil-works/pi-coding-agent/package.json"), r#"{"name": "@earendil-works/pi-coding-agent"}"#).unwrap();
        std::fs::write(temp_root.join("pkg2/@earendil-works/pi-coding-agent/package.json"), r#"{"name": "@earendil-works/pi-coding-agent"}"#).unwrap();

        std::fs::write(bin1.join("pi.cmd"), format!("node \"{}\"", cli1.to_string_lossy())).unwrap();
        std::fs::write(bin2.join("pi.cmd"), format!("node \"{}\"", cli2.to_string_lossy())).unwrap();

        let combined = std::env::join_paths([&bin1, &bin2]).unwrap();
        let res = discover_environment_impl(Some(combined.to_str().unwrap()), None, None);

        assert_eq!(res.status, EnvironmentStatus::Ambiguous);
        assert_eq!(res.entrypoint.status, DiscoveryStatus::Ambiguous);
        assert_eq!(res.entrypoint.candidates.len(), 2);
    }

    #[test]
    fn test_discovery_deduplicates_same_target() {
        let (_guard, temp_root) = create_test_temp_dir("dedup");
        let bin = temp_root.join("bin");
        let pkg = temp_root.join("pkg/@earendil-works/pi-coding-agent/dist");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&pkg).unwrap();

        let cli = pkg.join("cli.js");
        std::fs::write(&cli, "").unwrap();
        std::fs::write(temp_root.join("pkg/@earendil-works/pi-coding-agent/package.json"), r#"{"name": "@earendil-works/pi-coding-agent"}"#).unwrap();

        std::fs::write(bin.join("pi.cmd"), format!("node \"{}\"", cli.to_string_lossy())).unwrap();
        std::fs::write(bin.join("pi"), format!("# cmd-shim-target={}", cli.to_string_lossy())).unwrap();

        let path_str = bin.to_string_lossy().to_string();
        let res = discover_environment_impl(Some(&path_str), None, None);

        assert_eq!(res.entrypoint.status, DiscoveryStatus::Discovered);
        assert_eq!(res.entrypoint.candidates.len(), 1);
    }

    #[test]
    fn test_discovery_rejects_unrelated_binary() {
        let (_guard, temp_root) = create_test_temp_dir("unrelated");
        let bin = temp_root.join("bin");
        let other = temp_root.join("other");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let unrelated_js = other.join("random.js");
        std::fs::write(&unrelated_js, "console.log(1);").unwrap();
        std::fs::write(bin.join("pi.cmd"), format!("node \"{}\"", unrelated_js.to_string_lossy())).unwrap();

        let path_str = bin.to_string_lossy().to_string();
        let res = discover_environment_impl(Some(&path_str), None, None);

        assert_eq!(res.entrypoint.status, DiscoveryStatus::Missing);
        assert_eq!(res.entrypoint.path, None);
    }

    #[test]
    fn test_discovery_initial_directory_verified_vs_unverified() {
        let (_guard, temp_root) = create_test_temp_dir("dirs");
        let proj = temp_root.join("project");
        let empty = temp_root.join("empty");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(proj.join("package.json"), "{}").unwrap();

        let res_proj = discover_environment_impl(None, Some(&proj), None);
        assert_eq!(res_proj.initial_directory.status, DiscoveryStatus::Discovered);
        let expected = dunce::canonicalize(&proj).unwrap().to_string_lossy().to_string();
        assert_eq!(res_proj.initial_directory.path.as_deref(), Some(expected.as_str()));

        let res_empty = discover_environment_impl(None, Some(&empty), None);
        assert_eq!(res_empty.initial_directory.status, DiscoveryStatus::Missing);
        assert_eq!(res_empty.initial_directory.path, None);
    }

    #[test]
    fn test_discovery_preferred_overrides() {
        let (_guard, temp_root) = create_test_temp_dir("pref");
        let custom_dir = temp_root.join("custom");
        let pkg = temp_root.join("pkg/@earendil-works/pi-coding-agent/dist");
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::create_dir_all(&pkg).unwrap();

        let cli = pkg.join("cli.js");
        std::fs::write(&cli, "").unwrap();
        std::fs::write(temp_root.join("pkg/@earendil-works/pi-coding-agent/package.json"), r#"{"name": "@earendil-works/pi-coding-agent"}"#).unwrap();

        // Valid preferred values
        let payload = DiscoverEnvironmentPayload {
            preferred_entrypoint: Some(cli.to_string_lossy().to_string()),
            preferred_cwd: Some(custom_dir.to_string_lossy().to_string()),
        };
        let res = discover_environment_impl(None, None, Some(&payload));
        assert_eq!(res.entrypoint.status, DiscoveryStatus::Discovered);
        assert_eq!(res.initial_directory.status, DiscoveryStatus::Discovered);

        // Invalid non-existent preferred_cwd -> reports missing
        let invalid_payload = DiscoverEnvironmentPayload {
            preferred_entrypoint: None,
            preferred_cwd: Some(temp_root.join("non_existent").to_string_lossy().to_string()),
        };
        let res_invalid = discover_environment_impl(None, None, Some(&invalid_payload));
        assert_eq!(res_invalid.initial_directory.status, DiscoveryStatus::Missing);
    }

    #[test]
    fn test_discovery_node_path() {
        let (_guard, temp_root) = create_test_temp_dir("node");
        let bin = temp_root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();

        #[cfg(windows)]
        let node_bin = bin.join("node.exe");
        #[cfg(not(windows))]
        let node_bin = bin.join("node");
        std::fs::write(&node_bin, "").unwrap();

        assert_eq!(discover_node_path(Some(bin.to_str().unwrap())), Some("node".to_string()));
        assert_eq!(discover_node_path(None), None);
    }

    #[test]
    fn test_resolve_pi_agent_dir_from() {
        let home = PathBuf::from("/test/home");
        assert_eq!(
            resolve_pi_agent_dir_from(Some("/custom/pi/agent"), Some(&home)),
            Some(PathBuf::from("/custom/pi/agent"))
        );
        assert_eq!(
            resolve_pi_agent_dir_from(Some("   "), Some(&home)),
            Some(home.join(".pi").join("agent"))
        );
        assert_eq!(
            resolve_pi_agent_dir_from(None, Some(&home)),
            Some(home.join(".pi").join("agent"))
        );
        assert_eq!(resolve_pi_agent_dir_from(None, None), None);
    }

    fn write_test_pkg(dir: &Path, name: &str, bin_rel: &str) -> PathBuf {
        let bin_path = dir.join(bin_rel);
        if let Some(parent) = bin_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&bin_path, "console.log('shell');");
        let _ = std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"{name}","bin":{{"gentle-shell":"{bin_rel}"}}}}"#),
        );
        bin_path
    }

    #[test]
    fn test_validate_gentle_shell_candidate() {
        let (_guard, temp_root) = create_test_temp_dir("gs_val");
        let pkg_dir = temp_root.join("gentle-pi");
        let shell_file = write_test_pkg(&pkg_dir, "gentle-pi", "bin/gentle-shell.mjs");

        let validated = validate_gentle_shell_candidate(&pkg_dir);
        assert_eq!(validated, Some(dunce::canonicalize(&shell_file).unwrap()));

        // Rejects wrong name
        let wrong_pkg = temp_root.join("other");
        write_test_pkg(&wrong_pkg, "not-gentle-pi", "bin/gentle-shell.mjs");
        assert_eq!(validate_gentle_shell_candidate(&wrong_pkg), None);

        // Rejects missing bin
        let no_bin = temp_root.join("nobin");
        std::fs::create_dir_all(&no_bin).unwrap();
        std::fs::write(no_bin.join("package.json"), r#"{"name":"gentle-pi","bin":{}}"#).unwrap();
        assert_eq!(validate_gentle_shell_candidate(&no_bin), None);

        // Rejects path traversal
        let trav = temp_root.join("trav");
        write_test_pkg(&trav, "gentle-pi", "../outside.js");
        assert_eq!(validate_gentle_shell_candidate(&trav), None);

        // Rejects non-gentle-shell basename
        let wrong_base = temp_root.join("base");
        write_test_pkg(&wrong_base, "gentle-pi", "bin/cli.js");
        assert_eq!(validate_gentle_shell_candidate(&wrong_base), None);
    }

    #[test]
    fn test_resolve_gentle_pi_source_candidate_spec_rules() {
        let agent = PathBuf::from("/agent");
        // npm specs: only npm:gentle-pi and npm:gentle-pi@version (never scoped)
        assert_eq!(
            resolve_gentle_pi_source_candidate("npm:gentle-pi", &agent),
            Some(agent.join("npm/node_modules/gentle-pi"))
        );
        assert_eq!(
            resolve_gentle_pi_source_candidate("npm:gentle-pi@3.6.0", &agent),
            Some(agent.join("npm/node_modules/gentle-pi"))
        );
        assert_eq!(resolve_gentle_pi_source_candidate("npm:@scope/gentle-pi", &agent), None);
        assert_eq!(resolve_gentle_pi_source_candidate("npm:other", &agent), None);

        // Git sources rejected
        assert_eq!(resolve_gentle_pi_source_candidate("git:github.com/a/b", &agent), None);
        assert_eq!(resolve_gentle_pi_source_candidate("https://github.com/a/b.git", &agent), None);
        assert_eq!(resolve_gentle_pi_source_candidate("ssh://git@github.com/a/b", &agent), None);

        // Path sources resolved relative to agentDir
        assert_eq!(
            resolve_gentle_pi_source_candidate("packages/local", &agent),
            Some(agent.join("packages/local"))
        );
    }

    #[test]
    fn test_detect_gentle_shell_impl_lifecycle() {
        let (_guard, temp_root) = create_test_temp_dir("gs_life");
        let agent_dir = temp_root.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();

        // 1. Missing when unconfigured (no guessing)
        std::fs::write(agent_dir.join("settings.json"), r#"{"packages":["npm:unrelated"]}"#).unwrap();
        let res = detect_gentle_shell_impl(Some(&agent_dir));
        assert_eq!(res.status, DiscoveryStatus::Missing);

        // 2. Discovered from local checkout
        let local_pkg = temp_root.join("checkout/gentle-pi");
        let shell_file = write_test_pkg(&local_pkg, "gentle-pi", "bin/gentle-shell.mjs");
        let local_str = local_pkg.to_string_lossy().replace('\\', "/");
        std::fs::write(
            agent_dir.join("settings.json"),
            format!(r#"{{"packages":["{local_str}"]}}"#),
        ).unwrap();
        let res = detect_gentle_shell_impl(Some(&agent_dir));
        assert_eq!(res.status, DiscoveryStatus::Discovered);
        let expected = dunce::canonicalize(&shell_file).unwrap().to_string_lossy().to_string();
        assert_eq!(res.path.as_deref(), Some(expected.as_str()));

        // 3. Discovered from npm package
        let npm_pkg = agent_dir.join("npm/node_modules/gentle-pi");
        let npm_shell = write_test_pkg(&npm_pkg, "gentle-pi", "bin/gentle-shell.cjs");
        std::fs::write(agent_dir.join("settings.json"), r#"{"packages":["npm:gentle-pi@latest"]}"#).unwrap();
        let res = detect_gentle_shell_impl(Some(&agent_dir));
        assert_eq!(res.status, DiscoveryStatus::Discovered);
        let expected_npm = dunce::canonicalize(&npm_shell).unwrap().to_string_lossy().to_string();
        assert_eq!(res.path.as_deref(), Some(expected_npm.as_str()));

        // 4. Ambiguous when multiple packages
        std::fs::write(
            agent_dir.join("settings.json"),
            format!(r#"{{"packages":["npm:gentle-pi@latest", "{local_str}"]}}"#),
        ).unwrap();
        let res = detect_gentle_shell_impl(Some(&agent_dir));
        assert_eq!(res.status, DiscoveryStatus::Ambiguous);
        assert_eq!(res.candidates.len(), 2);

        // 5. Disabled package skipped
        std::fs::write(
            agent_dir.join("settings.json"),
            format!(r#"{{"packages":[{{"source":"{local_str}","disabled":true}}]}}"#),
        ).unwrap();
        let res = detect_gentle_shell_impl(Some(&agent_dir));
        assert_eq!(res.status, DiscoveryStatus::Missing);
    }
}
