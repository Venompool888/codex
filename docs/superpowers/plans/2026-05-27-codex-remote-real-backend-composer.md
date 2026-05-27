# Codex Remote Real Backend Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `codex-remote-agent` to Codex app-server v2 so the web composer submits real Codex turns and streams real assistant output.

**Architecture:** Add a focused backend adapter layer under `codex-rs/remote-agent/src/backend/`. `SessionManager` owns remote-agent session state and event persistence, while the backend adapter owns app-server JSON-RPC process I/O and translates app-server notifications into session events through a small callback interface. The existing deterministic behavior remains test-only/demo fallback; normal runtime uses the app-server bridge.

**Tech Stack:** Rust, Axum, Tokio, app-server v2 JSON-RPC over stdio, `serde_json`, existing static HTML/CSS/JS, existing file-backed `Store`.

---

## File Structure

- Create `codex-rs/remote-agent/src/backend/mod.rs`: object-safe backend trait, callback trait, app-server event enum used by the session layer.
- Create `codex-rs/remote-agent/src/backend/demo.rs`: deterministic backend implementation used by tests and explicit demo mode.
- Create `codex-rs/remote-agent/src/backend/app_server.rs`: app-server stdio process bridge, JSON-RPC request writer, response/notification reader, approval response writer.
- Modify `codex-rs/remote-agent/src/models.rs`: add message submit request/response payloads and app-server session metadata fields.
- Modify `codex-rs/remote-agent/src/store.rs`: persist per-session `threadId` and active `turnId` metadata.
- Modify `codex-rs/remote-agent/src/sessions.rs`: depend on backend trait, create real app-server threads, submit messages, map callbacks into stored events, reject duplicate active turns.
- Modify `codex-rs/remote-agent/src/routes.rs`: construct the selected backend, add `POST /api/sessions/{session_id}/messages`, return meaningful status codes.
- Modify `codex-rs/remote-agent/src/config.rs`: add backend mode and app-server command options.
- Modify `codex-rs/remote-agent/src/lib.rs`: export new backend module internally.
- Modify `codex-rs/remote-agent/static/app.js`: enable composer, submit messages, render running/failed/completed state from real events.
- Modify `codex-rs/remote-agent/static/index.html`: update composer placeholder/status copy.
- Modify `codex-rs/remote-agent/tests/api.rs`: route-level tests for message submit and state transitions.
- Modify `codex-rs/remote-agent/README.md`: document real backend mode, demo mode, and Tailscale preview command.

---

### Task 1: Add Session Metadata Persistence

**Files:**
- Modify: `codex-rs/remote-agent/src/models.rs`
- Modify: `codex-rs/remote-agent/src/store.rs`
- Test: `codex-rs/remote-agent/src/store.rs`

- [ ] **Step 1: Add the metadata model test**

Add this test to the existing `#[cfg(test)] mod tests` in `store.rs`:

```rust
#[tokio::test]
async fn session_metadata_round_trips_thread_and_active_turn() -> anyhow::Result<()> {
    let temp_dir = tempfile::TempDir::new()?;
    let store = Store::new(temp_dir.path().to_path_buf())?;
    let session_id = "session-1";

    store
        .upsert_session_metadata(crate::models::SessionMetadata {
            session_id: session_id.to_string(),
            app_server_thread_id: Some("thr_123".to_string()),
            active_turn_id: Some("turn_456".to_string()),
        })
        .await?;

    assert_eq!(
        store.session_metadata(session_id).await?,
        Some(crate::models::SessionMetadata {
            session_id: session_id.to_string(),
            app_server_thread_id: Some("thr_123".to_string()),
            active_turn_id: Some("turn_456".to_string()),
        })
    );

    store.clear_active_turn(session_id).await?;

    assert_eq!(
        store.session_metadata(session_id).await?,
        Some(crate::models::SessionMetadata {
            session_id: session_id.to_string(),
            app_server_thread_id: Some("thr_123".to_string()),
            active_turn_id: None,
        })
    );

    Ok(())
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent session_metadata_round_trips_thread_and_active_turn
```

Expected: fail because `SessionMetadata`, `upsert_session_metadata`, `session_metadata`, and `clear_active_turn` do not exist.

- [ ] **Step 3: Add `SessionMetadata`**

Add this struct to `models.rs` near `Session`:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub session_id: String,
    pub app_server_thread_id: Option<String>,
    pub active_turn_id: Option<String>,
}
```

- [ ] **Step 4: Extend the store state file**

In `store.rs`, import `SessionMetadata`:

```rust
use crate::models::SessionMetadata;
```

Update `AgentStateFile`:

```rust
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStateFile {
    sessions: Vec<Session>,
    events: Vec<SessionEvent>,
    approvals: Vec<ApprovalRequest>,
    #[serde(default)]
    session_metadata: Vec<SessionMetadata>,
}
```

Update `load_legacy_agent_state_locked` to initialize metadata:

```rust
Ok(AgentStateFile {
    sessions: sessions_file.sessions,
    events: events_file.events,
    approvals: approvals_file.approvals,
    session_metadata: Vec::new(),
})
```

- [ ] **Step 5: Add metadata store methods**

Add these methods to `impl Store`:

```rust
#[expect(
    clippy::await_holding_invalid_type,
    reason = "store operations intentionally serialize async file access"
)]
pub async fn session_metadata(
    &self,
    session_id: &str,
) -> anyhow::Result<Option<SessionMetadata>> {
    let _guard = self.mutex.lock().await;
    let _file_guard = self.lock_agent_state().await?;
    Ok(self
        .load_agent_state_locked()
        .await?
        .session_metadata
        .into_iter()
        .find(|metadata| metadata.session_id == session_id))
}

#[expect(
    clippy::await_holding_invalid_type,
    reason = "store operations intentionally serialize async file access"
)]
pub async fn upsert_session_metadata(&self, metadata: SessionMetadata) -> anyhow::Result<()> {
    let _guard = self.mutex.lock().await;
    let _file_guard = self.lock_agent_state().await?;
    let mut state = self.load_agent_state_locked().await?;
    if let Some(existing) = state
        .session_metadata
        .iter_mut()
        .find(|item| item.session_id == metadata.session_id)
    {
        *existing = metadata;
    } else {
        state.session_metadata.push(metadata);
    }
    self.save_agent_state_locked(&state).await
}

#[expect(
    clippy::await_holding_invalid_type,
    reason = "store operations intentionally serialize async file access"
)]
pub async fn clear_active_turn(&self, session_id: &str) -> anyhow::Result<()> {
    let _guard = self.mutex.lock().await;
    let _file_guard = self.lock_agent_state().await?;
    let mut state = self.load_agent_state_locked().await?;
    if let Some(metadata) = state
        .session_metadata
        .iter_mut()
        .find(|item| item.session_id == session_id)
    {
        metadata.active_turn_id = None;
    }
    self.save_agent_state_locked(&state).await
}
```

- [ ] **Step 6: Run the test**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent session_metadata_round_trips_thread_and_active_turn
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add codex-rs/remote-agent/src/models.rs codex-rs/remote-agent/src/store.rs
git commit -m "Persist remote agent session metadata"
```

---

### Task 2: Introduce the Backend Adapter Boundary

**Files:**
- Create: `codex-rs/remote-agent/src/backend/mod.rs`
- Create: `codex-rs/remote-agent/src/backend/demo.rs`
- Modify: `codex-rs/remote-agent/src/lib.rs`
- Modify: `codex-rs/remote-agent/src/sessions.rs`
- Test: `codex-rs/remote-agent/src/sessions.rs`

- [ ] **Step 1: Add the failing session creation test for backend-driven threads**

Replace the current `start_session_records_session_events_and_pending_approval` expectations in `sessions.rs` with a backend-driven test:

```rust
#[tokio::test]
async fn start_session_records_backend_thread_metadata() -> anyhow::Result<()> {
    let temp_dir = TempDir::new()?;
    let store = Store::new(temp_dir.path().to_path_buf())?;
    let backend = crate::backend::demo::DemoBackend::new();
    let manager = SessionManager::new(store.clone(), backend);

    let session = manager
        .start_session("workspace-1".to_string(), "Build feature".to_string())
        .await?;

    assert_eq!(
        store.sessions().await?,
        vec![crate::models::Session {
            id: session.id.clone(),
            workspace_id: "workspace-1".to_string(),
            title: "Build feature".to_string(),
            status: SessionStatus::Completed,
            created_at: session.created_at,
            updated_at: session.updated_at,
        }]
    );
    assert_eq!(
        store.session_metadata(&session.id).await?,
        Some(crate::models::SessionMetadata {
            session_id: session.id.clone(),
            app_server_thread_id: Some("demo-thread".to_string()),
            active_turn_id: None,
        })
    );

    let events = store.events(&session.id).await?;
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.clone())
            .collect::<Vec<_>>(),
        vec![
            SessionEventKind::SessionCreated,
            SessionEventKind::StatusText {
                status: "Ready.".to_string(),
            },
            SessionEventKind::MessageDelta {
                role: "assistant".to_string(),
                content: "Remote Codex session ready.".to_string(),
            },
        ]
    );

    Ok(())
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent start_session_records_backend_thread_metadata
```

Expected: fail because `backend` module and new constructor signature do not exist.

- [ ] **Step 3: Create `backend/mod.rs`**

Create `codex-rs/remote-agent/src/backend/mod.rs`:

```rust
pub mod demo;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendThread {
    pub thread_id: String,
    pub greeting: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendTurn {
    pub turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BackendEvent {
    AssistantDelta(String),
    Status(String),
    ToolStarted { command: String },
    ToolCompleted { exit_code: i32 },
    DiffUpdated,
    Completed,
    Failed { message: String },
}

pub(crate) trait BackendEventSink: Send + Sync + 'static {
    fn emit(
        &self,
        session_id: String,
        event: BackendEvent,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + '_>>;
}

pub(crate) trait CodexBackend: Send + Sync + 'static {
    fn start_thread(
        &self,
        workspace_path: String,
        title: String,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<BackendThread>> + Send + '_>>;

    fn submit_turn(
        &self,
        session_id: String,
        thread_id: String,
        workspace_path: String,
        message: String,
        sink: Arc<dyn BackendEventSink>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<BackendTurn>> + Send + '_>>;
}
```

- [ ] **Step 4: Create `backend/demo.rs`**

Create `codex-rs/remote-agent/src/backend/demo.rs`:

```rust
use crate::backend::BackendEvent;
use crate::backend::BackendEventSink;
use crate::backend::BackendThread;
use crate::backend::BackendTurn;
use crate::backend::CodexBackend;

#[derive(Clone, Debug, Default)]
pub(crate) struct DemoBackend;

impl DemoBackend {
    pub(crate) fn new() -> Self {
        Self
    }
}

impl CodexBackend for DemoBackend {
    fn start_thread(
        &self,
        _workspace_path: String,
        _title: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<BackendThread>> + Send + '_>> {
        Box::pin(async move {
            Ok(BackendThread {
                thread_id: "demo-thread".to_string(),
                greeting: Some("Remote Codex session ready.".to_string()),
            })
        })
    }

    fn submit_turn(
        &self,
        session_id: String,
        _thread_id: String,
        _workspace_path: String,
        message: String,
        sink: std::sync::Arc<dyn BackendEventSink>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<BackendTurn>> + Send + '_>> {
        Box::pin(async move {
            sink.emit(
                session_id.clone(),
                BackendEvent::AssistantDelta(format!("Demo backend received: {message}")),
            )
            .await?;
            sink.emit(session_id, BackendEvent::Completed).await?;
            Ok(BackendTurn {
                turn_id: "demo-turn".to_string(),
            })
        })
    }
}
```

- [ ] **Step 5: Wire the module into `lib.rs`**

Add this line to `lib.rs`:

```rust
pub(crate) mod backend;
```

- [ ] **Step 6: Update `SessionManager` to be generic over a backend**

In `sessions.rs`, import backend types:

```rust
use crate::backend::BackendEvent;
use crate::backend::BackendEventSink;
use crate::backend::CodexBackend;
use crate::models::SessionMetadata;
```

Change `SessionManager` to:

```rust
#[derive(Clone)]
pub(crate) struct SessionManager {
    store: Store,
    backend: std::sync::Arc<dyn CodexBackend>,
    senders: Arc<Mutex<HashMap<String, broadcast::Sender<SessionEvent>>>>,
}
```

Change the impl header and constructor:

```rust
impl SessionManager {
    pub(crate) fn new(store: Store, backend: std::sync::Arc<dyn CodexBackend>) -> Self {
        Self {
            store,
            backend,
            senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }
```

- [ ] **Step 7: Replace deterministic session startup with backend startup**

Replace the body of `start_session` with:

```rust
let now = unix_timestamp()?;
let thread = self
    .backend
    .start_thread(workspace_id.clone(), title.clone())
    .await?;
let session = Session {
    id: new_id(),
    workspace_id,
    title,
    status: SessionStatus::Completed,
    created_at: now,
    updated_at: now,
};
let mut events = vec![
    SessionEvent {
        id: new_id(),
        session_id: session.id.clone(),
        created_at: now,
        kind: SessionEventKind::SessionCreated,
    },
    SessionEvent {
        id: new_id(),
        session_id: session.id.clone(),
        created_at: now,
        kind: SessionEventKind::StatusText {
            status: "Ready.".to_string(),
        },
    },
];
if let Some(greeting) = thread.greeting {
    events.push(SessionEvent {
        id: new_id(),
        session_id: session.id.clone(),
        created_at: now,
        kind: SessionEventKind::MessageDelta {
            role: "assistant".to_string(),
            content: greeting,
        },
    });
}
self.store.upsert_session(session.clone()).await?;
self.store
    .upsert_session_metadata(SessionMetadata {
        session_id: session.id.clone(),
        app_server_thread_id: Some(thread.thread_id),
        active_turn_id: None,
    })
    .await?;
for event in events.clone() {
    self.store.append_event(event).await?;
}
self.broadcast_events(events);

Ok(session)
```

- [ ] **Step 8: Run the focused test**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent start_session_records_backend_thread_metadata
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add codex-rs/remote-agent/src/backend codex-rs/remote-agent/src/lib.rs codex-rs/remote-agent/src/sessions.rs
git commit -m "Add remote agent backend adapter boundary"
```

---

### Task 3: Add Real Message Submit API at the Session Layer

**Files:**
- Modify: `codex-rs/remote-agent/src/models.rs`
- Modify: `codex-rs/remote-agent/src/sessions.rs`
- Test: `codex-rs/remote-agent/src/sessions.rs`

- [ ] **Step 1: Add message submit tests**

Add these tests to `sessions.rs`:

```rust
#[tokio::test]
async fn submit_message_records_user_message_and_backend_events() -> anyhow::Result<()> {
    let temp_dir = TempDir::new()?;
    let store = Store::new(temp_dir.path().to_path_buf())?;
    let manager = SessionManager::new(store.clone(), crate::backend::demo::DemoBackend::new());
    let session = manager
        .start_session("workspace-1".to_string(), "Build feature".to_string())
        .await?;

    manager
        .submit_message(&session.id, "Run tests".to_string())
        .await?;

    assert_eq!(store.session_metadata(&session.id).await?.unwrap().active_turn_id, None);
    assert_eq!(
        store.sessions().await?[0].status,
        SessionStatus::Completed
    );
    assert_eq!(
        store
            .events(&session.id)
            .await?
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        vec![
            SessionEventKind::SessionCreated,
            SessionEventKind::StatusText {
                status: "Ready.".to_string(),
            },
            SessionEventKind::MessageDelta {
                role: "assistant".to_string(),
                content: "Remote Codex session ready.".to_string(),
            },
            SessionEventKind::MessageDelta {
                role: "user".to_string(),
                content: "Run tests".to_string(),
            },
            SessionEventKind::StatusText {
                status: "Codex is working.".to_string(),
            },
            SessionEventKind::MessageDelta {
                role: "assistant".to_string(),
                content: "Demo backend received: Run tests".to_string(),
            },
            SessionEventKind::StatusText {
                status: "Session completed.".to_string(),
            },
        ]
    );

    Ok(())
}

#[tokio::test]
async fn submit_message_rejects_missing_session() -> anyhow::Result<()> {
    let temp_dir = TempDir::new()?;
    let store = Store::new(temp_dir.path().to_path_buf())?;
    let manager = SessionManager::new(store, crate::backend::demo::DemoBackend::new());

    let result = manager
        .submit_message("missing-session", "Run tests".to_string())
        .await;

    assert!(matches!(result, Err(SubmitMessageError::SessionNotFound)));
    Ok(())
}
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent submit_message_
```

Expected: fail because `submit_message` and `SubmitMessageError` do not exist.

- [ ] **Step 3: Add API payload models**

Add these to `models.rs`:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitMessageRequest {
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitMessageResponse {
    pub accepted: bool,
}
```

- [ ] **Step 4: Add submit error type**

Add this enum to `sessions.rs`:

```rust
#[derive(Debug, thiserror::Error)]
pub(crate) enum SubmitMessageError {
    #[error("session not found")]
    SessionNotFound,
    #[error("session is missing backend thread")]
    MissingThread,
    #[error("turn is already active")]
    TurnAlreadyActive,
    #[error("message is empty")]
    EmptyMessage,
    #[error(transparent)]
    Store(#[from] anyhow::Error),
}
```

- [ ] **Step 5: Add event sink implementation**

Add this helper type and impl to `sessions.rs`:

```rust
#[derive(Clone)]
struct StoreEventSink {
    manager: SessionManagerSink,
}

#[derive(Clone)]
struct SessionManagerSink {
    store: Store,
    senders: Arc<Mutex<HashMap<String, broadcast::Sender<SessionEvent>>>>,
}

impl BackendEventSink for StoreEventSink {
    fn emit(
        &self,
        session_id: String,
        event: BackendEvent,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + '_>> {
        Box::pin(async move { self.manager.record_backend_event(&session_id, event).await })
    }
}

impl SessionManagerSink {
    async fn record_backend_event(
        &self,
        session_id: &str,
        backend_event: BackendEvent,
    ) -> anyhow::Result<()> {
        let now = unix_timestamp()?;
        let (status, kind) = match backend_event {
            BackendEvent::AssistantDelta(content) => (
                None,
                SessionEventKind::MessageDelta {
                    role: "assistant".to_string(),
                    content,
                },
            ),
            BackendEvent::Status(status) => (None, SessionEventKind::StatusText { status }),
            BackendEvent::ToolStarted { command } => {
                (None, SessionEventKind::ToolCallStarted { command })
            }
            BackendEvent::ToolCompleted { exit_code } => {
                (None, SessionEventKind::ToolCallCompleted { exit_code })
            }
            BackendEvent::DiffUpdated => (None, SessionEventKind::DiffUpdated),
            BackendEvent::Completed => (
                Some(SessionStatus::Completed),
                SessionEventKind::StatusText {
                    status: COMPLETED_STATUS_TEXT.to_string(),
                },
            ),
            BackendEvent::Failed { message } => {
                (Some(SessionStatus::Failed), SessionEventKind::ErrorRaised { message })
            }
        };
        let event = SessionEvent {
            id: new_id(),
            session_id: session_id.to_string(),
            created_at: now,
            kind,
        };
        self.store.append_event(event.clone()).await?;
        if let Some(status) = status {
            self.store.clear_active_turn(session_id).await?;
            if let Some(mut session) = self
                .store
                .sessions()
                .await?
                .into_iter()
                .find(|item| item.id == session_id)
            {
                session.status = status;
                session.updated_at = now;
                self.store.upsert_session(session).await?;
            }
        }
        let sender = self.sender(session_id);
        let _ = sender.send(event);
        Ok(())
    }

    fn sender(&self, session_id: &str) -> broadcast::Sender<SessionEvent> {
        let mut senders = self
            .senders
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        senders
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let (sender, _receiver) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
                sender
            })
            .clone()
    }
}
```

- [ ] **Step 6: Add `submit_message`**

Add this method to `impl SessionManager`:

```rust
pub(crate) async fn submit_message(
    &self,
    session_id: &str,
    message: String,
) -> Result<(), SubmitMessageError> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(SubmitMessageError::EmptyMessage);
    }
    let Some(mut session) = self
        .store
        .sessions()
        .await?
        .into_iter()
        .find(|item| item.id == session_id)
    else {
        return Err(SubmitMessageError::SessionNotFound);
    };
    let Some(metadata) = self.store.session_metadata(session_id).await? else {
        return Err(SubmitMessageError::MissingThread);
    };
    if metadata.active_turn_id.is_some() {
        return Err(SubmitMessageError::TurnAlreadyActive);
    }
    let Some(thread_id) = metadata.app_server_thread_id else {
        return Err(SubmitMessageError::MissingThread);
    };

    let now = unix_timestamp()?;
    session.status = SessionStatus::Running;
    session.updated_at = now;
    self.store.upsert_session(session.clone()).await?;
    self.store
        .upsert_session_metadata(SessionMetadata {
            session_id: session.id.clone(),
            app_server_thread_id: Some(thread_id.clone()),
            active_turn_id: Some("starting".to_string()),
        })
        .await?;
    let events = vec![
        SessionEvent {
            id: new_id(),
            session_id: session.id.clone(),
            created_at: now,
            kind: SessionEventKind::MessageDelta {
                role: "user".to_string(),
                content: message.clone(),
            },
        },
        SessionEvent {
            id: new_id(),
            session_id: session.id.clone(),
            created_at: now,
            kind: SessionEventKind::StatusText {
                status: "Codex is working.".to_string(),
            },
        },
    ];
    for event in events.clone() {
        self.store.append_event(event).await?;
    }
    self.broadcast_events(events);

    let sink = std::sync::Arc::new(StoreEventSink {
        manager: SessionManagerSink {
            store: self.store.clone(),
            senders: self.senders.clone(),
        },
    });
    let turn = self
        .backend
        .submit_turn(
            session.id.clone(),
            thread_id.clone(),
            session.workspace_id.clone(),
            message,
            sink,
        )
        .await
        .map_err(SubmitMessageError::Store)?;
    self.store
        .upsert_session_metadata(SessionMetadata {
            session_id: session.id,
            app_server_thread_id: Some(thread_id),
            active_turn_id: Some(turn.turn_id),
        })
        .await?;
    if let Some(current) = self
        .store
        .sessions()
        .await?
        .into_iter()
        .find(|item| item.id == session_id)
        && matches!(current.status, SessionStatus::Completed | SessionStatus::Failed)
    {
        self.store.clear_active_turn(session_id).await?;
    }
    Ok(())
}
```

- [ ] **Step 7: Run the submit tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent submit_message_
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add codex-rs/remote-agent/src/models.rs codex-rs/remote-agent/src/sessions.rs
git commit -m "Add remote agent message submission"
```

---

### Task 4: Add the HTTP Message Submit Route

**Files:**
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Modify: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Add route tests**

Add these tests to `tests/api.rs`:

```rust
#[tokio::test]
async fn submit_message_requires_non_empty_message() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let session_id = session["id"].as_str().unwrap();

    let response = post_json_with_token(
        app,
        &format!("/api/sessions/{session_id}/messages"),
        &session_token,
        json!({"message":"   "}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn submit_message_records_user_message() {
    let temp_dir = TempDir::new().unwrap();
    let app = session_test_app(&temp_dir).await;
    let session_token = setup_and_extract_token(app.clone()).await;
    let session = create_session(app.clone(), &session_token).await;
    let session_id = session["id"].as_str().unwrap();

    let response = post_json_with_token(
        app.clone(),
        &format!("/api/sessions/{session_id}/messages"),
        &session_token,
        json!({"message":"Run tests"}),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, json!({"accepted":true}));

    let store = Store::new(temp_dir.path().join("state")).unwrap();
    let events = store.events(session_id).await.unwrap();
    assert!(events.iter().any(|event| {
        event.kind
            == SessionEventKind::MessageDelta {
                role: "user".to_string(),
                content: "Run tests".to_string(),
            }
    }));
}
```

- [ ] **Step 2: Run the failing route tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent submit_message_
```

Expected: route tests fail because endpoint is missing.

- [ ] **Step 3: Update route imports**

In `routes.rs`, add:

```rust
use crate::models::SubmitMessageRequest;
use crate::models::SubmitMessageResponse;
use crate::sessions::SubmitMessageError;
```

- [ ] **Step 4: Register the route**

Add this route near the session routes:

```rust
.route(
    "/api/sessions/{session_id}/messages",
    post(submit_session_message),
)
```

- [ ] **Step 5: Add route handler**

Add this function in `routes.rs` near `create_session`:

```rust
async fn submit_session_message(
    _auth: Authenticated,
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<SubmitMessageRequest>,
) -> Result<Json<SubmitMessageResponse>, StatusCode> {
    state
        .sessions
        .submit_message(&session_id, request.message)
        .await
        .map(|()| Json(SubmitMessageResponse { accepted: true }))
        .map_err(|error| match error {
            SubmitMessageError::EmptyMessage => StatusCode::BAD_REQUEST,
            SubmitMessageError::SessionNotFound => StatusCode::NOT_FOUND,
            SubmitMessageError::MissingThread => StatusCode::CONFLICT,
            SubmitMessageError::TurnAlreadyActive => StatusCode::CONFLICT,
            SubmitMessageError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
        })
}
```

- [ ] **Step 6: Run route tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent submit_message_
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add codex-rs/remote-agent/src/routes.rs codex-rs/remote-agent/tests/api.rs
git commit -m "Expose remote agent message submit endpoint"
```

---

### Task 5: Implement App-Server JSON-RPC Bridge

**Files:**
- Create: `codex-rs/remote-agent/src/backend/app_server.rs`
- Modify: `codex-rs/remote-agent/src/backend/mod.rs`
- Test: `codex-rs/remote-agent/src/backend/app_server.rs`

- [ ] **Step 1: Register the module**

In `backend/mod.rs`, add:

```rust
pub mod app_server;
```

- [ ] **Step 2: Add JSON-RPC mapping tests**

Create `codex-rs/remote-agent/src/backend/app_server.rs` with tests first:

```rust
use serde_json::Value;

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn initialize_request_uses_remote_agent_client_info() {
        assert_eq!(
            jsonrpc_request(1, "initialize", initialize_params()),
            json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "codex_remote_agent",
                        "title": "Codex Remote Agent",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": false
                    }
                }
            })
        );
    }

    #[test]
    fn thread_start_request_passes_cwd_and_service_name() {
        assert_eq!(
            jsonrpc_request(2, "thread/start", thread_start_params("/srv/app")),
            json!({
                "id": 2,
                "method": "thread/start",
                "params": {
                    "cwd": "/srv/app",
                    "serviceName": "codex_remote_agent",
                    "sessionStartSource": "startup"
                }
            })
        );
    }

    #[test]
    fn turn_start_request_wraps_text_input() {
        assert_eq!(
            jsonrpc_request(3, "turn/start", turn_start_params("thr_123", "/srv/app", "Run tests")),
            json!({
                "id": 3,
                "method": "turn/start",
                "params": {
                    "threadId": "thr_123",
                    "input": [
                        {
                            "type": "text",
                            "text": "Run tests"
                        }
                    ],
                    "cwd": "/srv/app"
                }
            })
        );
    }
}
```

- [ ] **Step 3: Run failing mapping tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent backend::app_server
```

Expected: fail because helper functions are missing.

- [ ] **Step 4: Implement JSON helper functions**

Add this code above the test module:

```rust
use serde_json::json;

pub(crate) fn jsonrpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

pub(crate) fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "codex_remote_agent",
            "title": "Codex Remote Agent",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "experimentalApi": false,
        },
    })
}

pub(crate) fn thread_start_params(cwd: &str) -> Value {
    json!({
        "cwd": cwd,
        "serviceName": "codex_remote_agent",
        "sessionStartSource": "startup",
    })
}

pub(crate) fn turn_start_params(thread_id: &str, cwd: &str, message: &str) -> Value {
    json!({
        "threadId": thread_id,
        "input": [
            {
                "type": "text",
                "text": message,
            }
        ],
        "cwd": cwd,
    })
}
```

- [ ] **Step 5: Implement bridge struct and process startup**

Add:

```rust
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use anyhow::Context;
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::ChildStdin;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::sync::oneshot;

use crate::backend::BackendEvent;
use crate::backend::BackendEventSink;
use crate::backend::BackendThread;
use crate::backend::BackendTurn;
use crate::backend::CodexBackend;

#[derive(Clone)]
pub(crate) struct AppServerBackend {
    inner: Arc<AppServerInner>,
}

struct AppServerInner {
    command: String,
    next_id: AtomicU64,
    connection: Mutex<Option<AppServerConnection>>,
}

struct AppServerConnection {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<anyhow::Result<Value>>>>>,
    thread_sessions: Arc<Mutex<HashMap<String, ThreadBinding>>>,
}

impl AppServerBackend {
    pub(crate) fn new(command: String) -> Self {
        Self {
            inner: Arc::new(AppServerInner {
                command,
                next_id: AtomicU64::new(1),
                connection: Mutex::new(None),
            }),
        }
    }

    async fn ensure_connection(&self) -> anyhow::Result<AppServerConnection> {
        let mut guard = self.inner.connection.lock().await;
        if let Some(connection) = guard.as_ref() {
            return Ok(connection.clone());
        }

        let mut child = Command::new(&self.inner.command)
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to start {}", self.inner.command))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().context("app-server stdin missing")?,
        ));
        let stdout = child.stdout.take().context("app-server stdout missing")?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let thread_sessions = Arc::new(Mutex::new(HashMap::new()));
        spawn_reader(stdout, pending.clone(), thread_sessions.clone());
        let connection = AppServerConnection {
            stdin,
            pending,
            thread_sessions,
        };

        request_on_connection(&self.inner.next_id, &connection, "initialize", initialize_params())
            .await?;
        notify_on_connection(&connection, "initialized", json!({})).await?;

        *guard = Some(connection.clone());
        Ok(connection)
    }

    async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let connection = self.ensure_connection().await?;
        request_on_connection(&self.inner.next_id, &connection, method, params).await
    }

    async fn notify(&self, method: &str, params: Value) -> anyhow::Result<()> {
        let connection = self.ensure_connection().await?;
        notify_on_connection(&connection, method, params).await
    }
}

impl Clone for AppServerConnection {
    fn clone(&self) -> Self {
        Self {
            stdin: self.stdin.clone(),
            pending: self.pending.clone(),
            thread_sessions: self.thread_sessions.clone(),
        }
    }
}
```

- [ ] **Step 6: Implement reader and writer helpers**

Add:

```rust
fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<anyhow::Result<Value>>>>>,
    _thread_sessions: Arc<Mutex<HashMap<String, ThreadBinding>>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = value.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(sender) = pending.lock().await.remove(&id) else {
                continue;
            };
            let result = if let Some(error) = value.get("error") {
                Err(anyhow::anyhow!("app-server request failed: {error}"))
            } else {
                Ok(value.get("result").cloned().unwrap_or_else(|| json!({})))
            };
            let _ = sender.send(result);
        }
    });
}

async fn request_on_connection(
    next_id: &AtomicU64,
    connection: &AppServerConnection,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    let id = next_id.fetch_add(1, Ordering::Relaxed);
    let request = jsonrpc_request(id, method, params);
    let (tx, rx) = oneshot::channel();
    connection.pending.lock().await.insert(id, tx);
    write_json_line(&connection.stdin, &request).await?;
    rx.await.context("app-server response channel closed")?
}

async fn notify_on_connection(
    connection: &AppServerConnection,
    method: &str,
    params: Value,
) -> anyhow::Result<()> {
    write_json_line(
        &connection.stdin,
        &json!({
            "method": method,
            "params": params,
        }),
    )
    .await
}

async fn write_json_line(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> anyhow::Result<()> {
    let mut stdin = stdin.lock().await;
    stdin.write_all(serde_json::to_string(value)?.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}
```

- [ ] **Step 7: Implement `CodexBackend` for app-server**

Add:

```rust
impl CodexBackend for AppServerBackend {
    fn start_thread(
        &self,
        workspace_path: String,
        _title: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<BackendThread>> + Send + '_>> {
        Box::pin(async move {
            let result = self
                .request("thread/start", thread_start_params(&workspace_path))
                .await?;
            let thread_id = result
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .context("thread/start response missing thread.id")?
                .to_string();
            Ok(BackendThread {
                thread_id,
                greeting: Some("Remote Codex session ready.".to_string()),
            })
        })
    }

    fn submit_turn(
        &self,
        session_id: String,
        thread_id: String,
        workspace_path: String,
        message: String,
        sink: std::sync::Arc<dyn BackendEventSink>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<BackendTurn>> + Send + '_>> {
        Box::pin(async move {
            let result = self
                .request(
                    "turn/start",
                    turn_start_params(&thread_id, &workspace_path, &message),
                )
                .await?;
            let turn_id = result
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .context("turn/start response missing turn.id")?
                .to_string();
            sink.emit(session_id, BackendEvent::Status("Codex turn started.".to_string()))
                .await?;
            Ok(BackendTurn { turn_id })
        })
    }
}
```

This step starts with response handling only. Notification dispatch is added in the next task.

- [ ] **Step 8: Run focused bridge tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent backend::app_server
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add codex-rs/remote-agent/src/backend/app_server.rs codex-rs/remote-agent/src/backend/mod.rs
git commit -m "Add app-server bridge skeleton"
```

---

### Task 6: Dispatch App-Server Notifications Into Session Events

**Files:**
- Modify: `codex-rs/remote-agent/src/backend/app_server.rs`
- Modify: `codex-rs/remote-agent/src/backend/mod.rs`
- Modify: `codex-rs/remote-agent/src/sessions.rs`
- Test: `codex-rs/remote-agent/src/backend/app_server.rs`

- [ ] **Step 1: Add notification mapping tests**

Add these tests to `backend/app_server.rs`:

```rust
#[test]
fn maps_agent_message_delta_notification() {
    assert_eq!(
        map_notification(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thr_123",
                "turnId": "turn_456",
                "itemId": "item_1",
                "delta": "hello"
            }
        })),
        Some(MappedNotification {
            thread_id: "thr_123".to_string(),
            turn_id: Some("turn_456".to_string()),
            event: BackendEvent::AssistantDelta("hello".to_string()),
        })
    );
}

#[test]
fn maps_completed_turn_notification() {
    assert_eq!(
        map_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thr_123",
                "turn": {
                    "id": "turn_456",
                    "status": "completed",
                    "items": [],
                    "error": null
                }
            }
        })),
        Some(MappedNotification {
            thread_id: "thr_123".to_string(),
            turn_id: Some("turn_456".to_string()),
            event: BackendEvent::Completed,
        })
    );
}

#[test]
fn maps_failed_turn_notification() {
    assert_eq!(
        map_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thr_123",
                "turn": {
                    "id": "turn_456",
                    "status": "failed",
                    "items": [],
                    "error": {
                        "message": "quota exceeded"
                    }
                }
            }
        })),
        Some(MappedNotification {
            thread_id: "thr_123".to_string(),
            turn_id: Some("turn_456".to_string()),
            event: BackendEvent::Failed {
                message: "quota exceeded".to_string(),
            },
        })
    );
}
```

- [ ] **Step 2: Run failing notification tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent maps_
```

Expected: fail because `MappedNotification` and `map_notification` do not exist.

- [ ] **Step 3: Add mapped notification type and mapper**

Add this to `backend/app_server.rs`:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MappedNotification {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub event: BackendEvent,
}

pub(crate) fn map_notification(value: &Value) -> Option<MappedNotification> {
    let method = value.get("method")?.as_str()?;
    let params = value.get("params")?;
    match method {
        "item/agentMessage/delta" => Some(MappedNotification {
            thread_id: params.get("threadId")?.as_str()?.to_string(),
            turn_id: params
                .get("turnId")
                .and_then(Value::as_str)
                .map(str::to_string),
            event: BackendEvent::AssistantDelta(params.get("delta")?.as_str()?.to_string()),
        }),
        "turn/started" => Some(MappedNotification {
            thread_id: params.get("threadId")?.as_str()?.to_string(),
            turn_id: params
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .map(str::to_string),
            event: BackendEvent::Status("Codex is working.".to_string()),
        }),
        "turn/completed" => {
            let status = params.pointer("/turn/status")?.as_str()?;
            let event = match status {
                "completed" => BackendEvent::Completed,
                "interrupted" => BackendEvent::Failed {
                    message: "Turn interrupted.".to_string(),
                },
                "failed" => BackendEvent::Failed {
                    message: params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed.")
                        .to_string(),
                },
                _ => return None,
            };
            Some(MappedNotification {
                thread_id: params.get("threadId")?.as_str()?.to_string(),
                turn_id: params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                event,
            })
        }
        "turn/diff/updated" => Some(MappedNotification {
            thread_id: params.get("threadId")?.as_str()?.to_string(),
            turn_id: params
                .get("turnId")
                .and_then(Value::as_str)
                .map(str::to_string),
            event: BackendEvent::DiffUpdated,
        }),
        _ => None,
    }
}
```

- [ ] **Step 4: Add backend session binding**

Add this binding type near `AppServerConnection`:

```rust
#[derive(Clone)]
struct ThreadBinding {
    session_id: String,
    sink: Arc<dyn BackendEventSink>,
}
```

The `AppServerConnection` created in Task 5 already has `thread_sessions: Arc<Mutex<HashMap<String, ThreadBinding>>>`; this task starts using it for turn notifications.

- [ ] **Step 5: Update reader to dispatch notifications**

Update the `spawn_reader` notification branch from Task 5 so messages without `id` call `map_notification`. If a binding exists for the notification's `thread_id`, emit the mapped backend event to that session.

Core code:

```rust
if value.get("id").is_none() {
    if let Some(mapped) = map_notification(&value) {
        let binding = thread_sessions
            .lock()
            .await
            .get(&mapped.thread_id)
            .cloned();
        if let Some(binding) = binding {
            let _ = binding
                .sink
                .emit(binding.session_id, mapped.event)
                .await;
        }
    }
    continue;
}
```

- [ ] **Step 6: Bind session sink before `turn/start`**

In `submit_turn`, register the sink before sending `turn/start` so early notifications can be delivered:

```rust
let connection = self.ensure_connection().await?;
connection.thread_sessions.lock().await.insert(
    thread_id.clone(),
    ThreadBinding {
        session_id: session_id.clone(),
        sink: sink.clone(),
    },
);
```

If `turn/start` fails, remove the binding before returning the error:

```rust
if result.is_err() {
    connection.thread_sessions.lock().await.remove(&thread_id);
}
```

- [ ] **Step 7: Run mapper tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent maps_
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add codex-rs/remote-agent/src/backend/app_server.rs codex-rs/remote-agent/src/backend/mod.rs codex-rs/remote-agent/src/sessions.rs
git commit -m "Map app-server notifications to remote events"
```

---

### Task 7: Wire Runtime Config to Use App-Server Backend

**Files:**
- Modify: `codex-rs/remote-agent/src/config.rs`
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Modify: `codex-rs/remote-agent/src/sessions.rs`
- Modify: `codex-rs/remote-agent/src/backend/mod.rs`
- Test: `codex-rs/remote-agent/src/config.rs`

- [ ] **Step 1: Add config tests**

Add these tests to `config.rs`:

```rust
#[tokio::test]
async fn from_cli_defaults_to_app_server_backend() {
    let temp_dir = TempDir::new().unwrap();
    let config = Config::from_cli(Cli {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        state_dir: Some(temp_dir.path().join("state")),
        workspaces: Vec::new(),
        setup_token: Some("setup-secret".to_string()),
        backend: BackendMode::AppServer,
        codex_command: "codex".to_string(),
    })
    .await
    .unwrap();

    assert_eq!(config.backend_mode(), BackendMode::AppServer);
    assert_eq!(config.codex_command(), "codex");
}
```

- [ ] **Step 2: Run failing config test**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent from_cli_defaults_to_app_server_backend
```

Expected: fail because fields do not exist.

- [ ] **Step 3: Add backend CLI options**

In `config.rs`, add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::ValueEnum)]
pub enum BackendMode {
    AppServer,
    Demo,
}
```

Add fields to `Cli`:

```rust
#[arg(long, value_enum, default_value_t = BackendMode::AppServer)]
pub backend: BackendMode,

#[arg(long, default_value = "codex", env = "CODEX_REMOTE_CODEX_COMMAND")]
pub codex_command: String,
```

Add fields to `Config`:

```rust
backend: BackendMode,
codex_command: String,
```

Set them in `from_cli` and add getters:

```rust
pub fn backend_mode(&self) -> BackendMode {
    self.backend
}

pub fn codex_command(&self) -> &str {
    &self.codex_command
}
```

- [ ] **Step 4: Update every test `Cli` construction**

Every test helper constructing `Cli` must now pass:

```rust
backend: BackendMode::Demo,
codex_command: "codex".to_string(),
```

Use `BackendMode::Demo` for route tests so they do not require real app-server.

- [ ] **Step 5: Build backend from config**

In `routes.rs`, construct `SessionManager` with:

```rust
let backend = crate::backend::from_config(&config);
```

Add `from_config` in `backend/mod.rs`:

```rust
use std::sync::Arc;

use crate::config::BackendMode;
use crate::config::Config;

pub(crate) fn from_config(config: &Config) -> Arc<dyn CodexBackend> {
    match config.backend_mode() {
        BackendMode::AppServer => Arc::new(app_server::AppServerBackend::new(
            config.codex_command().to_string(),
        )),
        BackendMode::Demo => Arc::new(demo::DemoBackend::new()),
    }
}
```

- [ ] **Step 6: Run route and config tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent from_cli_defaults_to_app_server_backend
cargo test -p codex-remote-agent submit_message_
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add codex-rs/remote-agent/src/config.rs codex-rs/remote-agent/src/routes.rs codex-rs/remote-agent/src/sessions.rs codex-rs/remote-agent/src/backend/mod.rs codex-rs/remote-agent/tests/api.rs
git commit -m "Select remote agent backend from config"
```

---

### Task 8: Implement Real App-Server Approval Request Handling

**Files:**
- Modify: `codex-rs/remote-agent/src/backend/mod.rs`
- Modify: `codex-rs/remote-agent/src/backend/app_server.rs`
- Modify: `codex-rs/remote-agent/src/sessions.rs`
- Modify: `codex-rs/remote-agent/src/store.rs`
- Test: `codex-rs/remote-agent/src/backend/app_server.rs`
- Test: `codex-rs/remote-agent/src/sessions.rs`

- [ ] **Step 1: Add approval mapping tests**

Add to `backend/app_server.rs`:

```rust
#[test]
fn maps_command_approval_request() {
    assert_eq!(
        map_server_request(&json!({
            "id": 44,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thr_123",
                "turnId": "turn_456",
                "itemId": "item_1",
                "command": "cargo test",
                "reason": "Run project tests"
            }
        })),
        Some(MappedServerRequest {
            request_id: 44,
            thread_id: "thr_123".to_string(),
            approval: BackendApprovalRequest {
                action_type: "command".to_string(),
                command: "cargo test".to_string(),
                risk_summary: "Run project tests".to_string(),
            },
        })
    );
}
```

- [ ] **Step 2: Add backend approval types**

In `backend/mod.rs`, add:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendApprovalRequest {
    pub action_type: String,
    pub command: String,
    pub risk_summary: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BackendApprovalDecision {
    Approve,
    Deny,
}

pub(crate) trait ApprovalResponder: Send + Sync + 'static {
    fn respond(
        &self,
        request_id: u64,
        decision: BackendApprovalDecision,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
}
```

Extend `BackendEvent`:

```rust
ApprovalRequested {
    request_id: u64,
    approval: BackendApprovalRequest,
}
```

- [ ] **Step 3: Implement server request mapper**

In `app_server.rs`, add:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MappedServerRequest {
    pub request_id: u64,
    pub thread_id: String,
    pub approval: BackendApprovalRequest,
}

pub(crate) fn map_server_request(value: &Value) -> Option<MappedServerRequest> {
    let method = value.get("method")?.as_str()?;
    let request_id = value.get("id")?.as_u64()?;
    let params = value.get("params")?;
    match method {
        "item/commandExecution/requestApproval" => Some(MappedServerRequest {
            request_id,
            thread_id: params.get("threadId")?.as_str()?.to_string(),
            approval: BackendApprovalRequest {
                action_type: "command".to_string(),
                command: params
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("network access")
                    .to_string(),
                risk_summary: params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex requests permission to continue.")
                    .to_string(),
            },
        }),
        "item/fileChange/requestApproval" => Some(MappedServerRequest {
            request_id,
            thread_id: params.get("threadId")?.as_str()?.to_string(),
            approval: BackendApprovalRequest {
                action_type: "fileChange".to_string(),
                command: "apply file changes".to_string(),
                risk_summary: params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex requests permission to apply file changes.")
                    .to_string(),
            },
        }),
        _ => None,
    }
}
```

- [ ] **Step 4: Store backend request IDs with approvals**

Add an optional field to `ApprovalRequest` in `models.rs`:

```rust
pub backend_request_id: Option<u64>,
```

Update all existing tests and construction sites to include `backend_request_id: None` for synthetic/demo approvals. For app-server approvals, set `Some(request_id)`.

- [ ] **Step 5: Record approval requests from backend events**

In `SessionManagerSink::record_backend_event`, handle `BackendEvent::ApprovalRequested`:

```rust
BackendEvent::ApprovalRequested { request_id, approval } => {
    let approval_id = new_id();
    self.store
        .upsert_approval(ApprovalRequest {
            id: approval_id.clone(),
            session_id: session_id.to_string(),
            action_type: approval.action_type,
            command: approval.command,
            risk_summary: approval.risk_summary,
            created_at: now,
            status: ApprovalStatus::Pending,
            backend_request_id: Some(request_id),
        })
        .await?;
    (
        Some(SessionStatus::WaitingForApproval),
        SessionEventKind::ApprovalRequested { approval_id },
    )
}
```

- [ ] **Step 6: Send approval decisions back to app-server**

Extend `AppServerBackend` with:

```rust
pub(crate) async fn respond_approval(
    &self,
    request_id: u64,
    decision: BackendApprovalDecision,
) -> anyhow::Result<()> {
    let payload = match decision {
        BackendApprovalDecision::Approve => json!({
            "id": request_id,
            "result": {
                "decision": "accept"
            }
        }),
        BackendApprovalDecision::Deny => json!({
            "id": request_id,
            "result": {
                "decision": "decline"
            }
        }),
    };
    let connection = self.ensure_connection().await?;
    write_json_line(&connection.stdin, &payload).await
}
```

Wire `SessionManager::approve` so when an approval has `backend_request_id`, it calls the backend responder before transitioning local approval state. If the backend response write fails, return `ApproveError::Store`.

- [ ] **Step 7: Unknown approval requests are rejected**

In the app-server reader, if a message has `id` and `method` but `map_server_request` returns `None`, write a JSON-RPC response:

```json
{"id": <id>, "result": {"decision": "decline"}}
```

Then emit a `BackendEvent::Failed { message: "Unsupported approval request: <method>" }` to the bound session if a `threadId` is present in params. This keeps unsupported requests real and explicit.

- [ ] **Step 8: Run approval tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent approval
cargo test -p codex-remote-agent maps_command_approval_request
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add codex-rs/remote-agent/src/backend/mod.rs codex-rs/remote-agent/src/backend/app_server.rs codex-rs/remote-agent/src/models.rs codex-rs/remote-agent/src/sessions.rs codex-rs/remote-agent/src/store.rs codex-rs/remote-agent/tests/api.rs
git commit -m "Bridge app-server approval requests"
```

---

### Task 9: Enable the Frontend Composer

**Files:**
- Modify: `codex-rs/remote-agent/static/app.js`
- Modify: `codex-rs/remote-agent/static/index.html`
- Modify: `codex-rs/remote-agent/static/styles.css`
- Test: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Update embedded UI test expectations**

In `serves_embedded_web_ui`, replace the assertion that expects deterministic composer copy with assertions that expect real composer elements:

```rust
assert!(body.contains(r#"id="messageForm""#));
assert!(body.contains(r#"id="messageInput""#));
assert!(body.contains(r#"Ask Codex"#));
```

- [ ] **Step 2: Update HTML copy**

In `static/index.html`, set the composer input placeholder to:

```html
Ask Codex to change this workspace...
```

Set the composer status text to:

```html
Ready when a session is selected.
```

- [ ] **Step 3: Replace disabled composer handlers**

In `app.js`, replace:

```javascript
elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  revealComposerStatus();
});

elements.messageInput.addEventListener("focus", () => {
  revealComposerStatus();
});
```

with:

```javascript
elements.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitMessage();
});

elements.messageInput.addEventListener("input", () => {
  renderComposerState();
});
```

Remove `revealComposerStatus`.

- [ ] **Step 4: Add `submitMessage`**

Add near `createSession`:

```javascript
async function submitMessage() {
  const session = selectedSession();
  const message = elements.messageInput.value.trim();
  if (!session || !message || composerLocked()) {
    renderComposerState();
    return;
  }

  const token = state.token;
  const sessionId = session.id;
  elements.messageInput.disabled = true;
  elements.messageSend.disabled = true;
  elements.composerStatus.textContent = "Sending...";
  try {
    await apiJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ message }),
      },
      token,
    );
    if (state.token !== token || state.selectedSessionId !== sessionId) {
      return;
    }
    elements.messageInput.value = "";
    const current = selectedSession();
    if (current) {
      current.status = "Running";
    }
    renderWorkspaces();
    renderComposerState();
  } catch (error) {
    if (handleAuthError(error, token)) {
      return;
    }
    if (state.token !== token || state.selectedSessionId !== sessionId) {
      return;
    }
    appendStreamError(sessionId, error.message);
    renderComposerState();
  }
}
```

- [ ] **Step 5: Replace `renderComposerState`**

Replace the function with:

```javascript
function renderComposerState() {
  const session = selectedSession();
  const message = elements.messageInput.value.trim();
  const locked = composerLocked();
  elements.messageInput.disabled = !state.token || !session || locked;
  elements.messageSend.disabled = !state.token || !session || locked || !message;

  if (!state.token) {
    elements.messageInput.placeholder = "Sign in to start";
    elements.composerStatus.textContent = "Setup required.";
  } else if (!session) {
    elements.messageInput.placeholder = "Select a session";
    elements.composerStatus.textContent = "Create or select a session to message Codex.";
  } else if (session.status === "Running") {
    elements.messageInput.placeholder = "Codex is working";
    elements.composerStatus.textContent = "Codex is working...";
  } else if (session.status === "WaitingForApproval") {
    elements.messageInput.placeholder = "Approval required";
    elements.composerStatus.textContent = "Resolve the approval request to continue.";
  } else {
    elements.messageInput.placeholder = "Ask Codex to change this workspace...";
    elements.composerStatus.textContent = "Ready.";
  }
}

function composerLocked() {
  const session = selectedSession();
  return Boolean(
    session &&
      (session.status === "Running" || session.status === "WaitingForApproval"),
  );
}
```

- [ ] **Step 6: Update session state from events**

Replace `updateSessionStateFromEvent` with:

```javascript
function updateSessionStateFromEvent(event) {
  const session = state.sessions.find((item) => item.id === event.sessionId);
  if (!session) {
    return;
  }
  switch (event.kind.type) {
    case "approvalRequested":
      session.status = "WaitingForApproval";
      break;
    case "approvalDecided":
      session.status = event.kind.approved ? "Running" : "Failed";
      break;
    case "errorRaised":
      session.status = "Failed";
      break;
    case "statusText":
      if (event.kind.status === "Session completed.") {
        session.status = "Completed";
      } else if (event.kind.status === "Codex is working.") {
        session.status = "Running";
      }
      break;
    default:
      return;
  }
  session.updatedAt = event.createdAt || session.updatedAt;
  renderWorkspaces();
  renderComposerState();
  renderTitlebar();
}
```

- [ ] **Step 7: Update sidebar summary**

In `renderTitlebar`, change:

```javascript
? `Deterministic backend · ${state.workspaces.length} workspaces`
```

to:

```javascript
? `Codex app-server · ${state.workspaces.length} workspaces`
```

- [ ] **Step 8: Run JS syntax check**

Run:

```bash
node --check codex-rs/remote-agent/static/app.js
```

Expected: pass.

- [ ] **Step 9: Run embedded UI test**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent serves_embedded_web_ui
```

Expected: pass.

- [ ] **Step 10: Commit**

```bash
git add codex-rs/remote-agent/static/app.js codex-rs/remote-agent/static/index.html codex-rs/remote-agent/static/styles.css codex-rs/remote-agent/tests/api.rs
git commit -m "Enable remote agent composer UI"
```

---

### Task 10: Document Runtime and Run Full Verification

**Files:**
- Modify: `codex-rs/remote-agent/README.md`

- [ ] **Step 1: Update README**

Add a section:

```markdown
## Real Codex Backend

`codex-remote-agent` defaults to the real app-server backend:

```bash
cargo run -p codex-remote-agent -- \
  --bind 100.102.128.28:7682 \
  --state-dir /tmp/codex-remote-agent-preview \
  --workspace /root/codex \
  --setup-token ui-preview \
  --backend app-server
```

Open `http://100.102.128.28:7682` from a Tailscale-connected device and use setup token `ui-preview`.

For tests or UI-only demos:

```bash
cargo run -p codex-remote-agent -- \
  --bind 127.0.0.1:7682 \
  --state-dir /tmp/codex-remote-agent-demo \
  --workspace /root/codex \
  --setup-token ui-preview \
  --backend demo
```

The demo backend is explicit. It should not be used to validate real Codex behavior.
```
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd codex-rs
cargo test -p codex-remote-agent
```

Expected: pass.

- [ ] **Step 3: Run formatting**

Run:

```bash
cd codex-rs
just fmt
```

Expected: pass or format files in place.

- [ ] **Step 4: Run scoped fix**

Run:

```bash
cd codex-rs
just fix -p codex-remote-agent
```

Expected: pass or apply lint fixes.

- [ ] **Step 5: Run frontend syntax check**

Run:

```bash
node --check codex-rs/remote-agent/static/app.js
```

Expected: pass.

- [ ] **Step 6: Start Tailscale preview**

If port `7682` is free, run:

```bash
cd /root/codex
cargo run -p codex-remote-agent -- \
  --bind 100.102.128.28:7682 \
  --state-dir /tmp/codex-remote-agent-real-backend-preview \
  --workspace /root/codex \
  --setup-token ui-preview \
  --backend app-server
```

Expected: server listens on `http://100.102.128.28:7682`.

- [ ] **Step 7: Browser smoke test**

Use Playwright or the existing browser QA workflow:

1. Open `http://100.102.128.28:7682`.
2. Enter setup token `ui-preview`.
3. Create a session in `/root/codex`.
4. Submit: `Say hello and list the current workspace path.`
5. Confirm a user message appears.
6. Confirm assistant output streams from app-server.
7. Confirm composer disables while running and re-enables at completion/failure.
8. Confirm browser console has no errors.
9. Repeat at a mobile viewport and confirm no overlap.

- [ ] **Step 8: Commit docs and any verification fixes**

```bash
git add codex-rs/remote-agent/README.md codex-rs/remote-agent
git commit -m "Document real remote agent backend"
```

---

## Self-Review Checklist

- Spec coverage: backend adapter, app-server bridge, real submit endpoint, event mapping, approval boundary, frontend composer states, error handling, tests, and Tailscale preview are all covered.
- Scope control: native apps, hosted relay, multi-host SSH, account sync, and terminal features remain out of scope.
- No fake features: demo mode is explicit; normal runtime uses app-server. Unsupported approval requests are declined and surfaced.
- Type consistency: session metadata uses `app_server_thread_id`/`active_turn_id`; frontend receives camelCase through serde; app-server JSON payloads use camelCase wire names.
- Repo constraints: app-server v2 only, no v1 surface, avoid adding to `codex-core`, run `just fmt`, `cargo test -p codex-remote-agent`, and `just fix -p codex-remote-agent`.
