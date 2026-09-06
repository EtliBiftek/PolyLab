//! Coding agent loop (plan §5.3–5.4): a tool-using single-model run.
//!
//! Protocol: the model answers either with plain text (final answer) or with a
//! single fenced block ```tool {"tool":"fs_read","args":{…}}```. The engine
//! executes the tool (asking for approval when the conversation requires it),
//! feeds the result back, and loops — max `MAX_STEPS` iterations. Only the
//! final (tool-free) reply becomes the assistant message; tool traffic is
//! streamed as `agent_tool_start` / `agent_tool_result` events and persisted
//! into `agent_steps`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;

use crate::events::{ChatMode, ErrorCode, MessageStatus, ServerEvent};
use crate::fs;
use crate::git;
use crate::providers::{ChatMessage, ChatRequest, Provider, Role};
use crate::storage::{now_rfc3339, Conversation, ModelRow};
use crate::tokens::{estimate, Usage};

pub const MAX_STEPS: u32 = 8;
const APPROVAL_TIMEOUT_SECS: u64 = 180;

pub type Approvals = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

/// Extracts the last ```tool fenced JSON block from a model reply.
pub fn parse_tool_call(text: &str) -> Option<(String, Value)> {
    let mut inside = false;
    let mut body = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !inside && (trimmed == "```tool" || trimmed.starts_with("```tool")) {
            let rest = trimmed.strip_prefix("```tool").unwrap_or("").trim();
            body.clear();
            body.push_str(rest);
            inside = true;
            continue;
        }
        if inside {
            if trimmed.starts_with("```") {
                inside = false;
                continue;
            }
            body.push_str(line);
            body.push('\n');
        }
    }
    let parsed: Value = serde_json::from_str(body.trim()).ok()?;
    let tool = parsed.get("tool")?.as_str()?.to_string();
    if tool.is_empty() {
        return None;
    }
    let args = parsed.get("args").cloned().unwrap_or_else(|| Value::Object(Default::default()));
    Some((tool, args))
}

#[allow(clippy::too_many_arguments)]
pub async fn run_agent(
    db: &SqlitePool,
    hub: broadcast::Sender<String>,
    system_prompt: &str,
    conversation: &Conversation,
    model: &ModelRow,
    provider: &dyn Provider,
    history: &[ChatMessage],
    _task: &str,
    cancel: CancellationToken,
    approvals: Approvals,
) -> anyhow::Result<()> {
    let conversation_id = conversation.id.clone();
    let workspace = crate::terminal::workspace_root(conversation);
    ::std::fs::create_dir_all(&workspace)?;

    let message_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content, model_id, created_at)
         VALUES (?, ?, 'assistant', '', ?, ?)",
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(&model.id)
    .bind(now_rfc3339())
    .execute(db)
    .await?;
    let _ = hub.send(
        ServerEvent::MessageStart {
            conversation_id: conversation_id.clone(),
            message_id: message_id.clone(),
            model_id: model.id.clone(),
            mode: ChatMode::Agent,
        }
        .to_json(),
    );

    // Transcript: agent system prompt (+ workspace overview) → history → task.
    let overview = fs::list(&workspace, "").unwrap_or_else(|_| "(empty workspace)".into());
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: format!("{system_prompt}\n\n# Çalışma alanı\n{overview}"),
    }];
    messages.extend(history.iter().cloned());

    let mut steps_done: u32 = 0;
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut any_estimated = false;
    let mut final_text = String::new();
    let mut failed: Option<String> = None;
    let mut cancelled = false;

    for step in 1..=MAX_STEPS {
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
        let request = ChatRequest {
            model: model.model_id.clone(),
            messages: messages.clone(),
            temperature: model.temperature.map(|t| t as f32),
            max_tokens: model.max_tokens.map(|t| t as u32),
            images: Vec::new(),
            web: false,
        };
        let prompt_chars: u64 =
            messages.iter().map(|m| estimate(&m.content)).sum::<u64>().max(1);

        let (text, usage) = match provider.stream_chat(request).await {
            Ok(mut stream) => {
                use futures_util::StreamExt;
                let mut text = String::new();
                let mut usage: Option<Usage> = None;
                let mut stream_error: Option<String> = None;
                loop {
                    tokio::select! {
                        event = stream.next() => {
                            let Some(event) = event else { break };
                            match event {
                                crate::providers::ChatEvent::TextDelta(delta) => text.push_str(&delta),
                                crate::providers::ChatEvent::ReasoningDelta(_) => {}
                                crate::providers::ChatEvent::Usage { tokens_in, tokens_out } => {
                                    usage = Some(Usage { tokens_in, tokens_out, estimated: false });
                                }
                                crate::providers::ChatEvent::Error { detail } => {
                                    stream_error = Some(detail);
                                    break;
                                }
                            }
                        }
                        () = cancel.cancelled() => {
                            cancelled = true;
                            break;
                        }
                    }
                }
                if let Some(detail) = stream_error {
                    failed = Some(detail);
                }
                (text, usage)
            }
            Err(error) => {
                failed = Some(error.to_string());
                (String::new(), None)
            }
        };
        if cancelled {
            final_text = text;
            break;
        }
        if let Some(detail) = &failed {
            let _ = hub.send(
                ServerEvent::Error {
                    conversation_id: Some(conversation_id.clone()),
                    message_id: Some(message_id.clone()),
                    code: ErrorCode::ProviderError,
                    detail: detail.clone(),
                }
                .to_json(),
            );
            break;
        }

        let usage = usage.unwrap_or_else(|| Usage {
            tokens_in: prompt_chars,
            tokens_out: estimate(&text),
            estimated: true,
        });
        total_in += usage.tokens_in;
        total_out += usage.tokens_out;
        any_estimated = any_estimated || usage.estimated;

        let Some((tool, args)) = parse_tool_call(&text) else {
            // Final answer: replay as token events so the UI streams it.
            for chunk in chunk_text(&text) {
                let _ = hub.send(
                    ServerEvent::Token {
                        conversation_id: conversation_id.clone(),
                        message_id: message_id.clone(),
                        delta: chunk,
                    }
                    .to_json(),
                );
            }
            final_text = text;
            break;
        };

        steps_done = step;
        let args_json = args.to_string();
        let _ = hub.send(
            ServerEvent::AgentToolStart {
                conversation_id: conversation_id.clone(),
                message_id: message_id.clone(),
                step,
                tool: tool.clone(),
                args_json: args_json.clone(),
            }
            .to_json(),
        );

        // Approval gate for mutating tools.
        let needs_approval =
            matches!(tool.as_str(), "fs_write" | "fs_delete" | "exec" | "git_commit");
        if needs_approval && !conversation.agent_auto_approve {
            let approved = request_approval(
                &hub,
                &approvals,
                &conversation_id,
                &message_id,
                &tool,
                &args_json,
            )
            .await;
            if !approved {
                let output = "Kullanıcı bu aracı reddetti. Alternatif bir yol dene ya da sorunu bildir."
                    .to_string();
                finish_step(db, &conversation_id, &message_id, step, &tool, &args_json, &output, false)
                    .await?;
                let _ = hub.send(
                    ServerEvent::AgentToolResult {
                        conversation_id: conversation_id.clone(),
                        message_id: message_id.clone(),
                        step,
                        tool: tool.clone(),
                        ok: false,
                        output: output.clone(),
                    }
                    .to_json(),
                );
                messages.push(ChatMessage { role: Role::Assistant, content: text.clone() });
                messages.push(ChatMessage {
                    role: Role::User,
                    content: format!("[ARAÇ SONUCU | {tool}]\n{output}"),
                });
                continue;
            }
        }

        let (ok, output) = execute_tool(&workspace, &tool, &args).await;
        finish_step(db, &conversation_id, &message_id, step, &tool, &args_json, &output, ok).await?;
        let _ = hub.send(
            ServerEvent::AgentToolResult {
                conversation_id: conversation_id.clone(),
                message_id: message_id.clone(),
                step,
                tool: tool.clone(),
                ok,
                output: output.clone(),
            }
            .to_json(),
        );

        messages.push(ChatMessage { role: Role::Assistant, content: text.clone() });
        let status_label = if ok { "ok" } else { "hata" };
        messages.push(ChatMessage {
            role: Role::User,
            content: format!("[ARAÇ SONUCU | {tool} ({status_label})]\n{output}"),
        });
    }

    tracing::debug!(steps = steps_done, "agent run finished");
    let status = if cancelled {
        MessageStatus::Cancelled
    } else if failed.is_some() {
        MessageStatus::Error
    } else {
        MessageStatus::Done
    };
    sqlx::query(
        "UPDATE messages SET content = ?, tokens_in = ?, tokens_out = ?, tokens_estimated = ?
         WHERE id = ?",
    )
    .bind(&final_text)
    .bind(total_in as i64)
    .bind(total_out as i64)
    .bind(any_estimated)
    .bind(&message_id)
    .execute(db)
    .await?;
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(now_rfc3339())
        .bind(&conversation_id)
        .execute(db)
        .await?;

    let _ = hub.send(
        ServerEvent::Usage {
            conversation_id: conversation_id.clone(),
            message_id: message_id.clone(),
            tokens_in: total_in,
            tokens_out: total_out,
            estimated: any_estimated,
        }
        .to_json(),
    );
    let _ = hub.send(
        ServerEvent::MessageDone {
            conversation_id,
            message_id,
            status,
        }
        .to_json(),
    );
    Ok(())
}

async fn execute_tool(workspace: &std::path::Path, tool: &str, args: &Value) -> (bool, String) {
    let arg = |name: &str| args.get(name).and_then(Value::as_str).unwrap_or("").to_string();
    let result: anyhow::Result<String> = match tool {
        "fs_list" => tokio::task::spawn_blocking({
            let root = workspace.to_path_buf();
            let path = arg("path");
            move || fs::list(&root, &path)
        })
        .await
        .map_err(anyhow::Error::from)
        .and_then(|r| r),
        "fs_read" => tokio::task::spawn_blocking({
            let root = workspace.to_path_buf();
            let path = arg("path");
            move || fs::read(&root, &path)
        })
        .await
        .map_err(anyhow::Error::from)
        .and_then(|r| r),
        "fs_write" => tokio::task::spawn_blocking({
            let root = workspace.to_path_buf();
            let path = arg("path");
            let content = arg("content");
            move || fs::write(&root, &path, &content)
        })
        .await
        .map_err(anyhow::Error::from)
        .and_then(|r| r),
        "fs_delete" => tokio::task::spawn_blocking({
            let root = workspace.to_path_buf();
            let path = arg("path");
            move || fs::delete(&root, &path)
        })
        .await
        .map_err(anyhow::Error::from)
        .and_then(|r| r),
        "git_status" => git::status(workspace).await,
        "git_diff" => git::diff(workspace).await,
        "git_commit" => git::commit(workspace, &arg("message")).await,
        "exec" => run_exec(workspace, &arg("command")).await,
        other => Err(anyhow::anyhow!("bilinmeyen araç: {other}")),
    };
    match result {
        Ok(output) => (true, truncate_output(&output)),
        Err(error) => (false, truncate_output(&error.to_string())),
    }
}

async fn run_exec(workspace: &std::path::Path, command: &str) -> anyhow::Result<String> {
    if command.trim().is_empty() {
        anyhow::bail!("boş komut");
    }
    let (program, args) = crate::terminal::shell_exec(command);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        tokio::process::Command::new(program)
            .args(args)
            .current_dir(workspace)
            .output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("komut zaman aşımına uğradı (45s))"))??;
    Ok(format!(
        "(exit {})\n{}",
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout)
    ))
}

fn truncate_output(text: &str) -> String {
    const MAX: usize = 12_000;
    if text.len() <= MAX {
        return text.to_string();
    }
    format!("{}… (kısaltıldı)", &text[..MAX])
}

fn chunk_text(text: &str) -> Vec<String> {
    const CHUNK: usize = 24;
    text.chars()
        .collect::<Vec<_>>()
        .chunks(CHUNK)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

async fn request_approval(
    hub: &broadcast::Sender<String>,
    approvals: &Approvals,
    conversation_id: &str,
    message_id: &str,
    tool: &str,
    args_json: &str,
) -> bool {
    let (tx, rx) = oneshot::channel();
    let approval_id = uuid::Uuid::new_v4().to_string();
    approvals.lock().unwrap().insert(approval_id.clone(), tx);
    let _ = hub.send(
        ServerEvent::AgentApprovalRequest {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            approval_id,
            tool: tool.to_string(),
            args_json: args_json.to_string(),
            timeout_secs: APPROVAL_TIMEOUT_SECS,
        }
        .to_json(),
    );
    let verdict = tokio::time::timeout(
        std::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS),
        rx,
    )
    .await;
    match verdict {
        Ok(Ok(approved)) => approved,
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish_step(
    db: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
    seq: u32,
    tool: &str,
    args_json: &str,
    output: &str,
    ok: bool,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO agent_steps (id, conversation_id, message_id, seq, tool, args_json, result, ok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(conversation_id)
    .bind(message_id)
    .bind(seq as i64)
    .bind(tool)
    .bind(args_json)
    .bind(output)
    .bind(ok)
    .bind(now_rfc3339())
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_block() {
        let text = "Bir şeyler yapayım:\n```tool\n{\"tool\":\"fs_read\",\"args\":{\"path\":\"a.rs\"}}\n```\n";
        let (tool, args) = parse_tool_call(text).unwrap();
        assert_eq!(tool, "fs_read");
        assert_eq!(args["path"], "a.rs");
    }

    #[test]
    fn takes_last_tool_block_and_rejects_plain_text() {
        let two = "```tool\n{\"tool\":\"fs_list\",\"args\":{}}\n```\ngeçici\n```tool\n{\"tool\":\"exec\",\"args\":{\"command\":\"ls\"}}\n```";
        assert_eq!(parse_tool_call(two).unwrap().0, "exec");
        assert!(parse_tool_call("merhaba dünya").is_none());
        assert!(parse_tool_call("```json\n{\"tool\":\"x\"}\n```").is_none());
    }
}
