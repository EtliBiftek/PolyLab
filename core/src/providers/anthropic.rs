//! Anthropic Messages API (`/v1/messages`) with SSE streaming and extended thinking.

use eventsource_stream::Eventsource;
use serde_json::{json, Value};

use super::{ChatEvent, ChatRequest, ChatStream, Provider, RemoteModel};
use crate::storage::ProviderKind;

const DEFAULT_BASE: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 4096;

pub struct Anthropic {
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl Anthropic {
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
        let mut request = request
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json");
        if let Some(key) = &self.api_key {
            request = request.header("x-api-key", key);
        }
        request
    }
}

#[async_trait::async_trait]
impl Provider for Anthropic {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
    }

    async fn list_models(&self) -> anyhow::Result<Vec<RemoteModel>> {
        let response = self
            .auth(self.client.get(format!("{}/v1/models", self.base_url)))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(super::openai_compat::provider_error(
                "v1/models",
                status,
                response.text().await?,
            ));
        }
        let body: Value = response.json().await?;
        let mut models = Vec::new();
        if let Some(items) = body["data"].as_array() {
            for item in items {
                let Some(id) = item["id"].as_str() else { continue };
                models.push(RemoteModel {
                    id: id.to_string(),
                    display_name: item["display_name"].as_str().unwrap_or(id).to_string(),
                    supports_tools: None,
                    context_window: None,
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
        let conversation: Vec<Value> = request
            .messages
            .iter()
            .filter(|message| message.role != super::Role::System)
            .map(|message| {
                json!({
                    "role": if message.role == super::Role::Assistant { "assistant" } else { "user" },
                    "content": [{ "type": "text", "text": message.content }],
                })
            })
            .collect();

        let mut body = json!({
            "model": request.model,
            "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "messages": conversation,
            "stream": true,
        });
        if !system.is_empty() {
            body["system"] = json!(system.join("\n\n"));
        }
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }

        let response = self
            .auth(self.client.post(format!("{}/v1/messages", self.base_url)))
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(super::openai_compat::provider_error(
                "v1/messages",
                status,
                response.text().await?,
            ));
        }

        let source = response.bytes_stream().eventsource();
        let mut tokens_in: Option<u64> = None;
        let mut tokens_out: Option<u64> = None;

        Ok(super::stream_util::sse_events(source, move |event, out| {
            let Some(event) = event else { return true };
            let Ok(data) = serde_json::from_str::<Value>(&event.data) else { return true };
            match data["type"].as_str().unwrap_or_default() {
                "message_start" => {
                    tokens_in = data
                        .pointer("/message/usage/input_tokens")
                        .and_then(Value::as_u64);
                }
                "content_block_delta" => {
                    let delta = &data["delta"];
                    match delta["type"].as_str().unwrap_or_default() {
                        "text_delta" => {
                            if let Some(text) = delta["text"].as_str() {
                                out.push(ChatEvent::TextDelta(text.to_string()));
                            }
                        }
                        "thinking_delta" => {
                            if let Some(thinking) = delta["thinking"].as_str() {
                                out.push(ChatEvent::ReasoningDelta(thinking.to_string()));
                            }
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    tokens_out = data
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64);
                }
                "message_stop" => {
                    if let (Some(tokens_in), Some(tokens_out)) = (tokens_in, tokens_out) {
                        out.push(ChatEvent::Usage { tokens_in, tokens_out });
                    }
                    return false;
                }
                "error" => {
                    let detail = data
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown provider error")
                        .to_string();
                    out.push(ChatEvent::Error { detail });
                    return false;
                }
                _ => {}
            }
            true
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_default_and_trim() {
        assert_eq!(Anthropic::new(None, None).unwrap().base_url, DEFAULT_BASE);
        assert_eq!(
            Anthropic::new(Some("http://127.0.0.1:7/"), None).unwrap().base_url,
            "http://127.0.0.1:7"
        );
    }
}
