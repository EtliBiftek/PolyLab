//! One implementation for every OpenAI-compatible API (plan §5.1):
//! OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI, LM Studio, Ollama `/v1`, Custom.
//!
//! Payloads are parsed as raw `serde_json::Value` — providers differ in optional
//! fields (`reasoning_content`, `reasoning`, …) and strict structs would be brittle.

use eventsource_stream::Eventsource;
use serde_json::{json, Value};

use super::{ChatEvent, ChatMessage, ChatRequest, ChatStream, Provider, RemoteModel, Role};
use crate::storage::ProviderKind;

pub struct OpenAiCompat {
    kind: ProviderKind,
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

pub fn default_base(kind: ProviderKind) -> Option<&'static str> {
    Some(match kind {
        ProviderKind::Openai => "https://api.openai.com/v1",
        ProviderKind::Openrouter => "https://openrouter.ai/api/v1",
        ProviderKind::Deepseek => "https://api.deepseek.com/v1",
        ProviderKind::Groq => "https://api.groq.com/openai/v1",
        ProviderKind::Mistral => "https://api.mistral.ai/v1",
        ProviderKind::Xai => "https://api.x.ai/v1",
        ProviderKind::Lmstudio => "http://localhost:1234/v1",
        ProviderKind::Ollama => "http://localhost:11434/v1",
        ProviderKind::Custom => return None,
        other => {
            tracing::warn!(kind = other.as_str(), "kind has no OpenAI-compat default base");
            return None;
        }
    })
}

/// Providers documented to accept `stream_options.include_usage`. Conservative list:
/// unknown/custom servers may 400 on it.
fn supports_stream_options(kind: ProviderKind) -> bool {
    matches!(
        kind,
        ProviderKind::Openai
            | ProviderKind::Openrouter
            | ProviderKind::Deepseek
            | ProviderKind::Groq
            | ProviderKind::Mistral
            | ProviderKind::Xai
    )
}

impl OpenAiCompat {
    pub fn new(kind: ProviderKind, base_url: Option<&str>, api_key: Option<&str>) -> anyhow::Result<Self> {
        let base_url = base_url
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .or_else(|| default_base(kind).map(str::to_string))
            .ok_or_else(|| anyhow::anyhow!("base URL is required for custom providers"))?
            .trim_end_matches('/')
            .to_string();

        Ok(Self {
            kind,
            base_url,
            api_key: api_key.map(str::to_string),
            client: super::http_client()?,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn apply_auth(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        if self.kind == ProviderKind::Openrouter {
            // Attribution headers recommended by OpenRouter.
            request = request
                .header("HTTP-Referer", "https://polylab.local")
                .header("X-Title", "PolyLab");
        }
        request
    }
}

/// Serializes the request history. When vision attachments are present they are
/// appended as `image_url` content parts on the final user message — the only
/// shape OpenAI-compatible APIs accept for images.
fn build_messages(request: &ChatRequest) -> Vec<Value> {
    let mut messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| json!({ "role": message.role.as_str(), "content": message.content }))
        .collect();
    if request.images.is_empty() || messages.is_empty() {
        return messages;
    }
    let target = request
        .messages
        .iter()
        .rposition(|message| message.role == Role::User)
        .unwrap_or(request.messages.len() - 1);
    let mut parts = vec![json!({ "type": "text", "text": request.messages[target].content })];
    for image in &request.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": image.data_uri }
        }));
    }
    messages[target]["content"] = Value::Array(parts);
    messages
}

#[async_trait::async_trait]
impl Provider for OpenAiCompat {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    async fn list_models(&self) -> anyhow::Result<Vec<RemoteModel>> {
        let response = self
            .apply_auth(self.client.get(format!("{}/models", self.base_url)))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(provider_error("list_models", status, response.text().await?));
        }
        let body: Value = response.json().await?;
        let mut models = Vec::new();
        if let Some(items) = body["data"].as_array() {
            for item in items {
                let Some(id) = item["id"].as_str() else { continue };
                models.push(RemoteModel {
                    id: id.to_string(),
                    display_name: item
                        .get("display_name")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string(),
                    supports_tools: item
                        .get("supported_tools")
                        .and_then(Value::as_bool),
                    context_window: item
                        .get("context_length")
                        .or_else(|| item.get("top_provider"))
                        .and_then(|v| v.get("context_length"))
                        .and_then(Value::as_u64),
                });
            }
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(models)
    }

    async fn stream_chat(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let mut body = json!({
            "model": request.model,
            "messages": build_messages(&request),
            "stream": true,
        });
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if supports_stream_options(self.kind) {
            body["stream_options"] = json!({ "include_usage": true });
        }

        let response = self
            .apply_auth(self.client.post(format!("{}/chat/completions", self.base_url)))
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(provider_error("chat/completions", status, response.text().await?));
        }

        let mut think_filter = super::reasoning::ThinkFilter::new();
        let source = response.bytes_stream().eventsource();

        Ok(super::stream_util::sse_events(source, move |event, out| {
            let Some(event) = event else {
                let (text, reasoning) = think_filter.finish();
                if !reasoning.is_empty() {
                    out.push(ChatEvent::ReasoningDelta(reasoning));
                }
                if !text.is_empty() {
                    out.push(ChatEvent::TextDelta(text));
                }
                return true;
            };
            if event.data.trim() == "[DONE]" {
                return false;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(&event.data) else {
                return true;
            };

            if let Some(delta) = chunk.pointer("/choices/0/delta").and_then(Value::as_object) {
                if let Some(reasoning) = delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .and_then(Value::as_str)
                {
                    out.push(ChatEvent::ReasoningDelta(reasoning.to_string()));
                }
                if let Some(content) = delta.get("content").and_then(Value::as_str) {
                    let (text, reasoning) = think_filter.feed(content);
                    if !reasoning.is_empty() {
                        out.push(ChatEvent::ReasoningDelta(reasoning));
                    }
                    if !text.is_empty() {
                        out.push(ChatEvent::TextDelta(text));
                    }
                }
            }

            if let Some(usage) = chunk.get("usage").and_then(Value::as_object) {
                let tokens_in = usage.get("prompt_tokens").and_then(Value::as_u64);
                let tokens_out = usage.get("completion_tokens").and_then(Value::as_u64);
                if let (Some(tokens_in), Some(tokens_out)) = (tokens_in, tokens_out) {
                    out.push(ChatEvent::Usage { tokens_in, tokens_out });
                }
            }
            true
        }))
    }
}

pub fn provider_error(endpoint: &str, status: reqwest::StatusCode, body: String) -> anyhow::Error {
    let body = truncate(&body, 400);
    anyhow::anyhow!("{endpoint} failed: HTTP {status}: {body}")
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// `ChatMessage` helper for building histories.
pub fn message(role: super::Role, content: impl Into<String>) -> ChatMessage {
    ChatMessage { role, content: content.into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{InputImage, Role};

    fn test_app() -> axum::Router {
        use axum::{routing::get, routing::post, Json};
        async fn models() -> Json<Value> {
            json!({ "data": [ { "id": "zeta" }, { "id": "alpha" } ] }).into()
        }
        async fn chat() -> Json<Value> {
            json!({ "data": [] }).into()
        }
        axum::Router::new().route("/v1/models", get(models)).route("/v1/chat/completions", post(chat))
    }

    #[tokio::test]
    async fn default_base_urls() {
        assert_eq!(default_base(ProviderKind::Openai), Some("https://api.openai.com/v1"));
        assert_eq!(default_base(ProviderKind::Lmstudio), Some("http://localhost:1234/v1"));
        assert_eq!(default_base(ProviderKind::Custom), None);
    }

    #[tokio::test]
    async fn base_url_can_override_and_trailing_slash_is_trimmed() {
        let provider = OpenAiCompat::new(ProviderKind::Custom, Some("http://127.0.0.1:9/v1/"), None)
            .expect("custom with base");
        assert_eq!(provider.base_url(), "http://127.0.0.1:9/v1");

        assert!(OpenAiCompat::new(ProviderKind::Custom, None, None).is_err());
    }

    #[tokio::test]
    async fn list_models_sorts_by_id() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, test_app()).await.unwrap() });

        let provider = OpenAiCompat::new(ProviderKind::Custom, Some(&format!("http://{addr}/v1")), None)
            .unwrap();
        let models = provider.list_models().await.unwrap();
        let ids: Vec<_> = models.into_iter().map(|model| model.id).collect();
        assert_eq!(ids, vec!["alpha", "zeta"]);
    }

    #[test]
    fn message_helper() {
        let message = message(Role::User, "selam");
        assert_eq!(message.role, Role::User);
        assert_eq!(message.content, "selam");
    }

    #[test]
    fn build_messages_appends_images_to_the_last_user_turn() {
        let request = ChatRequest {
            model: "gpt-4o".into(),
            messages: vec![
                message(Role::System, "you are helpful"),
                message(Role::User, "describe this"),
                message(Role::Assistant, "ok"),
                message(Role::User, "and this one"),
            ],
            images: vec![
                InputImage { data_uri: "data:image/png;base64,AAA".into() },
                InputImage { data_uri: "data:image/png;base64,BBB".into() },
            ],
            ..Default::default()
        };
        let messages = build_messages(&request);
        assert_eq!(messages.len(), 4);
        // Earlier turns stay plain strings.
        assert_eq!(messages[0], json!({ "role": "system", "content": "you are helpful" }));
        // Last user turn becomes a content array: text followed by image parts.
        let last = &messages[3];
        assert_eq!(last["role"], "user");
        assert_eq!(last["content"][0]["type"], "text");
        assert_eq!(last["content"][0]["text"], "and this one");
        assert_eq!(last["content"][1]["type"], "image_url");
        assert_eq!(last["content"][1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(last["content"][2]["image_url"]["url"], "data:image/png;base64,BBB");
    }

    #[test]
    fn build_messages_without_images_keeps_plain_content() {
        let request = ChatRequest {
            model: "model".into(),
            messages: vec![message(Role::User, "selam")],
            ..Default::default()
        };
        let messages = build_messages(&request);
        assert_eq!(messages, vec![json!({ "role": "user", "content": "selam" })]);
    }
}
