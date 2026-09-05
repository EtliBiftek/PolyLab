//! Uniform REST error envelope: `{"error":{"code","detail"}}` with a proper status.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub detail: String,
}

impl ApiError {
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, code: "bad_request", detail: detail.into() }
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, code: "not_found", detail: detail.into() }
    }

    pub fn internal(error: anyhow::Error) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, code: "internal", detail: error.to_string() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": { "code": self.code, "detail": self.detail } })))
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, code: "database", detail: error.to_string() }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        ApiError::internal(error)
    }
}
