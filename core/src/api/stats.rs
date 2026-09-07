//! Cost statistics: `GET /api/stats/cost` aggregates usage × per-model pricing
//! by month, by model and by conversation (USD per 1M tokens).

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use super::error::ApiError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct CostMonth {
    pub month: String,
    pub usd: f64,
    pub tokens_in: i64,
    pub tokens_out: i64,
}

#[derive(Serialize)]
pub struct CostByModel {
    pub model_id: String,
    pub display_name: String,
    pub provider_name: String,
    pub usd: f64,
    pub replies: i64,
}

#[derive(Serialize)]
pub struct CostByConversation {
    pub conversation_id: String,
    pub title: Option<String>,
    pub usd: f64,
}

#[derive(Serialize)]
pub struct CostStats {
    pub total_usd: f64,
    pub months: Vec<CostMonth>,
    pub by_model: Vec<CostByModel>,
    pub by_conversation: Vec<CostByConversation>,
}

/// USD for a message row under the model's configured per-1M prices.
const COST_EXPR: &str = "(COALESCE(m.tokens_in, 0) * COALESCE(mo.price_input, 0)
        + COALESCE(m.tokens_out, 0) * COALESCE(mo.price_output, 0)) / 1000000.0";

/// `GET /api/stats/cost`
pub async fn cost(State(state): State<AppState>) -> Result<Json<CostStats>, ApiError> {
    let months: Vec<(String, f64, i64, i64)> = sqlx::query_as(&format!(
        "SELECT substr(m.created_at, 1, 7) AS month,
                COALESCE(SUM({COST_EXPR}), 0) AS usd,
                COALESCE(SUM(m.tokens_in), 0) AS tokens_in,
                COALESCE(SUM(m.tokens_out), 0) AS tokens_out
         FROM messages m
         LEFT JOIN models mo ON mo.id = m.model_id
         WHERE m.role = 'assistant'
         GROUP BY month
         ORDER BY month DESC
         LIMIT 12"
    ))
    .fetch_all(&state.db)
    .await?;

    let by_model: Vec<(String, String, String, f64, i64)> = sqlx::query_as(&format!(
        "SELECT mo.id, mo.display_name, p.name, COALESCE(SUM({COST_EXPR}), 0) AS usd, COUNT(*) AS replies
         FROM messages m
         JOIN models mo ON mo.id = m.model_id
         JOIN providers p ON p.id = mo.provider_id
         WHERE m.role = 'assistant'
         GROUP BY mo.id
         ORDER BY usd DESC
         LIMIT 50"
    ))
    .fetch_all(&state.db)
    .await?;

    let by_conversation: Vec<(String, Option<String>, f64)> = sqlx::query_as(&format!(
        "SELECT c.id, c.title, COALESCE(SUM({COST_EXPR}), 0) AS usd
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN models mo ON mo.id = m.model_id
         WHERE m.role = 'assistant'
         GROUP BY c.id
         ORDER BY usd DESC
         LIMIT 100"
    ))
    .fetch_all(&state.db)
    .await?;

    let total_usd = months.iter().map(|(_, usd, _, _)| *usd).sum();
    Ok(Json(CostStats {
        total_usd,
        months: months
            .into_iter()
            .map(|(month, usd, tokens_in, tokens_out)| CostMonth {
                month,
                usd,
                tokens_in,
                tokens_out,
            })
            .collect(),
        by_model: by_model
            .into_iter()
            .map(|(model_id, display_name, provider_name, usd, replies)| CostByModel {
                model_id,
                display_name,
                provider_name,
                usd,
                replies,
            })
            .collect(),
        by_conversation: by_conversation
            .into_iter()
            .map(|(conversation_id, title, usd)| CostByConversation {
                conversation_id,
                title,
                usd,
            })
            .collect(),
    }))
}
