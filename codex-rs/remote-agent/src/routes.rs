use axum::Json;
use axum::Router;
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
use crate::store::CompleteSetupError;

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
        .route("/api/workspaces", get(workspaces))
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

async fn workspaces(_auth: Authenticated) -> Json<Vec<serde_json::Value>> {
    Json(Vec::new())
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
