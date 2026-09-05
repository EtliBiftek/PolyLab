//! Shared application state.

use std::sync::Arc;
use std::time::Instant;

use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::auth;
use crate::engine::ChatEngine;
use crate::prompts::PromptLibrary;
use crate::secrets::SecretStore;

#[derive(Clone)]
pub struct AppState {
    token: Arc<str>,
    pub name: Arc<str>,
    pub version: Arc<str>,
    started_at: Instant,
    pub db: SqlitePool,
    pub secrets: Arc<dyn SecretStore>,
    pub prompts: Arc<PromptLibrary>,
    pub engine: Arc<ChatEngine>,
    /// Serialized `ServerEvent` JSON broadcast to every connected renderer.
    pub hub: broadcast::Sender<String>,
}

impl AppState {
    pub fn new(
        token: String,
        db: SqlitePool,
        secrets: Arc<dyn SecretStore>,
        prompts: Arc<PromptLibrary>,
        hub: broadcast::Sender<String>,
    ) -> Self {
        let engine = Arc::new(ChatEngine::new(
            db.clone(),
            hub.clone(),
            Arc::clone(&prompts),
            Arc::clone(&secrets),
        ));
        Self {
            token: Arc::from(token.as_str()),
            name: Arc::from(crate::NAME),
            version: Arc::from(crate::VERSION),
            started_at: Instant::now(),
            db,
            secrets,
            prompts,
            engine,
            hub,
        }
    }

    pub fn token_matches(&self, presented: &str) -> bool {
        auth::constant_time_eq(self.token.as_bytes(), presented.as_bytes())
    }

    pub fn uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }
}
