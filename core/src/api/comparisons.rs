//! Persistent model-comparison records: save race/debate outputs, mark a
//! winner, browse and delete comparisons.

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::error::ApiError;
use crate::state::AppState;
use crate::storage::{now_rfc3339, ComparisonDetail, ComparisonEntryRow, ComparisonRow};

#[derive(Deserialize)]
pub struct ComparisonEntryIn {
    pub model_id: String,
    pub resolved_model: Option<String>,
    pub content: String,
    pub reasoning: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub tokens_estimated: Option<bool>,
    pub cost_usd: Option<f64>,
}

#[derive(Deserialize)]
pub struct SaveComparison {
    pub conversation_id: String,
    pub question: Option<String>,
    pub kind: Option<String>,
    /// Optional: mark this entry as the winner in the same call.
    pub winner_entry_id: Option<String>,
    pub entries: Vec<ComparisonEntryIn>,
}

#[derive(Deserialize)]
pub struct WinnerBody {
    pub entry_id: String,
}

async fn load_detail(state: &AppState, id: &str) -> Result<ComparisonDetail, ApiError> {
    let comparison: ComparisonRow = sqlx::query_as("SELECT * FROM comparisons WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("comparison {id} not found")))?;
    let entries: Vec<ComparisonEntryRow> = sqlx::query_as(
        "SELECT * FROM comparison_entries WHERE comparison_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(ComparisonDetail { comparison, entries })
}

/// `POST /api/comparisons` — saves a comparison (race output snapshot).
pub async fn save(
    State(state): State<AppState>,
    Json(body): Json<SaveComparison>,
) -> Result<Json<ComparisonDetail>, ApiError> {
    if body.entries.is_empty() {
        return Err(ApiError::bad_request("a comparison needs at least one entry"));
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM conversations WHERE id = ?")
        .bind(&body.conversation_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found(format!(
            "conversation {} not found",
            body.conversation_id
        )));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO comparisons (id, conversation_id, kind, question, winner_entry_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&body.conversation_id)
    .bind(body.kind.as_deref().unwrap_or("race"))
    .bind(&body.question)
    .bind(&body.winner_entry_id)
    .bind(&now)
    .execute(&state.db)
    .await?;
    for entry in &body.entries {
        sqlx::query(
            "INSERT INTO comparison_entries
             (id, comparison_id, model_id, resolved_model, content, reasoning,
              tokens_in, tokens_out, tokens_estimated, cost_usd, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&id)
        .bind(&entry.model_id)
        .bind(&entry.resolved_model)
        .bind(&entry.content)
        .bind(&entry.reasoning)
        .bind(entry.tokens_in)
        .bind(entry.tokens_out)
        .bind(entry.tokens_estimated.map(|value| value as i64))
        .bind(entry.cost_usd)
        .bind(&now)
        .execute(&state.db)
        .await?;
    }
    Ok(Json(load_detail(&state, &id).await?))
}

/// `GET /api/comparisons` — newest first.
pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<ComparisonRow>>, ApiError> {
    let rows: Vec<ComparisonRow> = sqlx::query_as(
        "SELECT * FROM comparisons ORDER BY created_at DESC, rowid DESC LIMIT 200",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// `GET /api/comparisons/{id}` — comparison + its entries.
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ComparisonDetail>, ApiError> {
    Ok(Json(load_detail(&state, &id).await?))
}

/// `PATCH /api/comparisons/{id}/winner` — marks the winning entry.
pub async fn set_winner(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<WinnerBody>,
) -> Result<Json<ComparisonDetail>, ApiError> {
    let entry: Option<String> = sqlx::query_scalar(
        "SELECT id FROM comparison_entries WHERE id = ? AND comparison_id = ?",
    )
    .bind(&body.entry_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    if entry.is_none() {
        return Err(ApiError::not_found(format!(
            "entry {} not found in comparison {id}",
            body.entry_id
        )));
    }
    sqlx::query("UPDATE comparisons SET winner_entry_id = ? WHERE id = ?")
        .bind(&body.entry_id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(Json(load_detail(&state, &id).await?))
}

/// `DELETE /api/comparisons/{id}`
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let result = sqlx::query("DELETE FROM comparisons WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("comparison {id} not found")));
    }
    Ok(Json(json!({ "deleted": true })))
}
