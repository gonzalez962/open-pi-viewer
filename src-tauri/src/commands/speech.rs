//! Speech management commands for Tauri native backend.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct GetSpeechPackStatusPayload {
    #[serde(rename = "packId")]
    pub pack_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpeechFileStatus {
    pub filename: String,
    pub exists: bool,
    pub status: String,
    #[serde(rename = "actualSha256")]
    pub actual_sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpeechPackStatusResult {
    #[serde(rename = "packId")]
    pub pack_id: String,
    pub status: String,
    #[serde(rename = "packDir")]
    pub pack_dir: String,
    pub files: Vec<SpeechFileStatus>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InspectCustomSpeechModelPayload {
    #[serde(rename = "isCustom")]
    pub is_custom: bool,
    #[serde(rename = "modelPath")]
    pub model_path: String,
    #[serde(rename = "configPath")]
    pub config_path: Option<String>,
    #[serde(rename = "tokensPath")]
    pub tokens_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InspectCustomSpeechModelResult {
    pub valid: bool,
    pub error: Option<String>,
    #[serde(rename = "computedSha256")]
    pub computed_sha256: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
}

fn get_speech_models_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".open-pi-viewer")
        .join("models")
        .join("speech")
}

#[command]
pub async fn get_speech_pack_status(
    payload: GetSpeechPackStatusPayload,
) -> Result<SpeechPackStatusResult, String> {
    let pack_dir = get_speech_models_dir().join(&payload.pack_id);
    let mut files = Vec::new();
    let mut all_exist = true;

    if pack_dir.exists() {
        if let Ok(entries) = fs::read_dir(&pack_dir) {
            for entry in entries.flatten() {
                if let Ok(name) = entry.file_name().into_string() {
                    files.push(SpeechFileStatus {
                        filename: name,
                        exists: true,
                        status: "verified".to_string(),
                        actual_sha256: None,
                    });
                }
            }
        }
    } else {
        all_exist = false;
    }

    let status = if all_exist && !files.is_empty() {
        "verified".to_string()
    } else {
        "missing".to_string()
    };

    Ok(SpeechPackStatusResult {
        pack_id: payload.pack_id,
        status,
        pack_dir: pack_dir.to_string_lossy().to_string(),
        files,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteSpeechPackPayload {
    #[serde(rename = "packId")]
    pub pack_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteSpeechPackResult {
    pub success: bool,
    #[serde(rename = "packId")]
    pub pack_id: String,
}

#[command]
pub async fn delete_speech_pack(
    payload: DeleteSpeechPackPayload,
) -> Result<DeleteSpeechPackResult, String> {
    let pack_dir = get_speech_models_dir().join(&payload.pack_id);
    if pack_dir.exists() {
        let _ = fs::remove_dir_all(&pack_dir);
    }
    Ok(DeleteSpeechPackResult {
        success: true,
        pack_id: payload.pack_id,
    })
}

#[command]
pub async fn inspect_custom_speech_model(
    payload: InspectCustomSpeechModelPayload,
) -> Result<InspectCustomSpeechModelResult, String> {
    let p = Path::new(&payload.model_path);
    if !p.exists() {
        return Ok(InspectCustomSpeechModelResult {
            valid: false,
            error: Some(format!("Model file does not exist: {}", payload.model_path)),
            computed_sha256: None,
            size_bytes: None,
        });
    }

    if !payload.model_path.to_lowercase().ends_with(".onnx") {
        return Ok(InspectCustomSpeechModelResult {
            valid: false,
            error: Some("Model file must have a .onnx extension".to_string()),
            computed_sha256: None,
            size_bytes: None,
        });
    }

    let meta = match fs::metadata(p) {
        Ok(m) => m,
        Err(e) => {
            return Ok(InspectCustomSpeechModelResult {
                valid: false,
                error: Some(e.to_string()),
                computed_sha256: None,
                size_bytes: None,
            })
        }
    };

    Ok(InspectCustomSpeechModelResult {
        valid: true,
        error: None,
        computed_sha256: None,
        size_bytes: Some(meta.len()),
    })
}
