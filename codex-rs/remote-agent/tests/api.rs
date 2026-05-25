use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::body::to_bytes;
use axum::http::Request;
use axum::http::StatusCode;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tower::ServiceExt;

use codex_remote_agent::build_router;
use codex_remote_agent::config::Config;

async fn test_app(temp_dir: &TempDir) -> Router {
    let cli = codex_remote_agent::config::Cli {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        state_dir: Some(temp_dir.path().to_path_buf()),
        workspaces: Vec::new(),
        setup_token: Some("setup-secret".to_string()),
    };
    let config = match Config::from_cli(cli).await {
        Ok(config) => config,
        Err(error) => panic!("failed to build test config: {error}"),
    };
    build_router(config)
}

#[tokio::test]
async fn setup_returns_session_token_for_valid_setup_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let session_token = body_json
        .get("sessionToken")
        .and_then(serde_json::Value::as_str)
        .unwrap();
    assert_eq!(session_token.len(), 43);
    assert!(!session_token.is_empty());
}

#[tokio::test]
async fn protected_endpoint_requires_bearer_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn setup_rejects_wrong_setup_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"wrong"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn setup_replay_returns_conflict() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let request = || {
        Request::builder()
            .method("POST")
            .uri("/api/setup")
            .header("content-type", "application/json")
            .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
            .unwrap()
    };

    let response = app.clone().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app.oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn setup_replay_with_wrong_token_returns_conflict_after_setup() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;

    let response = app.clone().oneshot(setup_request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"wrong"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn setup_replay_without_configured_token_returns_conflict_after_restart() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;

    let response = app.oneshot(setup_request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let cli = codex_remote_agent::config::Cli {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        state_dir: Some(temp_dir.path().to_path_buf()),
        workspaces: Vec::new(),
        setup_token: None,
    };
    let config = Config::from_cli(cli).await.unwrap();
    let app = build_router(config);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"anything"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn concurrent_setup_allows_only_one_success() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;

    let (first, second, third, fourth) = tokio::join!(
        app.clone().oneshot(setup_request()),
        app.clone().oneshot(setup_request()),
        app.clone().oneshot(setup_request()),
        app.oneshot(setup_request()),
    );
    let mut statuses = vec![
        first.unwrap().status(),
        second.unwrap().status(),
        third.unwrap().status(),
        fourth.unwrap().status(),
    ];
    statuses.sort();

    assert_eq!(
        statuses,
        vec![
            StatusCode::OK,
            StatusCode::CONFLICT,
            StatusCode::CONFLICT,
            StatusCode::CONFLICT,
        ]
    );
}

fn setup_request() -> Request<Body> {
    match Request::builder()
        .method("POST")
        .uri("/api/setup")
        .header("content-type", "application/json")
        .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
    {
        Ok(request) => request,
        Err(error) => panic!("failed to build setup request: {error}"),
    }
}

#[tokio::test]
async fn setup_requires_configured_setup_token() {
    let temp_dir = TempDir::new().unwrap();
    let cli = codex_remote_agent::config::Cli {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        state_dir: Some(temp_dir.path().to_path_buf()),
        workspaces: Vec::new(),
        setup_token: None,
    };
    let config = Config::from_cli(cli).await.unwrap();
    let response = build_router(config)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn protected_endpoint_accepts_setup_session_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let session_token = body_json
        .get("sessionToken")
        .and_then(serde_json::Value::as_str)
        .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces")
                .header("authorization", format!("Bearer {session_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body_json, json!([]));
}

#[tokio::test]
async fn protected_endpoint_rejects_invalid_bearer_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces")
                .header("authorization", "Bearer wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn protected_endpoint_rejects_non_bearer_authorization() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces")
                .header("authorization", "Token whatever")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn health_remains_unauthenticated_after_setup() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}
