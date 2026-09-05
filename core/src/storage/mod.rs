//! SQLite storage via sqlx. Runtime queries (no macros) and a tiny hand-rolled
//! migrator (no `migrate` feature) keep the dependency graph lean — sqlx's macro and
//! migrate features pull in every backend driver.

mod types;

pub use types::{
    Conversation, DebateDetail, DebateRow, DebateTurnRow, GroupDetail, GroupRow, Message, ModelRow,
    ProviderKind, ProviderRow,
};

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::str::FromStr;

/// (version, sql) — applied in order, each inside a transaction.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("migrations/0001_phase1_init.sql")),
    (2, include_str!("migrations/0002_phase2_debates.sql")),
    (3, include_str!("migrations/0003_model_think_toggle.sql")),
    (4, include_str!("migrations/0004_agent_steps.sql")),
];

/// Opens the pool at `<data_dir>/polylab.db`, creates the schema, returns the pool.
pub async fn open(data_dir: &std::path::Path) -> anyhow::Result<SqlitePool> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating data directory {}", data_dir.display()))?;

    let db_path = data_dir.join("polylab.db");
    let options = SqliteConnectOptions::from_str(&format!(
        "sqlite://{}",
        db_path.display()
    ))?
    .create_if_missing(true)
    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
    .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .with_context(|| format!("opening database at {}", db_path.display()))?;

    migrate(&pool).await?;
    Ok(pool)
}

pub async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         )",
    )
    .execute(pool)
    .await
    .context("creating _migrations table")?;

    let applied: HashSet<i64> = sqlx::query_scalar("SELECT version FROM _migrations")
        .fetch_all(pool)
        .await
        .context("reading applied migrations")?
        .into_iter()
        .collect();

    for (version, sql) in MIGRATIONS {
        if applied.contains(version) {
            continue;
        }
        let mut tx = pool.begin().await?;
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
            .bind(version)
            .bind(now_rfc3339())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::info!(version, "applied migration");
    }
    Ok(())
}

/// All timestamps in the DB are RFC3339 UTC strings.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_create_the_phase1_tables() {
        let dir = std::env::temp_dir().join(format!("polylab-test-{}", uuid::Uuid::new_v4()));
        let pool = open(&dir).await.expect("open");
        for table in [
            "providers",
            "models",
            "conversations",
            "messages",
            "settings",
            "folders",
            "model_groups",
            "model_group_items",
            "debates",
            "debate_turns",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("table {table} missing: {e}"));
            assert_eq!(count, 0);
        }
        // Re-open is idempotent.
        drop(pool);
        let pool = open(&dir).await.expect("re-open");
        let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM _migrations")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(versions, vec![1, 2, 3, 4]);
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
