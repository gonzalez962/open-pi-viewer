//! Speech management commands for Tauri native backend.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::command;

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
