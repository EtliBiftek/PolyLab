//! Conversation folders (Phase 3) — thin CRUD over the `folders` table;
//! conversations reference folders via `folder_id`.

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::error::ApiError;
use crate::state::AppState;
use crate::storage::now_rfc3339;

#[derive(Debug, Clone, Serialize)]
pub struct FolderRow {
    pub id: String,
    pub name: String,
    pub position: i64,
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for FolderRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(FolderRow {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            position: row.try_get("position")?,
        })
    }
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<FolderRow>>, ApiError> {
    let rows: Vec<FolderRow> =
        sqlx::query_as("SELECT * FROM folders ORDER BY position ASC, name ASC")
            .fetch_all(&state.db)
            .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateFolder {
    pub name: String,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateFolder>,
) -> Result<Json<FolderRow>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("folder name cannot be empty"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let position: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position), -1) + 1 FROM folders")
        .fetch_one(&state.db)
        .await?;
    sqlx::query("INSERT INTO folders (id, name, position) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(name)
        .bind(position)
        .execute(&state.db)
        .await?;
    let row: FolderRow =
        sqlx::query_as("SELECT * FROM folders WHERE id = ?").bind(&id).fetch_one(&state.db).await?;
    let _ = now_rfc3339();
    Ok(Json(row))
}

#[derive(Deserialize)]
pub struct UpdateFolder {
    pub name: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateFolder>,
) -> Result<Json<FolderRow>, ApiError> {
    if let Some(name) = body.name.as_deref() {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::bad_request("folder name cannot be empty"));
        }
        sqlx::query("UPDATE folders SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    let row: FolderRow = sqlx::query_as("SELECT * FROM folders WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("folder {id} not found")))?;
    Ok(Json(row))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    let result = sqlx::query("DELETE FROM folders WHERE id = ?").bind(&id).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("folder {id} not found")));
    }
    // Detach conversations that pointed here.
    sqlx::query("UPDATE conversations SET folder_id = NULL WHERE folder_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
