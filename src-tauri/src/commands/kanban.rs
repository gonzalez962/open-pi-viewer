//! Fixed project-local Kanban persistence; never accepts arbitrary file paths.
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}, process::Command};
use serde::{Deserialize, Serialize};
use super::AppState;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCard {
    pub id: String,
    pub title: String,
    pub description: String,
    pub column_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KanbanBoard { pub cards: Vec<KanbanCard> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanPayload { working_directory: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveKanbanPayload { working_directory: String, board: KanbanBoard }

fn validate(board: &KanbanBoard) -> Result<(), String> {
    if board.cards.len() > 2000 { return Err("Invalid Kanban board: too many cards".into()); }
    let mut ids = HashSet::new();
    for card in &board.cards {
        if card.id.trim().is_empty() || card.id.encode_utf16().count() > 128 || !ids.insert(&card.id) {
            return Err("Invalid Kanban card id".into());
        }
        if card.title.trim().is_empty() || card.title.encode_utf16().count() > 200 {
            return Err("Invalid Kanban card title".into());
        }
        if card.description.encode_utf16().count() > 10000 { return Err("Invalid Kanban description".into()); }
        if !["pending", "in_progress", "done"].contains(&card.column_id.as_str()) {
            return Err("Invalid Kanban column".into());
        }
    }
    Ok(())
}

fn root(cwd: &str) -> Result<PathBuf, String> {
    let path = Path::new(cwd);
    if cwd.trim().is_empty() || !path.is_absolute() || !path.is_dir() {
        return Err("Invalid workingDirectory: an absolute project directory is required".into());
    }
    dunce::canonicalize(path).map_err(|e| e.to_string())
}

fn safe_path(path: &Path, directory: bool) -> Result<bool, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let mut link = meta.file_type().is_symlink();
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        link |= meta.file_attributes() & 0x400 != 0; // Reparse points include junctions.
    }
    if link { return Err("Kanban storage symlink is not allowed (project containment)".into()); }
    if if directory { !meta.is_dir() } else { !meta.is_file() } {
        return Err("Invalid Kanban storage path".into());
    }
    Ok(true)
}

fn read_board(root: &Path) -> Result<KanbanBoard, String> {
    if !safe_path(&root.join(".pi"), true)? { return Ok(KanbanBoard { cards: vec![] }); }
    let file = root.join(".pi/kanban.json");
    if !safe_path(&file, false)? { return Ok(KanbanBoard { cards: vec![] }); }
    if fs::metadata(&file).map_err(|e| e.to_string())?.len() > 24 * 1024 * 1024 {
        return Err("Invalid Kanban JSON: file too large".into());
    }
    let board: KanbanBoard = serde_json::from_str(&fs::read_to_string(file).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Invalid Kanban JSON: {e}"))?;
    validate(&board)?;
    Ok(board)
}

fn atomic_write(file: &Path, data: &[u8]) -> Result<(), String> {
    let temp = file.with_file_name(format!("{}.tmp-{}", file.file_name().unwrap().to_string_lossy(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        output.write_all(data)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temp, file)
    })();
    if temp.exists() { let _ = fs::remove_file(&temp); }
    result.map_err(|e: std::io::Error| e.to_string())
}

fn save_board(root: &Path, mut board: KanbanBoard) -> Result<KanbanBoard, String> {
    validate(&board)?;
    read_board(root)?; // Refuse to overwrite corrupt or linked data.
    let ignore = root.join(".gitignore");
    let previous = if safe_path(&ignore, false)? { fs::read_to_string(&ignore).map_err(|e| e.to_string())? } else { String::new() };
    let check = Command::new("git").arg("-C").arg(root)
        .args(["check-ignore", "-q", "--", ".pi/kanban.json"]).output();
    let ignored = match check {
        Ok(output) if output.status.success() => true,
        Ok(output) if output.status.code() == Some(128) => previous.lines().any(|line| line == "/.pi/kanban.json"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => previous.lines().any(|line| line == "/.pi/kanban.json"),
        _ => false,
    };
    if !safe_path(&root.join(".pi"), true)? { fs::create_dir(root.join(".pi")).map_err(|e| e.to_string())?; }
    if !ignored {
        let eol = if previous.contains("\r\n") { "\r\n" } else { "\n" };
        let prefix = if previous.is_empty() || previous.ends_with('\n') { "" } else { eol };
        atomic_write(&ignore, format!("{previous}{prefix}/.pi/kanban.json{eol}").as_bytes())?;
    }
    for card in &mut board.cards { card.title = card.title.trim().to_string(); }
    let json = serde_json::to_string_pretty(&board).map_err(|e| e.to_string())? + "\n";
    atomic_write(&root.join(".pi/kanban.json"), json.as_bytes())?;
    Ok(board)
}

#[tauri::command]
pub async fn get_project_kanban(payload: KanbanPayload, state: tauri::State<'_, AppState>) -> Result<KanbanBoard, String> {
    let _guard = state.storage_lock.lock().await;
    read_board(&root(&payload.working_directory)?)
}

#[tauri::command]
pub async fn save_project_kanban(payload: SaveKanbanPayload, state: tauri::State<'_, AppState>) -> Result<KanbanBoard, String> {
    let _guard = state.storage_lock.lock().await;
    save_board(&root(&payload.working_directory)?, payload.board)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kanban_roundtrip_and_rejected_save_preserves_data() {
        let dir = std::env::temp_dir().join(format!("pi-kanban-rust-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        assert!(read_board(&dir).unwrap().cards.is_empty());
        assert!(!dir.join(".pi").exists());
        let board = KanbanBoard { cards: vec![KanbanCard { id: "one".into(), title: "Task".into(), description: "Details".into(), column_id: "pending".into() }] };
        save_board(&dir, board.clone()).unwrap();
        assert_eq!(read_board(&dir).unwrap(), board);
        let ignore = fs::read_to_string(dir.join(".gitignore")).unwrap();
        save_board(&dir, board.clone()).unwrap();
        assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), ignore);
        let mut invalid = board.clone();
        invalid.cards[0].column_id = "invalid".into();
        assert!(save_board(&dir, invalid).is_err());
        assert_eq!(read_board(&dir).unwrap(), board);
        let file = dir.join(".pi/kanban.json");
        fs::write(&file, "{broken").unwrap();
        assert!(read_board(&dir).is_err());
        assert!(save_board(&dir, board).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "{broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
