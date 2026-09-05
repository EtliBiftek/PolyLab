use polylab_core::{config, serve};

fn main() -> anyhow::Result<()> {
    // Plain fmt subscriber; level comes from POLYLAB_LOG (default info).
    let level = config::log_level();
    tracing_subscriber::fmt()
        .with_max_level(level)
        .with_target(false)
        .init();

    let cfg = config::Config::from_env();
    if cfg.token_was_generated {
        // Standalone run (no Electron): make the token discoverable for local testing.
        // In the Electron flow the token arrives via POLYLAB_TOKEN and is never logged.
        tracing::warn!(
            token = %cfg.token,
            "no POLYLAB_TOKEN given; generated a session token for this run"
        );
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(serve(cfg))?;
    Ok(())
}
