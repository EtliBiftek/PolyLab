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
    ) {
        let engine = Arc::clone(self);
        tokio::spawn(async move { engine.run(conversation_id, content, attachments).await });
    }

    /// Synchronous variant used by tests and future internal callers.
    pub async fn send_message(&self, conversation_id: String, content: String) {
        self.run(conversation_id, content, Vec::new()).await;
    }

    async fn run(&self, conversation_id: String, content: String, attachments: Vec<AttachmentIn>) {
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

        self.run_guarded(conversation_id.clone(), content, attachments, token).await;

        self.cancels.lock().await.remove(&conversation_id);
    }

    async fn run_guarded(
        &self,
        conversation_id: String,
        content: String,
        attachments: Vec<AttachmentIn>,
        cancel: CancellationToken,
    ) {
        match self.run_inner(&conversation_id, content, attachments, cancel).await {
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

        // --- group send → debate engine (plan §5.2) -----------------------------
        if conversation.selection_type == "group" {
            return self.run_debate(conversation, cancel).await;
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
            .bind(conversation_id)
            .fetch_all(&self.db)
            .await?;
            let history: Vec<ChatMessage> = crate::trim_history(
                history
                    .into_iter()
                    .map(|(role, content)| ChatMessage {
                        role: match role.as_str() {
                            "assistant" => Role::Assistant,
                            _ => Role::User,
                        },
                        content,
                    })
                    .collect(),
                HISTORY_TOKEN_BUDGET,
            );
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
        let mut system = vec![base_prompt.to_string()];
        if let Some(extra) = model.system_prompt_override.as_deref().filter(|s| !s.trim().is_empty()) {
            system.push(extra.to_string());
        }

        let history: Vec<(String, String)> = sqlx::query_as(
            "SELECT role, content FROM messages
             WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(conversation_id)
        .fetch_all(&self.db)
        .await?;

        let mut messages = vec![ChatMessage { role: Role::System, content: system.join("\n\n") }];
        for (role, text) in history.into_iter().rev().take(MAX_HISTORY_MESSAGES).rev() {
            let role = match role.as_str() {
                "assistant" => Role::Assistant,
                _ => Role::User,
            };
            messages.push(ChatMessage { role, content: text });
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
        let history_budget_tokens = HISTORY_TOKEN_BUDGET;
        let messages = crate::trim_history(messages, history_budget_tokens);
        let request = ChatRequest {
            model: model.model_id.clone(),
            messages,
            temperature: model.temperature.map(|t| t as f32),
            max_tokens: model.max_tokens.map(|t| t as u32),
            images,
        };

        // --- assistant row + start event ---------------------------------------
        let message_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, content, model_id, created_at)
             VALUES (?, ?, 'assistant', '', ?, ?)",
        )
        .bind(&message_id)
        .bind(conversation_id)
        .bind(&model.id)
        .bind(&now)
        .execute(&self.db)
        .await?;

        self.emit(ServerEvent::MessageStart {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.clone(),
            model_id: model.id.clone(),
            mode: ChatMode::Single,
        });

        // Think (reasoning) toggle: explicit per-model choice, else follow the
        // capability flag. When off, reasoning deltas are dropped (not shown, not
        // stored) — providers that think server-side simply hide the panel.
        let think_mode = model.reasoning_enabled.unwrap_or(model.supports_reasoning);

        // --- stream -------------------------------------------------------------
        let prompt_texts: Vec<String> = request.messages.iter().map(|m| m.content.clone()).collect();
        let provider_impl = providers::build(kind, provider.base_url.as_deref(), api_key.as_deref())?;
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
                                        conversation_id: conversation_id.to_string(),
                                        message_id: message_id.clone(),
                                        delta,
                                    });
                                }
                                ChatEvent::ReasoningDelta(delta) if think_mode => {
                                    result.reasoning.push_str(&delta);
                                    self.emit(ServerEvent::ReasoningToken {
                                        conversation_id: conversation_id.to_string(),
                                        message_id: message_id.clone(),
                                        model_id: model.id.clone(),
                                        delta,
                                    });
                                }
                                ChatEvent::ReasoningDelta(_) => {}
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
                    tokens_estimated = ? WHERE id = ?",
        )
        .bind(&result.text)
        .bind(&result.reasoning)
        .bind(usage.tokens_in as i64)
        .bind(usage.tokens_out as i64)
        .bind(usage.estimated)
        .bind(&message_id)
        .execute(&self.db)
        .await?;
        sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
            .bind(&finished_at)
            .bind(conversation_id)
            .execute(&self.db)
            .await?;

        self.emit(ServerEvent::Usage {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.clone(),
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            estimated: usage.estimated,
        });
        if let Some(detail) = result.error {
            self.emit(ServerEvent::Error {
                conversation_id: Some(conversation_id.to_string()),
                message_id: Some(message_id.clone()),
                code: ErrorCode::ProviderError,
                detail,
            });
        }
        self.emit(ServerEvent::MessageDone {
            conversation_id: conversation_id.to_string(),
            message_id,
            status,
        });

        // Replace the cheap auto title with a model-generated one (best effort).
        if status == MessageStatus::Done && conversation.auto_title {
            self.generate_title(conversation_id, provider_impl.as_ref(), &model, &content).await;
        }
        Ok(())
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
                },
                ChatMessage {
                    role: Role::User,
                    content: format!(
                        "Aşağıdaki ilk mesaj için en fazla 6 kelimelik, tırnaksız, noktalama\
                         içermeyen kısa bir başlık yaz. Sadece başlık:\n\n{first_user_message}"
                    ),
                },
            ],
            temperature: Some(0.3),
            max_tokens: Some(48),
            images: Vec::new(),
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
        let history: Vec<ChatMessage> = history
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
            })
            .collect();

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
            cancel,
        )
        .await
        .map(|_| ())
    }
}

#[derive(Default)]
pub(crate) struct StreamResult {
    pub(crate) text: String,
    pub(crate) reasoning: String,
    pub(crate) usage: Option<Usage>,
    pub(crate) error: Option<String>,
    pub(crate) cancelled: bool,
}
