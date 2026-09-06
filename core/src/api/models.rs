//! Local model catalog CRUD (the models the user enabled from remote listings).

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::error::ApiError;
use crate::state::AppState;
use sqlx::Row as _;

use crate::storage::ModelRow;

#[derive(Serialize)]
pub struct ModelDto {
    #[serde(flatten)]
    pub row: ModelRow,
    pub provider_kind: String,
    pub provider_name: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for ModelDto {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(ModelDto {
            row: sqlx::FromRow::from_row(row)?,
            provider_kind: row.try_get("provider_kind")?,
            provider_name: row.try_get("provider_name")?,
        })
    }
}

#[derive(Deserialize)]
pub struct UpsertModel {
    pub provider_id: String,
    pub model_id: String,
    pub display_name: Option<String>,
    pub supports_vision: Option<bool>,
    pub supports_tools: Option<bool>,
    pub supports_reasoning: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateModel {
    pub display_name: Option<String>,
    /// `Some(None)` clears; `None` keeps the current value.
    pub color: Option<Option<String>>,
    /// `Some(None)` clears; `None` keeps the current value.
    pub temperature: Option<Option<f64>>,
    /// `Some(None)` clears; `None` keeps the current value.
    pub max_tokens: Option<Option<i64>>,
    /// `Some(None)` clears; `None` keeps the current value.
    pub system_prompt_override: Option<Option<String>>,
    pub supports_vision: Option<bool>,
    pub supports_tools: Option<bool>,
    pub supports_reasoning: Option<bool>,
    /// Think toggle. `Some(bool)` sets it; `None` keeps the current value.
    pub reasoning_enabled: Option<bool>,
    pub enabled: Option<bool>,
}

const MODEL_SELECT: &str = "SELECT m.*, p.kind AS provider_kind, p.name AS provider_name
    FROM models m JOIN providers p ON p.id = m.provider_id";

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<ModelDto>>, ApiError> {
    let rows: Vec<ModelDto> = sqlx::query_as(&format!(
        "{MODEL_SELECT} ORDER BY p.created_at ASC, m.display_name ASC"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ModelDto>, ApiError> {
    sqlx::query_as(&format!("{MODEL_SELECT} WHERE m.id = ?"))
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("model {id} not found")))
}

pub async fn upsert(
    State(state): State<AppState>,
    Json(body): Json<UpsertModel>,
) -> Result<Json<ModelDto>, ApiError> {
    if body.model_id.trim().is_empty() {
        return Err(ApiError::bad_request("model_id is required"));
    }
    let provider_exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM providers WHERE id = ?")
            .bind(&body.provider_id)
            .fetch_optional(&state.db)
            .await?;
    if provider_exists.is_none() {
        return Err(ApiError::not_found(format!(
            "provider {} not found",
            body.provider_id
        )));
    }

    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| body.model_id.clone());

    let id = uuid::Uuid::new_v4().to_string();
    // Enable-if-exists, insert-if-new.
    let result = sqlx::query(
        "UPDATE models SET enabled = 1, display_name = ? WHERE provider_id = ? AND model_id = ?",
    )
    .bind(&display_name)
    .bind(&body.provider_id)
    .bind(&body.model_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        sqlx::query(
            "INSERT INTO models (id, provider_id, model_id, display_name, supports_vision,
                                 supports_tools, supports_reasoning, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(&id)
        .bind(&body.provider_id)
        .bind(&body.model_id)
        .bind(&display_name)
        .bind(body.supports_vision.unwrap_or(false))
        .bind(body.supports_tools.unwrap_or(false))
        .bind(body.supports_reasoning.unwrap_or(false))
        .execute(&state.db)
        .await?;
    }

    let model_id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM models WHERE provider_id = ? AND model_id = ?",
    )
    .bind(&body.provider_id)
    .bind(&body.model_id)
    .fetch_one(&state.db)
    .await?;

    let row: ModelDto = sqlx::query_as(&format!("{MODEL_SELECT} WHERE m.id = ?"))
        .bind(&model_id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(row))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateModel>,
) -> Result<Json<ModelDto>, ApiError> {
    let row: ModelRow = sqlx::query_as("SELECT * FROM models WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("model {id} not found")))?;

    // Optional fields replace; absent keeps the current value. Nullable columns use
    // `Option<Option<T>>` so an explicit JSON `null` clears the column.
    let display_name = body.display_name.unwrap_or(row.display_name);
    let color = body.color.unwrap_or(row.color);
    let temperature = body.temperature.unwrap_or(row.temperature);
    let max_tokens = body.max_tokens.unwrap_or(row.max_tokens);
    let system_prompt_override = body.system_prompt_override.unwrap_or(row.system_prompt_override);
    let supports_vision = body.supports_vision.unwrap_or(row.supports_vision);
    let supports_tools = body.supports_tools.unwrap_or(row.supports_tools);
    let supports_reasoning = body.supports_reasoning.unwrap_or(row.supports_reasoning);
    let reasoning_enabled = body.reasoning_enabled.or(row.reasoning_enabled);
    let enabled = body.enabled.unwrap_or(row.enabled);

    sqlx::query(
        "UPDATE models SET display_name = ?, color = ?, temperature = ?, max_tokens = ?,
                system_prompt_override = ?, supports_vision = ?, supports_tools = ?,
                supports_reasoning = ?, reasoning_enabled = ?, enabled = ? WHERE id = ?",
    )
    .bind(&display_name)
    .bind(&color)
    .bind(temperature)
    .bind(max_tokens)
    .bind(&system_prompt_override)
    .bind(supports_vision)
    .bind(supports_tools)
    .bind(supports_reasoning)
    .bind(reasoning_enabled)
    .bind(enabled)
    .bind(&id)
    .execute(&state.db)
    .await?;

    let row: ModelDto = sqlx::query_as(&format!("{MODEL_SELECT} WHERE m.id = ?"))
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(row))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let result = sqlx::query("DELETE FROM models WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("model {id} not found")));
    }
    Ok(Json(serde_json::json!({ "deleted": true })))
}
