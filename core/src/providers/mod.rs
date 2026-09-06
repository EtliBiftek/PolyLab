//! Provider layer (plan §5.1): one trait, one implementation per wire protocol.
//!
//! `openai_compat` covers OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI, LM Studio,
//! Ollama (`/v1`) and Custom. Anthropic, Gemini and Ollama-native have their own
//! implementations. Native reasoning is normalized by `reasoning`.

pub mod anthropic;
pub mod gemini;
pub mod ollama_native;
pub mod openai_compat;
pub mod reasoning;
pub mod stream_util;

use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::storage::ProviderKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Vision attachments (data URIs). OpenAI-compatible providers attach them as
    /// image_url content parts on the final user turn; other providers ignore them.
    pub images: Vec<InputImage>,
    /// Web search for this turn (OpenRouter `web` plugin; ignored elsewhere).
    pub web: bool,
}

#[derive(Debug, Clone)]
pub struct InputImage {
    pub data_uri: String,
}

/// Splits `data:{mime};base64,{data}` into `(mime_type, base64)`; the native
/// Gemini/Anthropic payloads need them separately (OpenAI-compatible sends the
/// whole URI as `image_url.url`).
pub(crate) fn split_data_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    if mime.is_empty() || payload.is_empty() {
        return None;
    }
    Some((mime.to_string(), payload.to_string()))
}

#[derive(Debug, Clone)]
pub enum ChatEvent {
    TextDelta(String),
    ReasoningDelta(String),
    Usage { tokens_in: u64, tokens_out: u64 },
    Error { detail: String },
}

#[derive(Debug, Clone)]
pub struct RemoteModel {
    pub id: String,
    pub display_name: String,
    pub supports_tools: Option<bool>,
    pub context_window: Option<u64>,
}

pub type ChatStream = BoxStream<'static, ChatEvent>;

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn list_models(&self) -> anyhow::Result<Vec<RemoteModel>>;
    async fn stream_chat(&self, req: ChatRequest) -> anyhow::Result<ChatStream>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeyBundle {
    __polylab_keys: bool,
    keys: Vec<String>,
}

/// Encodes multiple provider API keys into the existing secret-store value.
pub fn encode_key_bundle(keys: &[String]) -> anyhow::Result<String> {
    serde_json::to_string(&KeyBundle {
        __polylab_keys: true,
        keys: keys.iter().filter(|key| !key.trim().is_empty()).cloned().collect(),
    })
    .map_err(Into::into)
}

fn decode_key_bundle(value: &str) -> Option<Vec<String>> {
    let bundle = serde_json::from_str::<KeyBundle>(value).ok()?;
    if !bundle.__polylab_keys {
        return None;
    }
    Some(
        bundle
            .keys
            .into_iter()
            .filter(|key| !key.trim().is_empty())
            .collect(),
    )
}

/// Builds the configured provider. When the secret-store value is a key bundle,
/// the returned provider automatically retries the same model on the next key if
/// connection/setup or streaming fails.
pub fn build(
    kind: ProviderKind,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> anyhow::Result<Box<dyn Provider>> {
    if let Some(raw) = api_key {
        if let Some(keys) = decode_key_bundle(raw) {
            return Ok(Box::new(FallbackProvider {
                kind,
                base_url: base_url.map(str::to_string),
                keys,
            }));
        }
    }
    build_one(kind, base_url, api_key)
}

fn build_one(
    kind: ProviderKind,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> anyhow::Result<Box<dyn Provider>> {
    Ok(match kind {
        ProviderKind::Anthropic => Box::new(anthropic::Anthropic::new(base_url, api_key)?),
        ProviderKind::Gemini => Box::new(gemini::Gemini::new(base_url, api_key)?),
        ProviderKind::Ollama => Box::new(ollama_native::OllamaNative::new(base_url)?),
        _ => Box::new(openai_compat::OpenAiCompat::new(kind, base_url, api_key)?),
    })
}

struct FallbackProvider {
    kind: ProviderKind,
    base_url: Option<String>,
    keys: Vec<String>,
}

#[async_trait::async_trait]
impl Provider for FallbackProvider {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    async fn list_models(&self) -> anyhow::Result<Vec<RemoteModel>> {
        if self.keys.is_empty() {
            return build_one(self.kind, self.base_url.as_deref(), None)?.list_models().await;
        }
        let mut last_error = None;
        for key in &self.keys {
            match build_one(self.kind, self.base_url.as_deref(), Some(key.as_str())) {
                Ok(provider) => match provider.list_models().await {
                    Ok(models) => return Ok(models),
                    Err(error) => last_error = Some(error),
                },
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no provider API keys configured")))
    }

    async fn stream_chat(&self, req: ChatRequest) -> anyhow::Result<ChatStream> {
        let state = FallbackStreamState {
            kind: self.kind,
            base_url: self.base_url.clone(),
            keys: self.keys.clone(),
            key_index: 0,
            request: req,
            stream: None,
            partial: String::new(),
            done: false,
        };
        Ok(Box::pin(stream::unfold(state, |mut state| async move {
            loop {
                if state.done {
                    return None;
                }

                if state.stream.is_none() {
                    let key = state.keys.get(state.key_index).map(String::as_str);
                    match build_one(state.kind, state.base_url.as_deref(), key) {
                        Ok(provider) => match provider.stream_chat(state.request.clone()).await {
                            Ok(stream) => state.stream = Some(stream),
                            Err(error) => {
                                if !advance_fallback(&mut state) {
                                    state.done = true;
                                    return Some((ChatEvent::Error { detail: error.to_string() }, state));
                                }
                                continue;
                            }
                        },
                        Err(error) => {
                            if !advance_fallback(&mut state) {
                                state.done = true;
                                return Some((ChatEvent::Error { detail: error.to_string() }, state));
                            }
                            continue;
                        }
                    }
                }

                let inner = state.stream.as_mut().expect("fallback stream initialized");
                match inner.next().await {
                    Some(ChatEvent::TextDelta(delta)) => {
                        state.partial.push_str(&delta);
                        return Some((ChatEvent::TextDelta(delta), state));
                    }
                    Some(ChatEvent::ReasoningDelta(delta)) => {
                        return Some((ChatEvent::ReasoningDelta(delta), state));
                    }
                    Some(ChatEvent::Usage { tokens_in, tokens_out }) => {
                        return Some((ChatEvent::Usage { tokens_in, tokens_out }, state));
                    }
                    Some(ChatEvent::Error { detail }) => {
                        state.stream = None;
                        if !advance_fallback(&mut state) {
                            state.done = true;
                            return Some((ChatEvent::Error { detail }, state));
                        }
                    }
                    None => {
                        // Stream ended without an error; `done` already governs the
                        // outer loop, so returning `None` (and dropping `state`) is
                        // the correct terminal condition.
                        return None;
                    }
                }
            }
        })))
    }
}

struct FallbackStreamState {
    kind: ProviderKind,
    base_url: Option<String>,
    keys: Vec<String>,
    key_index: usize,
    request: ChatRequest,
    stream: Option<ChatStream>,
    partial: String,
    done: bool,
}

fn advance_fallback(state: &mut FallbackStreamState) -> bool {
    if state.key_index + 1 >= state.keys.len() {
        return false;
    }
    state.key_index += 1;
    if !state.partial.trim().is_empty() {
        state.request.messages.push(ChatMessage {
            role: Role::Assistant,
            content: state.partial.clone(),
        });
        state.request.messages.push(ChatMessage {
            role: Role::User,
            content: "Continue the previous response from exactly where it stopped. Do not repeat text that is already present.".into(),
        });
    }
    true
}

pub fn http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
}
