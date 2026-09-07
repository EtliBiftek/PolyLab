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

/// Capability block appended to every system prompt. Standing rule: every
/// feature PolyLab provides must be advertised to the model in its system
/// prompt (web search, think levels, attachments, workspace, debate...).
pub fn capability_notice() -> &'static str {
    r#"# App capabilities / Uygulama özellikleri

PolyLab provides you with the following features — / PolyLab sana şu yetenekleri sağlar:
- Web search: when enabled, DuckDuckGo results are given under `# Web arama sonuçları`; use them. / Web araması: etkinleştirildiğinde DuckDuckGo sonuçları `# Web arama sonuçları` bölümünde verilir; bu sonuçları kullan.
- Think mode: your reasoning is shown in a separate panel; when a level is selected, think at that level. / Think modu: düşünme sürecin ayrı bir alanda gösterilir; seviye seçildiğinde o seviyeye göre düşün.
- Attachments: users can attach text files to messages; take them into account. / Dosya ekleri: kullanıcı mesajlarına metin dosyaları eklenebilir; bunları dikkate al.
- Workspace (coding mode): project files and tools are provided; read and modify files. / Çalışma alanı (kodlama modu): proje dosyaları ve araçlar sana verilir; dosyaları okuyup değiştir.
- Native function calling (coding mode): call the declared tools directly when the provider supports them; otherwise use the legacy tool block. / Yerel fonksiyon çağrısı (kodlama modu): sağlayıcı destekliyorsa tanımlı araçları doğrudan çağır; değilse eski araç bloğunu kullan.
- Change approval: mutating tools ask the user first; file writes/deletes attach a unified diff for review. / Değişiklik onayı: değiştirici araçlar önce kullanıcıya sorar; dosya yazma/silme işlemleri inceleme için birleşik bir fark (diff) ekler.
- Model race: the same prompt may be answered by several models in parallel; answer completely and independently. / Model yarışı: aynı soru birkaç modele paralel verilebilir; eksiksiz ve bağımsız cevapla.
- Multi-model debate: you work alongside anonymous experts; consider other answers and justify your own. / Çoklu model tartışması: anonim uzmanlarla birlikte çalışırsın; diğer cevapları dikkate al, kendi cevabını gerekçelendir.
- Feedback: users can rate your answers; a well-structured, complete answer is preferred. / Geri bildirim: kullanıcılar cevaplarını değerlendirebilir; iyi yapılandırılmış ve eksiksiz cevap tercih edilir.
"#}

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
