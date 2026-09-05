//! Row structs shared between storage, the engine and the REST API.
//!
//! `FromRow` is implemented by hand — the derive lives behind sqlx's `macros`
//! feature, which would pull every backend driver into the dependency tree.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteRow;
use sqlx::Row;

/// Provider kinds the UI can offer; unknown strings are preserved for forward compat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openai,
    Anthropic,
    Gemini,
    Openrouter,
    Deepseek,
    Groq,
    Mistral,
    Xai,
    Lmstudio,
    Ollama,
    Custom,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Openai => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Gemini => "gemini",
            ProviderKind::Openrouter => "openrouter",
            ProviderKind::Deepseek => "deepseek",
            ProviderKind::Groq => "groq",
            ProviderKind::Mistral => "mistral",
            ProviderKind::Xai => "xai",
            ProviderKind::Lmstudio => "lmstudio",
            ProviderKind::Ollama => "ollama",
            ProviderKind::Custom => "custom",
        }
    }

    pub fn from_str_loose(value: &str) -> Option<Self> {
        Some(match value {
            "openai" => ProviderKind::Openai,
            "anthropic" => ProviderKind::Anthropic,
            "gemini" => ProviderKind::Gemini,
            "openrouter" => ProviderKind::Openrouter,
            "deepseek" => ProviderKind::Deepseek,
            "groq" => ProviderKind::Groq,
            "mistral" => ProviderKind::Mistral,
            "xai" => ProviderKind::Xai,
            "lmstudio" => ProviderKind::Lmstudio,
            "ollama" => ProviderKind::Ollama,
            "custom" => ProviderKind::Custom,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelRow {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub color: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub system_prompt_override: Option<String>,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    /// Think (reasoning) toggle: None = auto (follows supports_reasoning).
    pub reasoning_enabled: Option<bool>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub id: String,
    pub title: Option<String>,
    pub mode: String,
    pub selection_type: String,
    pub model_id: Option<String>,
    pub group_id: Option<String>,
    pub debate_settings_json: Option<String>,
    pub project_path: Option<String>,
    pub folder_id: Option<String>,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub model_id: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub tokens_estimated: Option<bool>,
    pub attachments_json: Option<String>,
    pub created_at: String,
}

fn bool_col(row: &SqliteRow, name: &str) -> Result<bool, sqlx::Error> {
    row.try_get::<i64, _>(name).map(|value| value != 0)
}

fn opt_bool_col(row: &SqliteRow, name: &str) -> Result<Option<bool>, sqlx::Error> {
    row.try_get::<Option<i64>, _>(name).map(|value| value.map(|v| v != 0))
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupDetail {
    #[serde(flatten)]
    pub group: GroupRow,
    pub models: Vec<ModelRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebateRow {
    pub id: String,
    pub message_id: String,
    pub conversation_id: String,
    pub status: String,
    pub rounds_total: i64,
    pub consensus_reached: Option<bool>,
    pub leader_model_id: Option<String>,
    pub settings_json: Option<String>,
    pub total_tokens_in: i64,
    pub total_tokens_out: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebateTurnRow {
    pub id: String,
    pub debate_id: String,
    pub round: i64,
    pub model_id: String,
    pub anon_label: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub phase: String,
    pub consensus: Option<bool>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebateDetail {
    #[serde(flatten)]
    pub debate: DebateRow,
    pub turns: Vec<DebateTurnRow>,
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for GroupRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(GroupRow {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for DebateRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(DebateRow {
            id: row.try_get("id")?,
            message_id: row.try_get("message_id")?,
            conversation_id: row.try_get("conversation_id")?,
            status: row.try_get("status")?,
            rounds_total: row.try_get("rounds_total")?,
            consensus_reached: opt_bool_col(row, "consensus_reached")?,
            leader_model_id: row.try_get("leader_model_id")?,
            settings_json: row.try_get("settings_json")?,
            total_tokens_in: row.try_get("total_tokens_in")?,
            total_tokens_out: row.try_get("total_tokens_out")?,
            started_at: row.try_get("started_at")?,
            ended_at: row.try_get("ended_at")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for DebateTurnRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(DebateTurnRow {
            id: row.try_get("id")?,
            debate_id: row.try_get("debate_id")?,
            round: row.try_get("round")?,
            model_id: row.try_get("model_id")?,
            anon_label: row.try_get("anon_label")?,
            content: row.try_get("content")?,
            reasoning: row.try_get("reasoning")?,
            tokens_in: row.try_get("tokens_in")?,
            tokens_out: row.try_get("tokens_out")?,
            phase: row.try_get("phase")?,
            consensus: opt_bool_col(row, "consensus")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for ProviderRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(ProviderRow {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            name: row.try_get("name")?,
            base_url: row.try_get("base_url")?,
            enabled: bool_col(row, "enabled")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for ModelRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(ModelRow {
            id: row.try_get("id")?,
            provider_id: row.try_get("provider_id")?,
            model_id: row.try_get("model_id")?,
            display_name: row.try_get("display_name")?,
            color: row.try_get("color")?,
            temperature: row.try_get("temperature")?,
            max_tokens: row.try_get("max_tokens")?,
            system_prompt_override: row.try_get("system_prompt_override")?,
            supports_vision: bool_col(row, "supports_vision")?,
            supports_tools: bool_col(row, "supports_tools")?,
            supports_reasoning: bool_col(row, "supports_reasoning")?,
            reasoning_enabled: row
                .try_get::<Option<i64>, _>("reasoning_enabled")?
                .map(|value| value != 0),
            enabled: bool_col(row, "enabled")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for Conversation {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Conversation {
            id: row.try_get("id")?,
            title: row.try_get("title")?,
            mode: row.try_get("mode")?,
            selection_type: row.try_get("selection_type")?,
            model_id: row.try_get("model_id")?,
            group_id: row.try_get("group_id")?,
            debate_settings_json: row.try_get("debate_settings_json")?,
            project_path: row.try_get("project_path")?,
            folder_id: row.try_get("folder_id")?,
            pinned: bool_col(row, "pinned")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, SqliteRow> for Message {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Message {
            id: row.try_get("id")?,
            conversation_id: row.try_get("conversation_id")?,
            role: row.try_get("role")?,
            content: row.try_get("content")?,
            reasoning: row.try_get("reasoning")?,
            model_id: row.try_get("model_id")?,
            tokens_in: row.try_get("tokens_in")?,
            tokens_out: row.try_get("tokens_out")?,
            tokens_estimated: row.try_get::<Option<i64>, _>("tokens_estimated")?.map(|v| v != 0),
            attachments_json: row.try_get("attachments_json")?,
            created_at: row.try_get("created_at")?,
        })
    }
}
