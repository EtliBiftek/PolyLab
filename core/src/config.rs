//! Sidecar configuration, entirely environment-driven (values are passed by the
//! Electron main process when it spawns the sidecar).

use tracing::level_filters::LevelFilter;

pub const DEFAULT_PORT: u16 = 43110;

#[derive(Debug, Clone)]
pub struct Config {
    /// TCP port to bind on 127.0.0.1. `0` asks the OS for a free port.
    pub port: u16,
    /// Session token required on every request.
    pub token: String,
    /// True when no token was provided and one was generated for a standalone run.
    pub token_was_generated: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("POLYLAB_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        let provided = std::env::var("POLYLAB_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let token_was_generated = provided.is_none();
        let token = provided.unwrap_or_else(new_session_token);
        Config {
            port,
            token,
            token_was_generated,
        }
    }
}

/// 64 hex chars of entropy — printed only for standalone runs (see `main.rs`).
pub fn new_session_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub fn log_level() -> LevelFilter {
    match std::env::var("POLYLAB_LOG").ok().as_deref().map(str::trim) {
        Some("trace") => LevelFilter::TRACE,
        Some("debug") => LevelFilter::DEBUG,
        Some("warn" | "warning") => LevelFilter::WARN,
        Some("error") => LevelFilter::ERROR,
        _ => LevelFilter::INFO,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Env mutation is global; keep all env assertions in one sequential test.
    #[test]
    fn config_from_env_parses_port_and_token() {
        // Defaults.
        std::env::remove_var("POLYLAB_PORT");
        std::env::remove_var("POLYLAB_TOKEN");
        let cfg = Config::from_env();
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert!(cfg.token_was_generated);
        assert_eq!(cfg.token.len(), 64);

        // Explicit values.
        std::env::set_var("POLYLAB_PORT", "43210");
        std::env::set_var("POLYLAB_TOKEN", "abcdef");
        let cfg = Config::from_env();
        assert_eq!(cfg.port, 43210);
        assert_eq!(cfg.token, "abcdef");
        assert!(!cfg.token_was_generated);

        // Whitespace tolerated, invalid port falls back.
        std::env::set_var("POLYLAB_PORT", " 43211 ");
        std::env::set_var("POLYLAB_TOKEN", "  xyz  ");
        let cfg = Config::from_env();
        assert_eq!(cfg.port, 43211);
        assert_eq!(cfg.token, "xyz");

        std::env::set_var("POLYLAB_PORT", "not-a-port");
        let cfg = Config::from_env();
        assert_eq!(cfg.port, DEFAULT_PORT);

        std::env::set_var("POLYLAB_TOKEN", "");
        let cfg = Config::from_env();
        assert!(cfg.token_was_generated);

        std::env::remove_var("POLYLAB_PORT");
        std::env::remove_var("POLYLAB_TOKEN");
    }

    #[test]
    fn session_tokens_are_unique() {
        assert_ne!(new_session_token(), new_session_token());
    }
}
