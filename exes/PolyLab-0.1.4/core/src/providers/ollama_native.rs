//! Ollama native API — model listing via `/api/tags` (chat goes through the
//! OpenAI-compatible `/v1` endpoint covered by `openai_compat`).

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
        let mut models = Vec::new();
        if let Some(items) = body["models"].as_array() {
            for item in items {
                let Some(name) = item["name"].as_str() else { continue };
                models.push(super::RemoteModel {
                    id: name.to_string(),
                    display_name: name.to_string(),
                    supports_tools: None,
                    context_window: None,
                });
            }
        }
        Ok(models)
    }

    async fn stream_chat(&self, request: super::ChatRequest) -> anyhow::Result<super::ChatStream> {
        self.compat.stream_chat(request).await
    }
}
