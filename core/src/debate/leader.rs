//! Leader selection (plan §5.2): automatic score or the user's explicit choice.

use rand::seq::SliceRandom;

use crate::storage::{ProviderKind, ModelRow};

use super::Participant;

/// Anonymized labels are reshuffled for every debate so models cannot infer identity
/// from a stable A/B/C mapping across conversations.
pub fn assign_labels(participants: &mut [Participant]) {
    let mut rng = rand::rng();
    participants.shuffle(&mut rng);
    for (index, participant) in participants.iter_mut().enumerate() {
        participant.anon_label = format!("Model {}", char::from_u32('A' as u32 + index as u32).unwrap_or('?'));
    }
}

/// score = reasoning support (+3) + cloud provider (+1); ties → first in group order.
pub fn score(model: &ModelRow, provider_kind: ProviderKind) -> i32 {
    let mut score = 0;
    if model.supports_reasoning {
        score += 3;
    }
    if matches!(
        provider_kind,
        ProviderKind::Openai
            | ProviderKind::Anthropic
            | ProviderKind::Gemini
            | ProviderKind::Openrouter
            | ProviderKind::Deepseek
            | ProviderKind::Groq
            | ProviderKind::Mistral
            | ProviderKind::Xai
    ) {
        score += 1;
    }
    score
}

/// Chooses the leader model id. `explicit` (user choice) wins when it is still in the
/// group; otherwise the highest-scoring alive participant.
pub fn select_leader(
    participants: &[Participant],
    explicit: Option<&str>,
) -> String {
    if let Some(explicit) = explicit {
        if participants.iter().any(|p| p.model.id == explicit) {
            return explicit.to_string();
        }
    }
    // Strictly-greater comparison so ties resolve to the FIRST group member.
    let mut best: Option<(&Participant, i32)> = None;
    for participant in participants {
        let kind = crate::storage::ProviderKind::from_str_loose(&participant.provider_row.kind);
        let value = kind.map(|k| score(&participant.model, k)).unwrap_or(0);
        if best.map_or(true, |(_, best_value)| value > best_value) {
            best = Some((participant, value));
        }
    }
    best.map(|(p, _)| p.model.id.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::ProviderRow;

    fn participant(id: &str, kind: ProviderKind, reasoning: bool, provider_id: &str) -> Participant {
        Participant {
            model: ModelRow {
                id: id.into(),
                provider_id: provider_id.into(),
                model_id: format!("remote-{id}"),
                display_name: id.into(),
                color: None,
                temperature: None,
                max_tokens: None,
                system_prompt_override: None,
                supports_vision: false,
                supports_tools: false,
                supports_reasoning: reasoning,
                reasoning_enabled: None,
                enabled: true,
            },
            provider_row: ProviderRow {
                id: provider_id.into(),
                kind: kind.as_str().into(),
                name: format!("{kind:?}"),
                base_url: None,
                enabled: true,
                created_at: String::new(),
            },
            provider: std::sync::Arc::new(crate::providers::openai_compat::OpenAiCompat::new(
                ProviderKind::Custom,
                Some("http://127.0.0.1:9/v1"),
                None,
            ).unwrap()),
            anon_label: String::new(),
        }
    }

    #[test]
    fn explicit_leader_wins_when_present() {
        let participants = vec![
            participant("a", ProviderKind::Openai, false, "p1"),
            participant("b", ProviderKind::Lmstudio, false, "p2"),
        ];
        assert_eq!(select_leader(&participants, Some("b")), "b");
    }

    #[test]
    fn reasoning_beats_cloud_only() {
        let participants = vec![
            participant("cloud", ProviderKind::Openai, false, "p1"),
            participant("local-thinker", ProviderKind::Lmstudio, true, "p2"),
        ];
        assert_eq!(select_leader(&participants, None), "local-thinker");
    }

    #[test]
    fn ties_pick_first_in_group_order() {
        let participants = vec![
            participant("first", ProviderKind::Openai, false, "p1"),
            participant("second", ProviderKind::Openai, false, "p1"),
        ];
        assert_eq!(select_leader(&participants, None), "first");
    }

    #[test]
    fn labels_are_assigned_and_reshuffled() {
        // With enough reshuffles both orderings appear (labels really are random).
        let mut seen_swapped = false;
        for _ in 0..60 {
            let mut participants = vec![
                participant("x", ProviderKind::Openai, false, "p1"),
                participant("y", ProviderKind::Openai, false, "p1"),
            ];
            assign_labels(&mut participants);
            assert!(participants.iter().all(|p| p.anon_label.starts_with("Model ")));
            if participants[0].model.id == "y" {
                seen_swapped = true;
            }
        }
        assert!(seen_swapped);
    }
}
