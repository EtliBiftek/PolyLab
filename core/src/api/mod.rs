//! REST API under `/api` (contract: docs/EVENTS.md §6).

pub mod conversations;
pub mod error;
pub mod folders;
pub mod fs_git;
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
        .route("/providers/{id}/keys", get(providers::list_keys).post(providers::add_key))
        .route(
            "/providers/{id}/keys/{index}",
            put(providers::update_key).delete(providers::delete_key),
        )
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
        .route("/folders", get(folders::list).post(folders::create))
        .route(
            "/folders/{id}",
            axum::routing::patch(folders::update).delete(folders::delete),
        )
        .route("/fs", get(fs_git::fs_op))
        .route("/agent-steps", get(fs_git::agent_steps))
        .route("/git", get(fs_git::git_op).post(fs_git::git_commit))
        .route("/settings", get(settings::list).put(settings::put))
}

pub use error::ApiError;

#[allow(unused_imports)]
use put as _put_route_alias;
