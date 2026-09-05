//! Typed WebSocket event envelope — mirrors `docs/EVENTS.md`.
//!
//! Phase 0: hello / ping / pong / echo / error (loopback + liveness).
//! Phase 1: single-model chat streaming (send_message → message_start →
//! token | reasoning_token → usage → message_done).

use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "polylab-v1";

/// Client → server events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    Ping,
    Echo {
        text: String,
    },
    SendMessage {
        conversation_id: String,
        content: String,
        #[serde(default)]
        attachments: Vec<AttachmentIn>,
    },
    Cancel {
        conversation_id: String,
    },
    /// Answer to an `agent_approval_request` (Phase 4).
    AgentApprove {
        approval_id: String,
        approved: bool,
    },
    /// Run a shell command in the conversation's workspace; output streams back
    /// as `terminal_output` events (Phase 5).
    TerminalRun {
        conversation_id: String,
        command: String,
    },
    /// Start a persistent interactive shell session for a conversation
    /// (cwd/env survive between inputs; one session per conversation).
    TerminalStart {
        conversation_id: String,
    },
    /// Write raw characters (a full command line ending in \n) to the session.
    TerminalInput {
        conversation_id: String,
        data: String,
    },
    /// Kill the session (there is no TTY, so Ctrl+C semantics do not apply).
    TerminalKill {
        conversation_id: String,
    },
}

/// An attachment sent with a message: plain text (appended to the prompt) or a
/// base64 image (vision content parts). Exactly one of `text` / `data_base64`
/// is set for a given kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentIn {
    pub name: String,
    #[serde(default)]
    pub text: String,
    /// e.g. "image/png" — required when `data_base64` is present.
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub data_base64: Option<String>,
}

impl AttachmentIn {
    /// `data:{mime};base64,{data}` when this is an image attachment.
    pub fn data_uri(&self) -> Option<String> {
        let mime = self.mime_type.as_deref()?;
        if !mime.starts_with("image/") {
            return None;
        }
        self.data_base64
            .as_deref()
            .map(|data| format!("data:{mime};base64,{data}"))
    }
}

/// Server → client events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Hello {
        name: String,
        version: String,
    },
    Pong,
    Echo {
        text: String,
    },
    Error {
        conversation_id: Option<String>,
        message_id: Option<String>,
        code: ErrorCode,
        detail: String,
    },
    MessageStart {
        conversation_id: String,
        message_id: String,
        model_id: String,
        mode: ChatMode,
    },
    Token {
        conversation_id: String,
        message_id: String,
        delta: String,
    },
    ReasoningToken {
        conversation_id: String,
        message_id: String,
        model_id: String,
        delta: String,
    },
    Usage {
        conversation_id: String,
        message_id: String,
        tokens_in: u64,
        tokens_out: u64,
        estimated: bool,
    },
    MessageDone {
        conversation_id: String,
        message_id: String,
        status: MessageStatus,
    },
    DebateRoundStart {
        conversation_id: String,
        debate_id: String,
        round: u32,
        phase: DebatePhase,
    },
    DebateTurnToken {
        conversation_id: String,
        debate_id: String,
        round: u32,
        model_id: String,
        anon_label: String,
        delta: String,
    },
    DebateTurnReasoningToken {
        conversation_id: String,
        debate_id: String,
        round: u32,
        model_id: String,
        anon_label: String,
        delta: String,
    },
    DebateTurnDone {
        conversation_id: String,
        debate_id: String,
        round: u32,
        model_id: String,
        anon_label: String,
        tokens_in: u64,
        tokens_out: u64,
    },
    DebateConsensus {
        conversation_id: String,
        debate_id: String,
        reached: bool,
        reason: String,
    },
    DebateDone {
        conversation_id: String,
        debate_id: String,
        total_tokens_in: u64,
        total_tokens_out: u64,
    },
    AgentToolStart {
        conversation_id: String,
        message_id: String,
        step: u32,
        tool: String,
        args_json: String,
    },
    AgentToolResult {
        conversation_id: String,
        message_id: String,
        step: u32,
        tool: String,
        ok: bool,
        output: String,
    },
    AgentApprovalRequest {
        conversation_id: String,
        message_id: String,
        approval_id: String,
        tool: String,
        args_json: String,
        timeout_secs: u64,
    },
    TerminalOutput {
        conversation_id: String,
        seq: u64,
        chunk: String,
    },
    TerminalExit {
        conversation_id: String,
        code: Option<i64>,
    },
    TerminalStarted {
        conversation_id: String,
    },
}

/// Debate phases. The critique+revise step of plan §5.2 is one round on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DebatePhase {
    Initial,
    Critique,
    Synthesis,
}

/// `mode` on `message_start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMode {
    Single,
    Debate,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Done,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    BadRequest,
    Internal,
    NotFound,
    ProviderError,
    RateLimited,
    Timeout,
    Cancelled,
}

impl ServerEvent {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server events always serialize")
    }
}

pub fn parse_client_event(raw: &str) -> Result<ClientEvent, serde_json::Error> {
    serde_json::from_str(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_events_round_trip() {
        let ping = r#"{"type":"ping"}"#;
        assert_eq!(parse_client_event(ping).unwrap(), ClientEvent::Ping);

        let echo = r#"{"type":"echo","text":"merhaba"}"#;
        assert_eq!(
            parse_client_event(echo).unwrap(),
            ClientEvent::Echo { text: "merhaba".into() }
        );

        let send = r#"{"type":"send_message","conversation_id":"c1","content":"selam"}"#;
        assert_eq!(
            parse_client_event(send).unwrap(),
            ClientEvent::SendMessage {
                conversation_id: "c1".into(),
                content: "selam".into(),
                attachments: Vec::new(),
            }
        );

        let send_att = r#"{"type":"send_message","conversation_id":"c1","content":"selam",
            "attachments":[{"name":"a.txt","text":"içerik"}]}"#;
        assert_eq!(
            parse_client_event(send_att).unwrap(),
            ClientEvent::SendMessage {
                conversation_id: "c1".into(),
                content: "selam".into(),
                attachments: vec![AttachmentIn {
                    name: "a.txt".into(),
                    text: "içerik".into(),
                    mime_type: None,
                    data_base64: None,
                }],
            }
        );

        let approve = r#"{"type":"agent_approve","approval_id":"ap1","approved":true}"#;
        assert_eq!(
            parse_client_event(approve).unwrap(),
            ClientEvent::AgentApprove { approval_id: "ap1".into(), approved: true }
        );

        let term = r#"{"type":"terminal_run","conversation_id":"c1","command":"ls"}"#;
        assert!(matches!(
            parse_client_event(term).unwrap(),
            ClientEvent::TerminalRun { .. }
        ));

        let start = r#"{"type":"terminal_start","conversation_id":"c1"}"#;
        assert!(matches!(
            parse_client_event(start).unwrap(),
            ClientEvent::TerminalStart { .. }
        ));
        let input = r#"{"type":"terminal_input","conversation_id":"c1","data":"ls\n"}"#;
        assert!(matches!(
            parse_client_event(input).unwrap(),
            ClientEvent::TerminalInput { .. }
        ));
        let kill = r#"{"type":"terminal_kill","conversation_id":"c1"}"#;
        assert!(matches!(
            parse_client_event(kill).unwrap(),
            ClientEvent::TerminalKill { .. }
        ));
    }

    #[test]
    fn unknown_client_event_is_rejected() {
        assert!(parse_client_event(r#"{"type":"approve_change"}"#).is_err());
        assert!(parse_client_event("not json").is_err());
    }

    #[test]
    fn server_events_use_snake_case_types() {
        let event = ServerEvent::Hello {
            name: "polylab-core".into(),
            version: "0.1.0".into(),
        };
        let json = event.to_json();
        assert!(json.contains(r#""type":"hello""#), "{json}");

        let event = ServerEvent::Token {
            conversation_id: "c1".into(),
            message_id: "m1".into(),
            delta: "x".into(),
        };
        assert!(event.to_json().contains(r#""type":"token""#));

        let event = ServerEvent::MessageDone {
            conversation_id: "c1".into(),
            message_id: "m1".into(),
            status: MessageStatus::Cancelled,
        };
        let json = event.to_json();
        assert!(json.contains(r#""type":"message_done""#), "{json}");
        assert!(json.contains(r#""status":"cancelled""#), "{json}");

        let event = ServerEvent::DebateTurnToken {
            conversation_id: "c1".into(),
            debate_id: "d1".into(),
            round: 2,
            model_id: "m-3".into(),
            anon_label: "Model B".into(),
            delta: "x".into(),
        };
        let json = event.to_json();
        assert!(json.contains(r#""type":"debate_turn_token""#), "{json}");
        assert!(json.contains(r#""anon_label":"Model B""#), "{json}");

        let event = ServerEvent::DebateRoundStart {
            conversation_id: "c1".into(),
            debate_id: "d1".into(),
            round: 1,
            phase: DebatePhase::Initial,
        };
        assert!(event.to_json().contains(r#""phase":"initial""#));
    }
}
