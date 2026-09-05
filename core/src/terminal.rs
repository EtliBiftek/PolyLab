//! Workspace terminal (plan §5.5): one-shot shell commands with streamed output.
//!
//! Not a full interactive PTY — each `terminal_run` executes a command in the
//! conversation's workspace and streams stdout+stderr chunks over the hub.

use sqlx::SqlitePool;
use tokio::io::AsyncReadExt;
use tokio::sync::broadcast;

use crate::events::ServerEvent;
use crate::storage::Conversation;

const MAX_OUTPUT_BYTES: usize = 200 * 1024;
const TIMEOUT_SECS: u64 = 60;

/// Spawns `bash -c command` in the conversation workspace, streaming output.
/// Returns immediately; the task emits `terminal_output` / `terminal_exit`.
pub fn spawn_run(
    db: SqlitePool,
    hub: broadcast::Sender<String>,
    conversation: Conversation,
    command: String,
) {
    tokio::spawn(async move {
        let conversation_id = conversation.id.clone();
        let workspace = workspace_root(&conversation);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(TIMEOUT_SECS),
            run_command(workspace, command, tx.clone()),
        )
        .await;

        let code = match result {
            Ok(Ok(code)) => code,
            Ok(Err(error)) => {
                let _ = tx.send(format!("spawn failed: {error}"));
                None
            }
            Err(_) => None, // timed out; the task was aborted mid-flight
        };
        drop(tx);

        let mut seq: u64 = 0;
        while let Some(chunk) = rx.recv().await {
            let _ = hub.send(
                ServerEvent::TerminalOutput {
                    conversation_id: conversation_id.clone(),
                    seq,
                    chunk,
                }
                .to_json(),
            );
            seq += 1;
        }
        let _ = db; // reserved for future cwd/history persistence
        let _ = hub.send(
            ServerEvent::TerminalExit { conversation_id, code: code.map(|c| c as i64) }.to_json(),
        );
    });
}

async fn run_command(
    workspace: std::path::PathBuf,
    command: String,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
) -> anyhow::Result<Option<i32>> {
    // Merge stderr into stdout so a single pipe carries everything.
    let mut child = tokio::process::Command::new("bash")
        .arg("-c")
        .arg(format!("{command} 2>&1"))
        .current_dir(&workspace)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut written = 0usize;
    let mut buffer = vec![0u8; 8192];
    loop {
        let read = stdout.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        written += read;
        let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
        if tx.send(chunk).is_err() {
            break; // receiver gone
        }
        if written > MAX_OUTPUT_BYTES {
            let _ = tx.send("\n… (çıktı sınırına ulaşıldı)".into());
            break;
        }
    }

    let status = child.wait().await?;
    Ok(status.code())
}

/// Workspace dir: the conversation's project_path when set, else the default
/// shared workspace under the data dir.
pub fn workspace_root(conversation: &Conversation) -> std::path::PathBuf {
    conversation
        .project_path
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(
                std::env::var("POLYLAB_DATA_DIR").unwrap_or_else(|_| ".".into()),
            )
            .join("workspace")
        })
}
