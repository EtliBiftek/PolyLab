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
    let (program, args) = shell_exec(&command);
    let mut child = tokio::process::Command::new(program)
        .args(args)
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

/// Platform shell: unix keeps bash; windows falls back to cmd.exe (bash only
/// exists there when Git Bash/WSL is installed, and spawning a missing binary
/// would kill terminal sessions and the agent `exec` tool entirely).
pub fn shell_exec(command: &str) -> (&'static str, Vec<String>) {
    if cfg!(windows) {
        // cmd understands `2>&1` redirection the same way.
        ("cmd", vec!["/C".into(), format!("{command} 2>&1")])
    } else {
        ("bash", vec!["-c".into(), format!("{command} 2>&1")])
    }
}

/// Interactive session program: reads commands from piped stdin.
pub fn shell_interactive() -> (&'static str, Vec<String>) {
    if cfg!(windows) {
        // `/K` keeps cmd alive reading stdin lines (no TTY, same as bash -i here).
        ("cmd", vec!["/K".into()])
    } else {
        ("bash", vec!["-i".into()])
    }
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

/* ------------------------------------------------------- interactive shell -- */

pub struct ShellSession {
    stdin: std::sync::Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
    child: tokio::process::Child,
}

/// One persistent `bash -i` session per conversation: stdin is writable, so
/// cwd/env survive between `terminal_input` events (no TTY — ^C does not
/// generate SIGINT; use `terminal_kill`).
#[derive(Clone, Default)]
pub struct Terminals {
    sessions: std::sync::Arc<std::sync::Mutex<HashMapSessions>>,
}

type HashMapSessions = std::collections::HashMap<String, ShellSession>;

impl Terminals {
    /// Spawns (or replaces) the session and streams its merged output on the hub.
    pub fn start(&self, hub: broadcast::Sender<String>, conversation: &Conversation) {
        let conversation_id = conversation.id.clone();
        let workspace = workspace_root(conversation);
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut old) = sessions.remove(&conversation_id) {
            let _ = old.child.start_kill();
        }

        let (program, args) = shell_interactive();
        let mut child = tokio::process::Command::new(program)
            .args(args)
            .current_dir(&workspace)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                let _ = hub.send(
                    ServerEvent::TerminalOutput {
                        conversation_id: conversation_id.clone(),
                        seq: 0,
                        chunk: format!("oturum başlatılamadı: {error}"),
                    }
                    .to_json(),
                );
                return;
            }
        };
        let raw_stdin = child.stdin.take().expect("piped stdin");
        let stdin = std::sync::Arc::new(tokio::sync::Mutex::new(raw_stdin));
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        // Pump stdout+stderr sequentially-merged (stdout first keeps ordering sane).
        let hub_out = hub.clone();
        let id_out = conversation_id.clone();
        let seq = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let seq_out = std::sync::Arc::clone(&seq);
        tokio::spawn(async move {
            let mut stream = stdout;
            use tokio::io::AsyncReadExt;
            let mut buffer = vec![0u8; 8192];
            let mut written = 0usize;
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        written += n;
                        let chunk = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = hub_out.send(
                            ServerEvent::TerminalOutput {
                                conversation_id: id_out.clone(),
                                seq: seq_out.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                                chunk,
                            }
                            .to_json(),
                        );
                        if written > 400 * 1024 {
                            let _ = hub_out.send(
                                ServerEvent::TerminalOutput {
                                    conversation_id: id_out.clone(),
                                    seq: seq_out.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                                    chunk: "\\n… (oturum çıktı sınırı)".into(),
                                }
                                .to_json(),
                            );
                            break;
                        }
                    }
                }
            }
        });
        let hub_err = hub.clone();
        let id_err = conversation_id.clone();
        let seq_err = std::sync::Arc::clone(&seq);
        tokio::spawn(async move {
            let mut stream = stderr;
            use tokio::io::AsyncReadExt;
            let mut buffer = vec![0u8; 8192];
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = hub_err.send(
                            ServerEvent::TerminalOutput {
                                conversation_id: id_err.clone(),
                                seq: seq_err.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                                chunk,
                            }
                            .to_json(),
                        );
                    }
                }
            }
        });

        // Wait for exit and notify.
        let hub_exit = hub.clone();
        let id_exit = conversation_id.clone();
        let sessions_exit = std::sync::Arc::downgrade(&self.sessions);
        tokio::spawn(async move {
            // We no longer own `child` here (moved into the map); the exit is
            // detected via the stdout pump ending — approximate with try_wait.
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                if let Some(map) = sessions_exit.upgrade() {
                    let mut guard = map.lock().unwrap();
                    match guard.get_mut(&id_exit) {
                        Some(session) => {
                            if let Ok(Some(status)) = session.child.try_wait() {
                                guard.remove(&id_exit);
                                drop(guard);
                                let _ = hub_exit.send(
                                    ServerEvent::TerminalExit {
                                        conversation_id: id_exit.clone(),
                                        code: status.code().map(|c| c as i64),
                                    }
                                    .to_json(),
                                );
                                return;
                            }
                        }
                        None => {
                            // Removed by kill — the killer emits the exit event.
                            return;
                        }
                    }
                } else {
                    return;
                }
            }
        });

        sessions.insert(conversation_id.clone(), ShellSession { stdin, child });
        drop(sessions);
        let _ = hub.send(
            ServerEvent::TerminalStarted { conversation_id }.to_json(),
        );
    }

    /// Writes a raw line (caller includes the trailing \\n) to the session stdin.
    pub async fn input(&self, conversation_id: &str, data: &str) -> bool {
        let stdin = {
            let guard = self.sessions.lock().unwrap();
            let Some(session) = guard.get(conversation_id) else { return false };
            std::sync::Arc::clone(&session.stdin)
        };
        use tokio::io::AsyncWriteExt as _;
        let mut stdin = stdin.lock().await;
        let ok = stdin.write_all(data.as_bytes()).await.is_ok();
        let flushed = stdin.flush().await.is_ok();
        ok && flushed
    }

    /// Kills the session; emits `terminal_exit` when it goes down.
    pub fn kill(&self, hub: broadcast::Sender<String>, conversation_id: &str) {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(mut session) = guard.remove(conversation_id) {
            let _ = session.child.start_kill();
        }
        drop(guard);
        let _ = hub.send(
            ServerEvent::TerminalExit {
                conversation_id: conversation_id.to_string(),
                code: None,
            }
            .to_json(),
        );
    }
}
