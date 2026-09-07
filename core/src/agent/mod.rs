//! Coding agent loop (plan §5.3–5.4): a tool-using single-model run.
//!
//! Protocol: when the provider supports native function calling (`tools` in the
//! request), the model answers with `ChatEvent::ToolCalls`; the engine executes
//! each call (asking for approval — with a unified diff for file mutations —
//! when the conversation requires it), feeds the results back as tool messages
//! and loops. Providers without native tools fall back to the legacy single
//! fenced block ```tool {"tool":"…","args":{…}}``` protocol. Only the final
//! (tool-free) reply becomes the assistant message; tool traffic is streamed as
//! `agent_tool_start` / `agent_tool_result` events and persisted into
//! `agent_steps`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;

use crate::events::{ChatMode, ErrorCode, MessageStatus, ServerEvent};
use crate::fs;
use crate::git;
use crate::providers::{
    ChatEvent, ChatMessage, ChatRequest, Provider, Role, ToolCall, ToolSpec,
};
use crate::storage::{now_rfc3339, Conversation, ModelRow};
use crate::tokens::{estimate, Usage};

pub const MAX_STEPS: u32 = 8;
const APPROVAL_TIMEOUT_SECS: u64 = 180;

pub type Approvals = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

/// Native tool declarations offered to tool-capable providers.
fn build_tool_specs() -> Vec<ToolSpec> {
    let object = || json!({ "type": "object", "additionalProperties": false });
    vec![
        ToolSpec {
            name: "fs_list".into(),
            description: "List files in the workspace (path is relative to the workspace root, empty = root).".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "additionalProperties": false }),
        },
        ToolSpec {
            name: "fs_read".into(),
            description: "Read a file from the workspace; path is relative to the workspace root.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "fs_write".into(),
            description: "Write/overwrite a file in the workspace (approval is requested; the diff is shown).".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "fs_delete".into(),
            description: "Delete a file from the workspace (approval is requested; the diff is shown).".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "git_status".into(),
            description: "Show the git working tree status in the workspace repo.".into(),
            parameters: object(),
        },
        ToolSpec {
            name: "git_diff".into(),
            description: "Show the uncommitted git diff in the workspace repo.".into(),
            parameters: object(),
        },
        ToolSpec {
            name: "git_commit".into(),
            description: "Commit all current changes in the workspace repo (approval is requested).".into(),
            parameters: json!({ "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"], "additionalProperties": false }),
        },
        ToolSpec {
            name: "exec".into(),
            description: "Run a shell command in the workspace (approval is requested; 45s limit).".into(),
            parameters: json!({ "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"], "additionalProperties": false }),
        },
    ]
}

/// Extracts the last ```tool fenced JSON block from a model reply (legacy
/// protocol for providers without native function calling).
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
            race_id: None,
        }
        .to_json(),
    );

    // Transcript: agent system prompt (+ workspace snapshot) → history → task.
    let overview = match fs::snapshot(&workspace) {
        Ok(snapshot) => snapshot,
        Err(error) => format!("(çalışma alanı okunamadı: {error})"),
    };
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: format!(
            "{system_prompt}\n\n{}\n\n# Çalışma alanı\n{overview}",
            crate::prompts::capability_notice()
        ),
        ..Default::default()
    }];
    messages.extend(history.iter().cloned());

    let mut steps_done: u32 = 0;
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut any_estimated = false;
    let mut final_text = String::new();
    let mut failed: Option<String> = None;
    let mut cancelled = false;
    let mut resolved: Option<String> = None;

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
            reasoning_enabled: model.reasoning_enabled.unwrap_or(model.supports_reasoning),
            reasoning_effort: model.reasoning_effort.clone(),
            tools: build_tool_specs(),
            tool_choice: None,
        };
        let prompt_chars: u64 =
            messages.iter().map(|m| estimate(&m.content)).sum::<u64>().max(1);

        let (text, tool_calls, usage, step_resolved) = match provider.stream_chat(request).await {
            Ok(mut stream) => {
                use futures_util::StreamExt;
                let mut text = String::new();
                let mut tool_calls: Vec<ToolCall> = Vec::new();
                let mut usage: Option<Usage> = None;
                let mut resolved_model: Option<String> = None;
                let mut stream_error: Option<String> = None;
                loop {
                    tokio::select! {
                        event = stream.next() => {
                            let Some(event) = event else { break };
                            match event {
                                ChatEvent::TextDelta(delta) => text.push_str(&delta),
                                ChatEvent::ReasoningDelta(_) => {}
                                ChatEvent::ModelResolved(resolved) => {
                                    if resolved_model.is_none() {
                                        resolved_model = Some(resolved.clone());
                                        let _ = hub.send(
                                            ServerEvent::ModelResolved {
                                                conversation_id: conversation_id.clone(),
                                                message_id: message_id.clone(),
                                                model_id: resolved,
                                            }
                                            .to_json(),
                                        );
                                    }
                                }
                                ChatEvent::ToolCalls(calls) => tool_calls = calls,
                                ChatEvent::Usage { tokens_in, tokens_out } => {
                                    usage = Some(Usage { tokens_in, tokens_out, estimated: false });
                                }
                                ChatEvent::Error { detail } => {
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
                (text, tool_calls, usage, resolved_model)
            }
            Err(error) => {
                failed = Some(error.to_string());
                (String::new(), Vec::new(), None, None)
            }
        };
        if step_resolved.is_some() {
            resolved = step_resolved;
        }
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

        // Native function calls (preferred) vs the legacy ```tool block.
        let native_calls: Vec<ToolCall> = tool_calls
            .into_iter()
            .filter(|call| !call.name.trim().is_empty())
            .collect();
        if !native_calls.is_empty() {
            steps_done = step;
            // Execute every call ONCE; the outputs feed both the UI events and
            // the tool-result messages.
            let mut outputs: Vec<(ToolCall, bool, String)> = Vec::new();
            for call in &native_calls {
                let args_json = call.arguments.to_string();
                let _ = hub.send(
                    ServerEvent::AgentToolStart {
                        conversation_id: conversation_id.clone(),
                        message_id: message_id.clone(),
                        step,
                        tool: call.name.clone(),
                        args_json: args_json.clone(),
                    }
                    .to_json(),
                );

                let (ok, output) = approved_or_execute(
                    &workspace,
                    conversation,
                    &hub,
                    &approvals,
                    &conversation_id,
                    &message_id,
                    step,
                    &call.name,
                    &call.arguments,
                    &args_json,
                )
                .await;

                finish_step(db, &conversation_id, &message_id, step, &call.name, &args_json, &output, ok)
                    .await?;
                let _ = hub.send(
                    ServerEvent::AgentToolResult {
                        conversation_id: conversation_id.clone(),
                        message_id: message_id.clone(),
                        step,
                        tool: call.name.clone(),
                        ok,
                        output: output.clone(),
                    }
                    .to_json(),
                );
                outputs.push((call.clone(), ok, output));
            }
            // Assistant message with the native calls + one tool-result message
            // per call (OpenAI/Anthropic match the provider call id; Gemini's
            // synthetic id == name).
            messages.push(ChatMessage {
                role: Role::Assistant,
                content: text.clone(),
                tool_calls: native_calls,
                tool_call_id: None,
            });
            for (call, ok, output) in outputs {
                messages.push(ChatMessage {
                    role: Role::Tool,
                    content: tool_result_text(ok, &output),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(call.id),
                });
            }
            continue;
        }

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

        let (ok, output) = run_legacy_tool(&workspace, conversation, &hub, &approvals, &conversation_id, &message_id, step, &tool, &args, &args_json)
            .await;
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

        messages.push(ChatMessage {
            role: Role::Assistant,
            content: text.clone(),
            ..Default::default()
        });
        let status_label = if ok { "ok" } else { "hata" };
        messages.push(ChatMessage {
            role: Role::User,
            content: format!("[ARAÇ SONUCU | {tool} ({status_label})]\n{output}"),
            ..Default::default()
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
        "UPDATE messages SET content = ?, tokens_in = ?, tokens_out = ?, tokens_estimated = ?,
                resolved_model = ? WHERE id = ?",
    )
    .bind(&final_text)
    .bind(total_in as i64)
    .bind(total_out as i64)
    .bind(any_estimated)
    .bind(&resolved)
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

fn tool_result_text(ok: bool, output: &str) -> String {
    if ok {
        format!("[ARAÇ SONUCU | ok]\n{output}")
    } else {
        format!("[ARAÇ SONUCU | hata]\n{output}")
    }
}

/// Legacy ```tool protocol path: parse → approval → execute → result.
#[allow(clippy::too_many_arguments)]
async fn run_legacy_tool(
    workspace: &std::path::Path,
    conversation: &Conversation,
    hub: &broadcast::Sender<String>,
    approvals: &Approvals,
    conversation_id: &str,
    message_id: &str,
    step: u32,
    tool: &str,
    args: &Value,
    args_json: &str,
) -> (bool, String) {
    approved_or_execute(
        workspace,
        conversation,
        hub,
        approvals,
        conversation_id,
        message_id,
        step,
        tool,
        args,
        args_json,
    )
    .await
}

/// Approval gate + execution shared by both protocols.
#[allow(clippy::too_many_arguments)]
async fn approved_or_execute(
    workspace: &std::path::Path,
    conversation: &Conversation,
    hub: &broadcast::Sender<String>,
    approvals: &Approvals,
    conversation_id: &str,
    message_id: &str,
    step: u32,
    tool: &str,
    args: &Value,
    args_json: &str,
) -> (bool, String) {
    // Approval gate for mutating tools.
    let needs_approval =
        matches!(tool, "fs_write" | "fs_delete" | "exec" | "git_commit");
    if needs_approval && !conversation.agent_auto_approve {
        let diff = pending_diff(workspace, tool, args);
        let approved = request_approval(
            hub,
            approvals,
            conversation_id,
            message_id,
            tool,
            args_json,
            diff.as_deref(),
        )
        .await;
        if !approved {
            let output = "Kullanıcı bu aracı reddetti. Alternatif bir yol dene ya da sorunu bildir."
                .to_string();
            return (false, output);
        }
    }
    execute_tool(workspace, tool, args).await
}

/// Unified diff of the change `tool` would apply (`None` for non-file tools or
/// unreadable files). New files show as all-`+`; deletions as all-`-`.
fn pending_diff(workspace: &std::path::Path, tool: &str, args: &Value) -> Option<String> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    if path.is_empty() {
        return None;
    }
    let old = match tool {
        "fs_write" | "fs_delete" => fs::read(workspace, path).unwrap_or_default(),
        _ => return None,
    };
    let new = match tool {
        "fs_write" => args.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        "fs_delete" => String::new(),
        _ => return None,
    };
    Some(unified_diff(path, &old, &new))
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
    .map_err(|_| anyhow::anyhow!("komut zaman aşımına uğradı (45s)"))??;
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
    diff: Option<&str>,
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
            diff: diff.map(str::to_string),
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

/// Minimal unified diff for the approval dialog: common prefix/suffix trimming
/// then a greedy line diff (no line moves). Good enough to review a change.
fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut header = format!("--- {path}\n+++ {path}\n");
    if old_lines == new_lines {
        header.push_str("(no change)\n");
        return header;
    }
    // Common prefix.
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    // Common suffix (not overlapping the prefix).
    let mut suffix = 0;
    while suffix < old_lines.len() - prefix
        && suffix < new_lines.len() - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    // Longest common subsequence over the trimmed middles (cap the DP size).
    let old_mid = &old_lines[prefix..old_lines.len() - suffix];
    let new_mid = &new_lines[prefix..new_lines.len() - suffix];
    if old_mid.len() * new_mid.len() > 2_000_000 {
        // Too big for the DP table: show the whole middle as -/+ blocks.
        return format!(
            "{header}@@ -{prefix},{} +{prefix},{} @@\n{}{}",
            old_mid.len(),
            new_mid.len(),
            old_mid.iter().map(|line| format!("-{line}\n")).collect::<String>(),
            new_mid.iter().map(|line| format!("+{line}\n")).collect::<String>(),
        );
    }
    let mut table = vec![vec![0usize; new_mid.len() + 1]; old_mid.len() + 1];
    for i in (0..old_mid.len()).rev() {
        for j in (0..new_mid.len()).rev() {
            table[i][j] = if old_mid[i] == new_mid[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    header.push_str(&format!(
        "@@ -{prefix},{} +{prefix},{} @@\n",
        old_mid.len(),
        new_mid.len()
    ));
    let mut out = header;
    let (mut i, mut j) = (0, 0);
    while i < old_mid.len() || j < new_mid.len() {
        if j < new_mid.len() && (i == old_mid.len() || table[i][j + 1] >= table[i + 1][j]) {
            out.push('+');
            out.push_str(new_mid[j]);
            out.push('\n');
            j += 1;
        } else if i < old_mid.len() {
            out.push('-');
            out.push_str(old_mid[i]);
            out.push('\n');
            i += 1;
        } else {
            out.push('+');
            out.push_str(new_mid[j]);
            out.push('\n');
            j += 1;
        }
    }
    out
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

    #[test]
    fn diff_shows_change_and_new_file() {
        let diff = unified_diff("a.txt", "satır 1\nsatır 2\n", "satır 1\ndeğişti\n");
        assert!(diff.contains("-satır 2"), "{diff}");
        assert!(diff.contains("+değişti"), "{diff}");
        assert!(diff.starts_with("--- a.txt\n+++ a.txt\n"), "{diff}");

        let new_file = unified_diff("b.txt", "", "merhaba\n");
        assert!(new_file.contains("+merhaba"), "{new_file}");
    }

    #[test]
    fn diff_handles_identical_and_empty() {
        assert!(unified_diff("a", "x\n", "x\n").contains("(no change)"));
        assert!(unified_diff("a", "", "").contains("(no change)"));
    }

    #[test]
    fn tool_specs_cover_legacy_tools() {
        let specs = build_tool_specs();
        let names: Vec<&str> = specs.iter().map(|spec| spec.name.as_str()).collect();
        for expected in ["fs_list", "fs_read", "fs_write", "fs_delete", "git_status", "git_diff", "git_commit", "exec"] {
            assert!(names.contains(&expected), "missing {expected}");
        }
    }
}
