//! Provider CRUD + connection test + remote model listing.

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::error::ApiError;
use crate::secrets::provider_key;
use crate::state::AppState;
use crate::storage::{now_rfc3339, ProviderKind, ProviderRow};

#[derive(Serialize)]
pub struct ProviderDto {
    #[serde(flatten)]
    pub row: ProviderRow,
    pub has_api_key: bool,
}

#[derive(Deserialize)]
pub struct CreateProvider {
    pub kind: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateProvider {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub enabled: Option<bool>,
    /// Some("") deletes the stored key; Some(key) overwrites it.
    pub api_key: Option<String>,
}

fn dto_for(state: &AppState, row: ProviderRow) -> ProviderDto {
    let has_api_key = state
        .secrets
        .get(&provider_key(&row.id))
        .map(|key| key.as_deref().map(str::trim).filter(|k| !k.is_empty()).is_some())
        .unwrap_or(false);
    ProviderDto { row, has_api_key }
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<ProviderDto>>, ApiError> {
    let rows: Vec<ProviderRow> = sqlx::query_as("SELECT * FROM providers ORDER BY created_at ASC")
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(|row| dto_for(&state, row)).collect()))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProviderDto>, ApiError> {
    let row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("provider {id} not found")))?;
    Ok(Json(dto_for(&state, row)))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateProvider>,
) -> Result<Json<ProviderDto>, ApiError> {
    let kind = ProviderKind::from_str_loose(&body.kind)
        .ok_or_else(|| ApiError::bad_request(format!("unknown provider kind {}", body.kind)))?;
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| kind.as_str().to_string());
    let base_url = body
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string);

    if kind == ProviderKind::Custom && base_url.is_none() {
        return Err(ApiError::bad_request("custom providers require a base URL"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO providers (id, kind, name, base_url, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)")
        .bind(&id)
        .bind(kind.as_str())
        .bind(&name)
        .bind(&base_url)
        .bind(now_rfc3339())
        .execute(&state.db)
        .await?;

    if let Some(key) = body.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        state.secrets.set(&provider_key(&id), key).map_err(ApiError::internal)?;
    }

    let row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(dto_for(&state, row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProvider>,
) -> Result<Json<ProviderDto>, ApiError> {
    let row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("provider {id} not found")))?;

    let name = body.name.unwrap_or(row.name);
    let base_url = body.base_url.or(row.base_url);
    let enabled = body.enabled.unwrap_or(row.enabled);

    if ProviderKind::from_str_loose(&row.kind) == Some(ProviderKind::Custom)
        && base_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .is_none()
    {
        return Err(ApiError::bad_request("custom providers require a base URL"));
    }

    sqlx::query("UPDATE providers SET name = ?, base_url = ?, enabled = ? WHERE id = ?")
        .bind(&name)
        .bind(&base_url)
        .bind(enabled)
        .bind(&id)
        .execute(&state.db)
        .await?;

    match body.api_key.as_deref().map(str::trim) {
        Some("") | None => {}
        Some(key) => state.secrets.set(&provider_key(&id), key).map_err(ApiError::internal)?,
    }

    let row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(dto_for(&state, row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let result = sqlx::query("DELETE FROM providers WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("provider {id} not found")));
    }
    let _ = state.secrets.delete(&provider_key(&id));
    Ok(Json(json!({ "deleted": true })))
}

#[derive(Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub model_count: Option<usize>,
    pub detail: Option<String>,
}

pub async fn test(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TestResult>, ApiError> {
    let row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("provider {id} not found")))?;

    let kind = ProviderKind::from_str_loose(&row.kind)
        .ok_or_else(|| ApiError::bad_request(format!("unknown provider kind {}", row.kind)))?;
    let api_key = state
        .secrets
        .get(&provider_key(&id))
        .map_err(ApiError::internal)?
        .unwrap_or_default();

    let api_key = api_key.trim().to_string();
    let provider = crate::providers::build(
        kind,
        row.base_url.as_deref(),
        (!api_key.is_empty()).then_some(api_key.as_str()),
    )
    .map_err(ApiError::internal)?;
    match provider.list_models().await {
        Ok(models) => Ok(Json(TestResult { ok: true, model_count: Some(models.len()), detail: None })),
        Err(error) => Ok(Json(TestResult { ok: false, model_count: None, detail: Some(error.to_string()) })),
    }
}

#[derive(Serialize)]
pub struct RemoteModelDto {
    pub id: String,
    pub display_name: String,
    pub supports_tools: Option<bool>,
    pub context_window: Option<u64>,
    pub added: bool,
}

pub async fn remote_models(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<RemoteModelDto>>, ApiError> {
    let row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("provider {id} not found")))?;

    let kind = ProviderKind::from_str_loose(&row.kind)
        .ok_or_else(|| ApiError::bad_request(format!("unknown provider kind {}", row.kind)))?;
    let api_key = state
        .secrets
        .get(&provider_key(&id))
        .map_err(ApiError::internal)?
        .unwrap_or_default();

    let api_key = api_key.trim().to_string();
    let provider = crate::providers::build(
        kind,
        row.base_url.as_deref(),
        (!api_key.is_empty()).then_some(api_key.as_str()),
    )
    .map_err(ApiError::internal)?;
    let models = provider
        .list_models()
        .await
        .map_err(|error| ApiError { status: axum::http::StatusCode::BAD_GATEWAY, code: "provider_error", detail: error.to_string() })?;

    let existing: Vec<String> = sqlx::query_scalar("SELECT model_id FROM models WHERE provider_id = ?")
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(
        models
            .into_iter()
            .map(|model| RemoteModelDto {
                added: existing.contains(&model.id),
                id: model.id,
                display_name: model.display_name,
                supports_tools: model.supports_tools,
                context_window: model.context_window,
            })
            .collect(),
    ))
}
