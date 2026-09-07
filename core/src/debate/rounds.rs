//! Debate orchestration: sequential rounds (each model sees earlier answers in the
//! same round), consensus checks, leader synthesis.

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::debate::{select_leader, DebateSettings, Participant};
use crate::engine::StreamResult;
use crate::events::{ChatMode, DebatePhase, ErrorCode, MessageStatus, ServerEvent};
use crate::prompts::PromptLibrary;
use crate::providers::{ChatEvent, ChatMessage, ChatRequest, Role};
use crate::secrets::SecretStore;
use crate::storage::{now_rfc3339, Conversation, ModelRow};
use crate::tokens::{estimate, Usage};

pub struct DebateOutcome {
    pub status: MessageStatus,
    pub consensus_reached: Option<bool>,
    pub total_tokens_in: u64,
    pub total_tokens_out: u64,
}

#[derive(Clone)]
struct Ctx {
    hub: broadcast::Sender<String>,
    conversation_id: String,
    debate_id: String,
    message_id: String,
}

impl Ctx {
    fn emit(&self, event: ServerEvent) {
        let _ = self.hub.send(event.to_json());
    }
}

/// One turn's stored data.
struct TurnRecord {
    model_id: String,
    anon_label: String,
    round: u32,
    phase: DebatePhase,
    content: String,
    reasoning: String,
    usage: Usage,
    consensus: Option<bool>,
    failed: bool,
    /// Concrete model id the provider served for this turn (alias resolution).
    resolved_model: Option<String>,
}

/// Full debate flow. The leader's synthesis becomes the user-visible assistant
/// message; everything is streamed live as `debate_*` events (docs/EVENTS.md).
#[allow(clippy::too_many_arguments)]
pub async fn run_debate(
    db: &SqlitePool,
    hub: broadcast::Sender<String>,
    prompts: &PromptLibrary,
    secrets: &dyn SecretStore,
    conversation: &Conversation,
    group_models: &[ModelRow],
    settings: DebateSettings,
    history: &[ChatMessage],
    web: bool,
    cancel: CancellationToken,
) -> anyhow::Result<(String, DebateOutcome)> {
    let conversation_id = conversation.id.clone();
    let base_prompt_raw = if conversation.mode == "coding" {
        prompts.get("coding")
    } else {
        prompts.get("chat")
    };
    // Coding debates: give every participant + the leader the same project
    // snapshot so the models can actually see the workspace files.
    let mut base_prompt = base_prompt_raw.to_string();
    if conversation.mode == "coding" {
        let workspace = crate::terminal::workspace_root(conversation);
        let _ = ::std::fs::create_dir_all(&workspace);
        let context = crate::fs::snapshot(&workspace)
            .unwrap_or_else(|error| format!("(çalışma alanı okunamadı: {error})"));
        base_prompt.push_str("\n\n# Çalışma alanı\n");
        base_prompt.push_str(&context);
    }
    base_prompt.push_str("\n\n");
    base_prompt.push_str(crate::prompts::capability_notice());
    // Engine-side DuckDuckGo web search: same results for every participant
    // plus the leader (all providers).
    if web {
        let query = history
            .iter()
            .rev()
            .find(|message| message.role == Role::User)
            .map(|message| message.content.as_str())
            .unwrap_or("");
        let results = crate::search::search(query).await;
        base_prompt.push_str("\n\n# Web arama sonuçları\n");
        base_prompt.push_str(&crate::search::format_results(query, &results));
    }

    // --- participants + leader ------------------------------------------------
    let mut participants = super::build_participants(db, secrets, group_models).await?;
    anyhow::ensure!(participants.len() >= 2, "a debate group needs at least 2 models");
    let leader_id = select_leader(&participants, settings.leader_model_id.as_deref());
    let base_prompts: Vec<ChatMessage> = {
        let mut messages = vec![ChatMessage {
            role: Role::System,
            content: base_prompt.to_string(),
            ..Default::default()
        }];
        messages.extend(history.iter().cloned());
        messages
    };

    // --- rows ---------------------------------------------------------------------
    let debate_id = uuid::Uuid::new_v4().to_string();
    let message_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_rfc3339();
    let assistant_model_id = leader_id.clone();
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content, model_id, created_at)
         VALUES (?, ?, 'assistant', '', ?, ?)",
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(&assistant_model_id)
    .bind(&started_at)
    .execute(db)
    .await?;
    sqlx::query(
        "INSERT INTO debates (id, message_id, conversation_id, status, rounds_total,
                              leader_model_id, settings_json, started_at)
         VALUES (?, ?, ?, 'running', 0, ?, ?, ?)",
    )
    .bind(&debate_id)
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(&leader_id)
    .bind(serde_json::to_string(&settings)?)
    .bind(&started_at)
    .execute(db)
    .await?;

    let ctx = Ctx {
        hub,
        conversation_id: conversation_id.clone(),
        debate_id: debate_id.clone(),
        message_id: message_id.clone(),
    };
    ctx.emit(ServerEvent::MessageStart {
        conversation_id: conversation_id.clone(),
        message_id: message_id.clone(),
        model_id: leader_id.clone(),
        mode: ChatMode::Debate,
        race_id: None,
    });

    let mut consensus_reached: Option<bool> = None;
    let mut transcript: Vec<TurnRecord> = Vec::new();
    let mut rounds_done: u32 = 0;
    let mut cancelled = false;
    let mut synthesis_error: Option<String> = None;

    'debate: for round in 1..=settings.max_rounds.max(1) {
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
        let phase = if round == 1 { DebatePhase::Initial } else { DebatePhase::Critique };
        ctx.emit(ServerEvent::DebateRoundStart {
            conversation_id: ctx.conversation_id.clone(),
            debate_id: ctx.debate_id.clone(),
            round,
            phase,
        });

        // Sequential turns: models wait for each other. Every participant sees
        // the answers written earlier in this round (plus all previous rounds),
        // so the next model can react to what the others already said.
        let mut round_turns: Vec<TurnRecord> = Vec::new();
        for participant in &participants {
            if cancel.is_cancelled() {
                cancelled = true;
                break;
            }
            let (prompt_text, request) = build_turn_request(
                participant,
                round,
                base_prompt.as_str(),
                prompts,
                &transcript,
                &round_turns,
                &base_prompts,
            );
            let usage_estimate = Usage {
                tokens_in: estimate(&prompt_text),
                tokens_out: 0,
                estimated: true,
            };
            let result = run_one_turn(&ctx, participant, request, round, &cancel).await;
            let usage = result.usage.unwrap_or_else(|| Usage {
                tokens_in: usage_estimate.tokens_in,
                tokens_out: estimate(&result.text),
                estimated: true,
            });
            let consensus = (round > 1).then(|| crate::debate::consensus::parse_vote(&result.text)).flatten();
            let failed = result.error.is_some();
            if let Some(detail) = &result.error {
                tracing::warn!(model = %participant.model.display_name, %detail, "debate turn failed");
                ctx.emit(ServerEvent::Error {
                    conversation_id: Some(ctx.conversation_id.clone()),
                    message_id: Some(message_id.clone()),
                    code: ErrorCode::ProviderError,
                    detail: format!("{} ({}) ayırıldı: {detail}", participant.anon_label, participant.model.display_name),
                });
            }
            if result.cancelled {
                cancelled = true;
            }
            ctx.emit(ServerEvent::DebateTurnDone {
                conversation_id: ctx.conversation_id.clone(),
                debate_id: ctx.debate_id.clone(),
                round,
                model_id: participant.model.id.clone(),
                anon_label: participant.anon_label.clone(),
                tokens_in: usage.tokens_in,
                tokens_out: usage.tokens_out,
            });
            round_turns.push(TurnRecord {
                model_id: participant.model.id.clone(),
                anon_label: participant.anon_label.clone(),
                round,
                phase,
                content: result.text,
                reasoning: result.reasoning,
                usage,
                consensus,
                failed,
                resolved_model: result.resolved_model,
            });
        }

        // Persist this round's turns.
        for turn in &round_turns {
            persist_turn(db, &debate_id, turn, &started_at).await?;
        }
        transcript.extend(round_turns);
        rounds_done = round;

        // Drop failed participants for later rounds.
        participants.retain(|p| !transcript.iter().any(|t| t.failed && t.model_id == p.model.id));

        if participants.is_empty() {
            synthesis_error = Some("all participants failed".into());
            break;
        }

        if cancelled {
            break;
        }

        // Consensus check (round >= 2).
        if round > 1 && settings.termination == crate::debate::Termination::Consensus {
            let votes: Vec<Option<bool>> = transcript
                .iter()
                .filter(|t| t.round == round)
                .map(|t| t.consensus)
                .collect();
            match crate::debate::consensus::unanimous(&votes) {
                Some(true) => {
                    consensus_reached = Some(true);
                    ctx.emit(ServerEvent::DebateConsensus {
                        conversation_id: ctx.conversation_id.clone(),
                        debate_id: ctx.debate_id.clone(),
                        reached: true,
                        reason: format!("all {} participants voted yes", votes.len()),
                    });
                    break 'debate;
                }
                Some(false) | None => {
                    if round == settings.max_rounds {
                        consensus_reached = Some(false);
                        ctx.emit(ServerEvent::DebateConsensus {
                            conversation_id: ctx.conversation_id.clone(),
                            debate_id: ctx.debate_id.clone(),
                            reached: false,
                            reason: "max rounds reached without consensus; leader decided".into(),
                        });
                    }
                }
            }
        }
    }

    // --- synthesis -----------------------------------------------------------------
    let mut synthesis_text = String::new();
    let mut synthesis_reasoning = String::new();
    let mut synthesis_usage: Option<Usage> = None;
    let mut synthesis_resolved: Option<String> = None;
    if synthesis_error.is_none() && !cancelled {
        let leader = participants
            .iter()
            .find(|p| p.model.id == leader_id)
            .or_else(|| participants.first());
        if let Some(leader) = leader {
            let round = rounds_done + 1;
            ctx.emit(ServerEvent::DebateRoundStart {
                conversation_id: ctx.conversation_id.clone(),
                debate_id: ctx.debate_id.clone(),
                round,
                phase: DebatePhase::Synthesis,
            });
            let transcript_text = render_transcript(&transcript);
            let prompt_text = format!("{}\n\n{}", prompts.get("debate_leader"), transcript_text);
            let request = ChatRequest {
                model: leader.model.model_id.clone(),
                messages: vec![
                    ChatMessage { role: Role::System, content: base_prompt.to_string(), ..Default::default() },
                    ChatMessage { role: Role::System, content: prompts.get("debate_leader").to_string(), ..Default::default() },
                    ChatMessage {
                        role: Role::User,
                        content: format!(
                            "Görev ve tartışma turu çıktıları:\n\n{transcript_text}"
                        ),
                        ..Default::default()
                    },
                ],
                temperature: leader.model.temperature.map(|t| t as f32),
                max_tokens: leader.model.max_tokens.map(|t| t as u32),
                images: Vec::new(),
                web: false,
                reasoning_enabled: leader
                    .model
                    .reasoning_enabled
                    .unwrap_or(leader.model.supports_reasoning),
                reasoning_effort: leader.model.reasoning_effort.clone(),
                tools: Vec::new(),
                tool_choice: None,
            };
            let result = run_one_turn(&ctx, leader, request, round, &cancel).await;
            synthesis_text = result.text.clone();
            synthesis_reasoning = result.reasoning.clone();
            synthesis_resolved = result.resolved_model.clone();
            synthesis_usage = result.usage.or_else(|| Some(Usage {
                tokens_in: estimate(&prompt_text),
                tokens_out: estimate(&result.text),
                estimated: true,
            }));
            let usage = synthesis_usage.unwrap();
            ctx.emit(ServerEvent::DebateTurnDone {
                conversation_id: ctx.conversation_id.clone(),
                debate_id: ctx.debate_id.clone(),
                round,
                model_id: leader.model.id.clone(),
                anon_label: leader.anon_label.clone(),
                tokens_in: usage.tokens_in,
                tokens_out: usage.tokens_out,
            });
            persist_turn(
                db,
                &debate_id,
                &TurnRecord {
                    model_id: leader.model.id.clone(),
                    anon_label: leader.anon_label.clone(),
                    round,
                    phase: DebatePhase::Synthesis,
                    content: result.text,
                    reasoning: result.reasoning,
                    usage,
                    consensus: None,
                    failed: result.error.is_some() || result.cancelled,
                    resolved_model: result.resolved_model,
                },
                &started_at,
            )
            .await?;
            rounds_done = round;
            if result.error.is_some() {
                synthesis_error = result.error.clone();
            }
            if result.cancelled {
                cancelled = true;
            }
        }
    }

    // --- totals + finalize -------------------------------------------------------------
    let (total_in, total_out) = transcript_total(&transcript, synthesis_usage.as_ref());
    let any_estimated = transcript.iter().any(|t| t.usage.estimated)
        || synthesis_usage.map(|u| u.estimated).unwrap_or(false);
    let status = if cancelled {
        MessageStatus::Cancelled
    } else if synthesis_error.is_some() {
        MessageStatus::Error
    } else {
        MessageStatus::Done
    };

    // Resolved model (alias resolution) of the leader's synthesis, if the
    // provider reported it; falls back to the first participant that reported.
    let resolved_model = synthesis_resolved.clone().or_else(|| {
        transcript
            .iter()
            .find_map(|turn| turn.resolved_model.clone())
    });
    sqlx::query(
        "UPDATE messages SET content = ?, reasoning = ?, tokens_in = ?, tokens_out = ?, tokens_estimated = ?,
                resolved_model = ? WHERE id = ?",
    )
    .bind(&synthesis_text)
    .bind(&synthesis_reasoning)
    .bind(total_in as i64)
    .bind(total_out as i64)
    .bind(any_estimated)
    .bind(&resolved_model)
    .bind(&message_id)
    .execute(db)
    .await?;

    let debate_status = match status {
        MessageStatus::Done => "done",
        MessageStatus::Cancelled => "cancelled",
        MessageStatus::Error => "error",
    };
    sqlx::query(
        "UPDATE debates SET status = ?, rounds_total = ?, consensus_reached = ?,
                total_tokens_in = ?, total_tokens_out = ?, ended_at = ? WHERE id = ?",
    )
    .bind(debate_status)
    .bind(rounds_done as i64)
    .bind(consensus_reached)
    .bind(total_in as i64)
    .bind(total_out as i64)
    .bind(now_rfc3339())
    .bind(&debate_id)
    .execute(db)
    .await?;
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(now_rfc3339())
        .bind(&conversation_id)
        .execute(db)
        .await?;

    ctx.emit(ServerEvent::Usage {
        conversation_id: ctx.conversation_id.clone(),
        message_id: message_id.clone(),
        tokens_in: total_in,
        tokens_out: total_out,
        estimated: any_estimated,
    });
    if let Some(detail) = synthesis_error {
        ctx.emit(ServerEvent::Error {
            conversation_id: Some(ctx.conversation_id.clone()),
            message_id: Some(message_id.clone()),
            code: ErrorCode::ProviderError,
            detail,
        });
    }
    ctx.emit(ServerEvent::DebateDone {
        conversation_id: ctx.conversation_id.clone(),
        debate_id: ctx.debate_id.clone(),
        total_tokens_in: total_in,
        total_tokens_out: total_out,
    });
    ctx.emit(ServerEvent::MessageDone {
        conversation_id: ctx.conversation_id.clone(),
        message_id: message_id.clone(),
        status,
    });

    Ok((
        message_id,
        DebateOutcome {
            status,
            consensus_reached,
            total_tokens_in: total_in,
            total_tokens_out: total_out,
        },
    ))
}

/* ---------------------------------------------------------------------- helpers -- */

/// Runs one participant turn, streaming deltas to the hub.
async fn run_one_turn(
    ctx: &Ctx,
    participant: &Participant,
    request: ChatRequest,
    round: u32,
    cancel: &CancellationToken,
) -> StreamResult {
    let mut result = StreamResult::default();
    let provider = participant.provider.clone();
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
                                ctx.emit(ServerEvent::DebateTurnToken {
                                    conversation_id: ctx.conversation_id.clone(),
                                    debate_id: ctx.debate_id.clone(),
                                    round,
                                    model_id: participant.model.id.clone(),
                                    anon_label: participant.anon_label.clone(),
                                    delta,
                                });
                            }
                            ChatEvent::ReasoningDelta(delta) => {
                                result.reasoning.push_str(&delta);
                                ctx.emit(ServerEvent::DebateTurnReasoningToken {
                                    conversation_id: ctx.conversation_id.clone(),
                                    debate_id: ctx.debate_id.clone(),
                                    round,
                                    model_id: participant.model.id.clone(),
                                    anon_label: participant.anon_label.clone(),
                                    delta,
                                });
                            }
                            ChatEvent::ModelResolved(resolved) => {
                                if result.resolved_model.is_none() {
                                    result.resolved_model = Some(resolved.clone());
                                    ctx.emit(ServerEvent::ModelResolved {
                                        conversation_id: ctx.conversation_id.clone(),
                                        message_id: ctx.message_id.clone(),
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
    result
}

/// Builds the request for a participant in a given round. `same_round` holds
/// the answers written earlier in THIS round, so every model sees what the
/// previous models said before answering (sequential rounds, shared visibility).
#[allow(clippy::too_many_arguments)]
fn build_turn_request(
    participant: &Participant,
    round: u32,
    base_prompt: &str,
    prompts: &PromptLibrary,
    transcript: &[TurnRecord],
    same_round: &[TurnRecord],
    base_prompts: &[ChatMessage],
) -> (String, ChatRequest) {
    if round == 1 {
        let participant_prompt = prompts.get("debate_participant");
        let mut messages = vec![ChatMessage {
            role: Role::System,
            content: format!("{base_prompt}\n\n{participant_prompt}"),
            ..Default::default()
        }];
        messages.extend(base_prompts.iter().skip(1).cloned());
        let peers: Vec<String> = same_round
            .iter()
            .filter(|t| t.model_id != participant.model.id && !t.content.trim().is_empty())
            .map(|t| format!("## {}\n{}", t.anon_label, t.content))
            .collect();
        if !peers.is_empty() {
            if let Some(last_user) = messages
                .iter_mut()
                .rev()
                .find(|message| message.role == Role::User)
            {
                last_user.content.push_str(&format!(
                    "\n\nBU TURDA ŞİMDİYE KADAR DİĞER KATILIMCILARIN SÖYLEDİKLERİ:\n{}\n\nBu cevapları da dikkate al; aynı olan noktaları tekrarlama, farklı gördüklerine katkı yap.",
                    peers.join("\n\n"),
                ));
            }
        }
        let prompt_text = messages.iter().map(|m| m.content.clone()).collect::<Vec<_>>().join("\n");
        let request = ChatRequest {
            model: participant.model.model_id.clone(),
            messages,
            temperature: participant.model.temperature.map(|t| t as f32),
            max_tokens: participant.model.max_tokens.map(|t| t as u32),
            images: Vec::new(),
            web: false,
            reasoning_enabled: participant
                .model
                .reasoning_enabled
                .unwrap_or(participant.model.supports_reasoning),
            reasoning_effort: participant.model.reasoning_effort.clone(),
            tools: Vec::new(),
            tool_choice: None,
        };
        return (prompt_text, request);
    }

    // critique round: own previous answer + everyone else's (anon), including
    // the answers written earlier in this very round.
    let mut seen: Vec<&TurnRecord> = Vec::new();
    seen.extend(same_round.iter());
    seen.extend(transcript.iter().rev());
    let own = seen
        .iter()
        .find(|t| t.model_id == participant.model.id)
        .map(|t| t.content.clone())
        .unwrap_or_default();
    let others: Vec<String> = seen
        .iter()
        .filter(|t| t.model_id != participant.model.id)
        .map(|t| format!("## {}\n{}", t.anon_label, t.content))
        .collect();
    let critique_prompt = prompts.get("debate_critique");
    let user_content = format!(
        "KULLANICI SORUSU VE KONUŞMA:\n{}\n\nSENİN ÖNCEKİ CEVABIN:\n{}\n\nDİĞER KATILIMCILARIN CEVAPLARI:\n{}\n\n{}",
        base_prompts
            .iter()
            .skip(1)
            .map(|m| m.content.clone())
            .collect::<Vec<_>>()
            .join("\n"),
        own,
        others.join("\n\n"),
        critique_prompt,
    );
    let messages = vec![
        ChatMessage { role: Role::System, content: base_prompt.to_string(), ..Default::default() },
        ChatMessage { role: Role::User, content: user_content.clone(), ..Default::default() },
    ];
    let prompt_text = messages.iter().map(|m| m.content.clone()).collect::<Vec<_>>().join("\n");
    let request = ChatRequest {
        model: participant.model.model_id.clone(),
        messages,
        temperature: participant.model.temperature.map(|t| t as f32),
        max_tokens: participant.model.max_tokens.map(|t| t as u32),
        images: Vec::new(),
        web: false,
        reasoning_enabled: participant
            .model
            .reasoning_enabled
            .unwrap_or(participant.model.supports_reasoning),
        reasoning_effort: participant.model.reasoning_effort.clone(),
        tools: Vec::new(),
        tool_choice: None,
    };
    (prompt_text, request)
}

fn render_transcript(transcript: &[TurnRecord]) -> String {
    let mut text = String::new();
    for round in 1..=transcript.iter().map(|t| t.round).max().unwrap_or(0) {
        let turns: Vec<&TurnRecord> = transcript.iter().filter(|t| t.round == round).collect();
        if turns.is_empty() {
            continue;
        }
        let phase = match turns[0].phase {
            DebatePhase::Initial => "ilk cevaplar",
            DebatePhase::Critique => "eleştiri ve revizyon",
            DebatePhase::Synthesis => "sentez",
        };
        text.push_str(&format!("### Tur {round} — {phase}\n\n"));
        for turn in turns {
            if turn.phase == DebatePhase::Synthesis {
                continue;
            }
            text.push_str(&format!("## {} cevabı:\n{}\n\n", turn.anon_label, turn.content));
        }
    }
    text
}

fn transcript_total(transcript: &[TurnRecord], synthesis_usage: Option<&Usage>) -> (u64, u64) {
    let mut total_in = 0;
    let mut total_out = 0;
    for turn in transcript {
        total_in += turn.usage.tokens_in;
        total_out += turn.usage.tokens_out;
    }
    if let Some(usage) = synthesis_usage {
        total_in += usage.tokens_in;
        total_out += usage.tokens_out;
    }
    (total_in, total_out)
}

async fn persist_turn(
    db: &SqlitePool,
    debate_id: &str,
    turn: &TurnRecord,
    created_at: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO debate_turns (id, debate_id, round, model_id, anon_label, content,
                reasoning, tokens_in, tokens_out, phase, consensus, resolved_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(debate_id)
    .bind(turn.round as i64)
    .bind(&turn.model_id)
    .bind(&turn.anon_label)
    .bind(&turn.content)
    .bind(&turn.reasoning)
    .bind(turn.usage.tokens_in as i64)
    .bind(turn.usage.tokens_out as i64)
    .bind(match turn.phase {
        DebatePhase::Initial => "initial",
        DebatePhase::Critique => "critique",
        DebatePhase::Synthesis => "synthesis",
    })
    .bind(turn.consensus)
    .bind(&turn.resolved_model)
    .bind(created_at)
    .execute(db)
    .await?;
    Ok(())
}
