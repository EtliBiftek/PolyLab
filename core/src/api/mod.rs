//! REST API under `/api` (contract: docs/EVENTS.md §6).

pub mod conversations;
pub mod error;
pub mod groups;
pub mod models;
pub mod providers;
pub mod settings;

use axum::routing::{get, put};
use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/providers", get(providers::list).post(providers::create))
        .route(
            "/providers/{id}",
            get(providers::get_one).patch(providers::update).delete(providers::delete),
        )
        .route("/providers/{id}/test", get(providers::test))
        .route("/providers/{id}/remote-models", get(providers::remote_models))
        .route("/models", get(models::list).post(models::upsert))
        .route(
            "/models/{id}",
            get(models::get_one).patch(models::update).delete(models::delete),
        )
        .route(
            "/conversations",
            get(conversations::list).post(conversations::create),
        )
        .route(
            "/conversations/{id}",
            get(conversations::get_one)
                .patch(conversations::update)
                .delete(conversations::delete),
        )
        .route(
            "/conversations/{id}/messages",
            get(conversations::messages),
        )
        .route("/groups", get(groups::list).post(groups::create))
        .route(
            "/groups/{id}",
            get(groups::get_one).patch(groups::update).delete(groups::delete),
        )
        .route("/debates", get(groups::list_debates))
        .route("/settings", get(settings::list).put(settings::put))
}

// re-export for handlers
pub use error::ApiError;

#[allow(unused_imports)]
use put as _put_route_alias;
