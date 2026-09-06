//! WebSocket endpoint.
//!
//! Two directions on one socket:
//!  - inbound: loopback events (ping/echo) answered inline; `send_message`/`cancel`
//!    dispatched to the chat engine (spawned — the loop never blocks on generation)
//!  - outbound: everything on the hub (`ServerEvent` JSON) is forwarded to the client

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};

use crate::events::{self, ClientEvent, ErrorCode, ServerEvent};
use crate::state::AppState;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.protocols([events::PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state))
}

pub async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut hub = state.hub.subscribe();

    let hello = ServerEvent::Hello {
        name: state.name.to_string(),
        version: state.version.to_string(),
    };
    if sender.send(Message::Text(hello.to_json().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            inbound = receiver.next() => {
                let Some(Ok(message)) = inbound else { break };
                match message {
                    Message::Text(text) => {
                        let reply = handle_client_event(&state, &text).await;
                        if let Some(reply) = reply {
                            if sender.send(Message::Text(reply.to_json().into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Binary(_) => {
                        let reply = ServerEvent::Error {
                            conversation_id: None,
                            message_id: None,
                            code: ErrorCode::BadRequest,
                            detail: "binary frames are not supported".into(),
                        };
                        if sender.send(Message::Text(reply.to_json().into())).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            outbound = hub.recv() => {
                match outbound {
                    Ok(event) => {
                        if sender.send(Message::Text(event.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "ws client lagged on hub; events were dropped");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    let _ = sender.send(Message::Close(None)).await;
}

/// Returns a direct reply for loopback events; engine events return `None`
/// (their responses arrive through the hub).
async fn handle_client_event(state: &AppState, raw: &str) -> Option<ServerEvent> {
    match events::parse_client_event(raw) {
        Ok(ClientEvent::Ping) => Some(ServerEvent::Pong),
        Ok(ClientEvent::Echo { text }) => Some(ServerEvent::Echo { text }),
        Ok(ClientEvent::SendMessage { conversation_id, content, attachments, web }) => {
            if content.trim().is_empty() {
                return Some(ServerEvent::Error {
                    conversation_id: Some(conversation_id),
                    message_id: None,
                    code: ErrorCode::BadRequest,
                    detail: "message content is empty".into(),
                });
            }
            state.engine.dispatch_send(conversation_id, content, attachments, web);
            None
        }
        Ok(ClientEvent::AgentApprove { approval_id, approved }) => {
            state.engine.resolve_approval(&approval_id, approved);
            None
        }
        Ok(ClientEvent::TerminalRun { conversation_id, command }) => {
            let conversation: Option<crate::storage::Conversation> = sqlx::query_as(
                "SELECT * FROM conversations WHERE id = ?",
            )
            .bind(&conversation_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
            match conversation {
                Some(conversation) => {
                    crate::terminal::spawn_run(
                        state.db.clone(),
                        state.hub.clone(),
                        conversation,
                        command,
                    );
                    None
                }
                None => Some(ServerEvent::Error {
                    conversation_id: Some(conversation_id),
                    message_id: None,
                    code: ErrorCode::NotFound,
                    detail: "conversation not found".into(),
                }),
            }
        }
        Ok(ClientEvent::TerminalStart { conversation_id }) => {
            match sqlx::query_as::<_, crate::storage::Conversation>(
                "SELECT * FROM conversations WHERE id = ?",
            )
            .bind(&conversation_id)
            .fetch_optional(&state.db)
            .await
            {
                Ok(Some(conversation)) => {
                    state.terminals.start(state.hub.clone(), &conversation);
                    None
                }
                _ => Some(ServerEvent::Error {
                    conversation_id: Some(conversation_id),
                    message_id: None,
                    code: ErrorCode::NotFound,
                    detail: "conversation not found".into(),
                }),
            }
        }
        Ok(ClientEvent::TerminalInput { conversation_id, data }) => {
            if !state.terminals.input(&conversation_id, &data).await {
                return Some(ServerEvent::Error {
                    conversation_id: Some(conversation_id),
                    message_id: None,
                    code: ErrorCode::BadRequest,
                    detail: "no terminal session for this conversation".into(),
                });
            }
            None
        }
        Ok(ClientEvent::TerminalKill { conversation_id }) => {
            state.terminals.kill(state.hub.clone(), &conversation_id);
            None
        }
        Ok(ClientEvent::Cancel { conversation_id }) => {
            state.engine.cancel(&conversation_id).await;
            None
        }
        Err(_) => Some(ServerEvent::Error {
            conversation_id: None,
            message_id: None,
            code: ErrorCode::BadRequest,
            detail: "unrecognized or malformed event".into(),
        }),
    }
}
