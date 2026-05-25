use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::body::to_bytes;
use axum::http::Request;
use axum::http::StatusCode;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::process::Command;
use tower::ServiceExt;

use codex_remote_agent::Store;
use codex_remote_agent::build_router;
use codex_remote_agent::config::Config;
use codex_remote_agent::models::Session;
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
