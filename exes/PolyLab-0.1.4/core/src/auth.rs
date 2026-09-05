//! Session-token authentication.
//!
//! REST requests: `Authorization: Bearer <token>`.
//! WebSocket upgrade: browsers cannot set headers on `new WebSocket`, so `/ws` (and only
//! `/ws`) additionally accepts `?token=<token>`.

use axum::extract::Request;
use axum::http::header::AUTHORIZATION;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::extract::State;

use crate::state::AppState;

pub async fn auth_middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if !request_is_authorized(&state, &req) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(req).await
}

fn request_is_authorized(state: &AppState, req: &Request) -> bool {
    if let Some(value) = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(token) = value.strip_prefix("Bearer ") {
            if state.token_matches(token) {
                return true;
            }
        }
    }
    if req.uri().path() == "/ws" {
        if let Some(token) = query_param(req.uri(), "token") {
            return state.token_matches(token);
        }
    }
    false
}

/// Minimal `application/x-www-form-urlencoded` query lookup (avoids a dependency).
pub fn query_param<'a>(uri: &'a axum::http::Uri, key: &str) -> Option<&'a str> {
    uri.query()?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then_some(v)
    })
}

/// Length check leaks only the token *length*, which is not secret; the comparison of
/// equal-length values is branch-free on data.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Uri;
    use tower::ServiceExt;

    async fn test_router(token: &str) -> axum::Router {
        let dir = std::env::temp_dir().join(format!("polylab-auth-it-{}", uuid::Uuid::new_v4()));
        let state = crate::build_state(token.to_string(), &dir).await.expect("state");
        crate::build_router(state)
    }

    async fn get(router: axum::Router, uri: &str, bearer: Option<&str>) -> axum::http::Response<Body> {
        let mut builder = Request::builder().uri(uri);
        if let Some(token) = bearer {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        let req = builder.body(Body::empty()).unwrap();
        router.oneshot(req).await.unwrap()
    }

    #[tokio::test]
    async fn health_requires_token() {
        let router = test_router("secret-token-1").await;

        let res = get(router.clone(), "/health", None).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = get(router.clone(), "/health", Some("wrong")).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = get(router, "/health", Some("secret-token-1")).await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn query_token_only_works_for_ws() {
        let router = test_router("secret-token-1").await;

        // /health must not accept ?token=
        let res = get(router.clone(), "/health?token=secret-token-1", None).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // /ws without any token is rejected before the upgrade (401, not 400/500).
        let res = get(router.clone(), "/ws", Some("secret-token-1")).await;
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);

        let res = get(router, "/ws?token=secret-token-1", None).await;
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn query_param_parses() {
        let uri: Uri = "/ws?token=abc&x=1".parse().unwrap();
        assert_eq!(query_param(&uri, "token"), Some("abc"));
        assert_eq!(query_param(&uri, "x"), Some("1"));
        assert_eq!(query_param(&uri, "missing"), None);

        let uri: Uri = "/ws".parse().unwrap();
        assert_eq!(query_param(&uri, "token"), None);

        let uri: Uri = "/ws?notoken".parse().unwrap();
        assert_eq!(query_param(&uri, "token"), None);
    }
}
