//! Configuration file operations for custom providers and model thinking levels.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use serde_json::Value;

use super::AppState;



pub fn resolve_models_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;

    Some(home.join(".pi").join("agent").join("models.json"))
}

/// Validates providers input map and extracts sanitized provider configurations.
pub fn validate_and_extract_providers(input: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let providers_map = if let Some(map) = input.as_object() {
        if let Some(inner) = map.get("providers") {
            inner.as_object().ok_or_else(|| "'providers' field must be an object".to_string())?
        } else {
            map
        }
    } else {
        return Err("Providers payload must be a JSON object".to_string());
    };

    let mut validated = serde_json::Map::new();

    for (provider_id, provider_val) in providers_map {
        let id_trimmed = provider_id.trim();
        if id_trimmed.is_empty() {
            return Err("Provider ID must not be empty".to_string());
        }
        if !id_trimmed
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/')
        {
            return Err(format!(
                "Provider ID '{}' contains invalid characters. Use letters, digits, '-', '_', '.', or '/'",
                id_trimmed
            ));
        }

        let provider_obj = provider_val.as_object().ok_or_else(|| {
            format!("Provider '{}' configuration must be an object", id_trimmed)
        })?;

        let base_url = provider_obj.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.trim());
        if let Some(url) = base_url {
            if url.is_empty() {
                return Err(format!("Provider '{}' baseUrl must not be empty", id_trimmed));
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(format!(
                    "Provider '{}' baseUrl must start with http:// or https://, got '{}'",
                    id_trimmed, url
                ));
            }
        } else {
            return Err(format!("Provider '{}' missing required 'baseUrl'", id_trimmed));
        }

        let api_type = provider_obj.get("api").and_then(|v| v.as_str()).map(|s| s.trim());
        if let Some(api) = api_type {
            if api.is_empty() {
                return Err(format!("Provider '{}' 'api' field must not be empty", id_trimmed));
            }
        } else {
            return Err(format!("Provider '{}' missing required 'api' field", id_trimmed));
        }

        if let Some(models_val) = provider_obj.get("models") {
            let models_arr = models_val.as_array().ok_or_else(|| {
                format!("Provider '{}' 'models' field must be an array", id_trimmed)
            })?;
            for (idx, m_val) in models_arr.iter().enumerate() {
                let m_obj = m_val.as_object().ok_or_else(|| {
                    format!("Model at index {} in provider '{}' must be an object", idx, id_trimmed)
                })?;
                let m_id = m_obj.get("id").and_then(|v| v.as_str()).map(|s| s.trim());
                if m_id.is_none() || m_id.unwrap().is_empty() {
                    return Err(format!(
                        "Model at index {} in provider '{}' is missing required 'id'",
                        idx, id_trimmed
                    ));
                }
            }
        }

        if let Some(excluded_val) = provider_obj.get("excludedModels") {
            let excluded_arr = excluded_val.as_array().ok_or_else(|| {
                format!("Provider '{}' 'excludedModels' field must be an array", id_trimmed)
            })?;
            for (idx, item) in excluded_arr.iter().enumerate() {
                if !item.is_string() {
                    return Err(format!(
                        "Excluded model at index {} in provider '{}' must be a string",
                        idx, id_trimmed
                    ));
                }
            }
        }

        if let Some(included_val) = provider_obj.get("includedModels") {
            let included_arr = included_val.as_array().ok_or_else(|| {
                format!("Provider '{}' 'includedModels' field must be an array", id_trimmed)
            })?;
            for (idx, item) in included_arr.iter().enumerate() {
                if !item.is_string() {
                    return Err(format!(
                        "Included model at index {} in provider '{}' must be a string",
                        idx, id_trimmed
                    ));
                }
            }
        }

        validated.insert(id_trimmed.to_string(), provider_val.clone());
    }

    Ok(validated)
}

/// Reads `models.json` configuration and returns its contents as a JSON Value.
/// If the file does not exist, returns `{"providers": {}}`.
pub fn get_custom_providers_impl(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        let mut map = serde_json::Map::new();
        map.insert("providers".to_string(), Value::Object(serde_json::Map::new()));
        return Ok(Value::Object(map));
    }

    let contents = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read models.json: {}", e))?;

    if contents.trim().is_empty() {
        let mut map = serde_json::Map::new();
        map.insert("providers".to_string(), Value::Object(serde_json::Map::new()));
        return Ok(Value::Object(map));
    }

    let parsed: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse models.json: {}", e))?;

    if !parsed.is_object() {
        return Err("models.json root must be a JSON object".to_string());
    }

    Ok(parsed)
}

/// Reads models config file failing closed on unreadable or malformed JSON.
/// If file does not exist, returns an empty JSON object map.
pub fn read_models_config_file(config_path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !config_path.exists() {
        return Ok(serde_json::Map::new());
    }

    let contents = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read models.json at {:?}: {}", config_path, e))?;

    if contents.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }

    let parsed: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse models.json at {:?}: {}", config_path, e))?;

    parsed
        .as_object()
        .cloned()
        .ok_or_else(|| format!("models.json root at {:?} must be a JSON object", config_path))
}

/// Atomically writes a JSON map to a file path.
pub fn write_models_config_file_atomically(
    path: &Path,
    root_obj: &serde_json::Map<String, Value>,
    create_parent: bool,
) -> Result<(), String> {
    if create_parent {
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
            }
        }
    }

    let final_json = Value::Object(root_obj.clone());
    let serialized = serde_json::to_string_pretty(&final_json)
        .map_err(|e| format!("Failed to serialize models.json: {}", e))?;

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_file_path = path.with_extension(format!("tmp.{}.{}", std::process::id(), nonce));
    std::fs::write(&temp_file_path, serialized)
        .map_err(|e| format!("Failed to write temporary config file {:?}: {}", temp_file_path, e))?;

    if let Err(e) = std::fs::rename(&temp_file_path, path) {
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!("Failed to commit config file to {:?}: {}", path, e));
    }

    Ok(())
}

/// Validates a single provider's fields and returns the sanitized provider object.
pub fn extract_and_validate_single_provider(
    provider_id: &str,
    provider_data: &Value,
) -> Result<(String, serde_json::Map<String, Value>), String> {
    let id_trimmed = provider_id.trim();
    if id_trimmed.is_empty() {
        return Err("Provider ID must not be empty".to_string());
    }
    if !id_trimmed
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/')
    {
        return Err(format!(
            "Provider ID '{}' contains invalid characters. Use letters, digits, '-', '_', '.', or '/'",
            id_trimmed
        ));
    }

    let provider_obj = if let Some(map) = provider_data.as_object() {
        if let Some(inner) = map.get("provider").and_then(|v| v.as_object()) {
            inner
        } else {
            map
        }
    } else {
        return Err("Provider payload must be a JSON object".to_string());
    };

    let base_url = provider_obj.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.trim());
    if let Some(url) = base_url {
        if url.is_empty() {
            return Err(format!("Provider '{}' baseUrl must not be empty", id_trimmed));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(format!(
                "Provider '{}' baseUrl must start with http:// or https://, got '{}'",
                id_trimmed, url
            ));
        }
    } else {
        return Err(format!("Provider '{}' missing required 'baseUrl'", id_trimmed));
    }

    let api_type = provider_obj.get("api").and_then(|v| v.as_str()).map(|s| s.trim());
    if let Some(api) = api_type {
        if api.is_empty() {
            return Err(format!("Provider '{}' 'api' field must not be empty", id_trimmed));
        }
    } else {
        return Err(format!("Provider '{}' missing required 'api' field", id_trimmed));
    }

    if let Some(models_val) = provider_obj.get("models") {
        let models_arr = models_val.as_array().ok_or_else(|| {
            format!("Provider '{}' 'models' field must be an array", id_trimmed)
        })?;
        for (idx, m_val) in models_arr.iter().enumerate() {
            let m_obj = m_val.as_object().ok_or_else(|| {
                format!("Model at index {} in provider '{}' must be an object", idx, id_trimmed)
            })?;
            let m_id = m_obj.get("id").and_then(|v| v.as_str()).map(|s| s.trim());
            if m_id.is_none() || m_id.unwrap().is_empty() {
                return Err(format!(
                    "Model at index {} in provider '{}' is missing required 'id'",
                    idx, id_trimmed
                ));
            }
        }
    }

    if let Some(excluded_val) = provider_obj.get("excludedModels") {
        let excluded_arr = excluded_val.as_array().ok_or_else(|| {
            format!("Provider '{}' 'excludedModels' field must be an array", id_trimmed)
        })?;
        for (idx, item) in excluded_arr.iter().enumerate() {
            if !item.is_string() {
                return Err(format!(
                    "Excluded model at index {} in provider '{}' must be a string",
                    idx, id_trimmed
                ));
            }
        }
    }

    if let Some(included_val) = provider_obj.get("includedModels") {
        let included_arr = included_val.as_array().ok_or_else(|| {
            format!("Provider '{}' 'includedModels' field must be an array", id_trimmed)
        })?;
        for (idx, item) in included_arr.iter().enumerate() {
            if !item.is_string() {
                return Err(format!(
                    "Included model at index {} in provider '{}' must be a string",
                    idx, id_trimmed
                ));
            }
        }
    }

    Ok((id_trimmed.to_string(), provider_obj.clone()))
}

/// Merges a validated provider object into a root models.json map.
/// Preserves unrelated root keys and unrelated providers.
/// Preserves unknown fields on the edited provider and merges models keyed on `id`.
pub fn apply_provider_merge_to_root(
    root_obj: &mut serde_json::Map<String, Value>,
    provider_id: &str,
    provider_obj: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let providers_val = root_obj
        .entry("providers".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));

    let providers_map = providers_val
        .as_object_mut()
        .ok_or_else(|| "'providers' field in models.json must be a JSON object".to_string())?;

    let mut target_provider = match providers_map.get(provider_id) {
        Some(Value::Object(map)) => map.clone(),
        Some(_) => {
            return Err(format!(
                "Existing provider '{}' in models.json must be a JSON object",
                provider_id
            ));
        }
        None => serde_json::Map::new(),
    };

    for (k, v) in provider_obj {
        if k == "id" {
            continue;
        }
        if k == "models" {
            if let Some(inc_models) = v.as_array() {
                let existing_models = match target_provider.get("models") {
                    Some(Value::Array(arr)) => arr.clone(),
                    Some(_) => {
                        return Err(format!(
                            "Existing 'models' field in provider '{}' must be an array",
                            provider_id
                        ));
                    }
                    None => Vec::new(),
                };

                let mut merged_models: Vec<Value> = Vec::new();
                let mut matched_existing_ids: HashSet<String> = HashSet::new();

                for inc_m_val in inc_models {
                    if let Some(inc_m_obj) = inc_m_val.as_object() {
                        let inc_m_id = inc_m_obj
                            .get("id")
                            .and_then(|id| id.as_str())
                            .map(|s| s.trim())
                            .unwrap_or("");

                        let existing_match = existing_models.iter().find(|m| {
                            m.as_object()
                                .and_then(|o| o.get("id"))
                                .and_then(|id| id.as_str())
                                .map(|s| s.trim() == inc_m_id)
                                .unwrap_or(false)
                        });

                        if let Some(existing_m_val) = existing_match {
                            if let Some(existing_m_obj) = existing_m_val.as_object() {
                                matched_existing_ids.insert(inc_m_id.to_string());
                                let mut merged_m = existing_m_obj.clone();
                                for (mk, mv) in inc_m_obj {
                                    if mv.is_null() {
                                        merged_m.remove(mk);
                                    } else {
                                        merged_m.insert(mk.clone(), mv.clone());
                                    }
                                }
                                merged_models.push(Value::Object(merged_m));
                                continue;
                            }
                        }
                        merged_models.push(inc_m_val.clone());
                    } else {
                        merged_models.push(inc_m_val.clone());
                    }
                }

                // Preserve unmatched existing models so external models are not deleted
                for ext_m_val in &existing_models {
                    if let Some(ext_m_obj) = ext_m_val.as_object() {
                        let ext_m_id = ext_m_obj
                            .get("id")
                            .and_then(|id| id.as_str())
                            .map(|s| s.trim())
                            .unwrap_or("");
                        if !ext_m_id.is_empty() && !matched_existing_ids.contains(ext_m_id) {
                            merged_models.push(ext_m_val.clone());
                        }
                    } else {
                        // Non-object model entry: preserve safely so protected unknown config is retained
                        merged_models.push(ext_m_val.clone());
                    }
                }

                target_provider.insert("models".to_string(), Value::Array(merged_models));
            }
        } else if v.is_null() {
            target_provider.remove(k);
        } else {
            target_provider.insert(k.clone(), v.clone());
        }
    }

    providers_map.insert(provider_id.to_string(), Value::Object(target_provider));
    Ok(())
}

/// Checks whether a Gentle Shell custom home resolves to the same target as the main Pi configuration,
/// including direct path equality, symlinks/junctions, and canonical path equivalence.
pub fn is_same_config_target(main_config_path: &Path, gs_home_dir: &Path) -> bool {
    let gs_models_path = gs_home_dir.join("models.json");

    // 1. Direct path equality
    if main_config_path == gs_models_path {
        return true;
    }
    if let Some(main_parent) = main_config_path.parent() {
        if main_parent == gs_home_dir {
            return true;
        }
    }

    // 2. Canonical path equality on models.json (resolves symlinks)
    if let (Ok(canon_main), Ok(canon_gs)) = (main_config_path.canonicalize(), gs_models_path.canonicalize()) {
        if canon_main == canon_gs {
            return true;
        }
    }

    // 3. Canonical path equality on containing directories
    if let Some(main_parent) = main_config_path.parent() {
        if let (Ok(canon_main_dir), Ok(canon_gs_dir)) = (main_parent.canonicalize(), gs_home_dir.canonicalize()) {
            if canon_main_dir == canon_gs_dir {
                return true;
            }
        }
    }

    false
}

/// Resolves effective Gentle Shell sync target home directory.
///
/// Precedence & rules:
/// - Absent config (~/.gentle-shell/config.json missing, invalid JSON, or empty "home") or explicit "isolated"
///   propagates to default isolated home.
/// - Default isolated home honors GENTLE_SHELL_HOME environment variable if set and non-empty,
///   otherwise `<user_home>/.gentle-shell/agent`.
/// - Config `{ "home": "link" }` skips duplicate main home (returns `Ok(None)`).
/// - Explicit custom path retains relative cwd semantics against workspace_cwd (fails closed with error
///   if relative and workspace cwd is missing or invalid directory).
/// - Never creates directory during resolution (existing directory guard is maintained by callers).
pub fn resolve_gentle_shell_sync_target_impl<E, F>(
    user_home: Option<&Path>,
    workspace_cwd: Option<&Path>,
    get_env: E,
    read_config: F,
) -> Result<Option<PathBuf>, String>
where
    E: Fn(&str) -> Option<String>,
    F: Fn(&Path) -> Option<String>,
{
    let Some(user_home) = user_home else {
        return Ok(None);
    };

    let default_isolated_home = get_env("GENTLE_SHELL_HOME")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".gentle-shell").join("agent"));

    let config_path = user_home.join(".gentle-shell").join("config.json");
    let launcher_config = read_config(&config_path).and_then(|text| {
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let obj = v.as_object()?;
        let home_val = obj.get("home")?.as_str()?;
        let trimmed = home_val.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    match launcher_config.as_deref() {
        Some(s) if s.eq_ignore_ascii_case("link") => {
            // Mode link uses main Pi home directly; sync skips duplicate main home
            Ok(None)
        }
        Some(s) if s.eq_ignore_ascii_case("isolated") => {
            // Explicit isolated mode propagates to default isolated home
            Ok(Some(default_isolated_home))
        }
        Some(custom_path_str) => {
            let custom_path = PathBuf::from(custom_path_str);
            if custom_path.is_absolute() {
                Ok(Some(custom_path))
            } else if let Some(base) = workspace_cwd {
                if !base.as_os_str().is_empty() && base.is_dir() {
                    Ok(Some(base.join(&custom_path)))
                } else {
                    Err(format!(
                        "Gentle Shell config specifies relative custom home '{}', but workspace directory {:?} is invalid.",
                        custom_path_str, base
                    ))
                }
            } else {
                Err(format!(
                    "Gentle Shell config specifies relative custom home '{}', but no active workspace cwd could be resolved.",
                    custom_path_str
                ))
            }
        }
        None => {
            // Absent config, invalid JSON, or missing/empty "home" falls back to default isolated home
            Ok(Some(default_isolated_home))
        }
    }
}

/// Resolves Gentle Shell effective home directory for provider sync from system environment and ~/.gentle-shell/config.json.
pub fn resolve_gentle_shell_sync_target(
    user_home: Option<&Path>,
    workspace_cwd: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    resolve_gentle_shell_sync_target_impl(
        user_home,
        workspace_cwd,
        |k| std::env::var(k).ok(),
        |p| std::fs::read_to_string(p).ok(),
    )
}

/// Resolves configured Gentle Shell custom home for provider sync from ~/.gentle-shell/config.json.
/// Backwards-compatible facade over resolve_gentle_shell_sync_target_impl.
pub fn resolve_gentle_shell_custom_home_for_sync_impl<F>(
    user_home: Option<&Path>,
    workspace_cwd: Option<&Path>,
    read_config: F,
) -> Result<Option<PathBuf>, String>
where
    F: Fn(&Path) -> Option<String>,
{
    resolve_gentle_shell_sync_target_impl(
        user_home,
        workspace_cwd,
        |k| std::env::var(k).ok(),
        read_config,
    )
}

/// Resolves Gentle Shell custom home directory from system ~/.gentle-shell/config.json.
/// Backwards-compatible facade over resolve_gentle_shell_sync_target.
pub fn resolve_gentle_shell_custom_home_for_sync(
    user_home: Option<&Path>,
    workspace_cwd: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    resolve_gentle_shell_sync_target(user_home, workspace_cwd)
}

/// Propagates a provider upsert to an existing Gentle Shell custom home.
/// Does not create unsolicited custom home directories.
/// Fails closed if the Gentle Shell models.json is unreadable or malformed.
pub fn propagate_provider_upsert_to_gentle_shell(
    user_home: Option<&Path>,
    workspace_cwd: Option<&Path>,
    provider_id: &str,
    provider_obj: &serde_json::Map<String, Value>,
) -> Result<bool, String> {
    let Some(custom_home) = resolve_gentle_shell_custom_home_for_sync(user_home, workspace_cwd)? else {
        return Ok(false);
    };

    if !custom_home.is_dir() {
        return Ok(false);
    }

    if let Some(home) = user_home {
        let main_models_path = home.join(".pi").join("agent").join("models.json");
        if is_same_config_target(&main_models_path, &custom_home) {
            return Ok(false);
        }
    }

    let gs_models_path = custom_home.join("models.json");
    let mut gs_root = read_models_config_file(&gs_models_path)?;
    apply_provider_merge_to_root(&mut gs_root, provider_id, provider_obj)?;
    write_models_config_file_atomically(&gs_models_path, &gs_root, false)?;
    Ok(true)
}

/// Validates and saves custom providers to `models.json`, preserving other top-level keys.
/// Fails closed on unreadable or malformed files, fixing silent loss behavior.
pub fn save_custom_providers_impl(config_path: &Path, providers_input: &Value) -> Result<Value, String> {
    let validated_providers = validate_and_extract_providers(providers_input)?;

    let mut root_obj = read_models_config_file(config_path)?;

    for (p_id, p_val) in &validated_providers {
        if let Some(obj) = p_val.as_object() {
            apply_provider_merge_to_root(&mut root_obj, p_id, obj)?;
        }
    }

    write_models_config_file_atomically(config_path, &root_obj, true)?;

    Ok(Value::Object(root_obj))
}

/// Upserts a single custom provider additively into main Pi models.json and propagates to Gentle Shell custom home.
pub fn upsert_custom_provider_impl(
    main_config_path: &Path,
    provider_id: &str,
    provider_data: &Value,
    user_home: Option<&Path>,
    workspace_cwd: Option<&Path>,
) -> Result<Value, String> {
    // 1. Read main models.json, failing closed on unreadable or malformed files
    let mut main_root = read_models_config_file(main_config_path)?;

    // 2. Validate provider_id and extract provider object
    let (id_trimmed, provider_obj) = extract_and_validate_single_provider(provider_id, provider_data)?;

    // 3. Resolve Gentle Shell custom home if configured (fails closed on unresolvable relative path)
    let gs_custom_home = resolve_gentle_shell_custom_home_for_sync(user_home, workspace_cwd)?;

    // If Gentle Shell custom home exists and is not a duplicate of main Pi config,
    // validate its models.json BEFORE modifying anything
    let gs_target = if let Some(ref home_dir) = gs_custom_home {
        if home_dir.is_dir() && !is_same_config_target(main_config_path, home_dir) {
            let gs_models_path = home_dir.join("models.json");
            let gs_root = read_models_config_file(&gs_models_path)?;
            Some((gs_models_path, gs_root))
        } else {
            None
        }
    } else {
        None
    };

    // 4. Additive merge into main models.json
    apply_provider_merge_to_root(&mut main_root, &id_trimmed, &provider_obj)?;

    // 5. If Gentle Shell target is valid and not duplicate, additive merge into Gentle Shell models.json
    let gs_update = if let Some((gs_models_path, mut gs_root)) = gs_target {
        apply_provider_merge_to_root(&mut gs_root, &id_trimmed, &provider_obj)?;
        Some((gs_models_path, gs_root))
    } else {
        None
    };

    // 6. Write main config atomically
    write_models_config_file_atomically(main_config_path, &main_root, true)?;

    // 7. Write Gentle Shell config atomically if present (never creating unsolicited home and skipping duplicate)
    if let Some((gs_models_path, gs_root)) = gs_update {
        write_models_config_file_atomically(&gs_models_path, &gs_root, false)?;
    }

    Ok(Value::Object(main_root))
}

/// Deletes a custom provider from the main Pi models.json only.
/// Does NOT touch Gentle Shell custom home.
pub fn delete_custom_provider_impl(
    main_config_path: &Path,
    provider_id: &str,
) -> Result<Value, String> {
    let id_trimmed = provider_id.trim();
    if id_trimmed.is_empty() {
        return Err("Provider ID must not be empty".to_string());
    }

    if !main_config_path.exists() {
        let mut map = serde_json::Map::new();
        map.insert("providers".to_string(), Value::Object(serde_json::Map::new()));
        return Ok(Value::Object(map));
    }

    let mut main_root = read_models_config_file(main_config_path)?;

    if let Some(providers_val) = main_root.get("providers") {
        if !providers_val.is_object() {
            return Err("'providers' field in models.json must be a JSON object".to_string());
        }
    }

    if let Some(Value::Object(ref mut providers_map)) = main_root.get_mut("providers") {
        providers_map.remove(id_trimmed);
    }

    write_models_config_file_atomically(main_config_path, &main_root, true)?;

    // NOTICE: Gentle Shell is deliberately NOT modified on delete!
    // "Delete targets only selected main provider, not Gentle Shell."

    Ok(Value::Object(main_root))
}

/// Fetch configured custom model providers from ~/.pi/agent/models.json
#[tauri::command]
pub async fn get_custom_providers() -> Result<Value, String> {
    let path = resolve_models_config_path()
        .ok_or_else(|| "Could not resolve user home directory for models.json".to_string())?;
    get_custom_providers_impl(&path)
}

/// Save custom model providers to ~/.pi/agent/models.json and propagate to configured Gentle Shell custom home.
#[tauri::command]
pub async fn save_custom_providers(
    providers: Value,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let path = resolve_models_config_path()
        .ok_or_else(|| "Could not resolve user home directory for models.json".to_string())?;
    let workspace_cwd = state.active_cwd.lock().await.clone();
    let user_home = resolve_user_home();
    let validated = validate_and_extract_providers(&providers)?;

    // If Gentle Shell target exists and is not duplicate, validate it BEFORE modifying main Pi
    if let Some(home) = user_home.as_deref() {
        if let Ok(Some(gs_home)) = resolve_gentle_shell_custom_home_for_sync(Some(home), workspace_cwd.as_deref()) {
            if gs_home.is_dir() && !is_same_config_target(&path, &gs_home) {
                let gs_models_path = gs_home.join("models.json");
                let _ = read_models_config_file(&gs_models_path)?;
            }
        }
    }

    let saved = save_custom_providers_impl(&path, &providers)?;
    if let Some(home) = user_home.as_deref() {
        for (p_id, p_val) in validated {
            if let Some(obj) = p_val.as_object() {
                propagate_provider_upsert_to_gentle_shell(
                    Some(home),
                    workspace_cwd.as_deref(),
                    &p_id,
                    obj,
                )?;
            }
        }
    }
    Ok(saved)
}

/// Upsert a single custom model provider and propagate to Gentle Shell custom home if configured.
#[tauri::command]
pub async fn upsert_custom_provider(
    provider: Value,
    provider_id: Option<String>,
    cwd: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let path = resolve_models_config_path()
        .ok_or_else(|| "Could not resolve user home directory for models.json".to_string())?;
    let user_home = resolve_user_home();
    let p_id = provider_id
        .or_else(|| {
            provider
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| "Provider ID is required".to_string())?;

    let active_cwd = state.active_cwd.lock().await.clone();
    let workspace_cwd = cwd
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or(active_cwd);

    upsert_custom_provider_impl(
        &path,
        &p_id,
        &provider,
        user_home.as_deref(),
        workspace_cwd.as_deref(),
    )
}

/// Delete a custom model provider from main Pi models.json only (does not touch Gentle Shell).
#[tauri::command]
pub async fn delete_custom_provider(
    provider_id: Option<String>,
    id: Option<String>,
) -> Result<Value, String> {
    let path = resolve_models_config_path()
        .ok_or_else(|| "Could not resolve user home directory for models.json".to_string())?;
    let p_id = provider_id
        .or(id)
        .ok_or_else(|| "Provider ID is required".to_string())?;

    delete_custom_provider_impl(&path, &p_id)
}

pub const VALID_THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Resolves canonical path to `settings.json` under `$USERPROFILE` / `$HOME` / `.pi/agent/settings.json`.
pub fn resolve_settings_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;

    Some(home.join(".pi").join("agent").join("settings.json"))
}

/// Reads `settings.json` configuration and returns its `"modelThinkingLevels"` map as a JSON Value.
/// If the file does not exist, or does not contain an object `"modelThinkingLevels"`, returns `{}`.
pub fn get_model_thinking_levels_impl(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let contents = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read settings.json: {}", e))?;

    if contents.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }

    let parsed: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse settings.json: {}", e))?;

    if let Some(levels) = parsed.get("modelThinkingLevels") {
        if levels.is_object() {
            return Ok(levels.clone());
        }
    }

    Ok(serde_json::json!({}))
}

/// Validates and saves model thinking levels to `settings.json`, preserving all other top-level keys.
pub fn save_model_thinking_levels_impl(
    config_path: &Path,
    updates: &Value,
) -> Result<Value, String> {
    let updates_map = updates
        .as_object()
        .ok_or_else(|| "Thinking levels updates must be a JSON object".to_string())?;

    for (key, val) in updates_map {
        let trimmed_key = key.trim();
        if trimmed_key.is_empty() {
            return Err("Model identifier must not be empty".to_string());
        }
        match val {
            Value::Null => {}
            Value::String(s) => {
                let lvl = s.trim().to_lowercase();
                if !VALID_THINKING_LEVELS.contains(&lvl.as_str()) {
                    return Err(format!(
                        "Invalid thinking level '{}' for model '{}'. Valid levels are: {}",
                        s,
                        key,
                        VALID_THINKING_LEVELS.join(", ")
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "Thinking level for model '{}' must be a string or null",
                    key
                ));
            }
        }
    }

    if let Some(parent) = config_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
        }
    }

    let mut root_obj = if config_path.exists() {
        let content = std::fs::read_to_string(config_path)
            .map_err(|e| format!("Failed to read settings.json: {}", e))?;
        if content.trim().is_empty() {
            serde_json::Map::new()
        } else {
            let parsed: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse settings.json: {}", e))?;
            parsed
                .as_object()
                .cloned()
                .ok_or_else(|| "settings.json root must be a JSON object".to_string())?
        }
    } else {
        serde_json::Map::new()
    };

    let mut levels_map = match root_obj.remove("modelThinkingLevels") {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };

    for (key, val) in updates_map {
        if val.is_null() {
            levels_map.remove(key);
        } else if let Some(s) = val.as_str() {
            levels_map.insert(key.clone(), Value::String(s.trim().to_lowercase()));
        }
    }

    let levels_value = Value::Object(levels_map.clone());
    root_obj.insert("modelThinkingLevels".to_string(), levels_value);

    let final_json = Value::Object(root_obj);
    let serialized = serde_json::to_string_pretty(&final_json)
        .map_err(|e| format!("Failed to serialize settings.json: {}", e))?;

    let temp_file_path = config_path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&temp_file_path, serialized)
        .map_err(|e| format!("Failed to write temporary config file {:?}: {}", temp_file_path, e))?;

    if let Err(e) = std::fs::rename(&temp_file_path, config_path) {
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!("Failed to commit config file to {:?}: {}", config_path, e));
    }

    Ok(Value::Object(levels_map))
}

#[tauri::command]
pub async fn get_model_thinking_levels() -> Result<Value, String> {
    let path = resolve_settings_config_path()
        .ok_or_else(|| "Could not determine user profile directory".to_string())?;
    get_model_thinking_levels_impl(&path)
}

#[tauri::command]
pub async fn save_model_thinking_levels(levels: Value) -> Result<Value, String> {
    let path = resolve_settings_config_path()
        .ok_or_else(|| "Could not determine user profile directory".to_string())?;
    save_model_thinking_levels_impl(&path, &levels)
}

/// Resolves canonical path to `mcp.json` under `$USERPROFILE` / `$HOME` / `.pi/agent/mcp.json`.
pub fn resolve_global_mcp_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;

    Some(home.join(".pi").join("agent").join("mcp.json"))
}

/// Resolves project-level MCP config path checking in order:
/// 1. `cwd.join(".pi").join("mcp.json")` if exists
/// 2. `cwd.join(".mcp.json")` if exists
/// 3. `cwd.join(".agents").join("mcp.json")` if exists
/// Defaults to `cwd.join(".pi").join("mcp.json")` if `cwd.join(".pi").is_dir()`, else `cwd.join(".mcp.json")`.
pub fn resolve_project_mcp_config_path(cwd: &Path) -> Option<PathBuf> {
    let pi_mcp = cwd.join(".pi").join("mcp.json");
    if pi_mcp.exists() {
        return Some(pi_mcp);
    }

    let root_mcp = cwd.join(".mcp.json");
    if root_mcp.exists() {
        return Some(root_mcp);
    }

    let agents_mcp = cwd.join(".agents").join("mcp.json");
    if agents_mcp.exists() {
        return Some(agents_mcp);
    }

    if cwd.join(".pi").is_dir() {
        Some(pi_mcp)
    } else {
        Some(root_mcp)
    }
}

/// Parses MCP server definitions from a configuration file.
fn parse_mcp_servers_from_file(path: &Path, scope: &str) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read MCP config at {:?}: {}", path, e))?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse MCP config at {:?}: {}", path, e))?;

    let root_obj = parsed
        .as_object()
        .ok_or_else(|| format!("MCP config root at {:?} must be a JSON object", path))?;

    let mut raw_servers: Vec<(String, Value)> = Vec::new();
    if let Some(obj) = root_obj.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, def) in obj {
            raw_servers.push((name.clone(), def.clone()));
        }
    }
    if let Some(obj) = root_obj.get("mcp-servers").and_then(|v| v.as_object()) {
        for (name, def) in obj {
            if !raw_servers.iter().any(|(n, _)| n == name) {
                raw_servers.push((name.clone(), def.clone()));
            }
        }
    }

    let config_path_str = path.to_string_lossy().to_string();
    let mut servers = Vec::new();

    for (name, def) in raw_servers {
        let def_obj = match def.as_object() {
            Some(o) => o,
            None => continue,
        };

        let command = def_obj
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let args: Option<Vec<String>> = def_obj.get("args").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect()
            })
        });

        let url = def_obj
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let explicit_type = def_obj
            .get("type")
            .or_else(|| def_obj.get("serverType"))
            .or_else(|| def_obj.get("transport"))
            .and_then(|v| v.as_str());

        let server_type = if let Some(t) = explicit_type {
            t.to_string()
        } else if command.is_some() {
            "stdio".to_string()
        } else if url.is_some() {
            "sse".to_string()
        } else {
            "stdio".to_string()
        };

        let mut env_keys: Vec<String> = match def_obj.get("env").and_then(|v| v.as_object()) {
            Some(env_map) => env_map.keys().cloned().collect(),
            None => Vec::new(),
        };
        env_keys.sort();

        let env_obj: Option<serde_json::Map<String, Value>> = def_obj
            .get("env")
            .and_then(|v| v.as_object())
            .cloned();

        let headers_obj: Option<serde_json::Map<String, Value>> = def_obj
            .get("headers")
            .and_then(|v| v.as_object())
            .cloned();

        let is_disabled = def_obj.get("disabled") == Some(&Value::Bool(true))
            || def_obj.get("enabled") == Some(&Value::Bool(false));
        let is_enabled = !is_disabled;

        servers.push(serde_json::json!({
            "name": name,
            "command": command,
            "args": args,
            "url": url,
            "serverType": server_type,
            "envKeys": env_keys,
            "env": env_obj,
            "headers": headers_obj,
            "disabled": is_disabled,
            "enabled": is_enabled,
            "scope": scope,
            "configPath": config_path_str,
        }));
    }

    Ok(servers)
}

/// Reads global and project MCP configs if they exist, merges them with project precedence.
pub fn get_mcp_servers_impl(
    global_path: Option<&Path>,
    project_path: Option<&Path>,
) -> Result<Value, String> {
    let global_servers = match global_path {
        Some(p) => parse_mcp_servers_from_file(p, "global")?,
        None => Vec::new(),
    };

    let project_servers = match project_path {
        Some(p) => parse_mcp_servers_from_file(p, "project")?,
        None => Vec::new(),
    };

    let mut merged: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for g in global_servers {
        let name = g.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(p) = project_servers.iter().find(|p| p.get("name").and_then(|v| v.as_str()) == Some(&name)) {
            let p_has_command = p
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

            let p_has_url = p
                .get("url")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

            let p_has_env = p
                .get("env")
                .and_then(|v| v.as_object())
                .map(|m| !m.is_empty())
                .unwrap_or(false);

            let mut merged_server = g.clone();

            if p_has_command {
                merged_server["command"] = p.get("command").cloned().unwrap_or(Value::Null);
                merged_server["args"] = p.get("args").cloned().unwrap_or(Value::Null);
                if !p_has_url {
                    merged_server["url"] = Value::Null;
                    merged_server["headers"] = Value::Null;
                }
            }

            if p_has_url {
                merged_server["url"] = p.get("url").cloned().unwrap_or(Value::Null);
                merged_server["headers"] = p.get("headers").cloned().unwrap_or(Value::Null);
                if !p_has_command {
                    merged_server["command"] = Value::Null;
                    merged_server["args"] = Value::Null;
                }
            }

            if p_has_env {
                merged_server["env"] = p.get("env").cloned().unwrap_or(Value::Null);
                merged_server["envKeys"] = p.get("envKeys").cloned().unwrap_or(Value::Array(Vec::new()));
            }

            if p_has_command || p_has_url {
                merged_server["serverType"] = p.get("serverType").cloned().unwrap_or(Value::String("stdio".to_string()));
                merged_server["scope"] = Value::String("project".to_string());
                if let Some(cp) = p.get("configPath") {
                    merged_server["configPath"] = cp.clone();
                }
            } else {
                merged_server["scope"] = Value::String("global".to_string());
                merged_server["hasProjectOverride"] = Value::Bool(true);
                if let Some(cp) = g.get("configPath") {
                    merged_server["configPath"] = cp.clone();
                }
            }

            merged_server["disabled"] = p.get("disabled").cloned().unwrap_or(Value::Bool(false));
            merged_server["enabled"] = p.get("enabled").cloned().unwrap_or(Value::Bool(true));

            merged.push(merged_server);
        } else {
            merged.push(g);
        }
        seen.insert(name);
    }

    for p in project_servers {
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !seen.contains(&name) {
            merged.push(p);
        }
    }

    Ok(serde_json::json!({ "servers": merged }))
}

/// Toggles an MCP server's enabled/disabled status in the specified config file atomically.
pub fn toggle_mcp_server_impl(
    target_path: &Path,
    server_name: &str,
    enabled: bool,
) -> Result<Value, String> {
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
        }
    }

    let mut root_obj = if target_path.exists() {
        let content = std::fs::read_to_string(target_path)
            .map_err(|e| format!("Failed to read config file {:?}: {}", target_path, e))?;
        if content.trim().is_empty() {
            serde_json::Map::new()
        } else {
            let parsed: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config file {:?}: {}", target_path, e))?;
            parsed
                .as_object()
                .cloned()
                .ok_or_else(|| format!("Config file root at {:?} must be a JSON object", target_path))?
        }
    } else {
        serde_json::Map::new()
    };

    let servers_key = if root_obj.contains_key("mcpServers") {
        "mcpServers"
    } else if root_obj.contains_key("mcp-servers") {
        "mcp-servers"
    } else {
        "mcpServers"
    };

    let mut servers_map = match root_obj.remove(servers_key) {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };

    if let Some(server_val) = servers_map.get_mut(server_name) {
        let server_obj = server_val.as_object_mut().ok_or_else(|| {
            format!("Server '{}' definition is not a JSON object", server_name)
        })?;

        if enabled {
            server_obj.insert("disabled".to_string(), Value::Bool(false));
            if server_obj.contains_key("enabled") {
                server_obj.insert("enabled".to_string(), Value::Bool(true));
            }
        } else {
            server_obj.insert("disabled".to_string(), Value::Bool(true));
            if server_obj.contains_key("enabled") {
                server_obj.insert("enabled".to_string(), Value::Bool(false));
            }
        }
    } else {
        let mut new_entry = serde_json::Map::new();
        new_entry.insert("disabled".to_string(), Value::Bool(!enabled));
        new_entry.insert("enabled".to_string(), Value::Bool(enabled));
        servers_map.insert(server_name.to_string(), Value::Object(new_entry));
    }

    root_obj.insert(servers_key.to_string(), Value::Object(servers_map));

    let final_json = Value::Object(root_obj);
    let serialized = serde_json::to_string_pretty(&final_json)
        .map_err(|e| format!("Failed to serialize config file: {}", e))?;

    let temp_file_path = target_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&temp_file_path, serialized)
        .map_err(|e| format!("Failed to write temporary config file {:?}: {}", temp_file_path, e))?;

    if let Err(e) = std::fs::rename(&temp_file_path, target_path) {
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!("Failed to commit config file to {:?}: {}", target_path, e));
    }

    Ok(serde_json::json!({
        "success": true,
        "name": server_name,
        "enabled": enabled,
        "path": target_path.to_string_lossy().to_string(),
    }))
}

/// Checks if a server name exists in the configuration file at `path`.
fn server_exists_in_file(path: &Path, server_name: &str) -> bool {
    if !path.exists() {
        return false;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let parsed: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let root = match parsed.as_object() {
        Some(r) => r,
        None => return false,
    };
    let has_in = |key: &str| {
        root.get(key)
            .and_then(|v| v.as_object())
            .map(|obj| obj.contains_key(server_name))
            .unwrap_or(false)
    };
    has_in("mcpServers") || has_in("mcp-servers")
}

/// Tauri command to get MCP servers from global and/or project configs.
#[tauri::command]
pub async fn get_mcp_servers(cwd: Option<String>) -> Result<Value, String> {
    let global_path = resolve_global_mcp_config_path();
    let project_path = cwd.as_deref().and_then(|c| {
        let trimmed = c.trim();
        if trimmed.is_empty() {
            None
        } else {
            resolve_project_mcp_config_path(Path::new(trimmed))
        }
    });

    get_mcp_servers_impl(global_path.as_deref(), project_path.as_deref())
}

/// Tauri command to toggle an MCP server on or off.
#[tauri::command]
pub async fn toggle_mcp_server(
    name: String,
    enabled: bool,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<Value, String> {
    let server_name = name.trim();
    if server_name.is_empty() {
        return Err("Server name must not be empty".to_string());
    }

    let global_path = resolve_global_mcp_config_path();
    let project_path = cwd.as_deref().and_then(|c| {
        let trimmed = c.trim();
        if trimmed.is_empty() {
            None
        } else {
            resolve_project_mcp_config_path(Path::new(trimmed))
        }
    });

    let target_path = match scope.as_deref().map(|s| s.trim().to_lowercase()).as_deref() {
        Some("project") => project_path
            .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?,
        Some("global") => global_path
            .ok_or_else(|| "Could not resolve global MCP config path".to_string())?,
        _ => {
            if let Some(ref p) = project_path {
                if server_exists_in_file(p, server_name) {
                    p.clone()
                } else if let Some(ref g) = global_path {
                    if server_exists_in_file(g, server_name) {
                        g.clone()
                    } else {
                        g.clone()
                    }
                } else {
                    p.clone()
                }
            } else if let Some(ref g) = global_path {
                g.clone()
            } else {
                return Err("Could not resolve any MCP config path".to_string());
            }
        }
    };

    toggle_mcp_server_impl(&target_path, server_name, enabled)
}

/// Saves an MCP server definition into the specified config file atomically.
///
/// If `old_name` is provided and differs from `server_name`, `old_name` is removed (rename support).
/// Preserves existing fields (like `disabled`) unless explicitly overridden in `server_def`.
pub fn save_mcp_server_impl(
    target_path: &Path,
    server_name: &str,
    old_name: Option<&str>,
    server_def: Value,
) -> Result<Value, String> {
    let server_name = server_name.trim();
    if server_name.is_empty() {
        return Err("Server name must not be empty".to_string());
    }

    let mut def_obj = server_def
        .as_object()
        .cloned()
        .ok_or_else(|| "Server definition must be a JSON object".to_string())?;

    // Strip client-side UI metadata fields if present
    def_obj.remove("name");
    def_obj.remove("scope");
    def_obj.remove("configPath");
    def_obj.remove("envKeys");

    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
        }
    }

    let mut root_obj = if target_path.exists() {
        let content = std::fs::read_to_string(target_path)
            .map_err(|e| format!("Failed to read config file {:?}: {}", target_path, e))?;
        if content.trim().is_empty() {
            serde_json::Map::new()
        } else {
            let parsed: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config file {:?}: {}", target_path, e))?;
            parsed
                .as_object()
                .cloned()
                .ok_or_else(|| format!("Config file root at {:?} must be a JSON object", target_path))?
        }
    } else {
        serde_json::Map::new()
    };

    let servers_key = if root_obj.contains_key("mcpServers") {
        "mcpServers"
    } else if root_obj.contains_key("mcp-servers") {
        "mcp-servers"
    } else {
        "mcpServers"
    };

    let mut servers_map = match root_obj.remove(servers_key) {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };

    // If renaming: remove old_name from map and capture its definition for preserving fields.
    let mut existing_obj = None;

    if let Some(old) = old_name {
        let old_trimmed = old.trim();
        if !old_trimmed.is_empty() && old_trimmed != server_name {
            if let Some(Value::Object(map)) = servers_map.remove(old_trimmed) {
                existing_obj = Some(map);
            }
            // Also check other key if present
            let other_key = if servers_key == "mcpServers" { "mcp-servers" } else { "mcpServers" };
            if let Some(Value::Object(ref mut other_map)) = root_obj.get_mut(other_key) {
                if let Some(Value::Object(map)) = other_map.remove(old_trimmed) {
                    if existing_obj.is_none() {
                        existing_obj = Some(map);
                    }
                }
            }
        }
    }

    // If existing under server_name
    if let Some(Value::Object(map)) = servers_map.remove(server_name) {
        if existing_obj.is_none() {
            existing_obj = Some(map);
        }
    }

    // Merge def_obj into existing_obj:
    // Preserves existing fields (like `disabled`) unless explicitly overridden in `server_def`.
    let final_def = if let Some(mut existing) = existing_obj {
        // If switching from stdio to remote/url or vice versa, clear outdated transport keys
        if def_obj.contains_key("url") && !def_obj.contains_key("command") {
            existing.remove("command");
            existing.remove("args");
        } else if def_obj.contains_key("command") && !def_obj.contains_key("url") {
            existing.remove("url");
            existing.remove("headers");
        }

        for (k, v) in def_obj {
            if v.is_null() {
                existing.remove(&k);
            } else {
                existing.insert(k, v);
            }
        }
        existing
    } else {
        def_obj.retain(|_, v| !v.is_null());
        def_obj
    };

    servers_map.insert(server_name.to_string(), Value::Object(final_def));
    root_obj.insert(servers_key.to_string(), Value::Object(servers_map));

    let final_json = Value::Object(root_obj);
    let serialized = serde_json::to_string_pretty(&final_json)
        .map_err(|e| format!("Failed to serialize config file: {}", e))?;

    let temp_file_path = target_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&temp_file_path, serialized)
        .map_err(|e| format!("Failed to write temporary config file {:?}: {}", temp_file_path, e))?;

    if let Err(e) = std::fs::rename(&temp_file_path, target_path) {
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!("Failed to commit config file to {:?}: {}", target_path, e));
    }

    Ok(serde_json::json!({
        "success": true,
        "name": server_name,
        "path": target_path.to_string_lossy().to_string(),
    }))
}

/// Deletes an MCP server from the specified configuration file atomically.
pub fn delete_mcp_server_impl(
    target_path: &Path,
    server_name: &str,
) -> Result<Value, String> {
    let server_name = server_name.trim();
    if server_name.is_empty() {
        return Err("Server name must not be empty".to_string());
    }

    if !target_path.exists() {
        return Ok(serde_json::json!({
            "success": true,
            "name": server_name,
            "path": target_path.to_string_lossy().to_string(),
        }));
    }

    let content = std::fs::read_to_string(target_path)
        .map_err(|e| format!("Failed to read config file {:?}: {}", target_path, e))?;

    if content.trim().is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "name": server_name,
            "path": target_path.to_string_lossy().to_string(),
        }));
    }

    let parsed: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config file {:?}: {}", target_path, e))?;

    let mut root_obj = parsed
        .as_object()
        .cloned()
        .ok_or_else(|| format!("Config file root at {:?} must be a JSON object", target_path))?;

    for key in &["mcpServers", "mcp-servers"] {
        if let Some(Value::Object(ref mut map)) = root_obj.get_mut(*key) {
            map.remove(server_name);
        }
    }

    let final_json = Value::Object(root_obj);
    let serialized = serde_json::to_string_pretty(&final_json)
        .map_err(|e| format!("Failed to serialize config file: {}", e))?;

    let temp_file_path = target_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&temp_file_path, serialized)
        .map_err(|e| format!("Failed to write temporary config file {:?}: {}", temp_file_path, e))?;

    if let Err(e) = std::fs::rename(&temp_file_path, target_path) {
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!("Failed to commit config file to {:?}: {}", target_path, e));
    }

    Ok(serde_json::json!({
        "success": true,
        "name": server_name,
        "path": target_path.to_string_lossy().to_string(),
    }))
}

/// Tauri command to save or update an MCP server definition.
#[tauri::command]
pub async fn save_mcp_server(
    name: String,
    old_name: Option<String>,
    server: Value,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<Value, String> {
    let server_name = name.trim();
    if server_name.is_empty() {
        return Err("Server name must not be empty".to_string());
    }

    let global_path = resolve_global_mcp_config_path();
    let project_path = cwd.as_deref().and_then(|c| {
        let trimmed = c.trim();
        if trimmed.is_empty() {
            None
        } else {
            let cwd_path = Path::new(trimmed);
            resolve_project_mcp_config_path(cwd_path)
                .or_else(|| Some(cwd_path.join(".pi").join("mcp.json")))
        }
    });

    let target_path = match scope.as_deref().map(|s| s.trim().to_lowercase()).as_deref() {
        Some("project") => project_path
            .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?,
        Some("global") => global_path
            .ok_or_else(|| "Could not resolve global MCP config path".to_string())?,
        _ => {
            let check_name = old_name.as_deref().unwrap_or(server_name);
            if let Some(ref p) = project_path {
                if server_exists_in_file(p, check_name) {
                    p.clone()
                } else if let Some(ref g) = global_path {
                    g.clone()
                } else {
                    p.clone()
                }
            } else if let Some(ref g) = global_path {
                g.clone()
            } else {
                return Err("Could not resolve any MCP config path".to_string());
            }
        }
    };

    save_mcp_server_impl(&target_path, server_name, old_name.as_deref(), server)
}

/// Tauri command to delete an MCP server.
#[tauri::command]
pub async fn delete_mcp_server(
    name: String,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<Value, String> {
    let server_name = name.trim();
    if server_name.is_empty() {
        return Err("Server name must not be empty".to_string());
    }

    let global_path = resolve_global_mcp_config_path();
    let project_path = cwd.as_deref().and_then(|c| {
        let trimmed = c.trim();
        if trimmed.is_empty() {
            None
        } else {
            let cwd_path = Path::new(trimmed);
            resolve_project_mcp_config_path(cwd_path)
                .or_else(|| Some(cwd_path.join(".pi").join("mcp.json")))
        }
    });

    let target_path = match scope.as_deref().map(|s| s.trim().to_lowercase()).as_deref() {
        Some("project") => project_path
            .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?,
        Some("global") => global_path
            .ok_or_else(|| "Could not resolve global MCP config path".to_string())?,
        _ => {
            if let Some(ref p) = project_path {
                if server_exists_in_file(p, server_name) {
                    p.clone()
                } else if let Some(ref g) = global_path {
                    if server_exists_in_file(g, server_name) {
                        g.clone()
                    } else {
                        g.clone()
                    }
                } else {
                    p.clone()
                }
            } else if let Some(ref g) = global_path {
                g.clone()
            } else {
                return Err("Could not resolve any MCP config path".to_string());
            }
        }
    };

    delete_mcp_server_impl(&target_path, server_name)
}

/// Resolves project-level settings.json config path strictly as `<cwd>/.pi/settings.json`.
pub fn resolve_project_settings_config_path(cwd: &Path) -> PathBuf {
    cwd.join(".pi").join("settings.json")
}

/// Writes JSON atomically using a temporary file and platform-safe rename/replace semantics.
pub fn atomic_write_json(target_path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
        }
    }

    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    let temp_file_path = target_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    std::fs::write(&temp_file_path, serialized)
        .map_err(|e| format!("Failed to write temporary config file {:?}: {}", temp_file_path, e))?;

    if let Err(e) = std::fs::rename(&temp_file_path, target_path) {
        #[cfg(windows)]
        {
            if target_path.exists() {
                let backup_path = target_path.with_extension(format!(
                    "bak.{}.{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                if std::fs::rename(target_path, &backup_path).is_ok() {
                    if std::fs::rename(&temp_file_path, target_path).is_ok() {
                        let _ = std::fs::remove_file(&backup_path);
                        return Ok(());
                    } else {
                        let _ = std::fs::rename(&backup_path, target_path);
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!("Failed to commit config file to {:?}: {}", target_path, e));
    }

    Ok(())
}

/// Validates extension source syntax minimally: accepts relative, absolute paths, or globs.
pub fn validate_extension_source(source: &str) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Extension source must not be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("Extension source contains invalid characters".to_string());
    }
    let base = if trimmed.starts_with('!') || trimmed.starts_with('+') {
        trimmed[1..].trim()
    } else {
        trimmed
    };
    if base.is_empty() {
        return Err("Extension source must not be empty".to_string());
    }
    Ok(trimmed.to_string())
}

/// Validates package source syntax minimally: accepts npm, git, https/ssh, or local paths.
pub fn validate_package_source(source: &str) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Package source must not be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("Package source contains invalid characters".to_string());
    }

    let is_npm = trimmed.starts_with("npm:");
    let is_git = trimmed.starts_with("git:")
        || trimmed.starts_with("git@")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("ssh://");
    let is_local = trimmed.starts_with("./")
        || trimmed.starts_with(".\\")
        || trimmed.starts_with("../")
        || trimmed.starts_with("..\\")
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.starts_with("~/")
        || (trimmed.len() >= 3
            && trimmed.chars().next().map_or(false, |c| c.is_ascii_alphabetic())
            && (&trimmed[1..3] == ":\\" || &trimmed[1..3] == ":/"));
    let is_npm_shorthand = trimmed.chars().all(|c| {
        c.is_alphanumeric() || c == '@' || c == '/' || c == '-' || c == '_' || c == '.' || c == '^' || c == '~'
    });

    if !is_npm && !is_git && !is_local && !is_npm_shorthand {
        return Err(format!(
            "Invalid package source '{}'. Expected npm, git, https/ssh, or local path.",
            trimmed
        ));
    }

    Ok(trimmed.to_string())
}

/// Normalizes and validates a target source string for toggle, delete, or existence lookup.
/// Strips leading '!' or '+' markers for extensions and trims whitespace.
/// Returns an error if the source is empty, whitespace-only, or a bare marker without a target path.
pub fn normalize_target_source(kind: &str, source: &str) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Resource source must not be empty".to_string());
    }
    let clean = if kind == "extension" {
        if trimmed.starts_with('!') || trimmed.starts_with('+') {
            trimmed[1..].trim()
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    if clean.is_empty() {
        return Err(format!(
            "Invalid {} source '{}': bare marker without target path",
            if kind == "extension" { "extension" } else { "package" },
            source
        ));
    }
    if clean.contains('\0') {
        return Err("Source contains invalid characters".to_string());
    }
    Ok(clean.to_string())
}

/// Safely extracts the canonical source from an array item in settings.json.
/// Returns `None` for keyless/malformed objects, empty strings, bare markers, or non-string/object items.
pub fn extract_entry_source<'a>(kind: &str, item: &'a Value) -> Option<&'a str> {
    match item {
        Value::String(s) => {
            let s_trimmed = s.trim();
            if s_trimmed.is_empty() {
                return None;
            }
            if kind == "extension" {
                let clean = if s_trimmed.starts_with('!') || s_trimmed.starts_with('+') {
                    s_trimmed[1..].trim()
                } else {
                    s_trimmed
                };
                if clean.is_empty() {
                    None
                } else {
                    Some(clean)
                }
            } else {
                Some(s_trimmed)
            }
        }
        Value::Object(obj) => {
            let s = obj.get("source")
                .or_else(|| if kind == "extension" { obj.get("path") } else { None })
                .and_then(|v| v.as_str())
                .map(|s| s.trim())?;
            if s.is_empty() {
                return None;
            }
            if kind == "extension" {
                let clean = if s.starts_with('!') || s.starts_with('+') {
                    s[1..].trim()
                } else {
                    s
                };
                if clean.is_empty() {
                    None
                } else {
                    Some(clean)
                }
            } else {
                Some(s)
            }
        }
        _ => None,
    }
}

/// Derives a clean human-readable name for a Pi resource.
pub fn derive_resource_name(kind: &str, source: &str) -> String {
    let trimmed = source.trim();
    if kind == "package" {
        let s = trimmed.strip_prefix("npm:").unwrap_or(trimmed);
        if let Some(git_s) = s.strip_prefix("git:") {
            let clean_git = git_s.split('@').next().unwrap_or(git_s);
            let segs: Vec<&str> = clean_git.split('/').collect();
            return segs.last().unwrap_or(&clean_git).to_string();
        }
        if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("ssh://") {
            let no_proto = s.split("://").nth(1).unwrap_or(s);
            let no_ref = no_proto.split('@').next().unwrap_or(no_proto);
            let last_seg = no_ref.trim_end_matches(".git").split('/').last().unwrap_or(no_ref);
            if !last_seg.is_empty() {
                return last_seg.to_string();
            }
        }
        if let Some(at_idx) = s.rfind('@') {
            if at_idx > 0 {
                return s[..at_idx].to_string();
            }
        }
        s.to_string()
    } else {
        let norm = trimmed.replace('\\', "/");
        let clean = if norm.starts_with('!') || norm.starts_with('+') || norm.starts_with('-') {
            norm[1..].trim()
        } else {
            &norm
        };
        let segs: Vec<&str> = clean.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
        if segs.len() >= 2 {
            let last = segs.last().copied().unwrap_or("");
            if last == "index.ts" || last == "index.js" {
                let parent = segs[segs.len() - 2];
                if parent != "extensions" && parent != "." {
                    return parent.to_string();
                }
            }
        }
        segs.last().unwrap_or(&clean).to_string()
    }
}

/// Computes a stable unique identifier for a Pi resource entry across scopes and kinds.
pub fn normalize_resource_id(scope: &str, kind: &str, clean_source: &str) -> String {
    format!(
        "{}:{}:{}",
        scope.trim().to_lowercase(),
        kind.trim().to_lowercase(),
        clean_source.trim()
    )
}

/// Extracts the canonical identity of a package according to Pi 0.86.1 specification:
/// - npm: package name without version/tag (e.g. "npm:@scope/pkg@1.2.3" -> "@scope/pkg", "npm:pkg" -> "pkg")
/// - git: repository URL without ref or trailing .git (e.g. "git:github.com/user/repo@v1" -> "github.com/user/repo")
/// - local / other: normalized path string with forward slashes
pub fn extract_package_identity(source: &str) -> String {
    let trimmed = source.trim();
    let s = trimmed.strip_prefix("npm:").unwrap_or(trimmed);

    if let Some(git_s) = s.strip_prefix("git:") {
        let clean_git = git_s.split('@').next().unwrap_or(git_s);
        return clean_git.trim_end_matches(".git").to_string();
    }
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("ssh://") {
        let no_proto = s.split("://").nth(1).unwrap_or(s);
        let no_ref = no_proto.split('@').next().unwrap_or(no_proto);
        return no_ref.trim_end_matches(".git").to_string();
    }

    if s.starts_with('@') {
        if let Some(second_at) = s[1..].find('@') {
            return s[..1 + second_at].to_string();
        }
        return s.to_string();
    } else if let Some(at_idx) = s.find('@') {
        return s[..at_idx].to_string();
    }

    s.replace('\\', "/")
}

/// Determines whether two package source strings represent the exact same package identity.
pub fn package_identities_match(source_a: &str, source_b: &str) -> bool {
    let a = source_a.trim();
    let b = source_b.trim();
    if a == b {
        return true;
    }
    let id_a = extract_package_identity(a);
    let id_b = extract_package_identity(b);
    !id_a.is_empty() && id_a == id_b
}

fn normalize_ext_for_matching(source: &str) -> String {
    let mut s = source.trim();
    while s.starts_with('!') || s.starts_with('+') || s.starts_with('-') {
        s = s[1..].trim();
    }
    let norm = s.replace('\\', "/");
    let mut cleaned = norm.as_str();
    if let Some(stripped) = cleaned.strip_prefix("./") {
        cleaned = stripped;
    }
    if let Some(stripped) = cleaned.strip_prefix("extensions/") {
        cleaned = stripped;
    }
    cleaned.trim_end_matches('/').to_string()
}

/// Determines whether two extension source strings represent the same target extension file/path.
pub fn extension_sources_match(source_a: &str, source_b: &str) -> bool {
    let a = normalize_ext_for_matching(source_a);
    let b = normalize_ext_for_matching(source_b);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    if a == format!("{}/index.ts", b) || a == format!("{}/index.js", b) {
        return true;
    }
    if b == format!("{}/index.ts", a) || b == format!("{}/index.js", a) {
        return true;
    }
    false
}

/// Determines whether two resource source strings refer to the same resource for a given kind.
pub fn resource_identities_match(kind: &str, source_a: &str, source_b: &str) -> bool {
    if kind.eq_ignore_ascii_case("package") {
        package_identities_match(source_a, source_b)
    } else {
        extension_sources_match(source_a, source_b)
    }
}

/// Parses canonical string and object extension and package entries from a settings file.
pub fn parse_pi_resources_from_file(path: &Path, scope: &str) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read settings file {:?}: {}", path, e))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings file {:?}: {}", path, e))?;
    let root_obj = match root.as_object() {
        Some(o) => o,
        None => return Ok(Vec::new()),
    };

    let mut resources = Vec::new();
    let config_path_str = path.to_string_lossy().to_string();

    // 1. Extensions
    if let Some(exts) = root_obj.get("extensions").and_then(|v| v.as_array()) {
        for item in exts {
            match item {
                Value::String(s) => {
                    let s_trimmed = s.trim();
                    if s_trimmed.is_empty() {
                        continue;
                    }
                    let (enabled, clean_source) = if s_trimmed.starts_with('!') {
                        (false, s_trimmed[1..].trim().to_string())
                    } else if s_trimmed.starts_with('+') {
                        (true, s_trimmed[1..].trim().to_string())
                    } else {
                        (true, s_trimmed.to_string())
                    };
                    if clean_source.is_empty() {
                        continue;
                    }
                    let name = derive_resource_name("extension", &clean_source);
                    let id = normalize_resource_id(scope, "extension", &clean_source);
                    resources.push(serde_json::json!({
                        "id": id,
                        "name": name,
                        "kind": "extension",
                        "source": clean_source,
                        "scope": scope,
                        "enabled": enabled,
                        "configPath": config_path_str,
                        "raw": item.clone(),
                    }));
                }
                Value::Object(obj) => {
                    let source_opt = obj.get("source")
                        .or_else(|| obj.get("path"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim());
                    if let Some(src) = source_opt {
                        let clean_source = if src.starts_with('!') || src.starts_with('+') {
                            src[1..].trim().to_string()
                        } else {
                            src.to_string()
                        };
                        if clean_source.is_empty() {
                            continue;
                        }
                        let is_disabled = obj.get("disabled") == Some(&Value::Bool(true))
                            || obj.get("enabled") == Some(&Value::Bool(false))
                            || obj.get("autoload") == Some(&Value::Bool(false));
                        let enabled = !is_disabled;
                        let name = derive_resource_name("extension", &clean_source);
                        let id = normalize_resource_id(scope, "extension", &clean_source);
                        resources.push(serde_json::json!({
                            "id": id,
                            "name": name,
                            "kind": "extension",
                            "source": clean_source,
                            "scope": scope,
                            "enabled": enabled,
                            "configPath": config_path_str,
                            "raw": item.clone(),
                        }));
                    }
                }
                _ => {}
            }
        }
    }

    // 2. Packages
    if let Some(pkgs) = root_obj.get("packages").and_then(|v| v.as_array()) {
        for item in pkgs {
            match item {
                Value::String(s) => {
                    let s_trimmed = s.trim();
                    if s_trimmed.is_empty() {
                        continue;
                    }
                    let name = derive_resource_name("package", s_trimmed);
                    let id = normalize_resource_id(scope, "package", s_trimmed);
                    resources.push(serde_json::json!({
                        "id": id,
                        "name": name,
                        "kind": "package",
                        "source": s_trimmed,
                        "scope": scope,
                        "enabled": true,
                        "autoload": true,
                        "configPath": config_path_str,
                        "raw": item.clone(),
                    }));
                }
                Value::Object(obj) => {
                    let source_opt = obj.get("source")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim());
                    if let Some(clean_source) = source_opt {
                        if clean_source.is_empty() {
                            continue;
                        }
                        let autoload = obj.get("autoload").and_then(|v| v.as_bool());
                        let is_disabled = autoload == Some(false)
                            || obj.get("disabled") == Some(&Value::Bool(true))
                            || obj.get("enabled") == Some(&Value::Bool(false));
                        let enabled = !is_disabled;
                        let name = derive_resource_name("package", clean_source);
                        let id = normalize_resource_id(scope, "package", clean_source);

                        let mut filters_map = serde_json::Map::new();
                        for key in &["extensions", "skills", "prompts", "themes"] {
                            if let Some(f_val) = obj.get(*key) {
                                filters_map.insert(key.to_string(), f_val.clone());
                            }
                        }

                        let mut entry = serde_json::json!({
                            "id": id,
                            "name": name,
                            "kind": "package",
                            "source": clean_source,
                            "scope": scope,
                            "enabled": enabled,
                            "configPath": config_path_str,
                            "raw": item.clone(),
                        });
                        if let Some(a) = autoload {
                            entry["autoload"] = Value::Bool(a);
                        }
                        if !filters_map.is_empty() {
                            entry["filters"] = Value::Object(filters_map);
                        }
                        resources.push(entry);
                    }
                }
                _ => {}
            }
        }
    }

    Ok(resources)
}

/// Resolves canonical path to global extensions directory under `$USERPROFILE` / `$HOME` / `.pi/agent/extensions`.
pub fn resolve_global_extensions_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;

    Some(home.join(".pi").join("agent").join("extensions"))
}

/// Resolves project-level extensions directory strictly as `<cwd>/.pi/extensions`.
pub fn resolve_project_extensions_dir(cwd: &Path) -> PathBuf {
    cwd.join(".pi").join("extensions")
}

/// Discovers auto-discovered extensions in a directory according to Pi 0.86.1 conventions.
pub fn discover_extensions_in_dir(extensions_dir: &Path, scope: &str) -> Vec<Value> {
    if !extensions_dir.is_dir() {
        return Vec::new();
    }

    let mut resources = Vec::new();

    let read_res = match std::fs::read_dir(extensions_dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut entries: Vec<std::fs::DirEntry> = read_res.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') || file_name == "node_modules" {
            continue;
        }

        let entry_path = entry.path();
        if entry_path.is_file() {
            let fname = file_name.as_str();
            if (fname.ends_with(".ts") || fname.ends_with(".js")) && !fname.ends_with(".d.ts") {
                let source = format!("extensions/{}", fname);
                let name = derive_resource_name("extension", &source);
                let id = normalize_resource_id(scope, "extension", &source);
                let config_path = entry_path.to_string_lossy().to_string();
                resources.push(serde_json::json!({
                    "id": id,
                    "name": name,
                    "kind": "extension",
                    "source": source,
                    "scope": scope,
                    "enabled": true,
                    "configPath": config_path,
                }));
            }
        } else if entry_path.is_dir() {
            let dir_name = file_name;
            let mut found_manifest_ext = false;
            let package_json_path = entry_path.join("package.json");

            if package_json_path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&package_json_path) {
                    if let Ok(manifest) = serde_json::from_str::<Value>(&content) {
                        if let Some(ext_arr) = manifest
                            .get("pi")
                            .and_then(|p| p.get("extensions"))
                            .and_then(|e| e.as_array())
                        {
                            let pkg_name = manifest
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&dir_name);

                            for ext_val in ext_arr {
                                if let Some(rel) = ext_val.as_str() {
                                    let rel_norm = rel
                                        .trim()
                                        .trim_start_matches("./")
                                        .trim_start_matches(".\\")
                                        .replace('\\', "/");
                                    if !rel_norm.is_empty() {
                                        found_manifest_ext = true;
                                        let source = format!("extensions/{}/{}", dir_name, rel_norm);
                                        let id = normalize_resource_id(scope, "extension", &source);
                                        let file_path = entry_path.join(&rel_norm);
                                        resources.push(serde_json::json!({
                                            "id": id,
                                            "name": pkg_name,
                                            "kind": "extension",
                                            "source": source,
                                            "scope": scope,
                                            "enabled": true,
                                            "configPath": file_path.to_string_lossy().to_string(),
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if !found_manifest_ext {
                let index_ts = entry_path.join("index.ts");
                let index_js = entry_path.join("index.js");
                let index_filename = if index_ts.is_file() {
                    Some("index.ts")
                } else if index_js.is_file() {
                    Some("index.js")
                } else {
                    None
                };

                if let Some(idx_name) = index_filename {
                    let source = format!("extensions/{}/{}", dir_name, idx_name);
                    let id = normalize_resource_id(scope, "extension", &source);
                    let file_path = entry_path.join(idx_name);
                    let name = dir_name;
                    resources.push(serde_json::json!({
                        "id": id,
                        "name": name,
                        "kind": "extension",
                        "source": source,
                        "scope": scope,
                        "enabled": true,
                        "configPath": file_path.to_string_lossy().to_string(),
                    }));
                }
            }
        }
    }

    resources
}

/// Merges auto-discovered extensions with explicit settings resources for a given scope.
/// Auto-discovered extensions adopt explicit enabled state and raw metadata without duplication.
pub fn merge_scope_resources(
    auto_extensions: Vec<Value>,
    explicit_resources: Vec<Value>,
) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    let mut matched_explicit_indices = std::collections::HashSet::new();

    for mut auto_ext in auto_extensions {
        let auto_source = auto_ext
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let matched = explicit_resources.iter().enumerate().find(|(idx, exp)| {
            if matched_explicit_indices.contains(idx) {
                return false;
            }
            let exp_kind = exp.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let exp_source = exp.get("source").and_then(|v| v.as_str()).unwrap_or("");
            exp_kind == "extension" && extension_sources_match(&auto_source, exp_source)
        });

        if let Some((idx, exp)) = matched {
            matched_explicit_indices.insert(idx);
            let exp_enabled = exp.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            auto_ext["enabled"] = Value::Bool(exp_enabled);
            if let Some(raw) = exp.get("raw") {
                auto_ext["raw"] = raw.clone();
            }
        }

        merged.push(auto_ext);
    }

    for (idx, exp) in explicit_resources.into_iter().enumerate() {
        if !matched_explicit_indices.contains(&idx) {
            merged.push(exp);
        }
    }

    merged
}

/// Helper to determine whether a given extension source represents an auto-discovered extension.
pub fn is_autodiscovered_extension(target_path: &Path, source: &str) -> bool {
    let norm = source.trim().replace('\\', "/");
    let clean = norm.strip_prefix("./").unwrap_or(&norm);
    if clean.starts_with("extensions/") {
        return true;
    }

    if let Some(parent) = target_path.parent() {
        let proj_ext = parent.join("extensions");
        if proj_ext.is_dir() {
            let found = discover_extensions_in_dir(&proj_ext, "project");
            if found.iter().any(|item| {
                item.get("source")
                    .and_then(|s| s.as_str())
                    .map_or(false, |s| extension_sources_match(s, source))
            }) {
                return true;
            }
        }
    }

    if let Some(global_dir) = resolve_global_extensions_dir() {
        if global_dir.is_dir() {
            let found = discover_extensions_in_dir(&global_dir, "global");
            if found.iter().any(|item| {
                item.get("source")
                    .and_then(|s| s.as_str())
                    .map_or(false, |s| extension_sources_match(s, source))
            }) {
                return true;
            }
        }
    }

    false
}

/// Reads global and/or project settings and returns all configured extension and package resources.
/// Merges global entries with project overrides (MCP pattern) so no duplicate cards are created.
pub fn get_pi_resources_impl(
    global_path: Option<&Path>,
    project_path: Option<&Path>,
) -> Result<Value, String> {
    let auto_global_extensions = if let Some(gp) = global_path {
        if let Some(parent) = gp.parent() {
            discover_extensions_in_dir(&parent.join("extensions"), "global")
        } else {
            Vec::new()
        }
    } else if let Some(global_dir) = resolve_global_extensions_dir() {
        discover_extensions_in_dir(&global_dir, "global")
    } else {
        Vec::new()
    };

    let auto_project_extensions = if let Some(pp) = project_path {
        if let Some(parent) = pp.parent() {
            discover_extensions_in_dir(&parent.join("extensions"), "project")
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let explicit_global = match global_path {
        Some(p) => parse_pi_resources_from_file(p, "global")?,
        None => Vec::new(),
    };

    let explicit_project = match project_path {
        Some(p) => parse_pi_resources_from_file(p, "project")?,
        None => Vec::new(),
    };

    let global_resources = merge_scope_resources(auto_global_extensions, explicit_global);
    let project_resources = merge_scope_resources(auto_project_extensions, explicit_project);

    let mut merged: Vec<Value> = Vec::new();
    let mut matched_project_indices: std::collections::HashSet<usize> = std::collections::HashSet::new();

    for mut g in global_resources {
        let kind = g.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let g_source = g.get("source").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let g_enabled = g.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

        g["globalEnabled"] = Value::Bool(g_enabled);
        g["sourceScope"] = Value::String("global".to_string());

        // Find matching project resource if present
        let match_pos = project_resources.iter().enumerate().find(|(idx, p)| {
            if matched_project_indices.contains(idx) {
                return false;
            }
            let p_kind = p.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let p_source = p.get("source").and_then(|v| v.as_str()).unwrap_or("");
            p_kind == kind && resource_identities_match(&kind, &g_source, p_source)
        });

        if let Some((p_idx, p)) = match_pos {
            matched_project_indices.insert(p_idx);
            let p_enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

            g["hasProjectOverride"] = Value::Bool(true);
            g["enabled"] = Value::Bool(p_enabled);

            let g_config_path = g.get("configPath").and_then(|v| v.as_str()).unwrap_or("");
            let g_is_file = g_config_path.ends_with(".ts") || g_config_path.ends_with(".js");
            if !g_is_file {
                if let Some(cp) = p.get("configPath") {
                    g["configPath"] = cp.clone();
                }
            }
            if let Some(al) = p.get("autoload") {
                g["autoload"] = al.clone();
            }
            if let Some(filters) = p.get("filters") {
                g["filters"] = filters.clone();
            }
            merged.push(g);
        } else {
            g["hasProjectOverride"] = Value::Bool(false);
            merged.push(g);
        }
    }

    for (p_idx, mut p) in project_resources.into_iter().enumerate() {
        if !matched_project_indices.contains(&p_idx) {
            p["hasProjectOverride"] = Value::Bool(false);
            p["sourceScope"] = Value::String("project".to_string());
            merged.push(p);
        }
    }

    Ok(serde_json::json!({
        "resources": merged
    }))
}

/// Checks if a resource with the given kind and source exists in the specified settings file.
fn resource_exists_in_file(path: &Path, kind: &str, source: &str) -> bool {
    let clean_target = match normalize_target_source(kind, source) {
        Ok(t) => t,
        Err(_) => return false,
    };

    if !path.exists() {
        return false;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let root: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let root_obj = match root.as_object() {
        Some(o) => o,
        None => return false,
    };

    let array_key = if kind == "extension" { "extensions" } else { "packages" };
    let arr = match root_obj.get(array_key).and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return false,
    };

    arr.iter().any(|item| {
        if let Some(item_src) = extract_entry_source(kind, item) {
            resource_identities_match(kind, &clean_target, item_src)
        } else {
            false
        }
    })
}

/// Toggles a resource's enabled/disabled state in settings.json atomically.
/// Supports project overrides on inherited globals when scope == "project".
pub fn toggle_pi_resource_impl(
    target_path: &Path,
    kind: &str,
    source: &str,
    enabled: bool,
    scope: &str,
) -> Result<Value, String> {
    let kind = kind.trim().to_lowercase();
    if kind != "extension" && kind != "package" {
        return Err(format!("Invalid resource kind '{}'. Expected 'extension' or 'package'", kind));
    }
    let clean_target = normalize_target_source(&kind, source)?;

    let mut root: Value = if target_path.exists() {
        let content = std::fs::read_to_string(target_path)
            .map_err(|e| format!("Failed to read settings file {:?}: {}", target_path, e))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse settings file {:?}: {}", target_path, e))?
        }
    } else if scope == "project" {
        serde_json::json!({})
    } else {
        return Err(format!("Configuration file {:?} does not exist", target_path));
    };

    let root_obj = root.as_object_mut()
        .ok_or_else(|| "Settings file root must be an object".to_string())?;

    let array_key = if kind == "extension" { "extensions" } else { "packages" };
    if !root_obj.contains_key(array_key) {
        root_obj.insert(array_key.to_string(), Value::Array(Vec::new()));
    }

    let arr = root_obj.get_mut(array_key)
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| format!("'{}' array not found in settings", array_key))?;

    let is_auto = is_autodiscovered_extension(target_path, &clean_target);
    let target_clean = if clean_target.starts_with("extensions/") {
        clean_target.clone()
    } else if is_auto {
        format!("extensions/{}", clean_target.trim_start_matches("./"))
    } else {
        clean_target.clone()
    };

    let mut found_idx: Option<usize> = None;
    let mut was_exclusion = false;

    for (idx, item) in arr.iter().enumerate() {
        if let Some(item_src) = extract_entry_source(&kind, item) {
            if resource_identities_match(&kind, &clean_target, item_src) {
                found_idx = Some(idx);
                if kind == "extension" {
                    match item {
                        Value::String(s) => {
                            let s_trimmed = s.trim();
                            if s_trimmed.starts_with('!') || s_trimmed.starts_with('-') {
                                was_exclusion = true;
                            }
                        }
                        Value::Object(obj) => {
                            if obj.get("disabled") == Some(&Value::Bool(true))
                                || obj.get("enabled") == Some(&Value::Bool(false))
                                || obj.get("autoload") == Some(&Value::Bool(false))
                            {
                                was_exclusion = true;
                            }
                        }
                        _ => {}
                    }
                }
                break;
            }
        }
    }

    if let Some(idx) = found_idx {
        if kind == "extension" {
            if scope == "project" && is_auto && enabled && was_exclusion {
                arr.remove(idx);
            } else {
                let item = &mut arr[idx];
                match item {
                    Value::String(_) => {
                        if enabled {
                            *item = Value::String(target_clean.clone());
                        } else {
                            *item = Value::String(format!("!{}", target_clean));
                        }
                    }
                    Value::Object(obj) => {
                        if enabled {
                            obj.remove("autoload");
                            obj.remove("disabled");
                            obj.insert("enabled".to_string(), Value::Bool(true));
                        } else {
                            obj.insert("autoload".to_string(), Value::Bool(false));
                            obj.insert("enabled".to_string(), Value::Bool(false));
                        }
                    }
                    _ => {}
                }
            }
        } else {
            // Package
            let item = &mut arr[idx];
            match item {
                Value::String(_) => {
                    if enabled {
                        *item = Value::String(clean_target.clone());
                    } else {
                        let mut map = serde_json::Map::new();
                        map.insert("source".to_string(), Value::String(clean_target.clone()));
                        map.insert("autoload".to_string(), Value::Bool(false));
                        *item = Value::Object(map);
                    }
                }
                Value::Object(obj) => {
                    if enabled {
                        obj.remove("autoload");
                        obj.remove("disabled");
                        obj.insert("enabled".to_string(), Value::Bool(true));
                    } else {
                        obj.insert("autoload".to_string(), Value::Bool(false));
                        obj.insert("enabled".to_string(), Value::Bool(false));
                    }
                }
                _ => {}
            }
        }
    } else {
        if scope == "project" {
            // Inherited global or auto-discovered being overridden in project settings
            if kind == "extension" {
                if enabled {
                    arr.push(Value::String(target_clean.clone()));
                } else {
                    arr.push(Value::String(format!("!{}", target_clean)));
                }
            } else {
                // Package
                if enabled {
                    arr.push(Value::String(clean_target.clone()));
                } else {
                    let mut map = serde_json::Map::new();
                    map.insert("source".to_string(), Value::String(clean_target.clone()));
                    map.insert("autoload".to_string(), Value::Bool(false));
                    arr.push(Value::Object(map));
                }
            }
        } else {
            return Err(format!("Resource '{}' not found in '{}'", source, array_key));
        }
    }

    atomic_write_json(target_path, &root)?;

    let id = normalize_resource_id(scope, &kind, &clean_target);
    Ok(serde_json::json!({
        "success": true,
        "id": id,
        "kind": kind,
        "source": clean_target,
        "scope": scope,
        "enabled": enabled,
        "configPath": target_path.to_string_lossy().to_string(),
        "requiresReload": true,
    }))
}

/// Adds or updates a resource entry in the designated settings.json file atomically.
pub fn save_pi_resource_impl(
    target_path: &Path,
    kind: &str,
    source: &str,
    old_source: Option<&str>,
    enabled: Option<bool>,
    raw: Option<&Value>,
    scope: &str,
) -> Result<Value, String> {
    let kind = kind.trim().to_lowercase();
    if kind != "extension" && kind != "package" {
        return Err(format!("Invalid resource kind '{}'. Expected 'extension' or 'package'", kind));
    }

    let clean_source = if kind == "extension" {
        validate_extension_source(source)?
    } else {
        validate_package_source(source)?
    };

    let is_enabled = enabled.unwrap_or_else(|| {
        if kind == "extension" && clean_source.starts_with('!') {
            false
        } else {
            true
        }
    });

    let clean_source_without_prefix = if kind == "extension" && clean_source.starts_with('!') {
        clean_source[1..].trim().to_string()
    } else {
        clean_source.clone()
    };

    let mut root: Value = if target_path.exists() {
        let content = std::fs::read_to_string(target_path)
            .map_err(|e| format!("Failed to read settings file {:?}: {}", target_path, e))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse settings file {:?}: {}", target_path, e))?
        }
    } else {
        serde_json::json!({})
    };

    let root_obj = root.as_object_mut()
        .ok_or_else(|| "Settings file root must be an object".to_string())?;

    let array_key = if kind == "extension" { "extensions" } else { "packages" };
    if !root_obj.contains_key(array_key) {
        root_obj.insert(array_key.to_string(), Value::Array(Vec::new()));
    }
    let arr = root_obj.get_mut(array_key)
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| format!("'{}' field in settings must be an array", array_key))?;

    // Build the new value to insert
    let new_value = if kind == "extension" {
        if let Some(raw_obj) = raw.and_then(|r| r.as_object()) {
            let mut obj = raw_obj.clone();
            obj.insert("source".to_string(), Value::String(clean_source_without_prefix.clone()));
            if is_enabled {
                obj.remove("autoload");
                obj.remove("disabled");
                obj.insert("enabled".to_string(), Value::Bool(true));
            } else {
                obj.insert("autoload".to_string(), Value::Bool(false));
                obj.insert("enabled".to_string(), Value::Bool(false));
            }
            Value::Object(obj)
        } else {
            if is_enabled {
                Value::String(clean_source_without_prefix.clone())
            } else {
                Value::String(format!("!{}", clean_source_without_prefix))
            }
        }
    } else {
        // Package
        if let Some(raw_obj) = raw.and_then(|r| r.as_object()) {
            let mut obj = raw_obj.clone();
            obj.insert("source".to_string(), Value::String(clean_source.clone()));
            if is_enabled {
                obj.remove("autoload");
                obj.remove("disabled");
            } else {
                obj.insert("autoload".to_string(), Value::Bool(false));
            }
            Value::Object(obj)
        } else {
            if is_enabled {
                Value::String(clean_source.clone())
            } else {
                let mut map = serde_json::Map::new();
                map.insert("source".to_string(), Value::String(clean_source.clone()));
                map.insert("autoload".to_string(), Value::Bool(false));
                Value::Object(map)
            }
        }
    };

    // Find index to replace, matching old_source or clean_source
    let search_target = match old_source.filter(|s| !s.trim().is_empty()) {
        Some(old) => Some(normalize_target_source(&kind, old)?),
        None => None,
    };
    let mut match_index = None;

    if let Some(ref old_clean) = search_target {
        for (idx, item) in arr.iter().enumerate() {
            if extract_entry_source(&kind, item) == Some(old_clean.as_str()) {
                match_index = Some(idx);
                break;
            }
        }
    }

    if match_index.is_none() {
        let check_clean = if kind == "extension" { &clean_source_without_prefix } else { &clean_source };
        for (idx, item) in arr.iter().enumerate() {
            if extract_entry_source(&kind, item) == Some(check_clean.as_str()) {
                match_index = Some(idx);
                break;
            }
        }
    }

    if let Some(idx) = match_index {
        arr[idx] = new_value;
    } else {
        arr.push(new_value);
    }

    atomic_write_json(target_path, &root)?;

    let id_source = if kind == "extension" { &clean_source_without_prefix } else { &clean_source };
    let id = normalize_resource_id(scope, &kind, id_source);

    Ok(serde_json::json!({
        "success": true,
        "id": id,
        "kind": kind,
        "source": id_source,
        "scope": scope,
        "configPath": target_path.to_string_lossy().to_string(),
        "requiresReload": true,
    }))
}

/// Deletes a resource entry from settings.json atomically.
pub fn delete_pi_resource_impl(
    target_path: &Path,
    kind: &str,
    source: &str,
    scope: &str,
) -> Result<Value, String> {
    let kind = kind.trim().to_lowercase();
    if kind != "extension" && kind != "package" {
        return Err(format!("Invalid resource kind '{}'. Expected 'extension' or 'package'", kind));
    }
    let clean_target = normalize_target_source(&kind, source)?;

    if !target_path.exists() {
        return Err(format!("Configuration file {:?} does not exist", target_path));
    }

    let content = std::fs::read_to_string(target_path)
        .map_err(|e| format!("Failed to read settings file {:?}: {}", target_path, e))?;
    let mut root: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings file {:?}: {}", target_path, e))?;

    let root_obj = root.as_object_mut()
        .ok_or_else(|| "Settings file root must be an object".to_string())?;

    let array_key = if kind == "extension" { "extensions" } else { "packages" };
    let arr = root_obj.get_mut(array_key)
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| format!("'{}' array not found in settings", array_key))?;

    let mut remove_idx = None;
    for (idx, item) in arr.iter().enumerate() {
        if let Some(s) = extract_entry_source(&kind, item) {
            if resource_identities_match(&kind, &clean_target, s) {
                remove_idx = Some(idx);
                break;
            }
        }
    }

    let idx = remove_idx.ok_or_else(|| format!("Resource '{}' not found in '{}'", source, array_key))?;
    arr.remove(idx);

    atomic_write_json(target_path, &root)?;

    let id = normalize_resource_id(scope, &kind, &clean_target);
    Ok(serde_json::json!({
        "success": true,
        "id": id,
        "kind": kind,
        "source": clean_target,
        "scope": scope,
        "configPath": target_path.to_string_lossy().to_string(),
        "requiresReload": true,
    }))
}

/// Tauri command to list configured Pi extensions and packages across global and project settings.
#[tauri::command]
pub async fn get_pi_resources(cwd: Option<String>) -> Result<Value, String> {
    let global_path = resolve_settings_config_path();
    let project_path = cwd.as_deref().and_then(|c| {
        let trimmed = c.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(resolve_project_settings_config_path(Path::new(trimmed)))
        }
    });

    get_pi_resources_impl(global_path.as_deref(), project_path.as_deref())
}

/// Tauri command to add or edit a Pi extension or package.
#[tauri::command]
pub async fn save_pi_resource(
    cwd: Option<String>,
    scope: Option<String>,
    kind: String,
    source: String,
    old_source: Option<String>,
    enabled: Option<bool>,
    raw: Option<Value>,
) -> Result<Value, String> {
    let requested_scope = scope.as_deref().map(|s| s.trim().to_lowercase());
    let (target_path, final_scope) = match requested_scope.as_deref() {
        Some("project") => {
            let cwd_str = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?;
            (resolve_project_settings_config_path(Path::new(cwd_str)), "project")
        }
        Some("global") => {
            let g = resolve_settings_config_path()
                .ok_or_else(|| "Could not resolve global settings config path".to_string())?;
            (g, "global")
        }
        _ => {
            if let Some(cwd_str) = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                (resolve_project_settings_config_path(Path::new(cwd_str)), "project")
            } else {
                let g = resolve_settings_config_path()
                    .ok_or_else(|| "Could not resolve global settings config path".to_string())?;
                (g, "global")
            }
        }
    };

    save_pi_resource_impl(
        &target_path,
        &kind,
        &source,
        old_source.as_deref(),
        enabled,
        raw.as_ref(),
        final_scope,
    )
}

/// Tauri command to toggle a Pi extension or package enabled/disabled state.
#[tauri::command]
pub async fn toggle_pi_resource(
    cwd: Option<String>,
    scope: Option<String>,
    kind: String,
    source: String,
    enabled: bool,
) -> Result<Value, String> {
    let requested_scope = scope.as_deref().map(|s| s.trim().to_lowercase());
    let (target_path, final_scope) = match requested_scope.as_deref() {
        Some("project") => {
            let cwd_str = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?;
            (resolve_project_settings_config_path(Path::new(cwd_str)), "project")
        }
        Some("global") => {
            let g = resolve_settings_config_path()
                .ok_or_else(|| "Could not resolve global settings config path".to_string())?;
            (g, "global")
        }
        _ => {
            let proj_path = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .map(|c| resolve_project_settings_config_path(Path::new(c)));
            let glob_path = resolve_settings_config_path();

            if let Some(ref p) = proj_path {
                if resource_exists_in_file(p, &kind, &source) {
                    (p.clone(), "project")
                } else if let Some(ref g) = glob_path {
                    (g.clone(), "global")
                } else {
                    (p.clone(), "project")
                }
            } else if let Some(g) = glob_path {
                (g, "global")
            } else {
                return Err("Could not resolve any settings config path".to_string());
            }
        }
    };

    toggle_pi_resource_impl(&target_path, &kind, &source, enabled, final_scope)
}

/// Tauri command to delete a Pi extension or package from settings.
#[tauri::command]
pub async fn delete_pi_resource(
    cwd: Option<String>,
    scope: Option<String>,
    kind: String,
    source: String,
) -> Result<Value, String> {
    let requested_scope = scope.as_deref().map(|s| s.trim().to_lowercase());
    let (target_path, final_scope) = match requested_scope.as_deref() {
        Some("project") => {
            let cwd_str = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?;
            (resolve_project_settings_config_path(Path::new(cwd_str)), "project")
        }
        Some("global") => {
            let g = resolve_settings_config_path()
                .ok_or_else(|| "Could not resolve global settings config path".to_string())?;
            (g, "global")
        }
        _ => {
            let proj_path = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .map(|c| resolve_project_settings_config_path(Path::new(c)));
            let glob_path = resolve_settings_config_path();

            if let Some(ref p) = proj_path {
                if resource_exists_in_file(p, &kind, &source) {
                    (p.clone(), "project")
                } else if let Some(ref g) = glob_path {
                    (g.clone(), "global")
                } else {
                    (p.clone(), "project")
                }
            } else if let Some(g) = glob_path {
                (g, "global")
            } else {
                return Err("Could not resolve any settings config path".to_string());
            }
        }
    };

    delete_pi_resource_impl(&target_path, &kind, &source, final_scope)
}

/// Resolves canonical path to global Pi agent directory under `$USERPROFILE` / `$HOME` / `.pi/agent`.
pub fn resolve_global_agent_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_GLOBAL_AGENT_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;

    Some(home.join(".pi").join("agent"))
}

/// Resolves canonical path to global SDD profiles directory under `$USERPROFILE` / `$HOME` / `.pi/agent/profiles`.
pub fn resolve_global_profiles_dir() -> Option<PathBuf> {
    resolve_global_agent_dir().map(|d| d.join("profiles"))
}

/// Resolves path to project SDD profiles directory under `<cwd>/.pi/profiles`.
pub fn resolve_project_profiles_dir(cwd: &Path) -> PathBuf {
    cwd.join(".pi").join("profiles")
}

/// Resolves path to global `subagents.json` under `$USERPROFILE` / `$HOME` / `.pi/agent/subagents.json`.
pub fn resolve_global_subagents_path() -> Option<PathBuf> {
    resolve_global_agent_dir().map(|d| d.join("subagents.json"))
}

/// Resolves path to project `subagents.json` under `<cwd>/.pi/subagents.json`.
pub fn resolve_project_subagents_path(cwd: &Path) -> PathBuf {
    cwd.join(".pi").join("subagents.json")
}

/// Sanitizes a profile name into a valid filename / identifier.
pub fn sanitize_profile_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// Checks whether a key is a synthetic or invalid agent key (e.g. status emojis, UI hints, whitespace).
pub fn is_synthetic_agent_key(key: &str) -> bool {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with('⚡')
        || trimmed.starts_with('🧠')
        || trimmed.starts_with('📦')
        || trimmed.starts_with('👑')
        || trimmed.contains("[Asignar")
        || trimmed.chars().any(|c| c.is_whitespace())
    {
        return true;
    }
    false
}



/// Reads the trimmed string from an `.active` profile pointer file if present and non-empty.
pub fn read_active_file(path: &Path) -> Option<String> {
    if path.is_file() {
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Applies a profile's configuration to a `subagents.json` file, preserving existing custom configurations.
pub fn apply_profile_to_subagents_file(target_file: &Path, profile: &Value) -> Result<(), String> {
    let mut current_config = if target_file.is_file() {
        let content = std::fs::read_to_string(target_file)
            .map_err(|e| format!("Failed to read {}: {}", target_file.display(), e))?;
        serde_json::from_str::<Value>(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let config_obj = current_config.as_object_mut()
        .ok_or_else(|| "Subagents config must be an object".to_string())?;

    if let Some(dm) = profile.get("default_model").and_then(|v| v.as_str()) {
        if !dm.trim().is_empty() {
            config_obj.insert("default_model".to_string(), Value::String(dm.trim().to_string()));
        }
    }

    if let Some(de) = profile.get("default_effort").and_then(|v| v.as_str()) {
        let trimmed = de.trim();
        if !trimmed.is_empty() && trimmed != "none" && trimmed != "default" && trimmed != "unset" {
            config_obj.insert("default_effort".to_string(), Value::String(trimmed.to_string()));
        } else {
            config_obj.remove("default_effort");
        }
    } else {
        config_obj.remove("default_effort");
    }

    if let Some(name) = profile.get("name").and_then(|v| v.as_str()) {
        config_obj.insert("active_profile".to_string(), Value::String(name.trim().to_string()));
    }

    let mut model_profiles = serde_json::Map::new();
    if let Some(mp) = profile.get("model_profiles").and_then(|v| v.as_object()) {
        for (agent_key, entry_val) in mp {
            if !is_synthetic_agent_key(agent_key) {
                if let Some(entry_obj) = entry_val.as_object() {
                    if let Some(model) = entry_obj.get("model").and_then(|v| v.as_str()) {
                        let mut agent_entry = serde_json::Map::new();
                        agent_entry.insert("model".to_string(), Value::String(model.trim().to_string()));
                        if let Some(effort) = entry_obj.get("effort").and_then(|v| v.as_str()) {
                            let effort_trimmed = effort.trim();
                            if !effort_trimmed.is_empty()
                                && effort_trimmed != "none"
                                && effort_trimmed != "default"
                                && effort_trimmed != "unset"
                            {
                                agent_entry.insert("effort".to_string(), Value::String(effort_trimmed.to_string()));
                            }
                        }
                        model_profiles.insert(agent_key.clone(), Value::Object(agent_entry));
                    }
                }
            }
        }
    }
    config_obj.insert("model_profiles".to_string(), Value::Object(model_profiles));

    if let Some(parent) = target_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory for {}: {}", target_file.display(), e))?;
    }
    atomic_write_json(target_file, &current_config)
}

/// Removes profile-managed keys (`active_profile`, `default_model`, `default_effort`, `model_profiles`)
/// from a `subagents.json` file, preserving all other custom configuration.
pub fn clear_profile_keys_from_subagents_file(target_file: &Path) -> Result<(), String> {
    if !target_file.is_file() {
        return Ok(());
    }
    let content = std::fs::read_to_string(target_file)
        .map_err(|e| format!("Failed to read {}: {}", target_file.display(), e))?;
    let mut current_config: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    if let Some(obj) = current_config.as_object_mut() {
        obj.remove("active_profile");
        obj.remove("default_model");
        obj.remove("default_effort");
        obj.remove("model_profiles");
    }

    atomic_write_json(target_file, &current_config)
}

/// Helper to find a profile definition in a directory by name or sanitized name,
/// first checking direct paths then falling back to a full directory scan.
pub fn find_profile_by_name(dir: &Path, name: &str) -> Option<Value> {
    if !dir.is_dir() {
        return None;
    }
    let sanitized = sanitize_profile_name(name);

    // 1. Direct path check
    let direct_candidates = [
        dir.join(format!("{}.json", sanitized)),
        dir.join(format!("{}.json", name)),
    ];
    for path in &direct_candidates {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if val.is_object() {
                        let prof_name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if prof_name.trim() == name
                            || sanitize_profile_name(prof_name) == sanitized
                            || prof_name.eq_ignore_ascii_case(name)
                        {
                            return Some(val);
                        }
                    }
                }
            }
        }
    }

    // 2. Directory-scan fallback (consistent with discover_sdd_profiles_impl)
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension().and_then(|ext| ext.to_str()) == Some("json")
                    && p.file_name().and_then(|n| n.to_str()).map(|n| !n.starts_with('.')).unwrap_or(false)
            })
            .collect();
        paths.sort();

        for path in paths {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if val.is_object() {
                        let prof_name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if prof_name.trim() == name
                            || sanitize_profile_name(prof_name) == sanitized
                            || prof_name.eq_ignore_ascii_case(name)
                        {
                            return Some(val);
                        }
                    }
                }
            }
        }
    }

    None
}

#[derive(Debug, Clone)]
pub struct DiscoveredAgent {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub scope: String,
    pub origin_tier: u8,
    pub package_name: Option<String>,
}

pub fn slugify_category(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "custom".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn parse_markdown_agent_frontmatter(
    content: &str,
    file_stem: &str,
    scope: &str,
    origin_tier: u8,
    package_name: Option<String>,
) -> Option<DiscoveredAgent> {
    let trimmed = content.trim_start();
    let mut frontmatter_lines: Vec<&str> = Vec::new();

    if trimmed.starts_with("---") {
        let lines: Vec<&str> = trimmed.lines().collect();
        if lines.len() > 1 && lines[0].trim() == "---" {
            let mut closed = false;
            let mut candidate_lines = Vec::new();
            for &line in &lines[1..] {
                if line.trim() == "---" {
                    closed = true;
                    break;
                }
                candidate_lines.push(line);
            }
            if closed {
                frontmatter_lines = candidate_lines;
            }
        }
    }

    let mut id_opt = None;
    let mut name_opt = None;
    let mut desc_opt = None;
    let mut cat_opt = None;

    for line in frontmatter_lines {
        let line_trimmed = line.trim();
        if line_trimmed.starts_with('#') || line_trimmed.is_empty() {
            continue;
        }
        if let Some((k, v)) = line_trimmed.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let mut val = v.trim();
            if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
            {
                val = val[1..val.len() - 1].trim();
            }

            if !val.is_empty() {
                match key.as_str() {
                    "id" => id_opt = Some(val.to_string()),
                    "name" => name_opt = Some(val.to_string()),
                    "description" => desc_opt = Some(val.to_string()),
                    "category" => cat_opt = Some(val.to_string()),
                    _ => {}
                }
            }
        }
    }

    let effective_id = id_opt
        .or_else(|| name_opt.clone())
        .unwrap_or_else(|| file_stem.to_string());
    let effective_id = effective_id.trim();

    if effective_id.is_empty() || is_synthetic_agent_key(effective_id) {
        return None;
    }

    Some(DiscoveredAgent {
        id: effective_id.to_string(),
        name: name_opt.or_else(|| Some(effective_id.to_string())),
        description: desc_opt,
        category: cat_opt,
        scope: scope.to_string(),
        origin_tier,
        package_name,
    })
}

fn scan_agent_markdown_dir(
    dir: &Path,
    scope: &str,
    origin_tier: u8,
    package_name: Option<String>,
    candidates: &mut Vec<DiscoveredAgent>,
) {
    if dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()) {
                        if ext == "md" {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                if !is_synthetic_agent_key(stem) {
                                    if let Ok(content) = std::fs::read_to_string(&path) {
                                        if let Some(agent) = parse_markdown_agent_frontmatter(
                                            &content,
                                            stem,
                                            scope,
                                            origin_tier,
                                            package_name.clone(),
                                        ) {
                                            candidates.push(agent);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn scan_package_agents(
    settings_path: &Path,
    scope: &str,
    candidates: &mut Vec<DiscoveredAgent>,
) {
    if !settings_path.is_file() {
        return;
    }
    let content = match std::fs::read_to_string(settings_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let root: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };
    let pkgs = match root.get("packages").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return,
    };

    let settings_dir = settings_path.parent();

    for item in pkgs {
        let source = match item {
            Value::String(s) => s.as_str(),
            Value::Object(obj) => {
                let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                let autoload = obj.get("autoload").and_then(|v| v.as_bool()).unwrap_or(true);
                if !enabled || !autoload {
                    continue;
                }
                obj.get("source").and_then(|v| v.as_str()).unwrap_or("")
            }
            _ => "",
        };
        let source = source.trim();
        if source.is_empty() {
            continue;
        }

        let mut pkg_dir_opt: Option<PathBuf> = None;
        let is_rel_or_abs = source.starts_with('.') || source.starts_with('/') || source.starts_with('\\')
            || (source.len() >= 2 && source.chars().nth(1) == Some(':'));

        if is_rel_or_abs {
            if let Some(s_dir) = settings_dir {
                let candidate = s_dir.join(source);
                if candidate.is_dir() {
                    pkg_dir_opt = Some(candidate);
                }
            }
            if pkg_dir_opt.is_none() {
                let candidate = PathBuf::from(source);
                if candidate.is_dir() {
                    pkg_dir_opt = Some(candidate);
                }
            }
        } else if let Some(stripped) = source.strip_prefix("npm:") {
            let pkg_ident = extract_package_identity(stripped);
            if let Some(s_dir) = settings_dir {
                let candidate = s_dir.join("npm").join("node_modules").join(&pkg_ident);
                if candidate.is_dir() {
                    pkg_dir_opt = Some(candidate);
                } else {
                    let candidate2 = s_dir.join("npm").join(&pkg_ident);
                    if candidate2.is_dir() {
                        pkg_dir_opt = Some(candidate2);
                    }
                }
            }
        }

        if let Some(pkg_dir) = pkg_dir_opt {
            let mut pkg_name = derive_resource_name("package", source);
            let pkg_json = pkg_dir.join("package.json");
            if pkg_json.is_file() {
                if let Ok(pj_content) = std::fs::read_to_string(&pkg_json) {
                    if let Ok(pj_val) = serde_json::from_str::<Value>(&pj_content) {
                        if let Some(name_str) = pj_val.get("name").and_then(|v| v.as_str()) {
                            pkg_name = name_str.to_string();
                        }
                        if let Some(agent_arr) = pj_val.get("pi").and_then(|p| p.get("agents")).and_then(|a| a.as_array()) {
                            for agent_val in agent_arr {
                                if let Some(rel) = agent_val.as_str() {
                                    let rel_path = pkg_dir.join(rel);
                                    if rel_path.is_file() {
                                        if let Some(stem) = rel_path.file_stem().and_then(|s| s.to_str()) {
                                            if let Ok(c) = std::fs::read_to_string(&rel_path) {
                                                if let Some(a) = parse_markdown_agent_frontmatter(&c, stem, scope, 3, Some(pkg_name.clone())) {
                                                    candidates.push(a);
                                                }
                                            }
                                        }
                                    } else if rel_path.is_dir() {
                                        scan_agent_markdown_dir(&rel_path, scope, 3, Some(pkg_name.clone()), candidates);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            scan_agent_markdown_dir(&pkg_dir.join("agents"), scope, 3, Some(pkg_name.clone()), candidates);
            scan_agent_markdown_dir(&pkg_dir.join("subagents"), scope, 3, Some(pkg_name.clone()), candidates);
        }
    }
}

fn scan_subagents_file(
    path: &Path,
    scope: &str,
    candidates: &mut Vec<DiscoveredAgent>,
) {
    if !path.is_file() {
        return;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let val: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(agents) = val.get("agents") {
        if let Some(obj) = agents.as_object() {
            for (k, entry_val) in obj {
                if !is_synthetic_agent_key(k) {
                    let mut name = None;
                    let mut desc = None;
                    let mut cat = None;
                    if let Some(entry_obj) = entry_val.as_object() {
                        name = entry_obj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                        desc = entry_obj.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                        cat = entry_obj.get("category").and_then(|v| v.as_str()).map(|s| s.to_string());
                    } else if let Some(s) = entry_val.as_str() {
                        desc = Some(s.to_string());
                    }
                    candidates.push(DiscoveredAgent {
                        id: k.clone(),
                        name: name.or_else(|| Some(k.clone())),
                        description: desc,
                        category: cat,
                        scope: scope.to_string(),
                        origin_tier: 2,
                        package_name: None,
                    });
                }
            }
        } else if let Some(arr) = agents.as_array() {
            for item in arr {
                if let Some(id_str) = item.as_str() {
                    if !is_synthetic_agent_key(id_str) {
                        candidates.push(DiscoveredAgent {
                            id: id_str.to_string(),
                            name: Some(id_str.to_string()),
                            description: None,
                            category: None,
                            scope: scope.to_string(),
                            origin_tier: 2,
                            package_name: None,
                        });
                    }
                } else if let Some(item_obj) = item.as_object() {
                    if let Some(id_str) = item_obj.get("id").or_else(|| item_obj.get("name")).and_then(|v| v.as_str()) {
                        if !is_synthetic_agent_key(id_str) {
                            let name = item_obj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let desc = item_obj.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let cat = item_obj.get("category").and_then(|v| v.as_str()).map(|s| s.to_string());
                            candidates.push(DiscoveredAgent {
                                id: id_str.to_string(),
                                name: name.or_else(|| Some(id_str.to_string())),
                                description: desc,
                                category: cat,
                                scope: scope.to_string(),
                                origin_tier: 2,
                                package_name: None,
                            });
                        }
                    }
                }
            }
        }
    }

    if let Some(mp) = val.get("model_profiles").and_then(|v| v.as_object()) {
        for k in mp.keys() {
            if !is_synthetic_agent_key(k) {
                candidates.push(DiscoveredAgent {
                    id: k.clone(),
                    name: Some(k.clone()),
                    description: None,
                    category: None,
                    scope: scope.to_string(),
                    origin_tier: 1,
                    package_name: None,
                });
            }
        }
    }
}

/// Pure implementation to list all SDD profiles (global, project) and dynamically discovered subagents.
pub fn discover_sdd_profiles_impl(
    global_agent_dir: Option<&Path>,
    cwd: Option<&Path>,
) -> Result<Value, String> {
    let mut raw_profiles: Vec<(Value, &'static str, Option<String>)> = Vec::new();

    // 1. Global profiles
    if let Some(g_agent_dir) = global_agent_dir {
        let global_dir = g_agent_dir.join("profiles");
        if global_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&global_dir) {
                let mut paths: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.extension().and_then(|ext| ext.to_str()) == Some("json")
                            && p.file_name().and_then(|n| n.to_str()).map(|n| !n.starts_with('.')).unwrap_or(false)
                    })
                    .collect();
                paths.sort();
                for path in paths {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Ok(val) = serde_json::from_str::<Value>(&content) {
                            if val.is_object() && val.get("name").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                                raw_profiles.push((val, "global", Some(path.to_string_lossy().to_string())));
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Project profiles (<cwd>/.pi/profiles/*.json)
    if let Some(c) = cwd {
        let project_dir = c.join(".pi").join("profiles");
        if project_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&project_dir) {
                let mut paths: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.extension().and_then(|ext| ext.to_str()) == Some("json")
                            && p.file_name().and_then(|n| n.to_str()).map(|n| !n.starts_with('.')).unwrap_or(false)
                    })
                    .collect();
                paths.sort();
                for path in paths {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Ok(val) = serde_json::from_str::<Value>(&content) {
                            if val.is_object() && val.get("name").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                                raw_profiles.push((val, "project", Some(path.to_string_lossy().to_string())));
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Read .active files
    let global_active = global_agent_dir.and_then(|d| read_active_file(&d.join("profiles").join(".active")));
    let project_active = cwd.and_then(|c| read_active_file(&c.join(".pi").join("profiles").join(".active")));

    // 4. Effective active profile and scope
    let (effective_active, effective_scope): (Option<String>, Option<String>) = if let Some(ref pa) = project_active {
        let clean_pa = sanitize_profile_name(pa);
        let scope = raw_profiles
            .iter()
            .find(|(p, _, _)| {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                sanitize_profile_name(name) == clean_pa
            })
            .map(|(_, sc, _)| *sc)
            .unwrap_or("project");
        (Some(pa.clone()), Some(scope.to_string()))
    } else if let Some(ref ga) = global_active {
        let clean_ga = sanitize_profile_name(ga);
        let scope = raw_profiles
            .iter()
            .find(|(p, _, _)| {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                sanitize_profile_name(name) == clean_ga
            })
            .map(|(_, sc, _)| *sc)
            .unwrap_or("global");
        (Some(ga.clone()), Some(scope.to_string()))
    } else {
        (None, None)
    };

    let sanitized_effective = effective_active.as_deref().map(sanitize_profile_name);

    // 5. Build profile summaries
    let mut profiles_summaries: Vec<Value> = Vec::new();
    let mut chosen_active_index: Option<usize> = None;

    if let Some(ref se) = sanitized_effective {
        for (idx, (p, scope, _)) in raw_profiles.iter().enumerate() {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            let sanitized = sanitize_profile_name(name);
            let matches_effective = sanitized == *se;

            if matches_effective && chosen_active_index.is_none() {
                if project_active.is_some() && *scope == "project" {
                    chosen_active_index = Some(idx);
                } else if project_active.is_none() && global_active.is_some() && *scope == "global" {
                    chosen_active_index = Some(idx);
                }
            }
        }

        if chosen_active_index.is_none() {
            for (idx, (p, _, _)) in raw_profiles.iter().enumerate() {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
                if sanitize_profile_name(name) == *se {
                    chosen_active_index = Some(idx);
                    break;
                }
            }
        }
    }

    for (idx, (p, scope, path)) in raw_profiles.iter().enumerate() {
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let is_active = chosen_active_index == Some(idx);
        let active_scope = if is_active {
            if project_active.is_some() {
                Some("project")
            } else if global_active.is_some() {
                Some("global")
            } else {
                None
            }
        } else {
            None
        };

        let agent_count = p.get("model_profiles")
            .and_then(|v| v.as_object())
            .map(|mp| mp.keys().filter(|k| !is_synthetic_agent_key(k)).count())
            .unwrap_or(0);

        let mut summary_map = serde_json::Map::new();
        summary_map.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(desc) = p.get("description").and_then(|v| v.as_str()) {
            summary_map.insert("description".to_string(), Value::String(desc.to_string()));
        }
        if let Some(dm) = p.get("default_model").and_then(|v| v.as_str()) {
            summary_map.insert("default_model".to_string(), Value::String(dm.to_string()));
        }
        if let Some(de) = p.get("default_effort").and_then(|v| v.as_str()) {
            summary_map.insert("default_effort".to_string(), Value::String(de.to_string()));
        }
        summary_map.insert("agent_count".to_string(), serde_json::json!(agent_count));
        summary_map.insert("scope".to_string(), Value::String(scope.to_string()));
        summary_map.insert("is_active".to_string(), Value::Bool(is_active));
        if let Some(asc) = active_scope {
            summary_map.insert("active_scope".to_string(), Value::String(asc.to_string()));
        }
        if let Some(ref p_str) = path {
            summary_map.insert("path".to_string(), Value::String(p_str.clone()));
        }
        if let Some(mp) = p.get("model_profiles") {
            summary_map.insert("model_profiles".to_string(), mp.clone());
        }
        if let Some(ca) = p.get("created_at").and_then(|v| v.as_str()) {
            summary_map.insert("created_at".to_string(), Value::String(ca.to_string()));
        }
        if let Some(ua) = p.get("updated_at").and_then(|v| v.as_str()) {
            summary_map.insert("updated_at".to_string(), Value::String(ua.to_string()));
        }

        profiles_summaries.push(Value::Object(summary_map));
    }

    // 6. Dynamic subagent discovery from actual definitions and config
    // Saved profiles model_profiles alone are legacy references and MUST NOT make an agent appear installed.
    let mut candidate_agents: Vec<DiscoveredAgent> = Vec::new();

    if let Some(g_dir) = global_agent_dir {
        scan_agent_markdown_dir(&g_dir.join("agents"), "global", 4, None, &mut candidate_agents);
        scan_agent_markdown_dir(&g_dir.join("subagents"), "global", 4, None, &mut candidate_agents);
        scan_package_agents(&g_dir.join("settings.json"), "global", &mut candidate_agents);
        scan_subagents_file(&g_dir.join("subagents.json"), "global", &mut candidate_agents);
    }

    if let Some(c) = cwd {
        scan_agent_markdown_dir(&c.join(".pi").join("agents"), "project", 4, None, &mut candidate_agents);
        scan_agent_markdown_dir(&c.join(".pi").join("subagents"), "project", 4, None, &mut candidate_agents);
        scan_agent_markdown_dir(&c.join("agents"), "project", 4, None, &mut candidate_agents);
        scan_package_agents(&c.join(".pi").join("settings.json"), "project", &mut candidate_agents);
        scan_subagents_file(&c.join(".pi").join("subagents.json"), "project", &mut candidate_agents);
    }

    // Deduplicate candidates according to precedence:
    // Scope weight: Project = 10, Global = 0; + origin_tier (4 = def, 3 = pkg, 2 = agents cfg, 1 = bare cfg)
    let mut resolved_agents: std::collections::BTreeMap<String, (u8, DiscoveredAgent)> = std::collections::BTreeMap::new();

    for candidate in candidate_agents {
        let scope_weight: u8 = if candidate.scope == "project" { 10 } else { 0 };
        let score = scope_weight + candidate.origin_tier;

        match resolved_agents.get_mut(&candidate.id) {
            None => {
                resolved_agents.insert(candidate.id.clone(), (score, candidate));
            }
            Some((existing_score, existing_agent)) => {
                if score > *existing_score {
                    let mut updated = candidate;
                    if updated.description.is_none() {
                        updated.description = existing_agent.description.clone();
                    }
                    if updated.category.is_none() {
                        updated.category = existing_agent.category.clone();
                    }
                    *existing_score = score;
                    *existing_agent = updated;
                } else {
                    if existing_agent.description.is_none() {
                        existing_agent.description = candidate.description;
                    }
                    if existing_agent.category.is_none() {
                        existing_agent.category = candidate.category;
                    }
                }
            }
        }
    }

    // 7. Categories: dynamic categorization
    struct CategoryBucket {
        id: String,
        name: String,
        description: String,
        priority: u8,
        agents: Vec<String>,
    }

    let mut category_map: std::collections::BTreeMap<String, CategoryBucket> = std::collections::BTreeMap::new();

    for (agent_id, (_, agent)) in &resolved_agents {
        let (cat_id, cat_name, cat_desc, priority) = if let Some(ref c) = agent.category {
            let clean = c.trim();
            let slug = slugify_category(clean);
            (slug, clean.to_string(), format!("{} agents", clean), 50)
        } else if let Some(ref pkg) = agent.package_name {
            let clean = pkg.trim();
            let slug = format!("pkg-{}", slugify_category(clean));
            (slug, clean.to_string(), format!("Agents provided by {}", clean), 60)
        } else if agent_id.starts_with("sdd-") {
            ("sdd-core".to_string(), "Spec-Driven Development".to_string(), "Spec-Driven Development phase executor agents".to_string(), 10)
        } else if agent_id.starts_with("jd-") {
            ("judgment-day".to_string(), "Judgment Day".to_string(), "Blind dual review judges and fix agent".to_string(), 20)
        } else if agent_id.starts_with("review-") || agent_id.ends_with("-auditor") {
            ("reviewers".to_string(), "Reviewers & Auditors".to_string(), "Quality, security, and architectural review lenses".to_string(), 30)
        } else if agent_id.starts_with("gentle-ai-") || agent_id.starts_with("gentle-") {
            ("gentle-ai".to_string(), "Gentle AI".to_string(), "General harness and execution agents".to_string(), 40)
        } else if agent.scope == "project" {
            ("project".to_string(), "Project Agents".to_string(), "Subagents discovered in project directory".to_string(), 70)
        } else if agent.scope == "global" {
            ("global".to_string(), "Global Agents".to_string(), "Globally configured subagents".to_string(), 80)
        } else {
            ("general".to_string(), "General Harness".to_string(), "General subagents for code, exploration, and tracking".to_string(), 90)
        };

        let bucket = category_map.entry(cat_id.clone()).or_insert_with(|| CategoryBucket {
            id: cat_id,
            name: cat_name,
            description: cat_desc,
            priority,
            agents: Vec::new(),
        });
        bucket.agents.push(agent_id.clone());
    }

    let mut sorted_buckets: Vec<CategoryBucket> = category_map.into_values().collect();
    sorted_buckets.sort_by(|a, b| {
        if a.priority != b.priority {
            a.priority.cmp(&b.priority)
        } else {
            a.name.cmp(&b.name)
        }
    });

    let mut categories = Vec::new();
    let mut all_agents = Vec::new();

    for mut bucket in sorted_buckets {
        if !bucket.agents.is_empty() {
            bucket.agents.sort();
            for a in &bucket.agents {
                all_agents.push(a.clone());
            }
            categories.push(serde_json::json!({
                "id": bucket.id,
                "name": bucket.name,
                "description": bucket.description,
                "agents": bucket.agents
            }));
        }
    }

    Ok(serde_json::json!({
        "profiles": profiles_summaries,
        "projectActiveProfile": project_active,
        "globalActiveProfile": global_active,
        "effectiveActiveProfile": effective_active,
        "effectiveScope": effective_scope,
        "categories": categories,
        "allAgents": all_agents
    }))
}

/// Tauri command to list all SDD profiles (global, project) and discovered subagents.
#[tauri::command]
pub async fn get_sdd_profiles(cwd: Option<String>) -> Result<Value, String> {
    let global_agent_dir = resolve_global_agent_dir();
    let valid_cwd = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()).map(Path::new);
    discover_sdd_profiles_impl(global_agent_dir.as_deref(), valid_cwd)
}

/// Tauri command to save or update an SDD profile.
#[tauri::command]
pub async fn save_sdd_profile(
    cwd: Option<String>,
    scope: Option<String>,
    mut profile: Value,
) -> Result<Value, String> {
    let name_str = profile.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).unwrap_or_default();
    if name_str.is_empty() {
        return Err("Profile name is required and cannot be empty".to_string());
    }
    let sanitized_name = sanitize_profile_name(&name_str);
    if sanitized_name.is_empty() {
        return Err("Profile name contains only invalid characters".to_string());
    }

    let requested_scope = scope.as_deref().map(|s| s.trim().to_lowercase());
    let target_dir = match requested_scope.as_deref() {
        Some("project") => {
            let cwd_str = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?;
            resolve_project_profiles_dir(Path::new(cwd_str))
        }
        Some("global") => {
            resolve_global_profiles_dir()
                .ok_or_else(|| "Could not resolve global profiles directory".to_string())?
        }
        _ => {
            if let Some(cwd_str) = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                resolve_project_profiles_dir(Path::new(cwd_str))
            } else {
                resolve_global_profiles_dir()
                    .ok_or_else(|| "Could not resolve global profiles directory".to_string())?
            }
        }
    };

    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create profiles directory {}: {}", target_dir.display(), e))?;

    let target_file = target_dir.join(format!("{}.json", sanitized_name));

    let now_rfc3339 = crate::commands::sessions::system_time_to_rfc3339(std::time::SystemTime::now())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string());

    if let Some(obj) = profile.as_object_mut() {
        obj.insert("name".to_string(), Value::String(name_str.to_string()));
        if !obj.contains_key("created_at") || obj["created_at"].is_null() {
            obj.insert("created_at".to_string(), Value::String(now_rfc3339.clone()));
        }
        obj.insert("updated_at".to_string(), Value::String(now_rfc3339));
    }

    atomic_write_json(&target_file, &profile)?;

    Ok(serde_json::json!({
        "success": true,
        "profile": profile,
        "path": target_file.to_string_lossy(),
        "message": format!("Profile '{}' saved successfully", name_str)
    }))
}

/// Tauri command to delete an SDD profile file and clear .active if it points to it.
#[tauri::command]
pub async fn delete_sdd_profile(
    cwd: Option<String>,
    scope: Option<String>,
    name: String,
) -> Result<Value, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Profile name is required".to_string());
    }
    let sanitized_name = sanitize_profile_name(trimmed_name);

    let requested_scope = scope.as_deref().map(|s| s.trim().to_lowercase());
    let target_dir = match requested_scope.as_deref() {
        Some("project") => {
            let cwd_str = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?;
            resolve_project_profiles_dir(Path::new(cwd_str))
        }
        Some("global") => {
            resolve_global_profiles_dir()
                .ok_or_else(|| "Could not resolve global profiles directory".to_string())?
        }
        _ => {
            if let Some(cwd_str) = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let proj_dir = resolve_project_profiles_dir(Path::new(cwd_str));
                if proj_dir.join(format!("{}.json", sanitized_name)).is_file() || proj_dir.join(format!("{}.json", trimmed_name)).is_file() {
                    proj_dir
                } else if let Some(g) = resolve_global_profiles_dir() {
                    g
                } else {
                    proj_dir
                }
            } else {
                resolve_global_profiles_dir()
                    .ok_or_else(|| "Could not resolve global profiles directory".to_string())?
            }
        }
    };

    let file_to_delete = if target_dir.join(format!("{}.json", sanitized_name)).is_file() {
        Some(target_dir.join(format!("{}.json", sanitized_name)))
    } else if target_dir.join(format!("{}.json", trimmed_name)).is_file() {
        Some(target_dir.join(format!("{}.json", trimmed_name)))
    } else {
        None
    };

    if let Some(path) = file_to_delete {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete profile file {}: {}", path.display(), e))?;
    } else {
        return Err(format!("Profile '{}' not found in {}", trimmed_name, target_dir.display()));
    }

    // Clear .active if it points to this profile
    let active_file = target_dir.join(".active");
    if let Some(active_name) = read_active_file(&active_file) {
        if sanitize_profile_name(&active_name) == sanitized_name || active_name == trimmed_name {
            let _ = std::fs::remove_file(&active_file);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "message": format!("Profile '{}' deleted successfully", trimmed_name)
    }))
}

/// Pure helper to set or clear active SDD profile for specified directories.
pub fn set_active_sdd_profile_with_dirs(
    target_profiles_dir: &Path,
    target_subagents_file: &Path,
    global_profiles_dir: Option<&Path>,
    name: Option<&str>,
    is_project: bool,
) -> Result<Value, String> {
    let active_path = target_profiles_dir.join(".active");
    let clean_name = name.map(|n| n.trim()).filter(|n| !n.is_empty());

    match clean_name {
        None => {
            if active_path.exists() {
                let _ = std::fs::remove_file(&active_path);
            }

            if is_project {
                let global_active_name = global_profiles_dir
                    .and_then(|d| read_active_file(&d.join(".active")));
                let global_prof = if let Some(ref ga) = global_active_name {
                    global_profiles_dir.and_then(|d| find_profile_by_name(d, ga))
                } else {
                    None
                };

                if let Some(ref gp) = global_prof {
                    apply_profile_to_subagents_file(target_subagents_file, gp)?;
                } else {
                    clear_profile_keys_from_subagents_file(target_subagents_file)?;
                }
            } else {
                clear_profile_keys_from_subagents_file(target_subagents_file)?;
            }

            Ok(serde_json::json!({
                "success": true,
                "message": "Active profile cleared"
            }))
        }
        Some(n) => {
            let mut found_profile = find_profile_by_name(target_profiles_dir, n);

            if found_profile.is_none() && is_project {
                if let Some(g_dir) = global_profiles_dir {
                    found_profile = find_profile_by_name(g_dir, n);
                }
            }

            let prof = match found_profile {
                Some(p) => p,
                None => {
                    return Ok(serde_json::json!({
                        "success": false,
                        "message": format!("Profile '{}' not found", n)
                    }));
                }
            };

            std::fs::create_dir_all(target_profiles_dir)
                .map_err(|e| format!("Failed to create profiles directory: {}", e))?;
            std::fs::write(&active_path, n.as_bytes())
                .map_err(|e| format!("Failed to write .active file: {}", e))?;

            apply_profile_to_subagents_file(target_subagents_file, &prof)?;

            Ok(serde_json::json!({
                "success": true,
                "message": format!("Active profile set to '{}'", n)
            }))
        }
    }
}

/// Tauri command to set or clear the active SDD profile for project or global scope.
#[tauri::command]
pub async fn set_active_sdd_profile(
    cwd: Option<String>,
    scope: Option<String>,
    name: Option<String>,
) -> Result<Value, String> {
    let requested_scope = scope.as_deref().map(|s| s.trim().to_lowercase());
    let (target_profiles_dir, target_subagents_file, is_project) = match requested_scope.as_deref() {
        Some("project") => {
            let cwd_str = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
                .ok_or_else(|| "Project scope requested, but no valid cwd provided".to_string())?;
            let cwd_path = Path::new(cwd_str);
            (resolve_project_profiles_dir(cwd_path), resolve_project_subagents_path(cwd_path), true)
        }
        Some("global") => {
            let p_dir = resolve_global_profiles_dir()
                .ok_or_else(|| "Could not resolve global profiles directory".to_string())?;
            let s_file = resolve_global_subagents_path()
                .ok_or_else(|| "Could not resolve global subagents path".to_string())?;
            (p_dir, s_file, false)
        }
        _ => {
            if let Some(cwd_str) = cwd.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let cwd_path = Path::new(cwd_str);
                (resolve_project_profiles_dir(cwd_path), resolve_project_subagents_path(cwd_path), true)
            } else {
                let p_dir = resolve_global_profiles_dir()
                    .ok_or_else(|| "Could not resolve global profiles directory".to_string())?;
                let s_file = resolve_global_subagents_path()
                    .ok_or_else(|| "Could not resolve global subagents path".to_string())?;
                (p_dir, s_file, false)
            }
        }
    };

    let global_profiles_dir = resolve_global_profiles_dir();
    set_active_sdd_profile_with_dirs(
        &target_profiles_dir,
        &target_subagents_file,
        global_profiles_dir.as_deref(),
        name.as_deref(),
        is_project,
    )
}

// ---------------------------------------------------------------------------
// Gentle Shell Isolated Home Migration
// ---------------------------------------------------------------------------

/// Mode of Gentle Shell home resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GentleShellHomeMode {
    Link,
    Isolated,
    Path,
}

/// Resolved Gentle Shell home directories and resolution mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGentleShellHomes {
    pub main_pi_home: PathBuf,
    pub effective_home: PathBuf,
    pub default_isolated_home: PathBuf,
    pub mode: GentleShellHomeMode,
}

/// Resolves user home directory from USERPROFILE or HOME.
pub fn resolve_user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Pure launcher semantics home resolver for Gentle Shell.
///
/// Precedence:
/// - Main Pi home: `PI_CODING_AGENT_DIR` if set and non-empty, else `<user_home>/.pi/agent`.
/// - Default isolated home: `GENTLE_SHELL_HOME` if set and non-empty, else `<user_home>/.gentle-shell/agent`.
/// - Config file: `<user_home>/.gentle-shell/config.json`.
///   - If `{ "home": "link" }`: mode `Link`, effective home = main Pi home.
///   - If `{ "home": "isolated" }`: mode `Isolated`, effective home = default isolated home.
///   - If `{ "home": "<path>" }`: mode `Path`, effective home = resolved path (relative paths resolve against `base_dir` / workspace cwd).
///   - If missing, invalid JSON, or not an object with string `home`: falls back to default isolated home.
pub fn resolve_gentle_shell_homes_impl<E, F>(
    user_home: Option<&Path>,
    base_dir: Option<&Path>,
    get_env: E,
    read_config: F,
) -> Option<ResolvedGentleShellHomes>
where
    E: Fn(&str) -> Option<String>,
    F: Fn(&Path) -> Option<String>,
{
    let user_home = user_home?;

    let main_pi_home = get_env("PI_CODING_AGENT_DIR")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".pi").join("agent"));

    let default_isolated_home = get_env("GENTLE_SHELL_HOME")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".gentle-shell").join("agent"));

    let config_path = user_home.join(".gentle-shell").join("config.json");
    let launcher_config = read_config(&config_path).and_then(|text| {
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let obj = v.as_object()?;
        let home_val = obj.get("home")?.as_str()?;
        let trimmed = home_val.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let (mode, effective_home) = match launcher_config.as_deref() {
        Some("link") => (GentleShellHomeMode::Link, main_pi_home.clone()),
        Some("isolated") => (GentleShellHomeMode::Isolated, default_isolated_home.clone()),
        Some(custom_path_str) => {
            let custom_path = PathBuf::from(custom_path_str);
            let resolved = if custom_path.is_relative() {
                match base_dir {
                    Some(base) => base.join(&custom_path),
                    None => std::env::current_dir()
                        .unwrap_or_else(|_| user_home.to_path_buf())
                        .join(&custom_path),
                }
            } else {
                custom_path
            };
            (GentleShellHomeMode::Path, resolved)
        }
        None => (GentleShellHomeMode::Isolated, default_isolated_home.clone()),
    };

    Some(ResolvedGentleShellHomes {
        main_pi_home,
        effective_home,
        default_isolated_home,
        mode,
    })
}

/// Resolves Gentle Shell homes using system environment and filesystem.
pub fn resolve_gentle_shell_homes(base_dir: Option<&Path>) -> Option<ResolvedGentleShellHomes> {
    let user_home = resolve_user_home()?;
    resolve_gentle_shell_homes_impl(
        Some(&user_home),
        base_dir,
        |key| std::env::var(key).ok(),
        |path| std::fs::read_to_string(path).ok(),
    )
}

/// Resolves the effective Pi home directory given an optional working directory base.
/// Honors Gentle Shell isolated home configuration and PI_CODING_AGENT_DIR override,
/// falling back to `<user_home>/.pi/agent`.
pub fn resolve_effective_pi_home(base_dir: Option<&Path>) -> PathBuf {
    if let Some(homes) = resolve_gentle_shell_homes(base_dir) {
        homes.effective_home
    } else {
        let user_home = resolve_user_home().unwrap_or_else(|| PathBuf::from("."));
        user_home.join(".pi").join("agent")
    }
}

/// Returns true if migration must be skipped because mode is Link or effective home equals main Pi home.
pub fn should_skip_gentle_shell_migration(homes: &ResolvedGentleShellHomes) -> bool {
    if homes.mode == GentleShellHomeMode::Link {
        return true;
    }
    if homes.effective_home == homes.main_pi_home {
        return true;
    }
    let eff_canon = dunce::canonicalize(&homes.effective_home).ok();
    let main_canon = dunce::canonicalize(&homes.main_pi_home).ok();
    if eff_canon.is_some() && eff_canon == main_canon {
        return true;
    }
    false
}

/// Status of models.json or auth.json file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFileStatus {
    Missing,
    Blank,
    EmptyObject,
    Configured,
    MalformedNonblank,
}

impl ConfigFileStatus {
    /// Returns true if the status counts as unconfigured.
    /// Missing, blank, empty object, or malformed all count as unconfigured.
    pub fn is_unconfigured(self) -> bool {
        matches!(
            self,
            ConfigFileStatus::Missing
                | ConfigFileStatus::Blank
                | ConfigFileStatus::EmptyObject
                | ConfigFileStatus::MalformedNonblank
        )
    }

    /// Returns true if the status is configured data.
    pub fn is_configured(self) -> bool {
        matches!(self, ConfigFileStatus::Configured)
    }

    /// Returns true if non-blank data exists but is malformed/unrecognized.
    pub fn is_protected_malformed(self) -> bool {
        matches!(self, ConfigFileStatus::MalformedNonblank)
    }

    /// Returns true if safe to overwrite (missing, blank, or recognized empty object).
    pub fn can_safely_overwrite(self) -> bool {
        matches!(
            self,
            ConfigFileStatus::Missing | ConfigFileStatus::Blank | ConfigFileStatus::EmptyObject
        )
    }
}

/// Inspects content of models.json.
/// Configured means valid root object with non-empty providers object.
pub fn inspect_models_content_status(content: &str) -> ConfigFileStatus {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return ConfigFileStatus::Blank;
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return ConfigFileStatus::MalformedNonblank,
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return ConfigFileStatus::MalformedNonblank,
    };
    if let Some(providers_val) = obj.get("providers") {
        match providers_val.as_object() {
            Some(p_obj) => {
                if !p_obj.is_empty() {
                    ConfigFileStatus::Configured
                } else if obj.len() == 1 {
                    ConfigFileStatus::EmptyObject
                } else {
                    ConfigFileStatus::MalformedNonblank
                }
            }
            None => ConfigFileStatus::MalformedNonblank,
        }
    } else if obj.is_empty() {
        ConfigFileStatus::EmptyObject
    } else {
        ConfigFileStatus::MalformedNonblank
    }
}

/// Inspects models.json file on disk.
pub fn inspect_models_file_status(path: &Path) -> ConfigFileStatus {
    if !path.exists() {
        return ConfigFileStatus::Missing;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return ConfigFileStatus::MalformedNonblank,
    };
    inspect_models_content_status(&content)
}

/// Inspects content of auth.json.
/// Configured means valid non-empty root object.
pub fn inspect_auth_content_status(content: &str) -> ConfigFileStatus {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return ConfigFileStatus::Blank;
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return ConfigFileStatus::MalformedNonblank,
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return ConfigFileStatus::MalformedNonblank,
    };
    if !obj.is_empty() {
        ConfigFileStatus::Configured
    } else {
        ConfigFileStatus::EmptyObject
    }
}

/// Inspects auth.json file on disk.
pub fn inspect_auth_file_status(path: &Path) -> ConfigFileStatus {
    if !path.exists() {
        return ConfigFileStatus::Missing;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return ConfigFileStatus::MalformedNonblank,
    };
    inspect_auth_content_status(&content)
}

/// Result of migration eligibility inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationInspection {
    pub source_models: ConfigFileStatus,
    pub source_auth: ConfigFileStatus,
    pub dest_models: ConfigFileStatus,
    pub dest_auth: ConfigFileStatus,
    pub copy_models: bool,
    pub copy_auth: bool,
    pub eligible: bool,
    pub skip_reason: Option<String>,
}

/// Inspects source and destination files to determine if migration should be offered.
///
/// Rules:
/// - Prompt only if BOTH isolated models.json and auth.json are unconfigured.
/// - Malformed existing non-blank data in destination must be protected: skip prompt/migration.
/// - Main Pi home must have configured data in at least one source file.
/// - Selectively marks copy_models and copy_auth based on source configured + destination unconfigured.
pub fn check_migration_eligibility(
    main_pi_home: &Path,
    effective_home: &Path,
) -> MigrationInspection {
    let src_models_path = main_pi_home.join("models.json");
    let src_auth_path = main_pi_home.join("auth.json");
    let dest_models_path = effective_home.join("models.json");
    let dest_auth_path = effective_home.join("auth.json");

    let source_models = inspect_models_file_status(&src_models_path);
    let source_auth = inspect_auth_file_status(&src_auth_path);
    let dest_models = inspect_models_file_status(&dest_models_path);
    let dest_auth = inspect_auth_file_status(&dest_auth_path);

    // Prompt only if BOTH are unconfigured in destination
    let both_dest_unconfigured = dest_models.is_unconfigured() && dest_auth.is_unconfigured();
    if !both_dest_unconfigured {
        return MigrationInspection {
            source_models,
            source_auth,
            dest_models,
            dest_auth,
            copy_models: false,
            copy_auth: false,
            eligible: false,
            skip_reason: Some("Destination already has configured models or auth".to_string()),
        };
    }

    // Malformed destination must not be overwritten silently—treat malformed existing nonblank data as protected and skip prompt/migration.
    if dest_models.is_protected_malformed() || dest_auth.is_protected_malformed() {
        return MigrationInspection {
            source_models,
            source_auth,
            dest_models,
            dest_auth,
            copy_models: false,
            copy_auth: false,
            eligible: false,
            skip_reason: Some(
                "Destination contains malformed existing data that is protected from overwrite"
                    .to_string(),
            ),
        };
    }

    // Prompt only if main Pi home has configured data in at least one source file
    let has_configured_source = source_models.is_configured() || source_auth.is_configured();
    if !has_configured_source {
        return MigrationInspection {
            source_models,
            source_auth,
            dest_models,
            dest_auth,
            copy_models: false,
            copy_auth: false,
            eligible: false,
            skip_reason: Some("Source has no configured models or auth to migrate".to_string()),
        };
    }

    // Selective copy: only source files that have configured data and whose destination remains unconfigured
    let copy_models = source_models.is_configured() && dest_models.can_safely_overwrite();
    let copy_auth = source_auth.is_configured() && dest_auth.can_safely_overwrite();

    MigrationInspection {
        source_models,
        source_auth,
        dest_models,
        dest_auth,
        copy_models,
        copy_auth,
        eligible: copy_models || copy_auth,
        skip_reason: None,
    }
}

/// Atomically copies one config file from source to destination using staging and platform-safe rename.
///
/// Validates source configured status and re-checks destination safely overwritable before commit.
/// Applies private 0o600 permissions on Unix when copying auth.json.
pub fn atomic_copy_config_file(
    src_path: &Path,
    dest_path: &Path,
    is_auth: bool,
) -> Result<(), String> {
    if !src_path.exists() {
        return Err(format!("Source file does not exist: {}", src_path.display()));
    }

    let dest_dir = dest_path.parent().ok_or_else(|| {
        format!("Destination path has no parent directory: {}", dest_path.display())
    })?;

    if !dest_dir.exists() {
        std::fs::create_dir_all(dest_dir).map_err(|e| {
            format!("Failed to create destination directory {}: {e}", dest_dir.display())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dest_dir, std::fs::Permissions::from_mode(0o700));
        }
    }

    let data = std::fs::read(src_path).map_err(|e| {
        format!("Failed to read source file {}: {e}", src_path.display())
    })?;

    // Validate that source data is still configured
    if is_auth {
        let text = String::from_utf8_lossy(&data);
        if !inspect_auth_content_status(&text).is_configured() {
            return Err(format!("Source auth file is no longer configured: {}", src_path.display()));
        }
    } else {
        let text = String::from_utf8_lossy(&data);
        if !inspect_models_content_status(&text).is_configured() {
            return Err(format!("Source models file is no longer configured: {}", src_path.display()));
        }
    }

    // Race protection: re-check destination file right before writing
    if dest_path.exists() {
        let current_dest_status = if is_auth {
            inspect_auth_file_status(dest_path)
        } else {
            inspect_models_file_status(dest_path)
        };
        if !current_dest_status.can_safely_overwrite() {
            return Err(format!(
                "Destination file at {} was modified or is not unconfigured; aborting overwrite",
                dest_path.display()
            ));
        }
    }

    let file_name = dest_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");

    let temp_file_path = dest_dir.join(format!(
        ".{}.tmp.{}.{}",
        file_name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    std::fs::write(&temp_file_path, &data).map_err(|e| {
        format!("Failed to write temporary file {}: {e}", temp_file_path.display())
    })?;

    #[cfg(unix)]
    if is_auth {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        if let Err(e) = std::fs::set_permissions(&temp_file_path, perms) {
            let _ = std::fs::remove_file(&temp_file_path);
            return Err(format!(
                "Failed to set private permissions on temporary auth file {}: {e}",
                temp_file_path.display()
            ));
        }
    }

    if let Err(e) = std::fs::rename(&temp_file_path, dest_path) {
        #[cfg(windows)]
        {
            if dest_path.exists() {
                let backup_path = dest_dir.join(format!(
                    ".{}.bak.{}.{}",
                    file_name,
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                if std::fs::rename(dest_path, &backup_path).is_ok() {
                    if std::fs::rename(&temp_file_path, dest_path).is_ok() {
                        let _ = std::fs::remove_file(&backup_path);
                        return Ok(());
                    } else {
                        let _ = std::fs::rename(&backup_path, dest_path);
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&temp_file_path);
        return Err(format!(
            "Failed to atomically commit {} to {}: {e}",
            temp_file_path.display(),
            dest_path.display()
        ));
    }

    Ok(())
}

/// Executes selective migration of configured models.json and auth.json files.
/// Never touches settings.json, sessions, models-store.json, or other files.
pub fn execute_gentle_shell_migration(
    main_pi_home: &Path,
    effective_home: &Path,
    inspection: &MigrationInspection,
) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();

    if inspection.copy_models {
        let src = main_pi_home.join("models.json");
        let dest = effective_home.join("models.json");
        atomic_copy_config_file(&src, &dest, false)?;
        copied.push("models.json".to_string());
    }

    if inspection.copy_auth {
        let src = main_pi_home.join("auth.json");
        let dest = effective_home.join("auth.json");
        atomic_copy_config_file(&src, &dest, true)?;
        copied.push("auth.json".to_string());
    }

    Ok(copied)
}

/// Callback type for mockable dialog confirmation in tests.
pub type MigrationDialogFn = Arc<dyn Fn(&Path, &Path, &[&str]) -> Result<bool, String> + Send + Sync>;

/// Displays native Yes/No confirmation dialog using rfd.
pub fn show_native_migration_dialog(
    main_pi_home: &Path,
    effective_home: &Path,
    files_to_copy: &[&str],
) -> Result<bool, String> {
    // In headless, test, or CI environments, avoid blocking on native GUI dialogs
    if cfg!(test)
        || std::env::var("CI").is_ok()
        || std::env::var("HEADLESS").is_ok()
        || std::env::var("PI_HEADLESS_TEST").is_ok()
    {
        return Ok(false);
    }

    let files_desc = files_to_copy.join(" and ");
    let description = format!(
        "Gentle Shell is configured to use an isolated home directory:\n{}\n\n\
        Your main Pi configuration was found at:\n{}\n\n\
        Would you like to copy your configured {} to the isolated home?\n\n\
        Note: Only models and authentication credentials will be copied. Settings, session history, and cached stores will not be transferred.",
        effective_home.display(),
        main_pi_home.display(),
        files_desc
    );

    let res = rfd::MessageDialog::new()
        .set_title("Gentle Shell Configuration")
        .set_description(&description)
        .set_buttons(rfd::MessageButtons::YesNo)
        .set_level(rfd::MessageLevel::Info)
        .show();

    Ok(res == rfd::MessageDialogResult::Yes)
}

/// Prompts user confirmation via native dialog or mock override.
pub async fn prompt_migration_confirmation(
    main_pi_home: &Path,
    effective_home: &Path,
    files_to_copy: &[&str],
    dialog_override: Option<MigrationDialogFn>,
) -> Result<bool, String> {
    if let Some(mock) = dialog_override {
        return mock(main_pi_home, effective_home, files_to_copy);
    }

    let src = main_pi_home.to_path_buf();
    let dest = effective_home.to_path_buf();
    let files: Vec<String> = files_to_copy.iter().map(|s| s.to_string()).collect();

    tokio::task::spawn_blocking(move || {
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        show_native_migration_dialog(&src, &dest, &file_refs)
    })
    .await
    .map_err(|e| format!("Migration dialog task failed: {e}"))?
}

/// Runs the Gentle Shell migration preflight for a given ResolvedGentleShellHomes.
pub async fn run_gentle_shell_migration_preflight_for_homes(
    homes: &ResolvedGentleShellHomes,
    declined_migrations: &Arc<Mutex<HashSet<PathBuf>>>,
    dialog_override: Option<MigrationDialogFn>,
) -> Result<(), String> {
    if should_skip_gentle_shell_migration(homes) {
        return Ok(());
    }

    let eff_canon = dunce::canonicalize(&homes.effective_home)
        .unwrap_or_else(|_| homes.effective_home.clone());
    {
        let declined = declined_migrations.lock().await;
        if declined.contains(&homes.effective_home) || declined.contains(&eff_canon) {
            return Ok(());
        }
    }

    let inspection = check_migration_eligibility(&homes.main_pi_home, &homes.effective_home);
    if !inspection.eligible {
        return Ok(());
    }

    let mut files_to_copy = Vec::new();
    if inspection.copy_models {
        files_to_copy.push("models.json");
    }
    if inspection.copy_auth {
        files_to_copy.push("auth.json");
    }

    if files_to_copy.is_empty() {
        return Ok(());
    }

    let approved = prompt_migration_confirmation(
        &homes.main_pi_home,
        &homes.effective_home,
        &files_to_copy,
        dialog_override,
    )
    .await?;

    if !approved {
        let mut declined = declined_migrations.lock().await;
        declined.insert(homes.effective_home.clone());
        declined.insert(eff_canon);
        return Ok(());
    }

    execute_gentle_shell_migration(
        &homes.main_pi_home,
        &homes.effective_home,
        &inspection,
    )?;

    Ok(())
}

/// Runs the full Gentle Shell migration preflight before spawning a Gentle Shell subprocess.
pub async fn run_gentle_shell_migration_preflight(
    state: &AppState,
    base_dir: Option<&Path>,
    dialog_override: Option<MigrationDialogFn>,
) -> Result<(), String> {
    let Some(homes) = resolve_gentle_shell_homes(base_dir) else {
        return Ok(());
    };
    run_gentle_shell_migration_preflight_for_homes(
        &homes,
        &state.declined_migrations,
        dialog_override,
    )
    .await
}

/// Resolves the engram binary path, checking ENGRAM_BIN env var, user go/bin directory, and PATH.
pub fn resolve_engram_bin() -> PathBuf {
    if let Ok(bin) = std::env::var("ENGRAM_BIN") {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let local_bin = PathBuf::from(&home)
            .join(".local")
            .join("bin")
            .join(if cfg!(windows) { "engram.exe" } else { "engram" });
        if local_bin.exists() {
            return local_bin;
        }

        let cargo_bin = PathBuf::from(&home)
            .join(".cargo")
            .join("bin")
            .join(if cfg!(windows) { "engram.exe" } else { "engram" });
        if cargo_bin.exists() {
            return cargo_bin;
        }

        let go_bin = PathBuf::from(home)
            .join("go")
            .join("bin")
            .join(if cfg!(windows) { "engram.exe" } else { "engram" });
        if go_bin.exists() {
            return go_bin;
        }
    }

    PathBuf::from("engram")
}

/// Parses the active project name from `engram stats` stdout.
/// Returns None if missing, blank, or "none yet".
pub fn parse_engram_project_from_stats(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        let value_opt = if let Some(rest) = trimmed.strip_prefix("Projects:") {
            Some(rest)
        } else if let Some(rest) = trimmed.strip_prefix("Project:") {
            Some(rest)
        } else {
            None
        };

        if let Some(rest) = value_opt {
            let val = rest.trim();
            if val.is_empty() || val.eq_ignore_ascii_case("none yet") {
                return None;
            }
            return Some(val.to_string());
        }
    }
    None
}

#[derive(Clone, Debug)]
struct EngramProjectCacheEntry {
    project: Option<String>,
    expires: std::time::Instant,
}

#[derive(Clone, Debug)]
struct EngramCloudStatusCacheEntry {
    status: Option<EngramCloudStatus>,
    expires: std::time::Instant,
}

static ENGRAM_PROJECT_CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, EngramProjectCacheEntry>>> = std::sync::OnceLock::new();
static ENGRAM_CLOUD_STATUS_CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, EngramCloudStatusCacheEntry>>> = std::sync::OnceLock::new();

fn engram_project_cache() -> &'static std::sync::Mutex<HashMap<String, EngramProjectCacheEntry>> {
    ENGRAM_PROJECT_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn engram_cloud_status_cache() -> &'static std::sync::Mutex<HashMap<String, EngramCloudStatusCacheEntry>> {
    ENGRAM_CLOUD_STATUS_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn clear_engram_caches_for_test() {
    if let Ok(mut cache) = engram_project_cache().lock() {
        cache.clear();
    }
    if let Ok(mut cache) = engram_cloud_status_cache().lock() {
        cache.clear();
    }
}

/// Implementation of engram project detection for a given working directory.
/// Gracefully returns Ok(None) if engram is not installed, fails, or has no project.
pub async fn get_engram_project_impl(cwd: Option<&str>) -> Result<Option<String>, String> {
    let target_dir = cwd.map(|c| c.trim()).filter(|c| !c.is_empty()).map(Path::new);
    let target_key = target_dir
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();

    let now = std::time::Instant::now();
    {
        if let Ok(cache) = engram_project_cache().lock() {
            if let Some(entry) = cache.get(&target_key) {
                if entry.expires > now {
                    return Ok(entry.project.clone());
                }
            }
        }
    }

    let detected = get_engram_project_detected(target_dir).await?;

    if let Ok(mut cache) = engram_project_cache().lock() {
        cache.insert(
            target_key,
            EngramProjectCacheEntry {
                project: detected.clone(),
                expires: now + std::time::Duration::from_secs(60),
            },
        );
    }

    Ok(detected)
}

async fn get_engram_project_detected(target_dir: Option<&Path>) -> Result<Option<String>, String> {
    // Fast path: check if local .engram/config.json exists
    if let Some(dir) = target_dir {
        let config_path = dir.join(".engram").join("config.json");
        if config_path.is_file() {
            if let Ok(contents) = std::fs::read_to_string(&config_path) {
                if let Ok(json) = serde_json::from_str::<Value>(&contents) {
                    if let Some(name) = json
                        .get("name")
                        .or_else(|| json.get("project"))
                        .and_then(|v| v.as_str())
                    {
                        let trimmed = name.trim();
                        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("none yet") {
                            return Ok(Some(trimmed.to_string()));
                        }
                    }
                }
            }
        }
    }

    // CLI execution path with strict timeout (2.5s)
    let bin = resolve_engram_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("stats");
    if let Some(dir) = target_dir {
        if dir.exists() {
            cmd.current_dir(dir);
        }
    }

    let output_res = tokio::time::timeout(std::time::Duration::from_millis(2500), cmd.output()).await;
    let output = match output_res {
        Ok(Ok(out)) => out,
        _ => return Ok(None), // Not installed, command timed out, or spawn error
    };

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_engram_project_from_stats(&stdout))
}

/// Tauri command to detect the Engram project for a working directory.
#[tauri::command]
pub async fn get_engram_project(cwd: Option<String>) -> Result<Option<String>, String> {
    get_engram_project_impl(cwd.as_deref()).await
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngramCloudStatus {
    pub configured: bool,
    pub server_url: Option<String>,
    pub auth_ready: bool,
    pub enrolled: Option<bool>,
    pub daemon_running: bool,
    pub daemon_port: Option<u16>,
    pub phase: Option<String>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub reason_code: Option<String>,
    pub raw_details: Option<String>,
    pub cloud_permitted: Option<bool>,
    pub cloud_permission_message: Option<String>,
}

/// Parses output lines from `engram cloud status`.
pub fn parse_engram_cloud_status(stdout: &str) -> EngramCloudStatus {
    let mut configured = false;
    let mut server_url = None;
    let mut auth_ready = false;
    let mut enrolled = None;
    let mut daemon_running = false;
    let mut daemon_port = None;
    let mut reason_code = None;
    let mut last_error = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();

        if lower.starts_with("cloud status:") {
            configured = lower.contains("configured") && !lower.contains("not configured");
        } else if trimmed.starts_with("Server:") {
            let rest = trimmed["Server:".len()..].trim();
            if !rest.is_empty() {
                server_url = Some(rest.to_string());
            }
        } else if lower.starts_with("auth status:") {
            auth_ready = lower.contains("ready") && !lower.contains("not ready");
        } else if lower.starts_with("project enrollment:") {
            if lower.contains("not enrolled") {
                enrolled = Some(false);
            } else if lower.contains("enrolled (") {
                enrolled = Some(true);
            }
        } else if lower.starts_with("local daemon:") {
            daemon_running = lower.contains("running") && !lower.contains("not running");
            if let Some(port_idx) = lower.find("port ") {
                let rest = &lower[port_idx + 5..];
                let port_digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(p) = port_digits.parse::<u16>() {
                    daemon_port = Some(p);
                }
            }
        } else if lower.starts_with("reason_code:") {
            let rest = trimmed["reason_code:".len()..].trim();
            if !rest.is_empty() {
                reason_code = Some(rest.to_string());
            }
        } else if lower.starts_with("reason_message:") {
            let rest = trimmed["reason_message:".len()..].trim();
            if !rest.is_empty() {
                last_error = Some(rest.to_string());
            }
        }
    }

    let raw_details = {
        let t = stdout.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    };

    EngramCloudStatus {
        configured,
        server_url,
        auth_ready,
        enrolled,
        daemon_running,
        daemon_port,
        phase: None,
        last_sync_at: None,
        last_error,
        reason_code,
        raw_details,
        cloud_permitted: None,
        cloud_permission_message: None,
    }
}

/// Evaluates output of `engram sync --cloud --status --project <proj>` and updates cloud permission status.
pub fn apply_cloud_sync_permission_result(
    status: &mut EngramCloudStatus,
    cmd_result: Result<(bool, &str, &str), ()>,
) {
    match cmd_result {
        Ok((success, stdout, stderr)) => {
            let combined = format!("{}\n{}", stdout, stderr);
            let combined_lower = combined.to_lowercase();

            if combined_lower.contains("403")
                || combined_lower.contains("forbidden")
                || combined_lower.contains("not allowed")
                || combined_lower.contains("policy_forbidden")
            {
                status.cloud_permitted = Some(false);
                status.reason_code = Some("policy_forbidden".to_string());
                status.cloud_permission_message = Some(
                    "Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.".to_string(),
                );
                if status.last_error.is_none() {
                    let desc = if !stderr.trim().is_empty() {
                        stderr.trim()
                    } else {
                        stdout.trim()
                    };
                    if !desc.is_empty() {
                        status.last_error = Some(desc.to_string());
                    }
                }
            } else if combined_lower.contains("401") || combined_lower.contains("auth_required") {
                status.cloud_permitted = Some(false);
                status.cloud_permission_message =
                    Some("Autenticación requerida por el servidor (401)".to_string());
            } else if success || combined_lower.contains("cloud sync status") {
                status.cloud_permitted = Some(true);
                status.cloud_permission_message =
                    Some("Sincronización permitida en el servidor".to_string());
            } else {
                status.cloud_permitted = None;
                status.cloud_permission_message = Some(
                    "No se pudo verificar permisos en el servidor Cloud (tiempo de espera agotado)".to_string(),
                );
            }
        }
        Err(_) => {
            status.cloud_permitted = None;
            status.cloud_permission_message = Some(
                "No se pudo verificar permisos en el servidor Cloud (tiempo de espera agotado)".to_string(),
            );
        }
    }
}

/// Implementation of engram cloud status check.
/// Runs `engram cloud status [--project <name>]` with 3.5s timeout.
/// When enrolled, executes a remote check using `engram sync --cloud --status --project <proj>` with a 4s timeout.
/// Returns Ok(None) if engram is not installed or command fails.
pub async fn get_engram_cloud_status_impl(
    project: Option<&str>,
    cwd: Option<&str>,
) -> Result<Option<EngramCloudStatus>, String> {
    let cache_key = format!("{}_{}", project.unwrap_or(""), cwd.unwrap_or(""));
    let now = std::time::Instant::now();
    {
        if let Ok(cache) = engram_cloud_status_cache().lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if entry.expires > now {
                    return Ok(entry.status.clone());
                }
            }
        }
    }

    let status_opt = get_engram_cloud_status_detected(project, cwd).await?;

    let ttl = if status_opt.is_some() {
        std::time::Duration::from_secs(20)
    } else {
        std::time::Duration::from_secs(10)
    };

    if let Ok(mut cache) = engram_cloud_status_cache().lock() {
        cache.insert(
            cache_key,
            EngramCloudStatusCacheEntry {
                status: status_opt.clone(),
                expires: now + ttl,
            },
        );
    }

    Ok(status_opt)
}

async fn get_engram_cloud_status_detected(
    project: Option<&str>,
    cwd: Option<&str>,
) -> Result<Option<EngramCloudStatus>, String> {
    let bin = resolve_engram_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("cloud");
    cmd.arg("status");
    if let Some(proj) = project.map(|p| p.trim()).filter(|p| !p.is_empty()) {
        cmd.arg("--project");
        cmd.arg(proj);
    }
    let target_dir = cwd.map(|c| c.trim()).filter(|c| !c.is_empty()).map(Path::new);
    if let Some(dir) = target_dir {
        if dir.exists() {
            cmd.current_dir(dir);
        }
    }

    let output_res = tokio::time::timeout(std::time::Duration::from_millis(3500), cmd.output()).await;
    let output = match output_res {
        Ok(Ok(out)) => out,
        _ => return Ok(None),
    };

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(None);
    }

    let mut status = parse_engram_cloud_status(&stdout);

    if status.configured && status.enrolled == Some(true) {
        let proj_name = project
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| p.to_string())
            .or_else(|| {
                for line in stdout.lines() {
                    let lower = line.trim().to_lowercase();
                    if lower.starts_with("project enrollment:") {
                        if let Some(open) = line.find('(') {
                            if let Some(close) = line[open + 1..].find(')') {
                                let name = line[open + 1..open + 1 + close].trim();
                                if !name.is_empty() {
                                    return Some(name.to_string());
                                }
                            }
                        }
                    }
                }
                None
            });

        let mut sync_cmd = tokio::process::Command::new(&bin);
        sync_cmd.arg("sync");
        sync_cmd.arg("--cloud");
        sync_cmd.arg("--status");
        if let Some(ref p) = proj_name {
            sync_cmd.arg("--project");
            sync_cmd.arg(p);
        }
        if let Some(dir) = target_dir {
            if dir.exists() {
                sync_cmd.current_dir(dir);
            }
        }

        let sync_res = tokio::time::timeout(std::time::Duration::from_millis(4000), sync_cmd.output()).await;
        match sync_res {
            Ok(Ok(sync_out)) => {
                let out_str = String::from_utf8_lossy(&sync_out.stdout);
                let err_str = String::from_utf8_lossy(&sync_out.stderr);
                apply_cloud_sync_permission_result(
                    &mut status,
                    Ok((sync_out.status.success(), &out_str, &err_str)),
                );
            }
            _ => {
                apply_cloud_sync_permission_result(&mut status, Err(()));
            }
        }
    }

    Ok(Some(status))
}

/// Tauri command to get the Engram cloud status for a project or working directory.
#[tauri::command]
pub async fn get_engram_cloud_status(
    project: Option<String>,
    cwd: Option<String>,
) -> Result<Option<EngramCloudStatus>, String> {
    get_engram_cloud_status_impl(project.as_deref(), cwd.as_deref()).await
}

/// Implementation of engram cloud project enrollment.
/// Runs `engram cloud enroll <project>` with 5s timeout.
/// Returns Ok(true) if the command executes and succeeds.
/// Returns Err(...) if the command fails, times out, or project is blank.
pub async fn enroll_engram_project_impl(project: &str, cwd: Option<&str>) -> Result<bool, String> {
    let trimmed = project.trim();
    if trimmed.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }

    let bin = resolve_engram_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("cloud");
    cmd.arg("enroll");
    cmd.arg(trimmed);

    let target_dir = cwd.map(|c| c.trim()).filter(|c| !c.is_empty()).map(Path::new);
    if let Some(dir) = target_dir {
        if dir.exists() {
            cmd.current_dir(dir);
        }
    }

    let output_res = tokio::time::timeout(std::time::Duration::from_millis(5000), cmd.output()).await;
    let output = match output_res {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("Failed to execute engram command: {}", e)),
        Err(_) => return Err("Timeout enrolling project in Engram Cloud".to_string()),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "Command exited with non-zero status"
        };
        return Err(format!("Enroll failed: {}", msg));
    }

    Ok(true)
}

/// Tauri command to enroll a project in Engram Cloud.
#[tauri::command]
pub async fn enroll_engram_project(
    project: String,
    cwd: Option<String>,
) -> Result<bool, String> {
    enroll_engram_project_impl(&project, cwd.as_deref()).await
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_models_config_path() {
        let path_opt = resolve_models_config_path();
        assert!(path_opt.is_some());
        let path = path_opt.unwrap();
        let path_str = path.to_string_lossy();
        assert!(path_str.ends_with("models.json"));
        assert!(path_str.contains(".pi"));
        assert!(path_str.contains("agent"));
    }

    #[test]
    fn test_get_custom_providers_missing_and_empty_file() {
        let temp_dir = std::env::temp_dir().join(format!("test_models_missing_{}", std::process::id()));
        let missing_path = temp_dir.join("nonexistent_models.json");

        let res = get_custom_providers_impl(&missing_path).unwrap();
        assert!(res.is_object());
        assert!(res.get("providers").is_some());
        assert_eq!(res["providers"].as_object().unwrap().len(), 0);

        // Empty file
        std::fs::create_dir_all(&temp_dir).unwrap();
        let empty_path = temp_dir.join("empty_models.json");
        std::fs::write(&empty_path, "   \n").unwrap();
        let empty_res = get_custom_providers_impl(&empty_path).unwrap();
        assert!(empty_res.is_object());
        assert!(empty_res.get("providers").is_some());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_custom_providers_validation() {
        let temp_dir = std::env::temp_dir().join(format!("test_models_val_{}", std::process::id()));
        let config_path = temp_dir.join("models.json");

        // Reject non-object
        let err_non_obj = save_custom_providers_impl(&config_path, &Value::String("invalid".into()));
        assert!(err_non_obj.is_err());

        // Reject invalid provider ID
        let bad_id = serde_json::json!({
            "providers": {
                "invalid id with spaces": {
                    "baseUrl": "http://localhost:11434/v1",
                    "api": "openai-completions"
                }
            }
        });
        let err_bad_id = save_custom_providers_impl(&config_path, &bad_id);
        assert!(err_bad_id.is_err());
        assert!(err_bad_id.unwrap_err().contains("contains invalid characters"));

        // Reject empty baseUrl
        let empty_url = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "   ",
                    "api": "openai-completions"
                }
            }
        });
        let err_url = save_custom_providers_impl(&config_path, &empty_url);
        assert!(err_url.is_err());
        assert!(err_url.unwrap_err().contains("baseUrl must not be empty"));

        // Reject non-http baseUrl
        let bad_proto = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "ftp://localhost:11434",
                    "api": "openai-completions"
                }
            }
        });
        let err_proto = save_custom_providers_impl(&config_path, &bad_proto);
        assert!(err_proto.is_err());
        assert!(err_proto.unwrap_err().contains("must start with http:// or https://"));

        // Reject missing model id
        let missing_m_id = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "http://localhost:11434/v1",
                    "api": "openai-completions",
                    "models": [
                        { "name": "No ID" }
                    ]
                }
            }
        });
        let err_m_id = save_custom_providers_impl(&config_path, &missing_m_id);
        assert!(err_m_id.is_err());
        assert!(err_m_id.unwrap_err().contains("missing required 'id'"));

        // Reject non-array excludedModels
        let bad_excluded = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "http://localhost:11434/v1",
                    "api": "openai-completions",
                    "excludedModels": "not-an-array"
                }
            }
        });
        let err_excluded = save_custom_providers_impl(&config_path, &bad_excluded);
        assert!(err_excluded.is_err());
        assert!(err_excluded.unwrap_err().contains("excludedModels"));

        // Reject non-array includedModels
        let bad_included = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "http://localhost:11434/v1",
                    "api": "openai-completions",
                    "includedModels": "not-an-array"
                }
            }
        });
        let err_included = save_custom_providers_impl(&config_path, &bad_included);
        assert!(err_included.is_err());
        assert!(err_included.unwrap_err().contains("includedModels"));
    }

    #[test]
    fn test_save_custom_providers_preserves_other_keys_and_roundtrips() {
        let temp_dir = std::env::temp_dir().join(format!("test_models_roundtrip_{}", std::process::id()));
        let config_path = temp_dir.join("models.json");

        // Seed existing file with top-level key like modelOverrides
        std::fs::create_dir_all(&temp_dir).unwrap();
        let initial_json = serde_json::json!({
            "modelOverrides": {
                "existing/model": { "contextWindow": 64000 }
            },
            "providers": {
                "initial": {
                    "baseUrl": "https://api.initial.com/v1",
                    "api": "openai-completions"
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        // Save updated providers
        let update_json = serde_json::json!({
            "ollama": {
                "name": "Ollama Local",
                "baseUrl": "http://localhost:11434/v1",
                "api": "openai-completions",
                "excludedModels": ["dall-e*", "whisper-1"],
                "includedModels": ["claude-3-5*", "gpt-4o"],
                "models": [
                    {
                        "id": "llama3.1:8b",
                        "name": "Llama 3.1 8B",
                        "contextWindow": 128000,
                        "reasoning": false
                    }
                ]
            }
        });

        let saved = save_custom_providers_impl(&config_path, &update_json).unwrap();
        assert!(saved.get("modelOverrides").is_some());
        assert!(saved.get("providers").is_some());
        assert!(saved["providers"].get("ollama").is_some());

        // Read back using get_custom_providers_impl
        let reloaded = get_custom_providers_impl(&config_path).unwrap();
        assert_eq!(reloaded["providers"]["ollama"]["name"], "Ollama Local");
        assert_eq!(reloaded["providers"]["ollama"]["baseUrl"], "http://localhost:11434/v1");
        assert_eq!(reloaded["providers"]["ollama"]["models"][0]["id"], "llama3.1:8b");
        assert_eq!(reloaded["providers"]["ollama"]["excludedModels"][0], "dall-e*");
        assert_eq!(reloaded["providers"]["ollama"]["excludedModels"][1], "whisper-1");
        assert_eq!(reloaded["providers"]["ollama"]["includedModels"][0], "claude-3-5*");
        assert_eq!(reloaded["providers"]["ollama"]["includedModels"][1], "gpt-4o");
        assert!(reloaded.get("modelOverrides").is_some());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_additive_sync_preserves_unrelated_keys_and_providers() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_additive_preserves_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let gs_custom_home = temp_dir.join("gs_custom_home");
        let mock_user_home = temp_dir.join("user_home");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&gs_custom_home).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        // 1. Seed main Pi models.json with external root keys, unrelated provider, and unknown fields
        let main_path = main_pi_dir.join("models.json");
        let main_seed = serde_json::json!({
            "externalRootKey": "keep_main",
            "telemetry": false,
            "providers": {
                "unrelated_main": {
                    "baseUrl": "https://api.main.com/v1",
                    "api": "openai-completions"
                },
                "target_prov": {
                    "baseUrl": "https://api.old.com/v1",
                    "api": "openai-completions",
                    "unknownProviderProp": 999,
                    "models": [
                        {
                            "id": "m1",
                            "name": "Old M1",
                            "unknownModelProp": "m1_prop"
                        },
                        {
                            "id": "m_unmatched",
                            "name": "Unmatched Model",
                            "preservedKey": true
                        }
                    ]
                }
            }
        });
        std::fs::write(&main_path, serde_json::to_string_pretty(&main_seed).unwrap()).unwrap();

        // 2. Seed Gentle Shell models.json with its own root keys, existing target provider with distinct unknown properties and external models
        let gs_models_path = gs_custom_home.join("models.json");
        let gs_seed = serde_json::json!({
            "externalGsKey": "keep_gs",
            "providers": {
                "unrelated_gs": {
                    "baseUrl": "https://api.gs.com/v1",
                    "api": "openai-completions"
                },
                "target_prov": {
                    "baseUrl": "https://api.gs-initial.com/v1",
                    "api": "openai-completions",
                    "gsCustomProp": "do-not-remove",
                    "models": [
                        {
                            "id": "gs_model_only",
                            "name": "GS Model Only",
                            "gsModelProp": 777
                        }
                    ]
                }
            }
        });
        std::fs::write(&gs_models_path, serde_json::to_string_pretty(&gs_seed).unwrap()).unwrap();

        // 3. Configure ~/.gentle-shell/config.json with absolute path to gs_custom_home
        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        let gs_config = serde_json::json!({
            "home": gs_custom_home.to_string_lossy().to_string()
        });
        std::fs::write(&config_json_path, serde_json::to_string_pretty(&gs_config).unwrap()).unwrap();

        // 4. Upsert target_prov
        let update_payload = serde_json::json!({
            "baseUrl": "https://api.new.com/v1",
            "api": "openai-completions",
            "models": [
                {
                    "id": "m1",
                    "name": "New M1",
                    "maxTokens": 4096
                },
                {
                    "id": "m2",
                    "name": "New M2"
                }
            ]
        });

        let saved = upsert_custom_provider_impl(
            &main_path,
            "target_prov",
            &update_payload,
            Some(&mock_user_home),
            None,
        ).unwrap();

        // Verify main Pi file:
        assert_eq!(saved["externalRootKey"], "keep_main");
        assert_eq!(saved["telemetry"], false);
        assert!(saved["providers"].get("unrelated_main").is_some());
        let target = &saved["providers"]["target_prov"];
        assert_eq!(target["baseUrl"], "https://api.new.com/v1");
        assert_eq!(target["unknownProviderProp"], 999); // Preserved unknown provider field!
        assert_eq!(target["models"][0]["id"], "m1");
        assert_eq!(target["models"][0]["name"], "New M1");
        assert_eq!(target["models"][0]["maxTokens"], 4096);
        assert_eq!(target["models"][0]["unknownModelProp"], "m1_prop"); // Preserved unknown model field!
        assert_eq!(target["models"][1]["id"], "m2");
        // Unmatched existing model m_unmatched is preserved!
        assert_eq!(target["models"][2]["id"], "m_unmatched");
        assert_eq!(target["models"][2]["name"], "Unmatched Model");
        assert_eq!(target["models"][2]["preservedKey"], true);

        // Verify Gentle Shell file was additively updated:
        let gs_reloaded: Value = serde_json::from_str(&std::fs::read_to_string(&gs_models_path).unwrap()).unwrap();
        assert_eq!(gs_reloaded["externalGsKey"], "keep_gs");
        assert!(gs_reloaded["providers"].get("unrelated_gs").is_some());
        assert!(gs_reloaded["providers"].get("target_prov").is_some());
        let gs_target = &gs_reloaded["providers"]["target_prov"];
        assert_eq!(gs_target["baseUrl"], "https://api.new.com/v1");
        // Gentle Shell unknown provider property is preserved!
        assert_eq!(gs_target["gsCustomProp"], "do-not-remove");
        // Gentle Shell models: m1 and m2 included, and existing gs_model_only preserved!
        assert_eq!(gs_target["models"][0]["id"], "m1");
        assert_eq!(gs_target["models"][1]["id"], "m2");
        assert_eq!(gs_target["models"][2]["id"], "gs_model_only");
        assert_eq!(gs_target["models"][2]["gsModelProp"], 777);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_additive_sync_fails_closed_on_malformed_files() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_malformed_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let gs_custom_home = temp_dir.join("gs_custom_home");
        let mock_user_home = temp_dir.join("user_home");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&gs_custom_home).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        let update_payload = serde_json::json!({
            "baseUrl": "https://api.new.com/v1",
            "api": "openai-completions",
            "models": [{ "id": "m1" }]
        });

        // 1. Malformed main models.json fails closed and leaves file untouched
        let main_path = main_pi_dir.join("models.json");
        let malformed_main_bytes = "{ not valid json at all ...";
        std::fs::write(&main_path, malformed_main_bytes).unwrap();

        let err1 = upsert_custom_provider_impl(
            &main_path,
            "target",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(err1.is_err());
        assert_eq!(std::fs::read_to_string(&main_path).unwrap(), malformed_main_bytes);

        // 2. Malformed Gentle Shell models.json fails closed before any writes
        let valid_main_bytes = r#"{"providers": {"existing": {"baseUrl": "http://ok.com", "api": "openai-completions"}}}"#;
        std::fs::write(&main_path, valid_main_bytes).unwrap();

        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": gs_custom_home.to_string_lossy().to_string() }).to_string(),
        ).unwrap();

        let gs_models_path = gs_custom_home.join("models.json");
        let malformed_gs_bytes = "{ corrupt gentle shell json ...";
        std::fs::write(&gs_models_path, malformed_gs_bytes).unwrap();

        let err2 = upsert_custom_provider_impl(
            &main_path,
            "target",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(err2.is_err());
        assert_eq!(std::fs::read_to_string(&gs_models_path).unwrap(), malformed_gs_bytes);
        assert_eq!(std::fs::read_to_string(&main_path).unwrap(), valid_main_bytes);

        // 3. Root is array fails closed
        std::fs::write(&main_path, "[1, 2, 3]").unwrap();
        let err3 = upsert_custom_provider_impl(
            &main_path,
            "target",
            &update_payload,
            None,
            None,
        );
        assert!(err3.is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_additive_sync_custom_path_presence_and_absence() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_path_presence_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");
        let workspace_dir = temp_dir.join("workspace");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        let main_path = main_pi_dir.join("models.json");
        let update_payload = serde_json::json!({
            "baseUrl": "https://api.test.com/v1",
            "api": "openai-completions",
            "models": [{ "id": "m1" }]
        });

        // 1. Configured custom path does NOT exist on disk: succeeds on main Pi, does NOT create custom home!
        let nonexistent_custom_home = temp_dir.join("nonexistent_custom_home");
        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": nonexistent_custom_home.to_string_lossy().to_string() }).to_string(),
        ).unwrap();

        let res = upsert_custom_provider_impl(
            &main_path,
            "prov1",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res.is_ok());
        assert!(!nonexistent_custom_home.exists()); // Must not create unsolicited home!

        // 2. Mode "link" skips duplicate main home even if default isolated directory exists
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": "link" }).to_string(),
        ).unwrap();
        let default_iso = mock_user_home.join(".gentle-shell").join("agent");
        std::fs::create_dir_all(&default_iso).unwrap();
        let res_link = upsert_custom_provider_impl(
            &main_path,
            "prov_link",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res_link.is_ok());
        // Link skips duplicate main home: does NOT create models.json in default_iso
        assert!(!default_iso.join("models.json").exists());
        let _ = std::fs::remove_dir_all(&default_iso);

        // 3. Mode "isolated" when directory does not exist: does NOT create unsolicited directory
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": "isolated" }).to_string(),
        ).unwrap();
        let res_iso_absent = upsert_custom_provider_impl(
            &main_path,
            "prov1",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res_iso_absent.is_ok());
        assert!(!default_iso.exists()); // Isolated home is not created if absent

        // 4. Relative custom path with valid workspace cwd: resolves against workspace cwd and updates
        let rel_custom_home = workspace_dir.join("rel_agent_home");
        std::fs::create_dir_all(&rel_custom_home).unwrap();
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": "rel_agent_home" }).to_string(),
        ).unwrap();

        let res_rel = upsert_custom_provider_impl(
            &main_path,
            "prov_rel",
            &update_payload,
            Some(&mock_user_home),
            Some(&workspace_dir),
        );
        assert!(res_rel.is_ok());
        assert!(rel_custom_home.join("models.json").exists());

        // 5. Relative custom path without valid workspace cwd: fails closed with actionable error rather than silently skipping
        let res_no_cwd = upsert_custom_provider_impl(
            &main_path,
            "prov_no_cwd",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res_no_cwd.is_err());
        assert!(res_no_cwd.unwrap_err().contains("relative custom home"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_additive_sync_offline_behavior() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_offline_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let gs_custom_home = temp_dir.join("gs_custom_home");
        let mock_user_home = temp_dir.join("user_home");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&gs_custom_home).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        let main_path = main_pi_dir.join("models.json");
        let gs_models_path = gs_custom_home.join("models.json");

        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": gs_custom_home.to_string_lossy().to_string() }).to_string(),
        ).unwrap();

        let update_payload = serde_json::json!({
            "baseUrl": "https://api.offline.com/v1",
            "api": "openai-completions",
            "models": [{ "id": "offline-model" }]
        });

        // Even though no Gentle Shell process is running (offline), upsert propagates to disk
        let res = upsert_custom_provider_impl(
            &main_path,
            "offline_prov",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res.is_ok());
        assert!(gs_models_path.exists());

        let gs_content: Value = serde_json::from_str(&std::fs::read_to_string(&gs_models_path).unwrap()).unwrap();
        assert_eq!(gs_content["providers"]["offline_prov"]["baseUrl"], "https://api.offline.com/v1");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_delete_provider_targets_main_only_and_preserves_gentle_shell() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_delete_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let gs_custom_home = temp_dir.join("gs_custom_home");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&gs_custom_home).unwrap();

        // 1. Seed main Pi models.json
        let main_path = main_pi_dir.join("models.json");
        let main_seed = serde_json::json!({
            "rootMeta": "preserve_main",
            "providers": {
                "to_delete": {
                    "baseUrl": "https://api.delete.com/v1",
                    "api": "openai-completions"
                },
                "to_keep": {
                    "baseUrl": "https://api.keep.com/v1",
                    "api": "openai-completions"
                }
            }
        });
        std::fs::write(&main_path, serde_json::to_string_pretty(&main_seed).unwrap()).unwrap();

        // 2. Seed Gentle Shell models.json with to_delete and its own root keys
        let gs_models_path = gs_custom_home.join("models.json");
        let gs_seed = serde_json::json!({
            "gsRoot": true,
            "providers": {
                "to_delete": {
                    "baseUrl": "https://api.delete.com/v1",
                    "api": "openai-completions"
                }
            }
        });
        std::fs::write(&gs_models_path, serde_json::to_string_pretty(&gs_seed).unwrap()).unwrap();

        // 3. Delete to_delete
        let res = delete_custom_provider_impl(&main_path, "to_delete").unwrap();

        // Verify main Pi: to_delete is removed, to_keep and rootMeta preserved
        assert_eq!(res["rootMeta"], "preserve_main");
        assert!(res["providers"].get("to_delete").is_none());
        assert!(res["providers"].get("to_keep").is_some());

        // Verify Gentle Shell: to_delete is STILL PRESENT, Gentle Shell untouched!
        let gs_reloaded: Value = serde_json::from_str(&std::fs::read_to_string(&gs_models_path).unwrap()).unwrap();
        assert_eq!(gs_reloaded["gsRoot"], true);
        assert!(gs_reloaded["providers"].get("to_delete").is_some());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_additive_sync_same_home_skips_duplicate_target() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_same_home_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        let main_path = main_pi_dir.join("models.json");
        let initial_seed = serde_json::json!({
            "rootKey": "original_value",
            "providers": {
                "p_existing": {
                    "baseUrl": "https://api.existing.com/v1",
                    "api": "openai-completions",
                    "models": [{ "id": "m_init" }]
                }
            }
        });
        std::fs::write(&main_path, serde_json::to_string_pretty(&initial_seed).unwrap()).unwrap();

        // 1. Configure Gentle Shell with exact same path as main Pi directory
        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": main_pi_dir.to_string_lossy().to_string() }).to_string(),
        ).unwrap();

        assert!(is_same_config_target(&main_path, &main_pi_dir));

        let update_payload = serde_json::json!({
            "baseUrl": "https://api.new.com/v1",
            "api": "openai-completions",
            "models": [{ "id": "m_new" }]
        });

        // 2. Upsert provider into main Pi: must skip duplicate Gentle Shell write and succeed
        let res = upsert_custom_provider_impl(
            &main_path,
            "p_new",
            &update_payload,
            Some(&mock_user_home),
            None,
        ).unwrap();

        assert_eq!(res["rootKey"], "original_value");
        assert!(res["providers"].get("p_existing").is_some());
        assert!(res["providers"].get("p_new").is_some());

        // Verify file on disk is written accurately without rollback or duplicate write conflict
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&main_path).unwrap()).unwrap();
        assert_eq!(on_disk["rootKey"], "original_value");
        assert!(on_disk["providers"].get("p_existing").is_some());
        assert!(on_disk["providers"].get("p_new").is_some());

        // 3. Test canonical equivalence via relative dot-segments
        let sub_dir = main_pi_dir.join("sub");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let same_via_dotdot = main_pi_dir.join("sub").join("..");
        assert!(is_same_config_target(&main_path, &same_via_dotdot));

        // 4. propagate_provider_upsert_to_gentle_shell skips duplicate target
        let mock_pi_user_home = temp_dir.join("user_home_pi");
        let mock_pi_agent_dir = mock_pi_user_home.join(".pi").join("agent");
        std::fs::create_dir_all(&mock_pi_agent_dir).unwrap();
        std::fs::create_dir_all(mock_pi_user_home.join(".gentle-shell")).unwrap();

        let gs_cfg = mock_pi_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(
            &gs_cfg,
            serde_json::json!({ "home": mock_pi_agent_dir.to_string_lossy().to_string() }).to_string(),
        ).unwrap();

        let target_obj = update_payload.as_object().unwrap();
        let propagated = propagate_provider_upsert_to_gentle_shell(
            Some(&mock_pi_user_home),
            None,
            "p_new",
            target_obj,
        ).unwrap();
        // Since custom_home == ~/.pi/agent, it must skip duplicate target and return Ok(false)
        assert!(!propagated);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_sync_target_no_config_existing_default() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_sync_no_config_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");
        let default_iso_home = mock_user_home.join(".gentle-shell").join("agent");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&default_iso_home).unwrap();

        // 1. Seed existing Gentle Shell models.json in default isolated home
        let gs_models_path = default_iso_home.join("models.json");
        let gs_seed = serde_json::json!({
            "providers": {
                "existing_prov": {
                    "baseUrl": "https://api.existing.com/v1",
                    "api": "openai-completions"
                }
            }
        });
        std::fs::write(&gs_models_path, serde_json::to_string_pretty(&gs_seed).unwrap()).unwrap();

        // Main Pi file
        let main_path = main_pi_dir.join("models.json");
        let main_seed = serde_json::json!({
            "providers": {}
        });
        std::fs::write(&main_path, serde_json::to_string_pretty(&main_seed).unwrap()).unwrap();

        // Notice: ~/.gentle-shell/config.json is absent! (Host regression case)
        let resolved = resolve_gentle_shell_sync_target_impl(
            Some(&mock_user_home),
            None,
            |_| None,
            |_| None,
        ).unwrap();
        assert_eq!(resolved, Some(default_iso_home.clone()));

        // GENTLE_SHELL_HOME launcher semantics override
        let custom_launcher_home = PathBuf::from("/custom/launcher/agent");
        let resolved_env = resolve_gentle_shell_sync_target_impl(
            Some(&mock_user_home),
            None,
            |k| if k == "GENTLE_SHELL_HOME" { Some("/custom/launcher/agent".to_string()) } else { None },
            |_| None,
        ).unwrap();
        assert_eq!(resolved_env, Some(custom_launcher_home));

        // 2. Upsert provider into main Pi: must propagate to existing default isolated home!
        let update_payload = serde_json::json!({
            "baseUrl": "https://api.new.com/v1",
            "api": "openai-completions",
            "models": [{ "id": "m_new" }]
        });

        let res = upsert_custom_provider_impl(
            &main_path,
            "new_prov",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res.is_ok());

        // Verify Gentle Shell default isolated home has both existing_prov and new_prov
        let gs_reloaded: Value = serde_json::from_str(&std::fs::read_to_string(&gs_models_path).unwrap()).unwrap();
        assert!(gs_reloaded["providers"].get("existing_prov").is_some());
        assert!(gs_reloaded["providers"].get("new_prov").is_some());
        assert_eq!(gs_reloaded["providers"]["new_prov"]["baseUrl"], "https://api.new.com/v1");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_sync_target_explicit_isolated_existing_default() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_sync_isolated_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");
        let default_iso_home = mock_user_home.join(".gentle-shell").join("agent");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&default_iso_home).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        // 1. Explicit { "home": "isolated" } in config.json
        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(
            &config_json_path,
            serde_json::json!({ "home": "isolated" }).to_string(),
        ).unwrap();

        let gs_models_path = default_iso_home.join("models.json");
        let gs_seed = serde_json::json!({
            "providers": {
                "iso_existing": {
                    "baseUrl": "https://api.iso.com/v1",
                    "api": "openai-completions"
                }
            }
        });
        std::fs::write(&gs_models_path, serde_json::to_string_pretty(&gs_seed).unwrap()).unwrap();

        let main_path = main_pi_dir.join("models.json");
        std::fs::write(&main_path, r#"{"providers":{}}"#).unwrap();

        // Resolver check (including case-insensitivity)
        let resolved_lower = resolve_gentle_shell_sync_target_impl(
            Some(&mock_user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "isolated"}"#.to_string()),
        ).unwrap();
        assert_eq!(resolved_lower, Some(default_iso_home.clone()));

        let resolved_upper = resolve_gentle_shell_sync_target_impl(
            Some(&mock_user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "ISOLATED"}"#.to_string()),
        ).unwrap();
        assert_eq!(resolved_upper, Some(default_iso_home.clone()));

        // Upsert propagates to existing default isolated home
        let update_payload = serde_json::json!({
            "baseUrl": "https://api.added.com/v1",
            "api": "openai-completions"
        });

        let res = upsert_custom_provider_impl(
            &main_path,
            "iso_new",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res.is_ok());

        let gs_reloaded: Value = serde_json::from_str(&std::fs::read_to_string(&gs_models_path).unwrap()).unwrap();
        assert!(gs_reloaded["providers"].get("iso_existing").is_some());
        assert!(gs_reloaded["providers"].get("iso_new").is_some());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_sync_target_absent_directory_no_creation() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_sync_absent_dir_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");
        let default_iso_home = mock_user_home.join(".gentle-shell").join("agent");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        // default_iso_home is NOT created on disk
        assert!(!default_iso_home.exists());

        let main_path = main_pi_dir.join("models.json");
        std::fs::write(&main_path, r#"{"providers":{}}"#).unwrap();

        let update_payload = serde_json::json!({
            "baseUrl": "https://api.test.com/v1",
            "api": "openai-completions"
        });

        // 1. Absent config: succeeds on main Pi, does NOT create ~/.gentle-shell/agent
        let res_no_cfg = upsert_custom_provider_impl(
            &main_path,
            "prov_test",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res_no_cfg.is_ok());
        assert!(!default_iso_home.exists());

        // 2. Explicit isolated in config: succeeds on main Pi, does NOT create ~/.gentle-shell/agent
        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(&config_json_path, r#"{"home": "isolated"}"#).unwrap();

        let res_iso = upsert_custom_provider_impl(
            &main_path,
            "prov_test2",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res_iso.is_ok());
        assert!(!default_iso_home.exists());

        // 3. propagate_provider_upsert_to_gentle_shell returns Ok(false) and does not create directory
        let prov_obj = update_payload.as_object().unwrap();
        let prop_res = propagate_provider_upsert_to_gentle_shell(
            Some(&mock_user_home),
            None,
            "prov_test3",
            prov_obj,
        );
        assert_eq!(prop_res, Ok(false));
        assert!(!default_iso_home.exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_sync_target_link_skip() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_sync_link_skip_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");
        let default_iso_home = mock_user_home.join(".gentle-shell").join("agent");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&default_iso_home).unwrap();
        std::fs::create_dir_all(mock_user_home.join(".gentle-shell")).unwrap();

        // Seed default isolated home models.json
        let gs_models_path = default_iso_home.join("models.json");
        let original_gs_content = r#"{"providers":{"gs_orig":{"baseUrl":"http://gs.com","api":"openai"}}}"#;
        std::fs::write(&gs_models_path, original_gs_content).unwrap();

        // Configure mode = "link"
        let config_json_path = mock_user_home.join(".gentle-shell").join("config.json");
        std::fs::write(&config_json_path, r#"{"home": "link"}"#).unwrap();

        // 1. Resolver returns Ok(None) for link
        let res_resolver = resolve_gentle_shell_sync_target_impl(
            Some(&mock_user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "link"}"#.to_string()),
        ).unwrap();
        assert_eq!(res_resolver, None);

        // Case-insensitive "LINK"
        let res_resolver_upper = resolve_gentle_shell_sync_target_impl(
            Some(&mock_user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "LINK"}"#.to_string()),
        ).unwrap();
        assert_eq!(res_resolver_upper, None);

        // 2. upsert_custom_provider_impl succeeds on main Pi, skips Gentle Shell write
        let main_path = main_pi_dir.join("models.json");
        std::fs::write(&main_path, r#"{"providers":{}}"#).unwrap();

        let update_payload = serde_json::json!({
            "baseUrl": "https://api.new.com/v1",
            "api": "openai-completions"
        });

        let res_upsert = upsert_custom_provider_impl(
            &main_path,
            "link_prov",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res_upsert.is_ok());

        // Gentle Shell models.json is completely untouched
        let gs_current = std::fs::read_to_string(&gs_models_path).unwrap();
        assert_eq!(gs_current, original_gs_content);

        // 3. propagate_provider_upsert_to_gentle_shell returns Ok(false)
        let prov_obj = update_payload.as_object().unwrap();
        let prop_res = propagate_provider_upsert_to_gentle_shell(
            Some(&mock_user_home),
            None,
            "link_prov2",
            prov_obj,
        );
        assert_eq!(prop_res, Ok(false));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_changed_model_merge_retaining_external_fields() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_model_merge_{}", std::process::id()));
        let main_pi_dir = temp_dir.join("main_pi");
        let mock_user_home = temp_dir.join("user_home");
        let default_iso_home = mock_user_home.join(".gentle-shell").join("agent");

        std::fs::create_dir_all(&main_pi_dir).unwrap();
        std::fs::create_dir_all(&default_iso_home).unwrap();
        // Notice: ~/.gentle-shell/config.json is absent!

        // 1. Seed Gentle Shell models.json with:
        // - Unknown root fields ("gs_root_extra", "nested_meta")
        // - Unrelated provider ("unrelated_provider")
        // - Target provider ("target_prov") with unknown provider fields ("gs_provider_extra")
        // - Existing model ("model_1") with unknown model fields ("gs_model_extra", "contextWindow")
        // - Unmatched model ("model_unmatched") with its own fields
        let gs_models_path = default_iso_home.join("models.json");
        let gs_seed = serde_json::json!({
            "gs_root_extra": "keep_gs_root",
            "nested_meta": { "gsSpecific": true },
            "providers": {
                "unrelated_provider": {
                    "baseUrl": "https://unrelated.com/v1",
                    "api": "openai-completions",
                    "models": [{ "id": "unrelated_model" }]
                },
                "target_prov": {
                    "baseUrl": "https://target-old.com/v1",
                    "api": "openai-completions",
                    "gs_provider_extra": 12345,
                    "models": [
                        {
                            "id": "model_1",
                            "name": "Old Model 1 Name",
                            "gs_model_extra": "keep_model_val",
                            "contextWindow": 32000
                        },
                        {
                            "id": "model_unmatched",
                            "name": "External Unmatched Model",
                            "specialTag": "external"
                        }
                    ]
                }
            }
        });
        std::fs::write(&gs_models_path, serde_json::to_string_pretty(&gs_seed).unwrap()).unwrap();

        // 2. Seed main Pi models.json with its own root key and an exclusive provider
        let main_path = main_pi_dir.join("models.json");
        let main_seed = serde_json::json!({
            "mainRootProp": "main_only",
            "providers": {
                "main_exclusive_prov": {
                    "baseUrl": "https://main-exclusive.com",
                    "api": "openai-completions"
                }
            }
        });
        std::fs::write(&main_path, serde_json::to_string_pretty(&main_seed).unwrap()).unwrap();

        // 3. Update target_prov: edits model_1 (new name, maxTokens) and adds model_2
        let update_payload = serde_json::json!({
            "baseUrl": "https://target-new.com/v1",
            "api": "openai-completions",
            "models": [
                {
                    "id": "model_1",
                    "name": "Updated Model 1 Name",
                    "maxTokens": 8192
                },
                {
                    "id": "model_2",
                    "name": "Brand New Model 2"
                }
            ]
        });

        let res = upsert_custom_provider_impl(
            &main_path,
            "target_prov",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(res.is_ok());

        // 4. Verify Gentle Shell models.json after merge:
        let gs_reloaded: Value = serde_json::from_str(&std::fs::read_to_string(&gs_models_path).unwrap()).unwrap();

        // (a) Preserves unknown root fields
        assert_eq!(gs_reloaded["gs_root_extra"], "keep_gs_root");
        assert_eq!(gs_reloaded["nested_meta"]["gsSpecific"], true);
        // Does NOT copy main Pi root fields (no full file copy)
        assert!(gs_reloaded.get("mainRootProp").is_none());

        // (b) Preserves unrelated providers
        assert!(gs_reloaded["providers"].get("unrelated_provider").is_some());
        assert_eq!(
            gs_reloaded["providers"]["unrelated_provider"]["models"][0]["id"],
            "unrelated_model"
        );
        // Does NOT copy main Pi exclusive providers (no full file copy)
        assert!(gs_reloaded["providers"].get("main_exclusive_prov").is_none());

        // (c) Preserves unknown provider fields on edited provider
        let target = &gs_reloaded["providers"]["target_prov"];
        assert_eq!(target["baseUrl"], "https://target-new.com/v1");
        assert_eq!(target["gs_provider_extra"], 12345);

        // (d) Models merge:
        let models = target["models"].as_array().unwrap();
        // model_1 is updated with new name and maxTokens, but keeps gs_model_extra and contextWindow!
        let m1 = models.iter().find(|m| m["id"] == "model_1").unwrap();
        assert_eq!(m1["name"], "Updated Model 1 Name");
        assert_eq!(m1["maxTokens"], 8192);
        assert_eq!(m1["gs_model_extra"], "keep_model_val");
        assert_eq!(m1["contextWindow"], 32000);

        // model_2 is added
        let m2 = models.iter().find(|m| m["id"] == "model_2").unwrap();
        assert_eq!(m2["name"], "Brand New Model 2");

        // unmatched model_unmatched is preserved with its fields!
        let m_unmatched = models.iter().find(|m| m["id"] == "model_unmatched").unwrap();
        assert_eq!(m_unmatched["name"], "External Unmatched Model");
        assert_eq!(m_unmatched["specialTag"], "external");

        // (e) Fails closed on malformed Gentle Shell models.json without corrupting either file
        let malformed_gs = "{ invalid json content ...";
        std::fs::write(&gs_models_path, malformed_gs).unwrap();
        let main_snapshot = std::fs::read_to_string(&main_path).unwrap();

        let fail_res = upsert_custom_provider_impl(
            &main_path,
            "target_prov",
            &update_payload,
            Some(&mock_user_home),
            None,
        );
        assert!(fail_res.is_err());
        // Neither file is overwritten or corrupted
        assert_eq!(std::fs::read_to_string(&gs_models_path).unwrap(), malformed_gs);
        assert_eq!(std::fs::read_to_string(&main_path).unwrap(), main_snapshot);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_apply_provider_merge_to_root_protects_malformed_nested_entries() {
        let update_payload = serde_json::json!({
            "baseUrl": "https://api.new.com/v1",
            "api": "openai-completions",
            "models": [{ "id": "m_new", "name": "New Model" }]
        });
        let update_obj = update_payload.as_object().unwrap();

        // 1. Existing providers field is non-object -> rejected
        let mut root_non_obj_providers = serde_json::Map::new();
        root_non_obj_providers.insert("providers".to_string(), Value::String("not_an_object".to_string()));
        let err1 = apply_provider_merge_to_root(&mut root_non_obj_providers, "p1", update_obj);
        assert!(err1.is_err());
        assert!(err1.unwrap_err().contains("'providers' field in models.json must be a JSON object"));

        // 2. Existing target provider is non-object (e.g. string or number) -> rejected, not overwritten
        let mut root_corrupt_provider: serde_json::Map<String, Value> = serde_json::from_value(serde_json::json!({
            "providers": {
                "target_p": "corrupted_string_value",
                "other_p": { "baseUrl": "http://ok.com", "api": "openai" }
            }
        })).unwrap();
        let err2 = apply_provider_merge_to_root(&mut root_corrupt_provider, "target_p", update_obj);
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("must be a JSON object"));
        // Ensure protected unknown config was not replaced
        assert_eq!(root_corrupt_provider["providers"]["target_p"], "corrupted_string_value");

        // 3. Existing target provider's models field is non-array -> rejected, not overwritten
        let mut root_corrupt_models: serde_json::Map<String, Value> = serde_json::from_value(serde_json::json!({
            "providers": {
                "target_p": {
                    "baseUrl": "https://api.target.com/v1",
                    "api": "openai-completions",
                    "models": "malformed_models_not_array"
                }
            }
        })).unwrap();
        let err3 = apply_provider_merge_to_root(&mut root_corrupt_models, "target_p", update_obj);
        assert!(err3.is_err());
        assert!(err3.unwrap_err().contains("must be an array"));
        assert_eq!(
            root_corrupt_models["providers"]["target_p"]["models"],
            "malformed_models_not_array"
        );

        // 4. Existing models array contains non-object elements: preserved safely alongside updated/new models
        let mut root_mixed_models: serde_json::Map<String, Value> = serde_json::from_value(serde_json::json!({
            "providers": {
                "target_p": {
                    "baseUrl": "https://api.target.com/v1",
                    "api": "openai-completions",
                    "models": [
                        "legacy_string_model_id",
                        42,
                        { "id": "m_existing", "name": "Existing Model", "customField": 999 }
                    ]
                }
            }
        })).unwrap();
        let ok_res = apply_provider_merge_to_root(&mut root_mixed_models, "target_p", update_obj);
        assert!(ok_res.is_ok());

        let target_models = root_mixed_models["providers"]["target_p"]["models"].as_array().unwrap();
        // Should contain m_new, and preserved m_existing, "legacy_string_model_id", 42
        assert_eq!(target_models.len(), 4);
        assert!(target_models.iter().any(|m| m.as_str() == Some("legacy_string_model_id")));
        assert!(target_models.iter().any(|m| m.as_i64() == Some(42)));
        assert!(target_models.iter().any(|m| m.as_object().and_then(|o| o.get("id")).and_then(|id| id.as_str()) == Some("m_existing")));
        assert!(target_models.iter().any(|m| m.as_object().and_then(|o| o.get("id")).and_then(|id| id.as_str()) == Some("m_new")));

        // 5. Fail-closed on disk when upserting to a file with malformed nested target
        let temp_dir = std::env::temp_dir().join(format!("test_malformed_nested_{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let main_path = temp_dir.join("models.json");
        let initial_bytes = serde_json::to_string_pretty(&serde_json::json!({
            "providers": {
                "target": "not_an_object"
            }
        })).unwrap();
        std::fs::write(&main_path, &initial_bytes).unwrap();

        let err5 = upsert_custom_provider_impl(
            &main_path,
            "target",
            &update_payload,
            None,
            None,
        );
        assert!(err5.is_err());
        assert_eq!(std::fs::read_to_string(&main_path).unwrap(), initial_bytes);

        // 6. Delete fails closed when providers field is not an object
        let non_obj_providers_bytes = serde_json::to_string_pretty(&serde_json::json!({
            "providers": "not_an_object"
        })).unwrap();
        std::fs::write(&main_path, &non_obj_providers_bytes).unwrap();
        let err6 = delete_custom_provider_impl(&main_path, "target");
        assert!(err6.is_err());
        assert_eq!(std::fs::read_to_string(&main_path).unwrap(), non_obj_providers_bytes);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_custom_providers_fails_closed_on_malformed_file() {
        let temp_dir = std::env::temp_dir().join(format!("test_save_fail_closed_{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("models.json");

        let malformed_content = "{ invalid json content ...";
        std::fs::write(&config_path, malformed_content).unwrap();

        let valid_payload = serde_json::json!({
            "providers": {
                "ollama": {
                    "baseUrl": "http://localhost:11434/v1",
                    "api": "openai-completions"
                }
            }
        });

        // Must fail closed with Err rather than overwriting the malformed file
        let res = save_custom_providers_impl(&config_path, &valid_payload);
        assert!(res.is_err());
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), malformed_content);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_resolve_settings_config_path() {
        let path_opt = resolve_settings_config_path();
        assert!(path_opt.is_some());
        let path = path_opt.unwrap();
        let path_str = path.to_string_lossy();
        assert!(path_str.ends_with("settings.json"));
        assert!(path_str.contains(".pi"));
        assert!(path_str.contains("agent"));
    }

    #[test]
    fn test_get_model_thinking_levels_missing_and_empty_file() {
        let temp_dir = std::env::temp_dir().join(format!("test_settings_missing_{}", std::process::id()));
        let missing_path = temp_dir.join("nonexistent_settings.json");

        // Missing file returns {}
        let res = get_model_thinking_levels_impl(&missing_path).unwrap();
        assert!(res.is_object());
        assert_eq!(res.as_object().unwrap().len(), 0);

        // Empty file returns {}
        std::fs::create_dir_all(&temp_dir).unwrap();
        let empty_path = temp_dir.join("empty_settings.json");
        std::fs::write(&empty_path, "   \n").unwrap();
        let empty_res = get_model_thinking_levels_impl(&empty_path).unwrap();
        assert!(empty_res.is_object());
        assert_eq!(empty_res.as_object().unwrap().len(), 0);

        // File without modelThinkingLevels returns {}
        let other_path = temp_dir.join("other_settings.json");
        std::fs::write(&other_path, r#"{"defaultModel": "gpt-4o"}"#).unwrap();
        let other_res = get_model_thinking_levels_impl(&other_path).unwrap();
        assert!(other_res.is_object());
        assert_eq!(other_res.as_object().unwrap().len(), 0);

        // File where modelThinkingLevels is not an object returns {}
        let invalid_field_path = temp_dir.join("invalid_field_settings.json");
        std::fs::write(&invalid_field_path, r#"{"modelThinkingLevels": "invalid"}"#).unwrap();
        let invalid_res = get_model_thinking_levels_impl(&invalid_field_path).unwrap();
        assert!(invalid_res.is_object());
        assert_eq!(invalid_res.as_object().unwrap().len(), 0);

        // File with valid modelThinkingLevels returns the object
        let valid_path = temp_dir.join("valid_settings.json");
        std::fs::write(&valid_path, r#"{"modelThinkingLevels": {"model-a": "high"}}"#).unwrap();
        let valid_res = get_model_thinking_levels_impl(&valid_path).unwrap();
        assert_eq!(valid_res["model-a"], "high");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_model_thinking_levels_validation() {
        let temp_dir = std::env::temp_dir().join(format!("test_thinking_val_{}", std::process::id()));
        let config_path = temp_dir.join("settings.json");

        // Reject non-object
        let err_non_obj = save_model_thinking_levels_impl(&config_path, &serde_json::json!("invalid"));
        assert!(err_non_obj.is_err());
        assert!(err_non_obj.unwrap_err().contains("must be a JSON object"));

        // Reject empty model identifier
        let bad_key = serde_json::json!({
            "   ": "high"
        });
        let err_bad_key = save_model_thinking_levels_impl(&config_path, &bad_key);
        assert!(err_bad_key.is_err());
        assert!(err_bad_key.unwrap_err().contains("must not be empty"));

        // Reject non-string, non-null value (e.g. number)
        let num_val = serde_json::json!({
            "model-a": 123
        });
        let err_num = save_model_thinking_levels_impl(&config_path, &num_val);
        assert!(err_num.is_err());
        assert!(err_num.unwrap_err().contains("must be a string or null"));

        // Reject invalid thinking level string
        let invalid_lvl = serde_json::json!({
            "model-a": "ultra-deep"
        });
        let err_lvl = save_model_thinking_levels_impl(&config_path, &invalid_lvl);
        assert!(err_lvl.is_err());
        let msg = err_lvl.unwrap_err();
        assert!(msg.contains("Invalid thinking level 'ultra-deep'"));
        assert!(msg.contains("Valid levels are:"));

        // Reject empty thinking level string
        let empty_lvl = serde_json::json!({
            "model-a": ""
        });
        let err_empty = save_model_thinking_levels_impl(&config_path, &empty_lvl);
        assert!(err_empty.is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_model_thinking_levels_preserves_other_keys_updates_and_deletes() {
        let temp_dir = std::env::temp_dir().join(format!("test_thinking_roundtrip_{}", std::process::id()));
        let config_path = temp_dir.join("settings.json");

        std::fs::create_dir_all(&temp_dir).unwrap();
        // Seed settings.json with other keys and existing modelThinkingLevels
        let initial_json = serde_json::json!({
            "defaultModel": "gpt-4o",
            "defaultProvider": "openai",
            "defaultThinkingLevel": "medium",
            "extensions": ["extension-one"],
            "modelThinkingLevels": {
                "claude-3-7-sonnet": "high",
                "to-remove": "low",
                "to-keep": "minimal"
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        // Updates: update claude, delete to-remove with null, insert new-model
        let updates = serde_json::json!({
            "claude-3-7-sonnet": "max",
            "to-remove": null,
            "new-model": "off"
        });

        let saved = save_model_thinking_levels_impl(&config_path, &updates).unwrap();
        assert_eq!(saved["claude-3-7-sonnet"], "max");
        assert_eq!(saved["to-keep"], "minimal");
        assert_eq!(saved["new-model"], "off");
        assert!(saved.get("to-remove").is_none());

        // Verify settings.json on disk preserved other keys
        let on_disk_str = std::fs::read_to_string(&config_path).unwrap();
        let on_disk: Value = serde_json::from_str(&on_disk_str).unwrap();
        assert_eq!(on_disk["defaultModel"], "gpt-4o");
        assert_eq!(on_disk["defaultProvider"], "openai");
        assert_eq!(on_disk["defaultThinkingLevel"], "medium");
        assert_eq!(on_disk["extensions"][0], "extension-one");

        // Verify get_model_thinking_levels_impl reads back the updated map
        let reloaded = get_model_thinking_levels_impl(&config_path).unwrap();
        assert_eq!(reloaded["claude-3-7-sonnet"], "max");
        assert_eq!(reloaded["to-keep"], "minimal");
        assert_eq!(reloaded["new-model"], "off");
        assert!(reloaded.get("to-remove").is_none());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_resolve_mcp_config_paths() {
        // Global path resolution
        let global_opt = resolve_global_mcp_config_path();
        assert!(global_opt.is_some());
        let global_path = global_opt.unwrap();
        let global_str = global_path.to_string_lossy();
        assert!(global_str.ends_with("mcp.json"));
        assert!(global_str.contains(".pi"));
        assert!(global_str.contains("agent"));

        // Project path resolution
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_paths_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        // 1. None exists, no .pi directory -> defaults to cwd/.mcp.json
        let p1 = resolve_project_mcp_config_path(&temp_dir).unwrap();
        assert_eq!(p1, temp_dir.join(".mcp.json"));

        // 2. None exists, but .pi directory exists -> defaults to cwd/.pi/mcp.json
        let pi_dir = temp_dir.join(".pi");
        std::fs::create_dir_all(&pi_dir).unwrap();
        let p2 = resolve_project_mcp_config_path(&temp_dir).unwrap();
        assert_eq!(p2, pi_dir.join("mcp.json"));

        // 3. .agents/mcp.json exists (and no higher priority files) -> resolves to .agents/mcp.json
        let agents_dir = temp_dir.join(".agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        let agents_mcp = agents_dir.join("mcp.json");
        std::fs::write(&agents_mcp, "{}").unwrap();
        let p3 = resolve_project_mcp_config_path(&temp_dir).unwrap();
        assert_eq!(p3, agents_mcp);

        // 4. .mcp.json exists -> takes priority over .agents/mcp.json
        let root_mcp = temp_dir.join(".mcp.json");
        std::fs::write(&root_mcp, "{}").unwrap();
        let p4 = resolve_project_mcp_config_path(&temp_dir).unwrap();
        assert_eq!(p4, root_mcp);

        // 5. .pi/mcp.json exists -> takes highest priority
        let pi_mcp = pi_dir.join("mcp.json");
        std::fs::write(&pi_mcp, "{}").unwrap();
        let p5 = resolve_project_mcp_config_path(&temp_dir).unwrap();
        assert_eq!(p5, pi_mcp);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_get_mcp_servers_parsing_and_precedence() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_parsing_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let global_path = temp_dir.join("global_mcp.json");
        let project_path = temp_dir.join("project_mcp.json");

        let global_json = serde_json::json!({
            "mcpServers": {
                "shared-server": {
                    "command": "node",
                    "args": ["global_srv.js"],
                    "env": {
                        "GLOBAL_SECRET": "top-secret-val",
                        "ALPHA": "1"
                    }
                },
                "global-only": {
                    "command": "python",
                    "args": ["py_srv.py"],
                    "disabled": true
                }
            }
        });
        std::fs::write(&global_path, serde_json::to_string_pretty(&global_json).unwrap()).unwrap();

        let project_json = serde_json::json!({
            "mcp-servers": {
                "shared-server": {
                    "url": "http://localhost:8080/sse",
                    "type": "remote",
                    "env": {
                        "PROJ_TOKEN": "token-123",
                        "BETA": "2"
                    },
                    "enabled": true
                },
                "project-only": {
                    "command": "cargo",
                    "args": ["run"],
                    "enabled": false
                }
            }
        });
        std::fs::write(&project_path, serde_json::to_string_pretty(&project_json).unwrap()).unwrap();

        let res = get_mcp_servers_impl(Some(&global_path), Some(&project_path)).unwrap();
        assert!(res.is_object());
        let servers = res["servers"].as_array().expect("servers must be an array");
        assert_eq!(servers.len(), 3);

        // shared-server: project overrides global
        let shared = servers.iter().find(|s| s["name"] == "shared-server").expect("shared-server must exist");
        assert_eq!(shared["scope"], "project");
        assert_eq!(shared["url"], "http://localhost:8080/sse");
        assert_eq!(shared["serverType"], "remote");
        assert_eq!(shared["enabled"], true);
        assert_eq!(shared["disabled"], false);
        // envKeys must be sorted, env contains map of variables for editing
        assert_eq!(shared["envKeys"], serde_json::json!(["BETA", "PROJ_TOKEN"]));
        assert_eq!(
            shared["env"],
            serde_json::json!({
                "PROJ_TOKEN": "token-123",
                "BETA": "2"
            })
        );
        assert_eq!(shared["headers"], Value::Null);

        // global-only: scope global
        let global_srv = servers.iter().find(|s| s["name"] == "global-only").expect("global-only must exist");
        assert_eq!(global_srv["scope"], "global");
        assert_eq!(global_srv["command"], "python");
        assert_eq!(global_srv["args"], serde_json::json!(["py_srv.py"]));
        assert_eq!(global_srv["serverType"], "stdio");
        assert_eq!(global_srv["disabled"], true);
        assert_eq!(global_srv["enabled"], false);
        assert_eq!(global_srv["envKeys"], serde_json::json!([]));
        assert_eq!(global_srv["env"], Value::Null);
        assert_eq!(global_srv["headers"], Value::Null);

        // project-only: scope project
        let project_srv = servers.iter().find(|s| s["name"] == "project-only").expect("project-only must exist");
        assert_eq!(project_srv["scope"], "project");
        assert_eq!(project_srv["command"], "cargo");
        assert_eq!(project_srv["args"], serde_json::json!(["run"]));
        assert_eq!(project_srv["serverType"], "stdio");
        assert_eq!(project_srv["disabled"], true);
        assert_eq!(project_srv["enabled"], false);
        assert_eq!(project_srv["envKeys"], serde_json::json!([]));
        assert_eq!(project_srv["env"], Value::Null);
        assert_eq!(project_srv["headers"], Value::Null);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_toggle_mcp_server_atomic_preserves_keys() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_toggle_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let config_path = temp_dir.join("sub").join("mcp.json");

        // 1. Target file does not exist yet -> creates it
        let res_new = toggle_mcp_server_impl(&config_path, "srv-new", true).unwrap();
        assert_eq!(res_new["success"], true);
        assert_eq!(res_new["name"], "srv-new");
        assert_eq!(res_new["enabled"], true);

        let on_disk_1: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk_1["mcpServers"]["srv-new"]["disabled"], false);
        assert_eq!(on_disk_1["mcpServers"]["srv-new"]["enabled"], true);

        // 2. Add extra keys to config file to ensure they are preserved
        let mut seeded_obj = on_disk_1.as_object().unwrap().clone();
        seeded_obj.insert("unrelatedKey".to_string(), serde_json::json!({ "foo": "bar" }));
        seeded_obj.insert("anotherKey".to_string(), serde_json::json!(42));
        // Add command and args to srv-new to ensure server attributes are preserved
        let mut srv_new_map = seeded_obj["mcpServers"]["srv-new"].as_object().unwrap().clone();
        srv_new_map.insert("command".to_string(), serde_json::json!("node"));
        srv_new_map.insert("args".to_string(), serde_json::json!(["index.js"]));
        seeded_obj.get_mut("mcpServers").unwrap().as_object_mut().unwrap().insert("srv-new".to_string(), Value::Object(srv_new_map));
        std::fs::write(&config_path, serde_json::to_string_pretty(&Value::Object(seeded_obj)).unwrap()).unwrap();

        // 3. Toggle srv-new to disabled (false)
        let res_disable = toggle_mcp_server_impl(&config_path, "srv-new", false).unwrap();
        assert_eq!(res_disable["success"], true);
        assert_eq!(res_disable["enabled"], false);

        let on_disk_2: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        // Server updated
        assert_eq!(on_disk_2["mcpServers"]["srv-new"]["disabled"], true);
        assert_eq!(on_disk_2["mcpServers"]["srv-new"]["enabled"], false);
        // Server's other fields preserved
        assert_eq!(on_disk_2["mcpServers"]["srv-new"]["command"], "node");
        assert_eq!(on_disk_2["mcpServers"]["srv-new"]["args"], serde_json::json!(["index.js"]));
        // Other top-level keys preserved
        assert_eq!(on_disk_2["unrelatedKey"]["foo"], "bar");
        assert_eq!(on_disk_2["anotherKey"], 42);

        // 4. Toggle back to enabled (true)
        let res_enable = toggle_mcp_server_impl(&config_path, "srv-new", true).unwrap();
        assert_eq!(res_enable["success"], true);
        assert_eq!(res_enable["enabled"], true);

        let on_disk_3: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk_3["mcpServers"]["srv-new"]["disabled"], false);
        assert_eq!(on_disk_3["mcpServers"]["srv-new"]["enabled"], true);
        assert_eq!(on_disk_3["mcpServers"]["srv-new"]["command"], "node");
        assert_eq!(on_disk_3["unrelatedKey"]["foo"], "bar");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_tauri_commands_get_and_toggle_mcp_servers() {
        let temp_dir = std::env::temp_dir().join(format!("test_tauri_mcp_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let temp_str = temp_dir.to_string_lossy().to_string();

        // 1. Validation: empty name rejected
        let err_empty = toggle_mcp_server("   ".to_string(), true, None, None).await;
        assert!(err_empty.is_err());
        assert!(err_empty.unwrap_err().contains("Server name must not be empty"));

        // 2. Validation: project scope requested without cwd rejected
        let err_no_cwd = toggle_mcp_server("srv".to_string(), true, None, Some("project".to_string())).await;
        assert!(err_no_cwd.is_err());
        assert!(err_no_cwd.unwrap_err().contains("no valid cwd provided"));

        // 3. Toggle with project scope and cwd -> creates project config
        let toggle_res = toggle_mcp_server(
            "custom-tool".to_string(),
            true,
            Some(temp_str.clone()),
            Some("project".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(toggle_res["success"], true);
        assert_eq!(toggle_res["name"], "custom-tool");
        assert_eq!(toggle_res["enabled"], true);

        // 4. Get MCP servers with cwd includes the new server
        let list_res = get_mcp_servers(Some(temp_str.clone())).await.unwrap();
        let servers = list_res["servers"].as_array().expect("servers array");
        let srv = servers.iter().find(|s| s["name"] == "custom-tool").expect("found server");
        assert_eq!(srv["scope"], "project");
        assert_eq!(srv["enabled"], true);
        assert_eq!(srv["disabled"], false);

        // 5. Toggle without scope detects server exists in project config and disables it
        let toggle_off = toggle_mcp_server(
            "custom-tool".to_string(),
            false,
            Some(temp_str.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(toggle_off["success"], true);
        assert_eq!(toggle_off["enabled"], false);

        let list_res_2 = get_mcp_servers(Some(temp_str.clone())).await.unwrap();
        let srv_2 = list_res_2["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "custom-tool")
            .unwrap();
        assert_eq!(srv_2["enabled"], false);
        assert_eq!(srv_2["disabled"], true);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_mcp_project_override_and_scoped_toggle() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_proj_override_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let global_path = temp_dir.join("global_mcp.json");
        let project_dir = temp_dir.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let project_path = project_dir.join(".mcp.json");

        let global_json = serde_json::json!({
            "mcpServers": {
                "codegraph": {
                    "command": "npx",
                    "args": ["-y", "codegraph-server"],
                    "disabled": false
                }
            }
        });
        std::fs::write(&global_path, serde_json::to_string_pretty(&global_json).unwrap()).unwrap();

        let project_json = serde_json::json!({
            "mcpServers": {
                "codegraph": {
                    "disabled": true
                }
            }
        });
        std::fs::write(&project_path, serde_json::to_string_pretty(&project_json).unwrap()).unwrap();

        // 1. Verify get_mcp_servers_impl overlay merge:
        // Global server with command & args + project config with disabled: true
        // returns server with command/args intact, disabled: true, enabled: false, scope: "global", hasProjectOverride: true
        let res = get_mcp_servers_impl(Some(&global_path), Some(&project_path)).unwrap();
        let servers = res["servers"].as_array().expect("servers array");
        let srv = servers.iter().find(|s| s["name"] == "codegraph").expect("codegraph server exists");
        assert_eq!(srv["command"], "npx");
        assert_eq!(srv["args"], serde_json::json!(["-y", "codegraph-server"]));
        assert_eq!(srv["disabled"], true);
        assert_eq!(srv["enabled"], false);
        assert_eq!(srv["scope"], "global");
        assert_eq!(srv["hasProjectOverride"], true);
        assert_eq!(srv["configPath"], global_path.to_string_lossy().to_string());

        // 2. Verify toggle with scope: Some("project") writes to project config and leaves global file unchanged
        std::fs::remove_file(&project_path).unwrap();
        let global_before = std::fs::read_to_string(&global_path).unwrap();

        let toggle_res = toggle_mcp_server(
            "codegraph".to_string(),
            false,
            Some(project_dir.to_string_lossy().to_string()),
            Some("project".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(toggle_res["success"], true);
        assert_eq!(toggle_res["path"], project_path.to_string_lossy().to_string());

        // Global file is unchanged
        let global_after = std::fs::read_to_string(&global_path).unwrap();
        assert_eq!(global_before, global_after);

        // Project file was created and contains disabled: true
        assert!(project_path.exists());
        let proj_content = std::fs::read_to_string(&project_path).unwrap();
        let proj_val: Value = serde_json::from_str(&proj_content).unwrap();
        assert_eq!(proj_val["mcpServers"]["codegraph"]["disabled"], true);
        assert_eq!(proj_val["mcpServers"]["codegraph"]["enabled"], false);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_mcp_server_new_stdio_and_sse() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_save_new_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let config_path = temp_dir.join("sub").join("mcp.json");

        // 1. Add stdio server to non-existent file/directory
        let stdio_def = serde_json::json!({
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            "env": {
                "FS_ROOT": "/tmp",
                "DEBUG": "true"
            }
        });
        let res_stdio = save_mcp_server_impl(&config_path, "filesystem-server", None, stdio_def).unwrap();
        assert_eq!(res_stdio["success"], true);
        assert_eq!(res_stdio["name"], "filesystem-server");

        // 2. Add SSE / remote server with URL and headers to same file
        let sse_def = serde_json::json!({
            "url": "https://mcp.example.com/sse",
            "type": "sse",
            "headers": {
                "Authorization": "Bearer sse-secret-token",
                "X-Custom-Header": "pi-viewer"
            }
        });
        let res_sse = save_mcp_server_impl(&config_path, "remote-sse-server", None, sse_def).unwrap();
        assert_eq!(res_sse["success"], true);
        assert_eq!(res_sse["name"], "remote-sse-server");

        // 3. Read back using parse_mcp_servers_from_file and verify parsed fields
        let parsed = parse_mcp_servers_from_file(&config_path, "global").unwrap();
        assert_eq!(parsed.len(), 2);

        let fs_srv = parsed.iter().find(|s| s["name"] == "filesystem-server").unwrap();
        assert_eq!(fs_srv["command"], "npx");
        assert_eq!(fs_srv["args"], serde_json::json!(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]));
        assert_eq!(fs_srv["serverType"], "stdio");
        assert_eq!(fs_srv["envKeys"], serde_json::json!(["DEBUG", "FS_ROOT"]));
        assert_eq!(
            fs_srv["env"],
            serde_json::json!({
                "FS_ROOT": "/tmp",
                "DEBUG": "true"
            })
        );
        assert_eq!(fs_srv["headers"], Value::Null);

        let remote_srv = parsed.iter().find(|s| s["name"] == "remote-sse-server").unwrap();
        assert_eq!(remote_srv["url"], "https://mcp.example.com/sse");
        assert_eq!(remote_srv["serverType"], "sse");
        assert_eq!(
            remote_srv["headers"],
            serde_json::json!({
                "Authorization": "Bearer sse-secret-token",
                "X-Custom-Header": "pi-viewer"
            })
        );
        assert_eq!(remote_srv["env"], Value::Null);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_mcp_server_edit_existing_preserves_fields() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_edit_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let config_path = temp_dir.join("mcp.json");

        // Seed with existing server and top-level key
        let initial_json = serde_json::json!({
            "unrelatedSetting": "preserved-value",
            "mcpServers": {
                "code-analyzer": {
                    "command": "analyzer",
                    "args": ["--quick"],
                    "disabled": true,
                    "env": {
                        "API_TOKEN": "secret-123"
                    },
                    "customProp": 42
                },
                "other-server": {
                    "command": "python",
                    "args": ["main.py"]
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        // Update code-analyzer with new command and args (without specifying disabled or customProp)
        let edit_def = serde_json::json!({
            "command": "analyzer-v2",
            "args": ["--deep", "--all"]
        });
        let res = save_mcp_server_impl(&config_path, "code-analyzer", None, edit_def).unwrap();
        assert_eq!(res["success"], true);

        // Read raw disk contents to verify preservation
        let on_disk_str = std::fs::read_to_string(&config_path).unwrap();
        let on_disk: Value = serde_json::from_str(&on_disk_str).unwrap();

        assert_eq!(on_disk["unrelatedSetting"], "preserved-value");
        assert_eq!(on_disk["mcpServers"]["other-server"]["command"], "python");

        let analyzer = &on_disk["mcpServers"]["code-analyzer"];
        assert_eq!(analyzer["command"], "analyzer-v2");
        assert_eq!(analyzer["args"], serde_json::json!(["--deep", "--all"]));
        // Preserved fields:
        assert_eq!(analyzer["disabled"], true);
        assert_eq!(analyzer["env"]["API_TOKEN"], "secret-123");
        assert_eq!(analyzer["customProp"], 42);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_mcp_server_rename_with_old_name() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_rename_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let config_path = temp_dir.join("mcp.json");

        let initial_json = serde_json::json!({
            "mcpServers": {
                "legacy-worker": {
                    "command": "worker",
                    "args": ["run"],
                    "disabled": true,
                    "env": {
                        "ENV_VAL": "hello"
                    }
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        // Rename legacy-worker -> modernized-worker, updating command
        let rename_def = serde_json::json!({
            "command": "modern-worker",
            "args": ["serve"]
        });
        let res = save_mcp_server_impl(
            &config_path,
            "modernized-worker",
            Some("legacy-worker"),
            rename_def,
        )
        .unwrap();
        assert_eq!(res["success"], true);
        assert_eq!(res["name"], "modernized-worker");

        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let servers_map = on_disk["mcpServers"].as_object().unwrap();

        // legacy-worker must be removed
        assert!(!servers_map.contains_key("legacy-worker"));

        // modernized-worker must exist with updated command and preserved disabled + env
        let srv = &servers_map["modernized-worker"];
        assert_eq!(srv["command"], "modern-worker");
        assert_eq!(srv["args"], serde_json::json!(["serve"]));
        assert_eq!(srv["disabled"], true);
        assert_eq!(srv["env"]["ENV_VAL"], "hello");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_mcp_server_validation() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_val_{}", std::process::id()));
        let config_path = temp_dir.join("mcp.json");

        // Reject empty or whitespace name
        let err_empty = save_mcp_server_impl(&config_path, "   ", None, serde_json::json!({"command": "node"}));
        assert!(err_empty.is_err());
        assert!(err_empty.unwrap_err().contains("Server name must not be empty"));

        // Reject non-object server definition
        let err_non_obj = save_mcp_server_impl(&config_path, "valid-name", None, serde_json::json!("not-an-object"));
        assert!(err_non_obj.is_err());
        assert!(err_non_obj.unwrap_err().contains("must be a JSON object"));
    }

    #[test]
    fn test_delete_mcp_server_removes_server_and_preserves_others() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_del_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let config_path = temp_dir.join("mcp.json");

        let initial_json = serde_json::json!({
            "preservedRootKey": 999,
            "mcpServers": {
                "srv-to-delete": {
                    "command": "rm-me"
                },
                "srv-to-keep": {
                    "command": "keep-me"
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        // 1. Delete srv-to-delete
        let del_res = delete_mcp_server_impl(&config_path, "srv-to-delete").unwrap();
        assert_eq!(del_res["success"], true);
        assert_eq!(del_res["name"], "srv-to-delete");

        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk["preservedRootKey"], 999);
        assert!(!on_disk["mcpServers"].as_object().unwrap().contains_key("srv-to-delete"));
        assert!(on_disk["mcpServers"].as_object().unwrap().contains_key("srv-to-keep"));

        // 2. Delete non-existent server is idempotent
        let del_missing = delete_mcp_server_impl(&config_path, "srv-already-gone").unwrap();
        assert_eq!(del_missing["success"], true);

        // 3. Delete on non-existent file is idempotent
        let non_existent_path = temp_dir.join("does_not_exist.json");
        let del_non_existent = delete_mcp_server_impl(&non_existent_path, "any-server").unwrap();
        assert_eq!(del_non_existent["success"], true);

        // 4. Reject empty name
        let err_empty = delete_mcp_server_impl(&config_path, "   ");
        assert!(err_empty.is_err());
        assert!(err_empty.unwrap_err().contains("Server name must not be empty"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_and_delete_mcp_servers_with_mcp_dash_servers_key() {
        let temp_dir = std::env::temp_dir().join(format!("test_mcp_dash_key_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let config_path = temp_dir.join("mcp.json");

        // Seed with mcp-servers (hyphenated)
        let initial_json = serde_json::json!({
            "mcp-servers": {
                "server-one": {
                    "command": "cmd1"
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_json).unwrap()).unwrap();

        // Save server-two -> should preserve hyphenated "mcp-servers" key
        let save_res = save_mcp_server_impl(
            &config_path,
            "server-two",
            None,
            serde_json::json!({ "command": "cmd2" }),
        )
        .unwrap();
        assert_eq!(save_res["success"], true);

        let on_disk_1: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(on_disk_1.as_object().unwrap().contains_key("mcp-servers"));
        assert!(!on_disk_1.as_object().unwrap().contains_key("mcpServers"));
        assert!(on_disk_1["mcp-servers"].as_object().unwrap().contains_key("server-one"));
        assert!(on_disk_1["mcp-servers"].as_object().unwrap().contains_key("server-two"));

        // Delete server-one from hyphenated key
        let del_res = delete_mcp_server_impl(&config_path, "server-one").unwrap();
        assert_eq!(del_res["success"], true);

        let on_disk_2: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(!on_disk_2["mcp-servers"].as_object().unwrap().contains_key("server-one"));
        assert!(on_disk_2["mcp-servers"].as_object().unwrap().contains_key("server-two"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_tauri_commands_save_and_delete_mcp_server() {
        let temp_dir = std::env::temp_dir().join(format!("test_tauri_mcp_save_del_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let temp_str = temp_dir.to_string_lossy().to_string();

        // 1. Validation errors
        let err_save_empty = save_mcp_server("   ".to_string(), None, serde_json::json!({}), None, None).await;
        assert!(err_save_empty.is_err());
        assert!(err_save_empty.unwrap_err().contains("Server name must not be empty"));

        let err_del_empty = delete_mcp_server("   ".to_string(), None, None).await;
        assert!(err_del_empty.is_err());
        assert!(err_del_empty.unwrap_err().contains("Server name must not be empty"));

        let err_no_cwd = save_mcp_server(
            "srv".to_string(),
            None,
            serde_json::json!({"command": "node"}),
            None,
            Some("project".to_string()),
        )
        .await;
        assert!(err_no_cwd.is_err());
        assert!(err_no_cwd.unwrap_err().contains("no valid cwd provided"));

        // 2. Save new server in project scope
        let save_res = save_mcp_server(
            "proj-worker".to_string(),
            None,
            serde_json::json!({
                "command": "cargo",
                "args": ["run", "--bin", "worker"],
                "env": { "PORT": "9000" }
            }),
            Some(temp_str.clone()),
            Some("project".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(save_res["success"], true);
        assert_eq!(save_res["name"], "proj-worker");

        // 3. Verify get_mcp_servers sees the new server
        let servers_list = get_mcp_servers(Some(temp_str.clone())).await.unwrap();
        let srv = servers_list["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "proj-worker")
            .expect("proj-worker must be returned");
        assert_eq!(srv["scope"], "project");
        assert_eq!(srv["command"], "cargo");
        assert_eq!(srv["env"], serde_json::json!({ "PORT": "9000" }));

        // 4. Rename server via save_mcp_server
        let rename_res = save_mcp_server(
            "proj-worker-v2".to_string(),
            Some("proj-worker".to_string()),
            serde_json::json!({
                "command": "cargo",
                "args": ["run", "--bin", "worker-v2"]
            }),
            Some(temp_str.clone()),
            Some("project".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(rename_res["success"], true);
        assert_eq!(rename_res["name"], "proj-worker-v2");

        let servers_list_2 = get_mcp_servers(Some(temp_str.clone())).await.unwrap();
        let servers_arr = servers_list_2["servers"].as_array().unwrap();
        assert!(servers_arr.iter().all(|s| s["name"] != "proj-worker"));
        let srv_v2 = servers_arr.iter().find(|s| s["name"] == "proj-worker-v2").unwrap();
        assert_eq!(srv_v2["command"], "cargo");
        assert_eq!(srv_v2["args"], serde_json::json!(["run", "--bin", "worker-v2"]));
        // Preserved env from proj-worker
        assert_eq!(srv_v2["env"], serde_json::json!({ "PORT": "9000" }));

        // 5. Delete server without explicit scope (auto-detects project location)
        let del_res = delete_mcp_server(
            "proj-worker-v2".to_string(),
            Some(temp_str.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(del_res["success"], true);

        let servers_list_3 = get_mcp_servers(Some(temp_str.clone())).await.unwrap();
        assert!(!servers_list_3["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "proj-worker-v2"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_resolve_project_settings_config_path() {
        let p = resolve_project_settings_config_path(Path::new("/test/workspace"));
        assert_eq!(p, Path::new("/test/workspace/.pi/settings.json"));
    }

    #[test]
    fn test_validate_extension_and_package_source() {
        // Extension source validation
        assert!(validate_extension_source("./ext.ts").is_ok());
        assert!(validate_extension_source("!./ext.ts").is_ok());
        assert!(validate_extension_source("+./ext.ts").is_ok());
        assert!(validate_extension_source("extensions/**/*.ts").is_ok());
        assert!(validate_extension_source("/var/pi/ext.js").is_ok());
        assert!(validate_extension_source("").is_err());
        assert!(validate_extension_source("   ").is_err());
        assert!(validate_extension_source("!").is_err());

        // Package source validation
        assert!(validate_package_source("npm:@scope/pkg@1.0.0").is_ok());
        assert!(validate_package_source("npm:some-pkg").is_ok());
        assert!(validate_package_source("git:github.com/user/repo").is_ok());
        assert!(validate_package_source("https://github.com/user/repo.git").is_ok());
        assert!(validate_package_source("ssh://git@github.com/user/repo.git").is_ok());
        assert!(validate_package_source("git@github.com:user/repo.git").is_ok());
        assert!(validate_package_source("./local/path").is_ok());
        assert!(validate_package_source("../other/path").is_ok());
        assert!(validate_package_source("/absolute/pkg").is_ok());
        assert!(validate_package_source("plain-pkg-name").is_ok());
        assert!(validate_package_source("").is_err());
        assert!(validate_package_source("   ").is_err());
        assert!(validate_package_source("bogus::source??with invalid spaces").is_err());
    }

    #[test]
    fn test_parse_pi_resources_from_file_string_and_object() {
        let temp_dir = std::env::temp_dir().join(format!("test_parse_pi_res_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("settings.json");

        let settings_data = serde_json::json!({
            "unrelatedTopLevel": "keep-me",
            "extensions": [
                "./active-ext.ts",
                "!./disabled-ext.ts",
                {
                    "source": "./obj-disabled.ts",
                    "enabled": false
                },
                {
                    "source": "./obj-enabled.ts",
                    "enabled": true,
                    "customNote": "preserved"
                }
            ],
            "packages": [
                "npm:@pi/active-pkg@1.0.0",
                {
                    "source": "npm:@pi/disabled-pkg",
                    "autoload": false,
                    "extensions": ["ext/*.ts"],
                    "skills": []
                },
                {
                    "source": "git:github.com/user/filtered-pkg",
                    "autoload": true,
                    "prompts": ["prompts/review.md"]
                }
            ]
        });

        std::fs::write(&config_path, serde_json::to_string_pretty(&settings_data).unwrap()).unwrap();

        let resources = parse_pi_resources_from_file(&config_path, "project").unwrap();
        assert_eq!(resources.len(), 7);

        // Verify active string extension
        let active_ext = resources.iter().find(|r| r["source"] == "./active-ext.ts").unwrap();
        assert_eq!(active_ext["kind"], "extension");
        assert_eq!(active_ext["scope"], "project");
        assert_eq!(active_ext["enabled"], true);
        assert_eq!(active_ext["id"], "project:extension:./active-ext.ts");

        // Verify disabled string extension (with '!' marker)
        let disabled_ext = resources.iter().find(|r| r["source"] == "./disabled-ext.ts").unwrap();
        assert_eq!(disabled_ext["kind"], "extension");
        assert_eq!(disabled_ext["enabled"], false);
        assert_eq!(disabled_ext["id"], "project:extension:./disabled-ext.ts");

        // Verify disabled object extension
        let obj_disabled = resources.iter().find(|r| r["source"] == "./obj-disabled.ts").unwrap();
        assert_eq!(obj_disabled["enabled"], false);

        // Verify active string package
        let active_pkg = resources.iter().find(|r| r["source"] == "npm:@pi/active-pkg@1.0.0").unwrap();
        assert_eq!(active_pkg["kind"], "package");
        assert_eq!(active_pkg["enabled"], true);
        assert_eq!(active_pkg["id"], "project:package:npm:@pi/active-pkg@1.0.0");

        // Verify disabled package with autoload: false and filters preserved
        let disabled_pkg = resources.iter().find(|r| r["source"] == "npm:@pi/disabled-pkg").unwrap();
        assert_eq!(disabled_pkg["kind"], "package");
        assert_eq!(disabled_pkg["enabled"], false);
        assert_eq!(disabled_pkg["autoload"], false);
        assert!(disabled_pkg.get("filters").is_some());
        assert_eq!(disabled_pkg["filters"]["extensions"], serde_json::json!(["ext/*.ts"]));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_get_pi_resources_impl_preservation_and_isolation() {
        let temp_dir = std::env::temp_dir().join(format!("test_isolation_pi_res_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let global_dir = temp_dir.join("global").join(".pi").join("agent");
        let project_dir = temp_dir.join("project").join(".pi");
        std::fs::create_dir_all(&global_dir).unwrap();
        std::fs::create_dir_all(&project_dir).unwrap();

        let global_file = global_dir.join("settings.json");
        let project_file = project_dir.join("settings.json");

        // Same package source in both global and project
        std::fs::write(&global_file, serde_json::to_string_pretty(&serde_json::json!({
            "packages": ["npm:shared-pkg", "npm:global-only-pkg"],
            "extensions": ["./global-ext.ts"]
        })).unwrap()).unwrap();

        std::fs::write(&project_file, serde_json::to_string_pretty(&serde_json::json!({
            "packages": [
                {
                    "source": "npm:shared-pkg",
                    "autoload": false
                }
            ],
            "extensions": ["./project-ext.ts"]
        })).unwrap()).unwrap();

        // 1. Query with only global (cwd is None)
        let global_only = get_pi_resources_impl(Some(&global_file), None).unwrap();
        let g_list = global_only["resources"].as_array().unwrap();
        assert_eq!(g_list.len(), 3);
        assert!(g_list.iter().all(|r| r["scope"] == "global"));

        // 2. Query with both global and project (MCP pattern: merged cards with hasProjectOverride)
        let both = get_pi_resources_impl(Some(&global_file), Some(&project_file)).unwrap();
        let b_list = both["resources"].as_array().unwrap();
        assert_eq!(b_list.len(), 4); // 4 merged items instead of 5 duplicate cards

        // Check shared package is merged into a single entry with project override
        let shared_entries: Vec<&Value> = b_list.iter().filter(|r| r["source"] == "npm:shared-pkg").collect();
        assert_eq!(shared_entries.len(), 1);
        let shared_pkg = shared_entries[0];
        assert_eq!(shared_pkg["scope"], "global");
        assert_eq!(shared_pkg["hasProjectOverride"], true);
        assert_eq!(shared_pkg["globalEnabled"], true);
        assert_eq!(shared_pkg["enabled"], false);
        assert_eq!(shared_pkg["autoload"], false);
        assert_eq!(shared_pkg["id"], "global:package:npm:shared-pkg");

        // Check global-only items have hasProjectOverride == false
        let global_only_pkg = b_list.iter().find(|r| r["source"] == "npm:global-only-pkg").unwrap();
        assert_eq!(global_only_pkg["hasProjectOverride"], false);
        assert_eq!(global_only_pkg["globalEnabled"], true);
        assert_eq!(global_only_pkg["enabled"], true);

        // Check project-only items have scope == "project" and hasProjectOverride == false
        let project_ext = b_list.iter().find(|r| r["source"] == "./project-ext.ts").unwrap();
        assert_eq!(project_ext["scope"], "project");
        assert_eq!(project_ext["hasProjectOverride"], false);
        assert_eq!(project_ext["enabled"], true);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_toggle_pi_resource_roundtrip_extension_and_package() {
        let temp_dir = std::env::temp_dir().join(format!("test_toggle_pi_res_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("settings.json");

        let initial = serde_json::json!({
            "unrelatedSetting": "preserved",
            "extensions": ["./my-extension.ts"],
            "packages": [
                "npm:simple-pkg",
                {
                    "source": "npm:filtered-pkg",
                    "skills": ["skills/review.md"],
                    "autoload": true
                }
            ]
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

        // 1. Toggle extension to disabled (should prepend '!')
        let ext_res = toggle_pi_resource_impl(&config_path, "extension", "./my-extension.ts", false, "project").unwrap();
        assert_eq!(ext_res["success"], true);
        assert_eq!(ext_res["enabled"], false);
        assert_eq!(ext_res["requiresReload"], true);

        let on_disk_1: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk_1["extensions"], serde_json::json!(["!./my-extension.ts"]));
        assert_eq!(on_disk_1["unrelatedSetting"], "preserved");

        // 2. Toggle extension back to enabled (should remove '!')
        let ext_res_2 = toggle_pi_resource_impl(&config_path, "extension", "./my-extension.ts", true, "project").unwrap();
        assert_eq!(ext_res_2["success"], true);
        assert_eq!(ext_res_2["enabled"], true);

        let on_disk_2: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk_2["extensions"], serde_json::json!(["./my-extension.ts"]));

        // 3. Toggle string package to disabled (should convert to object with autoload: false)
        let pkg_res = toggle_pi_resource_impl(&config_path, "package", "npm:simple-pkg", false, "project").unwrap();
        assert_eq!(pkg_res["success"], true);
        assert_eq!(pkg_res["enabled"], false);

        let on_disk_3: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let simple_entry = &on_disk_3["packages"][0];
        assert_eq!(simple_entry["source"], "npm:simple-pkg");
        assert_eq!(simple_entry["autoload"], false);

        // 4. Toggle filtered package to disabled (preserves skills filter and sets autoload: false)
        let filtered_res = toggle_pi_resource_impl(&config_path, "package", "npm:filtered-pkg", false, "project").unwrap();
        assert_eq!(filtered_res["success"], true);

        let on_disk_4: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let filtered_entry = &on_disk_4["packages"][1];
        assert_eq!(filtered_entry["source"], "npm:filtered-pkg");
        assert_eq!(filtered_entry["autoload"], false);
        assert_eq!(filtered_entry["skills"], serde_json::json!(["skills/review.md"]));

        // 5. Toggle filtered package back to enabled (removes autoload, keeps skills filter)
        let filtered_res_2 = toggle_pi_resource_impl(&config_path, "package", "npm:filtered-pkg", true, "project").unwrap();
        assert_eq!(filtered_res_2["success"], true);

        let on_disk_5: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        let filtered_entry_enabled = &on_disk_5["packages"][1];
        assert_eq!(filtered_entry_enabled["source"], "npm:filtered-pkg");
        assert!(filtered_entry_enabled.get("autoload").is_none() || filtered_entry_enabled.get("autoload") == Some(&Value::Bool(true)));
        assert_eq!(filtered_entry_enabled["skills"], serde_json::json!(["skills/review.md"]));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_pi_resource_add_edit_and_preserve_unrelated_keys() {
        let temp_dir = std::env::temp_dir().join(format!("test_save_pi_res_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("settings.json");

        let initial = serde_json::json!({
            "modelThinkingLevels": {
                "claude-3-7-sonnet": "high"
            },
            "npmCommand": ["pnpm"],
            "extensions": ["./initial-ext.ts"]
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

        // 1. Add new package
        let save_res = save_pi_resource_impl(
            &config_path,
            "package",
            "npm:@tools/helper@2.0.0",
            None,
            Some(true),
            None,
            "project",
        ).unwrap();
        assert_eq!(save_res["success"], true);
        assert_eq!(save_res["requiresReload"], true);

        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk["modelThinkingLevels"]["claude-3-7-sonnet"], "high");
        assert_eq!(on_disk["npmCommand"], serde_json::json!(["pnpm"]));
        assert_eq!(on_disk["packages"], serde_json::json!(["npm:@tools/helper@2.0.0"]));

        // 2. Edit/rename extension with old_source
        let edit_res = save_pi_resource_impl(
            &config_path,
            "extension",
            "./renamed-ext.ts",
            Some("./initial-ext.ts"),
            Some(false),
            None,
            "project",
        ).unwrap();
        assert_eq!(edit_res["success"], true);

        let on_disk_2: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk_2["extensions"], serde_json::json!(["!./renamed-ext.ts"]));
        // Verify unrelated keys preserved
        assert_eq!(on_disk_2["modelThinkingLevels"]["claude-3-7-sonnet"], "high");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_delete_pi_resource_and_error_cases() {
        let temp_dir = std::env::temp_dir().join(format!("test_delete_pi_res_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("settings.json");

        let initial = serde_json::json!({
            "extensions": ["./stay.ts", "!./delete-me.ts"],
            "packages": ["npm:stay-pkg", "npm:delete-pkg"]
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

        // 1. Delete disabled extension
        let del_ext = delete_pi_resource_impl(&config_path, "extension", "./delete-me.ts", "project").unwrap();
        assert_eq!(del_ext["success"], true);
        assert_eq!(del_ext["requiresReload"], true);

        // 2. Delete package
        let del_pkg = delete_pi_resource_impl(&config_path, "package", "npm:delete-pkg", "project").unwrap();
        assert_eq!(del_pkg["success"], true);

        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(on_disk["extensions"], serde_json::json!(["./stay.ts"]));
        assert_eq!(on_disk["packages"], serde_json::json!(["npm:stay-pkg"]));

        // 3. Error case: Delete non-existent resource
        let del_missing = delete_pi_resource_impl(&config_path, "extension", "./non-existent.ts", "project");
        assert!(del_missing.is_err());

        // 4. Error case: Toggle non-existent resource in global scope
        let toggle_missing = toggle_pi_resource_impl(&config_path, "package", "npm:non-existent", false, "global");
        assert!(toggle_missing.is_err());

        // 5. Error case: Invalid kind
        let invalid_kind = delete_pi_resource_impl(&config_path, "plugin", "./stay.ts", "project");
        assert!(invalid_kind.is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_extract_package_identity_and_matching() {
        assert_eq!(extract_package_identity("npm:@scope/my-pkg@1.2.3"), "@scope/my-pkg");
        assert_eq!(extract_package_identity("npm:@scope/my-pkg"), "@scope/my-pkg");
        assert_eq!(extract_package_identity("@scope/my-pkg@2.0.0"), "@scope/my-pkg");
        assert_eq!(extract_package_identity("npm:plain-tool@1.0.0"), "plain-tool");
        assert_eq!(extract_package_identity("npm:plain-tool"), "plain-tool");
        assert_eq!(extract_package_identity("git:github.com/org/repo@v1"), "github.com/org/repo");
        assert_eq!(extract_package_identity("git:github.com/org/repo.git"), "github.com/org/repo");
        assert_eq!(extract_package_identity("https://github.com/org/repo@v2"), "github.com/org/repo");
        assert_eq!(extract_package_identity("./local/path"), "./local/path");
        assert_eq!(extract_package_identity(".\\local\\path"), "./local/path");

        // Matching
        assert!(package_identities_match("npm:@scope/pkg@1.0.0", "npm:@scope/pkg"));
        assert!(package_identities_match("npm:@scope/pkg@1.0.0", "@scope/pkg@2.0.0"));
        assert!(package_identities_match("git:github.com/a/b@v1", "git:github.com/a/b@v2"));
        assert!(!package_identities_match("npm:pkg-a", "npm:pkg-b"));

        // Extension matching
        assert!(extension_sources_match("./my-ext.ts", "!./my-ext.ts"));
        assert!(extension_sources_match("./my-ext.ts", "+./my-ext.ts"));
        assert!(extension_sources_match("./my-ext.ts", "my-ext.ts"));
        assert!(!extension_sources_match("./ext-a.ts", "./ext-b.ts"));
    }

    #[test]
    fn test_toggle_pi_resource_project_override_on_inherited_global() {
        let temp_dir = std::env::temp_dir().join(format!("test_override_delta_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let global_dir = temp_dir.join("global").join(".pi").join("agent");
        let project_dir = temp_dir.join("project").join(".pi");
        std::fs::create_dir_all(&global_dir).unwrap();
        std::fs::create_dir_all(&project_dir).unwrap();

        let global_file = global_dir.join("settings.json");
        let project_file = project_dir.join("settings.json");

        // Global has an enabled extension and an enabled package
        std::fs::write(&global_file, serde_json::to_string_pretty(&serde_json::json!({
            "extensions": ["./global-helper.ts"],
            "packages": ["npm:@pi/code-review@1.0.0"]
        })).unwrap()).unwrap();

        // Project file is initially empty or nonexistent
        // 1. Toggle global extension to disabled in project scope
        let ext_override = toggle_pi_resource_impl(&project_file, "extension", "./global-helper.ts", false, "project").unwrap();
        assert_eq!(ext_override["success"], true);
        assert_eq!(ext_override["enabled"], false);

        // Verify project file now has `!./global-helper.ts`
        let proj_disk: Value = serde_json::from_str(&std::fs::read_to_string(&project_file).unwrap()).unwrap();
        assert_eq!(proj_disk["extensions"], serde_json::json!(["!./global-helper.ts"]));

        // Verify global file was not mutated
        let glob_disk: Value = serde_json::from_str(&std::fs::read_to_string(&global_file).unwrap()).unwrap();
        assert_eq!(glob_disk["extensions"], serde_json::json!(["./global-helper.ts"]));

        // 2. Query merged resources - should return 1 card with hasProjectOverride == true and enabled == false
        let merged_1 = get_pi_resources_impl(Some(&global_file), Some(&project_file)).unwrap();
        let res_1 = merged_1["resources"].as_array().unwrap();
        let ext_card = res_1.iter().find(|r| r["source"] == "./global-helper.ts").unwrap();
        assert_eq!(ext_card["hasProjectOverride"], true);
        assert_eq!(ext_card["globalEnabled"], true);
        assert_eq!(ext_card["enabled"], false);
        assert_eq!(ext_card["scope"], "global");

        // 3. Toggle global package to disabled in project scope
        let pkg_override = toggle_pi_resource_impl(&project_file, "package", "npm:@pi/code-review", false, "project").unwrap();
        assert_eq!(pkg_override["success"], true);
        assert_eq!(pkg_override["enabled"], false);

        // Verify project file has autoload: false
        let proj_disk_2: Value = serde_json::from_str(&std::fs::read_to_string(&project_file).unwrap()).unwrap();
        let pkg_entry = &proj_disk_2["packages"][0];
        assert_eq!(pkg_entry["source"], "npm:@pi/code-review");
        assert_eq!(pkg_entry["autoload"], false);

        // 4. Query merged resources again
        let merged_2 = get_pi_resources_impl(Some(&global_file), Some(&project_file)).unwrap();
        let res_2 = merged_2["resources"].as_array().unwrap();
        assert_eq!(res_2.len(), 2);
        let pkg_card = res_2.iter().find(|r| r["name"] == "@pi/code-review").unwrap();
        assert_eq!(pkg_card["hasProjectOverride"], true);
        assert_eq!(pkg_card["globalEnabled"], true);
        assert_eq!(pkg_card["enabled"], false);
        assert_eq!(pkg_card["autoload"], false);

        // 5. Delete project override for extension - should revert to global inheritance
        let del_override = delete_pi_resource_impl(&project_file, "extension", "./global-helper.ts", "project").unwrap();
        assert_eq!(del_override["success"], true);

        let merged_3 = get_pi_resources_impl(Some(&global_file), Some(&project_file)).unwrap();
        let res_3 = merged_3["resources"].as_array().unwrap();
        let ext_card_reverted = res_3.iter().find(|r| r["source"] == "./global-helper.ts").unwrap();
        assert_eq!(ext_card_reverted["hasProjectOverride"], false);
        assert_eq!(ext_card_reverted["enabled"], true);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_tauri_commands_pi_resources() {
        let temp_dir = std::env::temp_dir().join(format!("test_tauri_pi_res_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let project_pi = temp_dir.join(".pi");
        std::fs::create_dir_all(&project_pi).unwrap();

        let temp_str = temp_dir.to_string_lossy().to_string();

        // 1. Save new extension via save_pi_resource command
        let save_res = save_pi_resource(
            Some(temp_str.clone()),
            Some("project".to_string()),
            "extension".to_string(),
            "./tool.ts".to_string(),
            None,
            Some(true),
            None,
        ).await.unwrap();
        assert_eq!(save_res["success"], true);
        assert_eq!(save_res["requiresReload"], true);

        // 2. Query resources via get_pi_resources command
        let list_res = get_pi_resources(Some(temp_str.clone())).await.unwrap();
        let res_arr = list_res["resources"].as_array().unwrap();
        let found = res_arr.iter().find(|r| r["source"] == "./tool.ts").unwrap();
        assert_eq!(found["kind"], "extension");
        assert_eq!(found["enabled"], true);

        // 3. Toggle extension via toggle_pi_resource command
        let toggle_res = toggle_pi_resource(
            Some(temp_str.clone()),
            Some("project".to_string()),
            "extension".to_string(),
            "./tool.ts".to_string(),
            false,
        ).await.unwrap();
        assert_eq!(toggle_res["success"], true);
        assert_eq!(toggle_res["enabled"], false);

        // 4. Delete extension via delete_pi_resource command
        let del_res = delete_pi_resource(
            Some(temp_str.clone()),
            Some("project".to_string()),
            "extension".to_string(),
            "./tool.ts".to_string(),
        ).await.unwrap();
        assert_eq!(del_res["success"], true);

        let list_res_2 = get_pi_resources(Some(temp_str.clone())).await.unwrap();
        assert!(!list_res_2["resources"].as_array().unwrap().iter().any(|r| r["source"] == "./tool.ts"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_normalize_target_source_rejects_bare_markers_and_whitespace() {
        assert!(normalize_target_source("extension", "!").is_err());
        assert!(normalize_target_source("extension", "!   ").is_err());
        assert!(normalize_target_source("extension", "+").is_err());
        assert!(normalize_target_source("extension", "+   ").is_err());
        assert!(normalize_target_source("extension", "   ").is_err());
        assert!(normalize_target_source("extension", "").is_err());

        assert!(normalize_target_source("package", "!").is_ok()); // package treats '!' as part of spec if present
        assert!(normalize_target_source("package", "   ").is_err());
        assert!(normalize_target_source("package", "").is_err());

        assert_eq!(normalize_target_source("extension", "!./my-tool.ts").unwrap(), "./my-tool.ts");
        assert_eq!(normalize_target_source("extension", "./my-tool.ts").unwrap(), "./my-tool.ts");
        assert_eq!(normalize_target_source("package", "npm:pkg").unwrap(), "npm:pkg");
    }

    #[test]
    fn test_bare_marker_and_malformed_entries_rejection_proves_no_file_changes() {
        let temp_dir = std::env::temp_dir().join(format!("test_regression_bare_marker_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        let config_path = temp_dir.join("settings.json");

        let initial_json = serde_json::json!({
            "keepMe": 12345,
            "extensions": [
                {},
                { "unrelated": "val" },
                "",
                "!",
                "!   ",
                "./valid-ext.ts"
            ],
            "packages": [
                {},
                { "autoload": false },
                "",
                "npm:valid-pkg"
            ]
        });
        let initial_content = serde_json::to_string_pretty(&initial_json).unwrap();
        std::fs::write(&config_path, &initial_content).unwrap();

        // 1. Verify resource_exists_in_file rejects bare markers and empty targets
        assert!(!resource_exists_in_file(&config_path, "extension", "!"));
        assert!(!resource_exists_in_file(&config_path, "extension", "!   "));
        assert!(!resource_exists_in_file(&config_path, "extension", "   "));
        assert!(!resource_exists_in_file(&config_path, "extension", ""));
        assert!(!resource_exists_in_file(&config_path, "package", "   "));
        assert!(!resource_exists_in_file(&config_path, "package", ""));

        // Valid resources still resolve existence
        assert!(resource_exists_in_file(&config_path, "extension", "./valid-ext.ts"));
        assert!(resource_exists_in_file(&config_path, "package", "npm:valid-pkg"));

        // 2. Verify toggle rejects bare markers and empty targets
        assert!(toggle_pi_resource_impl(&config_path, "extension", "!", false, "project").is_err());
        assert!(toggle_pi_resource_impl(&config_path, "extension", "!   ", false, "project").is_err());
        assert!(toggle_pi_resource_impl(&config_path, "extension", "   ", true, "project").is_err());
        assert!(toggle_pi_resource_impl(&config_path, "extension", "", true, "project").is_err());
        assert!(toggle_pi_resource_impl(&config_path, "package", "   ", false, "project").is_err());
        assert!(toggle_pi_resource_impl(&config_path, "package", "", false, "project").is_err());

        // 3. Verify delete rejects bare markers and empty targets
        assert!(delete_pi_resource_impl(&config_path, "extension", "!", "project").is_err());
        assert!(delete_pi_resource_impl(&config_path, "extension", "!   ", "project").is_err());
        assert!(delete_pi_resource_impl(&config_path, "extension", "   ", "project").is_err());
        assert!(delete_pi_resource_impl(&config_path, "extension", "", "project").is_err());
        assert!(delete_pi_resource_impl(&config_path, "package", "   ", "project").is_err());
        assert!(delete_pi_resource_impl(&config_path, "package", "", "project").is_err());

        // 4. Verify file content on disk is bit-for-bit UNTOUCHED after all rejected operations
        let after_content = std::fs::read_to_string(&config_path).unwrap();
        assert_eq!(initial_content, after_content, "File on disk must remain unchanged after rejected bare marker operations");

        // 5. Verify deleting a valid resource removes only the targeted item and does not touch keyless/malformed entries
        let del_res = delete_pi_resource_impl(&config_path, "extension", "./valid-ext.ts", "project").unwrap();
        assert_eq!(del_res["success"], true);

        let mutated: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(mutated["keepMe"], 12345);
        let exts = mutated["extensions"].as_array().unwrap();
        // The valid extension was removed, malformed entries remain intact
        assert!(!exts.iter().any(|e| e.as_str() == Some("./valid-ext.ts")));
        assert!(exts.iter().any(|e| e.is_object() && e.as_object().unwrap().is_empty()));
        assert!(exts.iter().any(|e| e.get("unrelated") == Some(&Value::String("val".to_string()))));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_derive_resource_name_and_extension_sources_match() {
        // derive_resource_name folder/index.ts pattern
        assert_eq!(derive_resource_name("extension", "extensions/cpamc-auto-switcher/index.ts"), "cpamc-auto-switcher");
        assert_eq!(derive_resource_name("extension", "cpamc-auto-switcher/index.ts"), "cpamc-auto-switcher");
        assert_eq!(derive_resource_name("extension", "extensions/cpamc-auto-switcher/index.js"), "cpamc-auto-switcher");
        assert_eq!(derive_resource_name("extension", "extensions/my-tool.ts"), "my-tool.ts");
        assert_eq!(derive_resource_name("extension", "my-tool.ts"), "my-tool.ts");
        assert_eq!(derive_resource_name("extension", "extensions/index.ts"), "index.ts");
        assert_eq!(derive_resource_name("extension", "!extensions/cpamc-auto-switcher/index.ts"), "cpamc-auto-switcher");

        // extension_sources_match
        assert!(extension_sources_match("extensions/cpamc-auto-switcher/index.ts", "!extensions/cpamc-auto-switcher/index.ts"));
        assert!(extension_sources_match("extensions/cpamc-auto-switcher/index.ts", "cpamc-auto-switcher/index.ts"));
        assert!(extension_sources_match("extensions/cpamc-auto-switcher/index.ts", "cpamc-auto-switcher"));
        assert!(extension_sources_match("cpamc-auto-switcher", "extensions/cpamc-auto-switcher/index.ts"));
        assert!(extension_sources_match("extensions/cpamc-auto-switcher", "extensions/cpamc-auto-switcher/index.ts"));
        assert!(extension_sources_match("-extensions/cpamc-auto-switcher/index.ts", "cpamc-auto-switcher"));
        assert!(!extension_sources_match("extensions/tool.ts", "extensions/other.ts"));
    }

    #[test]
    fn test_discover_extensions_in_dir_file_and_subdirectory() {
        let temp_dir = std::env::temp_dir().join(format!("test_discover_ext_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let ext_dir = temp_dir.join("extensions");
        std::fs::create_dir_all(&ext_dir).unwrap();

        // 1. Direct file
        std::fs::write(ext_dir.join("my-tool.ts"), "// tool").unwrap();
        // 2. Direct file .d.ts should be ignored
        std::fs::write(ext_dir.join("ignored.d.ts"), "// types").unwrap();
        // 3. Hidden file should be ignored
        std::fs::write(ext_dir.join(".hidden.ts"), "// hidden").unwrap();

        // 4. Subdirectory with index.ts
        let sub_a = ext_dir.join("cpamc-auto-switcher");
        std::fs::create_dir_all(&sub_a).unwrap();
        std::fs::write(sub_a.join("index.ts"), "// index").unwrap();

        // 5. Subdirectory with package.json
        let sub_b = ext_dir.join("manifest-pkg");
        std::fs::create_dir_all(&sub_b).unwrap();
        std::fs::write(sub_b.join("package.json"), serde_json::to_string_pretty(&serde_json::json!({
            "name": "cool-extension-pkg",
            "pi": {
                "extensions": ["./entry.js"]
            }
        })).unwrap()).unwrap();
        std::fs::write(sub_b.join("entry.js"), "// entry").unwrap();

        // 6. node_modules should be ignored
        let nm = ext_dir.join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("bad.ts"), "// bad").unwrap();

        let discovered = discover_extensions_in_dir(&ext_dir, "global");
        assert_eq!(discovered.len(), 3);

        let tool_ext = discovered.iter().find(|e| e["source"] == "extensions/my-tool.ts").unwrap();
        assert_eq!(tool_ext["name"], "my-tool.ts");
        assert_eq!(tool_ext["enabled"], true);
        assert_eq!(tool_ext["kind"], "extension");
        assert_eq!(tool_ext["scope"], "global");

        let switcher_ext = discovered.iter().find(|e| e["source"] == "extensions/cpamc-auto-switcher/index.ts").unwrap();
        assert_eq!(switcher_ext["name"], "cpamc-auto-switcher");
        assert_eq!(switcher_ext["enabled"], true);

        let pkg_ext = discovered.iter().find(|e| e["source"] == "extensions/manifest-pkg/entry.js").unwrap();
        assert_eq!(pkg_ext["name"], "cool-extension-pkg");
        assert_eq!(pkg_ext["enabled"], true);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_autodiscovered_extensions_get_and_toggle_project_override() {
        let temp_dir = std::env::temp_dir().join(format!("test_auto_override_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let global_agent = temp_dir.join("global").join(".pi").join("agent");
        let global_exts = global_agent.join("extensions");
        let project_pi = temp_dir.join("project").join(".pi");
        std::fs::create_dir_all(&global_exts).unwrap();
        std::fs::create_dir_all(&project_pi).unwrap();

        let global_settings = global_agent.join("settings.json");
        let project_settings = project_pi.join("settings.json");

        // Write empty global settings
        std::fs::write(&global_settings, serde_json::to_string_pretty(&serde_json::json!({})).unwrap()).unwrap();

        // Create auto-discovered extensions in global
        std::fs::write(global_exts.join("helper.ts"), "// helper").unwrap();
        let switcher_dir = global_exts.join("cpamc-auto-switcher");
        std::fs::create_dir_all(&switcher_dir).unwrap();
        std::fs::write(switcher_dir.join("index.ts"), "// index").unwrap();

        // 1. Initial query: both are discovered, enabled, no project override
        let initial_res = get_pi_resources_impl(Some(&global_settings), Some(&project_settings)).unwrap();
        let initial_arr = initial_res["resources"].as_array().unwrap();
        assert_eq!(initial_arr.len(), 2);

        let helper_card = initial_arr.iter().find(|r| r["source"] == "extensions/helper.ts").unwrap();
        assert_eq!(helper_card["name"], "helper.ts");
        assert_eq!(helper_card["enabled"], true);
        assert_eq!(helper_card["globalEnabled"], true);
        assert_eq!(helper_card["hasProjectOverride"], false);

        let switcher_card = initial_arr.iter().find(|r| r["source"] == "extensions/cpamc-auto-switcher/index.ts").unwrap();
        assert_eq!(switcher_card["name"], "cpamc-auto-switcher");
        assert_eq!(switcher_card["enabled"], true);
        assert_eq!(switcher_card["hasProjectOverride"], false);

        // 2. Disable cpamc-auto-switcher for project scope
        let toggle_res = toggle_pi_resource_impl(
            &project_settings,
            "extension",
            "extensions/cpamc-auto-switcher/index.ts",
            false,
            "project",
        ).unwrap();
        assert_eq!(toggle_res["success"], true);
        assert_eq!(toggle_res["enabled"], false);

        // Verify project settings file now contains exclusion
        let proj_disk: Value = serde_json::from_str(&std::fs::read_to_string(&project_settings).unwrap()).unwrap();
        assert_eq!(proj_disk["extensions"], serde_json::json!(["!extensions/cpamc-auto-switcher/index.ts"]));

        // 3. Query merged resources: cpamc-auto-switcher should be disabled with hasProjectOverride == true
        let overridden_res = get_pi_resources_impl(Some(&global_settings), Some(&project_settings)).unwrap();
        let overridden_arr = overridden_res["resources"].as_array().unwrap();
        assert_eq!(overridden_arr.len(), 2); // No duplicate cards!

        let overridden_switcher = overridden_arr.iter().find(|r| r["source"] == "extensions/cpamc-auto-switcher/index.ts").unwrap();
        assert_eq!(overridden_switcher["name"], "cpamc-auto-switcher");
        assert_eq!(overridden_switcher["enabled"], false);
        assert_eq!(overridden_switcher["globalEnabled"], true);
        assert_eq!(overridden_switcher["hasProjectOverride"], true);

        // 4. Re-enable cpamc-auto-switcher for project scope -> exclusion should be removed
        let toggle_re_enable = toggle_pi_resource_impl(
            &project_settings,
            "extension",
            "extensions/cpamc-auto-switcher/index.ts",
            true,
            "project",
        ).unwrap();
        assert_eq!(toggle_re_enable["success"], true);
        assert_eq!(toggle_re_enable["enabled"], true);

        let proj_disk_re_enabled: Value = serde_json::from_str(&std::fs::read_to_string(&project_settings).unwrap()).unwrap();
        let exts_arr = proj_disk_re_enabled["extensions"].as_array().unwrap();
        assert!(exts_arr.is_empty(), "Exclusion should be removed when re-enabling auto-discovered extension");

        // 5. Query merged resources: reverts to default enabled
        let reverted_res = get_pi_resources_impl(Some(&global_settings), Some(&project_settings)).unwrap();
        let reverted_arr = reverted_res["resources"].as_array().unwrap();
        assert_eq!(reverted_arr.len(), 2);
        let reverted_switcher = reverted_arr.iter().find(|r| r["source"] == "extensions/cpamc-auto-switcher/index.ts").unwrap();
        assert_eq!(reverted_switcher["enabled"], true);
        assert_eq!(reverted_switcher["hasProjectOverride"], false);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_sdd_profile_sanitize_and_synthetic_keys() {
        assert_eq!(sanitize_profile_name("  My Profile Name! 123 "), "my-profile-name--123");
        assert_eq!(sanitize_profile_name("speed-economy"), "speed-economy");
        assert_eq!(sanitize_profile_name("Balanced_Default"), "balanced_default");

        assert!(is_synthetic_agent_key(""));
        assert!(is_synthetic_agent_key("   "));
        assert!(is_synthetic_agent_key("⚡ Fast"));
        assert!(is_synthetic_agent_key("🧠 Deep"));
        assert!(is_synthetic_agent_key("📦 Box"));
        assert!(is_synthetic_agent_key("👑 King"));
        assert!(is_synthetic_agent_key("[Asignar Modelo]"));
        assert!(is_synthetic_agent_key("agent with spaces"));

        assert!(!is_synthetic_agent_key("sdd-explore"));
        assert!(!is_synthetic_agent_key("gentle-ai-worker"));
        assert!(!is_synthetic_agent_key("custom_agent_1"));
    }

    #[test]
    fn test_apply_profile_to_subagents_file() {
        let temp_dir = std::env::temp_dir().join(format!("test_apply_subagents_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let subagents_file = temp_dir.join("subagents.json");

        // Write existing file with extra custom keys
        std::fs::write(&subagents_file, serde_json::to_string_pretty(&serde_json::json!({
            "custom_setting": 42,
            "timeout_ms": 5000
        })).unwrap()).unwrap();

        let profile = serde_json::json!({
            "name": "my-test-profile",
            "default_model": "test-provider/test-model",
            "default_effort": "high",
            "model_profiles": {
                "sdd-explore": { "model": "test-provider/test-fast", "effort": "low" },
                "⚡ Fast": { "model": "ignored" }
            }
        });

        apply_profile_to_subagents_file(&subagents_file, &profile).unwrap();

        let updated: Value = serde_json::from_str(&std::fs::read_to_string(&subagents_file).unwrap()).unwrap();
        assert_eq!(updated["custom_setting"], 42);
        assert_eq!(updated["timeout_ms"], 5000);
        assert_eq!(updated["default_model"], "test-provider/test-model");
        assert_eq!(updated["default_effort"], "high");
        assert_eq!(updated["active_profile"], "my-test-profile");
        assert_eq!(updated["model_profiles"]["sdd-explore"]["model"], "test-provider/test-fast");
        assert_eq!(updated["model_profiles"]["sdd-explore"]["effort"], "low");
        assert!(updated["model_profiles"].get("⚡ Fast").is_none());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    static CRUD_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    async fn run_sdd_profiles_crud_and_isolation() {
        let count = CRUD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp_dir = std::env::temp_dir().join(format!("test_sdd_crud_{}_{}", std::process::id(), count));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let global_agent = temp_dir.join("global_agent");
        std::fs::create_dir_all(&global_agent).unwrap();
        std::env::set_var("PI_GLOBAL_AGENT_DIR", &global_agent);

        let cwd = temp_dir.join("project");
        let cwd_str = cwd.to_string_lossy().to_string();

        let proj_profiles = cwd.join(".pi").join("profiles");
        std::fs::create_dir_all(&proj_profiles).unwrap();

        // 1. Initial query: no project profiles configured, active is None
        let initial = get_sdd_profiles(Some(cwd_str.clone())).await.unwrap();
        assert!(initial["projectActiveProfile"].is_null());
        assert_eq!(
            initial["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["scope"] == "project")
                .count(),
            0
        );

        // 2. Save a project profile
        let save_res = save_sdd_profile(
            Some(cwd_str.clone()),
            Some("project".to_string()),
            serde_json::json!({
                "name": "project-custom",
                "description": "Custom for project",
                "default_model": "test/model-1",
                "model_profiles": {
                    "my-custom-subagent": { "model": "test/model-2" }
                }
            })
        ).await.unwrap();
        assert_eq!(save_res["success"], true);

        // 3. Query profiles: should list project-custom with agent_count 1,
        // but saved profile overrides alone MUST NOT make an agent appear installed in categories
        let queried = get_sdd_profiles(Some(cwd_str.clone())).await.unwrap();
        let profiles = queried["profiles"].as_array().unwrap();
        let custom_summary = profiles.iter().find(|p| p["name"] == "project-custom").unwrap();
        assert_eq!(custom_summary["scope"], "project");
        assert_eq!(custom_summary["agent_count"], 1);

        let categories = queried["categories"].as_array().unwrap();
        let subagent_installed = categories.iter().any(|c| {
            c.get("agents")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().any(|v| v == "my-custom-subagent"))
                .unwrap_or(false)
        });
        assert!(!subagent_installed, "Profile-only override must not make an agent appear installed");

        // 4. Set project active profile
        let act_res = set_active_sdd_profile(
            Some(cwd_str.clone()),
            Some("project".to_string()),
            Some("project-custom".to_string())
        ).await.unwrap();
        assert_eq!(act_res["success"], true);

        // Verify .pi/subagents.json was updated with project-custom settings
        let proj_subagents = cwd.join(".pi").join("subagents.json");
        assert!(proj_subagents.is_file());
        let subagents_val: Value = serde_json::from_str(&std::fs::read_to_string(&proj_subagents).unwrap()).unwrap();
        assert_eq!(subagents_val["active_profile"], "project-custom");
        assert_eq!(subagents_val["default_model"], "test/model-1");

        // 5. Query profiles: effective profile is project-custom with project scope
        let active_query = get_sdd_profiles(Some(cwd_str.clone())).await.unwrap();
        assert_eq!(active_query["effectiveActiveProfile"], "project-custom");
        assert_eq!(active_query["effectiveScope"], "project");
        assert_eq!(active_query["projectActiveProfile"], "project-custom");

        // Configured agents in subagents.json are discovered as runtime agents
        let active_cats = active_query["categories"].as_array().unwrap();
        let configured_found = active_cats.iter().any(|c| {
            c.get("agents")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().any(|v| v == "my-custom-subagent"))
                .unwrap_or(false)
        });
        assert!(configured_found, "Configured subagents.json agent should be discovered");

        // 6. Clear project active profile -> should fall back to None
        let clear_res = set_active_sdd_profile(
            Some(cwd_str.clone()),
            Some("project".to_string()),
            None
        ).await.unwrap();
        assert_eq!(clear_res["success"], true);

        let cleared_query = get_sdd_profiles(Some(cwd_str.clone())).await.unwrap();
        assert!(cleared_query["effectiveActiveProfile"].is_null());
        assert!(cleared_query["effectiveScope"].is_null());
        assert!(cleared_query["projectActiveProfile"].is_null());

        // 7. Delete the project profile
        let del_res = delete_sdd_profile(
            Some(cwd_str.clone()),
            Some("project".to_string()),
            "project-custom".to_string()
        ).await.unwrap();
        assert_eq!(del_res["success"], true);

        let post_del_query = get_sdd_profiles(Some(cwd_str.clone())).await.unwrap();
        let post_profiles = post_del_query["profiles"].as_array().unwrap();
        assert!(post_profiles.iter().all(|p| p["name"] != "project-custom"));

        let _ = std::fs::remove_dir_all(&temp_dir);
        std::env::remove_var("PI_GLOBAL_AGENT_DIR");
    }

    #[tokio::test]
    async fn test_sdd_profiles_crud_and_isolation() {
        run_sdd_profiles_crud_and_isolation().await;
    }

    #[tokio::test]
    async fn test_sdd_profiles_crud_isolation_and_fallback() {
        run_sdd_profiles_crud_and_isolation().await;
    }

    #[tokio::test]
    async fn test_sdd_profile_runtime_activation() {
        let temp_dir = std::env::temp_dir().join(format!(
            "test_sdd_activation_{}_{}",
            std::process::id(),
            CRUD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let global_dir = temp_dir.join("global_profiles");
        let project_dir = temp_dir.join("project").join(".pi").join("profiles");
        let project_subagents = temp_dir.join("project").join(".pi").join("subagents.json");
        std::fs::create_dir_all(&global_dir).unwrap();
        std::fs::create_dir_all(&project_dir).unwrap();

        // 1. Directory scan fallback: filename differs from display name
        // File is named `arbitrary_slug.json`, but inner JSON name is `Multi-Word Display Name`
        let custom_file = project_dir.join("arbitrary_slug.json");
        let profile_content = serde_json::json!({
            "name": "Multi-Word Display Name",
            "description": "Profile with non-matching filename",
            "default_model": "openrouter/anthropic/claude-3.5-sonnet",
            "default_effort": "high",
            "model_profiles": {
                "sdd-planner": { "model": "openai/o3-mini", "effort": "low" }
            }
        });
        std::fs::write(&custom_file, serde_json::to_string_pretty(&profile_content).unwrap()).unwrap();

        // Activating with display name should succeed via directory scan fallback
        let act_res = set_active_sdd_profile_with_dirs(
            &project_dir,
            &project_subagents,
            Some(&global_dir),
            Some("Multi-Word Display Name"),
            true,
        ).unwrap();
        assert_eq!(act_res["success"], true);

        // Verify .active was written and subagents.json contains the profile's settings
        let active_val = std::fs::read_to_string(project_dir.join(".active")).unwrap();
        assert_eq!(active_val.trim(), "Multi-Word Display Name");

        let subagents_val: Value = serde_json::from_str(&std::fs::read_to_string(&project_subagents).unwrap()).unwrap();
        assert_eq!(subagents_val["active_profile"], "Multi-Word Display Name");
        assert_eq!(subagents_val["default_model"], "openrouter/anthropic/claude-3.5-sonnet");
        assert_eq!(subagents_val["default_effort"], "high");
        assert_eq!(subagents_val["model_profiles"]["sdd-planner"]["model"], "openai/o3-mini");
        assert_eq!(subagents_val["model_profiles"]["sdd-planner"]["effort"], "low");

        // 2. Honest failure for missing profile: must return success: false and NOT write .active
        let fail_res = set_active_sdd_profile_with_dirs(
            &project_dir,
            &project_subagents,
            Some(&global_dir),
            Some("Completely-Non-Existent-Profile"),
            true,
        ).unwrap();
        assert_eq!(fail_res["success"], false);
        assert!(fail_res["message"].as_str().unwrap().contains("not found"));

        // 3. Clear project profile when a global active profile exists -> applies global profile to project subagents.json
        let global_profile_content = serde_json::json!({
            "name": "Global Fallback Profile",
            "default_model": "anthropic/claude-3-7-sonnet",
            "default_effort": "medium",
            "model_profiles": {
                "sdd-verifier": { "model": "anthropic/claude-haiku", "effort": "low" }
            }
        });
        std::fs::write(
            global_dir.join("global_fallback.json"),
            serde_json::to_string_pretty(&global_profile_content).unwrap(),
        ).unwrap();
        std::fs::write(global_dir.join(".active"), "Global Fallback Profile").unwrap();

        let clear_res = set_active_sdd_profile_with_dirs(
            &project_dir,
            &project_subagents,
            Some(&global_dir),
            None,
            true,
        ).unwrap();
        assert_eq!(clear_res["success"], true);

        // Project .active is removed
        assert!(!project_dir.join(".active").exists());

        // Project subagents.json now has global fallback applied
        let fallback_subagents: Value = serde_json::from_str(&std::fs::read_to_string(&project_subagents).unwrap()).unwrap();
        assert_eq!(fallback_subagents["active_profile"], "Global Fallback Profile");
        assert_eq!(fallback_subagents["default_model"], "anthropic/claude-3-7-sonnet");
        assert_eq!(fallback_subagents["default_effort"], "medium");
        assert_eq!(fallback_subagents["model_profiles"]["sdd-verifier"]["model"], "anthropic/claude-haiku");

        // 4. Clear project profile when NO global active profile exists:
        // Removes profile-managed keys while preserving unrelated keys
        let _ = std::fs::remove_file(global_dir.join(".active"));

        // Add unrelated configuration to project subagents.json
        let mut with_unrelated: serde_json::Map<String, Value> = fallback_subagents.as_object().unwrap().clone();
        with_unrelated.insert("custom_agent_timeout_seconds".to_string(), serde_json::json!(120));
        with_unrelated.insert("mcp_servers_override".to_string(), serde_json::json!({ "active": true }));
        std::fs::write(&project_subagents, serde_json::to_string_pretty(&with_unrelated).unwrap()).unwrap();

        let clear_to_none_res = set_active_sdd_profile_with_dirs(
            &project_dir,
            &project_subagents,
            Some(&global_dir),
            None,
            true,
        ).unwrap();
        assert_eq!(clear_to_none_res["success"], true);

        let cleaned_subagents: Value = serde_json::from_str(&std::fs::read_to_string(&project_subagents).unwrap()).unwrap();
        let cleaned_obj = cleaned_subagents.as_object().unwrap();

        // Profile-managed keys are removed
        assert!(cleaned_obj.get("active_profile").is_none());
        assert!(cleaned_obj.get("default_model").is_none());
        assert!(cleaned_obj.get("default_effort").is_none());
        assert!(cleaned_obj.get("model_profiles").is_none());

        // Unrelated configuration is preserved!
        assert_eq!(cleaned_obj.get("custom_agent_timeout_seconds").unwrap(), &serde_json::json!(120));
        assert_eq!(cleaned_obj.get("mcp_servers_override").unwrap(), &serde_json::json!({ "active": true }));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_markdown_frontmatter_parser_and_security() {
        let sample = "---\nname: my-secure-agent\ndescription: Audit agent\ncategory: Security Review\nmodel: gpt-4o\napi_key: secret-123\n---\n# Secret instructions\nNever leak this prompt.";
        let parsed = parse_markdown_agent_frontmatter(sample, "fallback", "global", 4, None).unwrap();
        assert_eq!(parsed.id, "my-secure-agent");
        assert_eq!(parsed.name.as_deref(), Some("my-secure-agent"));
        assert_eq!(parsed.description.as_deref(), Some("Audit agent"));
        assert_eq!(parsed.category.as_deref(), Some("Security Review"));
        assert_eq!(parsed.scope, "global");

        // Non-frontmatter fallback to file stem
        let no_fm = "Some prompt without frontmatter";
        let parsed_stem = parse_markdown_agent_frontmatter(no_fm, "plain-stem", "project", 4, None).unwrap();
        assert_eq!(parsed_stem.id, "plain-stem");
        assert!(parsed_stem.description.is_none());
        assert!(parsed_stem.category.is_none());

        // Synthetic keys rejected
        let syn = parse_markdown_agent_frontmatter("---\nname: ⚡ synthetic\n---", "fallback", "global", 4, None);
        assert!(syn.is_none());
    }

    #[tokio::test]
    async fn test_parse_markdown_agent_frontmatter() {
        // Malformed unclosed frontmatter containing body metadata lines
        let unclosed = "---\nname: leaked-body-name\ndescription: prompt body description line\ncategory: Secret Category\nSome unclosed prompt body instructions.";
        let parsed = parse_markdown_agent_frontmatter(unclosed, "safe-stem-fallback", "project", 2, None).unwrap();

        // Must fail closed: expose no body content and fall back safely to file-stem
        assert_eq!(parsed.id, "safe-stem-fallback");
        assert_eq!(parsed.name.as_deref(), Some("safe-stem-fallback"));
        assert!(
            parsed.description.is_none(),
            "Expected no description when frontmatter delimiter is unclosed, got: {:?}",
            parsed.description
        );
        assert!(
            parsed.category.is_none(),
            "Expected no category when frontmatter delimiter is unclosed, got: {:?}",
            parsed.category
        );

        // Triangulation: single delimiter without newline or closing
        let single_delim = "---";
        let parsed_single = parse_markdown_agent_frontmatter(single_delim, "stem-fallback", "global", 1, None).unwrap();
        assert_eq!(parsed_single.id, "stem-fallback");
        assert!(parsed_single.description.is_none());

        // Triangulation: unclosed frontmatter with synthetic name in body does not reject safe stem
        let unclosed_syn_body = "---\nname: ⚡ synthetic-in-body\ndescription: body line";
        let parsed_unclosed_syn = parse_markdown_agent_frontmatter(unclosed_syn_body, "safe-stem", "project", 2, None).unwrap();
        assert_eq!(parsed_unclosed_syn.id, "safe-stem");
        assert!(parsed_unclosed_syn.description.is_none());

        // Triangulation: properly closed frontmatter continues to parse correctly
        let closed = "---\nname: legit-agent\ndescription: Legit agent description\n---\nPrompt body here";
        let parsed_closed = parse_markdown_agent_frontmatter(closed, "ignored-stem", "global", 1, None).unwrap();
        assert_eq!(parsed_closed.id, "legit-agent");
        assert_eq!(parsed_closed.name.as_deref(), Some("legit-agent"));
        assert_eq!(parsed_closed.description.as_deref(), Some("Legit agent description"));
    }

    #[tokio::test]
    async fn test_dynamic_agent_discovery_crud_and_lifecycle() {
        let temp_dir = std::env::temp_dir().join(format!("test_agent_lifecycle_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let global_dir = temp_dir.join("global_agent");
        let cwd = temp_dir.join("project");

        let proj_agents_dir = cwd.join(".pi").join("agents");
        std::fs::create_dir_all(&proj_agents_dir).unwrap();

        let global_agents_dir = global_dir.join("agents");
        std::fs::create_dir_all(&global_agents_dir).unwrap();

        // 1. Initial state: no agent definitions in isolated environment -> empty categories
        let empty_query = discover_sdd_profiles_impl(None, Some(&cwd)).unwrap();
        assert_eq!(empty_query["categories"].as_array().unwrap().len(), 0);
        assert_eq!(empty_query["allAgents"].as_array().unwrap().len(), 0);

        // 2. Add an arbitrary newly defined agent with explicit category
        let custom_agent_file = proj_agents_dir.join("novel-compliance-bot.md");
        std::fs::write(
            &custom_agent_file,
            "---\nname: novel-compliance-bot\ndescription: Checks compliance rules\ncategory: Compliance Suite\n---\nYou are a compliance checker."
        ).unwrap();

        let populated_query = discover_sdd_profiles_impl(None, Some(&cwd)).unwrap();
        let cats = populated_query["categories"].as_array().unwrap();
        let comp_cat = cats.iter().find(|c| c["name"] == "Compliance Suite");
        assert!(comp_cat.is_some(), "Dynamic category should be created from metadata");
        let comp_agents = comp_cat.unwrap()["agents"].as_array().unwrap();
        assert!(comp_agents.iter().any(|a| a == "novel-compliance-bot"));

        // 3. Precedence: project definition overrides config reference
        let proj_subagents_file = cwd.join(".pi").join("subagents.json");
        std::fs::write(
            &proj_subagents_file,
            r#"{"agents": {"novel-compliance-bot": {"category": "Old Config Category", "description": "Old config"}}}"#
        ).unwrap();

        let precedence_query = discover_sdd_profiles_impl(None, Some(&cwd)).unwrap();
        let prec_cats = precedence_query["categories"].as_array().unwrap();
        // Project definition (.md with Compliance Suite) outranks config reference (Old Config Category)
        assert!(prec_cats.iter().any(|c| c["name"] == "Compliance Suite"));
        assert!(!prec_cats.iter().any(|c| c["name"] == "Old Config Category"));

        // 4. Precedence: project definition overrides global definition for duplicate agent IDs
        let global_dup_file = global_agents_dir.join("novel-compliance-bot.md");
        std::fs::write(
            &global_dup_file,
            "---\nname: novel-compliance-bot\ndescription: Global version\ncategory: Global Category\n---\nGlobal instructions."
        ).unwrap();

        let dup_query = discover_sdd_profiles_impl(Some(&global_dir), Some(&cwd)).unwrap();
        let dup_cats = dup_query["categories"].as_array().unwrap();
        assert!(dup_cats.iter().any(|c| c["name"] == "Compliance Suite"));
        assert!(!dup_cats.iter().any(|c| c["name"] == "Global Category"));

        // 5. Remove project definition -> now global definition takes effect
        std::fs::remove_file(&custom_agent_file).unwrap();
        std::fs::remove_file(&proj_subagents_file).unwrap();

        let fallback_query = discover_sdd_profiles_impl(Some(&global_dir), Some(&cwd)).unwrap();
        let fb_cats = fallback_query["categories"].as_array().unwrap();
        assert!(fb_cats.iter().any(|c| c["name"] == "Global Category"));

        // 6. Remove global definition -> category is omitted completely
        std::fs::remove_file(&global_dup_file).unwrap();

        let cleared_query = discover_sdd_profiles_impl(Some(&global_dir), Some(&cwd)).unwrap();
        let cl_cats = cleared_query["categories"].as_array().unwrap();
        assert_eq!(cl_cats.len(), 0);
        assert_eq!(cleared_query["allAgents"].as_array().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // -----------------------------------------------------------------------
    // Gentle Shell Isolated Home Migration Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_gentle_shell_resolution_precedence() {
        let user_home = PathBuf::from("/mock/home/alice");

        // 1. Default: no env overrides, no config.json
        let homes_default = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| None,
        ).unwrap();
        assert_eq!(homes_default.main_pi_home, user_home.join(".pi").join("agent"));
        assert_eq!(homes_default.default_isolated_home, user_home.join(".gentle-shell").join("agent"));
        assert_eq!(homes_default.effective_home, user_home.join(".gentle-shell").join("agent"));
        assert_eq!(homes_default.mode, GentleShellHomeMode::Isolated);

        // 2. PI_CODING_AGENT_DIR override
        let homes_pi_env = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |k| if k == "PI_CODING_AGENT_DIR" { Some("/custom/pi/dir".to_string()) } else { None },
            |_| None,
        ).unwrap();
        assert_eq!(homes_pi_env.main_pi_home, PathBuf::from("/custom/pi/dir"));
        assert_eq!(homes_pi_env.effective_home, user_home.join(".gentle-shell").join("agent"));

        // 3. GENTLE_SHELL_HOME override
        let homes_gentle_env = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |k| if k == "GENTLE_SHELL_HOME" { Some("/custom/gentle/home".to_string()) } else { None },
            |_| None,
        ).unwrap();
        assert_eq!(homes_gentle_env.default_isolated_home, PathBuf::from("/custom/gentle/home"));
        assert_eq!(homes_gentle_env.effective_home, PathBuf::from("/custom/gentle/home"));

        // 4. config.json with home = "link"
        let homes_link = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "link"}"#.to_string()),
        ).unwrap();
        assert_eq!(homes_link.mode, GentleShellHomeMode::Link);
        assert_eq!(homes_link.effective_home, homes_link.main_pi_home);

        // 5. config.json with home = "isolated"
        let homes_isolated = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "isolated"}"#.to_string()),
        ).unwrap();
        assert_eq!(homes_isolated.mode, GentleShellHomeMode::Isolated);
        assert_eq!(homes_isolated.effective_home, homes_isolated.default_isolated_home);

        // 6. config.json with custom path
        let custom_dir = if cfg!(windows) { "C:\\custom\\agent" } else { "/custom/agent" };
        let homes_custom = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(format!(r#"{{"home": "{}"}}"#, custom_dir.replace('\\', "\\\\"))),
        ).unwrap();
        assert_eq!(homes_custom.mode, GentleShellHomeMode::Path);
        assert_eq!(homes_custom.effective_home, PathBuf::from(custom_dir));

        // 7. config.json invalid or malformed -> gracefully falls back to default isolated
        let homes_malformed_json = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": invalid}"#.to_string()),
        ).unwrap();
        assert_eq!(homes_malformed_json.mode, GentleShellHomeMode::Isolated);
        assert_eq!(homes_malformed_json.effective_home, homes_malformed_json.default_isolated_home);

        let homes_empty_home = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(r#"{"home": "   "}"#.to_string()),
        ).unwrap();
        assert_eq!(homes_empty_home.mode, GentleShellHomeMode::Isolated);

        let homes_array = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(r#"[1, 2, 3]"#.to_string()),
        ).unwrap();
        assert_eq!(homes_array.mode, GentleShellHomeMode::Isolated);
    }

    #[test]
    fn test_resolve_effective_pi_home_returns_path() {
        let home = resolve_effective_pi_home(None);
        assert!(!home.as_os_str().is_empty());
        assert!(home.is_absolute());
    }

    #[test]
    fn test_gentle_shell_relative_custom_home_resolves_against_workspace_cwd() {
        let user_home = PathBuf::from("/mock/home/alice");
        let workspace_cwd = PathBuf::from("/mock/workspace/project");
        let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/fallback/process/cwd"));

        // Ensure workspace_cwd is distinct from process_cwd
        assert_ne!(workspace_cwd, process_cwd);

        // 1. With supplied workspace cwd (base_dir), relative custom path resolves against workspace_cwd
        let relative_path = "custom-agent-home";
        let homes_with_cwd = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            Some(&workspace_cwd),
            |_| None,
            |_| Some(format!(r#"{{"home": "{}"}}"#, relative_path)),
        ).unwrap();

        assert_eq!(homes_with_cwd.mode, GentleShellHomeMode::Path);
        assert_eq!(homes_with_cwd.effective_home, workspace_cwd.join(relative_path));
        assert_ne!(homes_with_cwd.effective_home, process_cwd.join(relative_path));

        // 2. Also test with subpath like "./nested/agent"
        let relative_subpath = "./nested/agent";
        let homes_subpath = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            Some(&workspace_cwd),
            |_| None,
            |_| Some(format!(r#"{{"home": "{}"}}"#, relative_subpath)),
        ).unwrap();

        assert_eq!(homes_subpath.mode, GentleShellHomeMode::Path);
        assert_eq!(homes_subpath.effective_home, workspace_cwd.join(relative_subpath));
        assert_ne!(homes_subpath.effective_home, process_cwd.join(relative_subpath));

        // 3. Fallback when base_dir is None: resolves against process cwd rather than arbitrary dir
        let homes_no_cwd = resolve_gentle_shell_homes_impl(
            Some(&user_home),
            None,
            |_| None,
            |_| Some(format!(r#"{{"home": "{}"}}"#, relative_path)),
        ).unwrap();

        assert_eq!(homes_no_cwd.mode, GentleShellHomeMode::Path);
        assert_eq!(homes_no_cwd.effective_home, process_cwd.join(relative_path));
        assert_ne!(homes_no_cwd.effective_home, workspace_cwd.join(relative_path));
    }

    #[test]
    fn test_gentle_shell_skip_link_and_same_home() {
        let p1 = PathBuf::from("/home/alice/.pi/agent");
        let p2 = PathBuf::from("/home/alice/.gentle-shell/agent");

        // Link mode skips
        let link_homes = ResolvedGentleShellHomes {
            main_pi_home: p1.clone(),
            effective_home: p1.clone(),
            default_isolated_home: p2.clone(),
            mode: GentleShellHomeMode::Link,
        };
        assert!(should_skip_gentle_shell_migration(&link_homes));

        // Isolated mode with different paths does NOT skip
        let iso_homes = ResolvedGentleShellHomes {
            main_pi_home: p1.clone(),
            effective_home: p2.clone(),
            default_isolated_home: p2.clone(),
            mode: GentleShellHomeMode::Isolated,
        };
        assert!(!should_skip_gentle_shell_migration(&iso_homes));

        // Custom path equal to main Pi home skips
        let same_homes = ResolvedGentleShellHomes {
            main_pi_home: p1.clone(),
            effective_home: p1.clone(),
            default_isolated_home: p2.clone(),
            mode: GentleShellHomeMode::Path,
        };
        assert!(should_skip_gentle_shell_migration(&same_homes));
    }

    #[test]
    fn test_gentle_shell_inspection_models_content() {
        // Configured: valid root object with non-empty providers object
        assert_eq!(
            inspect_models_content_status(r#"{"providers": {"openai": {"baseUrl": "http://localhost"}}}"#),
            ConfigFileStatus::Configured
        );

        // Empty object
        assert_eq!(inspect_models_content_status("{}"), ConfigFileStatus::EmptyObject);
        assert_eq!(inspect_models_content_status(r#"{"providers": {}}"#), ConfigFileStatus::EmptyObject);

        // Blank
        assert_eq!(inspect_models_content_status("   \n\t  "), ConfigFileStatus::Blank);
        assert_eq!(inspect_models_content_status(""), ConfigFileStatus::Blank);

        // Malformed: syntax error
        assert_eq!(inspect_models_content_status("{ bad json"), ConfigFileStatus::MalformedNonblank);

        // Malformed: not an object
        assert_eq!(inspect_models_content_status("[1, 2, 3]"), ConfigFileStatus::MalformedNonblank);
        assert_eq!(inspect_models_content_status("\"string\""), ConfigFileStatus::MalformedNonblank);

        // Malformed: providers is not an object
        assert_eq!(inspect_models_content_status(r#"{"providers": "openai"}"#), ConfigFileStatus::MalformedNonblank);
        assert_eq!(inspect_models_content_status(r#"{"providers": [1, 2]}"#), ConfigFileStatus::MalformedNonblank);

        // Malformed: object has other keys but missing providers
        assert_eq!(inspect_models_content_status(r#"{"my_custom_setting": 123}"#), ConfigFileStatus::MalformedNonblank);
    }

    #[test]
    fn test_gentle_shell_inspection_auth_content() {
        // Configured: valid non-empty root object
        assert_eq!(
            inspect_auth_content_status(r#"{"anthropic": "sk-ant-test"}"#),
            ConfigFileStatus::Configured
        );

        // Empty object
        assert_eq!(inspect_auth_content_status("{}"), ConfigFileStatus::EmptyObject);

        // Blank
        assert_eq!(inspect_auth_content_status("   \r\n"), ConfigFileStatus::Blank);
        assert_eq!(inspect_auth_content_status(""), ConfigFileStatus::Blank);

        // Malformed: syntax error
        assert_eq!(inspect_auth_content_status("{ bad"), ConfigFileStatus::MalformedNonblank);

        // Malformed: array or string
        assert_eq!(inspect_auth_content_status(r#"["token"]"#), ConfigFileStatus::MalformedNonblank);
        assert_eq!(inspect_auth_content_status(r#""raw_token""#), ConfigFileStatus::MalformedNonblank);
    }

    #[test]
    fn test_gentle_shell_eligibility_scenarios() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_elig_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        // 1. Both dest missing. Source has configured models.json only.
        std::fs::write(src.join("models.json"), r#"{"providers": {"ollama": {"baseUrl": "http://127.0.0.1"}}}"#).unwrap();
        let insp1 = check_migration_eligibility(&src, &dest);
        assert!(insp1.eligible);
        assert!(insp1.copy_models);
        assert!(!insp1.copy_auth);

        // 2. Both dest missing. Source has configured auth.json only.
        std::fs::remove_file(src.join("models.json")).unwrap();
        std::fs::write(src.join("auth.json"), r#"{"openai": "secret"}"#).unwrap();
        let insp2 = check_migration_eligibility(&src, &dest);
        assert!(insp2.eligible);
        assert!(!insp2.copy_models);
        assert!(insp2.copy_auth);

        // 3. Both dest missing. Source has BOTH configured.
        std::fs::write(src.join("models.json"), r#"{"providers": {"ollama": {"baseUrl": "http://127.0.0.1"}}}"#).unwrap();
        let insp3 = check_migration_eligibility(&src, &dest);
        assert!(insp3.eligible);
        assert!(insp3.copy_models);
        assert!(insp3.copy_auth);

        // 4. Dest has blank models and empty object auth. Eligible!
        std::fs::write(dest.join("models.json"), "   \n").unwrap();
        std::fs::write(dest.join("auth.json"), "{}").unwrap();
        let insp4 = check_migration_eligibility(&src, &dest);
        assert!(insp4.eligible);
        assert!(insp4.copy_models);
        assert!(insp4.copy_auth);

        // 5. Dest has configured models. NOT eligible (both must be unconfigured).
        std::fs::write(dest.join("models.json"), r#"{"providers": {"existing": {"baseUrl": "http://dest"}}}"#).unwrap();
        let insp5 = check_migration_eligibility(&src, &dest);
        assert!(!insp5.eligible);
        assert_eq!(insp5.dest_models, ConfigFileStatus::Configured);

        // 6. Source has neither configured (e.g. empty or missing). NOT eligible.
        std::fs::remove_file(dest.join("models.json")).unwrap();
        std::fs::remove_file(dest.join("auth.json")).unwrap();
        std::fs::write(src.join("models.json"), "{}").unwrap();
        std::fs::write(src.join("auth.json"), "   ").unwrap();
        let insp6 = check_migration_eligibility(&src, &dest);
        assert!(!insp6.eligible);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_malformed_destination_protection() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_protect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        std::fs::write(src.join("models.json"), r#"{"providers": {"openai": {"baseUrl": "http://localhost"}}}"#).unwrap();
        std::fs::write(src.join("auth.json"), r#"{"openai": "secret"}"#).unwrap();

        // 1. Dest models has malformed JSON -> protected!
        std::fs::write(dest.join("models.json"), "{ invalid json bytes").unwrap();
        let insp1 = check_migration_eligibility(&src, &dest);
        assert!(!insp1.eligible);
        assert!(insp1.dest_models.is_protected_malformed());

        // 2. Dest models has unrecognized nonblank content -> protected!
        std::fs::write(dest.join("models.json"), r#"{"custom_config": 42}"#).unwrap();
        let insp2 = check_migration_eligibility(&src, &dest);
        assert!(!insp2.eligible);
        assert!(insp2.dest_models.is_protected_malformed());

        // 3. Dest models is missing, but dest auth has malformed JSON -> protected!
        std::fs::remove_file(dest.join("models.json")).unwrap();
        std::fs::write(dest.join("auth.json"), "not json at all").unwrap();
        let insp3 = check_migration_eligibility(&src, &dest);
        assert!(!insp3.eligible);
        assert!(insp3.dest_auth.is_protected_malformed());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_gentle_shell_preflight_approval_and_selective_copy() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_approve_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        // Source has configured models.json and auth.json
        let models_content = r#"{"providers": {"ollama": {"baseUrl": "http://localhost:11434", "api": "openai"}}}"#;
        let auth_content = r#"{"anthropic": "sk-ant-12345"}"#;
        std::fs::write(src.join("models.json"), models_content).unwrap();
        std::fs::write(src.join("auth.json"), auth_content).unwrap();

        // Source also has extra files that must NEVER be copied
        std::fs::write(src.join("settings.json"), r#"{"theme": "dark"}"#).unwrap();
        std::fs::write(src.join("models-store.json"), r#"{"cache": true}"#).unwrap();
        let sessions_dir = src.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        std::fs::write(sessions_dir.join("chat.json"), "session data").unwrap();

        let homes = ResolvedGentleShellHomes {
            main_pi_home: src.clone(),
            effective_home: dest.clone(),
            default_isolated_home: dest.clone(),
            mode: GentleShellHomeMode::Isolated,
        };

        let state = AppState::new();

        // Run preflight with mock approval (Ok(true))
        let dialog_mock: MigrationDialogFn = Arc::new(|_src, _dest, files| {
            assert!(files.contains(&"models.json"));
            assert!(files.contains(&"auth.json"));
            Ok(true)
        });

        let res = run_gentle_shell_migration_preflight_for_homes(
            &homes,
            &state.declined_migrations,
            Some(dialog_mock),
        ).await;
        assert!(res.is_ok());

        // Verify models.json and auth.json were copied
        assert!(dest.join("models.json").exists());
        assert_eq!(std::fs::read_to_string(dest.join("models.json")).unwrap(), models_content);
        assert!(dest.join("auth.json").exists());
        assert_eq!(std::fs::read_to_string(dest.join("auth.json")).unwrap(), auth_content);

        // Verify settings.json, models-store.json, sessions were NEVER copied
        assert!(!dest.join("settings.json").exists());
        assert!(!dest.join("models-store.json").exists());
        assert!(!dest.join("sessions").exists());

        // Verify not marked as declined
        let declined = state.declined_migrations.lock().await;
        assert!(!declined.contains(&dest));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_gentle_shell_selective_copy_only_configured_source() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_selective_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        // Source has configured models.json only; auth.json is unconfigured (empty)
        std::fs::write(src.join("models.json"), r#"{"providers": {"ollama": {"baseUrl": "http://localhost"}}}"#).unwrap();
        std::fs::write(src.join("auth.json"), "{}").unwrap();

        let homes = ResolvedGentleShellHomes {
            main_pi_home: src.clone(),
            effective_home: dest.clone(),
            default_isolated_home: dest.clone(),
            mode: GentleShellHomeMode::Isolated,
        };

        let state = AppState::new();

        let dialog_mock: MigrationDialogFn = Arc::new(|_src, _dest, files| {
            assert_eq!(files, &["models.json"]);
            Ok(true)
        });

        let res = run_gentle_shell_migration_preflight_for_homes(
            &homes,
            &state.declined_migrations,
            Some(dialog_mock),
        ).await;
        assert!(res.is_ok());

        assert!(dest.join("models.json").exists());
        assert!(!dest.join("auth.json").exists(), "Unconfigured auth.json must NOT be copied");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_gentle_shell_preflight_decline_and_session_suppression() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_decline_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        std::fs::write(src.join("models.json"), r#"{"providers": {"ollama": {"baseUrl": "http://localhost"}}}"#).unwrap();

        let homes = ResolvedGentleShellHomes {
            main_pi_home: src.clone(),
            effective_home: dest.clone(),
            default_isolated_home: dest.clone(),
            mode: GentleShellHomeMode::Isolated,
        };

        let state = AppState::new();

        // 1. User declines dialog
        let dialog_mock_decline: MigrationDialogFn = Arc::new(|_src, _dest, _files| {
            Ok(false)
        });

        let res1 = run_gentle_shell_migration_preflight_for_homes(
            &homes,
            &state.declined_migrations,
            Some(dialog_mock_decline),
        ).await;
        assert!(res1.is_ok());

        // Files NOT copied
        assert!(!dest.join("models.json").exists());

        // Declined state recorded in AppState
        {
            let declined = state.declined_migrations.lock().await;
            assert!(declined.contains(&dest));
        }

        // 2. Second connect in same app process: dialog must NOT be invoked!
        let dialog_panics_if_called: MigrationDialogFn = Arc::new(|_, _, _| {
            panic!("Dialog should NOT be called when previously declined in the same process!");
        });

        let res2 = run_gentle_shell_migration_preflight_for_homes(
            &homes,
            &state.declined_migrations,
            Some(dialog_panics_if_called),
        ).await;
        assert!(res2.is_ok());
        assert!(!dest.join("models.json").exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_gentle_shell_preflight_dialog_error_aborts() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_err_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        std::fs::write(src.join("models.json"), r#"{"providers": {"ollama": {"baseUrl": "http://localhost"}}}"#).unwrap();

        let homes = ResolvedGentleShellHomes {
            main_pi_home: src.clone(),
            effective_home: dest.clone(),
            default_isolated_home: dest.clone(),
            mode: GentleShellHomeMode::Isolated,
        };

        let state = AppState::new();

        let dialog_error: MigrationDialogFn = Arc::new(|_, _, _| {
            Err("Native OS dialog spawn failure".to_string())
        });

        let res = run_gentle_shell_migration_preflight_for_homes(
            &homes,
            &state.declined_migrations,
            Some(dialog_error),
        ).await;

        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Native OS dialog spawn failure"));
        assert!(!dest.join("models.json").exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_gentle_shell_no_overwrite_configured_or_protected() {
        let temp_dir = std::env::temp_dir().join(format!("test_gs_no_ow_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        let src_models = src.join("models.json");
        let dest_models = dest.join("models.json");

        std::fs::write(&src_models, r#"{"providers": {"source": {"baseUrl": "http://source"}}}"#).unwrap();

        // 1. Destination already configured: atomic copy must refuse to overwrite
        std::fs::write(&dest_models, r#"{"providers": {"dest": {"baseUrl": "http://dest"}}}"#).unwrap();
        let err_res = atomic_copy_config_file(&src_models, &dest_models, false);
        assert!(err_res.is_err());
        assert!(err_res.unwrap_err().contains("aborting overwrite"));
        // Destination remains unchanged
        assert!(std::fs::read_to_string(&dest_models).unwrap().contains("http://dest"));

        // 2. Destination malformed non-blank: atomic copy must refuse to overwrite
        std::fs::write(&dest_models, "{ corrupt json data").unwrap();
        let err_malformed = atomic_copy_config_file(&src_models, &dest_models, false);
        assert!(err_malformed.is_err());
        assert!(err_malformed.unwrap_err().contains("aborting overwrite"));
        assert_eq!(std::fs::read_to_string(&dest_models).unwrap(), "{ corrupt json data");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_gentle_shell_auth_permissions_unix() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = std::env::temp_dir().join(format!("test_gs_perms_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let src = temp_dir.join("src");
        let dest = temp_dir.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();

        let src_auth = src.join("auth.json");
        let dest_auth = dest.join("auth.json");

        std::fs::write(&src_auth, r#"{"openai": "secret-key"}"#).unwrap();

        let copy_res = atomic_copy_config_file(&src_auth, &dest_auth, true);
        assert!(copy_res.is_ok());

        let meta = std::fs::metadata(&dest_auth).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "auth.json permissions must be private (0o600) on Unix");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_parse_engram_project_from_stats() {
        // Standard stats output
        let stats_1 = "Engram Memory Stats\n  Sessions:     294\n  Observations: 137\n  Prompts:      441\n  Projects:     pi-viewer\n  Database:     C:\\Users\\Personal\\.engram/engram.db\n";
        assert_eq!(parse_engram_project_from_stats(stats_1), Some("pi-viewer".to_string()));

        // Singular Project: prefix
        let stats_2 = "Engram Memory Stats\n  Project: my-awesome-app\n";
        assert_eq!(parse_engram_project_from_stats(stats_2), Some("my-awesome-app".to_string()));

        // none yet
        let stats_none = "Engram Memory Stats\n  Projects:     none yet\n";
        assert_eq!(parse_engram_project_from_stats(stats_none), None);

        // Blank value
        let stats_blank = "Engram Memory Stats\n  Projects:    \n";
        assert_eq!(parse_engram_project_from_stats(stats_blank), None);

        // No projects line
        let stats_missing = "Engram Memory Stats\n  Sessions: 1\n";
        assert_eq!(parse_engram_project_from_stats(stats_missing), None);
    }

    #[tokio::test]
    async fn test_get_engram_project_config_fast_path() {
        let temp_dir = std::env::temp_dir().join(format!("test_engram_cfg_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let engram_dir = temp_dir.join(".engram");
        std::fs::create_dir_all(&engram_dir).unwrap();

        let cfg = serde_json::json!({
            "name": "custom-detected-project"
        });
        std::fs::write(engram_dir.join("config.json"), serde_json::to_string(&cfg).unwrap()).unwrap();

        let res = get_engram_project_impl(Some(&temp_dir.to_string_lossy())).await.unwrap();
        assert_eq!(res, Some("custom-detected-project".to_string()));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_engram_project_ttl_cache_behavior() {
        clear_engram_caches_for_test();
        let temp_dir = std::env::temp_dir().join(format!("test_engram_cache_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let engram_dir = temp_dir.join(".engram");
        std::fs::create_dir_all(&engram_dir).unwrap();

        let cfg1 = serde_json::json!({ "name": "initial-project" });
        std::fs::write(engram_dir.join("config.json"), serde_json::to_string(&cfg1).unwrap()).unwrap();

        let dir_str = temp_dir.to_string_lossy().to_string();

        // First call populates cache
        let res1 = get_engram_project_impl(Some(&dir_str)).await.unwrap();
        assert_eq!(res1, Some("initial-project".to_string()));

        // Mutate the file on disk
        let cfg2 = serde_json::json!({ "name": "mutated-project" });
        std::fs::write(engram_dir.join("config.json"), serde_json::to_string(&cfg2).unwrap()).unwrap();

        // Second call should return cached value without reading mutated disk file
        let res2 = get_engram_project_impl(Some(&dir_str)).await.unwrap();
        assert_eq!(res2, Some("initial-project".to_string()));

        // Clearing cache should force re-reading
        clear_engram_caches_for_test();
        let res3 = get_engram_project_impl(Some(&dir_str)).await.unwrap();
        assert_eq!(res3, Some("mutated-project".to_string()));

        let _ = std::fs::remove_dir_all(&temp_dir);
        clear_engram_caches_for_test();
    }

    #[tokio::test]
    async fn test_engram_cloud_status_cache_behavior() {
        clear_engram_caches_for_test();
        let key_proj = "test-cached-project";

        // Seed cache through call (falls back gracefully and caches)
        let res1 = get_engram_cloud_status_impl(Some(key_proj), None).await.unwrap();
        let res2 = get_engram_cloud_status_impl(Some(key_proj), None).await.unwrap();
        assert_eq!(res1, res2);

        clear_engram_caches_for_test();
    }

    #[test]
    fn test_parse_engram_cloud_status() {
        let stdout_enrolled = r#"
Cloud status: configured (target=cloud)
Server: https://engram.myshortener.xyz/
Server source: cloud.json
Auth status: ready (token read from cloud.json)
Sync readiness: ready for explicit --project sync (project must be enrolled)
Project enrollment: enrolled (pi-viewer)
Local daemon: running on port 7437
"#;
        let status = parse_engram_cloud_status(stdout_enrolled);
        assert!(status.configured);
        assert_eq!(status.server_url.as_deref(), Some("https://engram.myshortener.xyz/"));
        assert!(status.auth_ready);
        assert_eq!(status.enrolled, Some(true));
        assert!(status.daemon_running);
        assert_eq!(status.daemon_port, Some(7437));
        assert_eq!(status.reason_code, None);
        assert_eq!(status.last_error, None);
        assert_eq!(status.cloud_permitted, None);
        assert_eq!(status.cloud_permission_message, None);

        let stdout_not_enrolled_with_error = r#"
Cloud status: configured (target=cloud)
Server: https://engram.myshortener.xyz/
Server source: cloud.json
Auth status: ready (token read from cloud.json)
Sync readiness: ready for explicit --project sync (project must be enrolled)
Project enrollment: not enrolled (pi-viewer)
Local daemon: running on port 7437
Sync diagnostic: project-scoped cloud state
reason_code: policy_forbidden
reason_message: cloud: fetch manifest: status 403: forbidden: project "cliproxyapi-main" is not allowed
"#;
        let status2 = parse_engram_cloud_status(stdout_not_enrolled_with_error);
        assert!(status2.configured);
        assert_eq!(status2.server_url.as_deref(), Some("https://engram.myshortener.xyz/"));
        assert!(status2.auth_ready);
        assert_eq!(status2.enrolled, Some(false));
        assert!(status2.daemon_running);
        assert_eq!(status2.daemon_port, Some(7437));
        assert_eq!(status2.reason_code.as_deref(), Some("policy_forbidden"));
        assert_eq!(
            status2.last_error.as_deref(),
            Some("cloud: fetch manifest: status 403: forbidden: project \"cliproxyapi-main\" is not allowed")
        );

        let stdout_not_configured = r#"
Cloud status: not configured
Auth status: not ready
Project enrollment: not checked (use --project <name>)
Local daemon: not running
"#;
        let status3 = parse_engram_cloud_status(stdout_not_configured);
        assert!(!status3.configured);
        assert_eq!(status3.server_url, None);
        assert!(!status3.auth_ready);
        assert_eq!(status3.enrolled, None);
        assert!(!status3.daemon_running);
        assert_eq!(status3.daemon_port, None);

        let status_empty = parse_engram_cloud_status("");
        assert!(!status_empty.configured);
        assert_eq!(status_empty.server_url, None);
        assert!(!status_empty.auth_ready);
        assert_eq!(status_empty.enrolled, None);
        assert!(!status_empty.daemon_running);
        assert_eq!(status_empty.daemon_port, None);
        assert_eq!(status_empty.raw_details, None);
        assert_eq!(status_empty.cloud_permitted, None);
        assert_eq!(status_empty.cloud_permission_message, None);
    }

    #[test]
    fn test_apply_cloud_sync_permission_result() {
        let base_status = EngramCloudStatus {
            configured: true,
            server_url: Some("https://engram.myshortener.xyz/".to_string()),
            auth_ready: true,
            enrolled: Some(true),
            daemon_running: true,
            daemon_port: Some(7437),
            phase: None,
            last_sync_at: None,
            last_error: None,
            reason_code: None,
            raw_details: None,
            cloud_permitted: None,
            cloud_permission_message: None,
        };

        // 1. Permitted (success exit code or output contains "Cloud sync status")
        let mut status_perm = base_status.clone();
        apply_cloud_sync_permission_result(
            &mut status_perm,
            Ok((true, "Cloud sync status: in sync\nEverything up to date", "")),
        );
        assert_eq!(status_perm.cloud_permitted, Some(true));
        assert_eq!(
            status_perm.cloud_permission_message.as_deref(),
            Some("Sincronización permitida en el servidor")
        );

        let mut status_perm_exit0 = base_status.clone();
        apply_cloud_sync_permission_result(
            &mut status_perm_exit0,
            Ok((true, "Sync state: ok", "")),
        );
        assert_eq!(status_perm_exit0.cloud_permitted, Some(true));
        assert_eq!(
            status_perm_exit0.cloud_permission_message.as_deref(),
            Some("Sincronización permitida en el servidor")
        );

        // 2. Forbidden (403 / policy_forbidden / not allowed / forbidden)
        let mut status_forbidden = base_status.clone();
        apply_cloud_sync_permission_result(
            &mut status_forbidden,
            Ok((
                false,
                "",
                "cloud: fetch manifest: status 403: forbidden: project \"pi-viewer\" is not allowed",
            )),
        );
        assert_eq!(status_forbidden.cloud_permitted, Some(false));
        assert_eq!(status_forbidden.reason_code.as_deref(), Some("policy_forbidden"));
        assert_eq!(
            status_forbidden.cloud_permission_message.as_deref(),
            Some("Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.")
        );
        assert_eq!(
            status_forbidden.last_error.as_deref(),
            Some("cloud: fetch manifest: status 403: forbidden: project \"pi-viewer\" is not allowed")
        );

        // Preserves existing last_error if already Some
        let mut status_forbidden_existing_err = base_status.clone();
        status_forbidden_existing_err.last_error = Some("pre-existing error".to_string());
        apply_cloud_sync_permission_result(
            &mut status_forbidden_existing_err,
            Ok((false, "reason_code: policy_forbidden", "")),
        );
        assert_eq!(status_forbidden_existing_err.cloud_permitted, Some(false));
        assert_eq!(
            status_forbidden_existing_err.reason_code.as_deref(),
            Some("policy_forbidden")
        );
        assert_eq!(
            status_forbidden_existing_err.last_error.as_deref(),
            Some("pre-existing error")
        );

        // 3. Auth error (401 / auth_required)
        let mut status_auth = base_status.clone();
        apply_cloud_sync_permission_result(
            &mut status_auth,
            Ok((false, "status 401: unauthorized (auth_required)", "")),
        );
        assert_eq!(status_auth.cloud_permitted, Some(false));
        assert_eq!(
            status_auth.cloud_permission_message.as_deref(),
            Some("Autenticación requerida por el servidor (401)")
        );

        // 4. Timeout or network failure
        let mut status_timeout = base_status.clone();
        apply_cloud_sync_permission_result(&mut status_timeout, Err(()));
        assert_eq!(status_timeout.cloud_permitted, None);
        assert_eq!(
            status_timeout.cloud_permission_message.as_deref(),
            Some("No se pudo verificar permisos en el servidor Cloud (tiempo de espera agotado)")
        );

        let mut status_net_fail = base_status.clone();
        apply_cloud_sync_permission_result(
            &mut status_net_fail,
            Ok((false, "", "dial tcp: connection refused")),
        );
        assert_eq!(status_net_fail.cloud_permitted, None);
        assert_eq!(
            status_net_fail.cloud_permission_message.as_deref(),
            Some("No se pudo verificar permisos en el servidor Cloud (tiempo de espera agotado)")
        );
    }

    #[tokio::test]
    async fn test_enroll_engram_project_validation() {
        let res_empty = enroll_engram_project_impl("", None).await;
        assert!(res_empty.is_err());
        assert!(res_empty.unwrap_err().contains("empty"));

        let res_whitespace = enroll_engram_project_impl("   ", None).await;
        assert!(res_whitespace.is_err());
        assert!(res_whitespace.unwrap_err().contains("empty"));
    }
}
