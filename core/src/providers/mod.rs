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

use futures_util::stream::BoxStream;

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
}

/// A base64-encoded image attachment (`data:{mime};base64,{data}`).
#[derive(Debug, Clone)]
pub struct InputImage {
    pub data_uri: String,
}

/// Normalized streaming events. `Error` carries a mid-stream failure (connection
/// dropped etc.) — the engine decides how much partial content to keep.
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

/// Builds the right provider for a configured row. `api_key` comes from the secret
/// store, not the database.
pub fn build(
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

/// HTTP client shared settings; `no TLS` cases (local servers) work everywhere.
pub fn http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
}
