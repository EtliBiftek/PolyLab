//! Conversation CRUD + message history.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::error::ApiError;
use crate::state::AppState;
use crate::storage::{now_rfc3339, Conversation, Message};

#[derive(Deserialize, Default)]
pub struct ListQuery {
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct CreateConversation {
    pub mode: Option<String>,
    pub model_id: Option<String>,
    pub selection_type: Option<String>,
    pub group_id: Option<String>,
    pub debate_settings: Option<serde_json::Value>,
    pub agent_auto_approve: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateConversation {
    pub title: Option<String>,
    pub model_id: Option<String>,
    pub mode: Option<String>,
    pub pinned: Option<bool>,
    pub folder_id: Option<String>,
    pub selection_type: Option<String>,
    pub group_id: Option<String>,
    pub debate_settings: Option<serde_json::Value>,
    pub agent_auto_approve: Option<bool>,
    pub project_path: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Conversation>>, ApiError> {
    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let rows: Vec<Conversation> = sqlx::query_as(
        "SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateConversation>,
) -> Result<Json<Conversation>, ApiError> {
    let mode = match body.mode.as_deref() {
        None | Some("chat") => "chat",
        Some("coding") => "coding",
        Some(other) => return Err(ApiError::bad_request(format!("unknown mode {other}"))),
    };
    let selection_type = match body.selection_type.as_deref() {
        None | Some("single") => "single",
        Some("group") => "group",
        Some(other) => return Err(ApiError::bad_request(format!("unknown selection_type {other}"))),
    };
    if let Some(model_id) = body.model_id.as_deref() {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM models WHERE id = ?")
            .bind(model_id)
            .fetch_optional(&state.db)
            .await?;
        if exists.is_none() {
            return Err(ApiError::not_found(format!("model {model_id} not found")));
        }
    }
    let debate_settings_json = store_debate_settings(&body.debate_settings)?;
    if selection_type == "group" {
        let group_id = body.group_id.as_deref().ok_or_else(|| {
            ApiError::bad_request("group conversations require group_id")
        })?;
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM model_groups WHERE id = ?")
            .bind(group_id)
            .fetch_optional(&state.db)
            .await?;
        if exists.is_none() {
            return Err(ApiError::not_found(format!("group {group_id} not found")));
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let project_path = if mode == "coding" {
        let path = state.data_dir.join("workspace").join(&id);
        std::fs::create_dir_all(&path).ok();
        Some(path.display().to_string())
    } else {
        None
    };
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO conversations (id, mode, selection_type, model_id, group_id,
                                    debate_settings_json, project_path,
                                    agent_auto_approve, auto_title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(mode)
    .bind(selection_type)
    .bind(if selection_type == "group" { None } else { body.model_id })
    .bind(if selection_type == "group" { body.group_id } else { None })
    .bind(&debate_settings_json)
    .bind(&project_path)
    .bind(body.agent_auto_approve.unwrap_or(false))
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let row: Conversation = sqlx::query_as("SELECT * FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(row))
}

#[derive(Serialize)]
pub struct ConversationDetail {
    #[serde(flatten)]
    pub conversation: Conversation,
    pub messages: Vec<Message>,
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ConversationDetail>, ApiError> {
    let conversation: Conversation = sqlx::query_as("SELECT * FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("conversation {id} not found")))?;
    let messages: Vec<Message> = sqlx::query_as(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(ConversationDetail { conversation, messages }))
}

pub async fn messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found(format!("conversation {id} not found")));
    }
    let rows: Vec<Message> = sqlx::query_as(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateConversation>,
) -> Result<Json<Conversation>, ApiError> {
    let row: Conversation = sqlx::query_as("SELECT * FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("conversation {id} not found")))?;

    let selection_type = match body.selection_type.as_deref() {
        None => row.selection_type.clone(),
        Some("single") => "single".to_string(),
        Some("group") => "group".to_string(),
        Some(other) => {
            return Err(ApiError::bad_request(format!("unknown selection_type {other}")))
        }
    };
    let title_was_user_set = body.title.is_some();
    let title = body.title.or(row.title);
    let mode = body.mode.unwrap_or(row.mode);
    let pinned = body.pinned.unwrap_or(row.pinned);
    let folder_id = body.folder_id.or(row.folder_id);

    // Selection target: model XOR group depending on the final selection_type.
    let (model_id, group_id) = if selection_type == "group" {
        let group_id = body.group_id.or(row.group_id).ok_or_else(|| {
            ApiError::bad_request("group conversations require group_id")
        })?;
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM model_groups WHERE id = ?")
                .bind(&group_id)
                .fetch_optional(&state.db)
                .await?;
        if exists.is_none() {
            return Err(ApiError::not_found(format!("group {group_id} not found")));
        }
        (None, Some(group_id))
    } else {
        let model_id = body.model_id.or(row.model_id);
        if let Some(model_id) = model_id.as_deref() {
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM models WHERE id = ?")
                .bind(model_id)
                .fetch_optional(&state.db)
                .await?;
            if exists.is_none() {
                return Err(ApiError::not_found(format!("model {model_id} not found")));
            }
        }
        (model_id, None)
    };
    let debate_settings_json = match (&body.debate_settings, row.debate_settings_json) {
        (Some(value), _) => store_debate_settings(&Some(value.clone()))?,
        (None, existing) => existing,
    };
    let agent_auto_approve = body.agent_auto_approve.unwrap_or(row.agent_auto_approve);
    let project_path = body.project_path.clone().or(row.project_path.clone());
    // A user-supplied title is final — model title generation must not touch it.
    let auto_title = !title_was_user_set && row.auto_title;

    sqlx::query(
        "UPDATE conversations SET title = ?, model_id = ?, mode = ?, pinned = ?, folder_id = ?,
                selection_type = ?, group_id = ?, debate_settings_json = ?,
                agent_auto_approve = ?, project_path = ?, auto_title = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&title)
    .bind(&model_id)
    .bind(&mode)
    .bind(pinned)
    .bind(&folder_id)
    .bind(&selection_type)
    .bind(&group_id)
    .bind(&debate_settings_json)
    .bind(agent_auto_approve)
    .bind(&project_path)
    .bind(auto_title)
    .bind(now_rfc3339())
    .bind(&id)
    .execute(&state.db)
    .await?;

    let row: Conversation = sqlx::query_as("SELECT * FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(row))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let result = sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("conversation {id} not found")));
    }
    Ok(Json(serde_json::json!({ "deleted": true })))
}

/// Validates a debate settings object (when present) and serializes it for storage.
fn store_debate_settings(
    value: &Option<serde_json::Value>,
) -> Result<Option<String>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    let settings = crate::debate::DebateSettings::parse(Some(&value.to_string()));
    Ok(Some(serde_json::to_string(&settings).map_err(anyhow::Error::from)?))
}
