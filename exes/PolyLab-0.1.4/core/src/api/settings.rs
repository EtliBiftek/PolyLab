//! Key/value settings (`settings` table; values are stored as JSON).

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use super::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct PutSetting {
    pub key: String,
    pub value: Value,
}

pub async fn list(State(state): State<AppState>) -> Result<Json<serde_json::Map<String, Value>>, ApiError> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value_json FROM settings")
        .fetch_all(&state.db)
        .await?;
    let mut map = serde_json::Map::new();
    for (key, raw) in rows {
        if let Ok(value) = serde_json::from_str(&raw) {
            map.insert(key, value);
        }
    }
    Ok(Json(map))
}

pub async fn put(
    State(state): State<AppState>,
    Json(body): Json<PutSetting>,
) -> Result<Json<Value>, ApiError> {
    if body.key.trim().is_empty() {
        return Err(ApiError::bad_request("setting key is required"));
    }
    let raw = body.value.to_string();
    sqlx::query("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
        .bind(body.key.trim())
        .bind(&raw)
        .execute(&state.db)
        .await?;
    Ok(Json(body.value))
}
