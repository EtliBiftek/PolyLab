//! Ollama native API — model listing via `/api/tags` (+ best-effort `/api/show`
//! capability probe; chat goes through the OpenAI-compatible `/v1` endpoint
//! covered by `openai_compat`, which maps `reasoning_effort` to Ollama's
//! internal `Think` field on thinking-capable models).

use crate::storage::ProviderKind;

pub struct OllamaNative {
    base_url: String,
    compat: super::openai_compat::OpenAiCompat,
}

impl OllamaNative {
    pub fn new(base_url: Option<&str>) -> anyhow::Result<Self> {
        let base_url = base_url
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .unwrap_or("http://localhost:11434")
            .trim_end_matches('/')
            .to_string();
        let compat = super::openai_compat::OpenAiCompat::new(
            ProviderKind::Ollama,
            Some(&format!("{base_url}/v1")),
            None,
        )?;
        Ok(Self { base_url, compat })
    }
}

/// Capability names Ollama reports (e.g. `tools`, `vision`, `thinking`).
fn has_capability(value: Option<&serde_json::Value>, wanted: &str) -> bool {
    value
        .and_then(|item| item.get("capabilities"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some(wanted)))
}

/// Conservative name heuristic for Ollama builds that expose capability arrays
/// on neither `/api/tags` nor `/api/show` (older servers). The families below
/// are documented as thinking-capable and auto-enable thinking.
fn name_hint_supports_reasoning(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id.starts_with("r1-")
        || id.starts_with("deepseek-r1")
        || id.starts_with("deepseek-v3.1")
        || id.starts_with("reason")
        || id.starts_with("think")
        || id.starts_with("qwen3")
        || id.starts_with("gpt-oss")
        || id.contains("reasoning")
}

#[async_trait::async_trait]
impl super::Provider for OllamaNative {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Ollama
    }

    async fn list_models(&self) -> anyhow::Result<Vec<super::RemoteModel>> {
        let client = super::http_client()?;
        let response = client
            .get(format!("{}/api/tags", self.base_url))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(super::openai_compat::provider_error(
                "api/tags",
                status,
                response.text().await?,
            ));
        }
        let body: serde_json::Value = response.json().await?;
        let items = body["models"].as_array().cloned().unwrap_or_default();

        let mut models = Vec::new();
        for item in &items {
            let Some(name) = item["name"].as_str() else { continue };
            // Modern servers advertise capabilities directly in /api/tags.
            // Older ones need a per-model /api/show probe; bounded so huge
            // catalogs (remote Ollama) stay responsive.
            let show: Option<serde_json::Value> = if item.get("capabilities").is_some()
                || items.len() > 64
            {
                None
            } else {
                match super::http_client().ok() {
                    Some(probe) => {
                        let show = probe
                            .post(format!("{}/api/show", self.base_url))
                            .json(&serde_json::json!({ "model": name }))
                            .send()
                            .await;
                        match show {
                            Ok(response) if response.status().is_success() => {
                                response.json::<serde_json::Value>().await.ok()
                            }
                            _ => None,
                        }
                    }
                    None => None,
                }
            };

            // /api/show / /api/tags capability arrays; fall back to the name
            // heuristic only when neither source reports capabilities.
            let caps_known =
                item.get("capabilities").is_some() || show.as_ref().and_then(|s| s.get("capabilities")).is_some();
            let reasoning = if caps_known {
                has_capability(Some(item), "thinking")
                    || show
                        .as_ref()
                        .is_some_and(|s| has_capability(Some(s), "thinking"))
            } else {
                name_hint_supports_reasoning(name)
            };
            let supports_reasoning = Some(reasoning);
            // Ollama's OpenAI-compat endpoint accepts reasoning_effort
            // (low/medium/high → thinking on with varying effort, "none" → off)
            // on thinking-capable models.
            let reasoning_options = if reasoning {
                vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                ]
            } else {
                Vec::new()
            };
            let supports_tools = if caps_known {
                Some(
                    has_capability(Some(item), "tools")
                        || show
                            .as_ref()
                            .is_some_and(|s| has_capability(Some(s), "tools")),
                )
            } else {
                None
            };
            let context_window = show
                .as_ref()
                .and_then(|show| show.pointer("/model_info/context_length"))
                .and_then(serde_json::Value::as_u64);
            models.push(super::RemoteModel {
                id: name.to_string(),
                display_name: name.to_string(),
                supports_tools,
                context_window,
                supports_reasoning,
                reasoning_options,
            });
        }
        Ok(models)
    }

    async fn stream_chat(&self, request: super::ChatRequest) -> anyhow::Result<super::ChatStream> {
        self.compat.stream_chat(request).await
    }
}
