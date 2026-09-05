//! polylab-core — the PolyLab sidecar.
//!
//! Binds to 127.0.0.1 only; every request must present the session token created by the
//! Electron main process (bearer header for REST, `?token=` for the WebSocket upgrade).
//! The wire contract lives in `docs/EVENTS.md`.

pub mod api;
pub mod auth;
pub mod config;
pub mod debate;
pub mod engine;
pub mod events;
pub mod prompts;
pub mod providers;
pub mod secrets;
pub mod state;
pub mod storage;
pub mod tokens;
pub mod ws;

use std::sync::Arc;

use axum::{middleware, routing::get, Router};
use tracing::info;

use crate::state::AppState;

pub const NAME: &str = env!("CARGO_PKG_NAME");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// All routes, with the auth middleware applied. Split from `serve` so tests can drive
/// the router with `tower::ServiceExt::oneshot` or a real socket.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::ws_handler))
        .nest("/api", api::router())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state)
}

async fn health(axum::extract::State(state): axum::extract::State<AppState>) -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "status": "ok",
        "name": state.name.as_ref(),
        "version": state.version.as_ref(),
        "uptime_secs": state.uptime_secs(),
    }))
}

/// Where the SQLite database and (sandbox-only) secret fallback live. The Electron
/// main process passes the OS user-data directory; standalone runs get `./polylab-data`.
pub fn data_dir() -> std::path::PathBuf {
    if let Some(dir) = std::env::var("POLYLAB_DATA_DIR")
        .ok()
        .map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty())
    {
        return std::path::PathBuf::from(dir);
    }
    std::path::PathBuf::from("./polylab-data")
}

/// Assemble state (db, secrets, prompts, hub, engine). Exposed for tests.
pub async fn build_state(token: String, data_dir: &std::path::Path) -> anyhow::Result<AppState> {
    let db = storage::open(data_dir).await?;
    let secrets: Arc<dyn secrets::SecretStore> = Arc::from(secrets::new_store(data_dir)?);
    let prompts = Arc::new(prompts::PromptLibrary::load());
    let (hub, _rx) = tokio::sync::broadcast::channel(4096);
    Ok(AppState::new(token, db, secrets, prompts, hub))
}

/// Bind and serve until interrupted. Returns the address actually bound (useful when
/// `POLYLAB_PORT=0` picks a random port).
pub async fn serve(cfg: config::Config) -> anyhow::Result<std::net::SocketAddr> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, cfg.port)).await?;
    let bound = listener.local_addr()?;
    let dir = data_dir();
    let state = build_state(cfg.token.clone(), &dir).await?;
    let app = build_router(state);

    info!(addr = %bound, name = NAME, version = VERSION, data_dir = %dir.display(), "polylab-core listening");
    // Machine-readable readiness line; Electron tails stdout only for diagnostics —
    // it relies on GET /health for readiness, not on this line.
    println!("POLYLAB_READY addr={bound}");
    use std::io::Write as _;
    let _ = std::io::stdout().flush();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    info!("polylab-core stopped");
    Ok(bound)
}

pub async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
