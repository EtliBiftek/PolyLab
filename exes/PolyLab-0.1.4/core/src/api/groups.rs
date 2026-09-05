//! Model group CRUD + debate replay (plan §5.2, contract docs/EVENTS.md §6).

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;

use super::error::ApiError;
use crate::state::AppState;
use crate::storage::{now_rfc3339, DebateDetail, DebateRow, DebateTurnRow, GroupDetail, GroupRow, ModelRow};

/* ------------------------------------------------------------------- groups --- */

#[derive(Deserialize)]
pub struct CreateGroup {
    pub name: String,
    pub description: Option<String>,
    pub model_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct UpdateGroup {
    pub name: Option<String>,
    pub description: Option<String>,
    pub model_ids: Option<Vec<String>>,
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<GroupDetail>>, ApiError> {
    let groups: Vec<GroupRow> =
        sqlx::query_as("SELECT * FROM model_groups ORDER BY name ASC").fetch_all(&state.db).await?;
    let mut details = Vec::new();
    for group in groups {
        details.push(load_detail(&state.db, group).await?);
    }
    Ok(Json(details))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<GroupDetail>, ApiError> {
    let group: GroupRow = sqlx::query_as("SELECT * FROM model_groups WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("group {id} not found")))?;
    Ok(Json(load_detail(&state.db, group).await?))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateGroup>,
) -> Result<Json<GroupDetail>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("group name cannot be empty"));
    }
    if body.model_ids.len() < 2 {
        return Err(ApiError::bad_request("a debate group needs at least 2 models"));
    }
    validate_models(&state.db, &body.model_ids).await?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO model_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(body.description.as_deref().map(str::trim).filter(|d| !d.is_empty()))
    .bind(&now)
    .execute(&state.db)
    .await?;
    replace_items(&state.db, &id, &body.model_ids).await?;

    let group: GroupRow = sqlx::query_as("SELECT * FROM model_groups WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(load_detail(&state.db, group).await?))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateGroup>,
) -> Result<Json<GroupDetail>, ApiError> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM model_groups WHERE id = ?").bind(&id).fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(ApiError::not_found(format!("group {id} not found")));
    }
    if let Some(name) = body.name.as_deref() {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::bad_request("group name cannot be empty"));
        }
        sqlx::query("UPDATE model_groups SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(description) = body.description.as_deref() {
        let description = description.trim();
        let value = (!description.is_empty()).then_some(description);
        sqlx::query("UPDATE model_groups SET description = ? WHERE id = ?")
            .bind(value)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(model_ids) = body.model_ids.as_deref() {
        if model_ids.len() < 2 {
            return Err(ApiError::bad_request("a debate group needs at least 2 models"));
        }
        validate_models(&state.db, model_ids).await?;
        replace_items(&state.db, &id, model_ids).await?;
    }
    let group: GroupRow = sqlx::query_as("SELECT * FROM model_groups WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(load_detail(&state.db, group).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    let result = sqlx::query("DELETE FROM model_groups WHERE id = ?").bind(&id).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("group {id} not found")));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/* ------------------------------------------------------------------ debates --- */

#[derive(Deserialize, Default)]
pub struct DebateQuery {
    pub message_id: Option<String>,
    pub conversation_id: Option<String>,
}

/// Replay data: debates (with turns) filtered by message or conversation.
pub async fn list_debates(
    State(state): State<AppState>,
    Query(query): Query<DebateQuery>,
) -> Result<Json<Vec<DebateDetail>>, ApiError> {
    let debates: Vec<DebateRow> = if let Some(message_id) = &query.message_id {
        sqlx::query_as("SELECT * FROM debates WHERE message_id = ? ORDER BY started_at ASC")
            .bind(message_id)
            .fetch_all(&state.db)
            .await?
    } else if let Some(conversation_id) = &query.conversation_id {
        sqlx::query_as("SELECT * FROM debates WHERE conversation_id = ? ORDER BY started_at ASC")
            .bind(conversation_id)
            .fetch_all(&state.db)
            .await?
    } else {
        return Err(ApiError::bad_request("message_id or conversation_id is required"));
    };

    let mut details = Vec::new();
    for debate in debates {
        let turns: Vec<DebateTurnRow> = sqlx::query_as(
            "SELECT * FROM debate_turns WHERE debate_id = ? ORDER BY round ASC, created_at ASC, rowid ASC",
        )
        .bind(&debate.id)
        .fetch_all(&state.db)
        .await?;
        details.push(DebateDetail { debate, turns });
    }
    Ok(Json(details))
}

/* ------------------------------------------------------------------ helpers --- */

async fn validate_models(db: &sqlx::SqlitePool, model_ids: &[String]) -> Result<(), ApiError> {
    for model_id in model_ids {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM models WHERE id = ?")
            .bind(model_id)
            .fetch_optional(db)
            .await?;
        if exists.is_none() {
            return Err(ApiError::not_found(format!("model {model_id} not found")));
        }
    }
    Ok(())
}

/// Replaces the group's items, keeping the given order as `position`.
async fn replace_items(db: &sqlx::SqlitePool, group_id: &str, model_ids: &[String]) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM model_group_items WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    for (position, model_id) in model_ids.iter().enumerate() {
        sqlx::query(
            "INSERT INTO model_group_items (group_id, model_id, position) VALUES (?, ?, ?)",
        )
        .bind(group_id)
        .bind(model_id)
        .bind(position as i64)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn load_detail(db: &sqlx::SqlitePool, group: GroupRow) -> Result<GroupDetail, ApiError> {
    let models: Vec<ModelRow> = sqlx::query_as(
        "SELECT m.* FROM model_group_items i
         JOIN models m ON m.id = i.model_id
         WHERE i.group_id = ? ORDER BY i.position ASC",
    )
    .bind(&group.id)
    .fetch_all(db)
    .await?;
    Ok(GroupDetail { group, models })
}
