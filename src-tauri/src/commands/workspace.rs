//! Workspace file tree navigation, file reading, and git status commands.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::AppState;

/// Directories ignored by default in workspace tree explorer
pub const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
];

/// Maximum permitted file size for workspace text preview (2 MB)
pub const MAX_WORKSPACE_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// Maximum permitted file size for workspace media preview (25 MB)
pub const MAX_WORKSPACE_MEDIA_BYTES: u64 = 25 * 1024 * 1024;

/// Backward-compatible alias for existing references
pub const MAX_WORKSPACE_FILE_READ_BYTES: u64 = MAX_WORKSPACE_TEXT_BYTES;

/// Payload for listing workspace directory contents
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceDirPayload {
    pub working_directory: Option<String>,
    pub relative_path: Option<String>,
}

/// A directory entry in the workspace
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub extension: Option<String>,
}

/// Payload for reading a file in the workspace
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFilePayload {
    pub working_directory: Option<String>,
    pub relative_path: String,
}

/// Content and metadata of a workspace file
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub relative_path: String,
    pub name: String,
    pub content: String,
    pub size: u64,
    pub is_binary: bool,
    pub extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_data_url: Option<String>,
}

/// Checks if a file name is deterministically binary/non-code
pub fn is_deterministic_binary_filename(filename: &str) -> bool {
    let lower = filename.trim().to_lowercase();
    if lower.ends_with(".so") {
        return true;
    }
    // Handle .so version suffixes, e.g. .so.1, .so.1.2.3, libc.so.6
    if let Some(pos) = lower.find(".so.") {
        let suffix = &lower[pos + 4..];
        if !suffix.is_empty() && suffix.split('.').all(|part| part.chars().all(|c| c.is_ascii_digit())) {
            return true;
        }
    }
    if lower.ends_with(".db-wal") || lower.ends_with(".db-shm") {
        return true;
    }

    if let Some(ext) = Path::new(&lower).extension().and_then(|s| s.to_str()) {
        matches!(
            ext,
            "dll"
                | "dylib"
                | "exe"
                | "bin"
                | "hex"
                | "obj"
                | "o"
                | "a"
                | "lib"
                | "class"
                | "pyc"
                | "pyo"
                | "pyd"
                | "wasm"
                | "db"
                | "sqlite"
                | "sqlite3"
                | "rdb"
                | "zip"
                | "tar"
                | "gz"
                | "tgz"
                | "bz2"
                | "xz"
                | "7z"
                | "rar"
                | "zst"
                | "iso"
                | "dmg"
                | "pkg"
                | "deb"
                | "rpm"
                | "mp3"
                | "wav"
                | "aac"
                | "flac"
                | "m4a"
                | "ttf"
                | "otf"
                | "woff"
                | "woff2"
                | "eot"
                | "pdf"
                | "doc"
                | "docx"
                | "xls"
                | "xlsx"
                | "ppt"
                | "pptx"
        )
    } else {
        false
    }
}

/// Returns allowlisted image MIME type if recognized
pub fn get_image_mime_type(filename: &str) -> Option<&'static str> {
    let lower = filename.trim().to_lowercase();
    let ext = Path::new(&lower).extension().and_then(|s| s.to_str())?;
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// Returns allowlisted video MIME type if recognized
pub fn get_video_mime_type(filename: &str) -> Option<&'static str> {
    let lower = filename.trim().to_lowercase();
    let ext = Path::new(&lower).extension().and_then(|s| s.to_str())?;
    match ext {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogg" | "ogv" => Some("video/ogg"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        _ => None,
    }
}

/// Inspects byte slice for binary content: NUL bytes, binary control chars, or malformed UTF-8
pub fn is_binary_byte_buffer(bytes: &[u8]) -> bool {
    for &b in bytes {
        if b == 0 {
            return true;
        }
        if (b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r' && b != 0x0c && b != 0x1b) || b == 0x7f {
            return true;
        }
    }
    std::str::from_utf8(bytes).is_err()
}

/// Resolves and canonicalizes the workspace root path
pub async fn resolve_canonical_workspace_root(
    working_directory_opt: Option<&str>,
    state: &AppState,
) -> Result<PathBuf, String> {
    let raw_path = if let Some(wd) = working_directory_opt.map(str::trim).filter(|s| !s.is_empty()) {
        PathBuf::from(wd)
    } else {
        let guard = state.session.lock().await;
        if let Some(session) = guard.as_ref() {
            session.cwd.clone()
        } else {
            return Err("No active workspace found and no working directory provided".to_string());
        }
    };

    if !raw_path.exists() {
        return Err(format!("Workspace root does not exist: {}", raw_path.display()));
    }
    if !raw_path.is_dir() {
        return Err(format!("Workspace root is not a directory: {}", raw_path.display()));
    }

    dunce::canonicalize(&raw_path)
        .map_err(|e| format!("Failed to canonicalize workspace root '{}': {e}", raw_path.display()))
}

/// Computes POSIX-style relative path with forward slashes
pub fn compute_relative_posix_path(canonical_root: &Path, canonical_target: &Path) -> Result<String, String> {
    let rel = canonical_target
        .strip_prefix(canonical_root)
        .map_err(|e| format!("Failed to strip workspace prefix: {e}"))?;

    let path_str = rel.to_string_lossy();
    Ok(path_str.replace('\\', "/"))
}

/// Validates child relative path and resolves to canonical path within workspace root
pub fn validate_and_resolve_child_path(
    canonical_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(canonical_root.to_path_buf());
    }

    // Inspect components for directory traversal
    let path_obj = Path::new(trimmed);
    for component in path_obj.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Path traversal attempt detected ('..')".to_string());
            }
            std::path::Component::Prefix(_) => {
                return Err("Windows drive prefix not permitted for workspace relative path".to_string());
            }
            _ => {}
        }
    }

    // Strip leading slashes to prevent absolute re-rooting
    let sanitized = trimmed.trim_start_matches(['/', '\\']);
    if sanitized.is_empty() {
        return Ok(canonical_root.to_path_buf());
    }

    let joined = canonical_root.join(sanitized);
    if !joined.exists() {
        return Err(format!("Target path does not exist: {}", joined.display()));
    }

    let canonical_child = dunce::canonicalize(&joined)
        .map_err(|e| format!("Failed to canonicalize child path '{}': {e}", joined.display()))?;

    // Defense-in-depth: Ensure canonical child starts with canonical root
    if !canonical_child.starts_with(canonical_root) {
        return Err("Access denied: path is outside workspace root".to_string());
    }

    Ok(canonical_child)
}

/// List files and subdirectories of a workspace directory
#[tauri::command]
pub async fn list_workspace_dir(
    payload: Option<ListWorkspaceDirPayload>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let working_dir_opt = payload.as_ref().and_then(|p| p.working_directory.as_deref());
    let canonical_root = resolve_canonical_workspace_root(working_dir_opt, &state).await?;

    let rel_path = payload.as_ref().and_then(|p| p.relative_path.as_deref()).unwrap_or("");
    let target_dir = validate_and_resolve_child_path(&canonical_root, rel_path)?;

    if !target_dir.is_dir() {
        return Err(format!("Target path is not a directory: {}", target_dir.display()));
    }

    let read_dir = std::fs::read_dir(&target_dir)
        .map_err(|e| format!("Failed to read directory '{}': {e}", target_dir.display()))?;

    let mut entries = Vec::new();

    for entry_res in read_dir {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };

        let file_name = entry.file_name().to_string_lossy().to_string();

        if IGNORED_DIR_NAMES.contains(&file_name.as_str()) {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let is_dir = file_type.is_dir();
        let canonical_entry = match dunce::canonicalize(entry.path()) {
            Ok(p) => p,
            Err(_) => continue,
        };

        if !canonical_entry.starts_with(&canonical_root) {
            continue;
        }

        let relative_path = match compute_relative_posix_path(&canonical_root, &canonical_entry) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let (size, extension) = if is_dir {
            (None, None)
        } else {
            let sz = entry.metadata().ok().map(|m| m.len());
            let ext = entry
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            (sz, ext)
        };

        entries.push(WorkspaceEntry {
            name: file_name,
            relative_path,
            is_dir,
            size,
            extension,
        });
    }

    // Sort: directories first, then alphabetical case-insensitive
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// Read text content of a workspace file within safe limits
#[tauri::command]
pub async fn read_workspace_file(
    payload: ReadWorkspaceFilePayload,
    state: State<'_, AppState>,
) -> Result<WorkspaceFileContent, String> {
    let canonical_root = resolve_canonical_workspace_root(payload.working_directory.as_deref(), &state).await?;
    let canonical_file = validate_and_resolve_child_path(&canonical_root, &payload.relative_path)?;

    let metadata = std::fs::metadata(&canonical_file)
        .map_err(|e| format!("Failed to read file metadata for '{}': {e}", canonical_file.display()))?;

    if metadata.is_dir() {
        return Err("Target path is a directory, not a file".to_string());
    }

    let file_size = metadata.len();
    let name = canonical_file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let extension = canonical_file
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());

    let relative_path = compute_relative_posix_path(&canonical_root, &canonical_file)?;

    // 1. Deterministic binary files - return metadata without loading bytes
    if is_deterministic_binary_filename(&name) {
        return Ok(WorkspaceFileContent {
            relative_path,
            name,
            content: String::new(),
            size: file_size,
            is_binary: true,
            extension,
            kind: Some("binary".to_string()),
            mime_type: None,
            media_data_url: None,
        });
    }

    // 2. Media files (images and videos) with 25 MB limit
    let image_mime = get_image_mime_type(&name);
    let video_mime = get_video_mime_type(&name);

    if image_mime.is_some() || video_mime.is_some() {
        if file_size > MAX_WORKSPACE_MEDIA_BYTES {
            return Err(format!(
                "File is too large to preview (size: {} bytes, maximum allowed: {} bytes)",
                file_size, MAX_WORKSPACE_MEDIA_BYTES
            ));
        }

        let bytes = std::fs::read(&canonical_file)
            .map_err(|e| format!("Failed to read file '{}': {e}", canonical_file.display()))?;

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mime = image_mime.or(video_mime).unwrap();
        let kind = if image_mime.is_some() { "image" } else { "video" };
        let media_data_url = format!("data:{mime};base64,{b64}");

        return Ok(WorkspaceFileContent {
            relative_path,
            name,
            content: String::new(),
            size: file_size,
            is_binary: true,
            extension,
            kind: Some(kind.to_string()),
            mime_type: Some(mime.to_string()),
            media_data_url: Some(media_data_url),
        });
    }

    // 3. Text and unknown binary files with 2 MB limit
    if file_size > MAX_WORKSPACE_TEXT_BYTES {
        return Err(format!(
            "File is too large to preview (size: {} bytes, maximum allowed: {} bytes)",
            file_size, MAX_WORKSPACE_TEXT_BYTES
        ));
    }

    let bytes = std::fs::read(&canonical_file)
        .map_err(|e| format!("Failed to read file '{}': {e}", canonical_file.display()))?;

    if is_binary_byte_buffer(&bytes) {
        return Ok(WorkspaceFileContent {
            relative_path,
            name,
            content: String::new(),
            size: file_size,
            is_binary: true,
            extension,
            kind: Some("binary".to_string()),
            mime_type: None,
            media_data_url: None,
        });
    }

    let content = String::from_utf8(bytes).map_err(|e| format!("Failed to decode UTF-8: {e}"))?;

    Ok(WorkspaceFileContent {
        relative_path,
        name,
        content,
        size: file_size,
        is_binary: false,
        extension,
        kind: Some("text".to_string()),
        mime_type: None,
        media_data_url: None,
    })
}

/// Payload for inspecting git status in workspace
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GetWorkspaceGitStatusPayload {
    pub working_directory: Option<String>,
}

/// Information about the workspace's Git repository
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    pub is_repo: bool,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
    pub modified_files: Vec<String>,
    pub added_files: Vec<String>,
    pub untracked_files: Vec<String>,
}

/// Payload for getting git diff of a specific file
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GetWorkspaceFileDiffPayload {
    pub working_directory: Option<String>,
    pub relative_path: String,
}

/// Git diff result for a workspace file
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileDiff {
    pub relative_path: String,
    pub has_diff: bool,
    pub diff: String,
}

/// Inspect git repository status, branch name, and changed/untracked files in workspace
#[tauri::command]
pub async fn get_workspace_git_status(
    payload: Option<GetWorkspaceGitStatusPayload>,
    state: State<'_, AppState>,
) -> Result<WorkspaceGitStatus, String> {
    let working_dir_opt = payload.as_ref().and_then(|p| p.working_directory.as_deref());
    let canonical_root = resolve_canonical_workspace_root(working_dir_opt, &state).await?;

    // Check if git is inside work tree
    let is_inside_output = tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&canonical_root)
        .output()
        .await;

    let is_inside = match is_inside_output {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true",
        Err(_) => false,
    };

    if !is_inside {
        return Ok(WorkspaceGitStatus {
            is_repo: false,
            repo_name: None,
            branch: None,
            modified_files: Vec::new(),
            added_files: Vec::new(),
            untracked_files: Vec::new(),
        });
    }

    // Repo name (folder name of canonical root)
    let repo_name = canonical_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string());

    // Branch name
    let branch_output = tokio::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(&canonical_root)
        .output()
        .await;

    let branch = match branch_output {
        Ok(out) if out.status.success() => {
            let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if b.is_empty() {
                // Detached HEAD fallback
                let head_output = tokio::process::Command::new("git")
                    .args(["rev-parse", "--short", "HEAD"])
                    .current_dir(&canonical_root)
                    .output()
                    .await;
                head_output.ok().and_then(|h| {
                    if h.status.success() {
                        let short_hash = String::from_utf8_lossy(&h.stdout).trim().to_string();
                        if !short_hash.is_empty() {
                            Some(format!("HEAD ({short_hash})"))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
            } else {
                Some(b)
            }
        }
        _ => None,
    };

    // Git status
    let status_output = tokio::process::Command::new("git")
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .current_dir(&canonical_root)
        .output()
        .await;

    let mut modified_files = Vec::new();
    let mut added_files = Vec::new();
    let mut untracked_files = Vec::new();

    if let Ok(out) = status_output {
        if out.status.success() {
            let stdout_str = String::from_utf8_lossy(&out.stdout);
            for line in stdout_str.lines() {
                if line.len() < 4 {
                    continue;
                }
                let status_code = &line[0..2];
                let file_path = line[3..].trim();
                // Strip quotes if git quoted the filename
                let clean_path = file_path.trim_matches('"').replace('\\', "/");

                if status_code == "??" {
                    untracked_files.push(clean_path);
                } else if status_code.contains('A') {
                    added_files.push(clean_path);
                } else if status_code.contains('M') || status_code.contains('D') || status_code.contains('R') {
                    modified_files.push(clean_path);
                }
            }
        }
    }

    Ok(WorkspaceGitStatus {
        is_repo: true,
        repo_name,
        branch,
        modified_files,
        added_files,
        untracked_files,
    })
}

/// Get git diff of a specific file in the workspace
#[tauri::command]
pub async fn get_workspace_file_diff(
    payload: GetWorkspaceFileDiffPayload,
    state: State<'_, AppState>,
) -> Result<WorkspaceFileDiff, String> {
    let canonical_root = resolve_canonical_workspace_root(payload.working_directory.as_deref(), &state).await?;
    let canonical_file = validate_and_resolve_child_path(&canonical_root, &payload.relative_path)?;

    let relative_posix = compute_relative_posix_path(&canonical_root, &canonical_file)?;

    // First try: git diff HEAD -- <file>
    let diff_output = tokio::process::Command::new("git")
        .args(["diff", "HEAD", "--", &relative_posix])
        .current_dir(&canonical_root)
        .output()
        .await;

    let mut diff_str = String::new();
    if let Ok(out) = diff_output {
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        if !stdout.trim().is_empty() {
            diff_str = stdout;
        }
    }

    // If diff is still empty, check if it is a new/untracked file
    if diff_str.is_empty() {
        let untracked_diff = tokio::process::Command::new("git")
            .args(["diff", "--no-index", "--", "/dev/null", &relative_posix])
            .current_dir(&canonical_root)
            .output()
            .await;

        if let Ok(out) = untracked_diff {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if !stdout.trim().is_empty() {
                diff_str = stdout;
            }
        }
    }

    let has_diff = !diff_str.trim().is_empty();

    Ok(WorkspaceFileDiff {
        relative_path: relative_posix,
        has_diff,
        diff: diff_str,
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_workspace_file_tree_security_and_operations() {
        struct TempDirGuard {
            path: PathBuf,
        }
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }

        let temp_root = std::env::temp_dir().join(format!(
            "pi_viewer_ws_tree_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_root).expect("Failed to create temp root");
        let _guard = TempDirGuard {
            path: temp_root.clone(),
        };

        let canonical_root = dunce::canonicalize(&temp_root).unwrap();

        // 1. Path traversal security checks
        assert!(validate_and_resolve_child_path(&canonical_root, "../outside").is_err());
        assert!(validate_and_resolve_child_path(&canonical_root, "foo/../../outside").is_err());
        assert!(validate_and_resolve_child_path(&canonical_root, "..").is_err());

        // 2. Relative path resolution for empty or current dir
        let root_res = validate_and_resolve_child_path(&canonical_root, "");
        assert_eq!(root_res.unwrap(), canonical_root);
        let dot_res = validate_and_resolve_child_path(&canonical_root, ".");
        assert_eq!(dot_res.unwrap(), canonical_root);

        // 3. Create nested structure
        let src_dir = canonical_root.join("src");
        let git_dir = canonical_root.join(".git");
        let node_modules_dir = canonical_root.join("node_modules");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(&node_modules_dir).unwrap();

        let readme_file = canonical_root.join("README.md");
        std::fs::write(&readme_file, "# Test Workspace\nHello world!").unwrap();

        let sub_file = src_dir.join("main.rs");
        std::fs::write(&sub_file, "fn main() {}\n").unwrap();

        let git_file = git_dir.join("config");
        std::fs::write(&git_file, "gitconfig").unwrap();

        // 4. Test child path resolution
        let resolved_readme = validate_and_resolve_child_path(&canonical_root, "README.md").unwrap();
        assert_eq!(resolved_readme, dunce::canonicalize(&readme_file).unwrap());

        let rel_posix = compute_relative_posix_path(&canonical_root, &resolved_readme).unwrap();
        assert_eq!(rel_posix, "README.md");

        let resolved_sub = validate_and_resolve_child_path(&canonical_root, "src/main.rs").unwrap();
        let sub_rel = compute_relative_posix_path(&canonical_root, &resolved_sub).unwrap();
        assert_eq!(sub_rel, "src/main.rs");

        // 5. Test binary vs text file reading logic
        let bin_file = canonical_root.join("sample.bin");
        std::fs::write(&bin_file, &[0x48, 0x65, 0x00, 0x6c, 0x6f]).unwrap(); // Contains null byte
        let bin_bytes = std::fs::read(&bin_file).unwrap();
        assert!(bin_bytes.iter().take(1024).any(|&b| b == 0));

        // 6. Test contracts
        let entry = WorkspaceEntry {
            name: "README.md".to_string(),
            relative_path: "README.md".to_string(),
            is_dir: false,
            size: Some(25),
            extension: Some("md".to_string()),
        };
        let entry_json = serde_json::to_string(&entry).unwrap();
        assert!(entry_json.contains("\"relativePath\":\"README.md\""));
        assert!(entry_json.contains("\"isDir\":false"));
        let deserialized_entry: WorkspaceEntry = serde_json::from_str(&entry_json).unwrap();
        assert_eq!(deserialized_entry, entry);

        let content = WorkspaceFileContent {
            relative_path: "README.md".to_string(),
            name: "README.md".to_string(),
            content: "# Test Workspace\nHello world!".to_string(),
            size: 25,
            is_binary: false,
            extension: Some("md".to_string()),
            kind: Some("text".to_string()),
            mime_type: None,
            media_data_url: None,
        };
        let content_json = serde_json::to_string(&content).unwrap();
        assert!(content_json.contains("\"content\":\"# Test Workspace\\nHello world!\""));
        assert!(content_json.contains("\"isBinary\":false"));
        assert!(content_json.contains("\"kind\":\"text\""));
        let deserialized_content: WorkspaceFileContent = serde_json::from_str(&content_json).unwrap();
        assert_eq!(deserialized_content, content);

        // 7. Parity tests: deterministic binary identification
        assert!(is_deterministic_binary_filename("libcrypto.so.1"));
        assert!(is_deterministic_binary_filename("libc.so.6"));
        assert!(is_deterministic_binary_filename("app.db-wal"));
        assert!(is_deterministic_binary_filename("app.db-shm"));
        assert!(is_deterministic_binary_filename("program.exe"));
        assert!(is_deterministic_binary_filename("archive.tar.gz"));
        assert!(!is_deterministic_binary_filename("README.md"));
        assert!(!is_deterministic_binary_filename("config.toml"));
        assert!(!is_deterministic_binary_filename("app.log"));

        // 8. Parity tests: media mime classification
        assert_eq!(get_image_mime_type("photo.png"), Some("image/png"));
        assert_eq!(get_image_mime_type("vector.svg"), Some("image/svg+xml"));
        assert_eq!(get_video_mime_type("clip.mp4"), Some("video/mp4"));
        assert_eq!(get_video_mime_type("movie.webm"), Some("video/webm"));
        assert_eq!(get_image_mime_type("main.rs"), None);

        // 9. Parity tests: byte inspection
        assert!(is_binary_byte_buffer(&[0x48, 0x00, 0x49])); // NUL
        assert!(is_binary_byte_buffer(&[0xff, 0xfe, 0x80])); // invalid utf-8
        assert!(is_binary_byte_buffer(&[0x48, 0x01, 0x49])); // control char
        assert!(!is_binary_byte_buffer(b"Hello world!\n\tTabbed\r\n")); // valid text

        let git_status = WorkspaceGitStatus {
            is_repo: true,
            repo_name: Some("test-repo".to_string()),
            branch: Some("main".to_string()),
            modified_files: vec!["src/main.rs".to_string()],
            added_files: vec!["README.md".to_string()],
            untracked_files: vec!["sample.bin".to_string()],
        };
        let git_status_json = serde_json::to_string(&git_status).unwrap();
        assert!(git_status_json.contains("\"isRepo\":true"));
        assert!(git_status_json.contains("\"repoName\":\"test-repo\""));
        assert!(git_status_json.contains("\"branch\":\"main\""));
        assert!(git_status_json.contains("\"modifiedFiles\":[\"src/main.rs\"]"));
        let deserialized_git: WorkspaceGitStatus = serde_json::from_str(&git_status_json).unwrap();
        assert_eq!(deserialized_git, git_status);

        let file_diff = WorkspaceFileDiff {
            relative_path: "src/main.rs".to_string(),
            has_diff: true,
            diff: "+fn main() {}\n".to_string(),
        };
        let file_diff_json = serde_json::to_string(&file_diff).unwrap();
        assert!(file_diff_json.contains("\"hasDiff\":true"));
        assert!(file_diff_json.contains("\"diff\":\"+fn main() {}\\n\""));
        let deserialized_diff: WorkspaceFileDiff = serde_json::from_str(&file_diff_json).unwrap();
        assert_eq!(deserialized_diff, file_diff);
    }

}
