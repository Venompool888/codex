use axum::Json;
use axum::Router;
use axum::routing::get;
use serde::Serialize;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    _config: Config,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

pub fn build_router(config: Config) -> Router {
    let state = AppState { _config: config };
    Router::new()
        .route("/api/health", get(health))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
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
