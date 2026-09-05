//! Debate engine (plan §5.2) — anonymized multi-model rounds with leader synthesis.

pub mod consensus;
pub mod leader;
pub mod rounds;

use serde::{Deserialize, Serialize};

use crate::providers::Provider;
use crate::secrets::{provider_key, SecretStore};
use crate::storage::{ModelRow, ProviderRow};

pub use leader::select_leader;

/// One debating model with its resolved provider connection and per-debate label.
pub struct Participant {
    pub model: ModelRow,
    pub provider_row: ProviderRow,
    pub provider: std::sync::Arc<dyn Provider>,
    pub anon_label: String,
}

/// Resolves provider connections for every enabled model of a group.
pub async fn build_participants(
    db: &sqlx::SqlitePool,
    secrets: &dyn SecretStore,
    models: &[ModelRow],
) -> anyhow::Result<Vec<Participant>> {
    let mut participants = Vec::new();
    for model in models {
        let provider_row: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
            .bind(&model.provider_id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| anyhow::anyhow!("provider {} not found", model.provider_id))?;
        let kind = crate::storage::ProviderKind::from_str_loose(&provider_row.kind)
            .ok_or_else(|| anyhow::anyhow!("unknown provider kind {}", provider_row.kind))?;
        let api_key = secrets
            .get(&provider_key(&provider_row.id))
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "secret store read failed; continuing without key");
                None
            });
        let provider: std::sync::Arc<dyn Provider> = crate::providers::build(
            kind,
            provider_row.base_url.as_deref(),
            api_key.as_deref(),
            )?
            .into();
        participants.push(Participant {
            model: model.clone(),
            provider_row,
            provider,
            anon_label: String::new(),
        });
    }
    leader::assign_labels(&mut participants);
    Ok(participants)
}

/// Per-conversation debate configuration (`debate_settings_json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DebateSettings {
    /// `fixed` runs exactly `max_rounds` rounds; `consensus` stops early when every
    /// remaining participant votes `CONSENSUS: yes` (max_rounds is the upper bound).
    pub termination: Termination,
    pub max_rounds: u32,
    /// None → automatic leader selection.
    pub leader_model_id: Option<String>,
    /// Always false in the protocol; kept so stored payloads round-trip.
    #[serde(default)]
    pub show_names_to_models: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Termination {
    Fixed,
    Consensus,
}

impl Default for DebateSettings {
    fn default() -> Self {
        Self {
            termination: Termination::Fixed,
            max_rounds: 2,
            leader_model_id: None,
            show_names_to_models: false,
        }
    }
}

impl DebateSettings {
    pub fn parse(json: Option<&str>) -> Self {
        json.and_then(|raw| serde_json::from_str::<DebateSettings>(raw).ok())
            .unwrap_or_default()
            .normalized()
    }

    fn normalized(self) -> Self {
        Self { max_rounds: self.max_rounds.clamp(1, 6), ..self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_parse_and_clamp() {
        assert_eq!(DebateSettings::parse(None).max_rounds, 2);

        let settings = DebateSettings::parse(Some(
            r#"{"termination":"consensus","max_rounds":99,"leader_model_id":"m1"}"#,
        ));
        assert_eq!(settings.termination, Termination::Consensus);
        assert_eq!(settings.max_rounds, 6);
        assert_eq!(settings.leader_model_id.as_deref(), Some("m1"));
        assert!(!settings.show_names_to_models);

        // Malformed JSON falls back to defaults.
        assert_eq!(DebateSettings::parse(Some("{")), DebateSettings::default());
    }
}
