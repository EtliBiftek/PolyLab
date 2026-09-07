//! Voice input: `POST /api/audio/transcribe` sends a recorded audio clip
//! (base64 JSON body) to the configured OpenAI provider's Whisper endpoint.
//! Requires an enabled `openai` provider with an API key.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::error::ApiError;
use crate::secrets::provider_key;
use crate::state::AppState;
use crate::storage::ProviderRow;

#[derive(Deserialize)]
pub struct TranscribeBody {
    /// Raw audio bytes, base64-encoded (MediaRecorder output, e.g. webm/ogg).
    pub data_base64: String,
    /// MIME type for the multipart upload (e.g. "audio/webm").
    pub mime_type: String,
    /// Optional BCP-47 language hint (e.g. "tr", "en").
    pub language: Option<String>,
}

#[derive(Serialize)]
pub struct TranscribeResponse {
    pub text: String,
}

#[derive(Deserialize)]
pub struct SpeechBody {
    pub text: String,
    pub voice: Option<String>,
    pub model: Option<String>,
}

#[derive(Serialize)]
pub struct SpeechResponse {
    pub audio_base64: String,
    pub mime_type: String,
}

/// `POST /api/audio/speech` — text-to-speech through the OpenAI provider
/// (`/audio/speech`, e.g. `tts-1`/`gpt-4o-mini-tts`). Needs an openai key.
pub async fn speech(
    State(state): State<AppState>,
    Json(body): Json<SpeechBody>,
) -> Result<Json<SpeechResponse>, ApiError> {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(ApiError::bad_request("text must not be empty".into()));
    }
    if text.chars().count() > 4000 {
        return Err(ApiError::bad_request("text too long (4000 chars max)".into()));
    }
    let provider: ProviderRow = sqlx::query_as(
        "SELECT * FROM providers WHERE kind = 'openai' AND enabled = 1
         ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        ApiError::bad_request(
            "ses sentezi için etkin bir 'openai' sağlayıcısı ve API anahtarı gerekli".into(),
        )
    })?;
    let api_key = state
        .secrets
        .get(&provider_key(&provider.id))
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::bad_request("openai sağlayıcısında API anahtarı yok".into()))?;
    let base = provider
        .base_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    let response = reqwest::Client::new()
        .post(format!("{base}/audio/speech"))
        .bearer_auth(api_key)
        .json(&json!({
            "model": body.model.as_deref().unwrap_or("tts-1"),
            "voice": body.voice.as_deref().unwrap_or("alloy"),
            "input": text,
            "response_format": "mp3",
        }))
        .send()
        .await
        .map_err(|error| ApiError::internal(format!("ses sentezi isteği başarısız: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(ApiError::internal(format!(
            "ses sentezi hatası ({status}): {detail}"
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ApiError::internal(format!("ses yanıtı okunamadı: {error}")))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(ApiError::bad_request("ses çıktısı çok büyük".into()));
    }
    Ok(Json(SpeechResponse {
        audio_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &bytes,
        ),
        mime_type: "audio/mpeg".to_string(),
    }))
}

/// `POST /api/audio/transcribe`
pub async fn transcribe(
    State(state): State<AppState>,
    Json(body): Json<TranscribeBody>,
) -> Result<Json<TranscribeResponse>, ApiError> {
    let provider: ProviderRow = sqlx::query_as(
        "SELECT * FROM providers WHERE kind = 'openai' AND enabled = 1
         ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        ApiError::bad_request(
            "ses tanıma için etkin bir 'openai' sağlayıcısı ve API anahtarı gerekli".into(),
        )
    })?;
    let api_key = state
        .secrets
        .get(&provider_key(&provider.id))
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::bad_request("openai sağlayıcısında API anahtarı yok".into()))?;
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &body.data_base64)
        .map_err(|error| ApiError::bad_request(format!("geçersiz ses verisi: {error}")))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(ApiError::bad_request("ses kaydı çok büyük (25 MB sınırı)".into()));
    }

    let base = provider
        .base_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    let mime = if body.mime_type.is_empty() {
        "audio/webm"
    } else {
        body.mime_type.as_str()
    };
    let mut form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("recording.{mime}"))
                .mime_str(mime)
                .map_err(|error| ApiError::bad_request(format!("geçersiz MIME: {error}")))?,
        )
        .part("model", reqwest::multipart::Part::text("whisper-1"));
    if let Some(language) = body.language.as_deref().filter(|l| !l.trim().is_empty()) {
        form = form.part("language", reqwest::multipart::Part::text(language.to_string()));
    }

    let response = reqwest::Client::new()
        .post(format!("{base}/audio/transcriptions"))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| ApiError::internal(format!("ses tanıma isteği başarısız: {error}")))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| ApiError::internal(format!("ses tanıma yanıtı okunamadı: {error}")))?;
    if !status.is_success() {
        return Err(ApiError::internal(format!(
            "ses tanıma hatası ({status}): {}",
            value.get("error").and_then(|e| e["message"].as_str()).unwrap_or("bilinmeyen hata")
        )));
    }
    let text = value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(Json(TranscribeResponse { text }))
}
