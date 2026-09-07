//! Google Gemini `streamGenerateContent` (SSE via `alt=sse`) + model listing.

use eventsource_stream::Eventsource;
use serde_json::{json, Value};

use super::{ChatEvent, ChatRequest, ChatStream, Provider, RemoteModel, Role, ToolCall, ToolChoice, ToolSpec};
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
                // Dynamic thinking: Gemini 2.5+ and 3.x. 2.5 exposes a budget
                // (single level); Gemini 3 exposes low/medium/high thinking_level.
                let id_lower = id.to_ascii_lowercase();
                let thinking_capable = id_lower.starts_with("gemini-2.5")
                    || id_lower.starts_with("gemini-3");
                models.push(RemoteModel {
                    id: id.to_string(),
                    display_name: item["displayName"].as_str().unwrap_or(id).to_string(),
                    supports_tools: None,
                    context_window: item.get("inputTokenLimit").and_then(Value::as_u64),
                    supports_reasoning: thinking_capable.then_some(true),
                    reasoning_options: if id_lower.starts_with("gemini-3") {
                        vec!["low".to_string(), "medium".to_string(), "high".to_string()]
                    } else {
                        Vec::new()
                    },
                });
            }
        }
        Ok(models)
    }

    async fn stream_chat(&self, request: ChatRequest) -> anyhow::Result<ChatStream> {
        let system: Vec<&str> = request
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .map(|message| message.content.as_str())
            .collect();
        // Native images: `inline_data` parts on the last user turn (the only
        // turn Gemini accepts them on).
        let images: Vec<(String, String)> = request
            .images
            .iter()
            .filter_map(|image| super::split_data_uri(&image.data_uri))
            .collect();
        let last_user = request
            .messages
            .iter()
            .rposition(|message| message.role == Role::User);
        let mut contents: Vec<Value> = Vec::new();
        for (index, message) in request.messages.iter().enumerate() {
            match message.role {
                Role::System => {}
                Role::Tool => {
                    // Gemini has no tool_use ids: results are matched by name.
                    contents.push(json!({
                        "role": "user",
                        "parts": [{
                            "functionResponse": {
                                "name": message.tool_call_id.as_deref().unwrap_or(""),
                                "response": { "output": message.content },
                            }
                        }],
                    }));
                }
                _ => {
                    let mut parts = vec![json!({ "text": message.content })];
                    if last_user == Some(index) {
                        for (mime, data) in &images {
                            parts.push(json!({ "inline_data": { "mime_type": mime, "data": data } }));
                        }
                    }
                    for call in &message.tool_calls {
                        parts.push(json!({
                            "functionCall": { "name": call.name, "args": call.arguments },
                        }));
                    }
                    contents.push(json!({
                        "role": if message.role == Role::Assistant { "model" } else { "user" },
                        "parts": parts,
                    }));
                }
            }
        }

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
        // Dynamic thinking: Gemini 3 uses thinking_level; Gemini 2.5 uses a
        // token budget (0 disables). Single-level 2.5 → default budget.
        if request.reasoning_enabled {
            let id_lower = request.model.to_ascii_lowercase();
            if id_lower.starts_with("gemini-3") {
                let level = match request.reasoning_effort.as_deref() {
                    Some("low") => "LOW",
                    Some("high") => "HIGH",
                    _ => "MEDIUM",
                };
                generation_config.insert(
                    "thinkingConfig".into(),
                    json!({ "thinkingLevel": level }),
                );
            } else {
                let budget = match request.reasoning_effort.as_deref() {
                    Some("low") => 2048,
                    Some("high") => 8192,
                    _ => 4096,
                };
                generation_config.insert(
                    "thinkingConfig".into(),
                    json!({ "thinkingBudget": budget }),
                );
            }
        }
        if !generation_config.is_empty() {
            body["generationConfig"] = Value::Object(generation_config);
        }
        // Native function calling.
        if !request.tools.is_empty() {
            body["tools"] = json!([{
                "functionDeclarations": request.tools.iter().map(|tool| json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                })).collect::<Vec<_>>(),
            }]);
            let calling_config = match &request.tool_choice {
                None | Some(ToolChoice::Auto) => json!({ "mode": "AUTO" }),
                Some(ToolChoice::None) => json!({ "mode": "NONE" }),
                Some(ToolChoice::Named(name)) => {
                    json!({ "mode": "ANY", "allowedFunctionNames": [name] })
                }
            };
            body["toolConfig"] = json!({ "functionCallingConfig": calling_config });
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
        let mut resolved: Option<String> = None;
        // Gemini sends whole `functionCall` parts (no id, no fragments); they are
        // flushed once as ChatEvent::ToolCalls at stream end. The call id is the
        // function name (Gemini has none), so tool results can be matched back.
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        Ok(super::stream_util::sse_events(source, move |event, out| {
            let Some(event) = event else {
                if let Some((tokens_in, tokens_out)) = usage {
                    out.push(ChatEvent::Usage { tokens_in, tokens_out });
                }
                if !tool_calls.is_empty() {
                    out.push(ChatEvent::ToolCalls(std::mem::take(&mut tool_calls)));
                }
                return true;
            };
            let Ok(chunk) = serde_json::from_str::<Value>(&event.data) else { return true };
            if resolved.is_none() {
                // Concrete model actually served (e.g. `gemini-3-flash` when a
                // `-preview` alias was requested).
                let actual = chunk
                    .pointer("/candidates/0/modelVersion")
                    .and_then(Value::as_str)
                    .or_else(|| chunk.pointer("/responseMetadata/model").and_then(Value::as_str));
                if let Some(model) = actual {
                    resolved = Some(model.to_string());
                    out.push(ChatEvent::ModelResolved(model.to_string()));
                }
            }
            if let Some(error) = chunk.get("error") {
                let detail = error["message"].as_str().unwrap_or("unknown error").to_string();
                out.push(ChatEvent::Error { detail });
                return false;
            }
            if let Some(parts) = chunk.pointer("/candidates/0/content/parts").and_then(Value::as_array) {
                for part in parts {
                    if let Some(call) = part.get("functionCall") {
                        if let Some(name) = call.get("name").and_then(Value::as_str) {
                            tool_calls.push(ToolCall {
                                id: name.to_string(),
                                name: name.to_string(),
                                arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
                            });
                        }
                        continue;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse as _;
    use axum::{extract::State, routing::post, Router};
    use std::sync::{Arc, Mutex};

    fn request_with_photo() -> ChatRequest {
        ChatRequest {
            model: "gemini-2.0-flash".into(),
            messages: vec![
                super::super::ChatMessage {
                    role: super::super::Role::System,
                    content: "sen yardımcısın".into(),
                    ..Default::default()
                },
                super::super::ChatMessage {
                    role: super::super::Role::User,
                    content: "bu ne?".into(),
                    ..Default::default()
                },
            ],
            images: vec![super::super::InputImage {
                data_uri: "data:image/png;base64,QUJD".into(),
            }],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn images_become_inline_data_on_the_last_user_turn() {
        let captured: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&captured);
        let app = Router::new()
            .route(
                // Axum 0.8 rejects a parameter mixed with literal text in one
                // segment, so use a literal route for the model under test.
                "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
                post(
                    |State(state): State<Arc<Mutex<Option<Value>>>>,
                     axum::Json(body): axum::Json<Value>| async move {
                        *state.lock().unwrap() = Some(body);
                        // Empty SSE stream (only the terminal flush matters here).
                        ([(axum::http::header::CONTENT_TYPE, "text/event-stream")], "")
                            .into_response()
                    },
                ),
            )
            .with_state(sink);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let provider = Gemini::new(Some(&format!("http://{addr}")), Some("key")).unwrap();
        let _stream = provider.stream_chat(request_with_photo()).await.unwrap();
        let body = captured.lock().unwrap().clone().expect("request captured");

        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
        let parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["text"], "bu ne?");
        assert_eq!(parts[1]["inline_data"]["mime_type"], "image/png");
        assert_eq!(parts[1]["inline_data"]["data"], "QUJD");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "sen yardımcısın");
    }

    #[test]
    fn split_data_uri_matches_native_shape() {
        let (mime, data) = super::super::split_data_uri("data:image/jpeg;base64,MTIz").unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(data, "MTIz");
        assert!(super::super::split_data_uri("no-uri").is_none());
    }
}
