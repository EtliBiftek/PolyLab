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
    pub api_key_count: usize,
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
    /// Some("") clears all keys; Some(key) replaces the primary key.
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
pub struct ApiKeyBody {
    pub api_key: String,
}

#[derive(Serialize)]
pub struct ApiKeySummary {
    pub index: usize,
    pub prefix: String,
    pub primary: bool,
}

fn decode_stored_keys(raw: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct KeyBundle {
        __polylab_keys: bool,
        keys: Vec<String>,
    }
    serde_json::from_str::<KeyBundle>(raw)
        .ok()
        .filter(|bundle| bundle.__polylab_keys)
        .map(|bundle| {
            bundle
                .keys
                .into_iter()
                .filter(|key| !key.trim().is_empty())
                .collect()
        })
        .unwrap_or_else(|| vec![raw.to_string()])
}

fn load_keys(state: &AppState, provider_id: &str) -> Result<Vec<String>, ApiError> {
    Ok(state
        .secrets
        .get(&provider_key(provider_id))
        .map_err(ApiError::internal)?
        .map(|raw| decode_stored_keys(&raw))
        .unwrap_or_default())
}

fn save_keys(state: &AppState, provider_id: &str, keys: &[String]) -> Result<(), ApiError> {
    let keys: Vec<String> = keys
        .iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect();
    if keys.is_empty() {
        state
            .secrets
            .delete(&provider_key(provider_id))
            .map_err(ApiError::internal)?;
        return Ok(());
    }
    let encoded = crate::providers::encode_key_bundle(&keys).map_err(ApiError::internal)?;
    state
        .secrets
        .set(&provider_key(provider_id), &encoded)
        .map_err(ApiError::internal)
}

fn mask_key(key: &str) -> String {
    let prefix: String = key.chars().take(5).collect();
    if prefix.is_empty() {
        "••••".into()
    } else {
        format!("{prefix}••••")
    }
}

fn key_summaries(keys: &[String]) -> Vec<ApiKeySummary> {
    keys.iter()
        .enumerate()
        .map(|(index, key)| ApiKeySummary {
            index,
            prefix: mask_key(key),
            primary: index == 0,
        })
        .collect()
}

fn dto_for(state: &AppState, row: ProviderRow) -> ProviderDto {
    let keys = load_keys(state, &row.id).unwrap_or_default();
    ProviderDto {
        row,
        has_api_key: !keys.is_empty(),
        api_key_count: keys.len(),
    }
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
        save_keys(&state, &id, &[key.to_string()])?;
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

    if let Some(key) = body.api_key {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            save_keys(&state, &id, &[])?;
        } else {
            save_keys(&state, &id, &[trimmed.to_string()])?;
        }
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

pub async fn list_keys(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<ApiKeySummary>>, ApiError> {
    let _row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("provider {id} not found")))?;
    Ok(Json(key_summaries(&load_keys(&state, &id)?)))
}

pub async fn add_key(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ApiKeyBody>,
) -> Result<Json<Vec<ApiKeySummary>>, ApiError> {
    let _row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("provider {id} not found")))?;
    let key = body.api_key.trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("api_key cannot be empty"));
    }
    let mut keys = load_keys(&state, &id)?;
    keys.push(key.to_string());
    save_keys(&state, &id, &keys)?;
    Ok(Json(key_summaries(&keys)))
}

pub async fn update_key(
    State(state): State<AppState>,
    Path((id, index)): Path<(String, usize)>,
    Json(body): Json<ApiKeyBody>,
) -> Result<Json<Vec<ApiKeySummary>>, ApiError> {
    let mut keys = load_keys(&state, &id)?;
    let key = body.api_key.trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("api_key cannot be empty"));
    }
    let slot = keys
        .get_mut(index)
        .ok_or_else(|| ApiError::not_found("api key slot not found"))?;
    *slot = key.to_string();
    save_keys(&state, &id, &keys)?;
    Ok(Json(key_summaries(&keys)))
}

pub async fn delete_key(
    State(state): State<AppState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Json<Vec<ApiKeySummary>>, ApiError> {
    let mut keys = load_keys(&state, &id)?;
    if index >= keys.len() {
        return Err(ApiError::not_found("api key slot not found"));
    }
    keys.remove(index);
    save_keys(&state, &id, &keys)?;
    Ok(Json(key_summaries(&keys)))
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
    let keys = load_keys(&state, &id)?;
    if keys.is_empty() {
        let provider = crate::providers::build(kind, row.base_url.as_deref(), None).map_err(ApiError::internal)?;
        return match provider.list_models().await {
            Ok(models) => Ok(Json(TestResult { ok: true, model_count: Some(models.len()), detail: None })),
            Err(error) => Ok(Json(TestResult { ok: false, model_count: None, detail: Some(error.to_string()) })),
        };
    }
    let mut last_error = None;
    for key in &keys {
        let provider = crate::providers::build(kind, row.base_url.as_deref(), Some(key.as_str())).map_err(ApiError::internal)?;
        match provider.list_models().await {
            Ok(models) => return Ok(Json(TestResult { ok: true, model_count: Some(models.len()), detail: None })),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Ok(Json(TestResult { ok: false, model_count: None, detail: last_error }))
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
    let keys = load_keys(&state, &id)?;
    let mut last_error = None;
    for key in keys.iter().map(Some).chain(std::iter::once(None)) {
        let api_key = key.map(String::as_str);
        let provider = crate::providers::build(kind, row.base_url.as_deref(), api_key)
            .map_err(ApiError::internal)?;
        match provider.list_models().await {
            Ok(models) => {
                let existing: Vec<String> = sqlx::query_scalar("SELECT model_id FROM models WHERE provider_id = ?")
                    .bind(&id)
                    .fetch_all(&state.db)
                    .await?;
                return Ok(Json(models.into_iter().map(|model| RemoteModelDto {
                    added: existing.contains(&model.id),
                    id: model.id,
                    display_name: model.display_name,
                    supports_tools: model.supports_tools,
                    context_window: model.context_window,
                }).collect()));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(ApiError { status: axum::http::StatusCode::BAD_GATEWAY, code: "provider_error", detail: last_error.unwrap_or_else(|| "provider returned no models".into()) })
}
