//! Integration tests over a real socket: the WebSocket handshake, auth, and the
//! Phase 0 loopback contract (docs/EVENTS.md).

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::{connect_async, WebSocketStream};


async fn spawn_core() -> (SocketAddr, String) {
    let token = "it-test-token".to_string();
    let dir = std::env::temp_dir().join(format!("polylab-ws-it-{}", uuid::Uuid::new_v4()));
    let state = polylab_core::build_state(token.clone(), &dir).await.expect("state");
    let app = polylab_core::build_router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, token)
}

type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: &SocketAddr, token: &str) -> Client {
    let url = format!("ws://{addr}/ws?token={token}");
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", HeaderValue::from_static("polylab-v1"));
    let (stream, _response) = connect_async(request).await.unwrap();
    stream
}

async fn send_json(ws: &mut Client, json: &str) {
    ws.send(Message::Text(json.into())).await.unwrap();
}

async fn recv_json(ws: &mut Client) -> serde_json::Value {
    match ws.next().await {
        Some(Ok(Message::Text(text))) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected text message, got {other:?}"),
    }
}

#[tokio::test]
async fn ws_sends_hello_then_serves_ping_pong_and_echo() {
    let (addr, token) = spawn_core().await;
    let mut ws = connect(&addr, &token).await;

    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["name"], "polylab-core");

    send_json(&mut ws, r#"{"type":"ping"}"#).await;
    let pong = recv_json(&mut ws).await;
    assert_eq!(pong["type"], "pong");

    send_json(&mut ws, r#"{"type":"echo","text":"merhaba dünya"}"#).await;
    let echoed = recv_json(&mut ws).await;
    assert_eq!(echoed["type"], "echo");
    assert_eq!(echoed["text"], "merhaba dünya");

    send_json(&mut ws, r#"{"type":"nonsense"}"#).await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "bad_request");
}

#[tokio::test]
async fn ws_rejects_wrong_token_before_upgrade() {
    let (addr, _token) = spawn_core().await;
    let err = match tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token=wrong")).await {
        Ok(_) => panic!("connection with wrong token must fail"),
        Err(err) => err,
    };
    match err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status(), 401);
        }
        other => panic!("expected HTTP error, got {other:?}"),
    }
}
