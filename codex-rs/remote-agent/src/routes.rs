use axum::Json;
use axum::Router;
use axum::extract::Path as AxumPath;
use axum::extract::RawQuery;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Sse;
use axum::response::sse::Event;
use axum::routing::get;
use axum::routing::post;
use futures::StreamExt;
use futures::TryStreamExt;
use futures::stream;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;

use crate::SetupState;
use crate::Store;
use crate::auth::Authenticated;
use crate::auth::generate_token;
use crate::auth::hash_token;
use crate::auth::verify_token;
use crate::config::Config;
use crate::models::DiffSummary;
use crate::models::FileEntry;
use crate::models::Session;
use crate::models::SessionEvent;
use crate::models::Workspace;
use crate::sessions::ApprovalDecision;
use crate::sessions::ApproveError;
use crate::sessions::SessionManager;
use crate::store::CompleteSetupError;
use crate::workspaces::WorkspaceRoot;
use crate::workspaces::workspace_roots;

const MAX_SESSION_TITLE_CHARS: usize = 200;

#[derive(Clone)]
pub struct AppState {
    config: Config,
    store: Store,
    sessions: SessionManager,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    workspace_id: String,
    title: String,
}

pub fn build_router(config: Config) -> Router {
    let store = match Store::new(config.state_dir().to_path_buf()) {
        Ok(store) => store,
        Err(error) => panic!("failed to create state store: {error}"),
    };
    let state = AppState {
        config,
        sessions: SessionManager::new(store.clone()),
        store,
    };
    Router::new()
        .route("/", get(crate::static_ui::index))
        .route("/assets", get(crate::static_ui::asset_root))
        .route("/assets/", get(crate::static_ui::asset_root))
        .route("/assets/{*path}", get(crate::static_ui::asset))
        .route("/api/health", get(health))
        .route("/api/setup", post(setup))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{session_id}/events", get(session_events))
        .route(
            "/api/approvals/{approval_id}/approve",
            post(approve_approval),
        )
        .route("/api/approvals/{approval_id}/deny", post(deny_approval))
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

async fn list_sessions(
    _auth: Authenticated,
    State(state): State<AppState>,
) -> Result<Json<Vec<Session>>, StatusCode> {
    state
        .sessions
        .list_sessions()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn create_session(
    _auth: Authenticated,
    State(state): State<AppState>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<Session>, StatusCode> {
    workspace_by_id(&state, &request.workspace_id)?;
    let title = request.title.trim();
    if title.is_empty() || title.chars().count() > MAX_SESSION_TITLE_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }

    state
        .sessions
        .start_session(request.workspace_id, title.to_string())
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn session_events(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    RawQuery(query): RawQuery,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, std::convert::Infallible>>>, StatusCode> {
    let token = query_token(query.as_deref()).ok_or(StatusCode::UNAUTHORIZED)?;
    let setup_state = state
        .store
        .setup_state()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(expected_hash) = setup_state.session_token_hash else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !verify_token(&token, &expected_hash) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if !state
        .sessions
        .session_exists(&session_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Err(StatusCode::NOT_FOUND);
    }

    let receiver = state.sessions.subscribe(&session_id);
    let historical_events = state
        .sessions
        .events(&session_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let historical_ids = historical_events
        .iter()
        .map(|event| event.id.clone())
        .collect::<HashSet<_>>();
    let live_events = BroadcastStream::new(receiver).map_err(|error| match error {
        BroadcastStreamRecvError::Lagged(_) => (),
    });
    let historical_stream = stream::iter(historical_events.into_iter().map(Ok));
    let events = sse_events(
        historical_stream.chain(live_events.try_filter(move |event| {
            let is_new = !historical_ids.contains(&event.id);
            std::future::ready(is_new)
        })),
    );

    Ok(Sse::new(events))
}

fn sse_events<Events>(
    events: Events,
) -> impl futures::Stream<Item = Result<Event, std::convert::Infallible>>
where
    Events: futures::Stream<Item = Result<SessionEvent, ()>> + Unpin,
{
    SseEventStream {
        events,
        terminated: false,
    }
}

struct SseEventStream<Events> {
    events: Events,
    terminated: bool,
}

impl<Events> futures::Stream for SseEventStream<Events>
where
    Events: futures::Stream<Item = Result<SessionEvent, ()>> + Unpin,
{
    type Item = Result<Event, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.terminated {
            return Poll::Ready(None);
        }

        let Some(event) = futures::ready!(Pin::new(&mut self.events).poll_next(cx)) else {
            return Poll::Ready(None);
        };
        let sse_event = sse_event(event);
        if sse_event.is_error {
            self.terminated = true;
        }
        Poll::Ready(Some(Ok(sse_event.event)))
    }
}
struct EncodedSseEvent {
    event: Event,
    is_error: bool,
}

fn sse_event(event: Result<SessionEvent, ()>) -> EncodedSseEvent {
    let Ok(event) = event else {
        return EncodedSseEvent {
            event: Event::default()
                .event("error")
                .data("stream lagged; reconnect required"),
            is_error: true,
        };
    };
    let data = serde_json::to_string(&event).unwrap_or_else(|error| {
        format!(
            "{{\"type\":\"serializationError\",\"message\":{}}}",
            serde_json::Value::String(error.to_string())
        )
    });
    EncodedSseEvent {
        event: Event::default().data(data),
        is_error: false,
    }
}

async fn approve_approval(
    _auth: Authenticated,
    State(state): State<AppState>,
    AxumPath(approval_id): AxumPath<String>,
) -> Result<StatusCode, StatusCode> {
    update_approval(&state, &approval_id, ApprovalDecision::Approve).await
}

async fn deny_approval(
    _auth: Authenticated,
    State(state): State<AppState>,
    AxumPath(approval_id): AxumPath<String>,
) -> Result<StatusCode, StatusCode> {
    update_approval(&state, &approval_id, ApprovalDecision::Deny).await
}

async fn update_approval(
    state: &AppState,
    approval_id: &str,
    decision: ApprovalDecision,
) -> Result<StatusCode, StatusCode> {
    state
        .sessions
        .approve(approval_id, decision)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|error| match error {
            ApproveError::NotFound => StatusCode::NOT_FOUND,
            ApproveError::MissingSession => StatusCode::CONFLICT,
            ApproveError::AlreadyCompleted => StatusCode::CONFLICT,
            ApproveError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
        })
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

fn query_token(query: Option<&str>) -> Option<String> {
    for pair in query?.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "token" {
            return percent_decode(value);
        }
    }
    None
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
    use axum::body::Body as AxumBody;
    use axum::body::to_bytes;
    use axum::http::Request;
    use axum::http::StatusCode;
    use futures::StreamExt;
    use futures::TryStreamExt;
    use futures::stream;
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn sse_events_emits_error_event_before_terminating_on_lag() -> anyhow::Result<()> {
        let event = SessionEvent {
            id: "event-1".to_string(),
            session_id: "session-1".to_string(),
            created_at: 1,
            kind: crate::models::SessionEventKind::SessionCreated,
        };
        let stream = sse_events(stream::iter([Ok(event), Err(())]).chain(stream::pending()));

        let body = AxumBody::from_stream(stream.map_ok(|event| {
            // Reuse Axum's public SSE response path in route tests; here we only
            // need a deterministic stream-level check that lag is surfaced once.
            format!("{event:?}")
        }));
        let text = String::from_utf8(to_bytes(body, usize::MAX).await?.to_vec())?;

        assert!(text.contains("stream lagged; reconnect required"));

        Ok(())
    }

    #[tokio::test]
    async fn sse_events_ends_immediately_after_lag_without_waiting_for_upstream()
    -> anyhow::Result<()> {
        let mut stream = Box::pin(sse_events(stream::iter([Err(())]).chain(stream::pending())));

        let first = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next()).await?;
        assert!(first.is_some());
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next()).await?;
        assert!(second.is_none());

        Ok(())
    }

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
