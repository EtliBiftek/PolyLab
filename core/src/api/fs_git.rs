//! Workspace REST endpoints (Phase 4/5): file browsing + git summary for the
//! renderer's right panel. Paths are always resolved against the conversation's
//! workspace root (project_path or the shared default).

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::error::ApiError;
use crate::state::AppState;
use crate::storage::Conversation;

#[derive(Deserialize)]
pub struct FsQuery {
    conversation_id: String,
    op: Option<String>,
    path: Option<String>,
}

#[derive(Serialize)]
pub struct FsResponse {
    pub root: String,
    pub path: String,
    pub content: String,
}

async fn workspace_conversation(
    state: &AppState,
    conversation_id: &str,
) -> Result<Conversation, ApiError> {
    let conversation: Conversation = sqlx::query_as("SELECT * FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("conversation {conversation_id} not found")))?;
    Ok(conversation)
}

/// `GET /api/fs?conversation_id=…&op=list|read&path=…`
pub async fn fs_op(
    State(state): State<AppState>,
    Query(query): Query<FsQuery>,
) -> Result<Json<FsResponse>, ApiError> {
    let conversation = workspace_conversation(&state, &query.conversation_id).await?;
    let root = crate::terminal::workspace_root(&conversation);
    std::fs::create_dir_all(&root).map_err(anyhow::Error::from)?;
    let path = query.path.as_deref().unwrap_or("");
    let content = match query.op.as_deref().unwrap_or("list") {
        "read" => crate::fs::read(&root, path)?,
        _ => crate::fs::list(&root, path)?,
    };
    Ok(Json(FsResponse {
        root: root.display().to_string(),
        path: path.to_string(),
        content,
    }))
}

#[derive(Deserialize)]
pub struct GitQuery {
    conversation_id: String,
    op: Option<String>,
}

/// `GET /api/git?conversation_id=…&op=status|diff|log`
pub async fn git_op(
    State(state): State<AppState>,
    Query(query): Query<GitQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let conversation = workspace_conversation(&state, &query.conversation_id).await?;
    let root = crate::terminal::workspace_root(&conversation);
    if !crate::git::is_repo(&root) {
        return Ok(Json(json!({ "repo": false, "output": "" })));
    }
    let output = match query.op.as_deref().unwrap_or("status") {
        "diff" => crate::git::diff(&root).await,
        "log" => crate::git::log(&root, 20).await,
        _ => crate::git::status(&root).await,
    }
    ?;
    Ok(Json(json!({ "repo": true, "output": output })))
}

#[derive(Deserialize)]
pub struct AgentStepsQuery {
    message_id: String,
}

#[derive(Serialize)]
pub struct AgentStepRow {
    pub id: String,
    pub message_id: String,
    pub seq: i64,
    pub tool: String,
    pub args_json: String,
    pub result: Option<String>,
    pub ok: bool,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for AgentStepRow {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row as _;
        Ok(AgentStepRow {
            id: row.try_get("id")?,
            message_id: row.try_get("message_id")?,
            seq: row.try_get("seq")?,
            tool: row.try_get("tool")?,
            args_json: row.try_get("args_json")?,
            result: row.try_get("result")?,
            ok: row.try_get::<i64, _>("ok")? != 0,
        })
    }
}

/// `GET /api/agent-steps?message_id=…` — persisted agent tool log (Phase 4).
pub async fn agent_steps(
    State(state): State<AppState>,
    Query(query): Query<AgentStepsQuery>,
) -> Result<Json<Vec<AgentStepRow>>, ApiError> {
    let rows: Vec<AgentStepRow> = sqlx::query_as(
        "SELECT id, message_id, seq, tool, args_json, result, ok FROM agent_steps
         WHERE message_id = ? ORDER BY seq ASC",
    )
    .bind(&query.message_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}
