//! Google Gemini `streamGenerateContent` (SSE via `alt=sse`) + model listing.

use eventsource_stream::Eventsource;
use serde_json::{json, Value};

use super::{ChatEvent, ChatRequest, ChatStream, Provider, RemoteModel};
use crate::storage::ProviderKind;

const DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com";

pub struct Gemini {
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl Gemini {
    pub fn new(base_url: Option<&str>, api_key: Option<&str>) -> anyhow::Result<Self> {
        Ok(Self {
            base_url: base_url
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .unwrap_or(DEFAULT_BASE)
                .trim_end_matches('/')
                .to_string(),
            api_key: api_key.map(str::to_string),
            client: super::http_client()?,
        })
    }

    fn auth(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(key) = &self.api_key {
            return request.header("x-goog-api-key", key);
        }
        request
    }
}

#[async_trait::async_trait]
impl Provider for Gemini {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Gemini
    }

    async fn list_models(&self) -> anyhow::Result<Vec<RemoteModel>> {
        let response = self
            .auth(self.client.get(format!("{}/v1beta/models", self.base_url)))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(super::openai_compat::provider_error(
                "v1beta/models",
                status,
                response.text().await?,
            ));
        }
        let body: Value = response.json().await?;
        let mut models = Vec::new();
        if let Some(items) = body["models"].as_array() {
            for item in items {
                let Some(name) = item["name"].as_str() else { continue };
                let methods = item["supportedGenerationMethods"]
                    .as_array()
                    .map(|array| {
                        array
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|method| method == "generateContent")
                    })
                    .unwrap_or(true);
                if !methods {
                    continue;
                }
                let id = name.strip_prefix("models/").unwrap_or(name);
                models.push(RemoteModel {
                    id: id.to_string(),
                    display_name: item["displayName"].as_str().unwrap_or(id).to_string(),
                    supports_tools: None,
                    context_window: item.get("inputTokenLimit").and_then(Value::as_u64),
                });
            }
        }
        Ok(models)
    }

    async fn stream_chat(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let system: Vec<&str> = request
            .messages
            .iter()
            .filter(|message| message.role == super::Role::System)
            .map(|message| message.content.as_str())
            .collect();
        let contents: Vec<Value> = request
            .messages
            .iter()
            .filter(|message| message.role != super::Role::System)
            .map(|message| {
                json!({
                    "role": if message.role == super::Role::Assistant { "model" } else { "user" },
                    "parts": [{ "text": message.content }],
                })
            })
            .collect();

        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
            self.base_url, request.model
        );
        let mut body = json!({ "contents": contents });
        if !system.is_empty() {
            body["systemInstruction"] = json!({ "parts": [{ "text": system.join("\n\n") }] });
        }
        let mut generation_config = serde_json::Map::new();
        if let Some(temperature) = request.temperature {
            generation_config.insert("temperature".into(), json!(temperature));
        }
        if let Some(max_tokens) = request.max_tokens {
            generation_config.insert("maxOutputTokens".into(), json!(max_tokens));
        }
        if !generation_config.is_empty() {
            body["generationConfig"] = Value::Object(generation_config);
        }

        let response = self.auth(self.client.post(url)).json(&body).send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(super::openai_compat::provider_error(
                "streamGenerateContent",
                status,
                response.text().await?,
            ));
        }

        let source = response.bytes_stream().eventsource();
        let mut usage: Option<(u64, u64)> = None;

        Ok(super::stream_util::sse_events(source, move |event, out| {
            let Some(event) = event else {
                if let Some((tokens_in, tokens_out)) = usage {
                    out.push(ChatEvent::Usage { tokens_in, tokens_out });
                }
                return true;
            };
            let Ok(chunk) = serde_json::from_str::<Value>(&event.data) else { return true };
            if let Some(error) = chunk.get("error") {
                let detail = error["message"].as_str().unwrap_or("unknown error").to_string();
                out.push(ChatEvent::Error { detail });
                return false;
            }
            if let Some(parts) = chunk.pointer("/candidates/0/content/parts").and_then(Value::as_array) {
                for part in parts {
                    let Some(text) = part["text"].as_str() else { continue };
                    if part.get("thought").and_then(Value::as_bool).unwrap_or(false) {
                        out.push(ChatEvent::ReasoningDelta(text.to_string()));
                    } else {
                        out.push(ChatEvent::TextDelta(text.to_string()));
                    }
                }
            }
            if let Some(metadata) = chunk.get("usageMetadata") {
                let prompt = metadata.get("promptTokenCount").and_then(Value::as_u64);
                let candidates = metadata.get("candidatesTokenCount").and_then(Value::as_u64);
                if let (Some(prompt), Some(candidates)) = (prompt, candidates) {
                    usage = Some((prompt, candidates));
                }
            }
            true
        }))
    }
}
