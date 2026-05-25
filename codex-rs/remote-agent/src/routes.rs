use axum::Json;
use axum::Router;
use axum::extract::Path as AxumPath;
use axum::extract::RawQuery;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::routing::post;
use serde::Deserialize;
use serde::Serialize;

use crate::SetupState;
use crate::Store;
use crate::auth::Authenticated;
use crate::auth::generate_token;
use crate::auth::hash_token;
use crate::auth::verify_token;
use crate::config::Config;
use crate::models::DiffSummary;
use crate::models::FileEntry;
use crate::models::Workspace;
use crate::store::CompleteSetupError;
use crate::workspaces::WorkspaceRoot;
use crate::workspaces::workspace_roots;

#[derive(Clone)]
pub struct AppState {
    config: Config,
    store: Store,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    setup_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupResponse {
    session_token: String,
}

pub fn build_router(config: Config) -> Router {
    let store = match Store::new(config.state_dir().to_path_buf()) {
        Ok(store) => store,
        Err(error) => panic!("failed to create state store: {error}"),
    };
    let state = AppState { config, store };
    Router::new()
        .route("/api/health", get(health))
        .route("/api/setup", post(setup))
        .route("/api/workspaces", get(list_workspaces))
        .route(
            "/api/workspaces/{workspace_id}/files",
            get(list_workspace_files),
        )
        .route(
            "/api/workspaces/{workspace_id}/file",
            get(read_workspace_file),
        )
        .route(
            "/api/workspaces/{workspace_id}/diff",
            get(workspace_diff_summary),
        )
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn setup(
    State(state): State<AppState>,
    Json(request): Json<SetupRequest>,
) -> Result<Json<SetupResponse>, StatusCode> {
    let setup_state = state
        .store
        .setup_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if setup_state.setup_complete {
        return Err(StatusCode::CONFLICT);
    }

    let expected_setup_token = state.config.setup_token().ok_or(StatusCode::FORBIDDEN)?;
    if !verify_token(&request.setup_token, &hash_token(expected_setup_token)) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let session_token = generate_token();
    state
        .store
        .complete_setup_once(SetupState {
            setup_complete: true,
            setup_token_hash: hash_token(expected_setup_token),
            session_token_hash: Some(hash_token(&session_token)),
        })
        .await
        .map_err(|error| match error {
            CompleteSetupError::AlreadyComplete => StatusCode::CONFLICT,
            CompleteSetupError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    Ok(Json(SetupResponse { session_token }))
}

async fn list_workspaces(
    _auth: Authenticated,
    State(state): State<AppState>,
) -> Result<Json<Vec<Workspace>>, StatusCode> {
    let roots = workspace_roots(state.config.workspaces()).map_err(|_| StatusCode::BAD_REQUEST)?;
    let sessions = state
        .store
        .sessions()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut workspaces = Vec::with_capacity(roots.len());
    for root in &roots {
        let last_session_id = sessions
            .iter()
            .filter(|session| session.workspace_id == root.id())
            .max_by_key(|session| session.updated_at)
            .map(|session| session.id.clone());
        workspaces.push(root.to_workspace(last_session_id).await);
    }

    Ok(Json(workspaces))
}

async fn list_workspace_files(
    _auth: Authenticated,
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<Vec<FileEntry>>, StatusCode> {
    let root = workspace_by_id(&state, &workspace_id)?;
    let path = query_path(query.as_deref()).ok_or(StatusCode::BAD_REQUEST)?;
    root.list_files(&path)
        .map(Json)
        .map_err(|_| StatusCode::BAD_REQUEST)
}

async fn read_workspace_file(
    _auth: Authenticated,
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    RawQuery(query): RawQuery,
) -> Result<String, StatusCode> {
    let root = workspace_by_id(&state, &workspace_id)?;
    let path = query_path(query.as_deref()).ok_or(StatusCode::BAD_REQUEST)?;
    root.read_file(&path).map_err(|_| StatusCode::BAD_REQUEST)
}

async fn workspace_diff_summary(
    _auth: Authenticated,
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<DiffSummary>, StatusCode> {
    let root = workspace_by_id(&state, &workspace_id)?;
    root.diff_summary()
        .await
        .map(Json)
        .map_err(|_| StatusCode::BAD_REQUEST)
}

fn workspace_by_id(state: &AppState, workspace_id: &str) -> Result<WorkspaceRoot, StatusCode> {
    workspace_roots(state.config.workspaces())
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .into_iter()
        .find(|root| root.id() == workspace_id)
        .ok_or(StatusCode::NOT_FOUND)
}

fn query_path(query: Option<&str>) -> Option<String> {
    let Some(query) = query else {
        return Some(String::new());
    };
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "path" {
            return percent_decode(value);
        }
    }
    Some(String::new())
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = bytes.get(index + 1..index + 3)?;
                decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

impl axum::extract::FromRef<AppState> for Store {
    fn from_ref(input: &AppState) -> Self {
        input.store.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;

    use axum::body::Body;
    use axum::body::to_bytes;
    use axum::http::Request;
    use axum::http::StatusCode;
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn health_returns_ok_status() -> anyhow::Result<()> {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let state_dir = std::env::temp_dir().join(format!(
            "codex-remote-agent-health-test-{}-{suffix}",
            std::process::id()
        ));
        let config = Config::from_cli(crate::config::Cli {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            state_dir: Some(state_dir),
            workspaces: Vec::new(),
            setup_token: None,
        })
        .await?;
        let response = build_router(config)
            .oneshot(Request::builder().uri("/api/health").body(Body::empty())?)
            .await?;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let body_json: serde_json::Value = serde_json::from_slice(&body)?;
        assert_eq!(body_json, json!({ "status": "ok" }));

        Ok(())
    }
}
