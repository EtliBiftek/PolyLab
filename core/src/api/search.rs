//! Message-content search: `GET /api/search?q=…` returns messages whose
//! content matches, with a snippet around the first hit. Backed by the
//! `messages_fts` FTS5 trigram index (migration 0011), ranked by bm25. Used
//! by the sidebar global search and by the command palette.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<i64>,
}

/// Raw `messages_fts` join row (keeps the multi-column query readable for clippy).
type SearchRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    String,
    f64,
);

#[derive(Serialize)]
pub struct SearchHit {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: Option<String>,
    pub role: String,
    pub snippet: String,
    pub model_id: Option<String>,
    pub created_at: String,
}

/// Extracts a readable window around the first (case-insensitive) occurrence of
/// `needle` in `content`. Falls back to the content head when there is no match
/// (defensive; the SQL LIKE filter normally guarantees one).
pub fn snippet(content: &str, needle: &str, radius: usize) -> String {
    let lower = content.to_lowercase();
    let needle_lower = needle.to_lowercase();
    let match_at = lower.find(&needle_lower).unwrap_or(0);
    let start = match_at.saturating_sub(radius);
    let end = (match_at + needle_lower.len() + radius).min(content.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&content[start..end]);
    if end < content.len() {
        out.push('…');
    }
    if out.trim().is_empty() {
        out.push_str("(boş)");
    }
    out
}

/// `GET /api/search?q=…` — newest first, capped by `limit` (default 20).
/// SQLite FTS5 phrase literal: double quotes, embedded quotes doubled.
/// Trigram tokenizer means 2-char needles match nothing, so the min length
/// of 3 is enforced by the caller (and the renderer hint).
fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

pub async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SearchHit>>, ApiError> {
    let needle = query.q.trim();
    if needle.chars().count() < 3 {
        return Ok(Json(Vec::new()));
    }
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let rows: Vec<SearchRow> = sqlx::query_as(
            "SELECT m.id, m.conversation_id, c.title, m.role, m.content, m.model_id, m.created_at,
                    bm25(messages_fts) AS rank
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             JOIN conversations c ON c.id = m.conversation_id
             WHERE messages_fts MATCH ?
             ORDER BY rank, m.created_at DESC
             LIMIT ?",
        )
        .bind(fts_phrase(needle))
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    let hits = rows
        .into_iter()
        .map(
            |(
                message_id,
                conversation_id,
                conversation_title,
                role,
                content,
                model_id,
                created_at,
                _rank,
            )| {
                SearchHit {
                    message_id,
                    conversation_id,
                    conversation_title,
                    role,
                    snippet: snippet(&content, needle, 60),
                    model_id,
                    created_at,
                }
            },
        )
        .collect();
    Ok(Json(hits))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_wraps_the_match() {
        let text = "İlk cümle çok uzun ve kullanışsız. Cargo test çalıştırıldı ve geçti. Son cümle.";
        let out = snippet(text, "cargo test", 24);
        assert!(out.contains("Cargo test"), "{out}");
        assert!(out.starts_with('…') || out.contains("İlk"), "{out}");
        assert!(out.ends_with('…') || out.contains("Son"), "{out}");
        assert!(out.len() < text.len(), "{out}");
    }

    #[test]
    fn snippet_handles_missing_match_and_short_text() {
        assert_eq!(snippet("kısa", "yok", 10), "kısa");
        assert!(!snippet("", "yok", 10).is_empty());
    }

    #[test]
    fn fts_phrase_quotes_and_escapes() {
        assert_eq!(fts_phrase("cargo test"), "\"cargo test\"");
        assert_eq!(fts_phrase("say \"hi\""), "\"say \"\"hi\"\"\"");
    }
}
