use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::body::to_bytes;
use axum::http::Request;
use axum::http::StatusCode;
use axum::http::header::CONTENT_SECURITY_POLICY;
use axum::http::header::CONTENT_TYPE;
use axum::http::header::REFERRER_POLICY;
use axum::http::header::X_CONTENT_TYPE_OPTIONS;
use axum::response::Response;
use futures::StreamExt;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::process::Command;
use tokio::time::Duration;
use tower::ServiceExt;

use codex_remote_agent::Store;
use codex_remote_agent::build_router;
use codex_remote_agent::config::Config;
use codex_remote_agent::models::ApprovalStatus;
use codex_remote_agent::models::Session;
use codex_remote_agent::models::SessionEventKind;
use codex_remote_agent::models::SessionStatus;

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

async fn test_app_with_workspaces(state_dir: PathBuf, workspaces: Vec<PathBuf>) -> Router {
    let cli = codex_remote_agent::config::Cli {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        state_dir: Some(state_dir),
        workspaces,
        setup_token: Some("setup-secret".to_string()),
    };
    let config = match Config::from_cli(cli).await {
        Ok(config) => config,
        Err(error) => panic!("failed to build test config: {error}"),
    };
    build_router(config)
}

async fn setup_and_extract_token(app: Router) -> String {
    let response = match app.oneshot(setup_request()).await {
        Ok(response) => response,
        Err(error) => panic!("setup request failed: {error}"),
    };
    assert_eq!(response.status(), StatusCode::OK);
    let body = match to_bytes(response.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(error) => panic!("failed to read setup response body: {error}"),
    };
    let body_json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => panic!("failed to parse setup response body: {error}"),
    };
    match body_json
        .get("sessionToken")
        .and_then(serde_json::Value::as_str)
    {
        Some(session_token) => session_token.to_string(),
        None => panic!("setup response did not include sessionToken"),
    }
}

async fn get_with_token(app: Router, uri: &str, token: &str) -> axum::response::Response {
    let request = match Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
    {
        Ok(request) => request,
        Err(error) => panic!("failed to build GET {uri} request: {error}"),
    };
    match app.oneshot(request).await {
        Ok(response) => response,
        Err(error) => panic!("GET {uri} failed: {error}"),
    }
}

async fn post_json_with_token(
    app: Router,
    uri: &str,
    token: &str,
    body: serde_json::Value,
) -> axum::response::Response {
    let request = match Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
    {
        Ok(request) => request,
        Err(error) => panic!("failed to build POST {uri} request: {error}"),
    };
    match app.oneshot(request).await {
        Ok(response) => response,
        Err(error) => panic!("POST {uri} failed: {error}"),
    }
}

async fn response_json(response: axum::response::Response) -> serde_json::Value {
    let body = match to_bytes(response.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(error) => panic!("failed to read response body: {error}"),
    };
    match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => panic!("failed to parse response body as JSON: {error}"),
    }
}

async fn create_session(app: Router, token: &str) -> serde_json::Value {
    let response = post_json_with_token(
        app.clone(),
        "/api/sessions",
        token,
        json!({"workspaceId":"workspace-1","title":"Build feature"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}

async fn session_test_app(temp_dir: &TempDir) -> Router {
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo)
        .await
        .unwrap_or_else(|error| panic!("failed to create session test repo: {error}"));
    test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await
}

async fn create_session_with_body(
    app: Router,
    token: &str,
    body: serde_json::Value,
) -> axum::response::Response {
    post_json_with_token(app, "/api/sessions", token, body).await
}

async fn run_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await
        .unwrap_or_else(|error| panic!("failed to run git {args:?}: {error}"));
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn serves_embedded_web_ui() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;

    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert_static_security_headers(&response);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains(r#"/assets/styles.css"#));
    assert!(body.contains(r#"/assets/app.js"#));
    assert!(body.contains(r#"id="messageForm""#));
    assert!(body.contains(r#"id="messageInput""#));
    assert!(body.contains(r#"id="messageSend""#));
}

#[tokio::test]
async fn serves_embedded_web_ui_assets() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;

    for (path, content_type) in [
        ("/assets/styles.css", "text/css; charset=utf-8"),
        ("/assets/app.js", "application/javascript; charset=utf-8"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(CONTENT_TYPE).unwrap(), content_type);
        assert_static_security_headers(&response);
    }

    for path in [
        "/assets",
        "/assets/",
        "/assets/missing.txt",
        "/assets/nested/missing.js",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "text/plain; charset=utf-8"
        );
        assert_static_security_headers(&response);
    }
}

fn assert_static_security_headers(response: &Response) {
    assert_eq!(
        response
            .headers()
            .get(CONTENT_SECURITY_POLICY)
            .and_then(|value| value.to_str().ok()),
        Some(
            "default-src 'self'; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
    );
    assert_eq!(
        response
            .headers()
            .get(X_CONTENT_TYPE_OPTIONS)
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );
    assert_eq!(
        response
            .headers()
            .get(REFERRER_POLICY)
            .and_then(|value| value.to_str().ok()),
        Some("no-referrer")
    );
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
async fn agent_status_reports_ok_without_auth() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/agent/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({
            "status": "ok",
            "setupComplete": false,
            "workspaceCount": 0,
        })
    );
}

#[tokio::test]
async fn agent_status_reports_setup_and_workspace_count() {
    let temp_dir = TempDir::new().unwrap();
    let first_repo = temp_dir.path().join("repo-1");
    let second_repo = temp_dir.path().join("repo-2");
    tokio::fs::create_dir_all(&first_repo).await.unwrap();
    tokio::fs::create_dir_all(&second_repo).await.unwrap();
    let app =
        test_app_with_workspaces(temp_dir.path().join("state"), vec![first_repo, second_repo])
            .await;

    setup_and_extract_token(app.clone()).await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/agent/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({
            "status": "ok",
            "setupComplete": true,
            "workspaceCount": 2,
        })
    );
}

#[tokio::test]
async fn agent_logs_requires_bearer_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/agent/logs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn agent_logs_returns_running_entry_with_setup_session_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/agent/logs", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({"entries":["codex-remote-agent is running"]})
    );
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
    let session_token = setup_and_extract_token(app.clone()).await;

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
async fn create_session_returns_waiting_for_approval_session() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = create_session_with_body(
        app.clone(),
        &session_token,
        json!({"workspaceId":"workspace-1","title":"  Build feature  "}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;

    assert_eq!(body_json["workspaceId"], "workspace-1");
    assert_eq!(body_json["title"], "Build feature");
    assert_eq!(body_json["status"], "waitingForApproval");
    assert!(body_json["id"].as_str().is_some());
}

#[tokio::test]
async fn create_session_rejects_unknown_workspace() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = create_session_with_body(
        app.clone(),
        &session_token,
        json!({"workspaceId":"workspace-missing","title":"Build feature"}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_session_rejects_empty_title() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = create_session_with_body(
        app.clone(),
        &session_token,
        json!({"workspaceId":"workspace-1","title":"   "}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_session_rejects_overlong_title() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = create_session_with_body(
        app,
        &session_token,
        json!({"workspaceId":"workspace-1","title":"x".repeat(201)}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn sessions_list_includes_created_session() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let created = create_session(app.clone(), &session_token).await;

    let response = get_with_token(app, "/api/sessions", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, json!([created]));
}

#[tokio::test]
async fn approvals_approve_updates_status_and_emits_completion_event() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let store = Store::new(temp_dir.path().join("state")).unwrap();
    let approval_id = store.approvals().await.unwrap()[0].id.clone();

    let response = post_json_with_token(
        app.clone(),
        &format!("/api/approvals/{approval_id}/approve"),
        &session_token,
        json!({}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let approvals = store.approvals().await.unwrap();
    assert_eq!(approvals[0].status, ApprovalStatus::Approved);
    let events = store.events(session["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(
        &events[4..],
        [
            codex_remote_agent::models::SessionEvent {
                id: events[4].id.clone(),
                session_id: events[4].session_id.clone(),
                created_at: events[4].created_at,
                kind: SessionEventKind::ApprovalDecided {
                    approval_id: approval_id.clone(),
                    approved: true,
                },
            },
            codex_remote_agent::models::SessionEvent {
                id: events[5].id.clone(),
                session_id: events[5].session_id.clone(),
                created_at: events[5].created_at,
                kind: SessionEventKind::StatusText {
                    status: "Session completed.".to_string(),
                },
            },
            codex_remote_agent::models::SessionEvent {
                id: events[6].id.clone(),
                session_id: events[6].session_id.clone(),
                created_at: events[6].created_at,
                kind: SessionEventKind::ToolCallCompleted { exit_code: 0 },
            },
        ]
    );
    let response = get_with_token(app, "/api/sessions", &session_token).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await[0]["status"], "completed");
}

#[tokio::test]
async fn double_approve_returns_conflict_and_emits_one_completion_event() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let store = Store::new(temp_dir.path().join("state")).unwrap();
    let approval_id = store.approvals().await.unwrap()[0].id.clone();

    let first = post_json_with_token(
        app.clone(),
        &format!("/api/approvals/{approval_id}/approve"),
        &session_token,
        json!({}),
    )
    .await;
    let second = post_json_with_token(
        app,
        &format!("/api/approvals/{approval_id}/approve"),
        &session_token,
        json!({}),
    )
    .await;

    assert_eq!(first.status(), StatusCode::NO_CONTENT);
    assert_eq!(second.status(), StatusCode::CONFLICT);
    let events = store.events(session["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, SessionEventKind::ToolCallCompleted { .. }))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, SessionEventKind::ApprovalDecided { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn concurrent_approve_and_deny_has_one_success_and_one_terminal_event() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let store = Store::new(temp_dir.path().join("state")).unwrap();
    let approval_id = store.approvals().await.unwrap()[0].id.clone();
    let approve_uri = format!("/api/approvals/{approval_id}/approve");
    let deny_uri = format!("/api/approvals/{approval_id}/deny");

    let (approve, deny) = tokio::join!(
        post_json_with_token(app.clone(), &approve_uri, &session_token, json!({}),),
        post_json_with_token(app, &deny_uri, &session_token, json!({}),)
    );
    let statuses = [approve.status(), deny.status()];

    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::NO_CONTENT)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
    let events = store.events(session["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.kind,
                SessionEventKind::ToolCallCompleted { .. } | SessionEventKind::ErrorRaised { .. }
            ))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, SessionEventKind::ApprovalDecided { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn approvals_deny_updates_status_and_emits_error_event() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let store = Store::new(temp_dir.path().join("state")).unwrap();
    let approval_id = store.approvals().await.unwrap()[0].id.clone();

    let response = post_json_with_token(
        app.clone(),
        &format!("/api/approvals/{approval_id}/deny"),
        &session_token,
        json!({}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let approvals = store.approvals().await.unwrap();
    assert_eq!(approvals[0].status, ApprovalStatus::Denied);
    let events = store.events(session["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(
        &events[4..],
        [
            codex_remote_agent::models::SessionEvent {
                id: events[4].id.clone(),
                session_id: events[4].session_id.clone(),
                created_at: events[4].created_at,
                kind: SessionEventKind::ApprovalDecided {
                    approval_id: approval_id.clone(),
                    approved: false,
                },
            },
            codex_remote_agent::models::SessionEvent {
                id: events[5].id.clone(),
                session_id: events[5].session_id.clone(),
                created_at: events[5].created_at,
                kind: SessionEventKind::StatusText {
                    status: "Session failed.".to_string(),
                },
            },
            codex_remote_agent::models::SessionEvent {
                id: events[6].id.clone(),
                session_id: events[6].session_id.clone(),
                created_at: events[6].created_at,
                kind: SessionEventKind::ErrorRaised {
                    message: "Command denied by user.".to_string()
                },
            },
        ]
    );
    let response = get_with_token(app, "/api/sessions", &session_token).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await[0]["status"], "failed");
}

#[tokio::test]
async fn approval_endpoint_returns_not_found_for_unknown_approval() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = post_json_with_token(
        app,
        "/api/approvals/missing/approve",
        &session_token,
        json!({}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sse_events_requires_token_query() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/{}/events",
                    session["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sse_events_returns_not_found_for_unknown_session() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/session-missing/events?token={session_token}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sse_events_includes_historical_events_with_token_query() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/{}/events?token={session_token}",
                    session["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    let events = sse_data_events(&body);
    assert_eq!(events.len(), 4);
    assert_eq!(events[0]["kind"]["type"], "sessionCreated");
    assert_eq!(events[1]["kind"]["type"], "statusText");
    assert_eq!(events[1]["kind"]["status"], "Waiting for approval.");
    assert_eq!(events[2]["kind"]["type"], "messageDelta");
    assert_eq!(
        events[2]["kind"]["content"],
        "Remote Codex session started."
    );
    assert_eq!(events[3]["kind"]["type"], "approvalRequested");
}

#[tokio::test]
async fn sse_events_delivers_live_events_after_connect() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let store = Store::new(temp_dir.path().join("state")).unwrap();
    let approval_id = store.approvals().await.unwrap()[0].id.clone();
    let session_id = session["id"].as_str().unwrap().to_string();

    let sse_app = app.clone();
    let sse_token = session_token.clone();
    let sse_session_id = session_id.clone();
    let response = sse_app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/{sse_session_id}/events?token={sse_token}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let approve_response = post_json_with_token(
        app,
        &format!("/api/approvals/{approval_id}/approve"),
        &session_token,
        json!({}),
    )
    .await;
    assert_eq!(approve_response.status(), StatusCode::NO_CONTENT);

    let events = read_sse_events_until(&mut stream, |event| {
        event["kind"]["type"] == "toolCallCompleted"
    })
    .await;
    assert!(
        events
            .iter()
            .any(|event| event["kind"]["type"] == "toolCallCompleted")
    );
    let ids = events
        .iter()
        .map(|event| event["id"].as_str().unwrap_or_default().to_string())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), events.len());
    assert!(
        events
            .iter()
            .any(|event| event["kind"]["type"] == "approvalDecided")
    );
}

async fn read_sse_events_until<Done>(
    stream: &mut axum::body::BodyDataStream,
    done: Done,
) -> Vec<serde_json::Value>
where
    Done: Fn(&serde_json::Value) -> bool,
{
    let mut events = Vec::new();
    let mut buffer = String::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for SSE frame"))
            .unwrap_or_else(|| panic!("SSE stream ended before expected event"))
            .unwrap_or_else(|error| panic!("failed to read SSE frame: {error}"));
        buffer.push_str(
            std::str::from_utf8(&chunk)
                .unwrap_or_else(|error| panic!("SSE frame was not UTF-8: {error}")),
        );
        while let Some((raw_event, rest)) = buffer.split_once("\n\n") {
            let parsed = sse_data_events(raw_event);
            buffer = rest.to_string();
            for event in parsed {
                let is_done = done(&event);
                events.push(event);
                if is_done {
                    return events;
                }
            }
        }
    }
}

fn sse_data_events(body: &str) -> Vec<serde_json::Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| {
            serde_json::from_str(data)
                .unwrap_or_else(|error| panic!("failed to parse SSE data event: {error}"))
        })
        .collect()
}

#[tokio::test]
async fn workspace_list_returns_configured_workspace_after_setup() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo.clone()]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/workspaces", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;
    assert_eq!(
        body_json,
        json!([{
            "id": "workspace-1",
            "displayName": "repo",
            "path": repo.canonicalize().unwrap().to_string_lossy(),
            "branch": null,
            "dirty": false,
            "lastSessionId": null
        }])
    );
}

#[tokio::test]
async fn workspace_files_requires_bearer_token() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/workspace-1/files")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn workspace_files_unknown_workspace_returns_not_found() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(
        app,
        "/api/workspaces/workspace-missing/files",
        &session_token,
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn workspace_files_returns_entries_for_configured_workspace() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(repo.join("src")).await.unwrap();
    tokio::fs::write(repo.join("README.md"), "hello")
        .await
        .unwrap();
    tokio::fs::write(repo.join("src/main.rs"), "fn main() {}\n")
        .await
        .unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/workspaces/workspace-1/files", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;
    assert_eq!(
        body_json,
        json!([
            {
                "path": "README.md",
                "kind": "file",
                "size": 5,
                "modifiedAt": body_json[0]["modifiedAt"].clone()
            },
            {
                "path": "src",
                "kind": "directory",
                "size": 0,
                "modifiedAt": body_json[1]["modifiedAt"].clone()
            }
        ])
    );
}

#[tokio::test]
async fn workspace_file_returns_file_contents() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    tokio::fs::write(repo.join("README.md"), "hello\n")
        .await
        .unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(
        app,
        "/api/workspaces/workspace-1/file?path=README.md",
        &session_token,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(body.as_ref(), b"hello\n");
}

#[tokio::test]
async fn workspace_file_rejects_path_traversal() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    tokio::fs::write(temp_dir.path().join("secret.txt"), "secret")
        .await
        .unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(
        app,
        "/api/workspaces/workspace-1/file?path=../secret.txt",
        &session_token,
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn workspace_file_rejects_absolute_path_escape() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    let secret_path = temp_dir.path().join("secret.txt");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    tokio::fs::write(&secret_path, "secret").await.unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(
        app,
        &format!(
            "/api/workspaces/workspace-1/file?path={}",
            secret_path.display()
        ),
        &session_token,
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn workspace_file_rejects_large_file() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    tokio::fs::write(repo.join("large.txt"), vec![b'x'; 1_000_001])
        .await
        .unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(
        app,
        "/api/workspaces/workspace-1/file?path=large.txt",
        &session_token,
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn workspace_diff_returns_modified_file_summary() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    run_git(&repo, &["init"]).await;
    run_git(&repo, &["config", "user.email", "test@example.com"]).await;
    run_git(&repo, &["config", "user.name", "Test User"]).await;
    tokio::fs::write(repo.join("README.md"), "hello\n")
        .await
        .unwrap();
    run_git(&repo, &["add", "README.md"]).await;
    run_git(&repo, &["commit", "-m", "baseline"]).await;
    tokio::fs::write(repo.join("README.md"), "hello\nworld\n")
        .await
        .unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/workspaces/workspace-1/diff", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;
    assert_eq!(
        body_json,
        json!({
            "files": [{
                "path": "README.md",
                "status": "modified",
                "additions": 1,
                "deletions": 0
            }],
            "additions": 1,
            "deletions": 0
        })
    );
}

#[tokio::test]
async fn workspace_diff_includes_staged_tracked_change() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    run_git(&repo, &["init"]).await;
    run_git(&repo, &["config", "user.email", "test@example.com"]).await;
    run_git(&repo, &["config", "user.name", "Test User"]).await;
    tokio::fs::write(repo.join("README.md"), "hello\n")
        .await
        .unwrap();
    run_git(&repo, &["add", "README.md"]).await;
    run_git(&repo, &["commit", "-m", "baseline"]).await;
    tokio::fs::write(repo.join("README.md"), "hello\nworld\n")
        .await
        .unwrap();
    run_git(&repo, &["add", "README.md"]).await;
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/workspaces/workspace-1/diff", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;
    assert_eq!(
        body_json,
        json!({
            "files": [{
                "path": "README.md",
                "status": "modified",
                "additions": 1,
                "deletions": 0
            }],
            "additions": 1,
            "deletions": 0
        })
    );
}

#[tokio::test]
async fn workspace_diff_includes_untracked_text_file() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    run_git(&repo, &["init"]).await;
    run_git(&repo, &["config", "user.email", "test@example.com"]).await;
    run_git(&repo, &["config", "user.name", "Test User"]).await;
    tokio::fs::write(repo.join("tracked.txt"), "baseline\n")
        .await
        .unwrap();
    run_git(&repo, &["add", "tracked.txt"]).await;
    run_git(&repo, &["commit", "-m", "baseline"]).await;
    tokio::fs::write(repo.join("notes.txt"), "one\ntwo\n")
        .await
        .unwrap();
    let app = test_app_with_workspaces(temp_dir.path().join("state"), vec![repo]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/workspaces/workspace-1/diff", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;
    assert_eq!(
        body_json,
        json!({
            "files": [{
                "path": "notes.txt",
                "status": "untracked",
                "additions": 2,
                "deletions": 0
            }],
            "additions": 2,
            "deletions": 0
        })
    );
}

#[tokio::test]
async fn workspace_list_includes_last_session_id_from_store() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    let state_dir = temp_dir.path().join("state");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    Store::new(state_dir.clone())
        .unwrap()
        .upsert_session(Session {
            id: "session-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Existing session".to_string(),
            status: SessionStatus::Running,
            created_at: 10,
            updated_at: 20,
        })
        .await
        .unwrap();
    let app = test_app_with_workspaces(state_dir, vec![repo.clone()]).await;
    let session_token = setup_and_extract_token(app.clone()).await;

    let response = get_with_token(app, "/api/workspaces", &session_token).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body_json = response_json(response).await;
    assert_eq!(
        body_json,
        json!([{
            "id": "workspace-1",
            "displayName": "repo",
            "path": repo.canonicalize().unwrap().to_string_lossy(),
            "branch": null,
            "dirty": false,
            "lastSessionId": "session-1"
        }])
    );
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
