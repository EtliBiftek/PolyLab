//! System prompt library. Prompts live in the repo's `prompts/` directory and are
//! embedded as compile-time defaults; `POLYLAB_PROMPTS_DIR` overrides them at runtime
//! (files are re-read on reload) so users can edit prompts without rebuilding.

use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct PromptLibrary {
    prompts: HashMap<String, String>,
}

pub const PROMPT_NAMES: &[&str] = &[
    "chat",
    "coding",
    "debate_participant",
    "debate_critique",
    "debate_leader",
    "code_reviewer",
    "agent",
];

impl PromptLibrary {
    pub fn load() -> Self {
        let mut prompts = HashMap::new();
        let defaults = embedded_defaults();
        let dir = std::env::var("POLYLAB_PROMPTS_DIR").ok().map(PathBuf::from);

        for name in PROMPT_NAMES {
            let loaded = dir.as_ref().and_then(|dir| {
                let path = dir.join(format!("{name}.md"));
                std::fs::read_to_string(&path)
                    .map_err(|error| {
                        tracing::warn!(%error, path = %path.display(), "failed to read prompt override");
                        error
                    })
                    .ok()
                    .filter(|text| !text.trim().is_empty())
            });
            let text = loaded
                .or_else(|| defaults.get(*name).cloned())
                .unwrap_or_default();
            prompts.insert((*name).to_string(), text);
        }
        Self { prompts }
    }

    pub fn get(&self, name: &str) -> &str {
        self.prompts
            .get(name)
            .map(String::as_str)
            .unwrap_or_default()
    }
}

fn embedded_defaults() -> HashMap<String, String> {
    [
        ("chat", include_str!("../../prompts/chat.md")),
        ("coding", include_str!("../../prompts/coding.md")),
        (
            "debate_participant",
            include_str!("../../prompts/debate_participant.md"),
        ),
        (
            "debate_critique",
            include_str!("../../prompts/debate_critique.md"),
        ),
        (
            "debate_leader",
            include_str!("../../prompts/debate_leader.md"),
        ),
        ("agent", include_str!("../../prompts/agent.md")),
        (
            "code_reviewer",
            include_str!("../../prompts/code_reviewer.md"),
        ),
    ]
    .into_iter()
    .map(|(name, text)| (name.to_string(), text.trim().to_string()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_prompts_load_non_empty() {
        let library = PromptLibrary::load();
        for name in PROMPT_NAMES {
            assert!(!library.get(name).trim().is_empty(), "prompt {name} is empty");
        }
    }
}
