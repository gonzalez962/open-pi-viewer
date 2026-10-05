//! Native conversation export save dialog and file writer.
//!
//! Reuses existing `rfd` file dialogs and tokio `spawn_blocking` without adding
//! new plugins or expanding filesystem capabilities.
//! User-selected save path only; arbitrary caller-selected paths are rejected.

use std::path::{Component, Path, PathBuf};

/// Allowed export format types
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Markdown,
    Json,
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Json => "json",
        }
    }

    pub fn filter_name(&self) -> &'static str {
        match self {
            Self::Markdown => "Markdown (*.md)",
            Self::Json => "JSON (*.json)",
        }
    }

    pub fn filter_extensions(&self) -> &'static [&'static str] {
        match self {
            Self::Markdown => &["md", "markdown"],
            Self::Json => &["json"],
        }
    }
}

/// Validates export format against allowed types: markdown (or md) and json.
pub fn validate_format(format_str: &str) -> Result<ExportFormat, String> {
    let trimmed = format_str.trim().to_ascii_lowercase();
    match trimmed.as_str() {
        "markdown" | "md" => Ok(ExportFormat::Markdown),
        "json" => Ok(ExportFormat::Json),
        _ => Err(format!(
            "Unsupported export format '{}': only 'markdown' (or 'md') and 'json' are allowed",
            format_str
        )),
    }
}

/// Checks whether a filename stem is a Windows reserved device name.
pub fn is_windows_reserved_device_name(name: &str) -> bool {
    let stem = match name.split('.').next() {
        Some(s) => s.trim(),
        None => name.trim(),
    };
    let stem_lower = stem.to_ascii_lowercase();
    matches!(
        stem_lower.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

/// Validates that suggested default filename is a safe single path component:
/// - Rejects directory separators (`/`, `\`) and path traversal (`..`).
/// - Rejects control characters, null bytes, and invalid filesystem characters.
/// - Rejects Windows reserved device names.
/// - Rejects trailing periods or spaces.
pub fn validate_suggested_filename(filename: &str) -> Result<String, String> {
    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    if filename.starts_with(' ') || filename.ends_with(' ') {
        return Err("Filename cannot have leading or trailing spaces".to_string());
    }

    if filename.ends_with('.') {
        return Err("Filename cannot end with a period".to_string());
    }

    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return Err("Filename cannot be empty or whitespace only".to_string());
    }

    if trimmed.chars().any(|c| c == '\0') {
        return Err("Filename contains null byte".to_string());
    }

    if trimmed.chars().any(|c| c.is_control()) {
        return Err("Filename contains control characters".to_string());
    }

    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Filename cannot contain directory separators".to_string());
    }

    let disallowed_chars = ['?', '%', '*', ':', '|', '"', '<', '>'];
    if trimmed.chars().any(|c| disallowed_chars.contains(&c)) {
        return Err("Filename contains invalid filesystem characters".to_string());
    }

    let path = Path::new(trimmed);
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(comp)) => {
            if components.next().is_some() {
                return Err("Filename must be a single path component".to_string());
            }
            let comp_str = comp.to_string_lossy();
            if comp_str == "." || comp_str == ".." {
                return Err("Filename cannot be a relative directory indicator".to_string());
            }
        }
        _ => {
            return Err("Filename must be a single normal path component".to_string());
        }
    }

    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err("Filename cannot end with a period or space".to_string());
    }

    if is_windows_reserved_device_name(trimmed) {
        return Err(format!(
            "Filename '{}' uses a reserved system device name",
            trimmed
        ));
    }

    Ok(trimmed.to_string())
}

/// Ensures the user-selected path has the appropriate extension for the export format.
/// If an extension is added or adjusted, ensures it does not independently overwrite
/// an existing file that the user was not prompted to replace in the dialog.
pub fn ensure_appropriate_extension(
    selected_path: PathBuf,
    format: ExportFormat,
) -> Result<PathBuf, String> {
    let expected_ext = format.extension();
    let has_matching_ext = match selected_path.extension().and_then(|e| e.to_str()) {
        Some(ext) => match format {
            ExportFormat::Markdown => {
                ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
            }
            ExportFormat::Json => ext.eq_ignore_ascii_case("json"),
        },
        None => false,
    };

    if has_matching_ext {
        Ok(selected_path)
    } else {
        let adjusted_path = match selected_path.extension() {
            None => selected_path.with_extension(expected_ext),
            Some(_) => {
                let mut p = selected_path.clone();
                p.set_extension(expected_ext);
                p
            }
        };

        // If the path was modified from what the user selected, ensure we don't
        // independently overwrite an existing file that the user was not prompted for
        if adjusted_path != selected_path && adjusted_path.exists() {
            return Err(format!(
                "Target file '{}' already exists. Choose a different name or confirm overwrite in the save dialog.",
                adjusted_path.display()
            ));
        }

        Ok(adjusted_path)
    }
}

/// Writes UTF-8 text content to the target file path.
pub fn write_export_file(path: &Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content.as_bytes())
        .map_err(|e| format!("Failed to write export file '{}': {}", path.display(), e))
}

/// Injectable implementation for testing save dialog behavior without opening OS GUI dialogs.
pub async fn save_conversation_export_with_dialog<F>(
    default_filename: String,
    content: String,
    format_str: String,
    dialog_fn: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(&str, ExportFormat) -> Option<PathBuf> + Send + 'static,
{
    let format = validate_format(&format_str)?;
    let validated_filename = validate_suggested_filename(&default_filename)?;

    let picked_path = tokio::task::spawn_blocking(move || {
        dialog_fn(&validated_filename, format)
    })
    .await
    .map_err(|e| format!("Failed to run file dialog: {e}"))?;

    let Some(raw_path) = picked_path else {
        return Ok(None);
    };

    let target_path = ensure_appropriate_extension(raw_path, format)?;
    write_export_file(&target_path, &content)?;

    Ok(Some(target_path.to_string_lossy().to_string()))
}

/// Prompts the user to save a conversation export via the native OS Save As dialog.
///
/// Runs the save dialog on a dedicated blocking thread via `tokio::task::spawn_blocking`.
/// The OS save dialog handles explicit user overwrite confirmation for existing files.
/// Writes UTF-8 text to the selected path before returning the saved path to the frontend.
/// Dialog cancellation returns `Ok(None)` without writing.
#[tauri::command]
pub async fn save_conversation_export(
    default_filename: String,
    content: String,
    format: String,
) -> Result<Option<String>, String> {
    save_conversation_export_with_dialog(
        default_filename,
        content,
        format,
        |suggested_name, fmt| {
            let mut dialog = rfd::FileDialog::new()
                .set_title("Export Conversation")
                .set_file_name(suggested_name);

            dialog = dialog.add_filter(fmt.filter_name(), fmt.filter_extensions());
            dialog.save_file()
        },
    )
    .await
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

    fn create_test_dir(prefix: &str) -> (PathBuf, TempDirGuard) {
        let path = std::env::temp_dir().join(format!(
            "{}_{}_{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("Failed to create test temp dir");
        let guard = TempDirGuard { path: path.clone() };
        (path, guard)
    }

    #[test]
    fn test_validate_format_allowed_types() {
        assert_eq!(validate_format("markdown").unwrap(), ExportFormat::Markdown);
        assert_eq!(validate_format("md").unwrap(), ExportFormat::Markdown);
        assert_eq!(validate_format("MD").unwrap(), ExportFormat::Markdown);
        assert_eq!(validate_format("Markdown").unwrap(), ExportFormat::Markdown);
        assert_eq!(validate_format("json").unwrap(), ExportFormat::Json);
        assert_eq!(validate_format("JSON").unwrap(), ExportFormat::Json);
    }

    #[test]
    fn test_validate_format_disallowed_types() {
        assert!(validate_format("").is_err());
        assert!(validate_format("yaml").is_err());
        assert!(validate_format("exe").is_err());
        assert!(validate_format("txt").is_err());
    }

    #[test]
    fn test_validate_suggested_filename_safe() {
        assert_eq!(
            validate_suggested_filename("conversation-export.md").unwrap(),
            "conversation-export.md"
        );
        assert_eq!(
            validate_suggested_filename("chat-2026-03-30.json").unwrap(),
            "chat-2026-03-30.json"
        );
        assert_eq!(
            validate_suggested_filename("simple_file").unwrap(),
            "simple_file"
        );
    }

    #[test]
    fn test_validate_suggested_filename_rejected() {
        // Empty / whitespace
        assert!(validate_suggested_filename("").is_err());
        assert!(validate_suggested_filename("   ").is_err());

        // Null byte
        assert!(validate_suggested_filename("file\0name.md").is_err());

        // Control characters
        assert!(validate_suggested_filename("file\nname.md").is_err());
        assert!(validate_suggested_filename("file\rname.md").is_err());
        assert!(validate_suggested_filename("file\tname.md").is_err());

        // Directory separators & traversal
        assert!(validate_suggested_filename("sub/file.md").is_err());
        assert!(validate_suggested_filename("sub\\file.md").is_err());
        assert!(validate_suggested_filename("../file.md").is_err());
        assert!(validate_suggested_filename("..").is_err());
        assert!(validate_suggested_filename(".").is_err());

        // Disallowed filesystem characters
        assert!(validate_suggested_filename("file?name.md").is_err());
        assert!(validate_suggested_filename("file*name.md").is_err());
        assert!(validate_suggested_filename("file:name.md").is_err());
        assert!(validate_suggested_filename("file|name.md").is_err());
        assert!(validate_suggested_filename("file\"name.md").is_err());
        assert!(validate_suggested_filename("file<name.md").is_err());
        assert!(validate_suggested_filename("file>name.md").is_err());

        // Trailing period / space
        assert!(validate_suggested_filename("filename.").is_err());
        assert!(validate_suggested_filename("filename ").is_err());

        // Windows reserved device names
        assert!(validate_suggested_filename("con.md").is_err());
        assert!(validate_suggested_filename("CON.json").is_err());
        assert!(validate_suggested_filename("prn").is_err());
        assert!(validate_suggested_filename("aux.txt").is_err());
        assert!(validate_suggested_filename("nul").is_err());
        assert!(validate_suggested_filename("com1.md").is_err());
        assert!(validate_suggested_filename("lpt9.json").is_err());
    }

    #[test]
    fn test_ensure_appropriate_extension_matching() {
        let p_md = PathBuf::from("/path/to/file.md");
        assert_eq!(
            ensure_appropriate_extension(p_md.clone(), ExportFormat::Markdown).unwrap(),
            p_md
        );

        let p_markdown = PathBuf::from("/path/to/file.markdown");
        assert_eq!(
            ensure_appropriate_extension(p_markdown.clone(), ExportFormat::Markdown).unwrap(),
            p_markdown
        );

        let p_json = PathBuf::from("/path/to/file.json");
        assert_eq!(
            ensure_appropriate_extension(p_json.clone(), ExportFormat::Json).unwrap(),
            p_json
        );
    }

    #[test]
    fn test_ensure_appropriate_extension_adds_missing() {
        let p_no_ext = PathBuf::from("/path/to/file");
        let result = ensure_appropriate_extension(p_no_ext, ExportFormat::Markdown).unwrap();
        assert_eq!(result, PathBuf::from("/path/to/file.md"));

        let p_no_ext_json = PathBuf::from("/path/to/file");
        let result_json = ensure_appropriate_extension(p_no_ext_json, ExportFormat::Json).unwrap();
        assert_eq!(result_json, PathBuf::from("/path/to/file.json"));
    }

    #[test]
    fn test_ensure_appropriate_extension_prevents_independent_overwrite() {
        let (temp_dir, _guard) = create_test_dir("test_ensure_ext_overwrite");
        let existing_target = temp_dir.join("export.md");
        std::fs::write(&existing_target, "existing data").unwrap();

        // User picked export.txt in the dialog, but adjusted would be export.md
        let user_picked = temp_dir.join("export.txt");
        let result = ensure_appropriate_extension(user_picked, ExportFormat::Markdown);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn test_write_export_file_success() {
        let (temp_dir, _guard) = create_test_dir("test_write_export_success");
        let file_path = temp_dir.join("output.md");
        let content = "# Test Header\n\n- item 1\n- item 2\n";

        let result = write_export_file(&file_path, content);
        assert!(result.is_ok());

        let read_back = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(read_back, content);
    }

    #[test]
    fn test_write_export_file_invalid_path_fails() {
        let invalid_path = PathBuf::from("/non_existent_dir_12345/sub/test.md");
        let result = write_export_file(&invalid_path, "content");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_save_conversation_export_with_dialog_cancellation() {
        let result = save_conversation_export_with_dialog(
            "conversation.md".to_string(),
            "# Hello".to_string(),
            "markdown".to_string(),
            |_filename, _fmt| None,
        )
        .await;

        assert_eq!(result, Ok(None));
    }

    #[tokio::test]
    async fn test_save_conversation_export_with_dialog_success() {
        let (temp_dir, _guard) = create_test_dir("test_save_export_success");
        let target_file = temp_dir.join("my-export.md");
        let target_clone = target_file.clone();

        let content = "# Title\nExport test content\n";
        let result = save_conversation_export_with_dialog(
            "my-export.md".to_string(),
            content.to_string(),
            "markdown".to_string(),
            move |_filename, _fmt| Some(target_clone),
        )
        .await;

        assert!(result.is_ok());
        let returned_path = result.unwrap();
        assert_eq!(returned_path, Some(target_file.to_string_lossy().to_string()));

        let read_back = std::fs::read_to_string(&target_file).unwrap();
        assert_eq!(read_back, content);
    }

    #[tokio::test]
    async fn test_save_conversation_export_with_dialog_validation_error_prevents_dialog() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dialog_invoked = Arc::new(AtomicBool::new(false));
        let dialog_invoked_clone = dialog_invoked.clone();

        let result = save_conversation_export_with_dialog(
            "invalid/filename.md".to_string(),
            "content".to_string(),
            "markdown".to_string(),
            move |_filename, _fmt| {
                dialog_invoked_clone.store(true, Ordering::SeqCst);
                None
            },
        )
        .await;

        assert!(result.is_err());
        assert!(
            !dialog_invoked.load(Ordering::SeqCst),
            "Dialog must NEVER be called when filename is invalid"
        );
    }

    #[tokio::test]
    async fn test_save_conversation_export_with_dialog_invalid_format_prevents_dialog() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dialog_invoked = Arc::new(AtomicBool::new(false));
        let dialog_invoked_clone = dialog_invoked.clone();

        let result = save_conversation_export_with_dialog(
            "filename.md".to_string(),
            "content".to_string(),
            "invalid_format".to_string(),
            move |_filename, _fmt| {
                dialog_invoked_clone.store(true, Ordering::SeqCst);
                None
            },
        )
        .await;

        assert!(result.is_err());
        assert!(
            !dialog_invoked.load(Ordering::SeqCst),
            "Dialog must NEVER be called when format is invalid"
        );
    }
}
