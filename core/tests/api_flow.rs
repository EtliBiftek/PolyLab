//! Phase 1 end-to-end flow against a mock OpenAI-compatible provider:
//! provider CRUD → model upsert → conversation create → engine send → streamed
//! events on the hub → persisted messages/usage/title.

use axum::body::Body;
use axum::http::{header::AUTHORIZATION, Request, StatusCode};
use axum::routing::{get, post};
use axum::response::IntoResponse as _;
use axum::{Json, Router};

use polylab_core::providers::Provider as _;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use polylab_core::state::AppState;

const TOKEN: &str = "it-test-token";

/* ------------------------------------------------------------ mock provider -- */

async fn models() -> Json<Value> {
    json!({ "data": [ { "id": "mock-1" }, { "id": "mock-2" } ] }).into()
}

async fn chat_completions() -> axum::response::Response {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"düşünüyorum\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Mer\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"<think>gizli</think>haba\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" dünya\"}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":17,\"completion_tokens\":5}}\n\n",
        "data: [DONE]\n\n",
    );
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        sse,
    )
        .into_response()
}

async fn spawn_mock_provider() -> std::net::SocketAddr {
    let app = Router::new()
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

/* ------------------------------------------------------------------ helpers -- */

async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("polylab-api-it-{}", uuid::Uuid::new_v4()));
    let state = polylab_core::build_state(TOKEN.to_string(), &dir).await.expect("state");
    (state, dir)
}

async fn request_json(
    router: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(AUTHORIZATION, format!("Bearer {TOKEN}"));
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
        .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn router(state: &AppState) -> axum::Router {
    polylab_core::build_router(state.clone())
}

/* --------------------------------------------------------------------- tests -- */

#[tokio::test]
async fn unauthorized_without_token() {
    let (state, dir) = test_state().await;
    let app = router(&state);
    let response = app
        .oneshot(Request::builder().uri("/api/providers").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    state.db.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn full_single_model_flow() {
    let provider_addr = spawn_mock_provider().await;
    let (state, dir) = test_state().await;
    let app = router(&state);

    // Provider CRUD.
    let (status, provider) = request_json(
        &app,
        "POST",
        "/api/providers",
        Some(json!({ "kind": "custom", "name": "Mock", "base_url": format!("http://{}/v1", provider_addr), "api_key": "sk-mock" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{provider}");
    let provider_id = provider["id"].as_str().unwrap().to_string();
    assert_eq!(provider["has_api_key"], true);
    assert_eq!(provider["kind"], "custom");

    let (status, listed) = request_json(&app, "GET", "/api/providers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.as_array().unwrap().len(), 1);

    // Connection test (hits the mock).
    let (status, test) = request_json(&app, "GET", &format!("/api/providers/{provider_id}/test"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(test["ok"], true, "{test}");
    assert_eq!(test["model_count"], 2);

    // Remote models list.
    let (status, remote) = request_json(&app, "GET", &format!("/api/providers/{provider_id}/remote-models"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(remote.as_array().unwrap().len(), 2);
    assert_eq!(remote[0]["added"], false);

    // Enable one model.
    let (status, model) = request_json(
        &app,
        "POST",
        "/api/models",
        Some(json!({ "provider_id": provider_id, "model_id": "mock-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{model}");
    let model_id = model["id"].as_str().unwrap().to_string();
    assert_eq!(model["model_id"], "mock-1");
    assert_eq!(model["provider_kind"], "custom");

    // Think toggle on via the new PATCH field (auto state follows supports_reasoning).
    let (status, patched) = request_json(
        &app,
        "PATCH",
        &format!("/api/models/{model_id}"),
        Some(json!({ "reasoning_enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["reasoning_enabled"], true);

    // Conversation with that model.
    let (status, conversation) = request_json(
        &app,
        "POST",
        "/api/conversations",
        Some(json!({ "mode": "chat", "model_id": model_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{conversation}");
    let conversation_id = conversation["id"].as_str().unwrap().to_string();
    assert_eq!(conversation["selection_type"], "single");

    // Run the engine directly and watch the hub.
    let mut hub = state.hub.subscribe();
    state
        .engine
        .send_message(conversation_id.clone(), "Selam, kısa bir selamlaşma yazarmısın?".to_string())
        .await;

    let mut event_types: Vec<String> = Vec::new();
    while let Ok(event) = hub.try_recv() {
        let value: Value = serde_json::from_str(&event).unwrap();
        event_types.push(value["type"].as_str().unwrap_or_default().to_string());
        if value["type"] == "message_done" {
            assert_eq!(value["status"], "done");
        }
    }
    for expected in ["message_start", "token", "reasoning_token", "usage", "message_done"] {
        assert!(
            event_types.contains(&expected.to_string()),
            "missing {expected} in {event_types:?}"
        );
    }

    // Persisted messages + usage + auto title.
    let (status, detail) = request_json(
        &app,
        "GET",
        &format!("/api/conversations/{conversation_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let messages = detail["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "Merhaba dünya");
    assert_eq!(messages[1]["reasoning"], "düşünüyorumgizli");
    assert_eq!(messages[1]["tokens_in"], 17);
    assert_eq!(messages[1]["tokens_out"], 5);
    assert_eq!(messages[1]["tokens_estimated"], false);
    let title = detail["title"].as_str().unwrap();
    assert!(title.starts_with("Selam, kısa bir"), "{title}");

    state.db.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn provider_delete_removes_models_and_keeps_conversations() {
    let provider_addr = spawn_mock_provider().await;
    let (state, dir) = test_state().await;
    let app = router(&state);

    let (_, provider) = request_json(
        &app,
        "POST",
        "/api/providers",
        Some(json!({ "kind": "custom", "base_url": format!("http://{}/v1", provider_addr) })),
    )
    .await;
    let provider_id = provider["id"].as_str().unwrap().to_string();

    let (_, model) = request_json(
        &app,
        "POST",
        "/api/models",
        Some(json!({ "provider_id": provider_id, "model_id": "mock-1" })),
    )
    .await;
    let model_id = model["id"].as_str().unwrap().to_string();

    let (_, conversation) = request_json(
        &app,
        "POST",
        "/api/conversations",
        Some(json!({ "model_id": model_id })),
    )
    .await;
    let conversation_id = conversation["id"].as_str().unwrap().to_string();

    let (status, _) = request_json(&app, "DELETE", &format!("/api/providers/{provider_id}"), None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, models) = request_json(&app, "GET", "/api/models", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(models.as_array().unwrap().len(), 0);

    let (status, detail) = request_json(&app, "GET", &format!("/api/conversations/{conversation_id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["model_id"], Value::Null); // ON DELETE SET NULL

    // Sending without a model reports a provider error, not a crash.
    let mut hub = state.hub.subscribe();
    state.engine.send_message(conversation_id, "selam".to_string()).await;
    let mut saw_error = false;
    while let Ok(event) = hub.try_recv() {
        let value: Value = serde_json::from_str(&event).unwrap();
        if value["type"] == "error" {
            saw_error = true;
        }
    }
    assert!(saw_error);

    state.db.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn settings_round_trip() {
    let (state, dir) = test_state().await;
    let app = router(&state);

    let (status, _) = request_json(
        &app,
        "PUT",
        "/api/settings",
        Some(json!({ "key": "language", "value": "tr" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, settings) = request_json(&app, "GET", "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["language"], "tr");

    state.db.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/* ------------------------------------------- provider-level stream parsing -- */

#[tokio::test]
async fn openai_compat_stream_normalizes_reasoning_and_usage() {
    let addr = spawn_mock_provider().await;
    let provider = polylab_core::providers::openai_compat::OpenAiCompat::new(
        polylab_core::storage::ProviderKind::Custom,
        Some(&format!("http://{addr}/v1")),
        Some("sk-mock"),
    )
    .unwrap();

    let request = polylab_core::providers::ChatRequest {
        model: "mock-1".into(),
        messages: vec![polylab_core::providers::ChatMessage {
            role: polylab_core::providers::Role::User,
            content: "selam".into(),
        }],
        temperature: None,
        max_tokens: None,
    };
    let mut stream = provider.stream_chat(request).await.unwrap();
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut usage = None;
    while let Some(event) = stream.next().await {
        match event {
            polylab_core::providers::ChatEvent::TextDelta(delta) => text.push_str(&delta),
            polylab_core::providers::ChatEvent::ReasoningDelta(delta) => reasoning.push_str(&delta),
            polylab_core::providers::ChatEvent::Usage { tokens_in, tokens_out } => {
                usage = Some((tokens_in, tokens_out));
            }
            polylab_core::providers::ChatEvent::Error { detail } => panic!("stream error: {detail}"),
        }
    }
    assert_eq!(text, "Merhaba dünya");
    assert_eq!(reasoning, "düşünüyorumgizli");
    assert_eq!(usage, Some((17, 5)));
}
