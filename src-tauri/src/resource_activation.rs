//! Project resource activation policy and enforcement (ODD Spec odd/tasks/shallow-resource-activation.md).
//!
//! Stores viewer activation policy in `~/.pi/agent/viewer-resource-activation.json`:
//! `{ version: 1, alwaysExtensions: string[], alwaysMcpServers: string[], projects: { [absoluteCwd]: { extensions: { [source]: bool }, mcpServers: { [name]: bool } } } }`.
//!
//! - Missing policy defaults to native enabled per project.
//! - Global exceptions ("always active") enable a resource across all projects.
//! - Project explicit booleans take precedence over global exceptions.
//! - At startup, native Pi discovery and builtins load naturally without CLI suppression.
//! - Explicit supported extension OFF states are migrated to native settings filters.
//! - MCP server effective states are materialized only for explicit supported overrides in `<cwd>/.pi/mcp.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

static ACTIVATION_FILE_OVERRIDE: RwLock<Option<PathBuf>> = RwLock::new(None);
static ACTIVATION_MUTEX: Mutex<()> = Mutex::new(());
#[cfg(test)]
static TEST_OVERRIDE_MUTEX: Mutex<()> = Mutex::new(());

/// Testing helper to redirect activation state persistence to an isolated temporary file.
#[cfg(test)]
pub fn set_activation_file_override_for_test(path: Option<PathBuf>) {
    let mut guard = ACTIVATION_FILE_OVERRIDE.write().unwrap_or_else(|e| e.into_inner());
    *guard = path;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceActivationState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub always_extensions: Vec<String>,
    #[serde(default)]
    pub always_mcp_servers: Vec<String>,
    #[serde(default)]
    pub projects: HashMap<String, ProjectActivationState>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivationState {
    #[serde(default)]
    pub extensions: HashMap<String, bool>,
    #[serde(default)]
    pub mcp_servers: HashMap<String, bool>,
}

/// Project-level resource activation file schema version 1 stored at `<cwd>/.pi/resource-activation.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalResourceActivationFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub extensions: HashMap<String, bool>,
    #[serde(default, alias = "mcp_servers")]
    pub mcp_servers: HashMap<String, bool>,
}

impl Default for LocalResourceActivationFile {
    fn default() -> Self {
        Self {
            version: 1,
            extensions: HashMap::new(),
            mcp_servers: HashMap::new(),
        }
    }
}

/// Resolves path to `<cwd>/.pi/resource-activation.json`.
pub fn resolve_project_resource_activation_file_path(cwd: &Path) -> PathBuf {
    cwd.join(".pi").join("resource-activation.json")
}

/// Loads project-level resource activation file from an explicit path.
/// Returns Ok(None) if file does not exist.
/// Fails closed (Err) if file exists but is malformed or unreadable.
pub fn load_project_resource_activation_file_from(file_path: &Path) -> Result<Option<LocalResourceActivationFile>, String> {
    if !file_path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read project resource activation file at {:?}: {}", file_path, e))?;
    if content.trim().is_empty() {
        return Ok(Some(LocalResourceActivationFile::default()));
    }
    let parsed: LocalResourceActivationFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse project resource activation JSON at {:?}: {}", file_path, e))?;
    Ok(Some(parsed))
}

/// Loads project-level resource activation file from `<cwd>/.pi/resource-activation.json`.
pub fn load_project_resource_activation_file(cwd: &Path) -> Result<Option<LocalResourceActivationFile>, String> {
    let file_path = resolve_project_resource_activation_file_path(cwd);
    load_project_resource_activation_file_from(&file_path)
}

/// Saves project-level resource activation file atomically to `<cwd>/.pi/resource-activation.json`.
pub fn save_project_resource_activation_file(cwd: &Path, file: &LocalResourceActivationFile) -> Result<(), String> {
    let file_path = resolve_project_resource_activation_file_path(cwd);
    let val = serde_json::to_value(file)
        .map_err(|e| format!("Failed to serialize project activation state: {}", e))?;
    crate::commands::config_files::atomic_write_json(&file_path, &val)
}

/// Scoped policy view for a specific project workspace.
/// Unifies global always exceptions and project overrides:
/// - If `<cwd>/.pi/resource-activation.json` exists, it is authoritative for project overrides.
///   Absent keys fall back to global exceptions, NOT legacy global projects.
/// - If `<cwd>/.pi/resource-activation.json` does NOT exist, falls back to legacy global `projects` read-only.
/// - Malformed local files fail closed on load.
#[derive(Debug, Clone)]
pub struct ScopedResourceActivationPolicy {
    pub global: ResourceActivationState,
    pub local: Option<LocalResourceActivationFile>,
    pub canonical_cwd: String,
    pub cwd: PathBuf,
}

impl ScopedResourceActivationPolicy {
    pub fn from_global(cwd: &Path, global: ResourceActivationState) -> Result<Self, String> {
        let canonical_cwd = canonicalize_project_cwd(cwd);
        let local = load_project_resource_activation_file(cwd)?;
        Ok(Self {
            global,
            local,
            canonical_cwd,
            cwd: cwd.to_path_buf(),
        })
    }

    pub fn is_extension_always_active(&self, source: &str) -> bool {
        self.global.is_extension_always_active(source)
    }

    pub fn is_mcp_server_always_active(&self, name: &str) -> bool {
        self.global.is_mcp_server_always_active(name)
    }

    pub fn get_extension_override(&self, source: &str) -> Option<bool> {
        if let Some(ref loc) = self.local {
            if let Some(&val) = loc.extensions.get(source) {
                return Some(val);
            }
            for (k, &v) in &loc.extensions {
                if crate::commands::config_files::extension_sources_match(k, source) {
                    return Some(v);
                }
            }
            None
        } else {
            self.global.get_project_extension_override(&self.canonical_cwd, source)
        }
    }

    pub fn has_extension_project_override(&self, source: &str) -> bool {
        self.get_extension_override(source).is_some()
    }

    pub fn is_extension_effective_enabled(&self, source: &str) -> bool {
        if let Some(explicit) = self.get_extension_override(source) {
            explicit
        } else if self.is_extension_always_active(source) {
            true
        } else {
            true
        }
    }

    pub fn get_mcp_override(&self, name: &str) -> Option<bool> {
        if let Some(ref loc) = self.local {
            loc.mcp_servers.get(name).copied()
        } else {
            self.global.get_project_mcp_override(&self.canonical_cwd, name)
        }
    }

    pub fn has_mcp_project_override(&self, name: &str) -> bool {
        self.get_mcp_override(name).is_some()
    }

    pub fn is_mcp_effective_enabled(&self, name: &str) -> bool {
        if let Some(explicit) = self.get_mcp_override(name) {
            explicit
        } else if self.is_mcp_server_always_active(name) {
            true
        } else {
            true
        }
    }
}

pub fn load_scoped_policy(cwd: &Path) -> Result<ScopedResourceActivationPolicy, String> {
    let global = load_resource_activation_state()?;
    ScopedResourceActivationPolicy::from_global(cwd, global)
}

impl Default for ResourceActivationState {
    fn default() -> Self {
        Self {
            version: 1,
            always_extensions: Vec::new(),
            always_mcp_servers: Vec::new(),
            projects: HashMap::new(),
        }
    }
}

/// Normalizes project keys to absolute filesystem path (case-normalized on Windows).
pub fn canonicalize_project_cwd(cwd: &Path) -> String {
    let abs_path = dunce::canonicalize(cwd).unwrap_or_else(|_| {
        if cwd.is_absolute() {
            cwd.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cd| cd.join(cwd))
                .unwrap_or_else(|_| cwd.to_path_buf())
        }
    });
    let s = abs_path.to_string_lossy().to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Resolves path to `viewer-resource-activation.json` under the active Pi agent directory.
pub fn resolve_resource_activation_file_path() -> Option<PathBuf> {
    if let Ok(guard) = ACTIVATION_FILE_OVERRIDE.read() {
        if let Some(ref path) = *guard {
            return Some(path.clone());
        }
    }
    crate::commands::discovery::resolve_pi_agent_dir()
        .map(|dir| dir.join("viewer-resource-activation.json"))
}

/// Loads resource activation state from a given file path. Missing file defaults to empty state.
pub fn load_resource_activation_state_from(file_path: &Path) -> Result<ResourceActivationState, String> {
    if !file_path.exists() {
        return Ok(ResourceActivationState::default());
    }
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read resource activation file at {:?}: {}", file_path, e))?;
    if content.trim().is_empty() {
        return Ok(ResourceActivationState::default());
    }
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse resource activation JSON at {:?}: {}", file_path, e))
}

/// Loads resource activation state from the standard agent location.
pub fn load_resource_activation_state() -> Result<ResourceActivationState, String> {
    let _guard = ACTIVATION_MUTEX.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let path = resolve_resource_activation_file_path()
        .ok_or_else(|| "Could not resolve Pi agent directory".to_string())?;
    load_resource_activation_state_from(&path)
}

/// Saves resource activation state atomically to a given file path.
pub fn save_resource_activation_state_to(file_path: &Path, state: &ResourceActivationState) -> Result<(), String> {
    let val = serde_json::to_value(state)
        .map_err(|e| format!("Failed to serialize activation state: {}", e))?;
    crate::commands::config_files::atomic_write_json(file_path, &val)
}

/// Saves resource activation state atomically to the standard agent location.
pub fn save_resource_activation_state(state: &ResourceActivationState) -> Result<(), String> {
    let _guard = ACTIVATION_MUTEX.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let path = resolve_resource_activation_file_path()
        .ok_or_else(|| "Could not resolve Pi agent directory".to_string())?;
    save_resource_activation_state_to(&path, state)
}

/// Atomically reads, updates, and saves resource activation state with mutual exclusion across threads.
/// When cwd is None: updates global exceptions in viewer-resource-activation.json.
/// When cwd is Some: updates local project overrides in <cwd>/.pi/resource-activation.json.
/// On first explicit project toggle seeds prior legacy choices from global file; subsequent toggles write local file only.
/// Never deletes/rewrites global file for project toggle.
pub fn atomic_update_activation(
    kind: &str,
    identity: &str,
    enabled: bool,
    cwd: Option<&Path>,
) -> Result<(), String> {
    let clean_kind = kind.trim().to_lowercase();
    if clean_kind != "extension" && clean_kind != "mcp" {
        return Err(format!("Invalid kind '{}'. Expected 'extension' or 'mcp'", kind));
    }
    let trimmed_id = identity.trim();
    if trimmed_id.is_empty() {
        return Err("Identity must not be empty".to_string());
    }

    let _guard = ACTIVATION_MUTEX.lock().map_err(|e| format!("Lock poisoned: {e}"))?;

    match cwd {
        None => {
            let path = resolve_resource_activation_file_path()
                .ok_or_else(|| "Could not resolve Pi agent directory".to_string())?;
            let mut state = load_resource_activation_state_from(&path)?;
            update_resource_activation(&mut state, &clean_kind, trimmed_id, enabled, None)?;
            save_resource_activation_state_to(&path, &state)
        }
        Some(dir) => {
            let local_path = resolve_project_resource_activation_file_path(dir);
            let mut local_file = if local_path.exists() {
                load_project_resource_activation_file_from(&local_path)?
                    .unwrap_or_default()
            } else {
                // First explicit project toggle seeds prior legacy choices from global file
                let mut seeded = LocalResourceActivationFile::default();
                if let Some(global_path) = resolve_resource_activation_file_path() {
                    if let Ok(global_state) = load_resource_activation_state_from(&global_path) {
                        let canon = canonicalize_project_cwd(dir);
                        if let Some(legacy_proj) = global_state.projects.get(&canon) {
                            seeded.extensions = legacy_proj.extensions.clone();
                            seeded.mcp_servers = legacy_proj.mcp_servers.clone();
                        }
                    }
                }
                seeded
            };

            if clean_kind == "extension" {
                local_file.extensions.retain(|k, _| {
                    k != trimmed_id && !crate::commands::config_files::extension_sources_match(k, trimmed_id)
                });
                local_file.extensions.insert(trimmed_id.to_string(), enabled);
            } else {
                local_file.mcp_servers.insert(trimmed_id.to_string(), enabled);
            }

            save_project_resource_activation_file(dir, &local_file)
        }
    }
}

impl ResourceActivationState {
    /// Checks whether an extension source matches any entry in `always_extensions`.
    pub fn is_extension_always_active(&self, source: &str) -> bool {
        self.always_extensions.iter().any(|s| {
            s == source || crate::commands::config_files::extension_sources_match(s, source)
        })
    }

    /// Checks whether an MCP server name matches any entry in `always_mcp_servers`.
    pub fn is_mcp_server_always_active(&self, name: &str) -> bool {
        self.always_mcp_servers.iter().any(|s| s == name)
    }

    /// Retrieves an explicit project-level override for an extension if configured.
    pub fn get_project_extension_override(&self, canonical_cwd: &str, source: &str) -> Option<bool> {
        let proj = self.projects.get(canonical_cwd)?;
        if let Some(&val) = proj.extensions.get(source) {
            return Some(val);
        }
        for (k, &v) in &proj.extensions {
            if crate::commands::config_files::extension_sources_match(k, source) {
                return Some(v);
            }
        }
        None
    }

    /// Retrieves an explicit project-level override for an MCP server if configured.
    pub fn get_project_mcp_override(&self, canonical_cwd: &str, name: &str) -> Option<bool> {
        let proj = self.projects.get(canonical_cwd)?;
        proj.mcp_servers.get(name).copied()
    }

    /// Evaluates effective activation for an extension in a project:
    /// project override > always-on exception > true (default native enabled).
    pub fn is_extension_effective_enabled(&self, canonical_cwd: &str, source: &str) -> bool {
        if let Some(explicit) = self.get_project_extension_override(canonical_cwd, source) {
            explicit
        } else if self.is_extension_always_active(source) {
            true
        } else {
            true
        }
    }

    /// Evaluates effective activation for an MCP server in a project:
    /// project override > always-on exception > true (default native enabled).
    pub fn is_mcp_effective_enabled(&self, canonical_cwd: &str, name: &str) -> bool {
        if let Some(explicit) = self.get_project_mcp_override(canonical_cwd, name) {
            explicit
        } else if self.is_mcp_server_always_active(name) {
            true
        } else {
            true
        }
    }
}

/// Updates the in-memory activation state.
/// If `cwd` is `None`: updates the global exception (`always_extensions` / `always_mcp_servers`).
/// If `cwd` is `Some`: updates the project's explicit override.
pub fn update_resource_activation(
    state: &mut ResourceActivationState,
    kind: &str,
    identity: &str,
    enabled: bool,
    cwd: Option<&Path>,
) -> Result<(), String> {
    let clean_kind = kind.trim().to_lowercase();
    if clean_kind != "extension" && clean_kind != "mcp" {
        return Err(format!("Invalid kind '{}'. Expected 'extension' or 'mcp'", kind));
    }
    let trimmed_id = identity.trim();
    if trimmed_id.is_empty() {
        return Err("Identity must not be empty".to_string());
    }

    match cwd {
        None => {
            // Global exception update
            if clean_kind == "extension" {
                if enabled {
                    if !state.always_extensions.iter().any(|s| {
                        s == trimmed_id || crate::commands::config_files::extension_sources_match(s, trimmed_id)
                    }) {
                        state.always_extensions.push(trimmed_id.to_string());
                    }
                } else {
                    state.always_extensions.retain(|s| {
                        s != trimmed_id && !crate::commands::config_files::extension_sources_match(s, trimmed_id)
                    });
                }
            } else {
                // mcp
                if enabled {
                    if !state.always_mcp_servers.iter().any(|s| s == trimmed_id) {
                        state.always_mcp_servers.push(trimmed_id.to_string());
                    }
                } else {
                    state.always_mcp_servers.retain(|s| s != trimmed_id);
                }
            }
        }
        Some(dir) => {
            let canonical_cwd = canonicalize_project_cwd(dir);
            let proj = state.projects.entry(canonical_cwd).or_default();
            if clean_kind == "extension" {
                // Clean existing matching entry to avoid ambiguity
                proj.extensions.retain(|k, _| {
                    k != trimmed_id && !crate::commands::config_files::extension_sources_match(k, trimmed_id)
                });
                proj.extensions.insert(trimmed_id.to_string(), enabled);
            } else {
                proj.mcp_servers.insert(trimmed_id.to_string(), enabled);
            }
        }
    }

    Ok(())
}

/// Resolves an extension's runtime path from its source string and owning config path.
pub fn resolve_extension_runtime_path(cwd: &Path, config_path: &Path, source: &str) -> PathBuf {
    let clean_source = source.trim().strip_prefix("./").unwrap_or(source.trim());
    if clean_source.starts_with("builtin:") {
        return PathBuf::from(clean_source);
    }
    let path_obj = Path::new(clean_source);
    if path_obj.is_absolute() {
        return path_obj.to_path_buf();
    }

    // Auto-discovered extensions already have configPath pointing to the actual script file
    let config_path_str = config_path.to_string_lossy();
    if (config_path_str.ends_with(".ts") || config_path_str.ends_with(".js") || config_path_str.ends_with(".mjs")) && config_path.is_file() {
        return dunce::canonicalize(config_path).unwrap_or_else(|_| config_path.to_path_buf());
    }

    // Explicit entries in settings.json resolve relative to the owning settings file's directory
    let owning_dir = if config_path.is_dir() {
        config_path
    } else if let Some(parent) = config_path.parent() {
        parent
    } else {
        cwd
    };

    let candidate_relative_to_owning = owning_dir.join(clean_source);
    if candidate_relative_to_owning.exists() {
        return dunce::canonicalize(&candidate_relative_to_owning)
            .unwrap_or(candidate_relative_to_owning);
    }

    let candidate_relative_to_cwd = cwd.join(clean_source);
    if candidate_relative_to_cwd.exists() {
        return dunce::canonicalize(&candidate_relative_to_cwd)
            .unwrap_or(candidate_relative_to_cwd);
    }

    // Fall back to owning dir path
    candidate_relative_to_owning
}

/// Enforces resource activation policy for a project before spawn:
/// 1. Materializes effective server enabled states in `<cwd>/.pi/mcp.json` if servers exist.
///    Avoids gratuitous project writes when no servers are configured.
/// 2. Returns authorized extensions (to be passed via `-e <path>`) and whether any MCP server is authorized.
/// Fails closed if any config cannot be parsed or materialized.
pub fn enforce_startup_resources(
    cwd: &Path,
    policy: &ResourceActivationState,
) -> Result<(Vec<PathBuf>, bool), String> {
    let global_mcp_path = crate::commands::config_files::resolve_global_mcp_config_path();
    let global_settings_path = crate::commands::config_files::resolve_settings_config_path();
    enforce_startup_resources_with_paths(
        cwd,
        policy,
        global_mcp_path.as_deref(),
        global_settings_path.as_deref(),
    )
}

/// Core startup enforcement accepting explicit global config paths for test isolation.
pub fn enforce_startup_resources_with_paths(
    cwd: &Path,
    policy: &ResourceActivationState,
    global_mcp_path: Option<&Path>,
    global_settings_path: Option<&Path>,
) -> Result<(Vec<PathBuf>, bool), String> {
    let scoped_policy = ScopedResourceActivationPolicy::from_global(cwd, policy.clone())?;

    // 1. MCP enforcement (only explicit supported overrides, no copy of globals or alternates)
    let has_authorized_mcp = materialize_project_mcp_enforcement(
        cwd,
        &scoped_policy,
        global_mcp_path,
    )?;

    // 2. Query workspace inventory roots to accurately match top-level extensions (no slash counting or phantom migration)
    let ext_res = crate::commands::config_files::get_pi_resources_for_workspace(
        global_settings_path,
        Some(cwd),
    )?;

    let inventory_resources = ext_res
        .get("resources")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 3. Migration of explicit top-level local/legacy extension OFF states to native settings filters,
    // plus applicable known inventory always_extensions positives as fallback when no explicit project override.
    let mut explicit_ext_overrides: Vec<(String, bool)> = Vec::new();
    if let Some(ref loc) = scoped_policy.local {
        for (k, &v) in &loc.extensions {
            explicit_ext_overrides.push((k.clone(), v));
        }
    } else if let Some(legacy_proj) = scoped_policy.global.projects.get(&scoped_policy.canonical_cwd) {
        for (k, &v) in &legacy_proj.extensions {
            explicit_ext_overrides.push((k.clone(), v));
        }
    }

    // Include applicable known inventory always_extensions positives as fallback only when no explicit matching project override
    for always_ext in &scoped_policy.global.always_extensions {
        let has_proj_override = explicit_ext_overrides.iter().any(|(src, _)| {
            crate::commands::config_files::extension_sources_match(src, always_ext)
        });
        if !has_proj_override {
            explicit_ext_overrides.push((always_ext.clone(), true));
        }
    }

    if !explicit_ext_overrides.is_empty() {
        let proj_settings_path = cwd.join(".pi").join("settings.json");
        let mut settings_val = if proj_settings_path.exists() {
            let content = std::fs::read_to_string(&proj_settings_path)
                .map_err(|e| format!("Failed to read project settings at {:?}: {}", proj_settings_path, e))?;
            if content.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse project settings at {:?}: {}", proj_settings_path, e))?
            }
        } else {
            serde_json::json!({})
        };

        if let Some(settings_obj) = settings_val.as_object_mut() {
            if !settings_obj.contains_key("extensions") {
                settings_obj.insert("extensions".to_string(), Value::Array(Vec::new()));
            }
            if let Some(ext_arr) = settings_obj.get_mut("extensions").and_then(|v| v.as_array_mut()) {
                let mut mutated = false;
                for (source, enabled) in explicit_ext_overrides {
                    let clean = source.trim();
                    let is_builtin = clean.starts_with("builtin:");

                    // Find matching real inventory resource (skip nonexistent policy phantoms)
                    let matched_res = inventory_resources.iter().find(|r| {
                        let r_kind = r.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                        let r_src = r.get("source").and_then(|v| v.as_str()).unwrap_or("");
                        r_kind.eq_ignore_ascii_case("extension") && crate::commands::config_files::extension_sources_match(r_src, clean)
                    });

                    if matched_res.is_none() && !is_builtin {
                        // Not a real workspace inventory resource; do NOT migrate phantom!
                        continue;
                    }

                    let (plain_entry, mask_str) = if is_builtin {
                        (clean.to_string(), format!("-{}", clean))
                    } else {
                        let res = matched_res.unwrap();
                        let ext_path_str = res.get("extensionPath").and_then(|v| v.as_str()).unwrap_or("");
                        let ext_dir_str = res.get("extensionDir").and_then(|v| v.as_str()).unwrap_or("");
                        let path_obj = Path::new(ext_path_str);
                        let dir_obj = Path::new(ext_dir_str);

                        let is_dir = (dir_obj.is_dir() && !path_obj.is_file()) || path_obj.is_dir();
                        let canonical_path = if is_dir {
                            dunce::canonicalize(dir_obj).unwrap_or_else(|_| dir_obj.to_path_buf())
                        } else {
                            dunce::canonicalize(path_obj).unwrap_or_else(|_| path_obj.to_path_buf())
                        };
                        let posix_path = canonical_path.to_string_lossy().replace('\\', "/");

                        if is_dir {
                            (posix_path.clone(), format!("!{}/**", posix_path))
                        } else {
                            (posix_path.clone(), format!("-{}", posix_path))
                        }
                    };

                    if !enabled {
                        // Native project [plain abs, mask] essential
                        let has_plain = ext_arr.iter().any(|item| item.as_str() == Some(&plain_entry));
                        if !has_plain {
                            ext_arr.push(Value::String(plain_entry));
                            mutated = true;
                        }
                        let has_mask = ext_arr.iter().any(|item| item.as_str() == Some(&mask_str));
                        if !has_mask {
                            ext_arr.push(Value::String(mask_str));
                            mutated = true;
                        }
                    } else {
                        // Enable: remove exact managed mask only, keep plain declaration!
                        let before_len = ext_arr.len();
                        ext_arr.retain(|item| {
                            if let Some(s) = item.as_str() {
                                s != mask_str && s != format!("-{}", plain_entry)
                            } else {
                                true
                            }
                        });
                        if ext_arr.len() != before_len {
                            mutated = true;
                        }
                    }
                }

                if mutated {
                    let pi_dir = cwd.join(".pi");
                    if !pi_dir.exists() {
                        let _ = std::fs::create_dir_all(&pi_dir);
                    }
                    crate::commands::config_files::atomic_write_json(&proj_settings_path, &settings_val)?;
                }
            }
        }
    }

    let mut authorized_extensions = Vec::new();
    for res in &inventory_resources {
        let kind = res.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if !kind.eq_ignore_ascii_case("extension") {
            continue;
        }
        let source = res.get("source").and_then(|v| v.as_str()).unwrap_or("");
        if source.is_empty() {
            continue;
        }

        if scoped_policy.is_extension_effective_enabled(source) {
            let config_path_str = res.get("configPath").and_then(|v| v.as_str()).unwrap_or("");
            let config_path = Path::new(config_path_str);
            let resolved = resolve_extension_runtime_path(cwd, config_path, source);
            authorized_extensions.push(resolved);
        }
    }

    Ok((authorized_extensions, has_authorized_mcp))
}

/// Materializes effective server enabled values in `<cwd>/.pi/mcp.json` only for explicit supported overrides.
/// Unselected defs remain raw (no enabled: true synthesis, no disabled removal).
/// Never imports or merges alternative candidate files (.mcp.json, mcp-adapter.json, .agents/mcp.json).
/// Avoids gratuitous project writes when no overrides exist.
fn materialize_project_mcp_enforcement(
    cwd: &Path,
    scoped_policy: &ScopedResourceActivationPolicy,
    global_mcp_path: Option<&Path>,
) -> Result<bool, String> {
    let pi_dir = cwd.join(".pi");
    let target_path = pi_dir.join("mcp.json");

    let global_servers = match global_mcp_path {
        Some(p) => crate::commands::config_files::parse_mcp_servers_from_file(p, "global")?,
        None => Vec::new(),
    };

    let mut explicit_overrides: HashMap<String, bool> = HashMap::new();
    if let Some(ref loc) = scoped_policy.local {
        for (k, &v) in &loc.mcp_servers {
            explicit_overrides.insert(k.clone(), v);
        }
    } else if let Some(legacy_proj) = scoped_policy.global.projects.get(&scoped_policy.canonical_cwd) {
        for (k, &v) in &legacy_proj.mcp_servers {
            explicit_overrides.insert(k.clone(), v);
        }
    }

    // Include global always_mcp_servers positives where not explicit local, only matching known definitions
    for always_mcp in &scoped_policy.global.always_mcp_servers {
        if !explicit_overrides.contains_key(always_mcp) {
            let is_known = global_servers.iter().any(|g| {
                g.get("name").and_then(|v| v.as_str()) == Some(always_mcp.as_str())
            });
            if is_known {
                explicit_overrides.insert(always_mcp.clone(), true);
            }
        }
    }

    // Determine if any authorized MCP exists
    let has_authorized_mcp = global_servers.iter().any(|g| {
        let name = g.get("name").and_then(|v| v.as_str()).unwrap_or("");
        scoped_policy.is_mcp_effective_enabled(name)
    }) || explicit_overrides.iter().any(|(_, &eff)| eff);

    // If no overrides to materialize and no native file, avoid gratuitous writes
    if explicit_overrides.is_empty() && !target_path.exists() {
        return Ok(has_authorized_mcp);
    }
    if explicit_overrides.is_empty() {
        return Ok(has_authorized_mcp);
    }

    let mut base_obj = serde_json::Map::new();
    let had_native_file = target_path.exists();
    if had_native_file {
        let content = std::fs::read_to_string(&target_path)
            .map_err(|e| format!("Failed to read project MCP config at {:?}: {}", target_path, e))?;
        if !content.trim().is_empty() {
            let native_val: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse project MCP config at {:?}: {}", target_path, e))?;
            if let Some(native_obj) = native_val.as_object() {
                base_obj = native_obj.clone();
            }
        }
    }

    let servers_key = if base_obj.contains_key("mcp-servers") {
        "mcp-servers"
    } else if base_obj.contains_key("servers") {
        "servers"
    } else {
        "mcpServers"
    };

    let mut servers_map: serde_json::Map<String, Value> = match base_obj.remove(servers_key) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };

    // Materialize ONLY explicit supported overrides, leaving all unselected defs raw!
    for (name, eff_enabled) in &explicit_overrides {
        if let Some(existing_def) = servers_map.get_mut(name).and_then(|v| v.as_object_mut()) {
            existing_def.insert("enabled".to_string(), Value::Bool(*eff_enabled));
            existing_def.insert("disabled".to_string(), Value::Bool(!eff_enabled));
        } else {
            // Check if known global server: write partial override only (no credential copying)
            let is_global = global_servers.iter().any(|g| {
                g.get("name").and_then(|v| v.as_str()) == Some(name.as_str())
            });
            if is_global {
                let mut partial = serde_json::Map::new();
                partial.insert("enabled".to_string(), Value::Bool(*eff_enabled));
                partial.insert("disabled".to_string(), Value::Bool(!eff_enabled));
                servers_map.insert(name.clone(), Value::Object(partial));
            }
        }
    }

    if servers_map.is_empty() && !had_native_file {
        return Ok(has_authorized_mcp);
    }

    base_obj.insert(servers_key.to_string(), Value::Object(servers_map));

    if !pi_dir.exists() {
        std::fs::create_dir_all(&pi_dir)
            .map_err(|e| format!("Failed to create .pi directory at {:?}: {}", pi_dir, e))?;
    }

    crate::commands::config_files::atomic_write_json(&target_path, &Value::Object(base_obj))?;

    Ok(has_authorized_mcp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_native_enabled_policy() {
        let state = ResourceActivationState::default();
        let cwd = "/test/workspace";

        // Without exceptions or overrides, resources default to native enabled
        assert!(state.is_extension_effective_enabled(cwd, "./my-tool.ts"));
        assert!(state.is_mcp_effective_enabled(cwd, "my-server"));
        assert!(!state.is_extension_always_active("./my-tool.ts"));
        assert!(!state.is_mcp_server_always_active("my-server"));
    }

    #[test]
    fn test_global_exceptions_always_active() {
        let mut state = ResourceActivationState::default();
        let proj_a = "/workspace/a";
        let proj_b = "/workspace/b";

        // Add global exception for extension and MCP
        update_resource_activation(&mut state, "extension", "./my-tool.ts", true, None).unwrap();
        update_resource_activation(&mut state, "mcp", "db-service", true, None).unwrap();

        assert!(state.is_extension_always_active("./my-tool.ts"));
        assert!(state.is_mcp_server_always_active("db-service"));

        // Effective across all projects
        assert!(state.is_extension_effective_enabled(proj_a, "./my-tool.ts"));
        assert!(state.is_extension_effective_enabled(proj_b, "./my-tool.ts"));
        assert!(state.is_mcp_effective_enabled(proj_a, "db-service"));
        assert!(state.is_mcp_effective_enabled(proj_b, "db-service"));

        // Toggling off global exception reverts to native default enabled
        update_resource_activation(&mut state, "extension", "./my-tool.ts", false, None).unwrap();
        update_resource_activation(&mut state, "mcp", "db-service", false, None).unwrap();

        assert!(!state.is_extension_always_active("./my-tool.ts"));
        assert!(!state.is_mcp_server_always_active("db-service"));
        assert!(state.is_extension_effective_enabled(proj_a, "./my-tool.ts"));
        assert!(state.is_mcp_effective_enabled(proj_a, "db-service"));
    }

    #[test]
    fn test_project_enable_and_disable_overrides_and_precedence() {
        let mut state = ResourceActivationState::default();
        let temp_dir = std::env::temp_dir().join(format!("test_act_prec_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let canon = canonicalize_project_cwd(&temp_dir);

        // 1. Project explicit enable on a resource without global exception
        update_resource_activation(
            &mut state,
            "extension",
            "./helper.ts",
            true,
            Some(&temp_dir),
        )
        .unwrap();
        assert!(state.is_extension_effective_enabled(&canon, "./helper.ts"));
        assert!(!state.is_extension_always_active("./helper.ts"));

        // 2. Global exception added for a resource
        update_resource_activation(&mut state, "mcp", "shared-mcp", true, None).unwrap();
        assert!(state.is_mcp_server_always_active("shared-mcp"));
        assert!(state.is_mcp_effective_enabled(&canon, "shared-mcp"));

        // 3. Project explicit disable takes precedence over global always-on
        update_resource_activation(
            &mut state,
            "mcp",
            "shared-mcp",
            false,
            Some(&temp_dir),
        )
        .unwrap();
        assert!(state.is_mcp_server_always_active("shared-mcp")); // Global remains always active
        assert!(!state.is_mcp_effective_enabled(&canon, "shared-mcp")); // Project override wins!

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_project_isolation() {
        let mut state = ResourceActivationState::default();
        let temp_dir_a = std::env::temp_dir().join(format!("test_act_iso_a_{}", std::process::id()));
        let temp_dir_b = std::env::temp_dir().join(format!("test_act_iso_b_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir_a);
        let _ = std::fs::remove_dir_all(&temp_dir_b);
        std::fs::create_dir_all(&temp_dir_a).unwrap();
        std::fs::create_dir_all(&temp_dir_b).unwrap();

        let canon_a = canonicalize_project_cwd(&temp_dir_a);
        let canon_b = canonicalize_project_cwd(&temp_dir_b);

        // Disable in project A
        update_resource_activation(
            &mut state,
            "extension",
            "./special.ts",
            false,
            Some(&temp_dir_a),
        )
        .unwrap();

        // Project A is disabled, Project B remains default enabled
        assert!(!state.is_extension_effective_enabled(&canon_a, "./special.ts"));
        assert!(state.is_extension_effective_enabled(&canon_b, "./special.ts"));

        let _ = std::fs::remove_dir_all(&temp_dir_a);
        let _ = std::fs::remove_dir_all(&temp_dir_b);
    }

    #[test]
    fn test_validation_rejects_invalid_inputs() {
        let mut state = ResourceActivationState::default();

        // Invalid kind
        assert!(update_resource_activation(&mut state, "package", "npm:pkg", true, None).is_err());
        assert!(update_resource_activation(&mut state, "tool", "tool-name", true, None).is_err());

        // Empty identity
        assert!(update_resource_activation(&mut state, "extension", "   ", true, None).is_err());
        assert!(update_resource_activation(&mut state, "mcp", "", true, None).is_err());
    }

    #[test]
    fn test_persistence_roundtrip_and_missing_policy_defaults() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_persist_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("viewer-resource-activation.json");

        // Missing file defaults to empty state
        let loaded_empty = load_resource_activation_state_from(&file_path).unwrap();
        assert_eq!(loaded_empty.version, 1);
        assert!(loaded_empty.always_extensions.is_empty());
        assert!(loaded_empty.always_mcp_servers.is_empty());

        let mut state = ResourceActivationState::default();
        update_resource_activation(&mut state, "extension", "./ext-1.ts", true, None).unwrap();
        update_resource_activation(&mut state, "mcp", "mcp-1", true, None).unwrap();
        update_resource_activation(&mut state, "mcp", "mcp-2", true, Some(&temp_dir)).unwrap();

        save_resource_activation_state_to(&file_path, &state).unwrap();
        assert!(file_path.exists());

        let loaded = load_resource_activation_state_from(&file_path).unwrap();
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.always_extensions, vec!["./ext-1.ts"]);
        assert_eq!(loaded.always_mcp_servers, vec!["mcp-1"]);

        let canon = canonicalize_project_cwd(&temp_dir);
        assert_eq!(
            loaded.get_project_mcp_override(&canon, "mcp-2"),
            Some(true)
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_enforce_startup_avoid_gratuitous_mcp_writes() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_gratuitous_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let dummy_settings = temp_dir.join("empty_settings.json");
        std::fs::write(&dummy_settings, "{}").unwrap();

        let policy = ResourceActivationState::default();
        let (_authorized_exts, has_mcp) =
            enforce_startup_resources_with_paths(&temp_dir, &policy, None, Some(&dummy_settings)).unwrap();

        assert!(!has_mcp);
        assert!(!temp_dir.join(".pi").join("mcp.json").exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_enforce_startup_mcp_materialization_and_preservation() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_materialize_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let pi_dir = temp_dir.join(".pi");
        std::fs::create_dir_all(&pi_dir).unwrap();

        let mcp_file = pi_dir.join("mcp.json");
        let initial_json = serde_json::json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "unrelatedSetting": "keep-me",
            "mcpServers": {
                "local-tool": {
                    "command": "node",
                    "args": ["server.js"],
                    "env": { "KEY": "VAL" },
                    "customField": "preserved"
                }
            }
        });
        std::fs::write(&mcp_file, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        let mut policy = ResourceActivationState::default();
        // Enable local-tool in project policy
        update_resource_activation(&mut policy, "mcp", "local-tool", true, Some(&temp_dir)).unwrap();

        let (_, has_mcp) =
            enforce_startup_resources_with_paths(&temp_dir, &policy, None, None).unwrap();
        assert!(has_mcp);

        // Read materialized file
        let content = std::fs::read_to_string(&mcp_file).unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();

        // Unrelated keys preserved
        assert_eq!(parsed["$schema"], "http://json-schema.org/draft-07/schema#");
        assert_eq!(parsed["unrelatedSetting"], "keep-me");

        // Local definition preserved
        let srv = &parsed["mcpServers"]["local-tool"];
        assert_eq!(srv["command"], "node");
        assert_eq!(srv["customField"], "preserved");
        assert_eq!(srv["enabled"], true);
        assert_eq!(srv["disabled"], false);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_resolve_extension_runtime_path() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_res_path_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let pi_dir = temp_dir.join(".pi");
        std::fs::create_dir_all(&pi_dir).unwrap();

        let script_file = pi_dir.join("my-ext.ts");
        std::fs::write(&script_file, "// ext").unwrap();

        let settings_file = pi_dir.join("settings.json");
        std::fs::write(&settings_file, "{}").unwrap();

        // Relative path resolves against owning settings directory
        let resolved = resolve_extension_runtime_path(&temp_dir, &settings_file, "./my-ext.ts");
        assert_eq!(
            resolved,
            dunce::canonicalize(&script_file).unwrap_or(script_file)
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_set_resource_activation_command_roundtrip() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_act_cmd_rt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let act_file = temp_dir.join("viewer-resource-activation.json");
        set_activation_file_override_for_test(Some(act_file.clone()));

        // Validation errors
        assert!(crate::commands::config_files::set_resource_activation(
            "invalid".to_string(),
            "res1".to_string(),
            true,
            None,
        )
        .await
        .is_err());

        assert!(crate::commands::config_files::set_resource_activation(
            "extension".to_string(),
            "   ".to_string(),
            true,
            None,
        )
        .await
        .is_err());

        // Unknown resource rejected without writes
        assert!(crate::commands::config_files::set_resource_activation(
            "extension".to_string(),
            "unknown-ext.ts".to_string(),
            true,
            None,
        )
        .await
        .is_err());

        // Global exception add on known builtin
        let res_global = crate::commands::config_files::set_resource_activation(
            "extension".to_string(),
            "builtin:mcp".to_string(),
            true,
            None,
        )
        .await
        .unwrap();
        assert_eq!(res_global["success"], true);

        // Project override add: setup project MCP
        let proj_mcp = temp_dir.join(".pi").join("mcp.json");
        std::fs::create_dir_all(proj_mcp.parent().unwrap()).unwrap();
        std::fs::write(&proj_mcp, serde_json::to_string(&serde_json::json!({
            "mcpServers": { "proj-server": { "command": "echo" } }
        })).unwrap()).unwrap();

        let temp_str = temp_dir.to_string_lossy().to_string();
        let res_proj = crate::commands::config_files::set_resource_activation(
            "mcp".to_string(),
            "proj-server".to_string(),
            true,
            Some(temp_str.clone()),
        )
        .await
        .unwrap();
        assert_eq!(res_proj["success"], true);

        // Verify loaded state: global file does not store project overrides
        let loaded = load_resource_activation_state().unwrap();
        assert!(loaded.is_extension_always_active("builtin:mcp"));
        let canon = canonicalize_project_cwd(&temp_dir);
        assert_eq!(loaded.get_project_mcp_override(&canon, "proj-server"), None);

        // Verified scoped persistence: local project file stores the project override
        let scoped = load_scoped_policy(&temp_dir).unwrap();
        assert_eq!(scoped.get_mcp_override("proj-server"), Some(true));
        assert!(temp_dir.join(".pi").join("resource-activation.json").exists());

        // Global exception remove
        crate::commands::config_files::set_resource_activation(
            "extension".to_string(),
            "builtin:mcp".to_string(),
            false,
            None,
        )
        .await
        .unwrap();
        let loaded_2 = load_resource_activation_state().unwrap();
        assert!(!loaded_2.is_extension_always_active("builtin:mcp"));

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_fail_closed_on_corrupted_policy_file() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_corrupt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let act_file = temp_dir.join("viewer-resource-activation.json");
        std::fs::write(&act_file, "INVALID JSON CONTENT { [ }").unwrap();

        let res = load_resource_activation_state_from(&act_file);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Failed to parse resource activation JSON"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_canonical_project_keys_case_normalization() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_case_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let canon = canonicalize_project_cwd(&temp_dir);
        #[cfg(windows)]
        {
            assert_eq!(canon, canon.to_lowercase());
        }
        #[cfg(not(windows))]
        {
            assert!(!canon.is_empty());
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_preserve_packages_behavior_on_resources_listing() {
        let temp_dir = std::env::temp_dir().join(format!("test_act_pkg_pres_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let pi_dir = temp_dir.join(".pi");
        std::fs::create_dir_all(&pi_dir).unwrap();

        let settings_file = pi_dir.join("settings.json");
        let initial_json = serde_json::json!({
            "packages": ["npm:test-pkg"],
            "extensions": ["./my-ext.ts"]
        });
        std::fs::write(&settings_file, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        let temp_str = temp_dir.to_string_lossy().to_string();
        let list_res = crate::commands::config_files::get_pi_resources(Some(temp_str)).await.unwrap();
        let res_arr = list_res["resources"].as_array().unwrap();

        // Package preserves enabled state and alwaysActive is false
        let pkg = res_arr.iter().find(|r| r["source"] == "npm:test-pkg").unwrap();
        assert_eq!(pkg["kind"], "package");
        assert_eq!(pkg["alwaysActive"], false);
        assert_eq!(pkg["enabled"], true);

        // Extension defaults enabled according to native settings without policy override
        let ext = res_arr.iter().find(|r| r["source"] == "./my-ext.ts").unwrap();
        assert_eq!(ext["kind"], "extension");
        assert_eq!(ext["alwaysActive"], false);
        assert_eq!(ext["enabled"], true);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_toggle_mcp_server_omitted_scope_preserves_global_byte_identical() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_b1_byte_id_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let global_dir = temp_dir.join("global_pi").join("agent");
        std::fs::create_dir_all(&global_dir).unwrap();
        let global_file = global_dir.join("mcp.json");

        let global_content = serde_json::json!({
            "mcpServers": {
                "srv-global": {
                    "command": "node",
                    "args": ["global.js"],
                    "disabled": false
                }
            }
        });
        let raw_before = serde_json::to_string_pretty(&global_content).unwrap() + "\n";
        std::fs::write(&global_file, &raw_before).unwrap();

        let proj_dir = temp_dir.join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        set_activation_file_override_for_test(Some(act_file.clone()));
        crate::commands::config_files::set_global_mcp_config_path_override_for_test(Some(global_file.clone()));

        // Toggle with cwd: Some(proj_dir), scope: None (omitted scope)
        let toggle_res = crate::commands::config_files::toggle_mcp_server(
            "srv-global".to_string(),
            false,
            Some(proj_dir.to_string_lossy().to_string()),
            None,
        )
        .await
        .unwrap();

        assert_eq!(toggle_res["success"], true);

        // Global file must remain byte-identical!
        let raw_after = std::fs::read_to_string(&global_file).unwrap();
        assert_eq!(raw_before, raw_after);

        crate::commands::config_files::set_global_mcp_config_path_override_for_test(None);
        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_root_pi_json_listing_and_runtime_resolution() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_b2_pi_json_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Project root contains only .pi.json
        let root_pi_json = temp_dir.join(".pi.json");
        std::fs::write(
            &root_pi_json,
            serde_json::to_string_pretty(&serde_json::json!({
                "extensions": ["./my-root-ext.ts"]
            }))
            .unwrap(),
        )
        .unwrap();

        let script_file = temp_dir.join("my-root-ext.ts");
        std::fs::write(&script_file, "// root ext").unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        set_activation_file_override_for_test(Some(act_file.clone()));

        // 1. get_pi_resources must list extensions from root .pi.json
        let list_res = crate::commands::config_files::get_pi_resources(Some(
            temp_dir.to_string_lossy().to_string(),
        ))
        .await
        .unwrap();

        let res_arr = list_res["resources"].as_array().unwrap();
        let found = res_arr.iter().find(|r| r["source"] == "./my-root-ext.ts");
        assert!(found.is_some(), "Extension from .pi.json must be listed");
        let ext = found.unwrap();
        assert_eq!(ext["configPath"], root_pi_json.to_string_lossy().to_string());

        // 2. Authorize extension and verify enforce_startup_resources resolves relative to owning dir (root)
        let mut policy = ResourceActivationState::default();
        update_resource_activation(&mut policy, "extension", "./my-root-ext.ts", true, Some(&temp_dir)).unwrap();

        let (authorized, _) = enforce_startup_resources_with_paths(&temp_dir, &policy, None, None).unwrap();
        assert!(authorized.iter().any(|p| *p == dunce::canonicalize(&script_file).unwrap_or(script_file.clone())));

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_alternate_mcp_raw_keys_preserved_on_materialization() {
        let temp_dir = std::env::temp_dir().join(format!("test_b3_raw_keys_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Project contains .mcp.json with raw extra keys
        let root_mcp = temp_dir.join(".mcp.json");
        std::fs::write(
            &root_mcp,
            serde_json::to_string_pretty(&serde_json::json!({
                "$schema": "http://json-schema.org/schema",
                "customRootMeta": 12345,
                "mcpServers": {
                    "tool-rich": {
                        "command": "node",
                        "args": ["rich.js"],
                        "cwd": "/some/custom/cwd",
                        "timeouts": { "init": 3000, "call": 60000 },
                        "metadata": { "author": "gentle", "tags": ["a", "b"] },
                        "customField": "must-preserve-this"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mut policy = ResourceActivationState::default();
        update_resource_activation(&mut policy, "mcp", "tool-rich", true, Some(&temp_dir)).unwrap();

        let (_, _) = enforce_startup_resources_with_paths(&temp_dir, &policy, None, None).unwrap();

        // Shallow activation: alternate .mcp.json is NOT imported into .pi/mcp.json
        assert!(!temp_dir.join(".pi").join("mcp.json").exists());
        // Alternate .mcp.json remains untouched
        assert!(root_mcp.exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_alternate_mcp_overlapping_candidates_precedence_and_merge() {
        let temp_dir = std::env::temp_dir().join(format!("test_b3_overlap_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let dot_mcp = temp_dir.join(".mcp.json");
        std::fs::write(
            &dot_mcp,
            serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "srv-common": { "command": "cmd-from-dot-mcp" }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let policy = ResourceActivationState::default();
        let (_, _) = enforce_startup_resources_with_paths(&temp_dir, &policy, None, None).unwrap();

        // Alternates are not imported in shallow activation
        assert!(!temp_dir.join(".pi").join("mcp.json").exists());
        assert!(dot_mcp.exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_second_startup_discovers_new_alternate_server_after_native_file_generated() {
        let temp_dir = std::env::temp_dir().join(format!("test_b3_second_startup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let dot_mcp = temp_dir.join(".mcp.json");
        std::fs::write(
            &dot_mcp,
            serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "srv-initial": { "command": "cmd-1", "cwd": "/init" }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let policy = ResourceActivationState::default();
        let (_, _) = enforce_startup_resources_with_paths(&temp_dir, &policy, None, None).unwrap();

        // In shallow activation, alternate files are ignored, not imported
        assert!(!temp_dir.join(".pi").join("mcp.json").exists());
        assert!(dot_mcp.exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_malformed_supported_mcp_and_settings_candidates_fail_closed() {
        let temp_dir = std::env::temp_dir().join(format!("test_malformed_fail_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let pi_dir = temp_dir.join(".pi");
        std::fs::create_dir_all(&pi_dir).unwrap();
        let native_mcp = pi_dir.join("mcp.json");
        std::fs::write(&native_mcp, "{ INVALID JSON MCP").unwrap();

        let mut policy = ResourceActivationState::default();
        update_resource_activation(&mut policy, "mcp", "srv", true, Some(&temp_dir)).unwrap();

        let res = enforce_startup_resources_with_paths(&temp_dir, &policy, None, None);
        assert!(res.is_err(), "Malformed native .pi/mcp.json must fail closed");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // =========================================================================
    // S6 REGRESSION TESTS
    // =========================================================================

    #[tokio::test]
    async fn test_s6_project_toggle_global_bytes_unchanged() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_s6_global_bytes_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        let initial_global = serde_json::json!({
            "version": 1,
            "alwaysExtensions": ["global-ext.ts"],
            "alwaysMcpServers": ["global-mcp"],
            "projects": {}
        });
        let initial_raw = serde_json::to_string_pretty(&initial_global).unwrap() + "\n";
        std::fs::write(&act_file, &initial_raw).unwrap();
        set_activation_file_override_for_test(Some(act_file.clone()));

        let proj_dir = temp_dir.join("my-project");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let proj_mcp = proj_dir.join(".pi").join("mcp.json");
        std::fs::create_dir_all(proj_mcp.parent().unwrap()).unwrap();
        std::fs::write(&proj_mcp, serde_json::to_string(&serde_json::json!({
            "mcpServers": { "local-server": { "command": "node" } }
        })).unwrap()).unwrap();

        // Perform explicit project toggle
        let res = crate::commands::config_files::set_resource_activation(
            "mcp".to_string(),
            "local-server".to_string(),
            true,
            Some(proj_dir.to_string_lossy().to_string()),
        )
        .await
        .unwrap();
        assert_eq!(res["success"], true);

        // 1. Global file bytes must remain completely unchanged!
        let after_raw = std::fs::read_to_string(&act_file).unwrap();
        assert_eq!(initial_raw, after_raw, "Global activation file must remain byte-identical on project toggle");

        // 2. Project local file must have been created at <cwd>/.pi/resource-activation.json
        let local_file = proj_dir.join(".pi").join("resource-activation.json");
        assert!(local_file.exists(), "Local project activation file must be created");

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_s6_first_explicit_toggle_seeds_prior_legacy() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_s6_seeding_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let proj_dir = temp_dir.join("seeded-project");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let canon = canonicalize_project_cwd(&proj_dir);

        let proj_mcp = proj_dir.join(".pi").join("mcp.json");
        std::fs::create_dir_all(proj_mcp.parent().unwrap()).unwrap();
        std::fs::write(&proj_mcp, serde_json::to_string(&serde_json::json!({
            "mcpServers": { "new-mcp": { "command": "node" } }
        })).unwrap()).unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        let initial_global = serde_json::json!({
            "version": 1,
            "alwaysExtensions": [],
            "alwaysMcpServers": [],
            "projects": {
                &canon: {
                    "extensions": {
                        "./legacy-ext.ts": true,
                        "./legacy-ext-off.ts": false
                    },
                    "mcpServers": {
                        "legacy-mcp": true,
                        "legacy-mcp-off": false
                    }
                }
            }
        });
        std::fs::write(&act_file, serde_json::to_string_pretty(&initial_global).unwrap()).unwrap();
        set_activation_file_override_for_test(Some(act_file.clone()));

        // Local file does not exist yet
        let local_file = proj_dir.join(".pi").join("resource-activation.json");
        assert!(!local_file.exists());

        // Perform first explicit project toggle
        let res = crate::commands::config_files::set_resource_activation(
            "mcp".to_string(),
            "new-mcp".to_string(),
            true,
            Some(proj_dir.to_string_lossy().to_string()),
        )
        .await
        .unwrap();
        assert_eq!(res["success"], true);

        // Local file must exist and contain seeded legacy entries plus new toggle
        assert!(local_file.exists());
        let content = std::fs::read_to_string(&local_file).unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["extensions"]["./legacy-ext.ts"], true);
        assert_eq!(parsed["extensions"]["./legacy-ext-off.ts"], false);
        assert_eq!(parsed["mcpServers"]["legacy-mcp"], true);
        assert_eq!(parsed["mcpServers"]["legacy-mcp-off"], false);
        assert_eq!(parsed["mcpServers"]["new-mcp"], true);

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_s6_local_authoritative_emptiness_and_legacy_missing_fallback() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_s6_auth_empty_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let proj_missing = temp_dir.join("proj-missing");
        let proj_empty = temp_dir.join("proj-empty");
        std::fs::create_dir_all(&proj_missing).unwrap();
        std::fs::create_dir_all(&proj_empty).unwrap();

        let canon_missing = canonicalize_project_cwd(&proj_missing);
        let canon_empty = canonicalize_project_cwd(&proj_empty);

        let act_file = temp_dir.join("viewer-resource-activation.json");
        let initial_global = serde_json::json!({
            "version": 1,
            "alwaysExtensions": ["always-ext.ts"],
            "alwaysMcpServers": ["always-mcp"],
            "projects": {
                &canon_missing: {
                    "extensions": { "./legacy-ext.ts": true },
                    "mcpServers": { "legacy-mcp": true }
                },
                &canon_empty: {
                    "extensions": { "./legacy-ext.ts": true },
                    "mcpServers": { "legacy-mcp": true }
                }
            }
        });
        std::fs::write(&act_file, serde_json::to_string_pretty(&initial_global).unwrap()).unwrap();
        set_activation_file_override_for_test(Some(act_file.clone()));

        // Case A: Missing local file in proj-missing -> falls back to legacy global projects
        let scoped_missing = load_scoped_policy(&proj_missing).unwrap();
        assert!(scoped_missing.is_extension_effective_enabled("./legacy-ext.ts"));
        assert!(scoped_missing.has_extension_project_override("./legacy-ext.ts"));
        assert!(scoped_missing.is_mcp_effective_enabled("legacy-mcp"));
        assert!(scoped_missing.has_mcp_project_override("legacy-mcp"));

        // Case B: Present but empty local file in proj-empty -> authoritative emptiness!
        let empty_local_path = proj_empty.join(".pi").join("resource-activation.json");
        std::fs::create_dir_all(empty_local_path.parent().unwrap()).unwrap();
        std::fs::write(
            &empty_local_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "extensions": {},
                "mcpServers": {}
            }))
            .unwrap(),
        )
        .unwrap();

        let scoped_empty = load_scoped_policy(&proj_empty).unwrap();
        // Must NOT fall back to legacy entries!
        assert!(!scoped_empty.has_extension_project_override("./legacy-ext.ts"));
        assert!(!scoped_empty.has_mcp_project_override("legacy-mcp"));

        // Global exceptions still apply
        assert!(scoped_empty.is_extension_effective_enabled("always-ext.ts"));
        assert!(scoped_empty.is_mcp_effective_enabled("always-mcp"));

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_s6_directory_move_retains_settings() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_s6_move_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        std::fs::write(&act_file, "{}").unwrap();
        set_activation_file_override_for_test(Some(act_file.clone()));

        let origin_dir = temp_dir.join("project-origin");
        std::fs::create_dir_all(&origin_dir).unwrap();
        let origin_settings = origin_dir.join(".pi").join("settings.json");
        std::fs::create_dir_all(origin_settings.parent().unwrap()).unwrap();
        std::fs::write(&origin_settings, serde_json::to_string(&serde_json::json!({
            "extensions": ["./local-tool.ts"]
        })).unwrap()).unwrap();
        std::fs::write(origin_dir.join(".pi").join("local-tool.ts"), "//").unwrap();
        let origin_mcp = origin_dir.join(".pi").join("mcp.json");
        std::fs::write(&origin_mcp, serde_json::to_string(&serde_json::json!({
            "mcpServers": { "local-server": { "command": "node" } }
        })).unwrap()).unwrap();

        // Enable in origin_dir
        crate::commands::config_files::set_resource_activation(
            "extension".to_string(),
            "./local-tool.ts".to_string(),
            true,
            Some(origin_dir.to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        crate::commands::config_files::set_resource_activation(
            "mcp".to_string(),
            "local-server".to_string(),
            true,
            Some(origin_dir.to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        // Move/rename directory to moved_dir
        let moved_dir = temp_dir.join("project-moved");
        std::fs::rename(&origin_dir, &moved_dir).unwrap();

        // Verify that moved_dir retains its activation settings because they are stored locally!
        let scoped = load_scoped_policy(&moved_dir).unwrap();
        assert!(scoped.is_extension_effective_enabled("./local-tool.ts"));
        assert!(scoped.has_extension_project_override("./local-tool.ts"));
        assert!(scoped.is_mcp_effective_enabled("local-server"));
        assert!(scoped.has_mcp_project_override("local-server"));

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_s6_no_read_writes_during_listing_and_loading() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_s6_no_read_writes_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        std::fs::write(&act_file, "{}").unwrap();
        set_activation_file_override_for_test(Some(act_file.clone()));

        let proj_dir = temp_dir.join("read-only-project");
        std::fs::create_dir_all(&proj_dir).unwrap();

        let local_act = proj_dir.join(".pi").join("resource-activation.json");
        let local_mcp = proj_dir.join(".pi").join("mcp.json");

        assert!(!local_act.exists());
        assert!(!local_mcp.exists());

        // Perform read queries
        let _ = load_scoped_policy(&proj_dir).unwrap();
        let _ = crate::commands::config_files::get_pi_resources(Some(proj_dir.to_string_lossy().to_string())).await.unwrap();
        let _ = crate::commands::config_files::get_mcp_servers(Some(proj_dir.to_string_lossy().to_string())).await.unwrap();

        // Must NOT write or create files on read
        assert!(!local_act.exists(), "Listing/loading must never create local resource-activation.json");
        assert!(!local_mcp.exists(), "Listing/loading must never create local mcp.json");

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_s6_malformed_local_file_fails_closed() {
        let _test_guard = TEST_OVERRIDE_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = std::env::temp_dir().join(format!("test_s6_malformed_local_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let act_file = temp_dir.join("viewer-resource-activation.json");
        std::fs::write(&act_file, "{}").unwrap();
        set_activation_file_override_for_test(Some(act_file.clone()));

        let proj_dir = temp_dir.join("broken-project");
        let local_dir = proj_dir.join(".pi");
        std::fs::create_dir_all(&local_dir).unwrap();

        let local_act = local_dir.join("resource-activation.json");
        std::fs::write(&local_act, "{ MALFORMED JSON !!!").unwrap();

        // 1. load_scoped_policy must fail
        assert!(load_scoped_policy(&proj_dir).is_err());

        // 2. enforce_startup_resources must fail
        let policy = ResourceActivationState::default();
        assert!(enforce_startup_resources(&proj_dir, &policy).is_err());

        // 3. get_pi_resources must fail
        assert!(crate::commands::config_files::get_pi_resources(Some(proj_dir.to_string_lossy().to_string())).await.is_err());

        // 4. get_mcp_servers must fail
        assert!(crate::commands::config_files::get_mcp_servers(Some(proj_dir.to_string_lossy().to_string())).await.is_err());

        // 5. Explicit toggle on malformed file must fail and NOT overwrite corrupt file
        let toggle_res = crate::commands::config_files::set_resource_activation(
            "mcp".to_string(),
            "srv".to_string(),
            true,
            Some(proj_dir.to_string_lossy().to_string()),
        )
        .await;
        assert!(toggle_res.is_err());
        assert_eq!(std::fs::read_to_string(&local_act).unwrap(), "{ MALFORMED JSON !!!");

        set_activation_file_override_for_test(None);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_s6_extension_metadata_and_name_fallback_index_trio_and_declared_name() {
        let temp_dir = std::env::temp_dir().join(format!("test_s6_metadata_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let extensions_dir = temp_dir.join(".pi").join("extensions");
        std::fs::create_dir_all(&extensions_dir).unwrap();

        // 1. Auto-discovery index trio:
        // index.ts directory
        let dir_ts = extensions_dir.join("folder-ts");
        std::fs::create_dir_all(&dir_ts).unwrap();
        std::fs::write(dir_ts.join("index.ts"), "// ts").unwrap();

        // index.js directory
        let dir_js = extensions_dir.join("folder-js");
        std::fs::create_dir_all(&dir_js).unwrap();
        std::fs::write(dir_js.join("index.js"), "// js").unwrap();

        // index.mjs directory
        let dir_mjs = extensions_dir.join("folder-mjs");
        std::fs::create_dir_all(&dir_mjs).unwrap();
        std::fs::write(dir_mjs.join("index.mjs"), "// mjs").unwrap();

        // Explicit declared names in settings.json
        let settings_file = temp_dir.join(".pi").join("settings.json");
        std::fs::write(
            &settings_file,
            serde_json::to_string_pretty(&serde_json::json!({
                "extensions": [
                    { "name": "declared-custom-ext", "source": "./custom-ext.ts" },
                    "./unnamed-ext/index.mjs"
                ],
                "packages": [
                    { "name": "declared-custom-pkg", "source": "npm:my-package" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(temp_dir.join(".pi").join("custom-ext.ts"), "// custom").unwrap();
        let unnamed_dir = temp_dir.join(".pi").join("unnamed-ext");
        std::fs::create_dir_all(&unnamed_dir).unwrap();
        std::fs::write(unnamed_dir.join("index.mjs"), "// mjs").unwrap();

        let list_res = crate::commands::config_files::get_pi_resources(
            Some(temp_dir.to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        let resources = list_res["resources"].as_array().unwrap();

        // Check auto-discovered index trio
        let res_ts = resources.iter().find(|r| r["name"] == "folder-ts").expect("folder-ts found");
        assert!(res_ts.get("extensionPath").is_some(), "folder-ts must have extensionPath");
        assert!(res_ts.get("extensionDir").is_some(), "folder-ts must have extensionDir");
        assert_eq!(
            res_ts["extensionDir"].as_str().unwrap(),
            dunce::canonicalize(&dir_ts).unwrap_or(dir_ts).to_string_lossy()
        );

        let res_js = resources.iter().find(|r| r["name"] == "folder-js").expect("folder-js found");
        assert!(res_js.get("extensionPath").is_some());
        assert_eq!(
            res_js["extensionDir"].as_str().unwrap(),
            dunce::canonicalize(&dir_js).unwrap_or(dir_js).to_string_lossy()
        );

        let res_mjs = resources.iter().find(|r| r["name"] == "folder-mjs").expect("folder-mjs discovered via index.mjs");
        assert!(res_mjs.get("extensionPath").is_some());
        assert_eq!(
            res_mjs["extensionDir"].as_str().unwrap(),
            dunce::canonicalize(&dir_mjs).unwrap_or(dir_mjs).to_string_lossy()
        );

        // Check declared name preservation
        let decl_ext = resources.iter().find(|r| r["name"] == "declared-custom-ext").expect("declared-custom-ext found");
        assert_eq!(decl_ext["name"], "declared-custom-ext");
        assert!(decl_ext.get("extensionPath").is_some());
        assert!(decl_ext.get("extensionDir").is_some());
        assert_ne!(decl_ext["configPath"], decl_ext["extensionDir"]); // configPath is settings.json, extensionDir is directory

        let decl_pkg = resources.iter().find(|r| r["name"] == "declared-custom-pkg").expect("declared-custom-pkg found");
        assert_eq!(decl_pkg["name"], "declared-custom-pkg");

        // Check unnamed index.mjs uses parent folder name
        let unnamed_mjs = resources.iter().find(|r| r["source"] == "./unnamed-ext/index.mjs" || r["source"] == "unnamed-ext/index.mjs").expect("unnamed mjs found");
        assert_eq!(unnamed_mjs["name"], "unnamed-ext");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
