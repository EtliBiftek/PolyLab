//! Chat engine (Phase 1: single model). Owns a run per conversation: builds the
//! prompt, streams from the provider, persists partial results, and broadcasts
//! events on the hub. Cancellation is cooperative via `CancellationToken`.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{broadcast, Mutex};
use tokio_util::sync::CancellationToken;

use crate::agent;
use crate::events::{AttachmentIn, ChatMode, ErrorCode, MessageStatus, ServerEvent};
use crate::prompts::PromptLibrary;
use crate::providers::{self, ChatEvent, ChatMessage, ChatRequest, Role};
use crate::secrets::{provider_key, SecretStore};
use crate::storage::{self, Conversation, ModelRow, ProviderRow};
use crate::tokens::{estimate, Usage};

/// Cap how much history is replayed to the model (Phase 7 adds smarter trimming).
const MAX_HISTORY_MESSAGES: usize = 40;
/// Messages shorter than this are dropped from the assistant context (UI events).
const AUTO_TITLE_MAX_CHARS: usize = 40;
/// Soft token budget for replayed history (newest-first until exceeded).
pub const HISTORY_TOKEN_BUDGET: u64 = 16_000;

pub struct ChatEngine {
    db: SqlitePool,
    hub: broadcast::Sender<String>,
    prompts: Arc<PromptLibrary>,
    secrets: Arc<dyn SecretStore>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
    /// Pending agent approvals: id → oneshot verdict sender.
    approvals: agent::Approvals,
}

impl ChatEngine {
    pub fn new(
        db: SqlitePool,
        hub: broadcast::Sender<String>,
        prompts: Arc<PromptLibrary>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            db,
            hub,
            prompts,
            secrets,
            cancels: Mutex::new(HashMap::new()),
            approvals: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Answers a pending `agent_approval_request`.
    pub fn resolve_approval(&self, approval_id: &str, approved: bool) {
        if let Some(sender) = self.approvals.lock().unwrap().remove(approval_id) {
            let _ = sender.send(approved);
        }
    }

    fn emit(&self, event: ServerEvent) {
        // A closed receiver just means nobody is watching; the run continues.
        let _ = self.hub.send(event.to_json());
    }

    pub async fn cancel(&self, conversation_id: &str) {
        let guard = self.cancels.lock().await;
        if let Some(token) = guard.get(conversation_id) {
            token.cancel();
        }
    }

    /// Entry point for `send_message`. Spawns the run so the WS loop stays free.
    pub fn dispatch_send(
        self: &Arc<Self>,
        conversation_id: String,
        content: String,
        attachments: Vec<AttachmentIn>,
        web: bool,
    ) {
        let engine = Arc::clone(self);
        tokio::spawn(async move { engine.run(conversation_id, content, attachments, web).await });
    }

    /// Synchronous variant used by tests and future internal callers.
    pub async fn send_message(&self, conversation_id: String, content: String) {
        self.run(conversation_id, content, Vec::new(), false).await;
    }

    async fn run(&self, conversation_id: String, content: String, attachments: Vec<AttachmentIn>, web: bool) {
        let token = CancellationToken::new();
        {
            let mut cancels = self.cancels.lock().await;
            if cancels.contains_key(&conversation_id) {
                self.emit(ServerEvent::Error {
                    conversation_id: Some(conversation_id.clone()),
                    message_id: None,
                    code: ErrorCode::BadRequest,
                    detail: "this conversation is already generating".into(),
                });
                return;
            }
            cancels.insert(conversation_id.clone(), token.clone());
        }

        self.run_guarded(conversation_id.clone(), content, attachments, web, token).await;

        self.cancels.lock().await.remove(&conversation_id);
    }

    async fn run_guarded(
        &self,
        conversation_id: String,
        content: String,
        attachments: Vec<AttachmentIn>,
        web: bool,
        cancel: CancellationToken,
    ) {
        match self.run_inner(&conversation_id, content, attachments, web, cancel).await {
            Ok(()) => {}
            Err(error) => {
                tracing::error!(%error, conversation_id, "send_message failed");
                self.emit(ServerEvent::Error {
                    conversation_id: Some(conversation_id),
                    message_id: None,
                    code: ErrorCode::Internal,
                    detail: error.to_string(),
                });
            }
        }
    }

    async fn run_inner(
        &self,
        conversation_id: &str,
        content: String,
        attachments: Vec<AttachmentIn>,
        web: bool,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let conversation: Conversation = sqlx::query_as(
            "SELECT * FROM conversations WHERE id = ?",
        )
        .bind(conversation_id)
        .fetch_optional(&self.db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("conversation {conversation_id} not found"))?;

        // --- persist the user message -----------------------------------------
        let user_message_id = uuid::Uuid::new_v4().to_string();
        let now = storage::now_rfc3339();
        // Persist attachment metadata (name/mime/text; base64 data for images) so
        // history reloads can re-render the attachment chips (MessageItem).
        let attachments_json = if attachments.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&attachments)?)
        };
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at)
             VALUES (?, ?, 'user', ?, ?, ?)",
        )
        .bind(&user_message_id)
        .bind(conversation_id)
        .bind(&content)
        .bind(&attachments_json)
        .bind(&now)
        .execute(&self.db)
        .await?;

        // Auto-title from the first user message (cheap; a model-generated title can
        // replace it later).
        if conversation.title.as_deref().unwrap_or("").is_empty() {
            let title: String = content.chars().take(AUTO_TITLE_MAX_CHARS).collect();
            sqlx::query(
                "UPDATE conversations SET title = ?, auto_title = 1, updated_at = ? WHERE id = ?",
            )
            .bind(title.trim().to_string())
            .bind(&now)
            .bind(conversation_id)
            .execute(&self.db)
            .await?;
        }

        self.reply(conversation, content, attachments, web, None, cancel).await
    }

    /// Entry point for `edit_message`: replaces the stored user message,
    /// drops every later message and regenerates the reply.
    pub fn dispatch_edit(
        self: &Arc<Self>,
        conversation_id: String,
        message_id: String,
        content: String,
        quote: bool,
        web: bool,
    ) {
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            engine.run_edit(conversation_id, message_id, content, quote, web).await;
        });
    }

    async fn run_edit(
        &self,
        conversation_id: String,
        message_id: String,
        content: String,
        quote: bool,
        web: bool,
    ) {
        let token = CancellationToken::new();
        {
            let mut cancels = self.cancels.lock().await;
            if cancels.contains_key(&conversation_id) {
                self.emit(ServerEvent::Error {
                    conversation_id: Some(conversation_id.clone()),
                    message_id: Some(message_id.clone()),
                    code: ErrorCode::BadRequest,
                    detail: "this conversation is already generating".into(),
                });
                return;
            }
            cancels.insert(conversation_id.clone(), token.clone());
        }
        if let Err(error) = self
            .edit_inner(&conversation_id, &message_id, &content, quote, web, token.clone())
            .await
        {
            tracing::error!(%error, conversation_id, "edit_message failed");
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation_id.clone()),
                message_id: Some(message_id.clone()),
                code: ErrorCode::Internal,
                detail: error.to_string(),
            });
        }
        self.cancels.lock().await.remove(&conversation_id);
    }

    async fn edit_inner(
        &self,
        conversation_id: &str,
        message_id: &str,
        content: &str,
        quote: bool,
        web: bool,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        if content.trim().is_empty() {
            anyhow::bail!("message content is empty");
        }
        let conversation: Conversation = sqlx::query_as(
            "SELECT * FROM conversations WHERE id = ?",
        )
        .bind(conversation_id)
        .fetch_optional(&self.db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("conversation {conversation_id} not found"))?;

        // The target must be a user message in this conversation.
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT content, attachments_json FROM messages
             WHERE id = ? AND conversation_id = ? AND role = 'user'",
        )
        .bind(message_id)
        .bind(conversation_id)
        .fetch_optional(&self.db)
        .await?;
        let Some((old_content, attachments_json)) = row else {
            anyhow::bail!("message {message_id} is not an editable user message");
        };

        sqlx::query("UPDATE messages SET content = ? WHERE id = ?")
            .bind(content)
            .bind(message_id)
            .execute(&self.db)
            .await?;
        // Drop everything after the edited turn (debates cascade via FK).
        sqlx::query(
            "DELETE FROM messages WHERE conversation_id = ? AND rowid >
                (SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?)",
        )
        .bind(conversation_id)
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.db)
        .await?;
        // agent_steps has no FK cascade: drop orphaned steps (debates cascade).
        sqlx::query(
            "DELETE FROM agent_steps WHERE conversation_id = ? AND
                message_id NOT IN (SELECT id FROM messages WHERE conversation_id = ?)",
        )
        .bind(conversation_id)
        .bind(conversation_id)
        .execute(&self.db)
        .await?;

        let attachments: Vec<AttachmentIn> = attachments_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default();
        let quote_old = if quote { Some(old_content) } else { None };
        self.reply(conversation, content.to_string(), attachments, web, quote_old, cancel)
            .await
    }

    /// Entry point for `regenerate`: drops the assistant message and everything
    /// after it, optionally switches the conversation to another model and
    /// re-runs the reply for the preceding user message.
    pub fn dispatch_regenerate(
        self: &Arc<Self>,
        conversation_id: String,
        message_id: String,
        model_id: Option<String>,
    ) {
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            engine.run_regenerate(conversation_id, message_id, model_id).await;
        });
    }

    async fn run_regenerate(
        &self,
        conversation_id: String,
        message_id: String,
        model_id: Option<String>,
    ) {
        let token = CancellationToken::new();
        {
            let mut cancels = self.cancels.lock().await;
            if cancels.contains_key(&conversation_id) {
                self.emit(ServerEvent::Error {
                    conversation_id: Some(conversation_id.clone()),
                    message_id: Some(message_id.clone()),
                    code: ErrorCode::BadRequest,
                    detail: "this conversation is already generating".into(),
                });
                return;
            }
            cancels.insert(conversation_id.clone(), token.clone());
        }
        if let Err(error) = self
            .regenerate_inner(&conversation_id, &message_id, model_id, token.clone())
            .await
        {
            tracing::error!(%error, conversation_id, "regenerate failed");
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation_id.clone()),
                message_id: Some(message_id.clone()),
                code: ErrorCode::Internal,
                detail: error.to_string(),
            });
        }
        self.cancels.lock().await.remove(&conversation_id);
    }

    async fn regenerate_inner(
        &self,
        conversation_id: &str,
        message_id: &str,
        model_id: Option<String>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let exists: Option<String> = sqlx::query_scalar(
            "SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'",
        )
        .bind(message_id)
        .bind(conversation_id)
        .fetch_optional(&self.db)
        .await?;
        if exists.is_none() {
            anyhow::bail!("message {message_id} is not a regenerable assistant message");
        }
        sqlx::query(
            "DELETE FROM messages WHERE conversation_id = ? AND rowid >=
                (SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?)",
        )
        .bind(conversation_id)
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.db)
        .await?;
        // agent_steps has no FK cascade: drop orphaned steps (debates cascade).
        sqlx::query(
            "DELETE FROM agent_steps WHERE conversation_id = ? AND
                message_id NOT IN (SELECT id FROM messages WHERE conversation_id = ?)",
        )
        .bind(conversation_id)
        .bind(conversation_id)
        .execute(&self.db)
        .await?;

        let mut conversation: Conversation = sqlx::query_as(
            "SELECT * FROM conversations WHERE id = ?",
        )
        .bind(conversation_id)
        .fetch_optional(&self.db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("conversation {conversation_id} not found"))?;

        if let Some(model_id) = model_id {
            let model_exists: Option<String> =
                sqlx::query_scalar("SELECT id FROM models WHERE id = ? AND enabled = 1")
                    .bind(&model_id)
                    .fetch_optional(&self.db)
                    .await?;
            if model_exists.is_none() {
                anyhow::bail!("model {model_id} is not available");
            }
            // A group message regenerated with a chosen model becomes single.
            sqlx::query(
                "UPDATE conversations SET model_id = ?, selection_type = 'single',
                        group_id = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(&model_id)
            .bind(storage::now_rfc3339())
            .bind(conversation_id)
            .execute(&self.db)
            .await?;
            conversation = sqlx::query_as("SELECT * FROM conversations WHERE id = ?")
                .bind(conversation_id)
                .fetch_optional(&self.db)
                .await?
                .ok_or_else(|| anyhow::anyhow!("conversation {conversation_id} not found"))?;
        }

        // Reply to the last stored user message.
        let last_user: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT content, attachments_json FROM messages
             WHERE conversation_id = ? AND role = 'user'
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_optional(&self.db)
        .await?;
        let Some((content, attachments_json)) = last_user else {
            anyhow::bail!("no user message to reply to");
        };
        let attachments: Vec<AttachmentIn> = attachments_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default();
        self.reply(conversation, content, attachments, false, None, cancel)
            .await
    }

    /// Generates the assistant reply for an ALREADY STORED turn (send, edit and
    /// regenerate converge here). `quote_old` is the user message's previous
    /// content, injected into the model request when an edit is quoted — the
    /// stored message keeps only the edited text.
    #[allow(clippy::too_many_arguments)]
    async fn reply(
        &self,
        conversation: Conversation,
        content: String,
        attachments: Vec<AttachmentIn>,
        web: bool,
        quote_old: Option<String>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let conversation_id = conversation.id.clone();
        let now = storage::now_rfc3339();
        // --- group send → debate engine (plan §5.2) -----------------------------
        if conversation.selection_type == "group" {
            return self.run_debate(conversation, web, quote_old, cancel).await;
        }
        // --- race send: same prompt to N models in parallel (side-by-side) ------
        if conversation.selection_type == "race" {
            return self.run_race(conversation, attachments, web, quote_old, cancel).await;
        }

        let model_id = conversation
            .model_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("no model selected for this conversation"))?;
        let model: ModelRow = sqlx::query_as("SELECT * FROM models WHERE id = ? AND enabled = 1")
            .bind(&model_id)
            .fetch_optional(&self.db)
            .await?
            .ok_or_else(|| anyhow::anyhow!("model {model_id} is not available"))?;
        // Backup model for automatic failover (single chat only).
        let fallback_model: Option<ModelRow> = match conversation.fallback_model_id.as_deref() {
            Some(id) if id != model.id => {
                sqlx::query_as("SELECT * FROM models WHERE id = ? AND enabled = 1")
                    .bind(id)
                    .fetch_optional(&self.db)
                    .await?
            }
            _ => None,
        };
        let provider: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
            .bind(&model.provider_id)
            .fetch_one(&self.db)
            .await?;
        let kind = storage::ProviderKind::from_str_loose(&provider.kind)
            .ok_or_else(|| anyhow::anyhow!("unknown provider kind {}", provider.kind))?;
        let api_key = self
            .secrets
            .get(&provider_key(&provider.id))
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "secret store read failed; continuing without key");
                None
            });

        // Coding mode (single model) → tool-using agent (plan §5.3).
        if conversation.mode == "coding" {
            let provider_impl =
                providers::build(kind, provider.base_url.as_deref(), api_key.as_deref())?;
            let history: Vec<(String, String)> = sqlx::query_as(
                "SELECT role, content FROM messages
                 WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
            )
            .bind(&conversation_id)
            .fetch_all(&self.db)
            .await?;
            let mut history: Vec<ChatMessage> = history
                .into_iter()
                .map(|(role, content)| ChatMessage {
                    role: match role.as_str() {
                        "assistant" => Role::Assistant,
                        _ => Role::User,
                    },
                    content,
                    ..Default::default()
                })
                .collect();
            // Web search + edit quote apply to the agent too (point 3/4: all
            // models, every mode — the agent reads the injected user turn).
            if web || quote_old.is_some() {
                if let Some(last_user) = history
                    .iter_mut()
                    .rev()
                    .find(|message| matches!(message.role, Role::User))
                {
                    if web {
                        let results = crate::search::search(&content).await;
                        last_user.content.push_str(&format!(
                            "\n\n# Web arama sonuçları\n{}\n\nBu sonuçları kullanarak soruyu cevapla ve kaynaklara atıf yap.",
                            crate::search::format_results(&content, &results)
                        ));
                    }
                    if let Some(quote) = quote_old.as_deref() {
                        last_user.content.push_str(&format!(
                            "\n\n# Alıntılanan önceki mesaj\n{quote}\n\nBu mesaj düzenlendi. Alıntılanan önceki haliyle birlikte düzenlenmiş mesaja odaklanarak cevap ver."
                        ));
                    }
                }
            }
            let history = crate::trim_history(history, HISTORY_TOKEN_BUDGET);
            return agent::run_agent(
                &self.db,
                self.hub.clone(),
                self.prompts.get("agent"),
                &conversation,
                &model,
                provider_impl.as_ref(),
                &history,
                &content,
                cancel,
                self.approvals.clone(),
            )
            .await;
        }

        // --- build the request --------------------------------------------------
        let base_prompt = if conversation.mode == "coding" {
            self.prompts.get("coding")
        } else {
            self.prompts.get("chat")
        };
        let mut system = vec![
            base_prompt.to_string(),
            crate::prompts::capability_notice().to_string(),
        ];
        if let Some(extra) = model.system_prompt_override.as_deref().filter(|s| !s.trim().is_empty()) {
            system.push(extra.to_string());
        }
        // Web search is engine-side DuckDuckGo (all providers): the engine runs
        // the search and injects the results, so the model never needs its own
        // browsing. The injected block is visible only in this request; the
        // stored user message keeps the plain text.
        let mut web_results = String::new();
        if web {
            let results = crate::search::search(&content).await;
            web_results = crate::search::format_results(&content, &results);
        }

        let history: Vec<(String, String)> = sqlx::query_as(
            "SELECT role, content FROM messages
             WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(&conversation_id)
        .fetch_all(&self.db)
        .await?;

        let mut messages = vec![
            ChatMessage { role: Role::System, content: system.join("\n\n"), ..Default::default() },
        ];
        for (role, text) in history.into_iter().rev().take(MAX_HISTORY_MESSAGES).rev() {
            let role = match role.as_str() {
                "assistant" => Role::Assistant,
                _ => Role::User,
            };
            messages.push(ChatMessage { role, content: text, ..Default::default() });
        }
        let mut images: Vec<providers::InputImage> = Vec::new();
        if !attachments.is_empty() {
            if let Some(last_user) = messages
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                for attachment in &attachments {
                    if let Some(data_uri) = attachment.data_uri() {
                        // Images travel as vision content parts, not prompt text.
                        images.push(providers::InputImage { data_uri });
                    } else {
                        last_user.content.push_str(&format!(
                            "\n\n[Dosya eki: {}]\n{}",
                            attachment.name, attachment.text
                        ));
                    }
                }
            }
        }
        // Engine-side web search: inject DuckDuckGo results into the current
        // user turn (works on every provider; no provider plugin needed).
        if !web_results.is_empty() {
            if let Some(last_user) = messages
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                last_user.content.push_str(&format!(
                    "\n\n# Web arama sonuçları\n{web_results}\n\nBu sonuçları kullanarak soruyu cevapla ve kaynaklara atıf yap."
                ));
            }
        }
        // Edited message: quote the previous version so the model focuses on it.
        if let Some(quote) = quote_old {
            if let Some(last_user) = messages
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                last_user.content.push_str(&format!(
                    "\n\n# Alıntılanan önceki mesaj\n{quote}\n\nBu mesaj düzenlendi. Alıntılanan önceki haliyle birlikte düzenlenmiş mesaja odaklanarak cevap ver."
                ));
            }
        }
        // Think (reasoning) toggle: explicit per-model choice, else follow the
        // capability flag. When off, reasoning deltas are dropped (not shown, not
        // stored) and no native thinking parameter is sent.
        let think_mode = model.reasoning_enabled.unwrap_or(model.supports_reasoning);
        let provider_impl = providers::build(kind, provider.base_url.as_deref(), api_key.as_deref())?;
        // Long conversations: summarize the oldest part instead of silently
        // dropping it (best effort — the plain trim remains as a safety net).
        let messages = self
            .summarize_overflow(messages, provider_impl.as_ref(), &model, &cancel)
            .await?;
        let history_budget_tokens = HISTORY_TOKEN_BUDGET;
        let messages = crate::trim_history(messages, history_budget_tokens);
        let request = ChatRequest {
            model: model.model_id.clone(),
            messages,
            temperature: model.temperature.map(|t| t as f32),
            max_tokens: model.max_tokens.map(|t| t as u32),
            images,
            web,
            reasoning_enabled: think_mode,
            reasoning_effort: if think_mode {
                model.reasoning_effort.clone().or_else(|| Some("medium".to_string()))
            } else {
                None
            },
            tools: Vec::new(),
            tool_choice: None,
        };

        // --- assistant row + start event ---------------------------------------
        let message_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, content, model_id, created_at)
             VALUES (?, ?, 'assistant', '', ?, ?)",
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&model.id)
        .bind(&now)
        .execute(&self.db)
        .await?;

        self.emit(ServerEvent::MessageStart {
            conversation_id: conversation_id.clone(),
            message_id: message_id.clone(),
            model_id: model.id.clone(),
            mode: ChatMode::Single,
            race_id: None,
        });

        // --- stream (primary model, automatic failover) ---------------------------
        let prompt_texts: Vec<String> = request.messages.iter().map(|m| m.content.clone()).collect();
        let retry_request = request.clone();
        let mut active_provider: Box<dyn providers::Provider> = provider_impl;
        let mut active_model: &ModelRow = &model;
        let mut result = self
            .stream_single(&message_id, &conversation_id, &model, active_provider.as_ref(), request, &cancel)
            .await;
        if result.text.is_empty() && result.error.is_some() {
            if let Some(fallback) = fallback_model.as_ref() {
                let fallback_provider_row: ProviderRow =
                    sqlx::query_as("SELECT * FROM providers WHERE id = ?")
                        .bind(&fallback.provider_id)
                        .fetch_one(&self.db)
                        .await?;
                let fallback_kind = storage::ProviderKind::from_str_loose(&fallback_provider_row.kind)
                    .ok_or_else(|| anyhow::anyhow!("unknown provider kind {}", fallback_provider_row.kind))?;
                let fallback_key = self
                    .secrets
                    .get(&provider_key(&fallback_provider_row.id))
                    .unwrap_or_else(|error| {
                        tracing::warn!(%error, "secret store read failed; continuing without key");
                        None
                    });
                let fallback_provider = providers::build(
                    fallback_kind,
                    fallback_provider_row.base_url.as_deref(),
                    fallback_key.as_deref(),
                )?;
                let fallback_think =
                    fallback.reasoning_enabled.unwrap_or(fallback.supports_reasoning);
                let mut fallback_request = retry_request;
                fallback_request.model = fallback.model_id.clone();
                fallback_request.temperature = fallback.temperature.map(|t| t as f32);
                fallback_request.max_tokens = fallback.max_tokens.map(|t| t as u32);
                fallback_request.reasoning_enabled = fallback_think;
                fallback_request.reasoning_effort = if fallback_think {
                    fallback.reasoning_effort.clone().or_else(|| Some("medium".to_string()))
                } else {
                    None
                };
                self.emit(ServerEvent::FallbackUsed {
                    conversation_id: conversation_id.clone(),
                    message_id: message_id.clone(),
                    from_model: model.id.clone(),
                    to_model: fallback.id.clone(),
                    detail: format!(
                        "{} kullanılamadı ({}) — {} devreye girdi",
                        model.display_name,
                        result.error.as_deref().unwrap_or("bilinmeyen hata"),
                        fallback.display_name
                    ),
                });
                // The persisted row belongs to the model that actually answered;
                // remember which model it fell back from for the UI badge.
                sqlx::query("UPDATE messages SET model_id = ?, fallback_from_model_id = ? WHERE id = ?")
                    .bind(&fallback.id)
                    .bind(&model.id)
                    .bind(&message_id)
                    .execute(&self.db)
                    .await?;
                active_provider = fallback_provider;
                active_model = fallback;
                result = self
                    .stream_single(
                        &message_id,
                        &conversation_id,
                        fallback,
                        active_provider.as_ref(),
                        fallback_request,
                        &cancel,
                    )
                    .await;
            }
        }

        // --- usage (estimate when the provider did not report) --------------------
        let usage = result.usage.unwrap_or_else(|| Usage {
            tokens_in: crate::tokens::estimate_prompt(&prompt_texts),
            tokens_out: estimate(&result.text),
            estimated: true,
        });

        // --- persist --------------------------------------------------------------
        let status = if result.cancelled {
            MessageStatus::Cancelled
        } else if result.error.is_some() {
            MessageStatus::Error
        } else {
            MessageStatus::Done
        };
        let finished_at = storage::now_rfc3339();
        sqlx::query(
            "UPDATE messages SET content = ?, reasoning = ?, tokens_in = ?, tokens_out = ?,
                    tokens_estimated = ?, resolved_model = ? WHERE id = ?",
        )
        .bind(&result.text)
        .bind(&result.reasoning)
        .bind(usage.tokens_in as i64)
        .bind(usage.tokens_out as i64)
        .bind(usage.estimated)
        .bind(&result.resolved_model)
        .bind(&message_id)
        .execute(&self.db)
        .await?;
        sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
            .bind(&finished_at)
            .bind(&conversation_id)
            .execute(&self.db)
            .await?;

        self.emit(ServerEvent::Usage {
            conversation_id: conversation_id.clone(),
            message_id: message_id.clone(),
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            estimated: usage.estimated,
        });
        if let Some(detail) = result.error {
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation_id.clone()),
                message_id: Some(message_id.clone()),
                code: ErrorCode::ProviderError,
                detail,
            });
        }
        self.emit(ServerEvent::MessageDone {
            conversation_id: conversation_id.clone(),
            message_id,
            status,
        });

        // Replace the cheap auto title with a model-generated one (best effort).
        if status == MessageStatus::Done && conversation.auto_title {
            self.generate_title(&conversation_id, active_provider.as_ref(), active_model, &content).await;
        }
        Ok(())
    }

    /// Runs one provider stream for a single-chat reply, emitting events into
    /// `message_id`'s stream. Provider failures land in `result.error` — this
    /// method itself never fails, so callers can decide about fallbacks.
    async fn stream_single(
        &self,
        message_id: &str,
        conversation_id: &str,
        model: &ModelRow,
        provider: &dyn providers::Provider,
        request: ChatRequest,
        cancel: &CancellationToken,
    ) -> StreamResult {
        let think_mode = model.reasoning_enabled.unwrap_or(model.supports_reasoning);
        let mut result = StreamResult::default();
        match provider.stream_chat(request).await {
            Ok(mut stream) => {
                use futures_util::StreamExt;
                loop {
                    tokio::select! {
                        event = stream.next() => {
                            let Some(event) = event else { break };
                            match event {
                                ChatEvent::TextDelta(delta) => {
                                    result.text.push_str(&delta);
                                    self.emit(ServerEvent::Token {
                                        conversation_id: conversation_id.to_string(),
                                        message_id: message_id.to_string(),
                                        delta,
                                    });
                                }
                                ChatEvent::ReasoningDelta(delta) if think_mode => {
                                    result.reasoning.push_str(&delta);
                                    self.emit(ServerEvent::ReasoningToken {
                                        conversation_id: conversation_id.to_string(),
                                        message_id: message_id.to_string(),
                                        model_id: model.id.clone(),
                                        delta,
                                    });
                                }
                                ChatEvent::ReasoningDelta(_) => {}
                                ChatEvent::ModelResolved(resolved) => {
                                    if result.resolved_model.is_none() {
                                        result.resolved_model = Some(resolved.clone());
                                        self.emit(ServerEvent::ModelResolved {
                                            conversation_id: conversation_id.to_string(),
                                            message_id: message_id.to_string(),
                                            model_id: resolved,
                                        });
                                    }
                                }
                                ChatEvent::ToolCalls(_) => {
                                    // Single-chat mode never offers native tools.
                                }
                                ChatEvent::Usage { tokens_in, tokens_out } => {
                                    result.usage = Some(Usage { tokens_in, tokens_out, estimated: false });
                                }
                                ChatEvent::Error { detail } => {
                                    result.error = Some(detail);
                                    break;
                                }
                            }
                        }
                        () = cancel.cancelled() => {
                            result.cancelled = true;
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                result.error = Some(error.to_string());
            }
        }
        result
    }

    /// If the history exceeds the token budget, asks the SAME model to summarize
    /// the oldest part and replaces it with a system summary message. Best
    /// effort: any failure returns the messages unchanged (plain trim remains
    /// the safety net).
    async fn summarize_overflow(
        &self,
        messages: Vec<ChatMessage>,
        provider: &dyn providers::Provider,
        model: &ModelRow,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Vec<ChatMessage>> {
        let cut = summarize_cut(&messages, HISTORY_TOKEN_BUDGET);
        if cut <= 1 {
            return Ok(messages);
        }
        let to_summarize = &messages[1..cut];
        let prompt = format!(
            "Aşağıdaki eski sohbet geçmişini Türkçe madde madde özetle. Önemli kararları,              dosya adlarını, model seçimlerini ve sonuçları koru; 300 kelimeyi aşma.\n\n{}",
            to_summarize
                .iter()
                .map(|message| format!("[{}]\n{}", message.role.as_str(), message.content))
                .collect::<Vec<_>>()
                .join("\n\n")
        );
        let request = ChatRequest {
            model: model.model_id.clone(),
            messages: vec![ChatMessage::new(Role::System, prompt)],
            temperature: Some(0.2),
            max_tokens: Some(600),
            images: Vec::new(),
            web: false,
            reasoning_enabled: false,
            reasoning_effort: None,
            tools: Vec::new(),
            tool_choice: None,
        };
        let mut summary = String::new();
        match provider.stream_chat(request).await {
            Ok(mut stream) => {
                use futures_util::StreamExt;
                loop {
                    tokio::select! {
                        event = stream.next() => {
                            let Some(event) = event else { break };
                            if let ChatEvent::TextDelta(delta) = event {
                                summary.push_str(&delta);
                            }
                        }
                        () = cancel.cancelled() => break,
                    }
                }
            }
            Err(error) => {
                tracing::warn!(%error, "history summarization failed; falling back to trimming");
                return Ok(messages);
            }
        }
        if summary.trim().is_empty() {
            return Ok(messages);
        }
        tracing::info!(summarized = cut - 1, "conversation history summarized");
        let mut next = Vec::with_capacity(messages.len() - (cut - 1) + 1);
        next.push(messages[0].clone());
        next.push(ChatMessage::new(
            Role::System,
            format!("# Önceki konuşmanın özeti\n{}", summary.trim()),
        ));
        next.extend(messages[cut..].iter().cloned());
        Ok(next)
    }

    /// Index of the first oldest message that must be KEPT so system + kept +
    /// summary fit under `budget`; `1` means nothing needs summarizing. The
    /// last user turn (the current request) is always kept.
    /// `messages` is `[system, history...]`.
    fn summarize_cut(messages: &[ChatMessage], budget: u64) -> usize {
        if messages.len() < 3 {
            return 1;
        }
        let Some(last_user) = messages.iter().rposition(|m| matches!(m.role, Role::User)) else {
            return 1;
        };
        let total: u64 = messages.iter().map(|m| estimate(&m.content)).sum();
        if total <= budget {
            return 1;
        }
        const SUMMARY_OVERHEAD: u64 = 200;
        let mut kept = estimate(&messages[0].content) + SUMMARY_OVERHEAD;
        let mut cut = last_user;
        for index in (1..=last_user).rev() {
            let tokens = estimate(&messages[index].content);
            if kept + tokens > budget {
                cut = index + 1;
                break;
            }
            kept += tokens;
            cut = index;
        }
        if cut == 1 {
            return 1;
        }
        // Only summarize when it removes a meaningful chunk (≥3 messages or
        // ≥512 tokens), avoiding pointless summarization calls.
        let removable: u64 = messages[1..cut].iter().map(|m| estimate(&m.content)).sum();
        if cut - 1 < 3 && removable < 512 {
            return 1;
        }
        cut
    }

    /// Asks the model for a 3–6 word conversation title; replaces auto titles.
    async fn generate_title(
        &self,
        conversation_id: &str,
        provider: &dyn providers::Provider,
        model: &ModelRow,
        first_user_message: &str,
    ) {
        let request = ChatRequest {
            model: model.model_id.clone(),
            messages: vec![
                ChatMessage {
                    role: Role::System,
                    content: "Sohbet başlığı üreticisisin. Yalnızca başlığı yaz.".into(),
                    ..Default::default()
                },
                ChatMessage {
                    role: Role::User,
                    content: format!(
                        "Aşağıdaki ilk mesaj için en fazla 6 kelimelik, tırnaksız, noktalama\
                         içermeyen kısa bir başlık yaz. Sadece başlık:\n\n{first_user_message}"
                    ),
                    ..Default::default()
                },
            ],
            temperature: Some(0.3),
            max_tokens: Some(48),
            images: Vec::new(),
            web: false,
            reasoning_enabled: false,
            reasoning_effort: None,
            tools: Vec::new(),
            tool_choice: None,
        };
        let Ok(mut stream) = provider.stream_chat(request).await else { return };
        let mut title = String::new();
        use futures_util::StreamExt;
        while let Some(event) = stream.next().await {
            if let providers::ChatEvent::TextDelta(delta) = event {
                title.push_str(&delta);
            }
        }
        let title: String = title.lines().next().unwrap_or("").trim().chars().take(60).collect();
        if title.len() < 2 {
            return;
        }
        let updated = sqlx::query(
            "UPDATE conversations SET title = ?, auto_title = 0 WHERE id = ? AND auto_title = 1",
        )
        .bind(&title)
        .bind(conversation_id)
        .execute(&self.db)
        .await;
        match updated {
            Ok(result) if result.rows_affected() > 0 => {
                tracing::info!(conversation_id, %title, "model-generated title applied");
            }
            _ => {}
        }
    }

    /// Group send → debate engine (plan §5.2).
    async fn run_debate(
        &self,
        conversation: Conversation,
        web: bool,
        quote_old: Option<String>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let group_id = conversation
            .group_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("group conversation has no group_id"))?;
        let models: Vec<ModelRow> = sqlx::query_as(
            "SELECT m.* FROM model_group_items i
             JOIN models m ON m.id = i.model_id
             WHERE i.group_id = ? AND m.enabled = 1
             ORDER BY i.position ASC, m.id ASC",
        )
        .bind(&group_id)
        .fetch_all(&self.db)
        .await?;
        if models.len() < 2 {
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation.id.clone()),
                message_id: None,
                code: ErrorCode::BadRequest,
                detail: "a debate group needs at least 2 enabled models".into(),
            });
            return Ok(());
        }

        let history: Vec<(String, String)> = sqlx::query_as(
            "SELECT role, content FROM messages
             WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(&conversation.id)
        .fetch_all(&self.db)
        .await?;
        let mut history: Vec<ChatMessage> = history
            .into_iter()
            .rev()
            .take(MAX_HISTORY_MESSAGES)
            .rev()
            .map(|(role, content)| ChatMessage {
                role: match role.as_str() {
                    "assistant" => Role::Assistant,
                    _ => Role::User,
                },
                content,
                ..Default::default()
            })
            .collect();
        // Edited turn: every participant and the leader see the quoted previous
        // version of the last user message (request-only, not stored).
        if let Some(quote) = quote_old {
            if let Some(last_user) = history
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                last_user.content.push_str(&format!(
                    "\n\n# Alıntılanan önceki mesaj\n{quote}\n\nBu mesaj düzenlendi. Alıntılanan önceki haliyle birlikte düzenlenmiş mesaja odaklanarak cevap ver."
                ));
            }
        }

        let settings = crate::debate::DebateSettings::parse(conversation.debate_settings_json.as_deref());
        crate::debate::rounds::run_debate(
            &self.db,
            self.hub.clone(),
            &self.prompts,
            self.secrets.as_ref(),
            &conversation,
            &models,
            settings,
            &history,
            web,
            cancel,
        )
        .await
        .map(|_| ())
    }

    /// Race run: the same prompt is sent to every model of the group in
    /// parallel; each lane persists its own assistant message (grouped by
    /// `race_id`) and streams its own events so the UI renders columns.
    async fn run_race(
        &self,
        conversation: Conversation,
        attachments: Vec<AttachmentIn>,
        web: bool,
        quote_old: Option<String>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let group_id = conversation
            .group_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("race conversation has no group_id"))?;
        let models: Vec<ModelRow> = sqlx::query_as(
            "SELECT m.* FROM model_group_items i
             JOIN models m ON m.id = i.model_id
             WHERE i.group_id = ? AND m.enabled = 1
             ORDER BY i.position ASC, m.id ASC",
        )
        .bind(&group_id)
        .fetch_all(&self.db)
        .await?;
        if models.len() < 2 {
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation.id.clone()),
                message_id: None,
                code: ErrorCode::BadRequest,
                detail: "a race group needs at least 2 enabled models".into(),
            });
            return Ok(());
        }

        let history: Vec<(String, String)> = sqlx::query_as(
            "SELECT role, content FROM messages
             WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(&conversation.id)
        .fetch_all(&self.db)
        .await?;
        let mut history: Vec<ChatMessage> = history
            .into_iter()
            .rev()
            .take(MAX_HISTORY_MESSAGES)
            .rev()
            .map(|(role, content)| {
                ChatMessage::new(
                    match role.as_str() {
                        "assistant" => Role::Assistant,
                        _ => Role::User,
                    },
                    content,
                )
            })
            .collect();
        // Edited turn: every race lane sees the quoted previous version of the
        // last user message (request-only, not stored).
        if let Some(quote) = quote_old {
            if let Some(last_user) = history
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                last_user.content.push_str(&format!(
                    "\n\n# Alıntılanan önceki mesaj\n{quote}\n\nBu mesaj düzenlendi. Alıntılanan önceki haliyle birlikte düzenlenmiş mesaja odaklanarak cevap ver."
                ));
            }
        }

        // Images + text attachments (shared by every lane).
        let mut images: Vec<providers::InputImage> = Vec::new();
        if !attachments.is_empty() {
            if let Some(last_user) = history
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                for attachment in &attachments {
                    if let Some(data_uri) = attachment.data_uri() {
                        images.push(providers::InputImage { data_uri });
                    } else {
                        last_user.content.push_str(&format!(
                            "\n\n[Dosya eki: {}]\n{}",
                            attachment.name, attachment.text
                        ));
                    }
                }
            }
        }
        // Engine-side web search (shared by every lane).
        if web {
            let prompt = history
                .iter()
                .rev()
                .find(|message| matches!(message.role, Role::User))
                .map(|message| message.content.clone())
                .unwrap_or_default();
            let results = crate::search::search(&prompt).await;
            let web_results = crate::search::format_results(&prompt, &results);
            if let Some(last_user) = history
                .iter_mut()
                .rev()
                .find(|message| matches!(message.role, Role::User))
            {
                last_user.content.push_str(&format!(
                    "\n\n# Web arama sonuçları\n{web_results}\n\nBu sonuçları kullanarak soruyu cevapla ve kaynaklara atıf yap."
                ));
            }
        }

        let base_prompt = if conversation.mode == "coding" {
            self.prompts.get("coding")
        } else {
            self.prompts.get("chat")
        };
        let race_id = uuid::Uuid::new_v4().to_string();
        let lanes = models
            .iter()
            .map(|model| {
                Box::pin(self.race_lane(
                    &conversation,
                    model,
                    &history,
                    &images,
                    web,
                    base_prompt,
                    &race_id,
                    &cancel,
                ))
            })
            .collect::<Vec<_>>();
        for result in futures_util::future::join_all(lanes).await {
            if let Err(error) = result {
                tracing::error!(%error, conversation_id = %conversation.id, "race lane failed");
            }
        }
        Ok(())
    }

    /// One race lane: builds the per-model request, streams and persists its own
    /// assistant message (grouped by `race_id`).
    #[allow(clippy::too_many_arguments)]
    async fn race_lane(
        &self,
        conversation: &Conversation,
        model: &ModelRow,
        history: &[ChatMessage],
        images: &[providers::InputImage],
        web: bool,
        base_prompt: &str,
        race_id: &str,
        cancel: &CancellationToken,
    ) -> anyhow::Result<()> {
        let conversation_id = conversation.id.clone();
        let provider: ProviderRow = sqlx::query_as("SELECT * FROM providers WHERE id = ?")
            .bind(&model.provider_id)
            .fetch_one(&self.db)
            .await?;
        let kind = storage::ProviderKind::from_str_loose(&provider.kind)
            .ok_or_else(|| anyhow::anyhow!("unknown provider kind {}", provider.kind))?;
        let api_key = self
            .secrets
            .get(&provider_key(&provider.id))
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "secret store read failed; continuing without key");
                None
            });
        let provider_impl = providers::build(kind, provider.base_url.as_deref(), api_key.as_deref())?;

        let mut system = vec![
            base_prompt.to_string(),
            crate::prompts::capability_notice().to_string(),
        ];
        if let Some(extra) = model
            .system_prompt_override
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            system.push(extra.to_string());
        }
        let mut messages = vec![ChatMessage::new(Role::System, system.join("\n\n"))];
        messages.extend(history.iter().cloned());
        let think_mode = model.reasoning_enabled.unwrap_or(model.supports_reasoning);
        let messages = crate::trim_history(messages, HISTORY_TOKEN_BUDGET);
        let request = ChatRequest {
            model: model.model_id.clone(),
            messages: messages.clone(),
            temperature: model.temperature.map(|t| t as f32),
            max_tokens: model.max_tokens.map(|t| t as u32),
            images: images.to_vec(),
            web,
            reasoning_enabled: think_mode,
            reasoning_effort: if think_mode {
                model.reasoning_effort.clone().or_else(|| Some("medium".to_string()))
            } else {
                None
            },
            tools: Vec::new(),
            tool_choice: None,
        };
        let prompt_texts: Vec<String> = messages.iter().map(|m| m.content.clone()).collect();

        // --- assistant row + start event ---------------------------------------
        let message_id = uuid::Uuid::new_v4().to_string();
        let now = storage::now_rfc3339();
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, content, model_id, race_id, created_at)
             VALUES (?, ?, 'assistant', '', ?, ?, ?)",
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&model.id)
        .bind(race_id)
        .bind(&now)
        .execute(&self.db)
        .await?;

        self.emit(ServerEvent::MessageStart {
            conversation_id: conversation_id.clone(),
            message_id: message_id.clone(),
            model_id: model.id.clone(),
            mode: ChatMode::Race,
            race_id: Some(race_id.to_string()),
        });

        // Every failure after the row exists must still close the lane
        // (Error + MessageDone) so the UI does not wait forever.
        let outcome: anyhow::Result<()> = async {
            // --- stream -------------------------------------------------------------
            let mut result = StreamResult::default();
        match provider_impl.stream_chat(request).await {
            Ok(mut stream) => {
                use futures_util::StreamExt;
                loop {
                    tokio::select! {
                        event = stream.next() => {
                            let Some(event) = event else { break };
                            match event {
                                ChatEvent::TextDelta(delta) => {
                                    result.text.push_str(&delta);
                                    self.emit(ServerEvent::Token {
                                        conversation_id: conversation_id.clone(),
                                        message_id: message_id.clone(),
                                        delta,
                                    });
                                }
                                ChatEvent::ReasoningDelta(delta) if think_mode => {
                                    result.reasoning.push_str(&delta);
                                    self.emit(ServerEvent::ReasoningToken {
                                        conversation_id: conversation_id.clone(),
                                        message_id: message_id.clone(),
                                        model_id: model.id.clone(),
                                        delta,
                                    });
                                }
                                ChatEvent::ReasoningDelta(_) => {}
                                ChatEvent::ModelResolved(resolved) => {
                                    if result.resolved_model.is_none() {
                                        result.resolved_model = Some(resolved.clone());
                                        self.emit(ServerEvent::ModelResolved {
                                            conversation_id: conversation_id.clone(),
                                            message_id: message_id.clone(),
                                            model_id: resolved,
                                        });
                                    }
                                }
                                ChatEvent::ToolCalls(_) => {}
                                ChatEvent::Usage { tokens_in, tokens_out } => {
                                    result.usage = Some(Usage { tokens_in, tokens_out, estimated: false });
                                }
                                ChatEvent::Error { detail } => {
                                    result.error = Some(detail);
                                    break;
                                }
                            }
                        }
                        () = cancel.cancelled() => {
                            result.cancelled = true;
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                result.error = Some(error.to_string());
            }
        }

        // --- usage + persist ------------------------------------------------------
        let usage = result.usage.unwrap_or_else(|| Usage {
            tokens_in: crate::tokens::estimate_prompt(&prompt_texts),
            tokens_out: estimate(&result.text),
            estimated: true,
        });
        let status = if result.cancelled {
            MessageStatus::Cancelled
        } else if result.error.is_some() {
            MessageStatus::Error
        } else {
            MessageStatus::Done
        };
        let finished_at = storage::now_rfc3339();
        sqlx::query(
            "UPDATE messages SET content = ?, reasoning = ?, tokens_in = ?, tokens_out = ?,
                    tokens_estimated = ?, resolved_model = ? WHERE id = ?",
        )
        .bind(&result.text)
        .bind(&result.reasoning)
        .bind(usage.tokens_in as i64)
        .bind(usage.tokens_out as i64)
        .bind(usage.estimated)
        .bind(&result.resolved_model)
        .bind(&message_id)
        .execute(&self.db)
        .await?;
        sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
            .bind(&finished_at)
            .bind(&conversation_id)
            .execute(&self.db)
            .await?;

        self.emit(ServerEvent::Usage {
            conversation_id: conversation_id.clone(),
            message_id: message_id.clone(),
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            estimated: usage.estimated,
        });
        if let Some(detail) = result.error {
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation_id.clone()),
                message_id: Some(message_id.clone()),
                code: ErrorCode::ProviderError,
                detail,
            });
        }
            self.emit(ServerEvent::MessageDone {
                conversation_id: conversation_id.clone(),
                message_id: message_id.clone(),
                status,
            });
            Ok(())
        }
        .await;

        if let Err(error) = outcome {
            tracing::error!(%error, conversation_id, "race lane failed");
            let detail = error.to_string();
            let _ = sqlx::query("UPDATE messages SET content = ? WHERE id = ?")
                .bind(&detail)
                .bind(&message_id)
                .execute(&self.db)
                .await;
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation_id.clone()),
                message_id: Some(message_id.clone()),
                code: ErrorCode::ProviderError,
                detail,
            });
            self.emit(ServerEvent::MessageDone {
                conversation_id,
                message_id,
                status: MessageStatus::Error,
            });
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct StreamResult {
    pub(crate) text: String,
    pub(crate) reasoning: String,
    pub(crate) usage: Option<Usage>,
    pub(crate) error: Option<String>,
    pub(crate) cancelled: bool,
    /// Concrete model id the provider served (alias resolution), if any.
    pub(crate) resolved_model: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_cut_keeps_recent_and_targets_old() {
        // Small history: everything fits under a big budget → no cut.
        let small: Vec<ChatMessage> = std::iter::once(ChatMessage::new(Role::System, "sys"))
            .chain((0..10).map(|i| {
                if i == 9 {
                    ChatMessage::new(Role::User, "current request")
                } else {
                    ChatMessage::new(Role::Assistant, format!("answer {i} ").repeat(60))
                }
            }))
            .collect();
        assert_eq!(summarize_cut(&small, 16_000), 1);

        // Oversized history: everything but the last user turn is summarized.
        let big: Vec<ChatMessage> = std::iter::once(ChatMessage::new(Role::System, "sys"))
            .chain((0..6).map(|i| ChatMessage::new(Role::Assistant, format!("a{i} ").repeat(4000))))
            .chain(std::iter::once(ChatMessage::new(Role::User, "current request")))
            .collect();
        let cut = summarize_cut(&big, 4_000);
        assert!(cut > 1, "expected a summarization cut, got {cut}");
        assert!(cut < big.len(), "last user turn must be kept, cut={cut}");
        assert_eq!(big[cut..].last().unwrap().role, Role::User);
        // The summary replaces the oldest messages: kept part starts below the
        // budget and the system message stays first.
        assert_eq!(big[0].role, Role::System);
    }
}
