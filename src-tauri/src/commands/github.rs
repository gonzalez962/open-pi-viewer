//! GitHub repository authentication status and cloning commands.
//!
//! Provides:
//! - `get_github_auth_status`: detects whether GitHub CLI (`gh`) is installed and authenticated.
//! - `clone_github_repository`: clones public or private repositories with strict URL normalization,
//!   atomic directory reservation, child-only PAT configuration (or authenticated `gh` without PAT),
//!   isolated process execution with kill-on-drop, bounded timeouts, and safe cleanup on failure.

use std::path::{Path, PathBuf};
use std::time::Duration;
use serde::{Deserialize, Serialize};

/// Bounded timeout for probing `gh` availability and auth status (5 seconds).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bounded timeout for repository cloning operations (120 seconds).
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// Bounded timeout for listing repositories (30 seconds).
pub const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// Status of GitHub CLI availability and active authentication
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubAuthStatus {
    pub installed: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoPermissions {
    pub admin: bool,
    pub push: bool,
    pub pull: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositorySummary {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_avatar_url: Option<String>,
    pub is_private: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pushed_at: Option<String>,
    pub html_url: String,
    pub clone_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_url: Option<String>,
    pub fork: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<GithubRepoPermissions>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubOwnerGroup {
    pub owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_avatar_url: Option<String>,
    pub is_current_user: bool,
    pub repositories: Vec<GithubRepositorySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListGithubRepositoriesPayload {
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListGithubRepositoriesResult {
    pub groups: Vec<GithubOwnerGroup>,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_user: Option<String>,
}

/// Payload accepted by `clone_github_repository` command
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneGithubRepositoryPayload {
    pub repository: Option<String>,
    #[serde(alias = "parentPath")]
    pub parent_path: Option<String>,
    pub token: Option<String>,
}

/// Result returned from a successful repository clone
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneGithubRepositoryResult {
    pub path: String,
}

/// Validated and normalized GitHub repository specification
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedRepo {
    pub owner: String,
    pub repo: String,
    pub clone_url: String,
}

/// Output captured from a subprocess execution
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Specification for launching a child command
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
    pub env_removes: Vec<String>,
    pub timeout: Duration,
    pub capture_output: bool,
}

/// Subprocess runner abstraction for deterministic testing without live execution
pub trait SubprocessRunner: Send + Sync {
    fn run_command(
        &self,
        spec: CommandSpec,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ProcessOutput, String>> + Send>>;
}

/// Default real process runner using tokio::process::Command with kill-on-drop
pub struct RealSubprocessRunner;

impl SubprocessRunner for RealSubprocessRunner {
    fn run_command(
        &self,
        spec: CommandSpec,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ProcessOutput, String>> + Send>> {
        Box::pin(async move {
            let mut cmd = tokio::process::Command::new(&spec.program);
            cmd.args(&spec.args);
            cmd.kill_on_drop(true);
            cmd.stdin(std::process::Stdio::null());
            if spec.capture_output {
                cmd.stdout(std::process::Stdio::piped());
                cmd.stderr(std::process::Stdio::piped());
            } else {
                // Clone output is not shown to callers. Discard it instead of buffering
                // unbounded progress output or credential-bearing diagnostics.
                cmd.stdout(std::process::Stdio::null());
                cmd.stderr(std::process::Stdio::null());
            }
            #[cfg(unix)]
            cmd.process_group(0);

            for key in &spec.env_removes {
                cmd.env_remove(key);
            }
            for (key, val) in &spec.envs {
                if key == "GIT_CLONE_CWD" {
                    cmd.current_dir(val);
                } else {
                    cmd.env(key, val);
                }
            }

            if spec.capture_output {
                let output_fut = cmd.output();
                match tokio::time::timeout(spec.timeout, output_fut).await {
                    Ok(Ok(output)) => Ok(ProcessOutput {
                        success: output.status.success(),
                        exit_code: output.status.code(),
                        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    }),
                    Ok(Err(_)) => Err("GitHub command failed".into()),
                    Err(_) => Err("Command timed out".into()),
                }
            } else {
                let mut child = cmd.spawn().map_err(|_| "Unable to start GitHub command".to_string())?;
                let pid = child.id();
                match tokio::time::timeout(spec.timeout, child.wait()).await {
                    Ok(Ok(status)) => Ok(ProcessOutput {
                        success: status.success(), exit_code: status.code(),
                        stdout: String::new(), stderr: String::new(),
                    }),
                    Ok(Err(_)) => Err("GitHub command failed".into()),
                    Err(_) => {
                        if let Some(pid) = pid {
                            #[cfg(windows)]
                            let mut killer = {
                                let mut c = tokio::process::Command::new("taskkill");
                                c.args(["/PID", &pid.to_string(), "/T", "/F"]);
                                c
                            };
                            #[cfg(unix)]
                            let mut killer = {
                                let mut c = tokio::process::Command::new("kill");
                                c.args(["-KILL", "--", &format!("-{pid}")]);
                                c
                            };
                            #[cfg(any(windows, unix))]
                            {
                                killer.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                                    .stderr(std::process::Stdio::null()).kill_on_drop(true);
                                let _ = tokio::time::timeout(Duration::from_secs(3), killer.status()).await;
                            }
                        }
                        let _ = child.start_kill();
                        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
                        Err("Command timed out".into())
                    }
                }
            }
        })
    }
}

/// Validates and parses a repository string.
///
/// Accepts:
/// - `owner/repo` or `owner/repo.git`
/// - Strict credential-free `https://github.com/owner/repo` or `https://github.com/owner/repo.git`
///
/// Normalizes to `https://github.com/owner/repo.git`.
/// Rejects credentials, options, query parameters, fragments, other protocols/hosts, traversal.
pub fn validate_and_normalize_github_repo(input: &str) -> Result<NormalizedRepo, String> {
    let input = input.trim();
    if input.is_empty() || input.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Invalid GitHub repository".into());
    }
    let identity = if let Some(rest) = input.strip_prefix("https://github.com/") {
        rest.trim_end_matches('/')
    } else {
        input
    };
    let parts: Vec<_> = identity.split('/').collect();
    if parts.len() != 2 { return Err("Invalid GitHub repository".into()); }
    let owner = parts[0];
    let raw_repo = parts[1];
    let repo = raw_repo.strip_suffix(".git").unwrap_or(raw_repo);
    let valid_owner = !owner.is_empty() && owner.len() <= 39
        && owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && !owner.starts_with('-') && !owner.ends_with('-') && !owner.contains("--");
    let valid_repo = !repo.is_empty() && repo.len() <= 100 && repo != "." && repo != ".."
        && repo.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c));
    if !valid_owner || !valid_repo { return Err("Invalid GitHub repository".into()); }
    Ok(NormalizedRepo { owner: owner.into(), repo: repo.into(), clone_url: format!("https://github.com/{owner}/{repo}.git") })
}

/// Atomically reserves the destination directory under `canonical_parent`.
pub fn reserve_destination_directory(
    canonical_parent: &Path,
    repo_name: &str,
) -> Result<PathBuf, String> {
    if !canonical_parent.is_dir() || repo_name.is_empty() || repo_name == "." || repo_name == ".."
        || !repo_name.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)) {
        return Err("Invalid destination directory".into());
    }
    let target = canonical_parent.join(repo_name);
    std::fs::create_dir(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            "Permission denied: cannot create directory".to_string()
        } else {
            "Destination unavailable or already exists".to_string()
        }
    })?;
    Ok(target)
}

/// Builds hardened child environment for git invocation
pub fn build_child_git_env(
    token: Option<&str>,
    is_anonymous: bool,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    use base64::Engine;
    if token.is_some_and(|t| t.chars().any(|c| c.is_control())) {
        return Err("Invalid token".into());
    }
    let mut removes: Vec<String> = std::env::vars_os().filter_map(|(k, _)| {
        let key = k.to_string_lossy().into_owned();
        if key.starts_with("GIT_") || key == "SSH_ASKPASS" { Some(key) } else { None }
    }).collect();
    removes.extend(["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"].iter().map(|s| s.to_string()));
    if is_anonymous || token.is_some() {
        removes.extend(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].iter().map(|s| s.to_string()));
    }
    let mut envs: Vec<(String, String)> = [
        ("GIT_TERMINAL_PROMPT", "0"), ("GIT_ASKPASS", ""), ("SSH_ASKPASS", ""),
        ("GIT_ALLOW_PROTOCOL", "https"), ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" }),
    ].iter().map(|(k,v)| (k.to_string(), v.to_string())).collect();
    let mut configs = vec![
        ("credential.helper", String::new()), ("http.followRedirects", "false".into()),
        ("init.templateDir", String::new()),
        ("safe.directory", "*".into()),
    ];
    if let Some(t) = token.filter(|t| !t.trim().is_empty()) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{}", t.trim()));
        configs.push(("http.https://github.com/.extraheader", format!("AUTHORIZATION: basic {encoded}")));
    } else if !is_anonymous {
        configs.push(("credential.https://github.com.helper", "!gh auth git-credential".into()));
    }
    envs.push(("GIT_CONFIG_COUNT".into(), configs.len().to_string()));
    for (i, (key, value)) in configs.into_iter().enumerate() {
        envs.push((format!("GIT_CONFIG_KEY_{i}"), key.into()));
        envs.push((format!("GIT_CONFIG_VALUE_{i}"), value));
    }
    Ok((envs, removes))
}

/// Sanitizes process error messages to avoid leaking token or base64 token
pub fn sanitize_error_message(raw_message: &str, token: Option<&str>) -> String {
    let _ = token;
    let message = raw_message.to_lowercase();
    if message.contains("cannot write to destination directory")
        || message.contains("cannot create directory")
        || (message.contains("permission denied") && (message.contains("destination") || message.contains("mkdir") || message.contains("work tree")))
    {
        "Permission denied on destination directory".into()
    } else if message.contains("timed out") {
        "Cloning timed out after 120 seconds".into()
    } else if message.contains("authentication") || message.contains("repository not found") || message.contains("permission denied") {
        "Repository not found or access denied".into()
    } else {
        "Clone operation failed".into()
    }
}

pub fn parse_gh_username(output: &str) -> Option<String> {
    for line in output.lines() {
        let lower = line.to_lowercase();
        if let Some(pos) = lower.find("account ") {
            let rest = &line[pos + 8..].trim_start();
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '-').collect();
            if !name.is_empty() { return Some(name); }
        } else if let Some(pos) = lower.find("logged in as ") {
            let rest = &line[pos + 13..].trim_start();
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '-').collect();
            if !name.is_empty() { return Some(name); }
        }
    }
    None
}

pub fn parse_paginated_json_arrays(stdout: &str) -> Vec<serde_json::Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        if let Ok(serde_json::Value::Array(items)) = serde_json::from_str(trimmed) {
            return items;
        }
    }
    let mut items = Vec::new();
    let mut depth = 0;
    let mut start = None;
    for (i, c) in stdout.char_indices() {
        if c == '[' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
        } else if c == ']' {
            depth -= 1;
            if depth == 0 {
                if let Some(s) = start {
                    if let Ok(serde_json::Value::Array(chunk)) = serde_json::from_str(&stdout[s..=i]) {
                        items.extend(chunk);
                    }
                    start = None;
                }
            }
        }
    }
    items
}

pub fn normalize_raw_github_repo(raw: &serde_json::Value) -> Option<GithubRepositorySummary> {
    let obj = raw.as_object()?;
    let id = obj.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let name = obj.get("name").and_then(|v| v.as_str())?.to_string();
    let owner_obj = obj.get("owner").and_then(|v| v.as_object());
    let owner = owner_obj
        .and_then(|o| o.get("login"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let full_name = obj
        .get("full_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| if owner.is_empty() { name.clone() } else { format!("{}/{}", owner, name) });
    let owner_type = owner_obj
        .and_then(|o| o.get("type"))
        .and_then(|v| v.as_str())
        .map(|t| if t == "Organization" { "Organization".to_string() } else { "User".to_string() });
    let owner_avatar_url = owner_obj
        .and_then(|o| o.get("avatar_url"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let is_private = obj.get("private").and_then(|v| v.as_bool()).unwrap_or(false);
    let description = obj.get("description").and_then(|v| v.as_str()).map(String::from);
    let default_branch = obj.get("default_branch").and_then(|v| v.as_str()).map(String::from);
    let updated_at = obj.get("updated_at").and_then(|v| v.as_str()).map(String::from);
    let pushed_at = obj.get("pushed_at").and_then(|v| v.as_str()).map(String::from);
    let html_url = obj
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("https://github.com/{}", full_name));
    let clone_url = obj
        .get("clone_url")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("https://github.com/{}.git", full_name));
    let ssh_url = obj.get("ssh_url").and_then(|v| v.as_str()).map(String::from);
    let fork = obj.get("fork").and_then(|v| v.as_bool()).unwrap_or(false);
    let archived = obj.get("archived").and_then(|v| v.as_bool());
    let permissions = obj.get("permissions").and_then(|p| {
        Some(GithubRepoPermissions {
            admin: p.get("admin").and_then(|v| v.as_bool()).unwrap_or(false),
            push: p.get("push").and_then(|v| v.as_bool()).unwrap_or(false),
            pull: p.get("pull").and_then(|v| v.as_bool()).unwrap_or(false),
        })
    });

    Some(GithubRepositorySummary {
        id,
        name,
        full_name,
        owner,
        owner_type,
        owner_avatar_url,
        is_private,
        description,
        default_branch,
        updated_at,
        pushed_at,
        html_url,
        clone_url,
        ssh_url,
        fork,
        archived,
        permissions,
    })
}

pub fn group_repositories_by_owner(
    repos: Vec<GithubRepositorySummary>,
    current_user: Option<&str>,
) -> Vec<GithubOwnerGroup> {
    let clean_user = current_user.map(str::trim).filter(|s| !s.is_empty()).map(str::to_lowercase);
    let mut map: std::collections::BTreeMap<String, GithubOwnerGroup> = std::collections::BTreeMap::new();
    let mut seen_ids = std::collections::HashSet::new();

    for repo in repos {
        if !seen_ids.insert(repo.id) {
            continue;
        }
        let owner_key = repo.owner.to_lowercase();
        let is_current = clean_user.as_ref().map_or(false, |u| u == &owner_key);
        let group = map.entry(owner_key).or_insert_with(|| GithubOwnerGroup {
            owner: repo.owner.clone(),
            owner_type: repo.owner_type.clone(),
            owner_avatar_url: repo.owner_avatar_url.clone(),
            is_current_user: is_current,
            repositories: Vec::new(),
        });
        if group.owner_avatar_url.is_none() && repo.owner_avatar_url.is_some() {
            group.owner_avatar_url = repo.owner_avatar_url.clone();
        }
        if group.owner_type.is_none() && repo.owner_type.is_some() {
            group.owner_type = repo.owner_type.clone();
        }
        group.repositories.push(repo);
    }

    // Sort repositories within each group by pushed_at / updated_at descending, then name
    for group in map.values_mut() {
        group.repositories.sort_by(|a, b| {
            let time_a = a.pushed_at.as_deref().or(a.updated_at.as_deref()).unwrap_or("");
            let time_b = b.pushed_at.as_deref().or(b.updated_at.as_deref()).unwrap_or("");
            time_b.cmp(time_a).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    }

    // Sort groups: current user first, then alphabetical by owner
    let mut groups: Vec<GithubOwnerGroup> = map.into_values().collect();
    groups.sort_by(|a, b| {
        match (a.is_current_user, b.is_current_user) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.owner.to_lowercase().cmp(&b.owner.to_lowercase()),
        }
    });

    groups
}

/// Core implementation of auth status detection using an injectable runner
pub async fn get_github_auth_status_impl(runner: &dyn SubprocessRunner) -> Result<GithubAuthStatus, String> {
    let probe = |args: Vec<String>| CommandSpec { program: "gh".into(), args, envs: vec![], env_removes: vec![], timeout: PROBE_TIMEOUT, capture_output: true };
    let installed = runner.run_command(probe(vec!["--version".into()])).await.map(|r| r.success).unwrap_or(false);
    if !installed { return Ok(GithubAuthStatus { installed: false, authenticated: false, username: None }); }
    let auth_res = runner.run_command(probe(vec!["auth".into(), "status".into(), "--hostname".into(), "github.com".into()])).await;
    let (authenticated, combined_output) = match auth_res {
        Ok(out) => (out.success, format!("{}\n{}", out.stdout, out.stderr)),
        Err(_) => (false, String::new()),
    };
    let username = if authenticated { parse_gh_username(&combined_output) } else { None };
    Ok(GithubAuthStatus { installed: true, authenticated, username })
}

/// Core implementation of repository cloning using an injectable runner
pub async fn clone_github_repository_impl(
    repository: &str,
    parent_path: &str,
    token: Option<&str>,
    runner: &dyn SubprocessRunner,
) -> Result<CloneGithubRepositoryResult, String> {
    let repo = validate_and_normalize_github_repo(repository)?;
    let parent = dunce::canonicalize(parent_path.trim()).map_err(|_| "Invalid destination directory".to_string())?;
    let token = token.map(str::trim).filter(|t| !t.is_empty());
    let auth = if token.is_none() { get_github_auth_status_impl(runner).await? } else { GithubAuthStatus { installed: false, authenticated: false, username: None } };
    let (mut envs, env_removes) = build_child_git_env(token, !auth.authenticated)?;
    let target = reserve_destination_directory(&parent, &repo.repo)?;
    // Prevent parent repository discovery; the reserved directory is our isolated cwd.
    envs.push(("GIT_CEILING_DIRECTORIES".into(), parent.to_string_lossy().into_owned()));
    envs.push(("GIT_CLONE_CWD".into(), target.to_string_lossy().into_owned()));
    let args = if auth.authenticated {
        vec!["repo".into(), "clone".into(), repo.clone_url.clone(), target.to_string_lossy().into_owned()]
    } else {
        vec!["clone".into(), "--".into(), repo.clone_url.clone(), target.to_string_lossy().into_owned()]
    };
    let spec = CommandSpec { program: if auth.authenticated { "gh" } else { "git" }.into(), args, envs, env_removes, timeout: CLONE_TIMEOUT, capture_output: false };
    let mut run_result = runner.run_command(spec).await;

    // Fallback: If gh repo clone failed and no explicit token was provided, attempt anonymous
    // git clone directly over HTTPS. In Linux, gh CLI frequently fails in headless/daemon
    // environments or due to SSH/keyring configs, but public repositories can always be cloned
    // cleanly without credentials via git clone.
    if auth.authenticated && token.is_none() && run_result.as_ref().map_or(true, |o| !o.success) {
        if let Ok(entries) = std::fs::read_dir(&target) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_dir_all(entry.path()).or_else(|_| std::fs::remove_file(entry.path()));
            }
        }
        if let Ok((mut fallback_envs, fallback_removes)) = build_child_git_env(None, true) {
            fallback_envs.push(("GIT_CEILING_DIRECTORIES".into(), parent.to_string_lossy().into_owned()));
            fallback_envs.push(("GIT_CLONE_CWD".into(), target.to_string_lossy().into_owned()));
            let fallback_spec = CommandSpec {
                program: "git".into(),
                args: vec!["clone".into(), "--".into(), repo.clone_url.clone(), target.to_string_lossy().into_owned()],
                envs: fallback_envs,
                env_removes: fallback_removes,
                timeout: CLONE_TIMEOUT,
                capture_output: false,
            };
            let fallback_result = runner.run_command(fallback_spec).await;
            if fallback_result.as_ref().map_or(false, |o| o.success) {
                run_result = fallback_result;
            }
        }
    }

    match run_result {
        Ok(output) if output.success => Ok(CloneGithubRepositoryResult { path: target.to_string_lossy().into_owned() }),
        result => {
            let _ = std::fs::remove_dir_all(&target);
            let message = match result { Ok(output) => output.stderr, Err(error) => error };
            Err(sanitize_error_message(&message, token))
        }
    }
}

/// Core implementation of repository listing using an injectable runner
pub async fn list_github_repositories_impl(
    token: Option<&str>,
    runner: &dyn SubprocessRunner,
) -> Result<ListGithubRepositoriesResult, String> {
    let token = token.map(str::trim).filter(|t| !t.is_empty());

    if let Some(tok) = token {
        if tok.chars().any(|c| c == '\r' || c == '\n' || c == '\0') {
            return Err("Token contains invalid characters".to_string());
        }

        // Check if gh is installed
        let probe = CommandSpec {
            program: "gh".into(),
            args: vec!["--version".into()],
            envs: vec![],
            env_removes: vec![],
            timeout: PROBE_TIMEOUT,
            capture_output: true,
        };
        let gh_installed = runner.run_command(probe).await.map(|r| r.success).unwrap_or(false);

        if gh_installed {
            // First get user login
            let user_spec = CommandSpec {
                program: "gh".into(),
                args: vec!["api".into(), "user".into()],
                envs: vec![("GH_TOKEN".into(), tok.to_string())],
                env_removes: vec![],
                timeout: PROBE_TIMEOUT,
                capture_output: true,
            };
            let current_user = if let Ok(out) = runner.run_command(user_spec).await {
                if out.success {
                    serde_json::from_str::<serde_json::Value>(&out.stdout)
                        .ok()
                        .and_then(|v| v.get("login").and_then(|l| l.as_str()).map(String::from))
                } else {
                    None
                }
            } else {
                None
            };

            let list_spec = CommandSpec {
                program: "gh".into(),
                args: vec![
                    "api".into(),
                    "user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated".into(),
                    "--paginate".into(),
                ],
                envs: vec![("GH_TOKEN".into(), tok.to_string())],
                env_removes: vec![],
                timeout: LIST_TIMEOUT,
                capture_output: true,
            };
            let res = runner.run_command(list_spec).await?;
            if !res.success {
                return Err(sanitize_error_message(&format!("{}\n{}", res.stderr, res.stdout), Some(tok)));
            }

            let raw_items = parse_paginated_json_arrays(&res.stdout);
            let repos: Vec<GithubRepositorySummary> = raw_items.iter().filter_map(normalize_raw_github_repo).collect();
            let total = repos.len();
            let groups = group_repositories_by_owner(repos, current_user.as_deref());

            return Ok(ListGithubRepositoriesResult {
                groups,
                total,
                current_user,
            });
        } else {
            // Fallback to curl
            let curl_spec = CommandSpec {
                program: "curl".into(),
                args: vec![
                    "-s".into(),
                    "-H".into(),
                    "Accept: application/vnd.github+json".into(),
                    "-H".into(),
                    format!("Authorization: Bearer {}", tok),
                    "-H".into(),
                    "User-Agent: open-pi-viewer".into(),
                    "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated".into(),
                ],
                envs: vec![],
                env_removes: vec![],
                timeout: LIST_TIMEOUT,
                capture_output: true,
            };
            let res = runner.run_command(curl_spec).await?;
            if !res.success {
                return Err("Failed to list GitHub repositories via curl".to_string());
            }
            let raw_items = parse_paginated_json_arrays(&res.stdout);
            let repos: Vec<GithubRepositorySummary> = raw_items.iter().filter_map(normalize_raw_github_repo).collect();
            let total = repos.len();
            let groups = group_repositories_by_owner(repos, None);

            return Ok(ListGithubRepositoriesResult {
                groups,
                total,
                current_user: None,
            });
        }
    }

    // When no token is passed, gh must be authenticated
    let auth = get_github_auth_status_impl(runner).await?;
    if !auth.installed || !auth.authenticated {
        return Err("GitHub authentication required: gh CLI is not authenticated and no Personal Access Token was provided".to_string());
    }

    let list_spec = CommandSpec {
        program: "gh".into(),
        args: vec![
            "api".into(),
            "user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated".into(),
            "--paginate".into(),
        ],
        envs: vec![],
        env_removes: vec![],
        timeout: LIST_TIMEOUT,
        capture_output: true,
    };
    let res = runner.run_command(list_spec).await?;
    if !res.success {
        return Err(sanitize_error_message(&format!("{}\n{}", res.stderr, res.stdout), None));
    }

    let raw_items = parse_paginated_json_arrays(&res.stdout);
    let repos: Vec<GithubRepositorySummary> = raw_items.iter().filter_map(normalize_raw_github_repo).collect();
    let total = repos.len();
    let groups = group_repositories_by_owner(repos, auth.username.as_deref());

    Ok(ListGithubRepositoriesResult {
        groups,
        total,
        current_user: auth.username,
    })
}

/// Tauri command to list all GitHub repositories accessible to the user
#[tauri::command]
pub async fn list_github_repositories(
    payload: Option<ListGithubRepositoriesPayload>,
    token: Option<String>,
) -> Result<ListGithubRepositoriesResult, String> {
    let tok = payload.as_ref().and_then(|p| p.token.clone()).or(token);
    list_github_repositories_impl(tok.as_deref(), &RealSubprocessRunner).await
}

/// Tauri command to inspect GitHub CLI availability and auth status
#[tauri::command]
pub async fn get_github_auth_status() -> Result<GithubAuthStatus, String> {
    get_github_auth_status_impl(&RealSubprocessRunner).await
}

/// Tauri command to clone a GitHub repository
#[tauri::command]
pub async fn clone_github_repository(
    payload: Option<CloneGithubRepositoryPayload>,
    repository: Option<String>,
    parent_path: Option<String>,
    token: Option<String>,
) -> Result<CloneGithubRepositoryResult, String> {
    let repo = payload
        .as_ref()
        .and_then(|p| p.repository.clone())
        .or(repository)
        .ok_or_else(|| "Repository is required and cannot be empty".to_string())?;

    let parent = payload
        .as_ref()
        .and_then(|p| p.parent_path.clone())
        .or(parent_path)
        .ok_or_else(|| "Parent directory path is required".to_string())?;

    let tok = payload.as_ref().and_then(|p| p.token.clone()).or(token);

    clone_github_repository_impl(&repo, &parent, tok.as_deref(), &RealSubprocessRunner).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct MockRunner<F>
    where
        F: Fn(CommandSpec) -> Result<ProcessOutput, String> + Send + Sync + 'static,
    {
        handler: F,
    }

    impl<F> SubprocessRunner for MockRunner<F>
    where
        F: Fn(CommandSpec) -> Result<ProcessOutput, String> + Send + Sync + 'static,
    {
        fn run_command(
            &self,
            spec: CommandSpec,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ProcessOutput, String>> + Send>> {
            let res = (self.handler)(spec);
            Box::pin(async move { res })
        }
    }

    #[tokio::test]
    async fn real_git_ignores_parent_repository_rewrites() {
        let parent = std::env::temp_dir().join(format!("pi_git_isolation_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(parent.join(".git")).unwrap();
        std::fs::write(parent.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::create_dir_all(parent.join(".git/objects")).unwrap();
        std::fs::create_dir_all(parent.join(".git/refs")).unwrap();
        std::fs::write(parent.join(".git/config"), "[url \"https://example.invalid/\"]\n\tinsteadOf = https://github.com/owner/\n").unwrap();
        let target = reserve_destination_directory(&parent, "destination").unwrap();
        let (envs, removes) = build_child_git_env(None, true).unwrap();
        let mut command = tokio::process::Command::new("git");
        command.current_dir(&target).args(["ls-remote", "--get-url", "https://github.com/owner/repo.git"]);
        for key in removes { command.env_remove(key); }
        for (key, value) in envs { command.env(key, value); }
        command.env("GIT_CEILING_DIRECTORIES", &parent);
        let output = command.output().await.unwrap();
        let _ = std::fs::remove_dir_all(&parent);
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "https://github.com/owner/repo.git");
    }

    #[test]
    fn isolated_config_disables_global_and_system_sources() {
        let (envs, _) = build_child_git_env(None, true).unwrap();
        let env: std::collections::HashMap<_, _> = envs.into_iter().collect();
        assert_eq!(env.get("GIT_CONFIG_NOSYSTEM").map(String::as_str), Some("1"));
        assert_eq!(env.get("GIT_CONFIG_GLOBAL").map(String::as_str), Some(if cfg!(windows) { "NUL" } else { "/dev/null" }));
    }

    // ---------------------------------------------------------------------------
    // 1. Repository validation and normalization tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_validation_owner_repo() {
        let norm = validate_and_normalize_github_repo("octocat/Hello-World").unwrap();
        assert_eq!(norm.owner, "octocat");
        assert_eq!(norm.repo, "Hello-World");
        assert_eq!(norm.clone_url, "https://github.com/octocat/Hello-World.git");

        let norm_git = validate_and_normalize_github_repo("octocat/Hello-World.git").unwrap();
        assert_eq!(norm_git.owner, "octocat");
        assert_eq!(norm_git.repo, "Hello-World");
        assert_eq!(norm_git.clone_url, "https://github.com/octocat/Hello-World.git");
    }

    #[test]
    fn test_validation_https_url() {
        let norm = validate_and_normalize_github_repo("https://github.com/torvalds/linux").unwrap();
        assert_eq!(norm.owner, "torvalds");
        assert_eq!(norm.repo, "linux");
        assert_eq!(norm.clone_url, "https://github.com/torvalds/linux.git");

        let norm_trailing = validate_and_normalize_github_repo("https://github.com/facebook/react.git/").unwrap();
        assert_eq!(norm_trailing.owner, "facebook");
        assert_eq!(norm_trailing.repo, "react");
        assert_eq!(norm_trailing.clone_url, "https://github.com/facebook/react.git");
    }

    #[test]
    fn test_validation_rejections() {
        assert!(validate_and_normalize_github_repo("https://user:pass@github.com/owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("https://token@github.com/owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("https://github.com/owner/repo?query=1").is_err());
        assert!(validate_and_normalize_github_repo("https://github.com/owner/repo#frag").is_err());
        assert!(validate_and_normalize_github_repo("https://github.com:8080/owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("git@github.com:owner/repo.git").is_err());
        assert!(validate_and_normalize_github_repo("http://github.com/owner/repo.git").is_err());
        assert!(validate_and_normalize_github_repo("ssh://git@github.com/owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("file:///etc/passwd").is_err());
        assert!(validate_and_normalize_github_repo("https://gitlab.com/owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("https://github.evil.com/owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("--upload-pack=evil").is_err());
        assert!(validate_and_normalize_github_repo("-o/repo").is_err());
        assert!(validate_and_normalize_github_repo("../owner/repo").is_err());
        assert!(validate_and_normalize_github_repo("owner/../repo").is_err());
        assert!(validate_and_normalize_github_repo("owner/..").is_err());
        assert!(validate_and_normalize_github_repo("owner/.git").is_err());
        assert!(validate_and_normalize_github_repo("").is_err());
        assert!(validate_and_normalize_github_repo("   ").is_err());
        assert!(validate_and_normalize_github_repo("owner").is_err());
        assert!(validate_and_normalize_github_repo("owner/repo/extra").is_err());
        assert!(validate_and_normalize_github_repo("owner\n/repo").is_err());
        assert!(validate_and_normalize_github_repo("owner\0/repo").is_err());
    }

    // ---------------------------------------------------------------------------
    // 2. Reservation & directory tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_reserve_destination_directory_lifecycle() {
        let temp_dir = std::env::temp_dir().join(format!("pi_git_test_reserve_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let reserved = reserve_destination_directory(&temp_dir, "my-repo");
        assert!(reserved.is_ok(), "Should reserve empty destination");
        let reserved_path = reserved.unwrap();
        assert!(reserved_path.is_dir());

        // Second reservation must fail because destination already exists
        let second = reserve_destination_directory(&temp_dir, "my-repo");
        assert!(second.is_err(), "Should reject pre-existing destination");

        // Non-existent parent directory must fail
        let non_existent = temp_dir.join("non_existent_sub");
        assert!(reserve_destination_directory(&non_existent, "any-repo").is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_reserve_destination_preserves_foreign_files() {
        let temp_dir = std::env::temp_dir().join(format!("pi_git_test_foreign_{}", uuid::Uuid::new_v4()));
        let dest_dir = temp_dir.join("existing-repo");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let foreign_file = dest_dir.join("data.txt");
        std::fs::write(&foreign_file, "precious user data").unwrap();

        let res = reserve_destination_directory(&temp_dir, "existing-repo");
        assert!(res.is_err());

        // File and directory must be untouched
        assert!(foreign_file.exists());
        assert_eq!(std::fs::read_to_string(&foreign_file).unwrap(), "precious user data");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // ---------------------------------------------------------------------------
    // 3. Child git env construction tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_build_child_git_env_anonymous() {
        let (envs, env_removes) = build_child_git_env(None, true).unwrap();

        assert!(env_removes.contains(&"GIT_CONFIG_PARAMETERS".to_string()));
        assert!(env_removes.contains(&"GIT_CONFIG_COUNT".to_string()));
        assert!(env_removes.contains(&"GH_TOKEN".to_string()));
        assert!(env_removes.contains(&"GITHUB_TOKEN".to_string()));

        let env_map: std::collections::HashMap<_, _> = envs.into_iter().collect();
        assert_eq!(env_map.get("GIT_TERMINAL_PROMPT").map(String::as_str), Some("0"));
        assert_eq!(env_map.get("GIT_ASKPASS").map(String::as_str), Some(""));
        assert_eq!(env_map.get("SSH_ASKPASS").map(String::as_str), Some(""));
        assert_eq!(env_map.get("GIT_ALLOW_PROTOCOL").map(String::as_str), Some("https"));

        let count: usize = env_map.get("GIT_CONFIG_COUNT").unwrap().parse().unwrap();
        assert!(count >= 3);

        let mut configs = std::collections::HashMap::new();
        for i in 0..count {
            let key = env_map.get(&format!("GIT_CONFIG_KEY_{i}")).unwrap();
            let val = env_map.get(&format!("GIT_CONFIG_VALUE_{i}")).unwrap();
            configs.insert(key.as_str(), val.as_str());
        }

        assert_eq!(configs.get("credential.helper"), Some(&""));
        assert_eq!(configs.get("http.followRedirects"), Some(&"false"));
        assert_eq!(configs.get("init.templateDir"), Some(&""));
        assert_eq!(configs.get("http.https://github.com/.extraheader"), None);
    }

    #[test]
    fn test_build_child_git_env_with_pat() {
        let pat = "ghp_mySecretToken12345";
        let (envs, env_removes) = build_child_git_env(Some(pat), false).unwrap();

        assert!(env_removes.contains(&"GH_TOKEN".to_string()));
        assert!(env_removes.contains(&"GITHUB_TOKEN".to_string()));

        let env_map: std::collections::HashMap<_, _> = envs.into_iter().collect();
        let count: usize = env_map.get("GIT_CONFIG_COUNT").unwrap().parse().unwrap();
        let mut configs = std::collections::HashMap::new();
        for i in 0..count {
            let key = env_map.get(&format!("GIT_CONFIG_KEY_{i}")).unwrap();
            let val = env_map.get(&format!("GIT_CONFIG_VALUE_{i}")).unwrap();
            configs.insert(key.as_str(), val.as_str());
        }

        use base64::Engine;
        let expected_b64 = base64::engine::general_purpose::STANDARD
            .encode(format!("x-access-token:{pat}"));
        let expected_auth = format!("AUTHORIZATION: basic {expected_b64}");
        assert_eq!(
            configs.get("http.https://github.com/.extraheader"),
            Some(&expected_auth.as_str())
        );
    }

    #[test]
    fn test_build_child_git_env_rejects_crlf_tokens() {
        assert!(build_child_git_env(Some("token\r\ninjected: val"), false).is_err());
        assert!(build_child_git_env(Some("token\ninjected: val"), false).is_err());
        assert!(build_child_git_env(Some("token\0injected"), false).is_err());
    }

    // ---------------------------------------------------------------------------
    // 4. Subprocess auth status tests
    // ---------------------------------------------------------------------------

    #[tokio::test]
    async fn test_auth_status_gh_missing() {
        let runner = MockRunner {
            handler: |_spec| Err("gh: executable not found in %PATH%".to_string()),
        };
        let status = get_github_auth_status_impl(&runner).await.unwrap();
        assert_eq!(status, GithubAuthStatus { installed: false, authenticated: false, username: None });
    }

    #[tokio::test]
    async fn test_auth_status_gh_unauthenticated() {
        let runner = MockRunner {
            handler: |spec| {
                if spec.args.contains(&"--version".to_string()) {
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "gh version 2.50.0".to_string(),
                        stderr: String::new(),
                    })
                } else {
                    Ok(ProcessOutput {
                        success: false,
                        exit_code: Some(1),
                        stdout: String::new(),
                        stderr: "You are not logged into any GitHub hosts".to_string(),
                    })
                }
            },
        };
        let status = get_github_auth_status_impl(&runner).await.unwrap();
        assert_eq!(status, GithubAuthStatus { installed: true, authenticated: false, username: None });
    }

    #[tokio::test]
    async fn test_auth_status_gh_authenticated() {
        let runner = MockRunner {
            handler: |spec| {
                if spec.args.contains(&"--version".to_string()) {
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "gh version 2.50.0".to_string(),
                        stderr: String::new(),
                    })
                } else {
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "Logged in to github.com account octocat".to_string(),
                        stderr: String::new(),
                    })
                }
            },
        };
        let status = get_github_auth_status_impl(&runner).await.unwrap();
        assert_eq!(status, GithubAuthStatus { installed: true, authenticated: true, username: Some("octocat".to_string()) });
    }

    // ---------------------------------------------------------------------------
    // 5. Clone execution tests
    // ---------------------------------------------------------------------------

    #[tokio::test]
    async fn test_clone_with_explicit_pat() {
        let temp_dir = std::env::temp_dir().join(format!("pi_git_test_pat_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let temp_dir_str = temp_dir.to_string_lossy().to_string();

        let pat = "ghp_secretCloneToken123";
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        let runner = MockRunner {
            handler: move |spec| {
                captured_clone.lock().unwrap().push(spec);
                Ok(ProcessOutput {
                    success: true,
                    exit_code: Some(0),
                    stdout: "Cloning into...".to_string(),
                    stderr: String::new(),
                })
            },
        };

        let res = clone_github_repository_impl(
            "octocat/Hello-World",
            &temp_dir_str,
            Some(pat),
            &runner,
        )
        .await;

        assert!(res.is_ok());
        let calls = captured.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        let call = &calls[0];

        assert_eq!(call.program, "git");
        assert_eq!(call.timeout, Duration::from_secs(120));
        assert_eq!(call.args[0], "clone");
        assert_eq!(call.args[1], "--");
        assert_eq!(call.args[2], "https://github.com/octocat/Hello-World.git");
        assert!(!call.args.iter().any(|a| a.contains(pat)), "Token must never be in args");

        let env_map: std::collections::HashMap<_, _> = call.envs.iter().cloned().collect();
        let count: usize = env_map.get("GIT_CONFIG_COUNT").unwrap().parse().unwrap();
        let mut configs = std::collections::HashMap::new();
        for i in 0..count {
            let key = env_map.get(&format!("GIT_CONFIG_KEY_{i}")).unwrap();
            let val = env_map.get(&format!("GIT_CONFIG_VALUE_{i}")).unwrap();
            configs.insert(key.as_str(), val.as_str());
        }
        assert!(configs.get("http.https://github.com/.extraheader").is_some());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_clone_without_pat_gh_authenticated() {
        let temp_dir = std::env::temp_dir().join(format!("pi_git_test_gh_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let temp_dir_str = temp_dir.to_string_lossy().to_string();

        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        let runner = MockRunner {
            handler: move |spec| {
                captured_clone.lock().unwrap().push(spec.clone());
                if spec.program == "gh" && spec.args.contains(&"--version".to_string()) {
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "gh 2.50.0".to_string(),
                        stderr: String::new(),
                    })
                } else if spec.program == "gh" && spec.args.contains(&"status".to_string()) {
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "Logged in as testuser".to_string(),
                        stderr: String::new(),
                    })
                } else if spec.program == "gh" && spec.args.contains(&"repo".to_string()) {
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "Cloning...".to_string(),
                        stderr: String::new(),
                    })
                } else {
                    Err("Unexpected command".to_string())
                }
            },
        };

        let res = clone_github_repository_impl(
            "octocat/Hello-World",
            &temp_dir_str,
            None,
            &runner,
        )
        .await;

        assert!(res.is_ok());
        let calls = captured.lock().unwrap().clone();
        let clone_call = calls.iter().find(|c| c.args.contains(&"repo".to_string())).unwrap();
        assert_eq!(clone_call.program, "gh");
        assert_eq!(clone_call.timeout, Duration::from_secs(120));
        assert!(clone_call.args.contains(&"https://github.com/octocat/Hello-World.git".to_string()));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_clone_without_pat_anonymous_fallback() {
        let temp_dir = std::env::temp_dir().join(format!("pi_git_test_anon_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let temp_dir_str = temp_dir.to_string_lossy().to_string();

        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        let runner = MockRunner {
            handler: move |spec| {
                captured_clone.lock().unwrap().push(spec.clone());
                if spec.program == "gh" {
                    // gh missing or unauthenticated
                    Err("gh not found".to_string())
                } else {
                    // git clone
                    Ok(ProcessOutput {
                        success: true,
                        exit_code: Some(0),
                        stdout: "Cloned anonymously".to_string(),
                        stderr: String::new(),
                    })
                }
            },
        };

        let res = clone_github_repository_impl(
            "octocat/Hello-World",
            &temp_dir_str,
            None,
            &runner,
        )
        .await;

        assert!(res.is_ok());
        let calls = captured.lock().unwrap().clone();
        let clone_call = calls.iter().find(|c| c.program == "git").unwrap();
        assert_eq!(clone_call.args[0], "clone");
        assert_eq!(clone_call.args[1], "--");
        assert!(clone_call.env_removes.contains(&"GH_TOKEN".to_string()));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_clone_failure_cleans_up_reserved_dir_and_redacts_token() {
        let temp_dir = std::env::temp_dir().join(format!("pi_git_test_fail_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let temp_dir_str = temp_dir.to_string_lossy().to_string();
        let dest_dir = temp_dir.join("Hello-World");

        let pat = "ghp_leakedSecretToken999";

        let runner = MockRunner {
            handler: move |_spec| {
                Ok(ProcessOutput {
                    success: false,
                    exit_code: Some(128),
                    stdout: String::new(),
                    stderr: format!("fatal: Authentication failed for 'https://github.com/octocat/Hello-World.git' using {pat}"),
                })
            },
        };

        let res = clone_github_repository_impl(
            "octocat/Hello-World",
            &temp_dir_str,
            Some(pat),
            &runner,
        )
        .await;

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(!err.contains(pat), "PAT must be redacted in error message");
        assert!(!dest_dir.exists(), "Reserved destination directory must be cleaned up on failure");
        assert!(temp_dir.exists(), "Parent directory must be preserved");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_group_repositories_by_owner_categorization() {
        let repo1 = GithubRepositorySummary {
            id: 1,
            name: "repo-alpha".into(),
            full_name: "myorg/repo-alpha".into(),
            owner: "myorg".into(),
            owner_type: Some("Organization".into()),
            owner_avatar_url: None,
            is_private: true,
            description: None,
            default_branch: Some("main".into()),
            updated_at: None,
            pushed_at: Some("2026-02-01T00:00:00Z".into()),
            html_url: "https://github.com/myorg/repo-alpha".into(),
            clone_url: "https://github.com/myorg/repo-alpha.git".into(),
            ssh_url: None,
            fork: false,
            archived: None,
            permissions: None,
        };
        let repo2 = GithubRepositorySummary {
            id: 2,
            name: "my-tool".into(),
            full_name: "testuser/my-tool".into(),
            owner: "testuser".into(),
            owner_type: Some("User".into()),
            owner_avatar_url: None,
            is_private: false,
            description: None,
            default_branch: Some("main".into()),
            updated_at: None,
            pushed_at: Some("2026-03-01T00:00:00Z".into()),
            html_url: "https://github.com/testuser/my-tool".into(),
            clone_url: "https://github.com/testuser/my-tool.git".into(),
            ssh_url: None,
            fork: false,
            archived: None,
            permissions: None,
        };
        let repo3 = GithubRepositorySummary {
            id: 3,
            name: "another-tool".into(),
            full_name: "collab/another-tool".into(),
            owner: "collab".into(),
            owner_type: Some("User".into()),
            owner_avatar_url: None,
            is_private: true,
            description: None,
            default_branch: Some("main".into()),
            updated_at: None,
            pushed_at: Some("2026-01-01T00:00:00Z".into()),
            html_url: "https://github.com/collab/another-tool".into(),
            clone_url: "https://github.com/collab/another-tool.git".into(),
            ssh_url: None,
            fork: false,
            archived: None,
            permissions: None,
        };

        let groups = group_repositories_by_owner(vec![repo1, repo2, repo3], Some("testuser"));
        assert_eq!(groups.len(), 3);
        // Current user must be first
        assert_eq!(groups[0].owner, "testuser");
        assert!(groups[0].is_current_user);
        assert_eq!(groups[0].repositories[0].name, "my-tool");

        // Remaining sorted alphabetically: collab, myorg
        assert_eq!(groups[1].owner, "collab");
        assert!(!groups[1].is_current_user);

        assert_eq!(groups[2].owner, "myorg");
        assert!(!groups[2].is_current_user);
    }

    #[tokio::test]
    async fn test_list_github_repositories_impl_with_gh() {
        let runner = MockRunner {
            handler: |spec| {
                if spec.program == "gh" && spec.args.contains(&"--version".to_string()) {
                    return Ok(ProcessOutput { success: true, exit_code: Some(0), stdout: "gh version 2.50.0".into(), stderr: String::new() });
                }
                if spec.program == "gh" && spec.args.contains(&"auth".to_string()) {
                    return Ok(ProcessOutput { success: true, exit_code: Some(0), stdout: "Logged in to github.com account octocat (keyring)".into(), stderr: String::new() });
                }
                if spec.program == "gh" && spec.args.contains(&"api".to_string()) {
                    let json = serde_json::json!([
                        {
                            "id": 1,
                            "name": "octo-repo",
                            "full_name": "octocat/octo-repo",
                            "owner": { "login": "octocat", "type": "User" },
                            "private": false,
                            "html_url": "https://github.com/octocat/octo-repo",
                            "clone_url": "https://github.com/octocat/octo-repo.git"
                        },
                        {
                            "id": 2,
                            "name": "team-lib",
                            "full_name": "orgx/team-lib",
                            "owner": { "login": "orgx", "type": "Organization" },
                            "private": true,
                            "html_url": "https://github.com/orgx/team-lib",
                            "clone_url": "https://github.com/orgx/team-lib.git"
                        }
                    ]);
                    return Ok(ProcessOutput { success: true, exit_code: Some(0), stdout: json.to_string(), stderr: String::new() });
                }
                Ok(ProcessOutput { success: true, exit_code: Some(0), stdout: String::new(), stderr: String::new() })
            },
        };

        let res = list_github_repositories_impl(None, &runner).await.unwrap();
        assert_eq!(res.total, 2);
        assert_eq!(res.current_user.as_deref(), Some("octocat"));
        assert_eq!(res.groups.len(), 2);
        assert_eq!(groups_find(&res.groups, "octocat").unwrap().is_current_user, true);
        assert_eq!(groups_find(&res.groups, "orgx").unwrap().is_current_user, false);
    }

    fn groups_find<'a>(groups: &'a [GithubOwnerGroup], owner: &str) -> Option<&'a GithubOwnerGroup> {
        groups.iter().find(|g| g.owner == owner)
    }
}
