//! One implementation for every OpenAI-compatible API (plan §5.1):
//! OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI, LM Studio, Ollama `/v1`, Custom.
//!
//! Payloads are parsed as raw `serde_json::Value` — providers differ in optional
//! fields (`reasoning_content`, `reasoning`, …) and strict structs would be brittle.

use eventsource_stream::Eventsource;
use serde_json::{json, Value};

use super::{ChatEvent, ChatMessage, ChatRequest, ChatStream, Provider, RemoteModel, Role, ToolCall, ToolChoice};
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

/// Serializes the request history. Tool calls/results and vision attachments are
/// mapped to the OpenAI wire shape (tool messages get `tool_call_id`; assistant
/// tool calls become `tool_calls`; images become `image_url` parts on the final
/// user turn).
fn build_messages(request: &ChatRequest) -> Vec<Value> {
    let mut messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            let mut value = json!({ "role": message.role.as_str(), "content": message.content });
            if !message.tool_calls.is_empty() {
                value["tool_calls"] = Value::Array(
                    message
                        .tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments.to_string(),
                                }
                            })
                        })
                        .collect(),
                );
            }
            if let Some(call_id) = &message.tool_call_id {
                value["tool_call_id"] = json!(call_id);
            }
            value
        })
        .collect();
    if request.images.is_empty() || messages.is_empty() {
        return messages;
    }
    // The image-bearing turn is the LAST plain user message in the wire array
    // (tool results never carry images).
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

/// `tools` + `tool_choice` request fields (native function calling).
fn build_tools(request: &ChatRequest) -> Option<Value> {
    if request.tools.is_empty() {
        return None;
    }
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            })
        })
        .collect();
    let tool_choice = match &request.tool_choice {
        None | Some(ToolChoice::Auto) => json!("auto"),
        Some(ToolChoice::None) => json!("none"),
        Some(ToolChoice::Named(name)) => json!({ "type": "function", "function": { "name": name } }),
    };
    Some(json!({ "tools": tools, "tool_choice": tool_choice }))
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
                    supports_reasoning: item
                        .get("reasoning")
                        .and_then(|v| v.get("enabled"))
                        .and_then(Value::as_bool)
                        .or_else(|| item.get("reasoning").map(|_| true))
                        .or_else(|| {
                            // Native OpenAI listings carry no capability flags:
                            // recognize the reasoning families by model id.
                            let id = id.to_ascii_lowercase();
                            (id.starts_with("o1")
                                || id.starts_with("o3")
                                || id.starts_with("o4")
                                || id.contains("gpt-5")
                                || id.starts_with("gpt-5"))
                            .then_some(true)
                        }),
                    // OpenRouter advertises the effort level; expose the
                    // standard low/medium/high ladder when it is present.
                    reasoning_options: item
                        .get("reasoning")
                        .and_then(|v| v.get("effort"))
                        .and_then(Value::as_str)
                        .map(|_| {
                            vec![
                                "low".to_string(),
                                "medium".to_string(),
                                "high".to_string(),
                            ]
                        })
                        .unwrap_or_default(),
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
        if let Some(tools) = build_tools(&request) {
            body["tools"] = tools["tools"].clone();
            body["tool_choice"] = tools["tool_choice"].clone();
        }
        // Web search is resolved by the engine (DuckDuckGo injection for every
        // provider) — no provider-side plugin is sent here.
        // Think: OpenRouter wants `reasoning.effort`, OpenAI-compatible reasoning
        // models use `reasoning_effort`; "medium" is the provider default level.
        if request.reasoning_enabled {
            let effort = request.reasoning_effort.clone().unwrap_or_else(|| "medium".to_string());
            if self.kind == ProviderKind::Openrouter {
                body["reasoning"] = json!({ "enabled": true, "effort": effort });
            } else {
                body["reasoning_effort"] = json!(effort);
            }
        } else if self.kind == ProviderKind::Ollama {
            // Ollama auto-enables thinking on capable models when the field is
            // absent (0.12+); "none" is the documented off value, so Think OFF
            // actually stays off there.
            body["reasoning_effort"] = json!("none");
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
        let mut resolved: Option<String> = None;
        // Streaming tool-call deltas arrive fragmented by `index`; they are
        // accumulated here and flushed once as ChatEvent::ToolCalls at stream end.
        let mut tool_fragments: Vec<(String, String, String)> = Vec::new();
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
                if !tool_fragments.is_empty() {
                    out.push(ChatEvent::ToolCalls(
                        tool_fragments
                            .iter()
                            .map(|(id, name, arguments)| ToolCall {
                                id: id.clone(),
                                name: name.clone(),
                                arguments: serde_json::from_str(arguments)
                                    .unwrap_or_else(|_| json!({ "raw": arguments })),
                            })
                            .collect(),
                    ));
                }
                return true;
            };
            if event.data.trim() == "[DONE]" {
                return false;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(&event.data) else {
                return true;
            };

            // Providers report the concrete model they served (alias resolution,
            // e.g. OpenRouter `:free` routing). `top_provider.model` is the real
            // backend; fall back to the response `model` field.
            if resolved.is_none() {
                let actual = chunk
                    .pointer("/top_provider/model")
                    .and_then(Value::as_str)
                    .or_else(|| chunk.get("model").and_then(Value::as_str));
                if let Some(model) = actual {
                    resolved = Some(model.to_string());
                    out.push(ChatEvent::ModelResolved(model.to_string()));
                }
            }

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
                // Native tool calls: fragments carry {index, id?, function{name?, arguments?}}.
                if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        while tool_fragments.len() <= index {
                            tool_fragments.push((String::new(), String::new(), String::new()));
                        }
                        let fragment = &mut tool_fragments[index];
                        if let Some(id) = call.get("id").and_then(Value::as_str) {
                            fragment.0 = id.to_string();
                        }
                        if let Some(name) = call
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                        {
                            if !name.is_empty() {
                                fragment.1 = name.to_string();
                            }
                        }
                        if let Some(arguments) = call
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                        {
                            fragment.2.push_str(arguments);
                        }
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
    ChatMessage::new(role, content)
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

    #[test]
    fn build_messages_serializes_native_tool_calls_and_results() {
        use crate::providers::{ToolCall, ToolChoice, ToolSpec};
        let mut assistant = message(Role::Assistant, "");
        assistant.tool_calls = vec![ToolCall {
            id: "call_1".into(),
            name: "fs_read".into(),
            arguments: json!({ "path": "a.rs" }),
        }];
        let mut result = message(Role::Tool, "file content");
        result.tool_call_id = Some("call_1".into());
        let request = ChatRequest {
            model: "gpt-4o".into(),
            messages: vec![message(Role::User, "read a.rs"), assistant, result],
            tools: vec![ToolSpec {
                name: "fs_read".into(),
                description: "read a file".into(),
                parameters: json!({ "type": "object" }),
            }],
            tool_choice: Some(ToolChoice::Auto),
            ..Default::default()
        };
        let wire = build_messages(&request);
        assert_eq!(wire[1]["tool_calls"][0]["id"], "call_1");
        assert_eq!(wire[1]["tool_calls"][0]["function"]["name"], "fs_read");
        assert_eq!(wire[1]["tool_calls"][0]["function"]["arguments"], r#"{"path":"a.rs"}"#);
        assert_eq!(wire[2]["role"], "tool");
        assert_eq!(wire[2]["tool_call_id"], "call_1");
        let tools = build_tools(&request).unwrap();
        assert_eq!(tools["tools"][0]["function"]["name"], "fs_read");
        assert_eq!(tools["tool_choice"], "auto");
    }

    #[test]
    fn tool_choice_named_and_none_serialize() {
        use crate::providers::{ToolChoice, ToolSpec};
        let spec = ToolSpec {
            name: "exec".into(),
            description: "run a command".into(),
            parameters: json!({ "type": "object" }),
        };
        let mut request = ChatRequest {
            model: "m".into(),
            messages: vec![],
            tools: vec![spec],
            ..Default::default()
        };
        request.tool_choice = Some(ToolChoice::Named("exec".into()));
        let tools = build_tools(&request).unwrap();
        assert_eq!(tools["tool_choice"]["function"]["name"], "exec");
        request.tool_choice = Some(ToolChoice::None);
        let tools = build_tools(&request).unwrap();
        assert_eq!(tools["tool_choice"], "none");
    }
}
