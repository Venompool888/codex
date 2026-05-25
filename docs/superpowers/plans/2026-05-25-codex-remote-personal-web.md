# Codex Remote Personal Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal self-hosted `codex-remote-agent` that serves a Web UI for workspace selection, session control, approvals, diffs, and event streaming.

**Architecture:** Add a new `codex-remote-agent` Rust crate in `codex-rs/` instead of expanding `codex-core` or the existing app-server. The crate owns a small Axum HTTP server, JSON-file persistence, token auth, workspace allowlisting, an adapter-shaped session service, SSE event streaming, file/diff APIs, and embedded static Web UI assets. The initial Codex backend is a deterministic local adapter so the UI/API contract can be built and tested before wiring real Codex protocol integration.

**Tech Stack:** Rust 2024, Axum, Tokio, Serde/Serde JSON, UUID v7, Time, SHA-256 token hashing, local JSON persistence, Server-Sent Events, static HTML/CSS/JS, Cargo tests, Bazel crate target.

---

## File Structure

- Create `codex-rs/remote-agent/Cargo.toml`: crate manifest for `codex-remote-agent`.
- Create `codex-rs/remote-agent/BUILD.bazel`: Bazel target for the new crate.
- Create `codex-rs/remote-agent/src/lib.rs`: module exports and app construction entry point.
- Create `codex-rs/remote-agent/src/main.rs`: CLI entry point and server startup.
- Create `codex-rs/remote-agent/src/config.rs`: CLI/config types, workspace allowlist, bind address defaults, state directory paths.
- Create `codex-rs/remote-agent/src/models.rs`: shared API/domain models.
- Create `codex-rs/remote-agent/src/store.rs`: JSON-file persistence for setup state, sessions, events, approvals, and audit entries.
- Create `codex-rs/remote-agent/src/auth.rs`: setup token validation, session token creation, token hashing, auth extractor helpers.
- Create `codex-rs/remote-agent/src/workspaces.rs`: workspace validation, file listing, file reads, git status, and git diff helpers.
- Create `codex-rs/remote-agent/src/sessions.rs`: session manager, event bus, deterministic MVP backend adapter, approvals.
- Create `codex-rs/remote-agent/src/routes.rs`: Axum router and REST/SSE handlers.
- Create `codex-rs/remote-agent/src/static_ui.rs`: embedded static asset serving.
- Create `codex-rs/remote-agent/static/index.html`: single-page Web UI shell.
- Create `codex-rs/remote-agent/static/styles.css`: responsive UI styling.
- Create `codex-rs/remote-agent/static/app.js`: browser client logic.
- Create `codex-rs/remote-agent/tests/api.rs`: integration tests for auth, workspaces, sessions, approvals, diffs, and static UI.
- Modify `codex-rs/Cargo.toml`: add workspace member and workspace dependency alias.
- Modify `docs/superpowers/specs/2026-05-25-codex-remote-personal-web-design.md`: append implementation note only if the implementation intentionally changes the accepted design.

## Task 1: Add The Crate Skeleton

**Files:**
- Create: `codex-rs/remote-agent/Cargo.toml`
- Create: `codex-rs/remote-agent/BUILD.bazel`
- Create: `codex-rs/remote-agent/src/lib.rs`
- Create: `codex-rs/remote-agent/src/main.rs`
- Modify: `codex-rs/Cargo.toml`

- [ ] **Step 1: Add the workspace member test**

Run:

```bash
cd /root/codex/codex-rs
cargo metadata --no-deps --format-version 1 | rg '"name":"codex-remote-agent"'
```

Expected: FAIL because the crate does not exist yet.

- [ ] **Step 2: Create the crate manifest**

Create `codex-rs/remote-agent/Cargo.toml`:

```toml
[package]
name = "codex-remote-agent"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "codex-remote-agent"
path = "src/main.rs"

[lib]
name = "codex_remote_agent"
path = "src/lib.rs"

[lints]
workspace = true

[dependencies]
anyhow = { workspace = true }
axum = { workspace = true, default-features = false, features = [
    "http1",
    "json",
    "tokio",
] }
base64 = { workspace = true }
clap = { workspace = true, features = ["derive"] }
futures = { workspace = true }
http = { workspace = true }
rand = { workspace = true }
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
sha2 = { workspace = true }
thiserror = { workspace = true }
time = { workspace = true, features = ["formatting", "serde"] }
tokio = { workspace = true, features = [
    "fs",
    "macros",
    "net",
    "process",
    "rt-multi-thread",
    "signal",
    "sync",
    "time",
] }
tokio-stream = { workspace = true, features = ["sync"] }
tracing = { workspace = true }
tracing-subscriber = { workspace = true, features = ["env-filter", "fmt"] }
uuid = { workspace = true, features = ["serde", "v7"] }

[dev-dependencies]
pretty_assertions = { workspace = true }
reqwest = { workspace = true, features = ["json", "rustls-tls", "stream"] }
tempfile = { workspace = true }
tower = { workspace = true, features = ["util"] }
```

- [ ] **Step 3: Add the Bazel crate target**

Create `codex-rs/remote-agent/BUILD.bazel`:

```python
load("//:defs.bzl", "codex_rust_crate")

codex_rust_crate(
    name = "remote-agent",
    crate_name = "codex_remote_agent",
)
```

- [ ] **Step 4: Add initial source files**

Create `codex-rs/remote-agent/src/lib.rs`:

```rust
pub mod auth;
pub mod config;
pub mod models;
pub mod routes;
pub mod sessions;
pub mod static_ui;
pub mod store;
pub mod workspaces;

pub use routes::build_router;
```

Create `codex-rs/remote-agent/src/main.rs`:

```rust
use anyhow::Context;
use clap::Parser;
use codex_remote_agent::build_router;
use codex_remote_agent::config::Cli;
use codex_remote_agent::config::Config;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    let config = Config::from_cli(cli).await?;
    let listener = TcpListener::bind(config.bind_addr())
        .await
        .with_context(|| format!("failed to bind {}", config.bind_addr()))?;
    let addr = listener.local_addr()?;

    tracing::info!("codex-remote-agent listening on http://{addr}");
    axum::serve(listener, build_router(config)).await?;

    Ok(())
}
```

Temporarily create empty modules so the crate can compile:

```bash
touch codex-rs/remote-agent/src/auth.rs
touch codex-rs/remote-agent/src/config.rs
touch codex-rs/remote-agent/src/models.rs
touch codex-rs/remote-agent/src/routes.rs
touch codex-rs/remote-agent/src/sessions.rs
touch codex-rs/remote-agent/src/static_ui.rs
touch codex-rs/remote-agent/src/store.rs
touch codex-rs/remote-agent/src/workspaces.rs
```

- [ ] **Step 5: Register the crate in the workspace**

Modify `codex-rs/Cargo.toml`:

```toml
[workspace]
members = [
    "aws-auth",
    "analytics",
    "agent-graph-store",
    "agent-identity",
    "backend-client",
    "ansi-escape",
    "async-utils",
    "app-server",
    "app-server-transport",
    "app-server-client",
    "app-server-protocol",
    "app-server-test-client",
    "remote-agent",
    # keep the existing entries after this line unchanged
]
```

Also add this entry in `[workspace.dependencies]` near the other internal crates:

```toml
codex-remote-agent = { path = "remote-agent" }
```

Add this external workspace dependency near the other external crates:

```toml
tower = "0.5"
```

- [ ] **Step 6: Add minimal config and router code**

Replace `codex-rs/remote-agent/src/config.rs`:

```rust
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;

#[derive(Debug, Parser)]
pub struct Cli {
    #[arg(long, default_value = "127.0.0.1:7680")]
    pub bind: SocketAddr,

    #[arg(long)]
    pub state_dir: Option<PathBuf>,

    #[arg(long = "workspace")]
    pub workspaces: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct Config {
    bind: SocketAddr,
    state_dir: PathBuf,
    workspaces: Vec<PathBuf>,
}

impl Config {
    pub async fn from_cli(cli: Cli) -> anyhow::Result<Self> {
        let state_dir = match cli.state_dir {
            Some(path) => path,
            None => std::env::current_dir()?.join(".codex-remote-agent"),
        };
        tokio::fs::create_dir_all(&state_dir)
            .await
            .with_context(|| format!("failed to create {}", state_dir.display()))?;

        Ok(Self {
            bind: cli.bind,
            state_dir,
            workspaces: cli.workspaces,
        })
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind
    }

    pub fn state_dir(&self) -> &PathBuf {
        &self.state_dir
    }

    pub fn workspaces(&self) -> &[PathBuf] {
        &self.workspaces
    }
}
```

Replace `codex-rs/remote-agent/src/routes.rs`:

```rust
use axum::Json;
use axum::Router;
use axum::routing::get;
use serde::Serialize;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

pub fn build_router(config: Config) -> Router {
    let state = AppState { config };
    Router::new()
        .route("/api/health", get(health))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}
```

- [ ] **Step 7: Run the crate metadata check**

Run:

```bash
cd /root/codex/codex-rs
cargo metadata --no-deps --format-version 1 | rg '"name":"codex-remote-agent"'
```

Expected: PASS with a JSON line containing `"name":"codex-remote-agent"`.

- [ ] **Step 8: Run the package tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/Cargo.toml codex-rs/remote-agent
git commit -m "Add codex remote agent crate"
```

## Task 2: Define API Models

**Files:**
- Modify: `codex-rs/remote-agent/src/models.rs`
- Test: `codex-rs/remote-agent/src/models.rs`

- [ ] **Step 1: Write model serialization tests**

Replace `codex-rs/remote-agent/src/models.rs`:

```rust
use pretty_assertions::assert_eq;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_serializes_with_camel_case_fields() {
        let workspace = Workspace {
            id: "main".to_string(),
            display_name: "Main".to_string(),
            path: "/srv/app".to_string(),
            branch: Some("main".to_string()),
            dirty: true,
            last_session_id: Some("session-1".to_string()),
        };

        let value = serde_json::to_value(workspace).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "main",
                "displayName": "Main",
                "path": "/srv/app",
                "branch": "main",
                "dirty": true,
                "lastSessionId": "session-1"
            })
        );
    }

    #[test]
    fn session_event_serializes_as_tagged_union() {
        let event = SessionEvent {
            id: "event-1".to_string(),
            session_id: "session-1".to_string(),
            created_at: 1_779_716_738,
            kind: SessionEventKind::ApprovalRequested {
                approval_id: "approval-1".to_string(),
            },
        };

        let value = serde_json::to_value(event).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "event-1",
                "sessionId": "session-1",
                "createdAt": 1779716738,
                "kind": {
                    "type": "approvalRequested",
                    "approvalId": "approval-1"
                }
            })
        );
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent models
```

Expected: FAIL with missing model types.

- [ ] **Step 3: Implement the models**

Replace `codex-rs/remote-agent/src/models.rs`:

```rust
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub display_name: String,
    pub path: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub last_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Running,
    WaitingForApproval,
    Stale,
    Failed,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub session_id: String,
    pub created_at: i64,
    pub kind: SessionEventKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SessionEventKind {
    SessionCreated,
    MessageDelta { role: String, content: String },
    ToolCallStarted { command: String },
    ToolCallCompleted { exit_code: i32 },
    ApprovalRequested { approval_id: String },
    DiffUpdated,
    ErrorRaised { message: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub session_id: String,
    pub action_type: String,
    pub command: String,
    pub risk_summary: String,
    pub created_at: i64,
    pub status: ApprovalStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub kind: FileEntryKind,
    pub size: u64,
    pub modified_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileEntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn workspace_serializes_with_camel_case_fields() {
        let workspace = Workspace {
            id: "main".to_string(),
            display_name: "Main".to_string(),
            path: "/srv/app".to_string(),
            branch: Some("main".to_string()),
            dirty: true,
            last_session_id: Some("session-1".to_string()),
        };

        let value = serde_json::to_value(workspace).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "main",
                "displayName": "Main",
                "path": "/srv/app",
                "branch": "main",
                "dirty": true,
                "lastSessionId": "session-1"
            })
        );
    }

    #[test]
    fn session_event_serializes_as_tagged_union() {
        let event = SessionEvent {
            id: "event-1".to_string(),
            session_id: "session-1".to_string(),
            created_at: 1_779_716_738,
            kind: SessionEventKind::ApprovalRequested {
                approval_id: "approval-1".to_string(),
            },
        };

        let value = serde_json::to_value(event).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "event-1",
                "sessionId": "session-1",
                "createdAt": 1779716738,
                "kind": {
                    "type": "approvalRequested",
                    "approvalId": "approval-1"
                }
            })
        );
    }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent models
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/remote-agent/src/models.rs
git commit -m "Define codex remote agent API models"
```

## Task 3: Add JSON Persistence

**Files:**
- Modify: `codex-rs/remote-agent/src/store.rs`
- Test: `codex-rs/remote-agent/src/store.rs`

- [ ] **Step 1: Write persistence tests**

Replace `codex-rs/remote-agent/src/store.rs`:

```rust
#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;
    use crate::models::Session;
    use crate::models::SessionStatus;

    #[tokio::test]
    async fn saves_and_loads_sessions() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let session = Session {
            id: "session-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Build feature".to_string(),
            status: SessionStatus::Running,
            created_at: 1,
            updated_at: 2,
        };

        store.upsert_session(session.clone()).await.unwrap();
        let loaded = store.sessions().await.unwrap();

        assert_eq!(loaded, vec![session]);
    }

    #[tokio::test]
    async fn setup_state_round_trips() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let state = SetupState {
            setup_complete: true,
            setup_token_hash: "setup-hash".to_string(),
            session_token_hash: Some("session-hash".to_string()),
        };

        store.save_setup_state(&state).await.unwrap();

        assert_eq!(store.setup_state().await.unwrap(), state);
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent store
```

Expected: FAIL with missing `Store` and `SetupState`.

- [ ] **Step 3: Implement JSON persistence**

Replace `codex-rs/remote-agent/src/store.rs`:

```rust
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::models::ApprovalRequest;
use crate::models::Session;
use crate::models::SessionEvent;

#[derive(Clone)]
pub struct Store {
    inner: Arc<Mutex<StoreInner>>,
}

#[derive(Debug)]
struct StoreInner {
    dir: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub setup_complete: bool,
    pub setup_token_hash: String,
    pub session_token_hash: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsFile {
    sessions: Vec<Session>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventsFile {
    events: Vec<SessionEvent>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalsFile {
    approvals: Vec<ApprovalRequest>,
}

impl Store {
    pub fn new(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(StoreInner { dir })),
        })
    }

    pub async fn setup_state(&self) -> anyhow::Result<SetupState> {
        let inner = self.inner.lock().await;
        read_json(inner.dir.join("setup.json")).await
    }

    pub async fn save_setup_state(&self, state: &SetupState) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        write_json(inner.dir.join("setup.json"), state).await
    }

    pub async fn sessions(&self) -> anyhow::Result<Vec<Session>> {
        let inner = self.inner.lock().await;
        let file: SessionsFile = read_json(inner.dir.join("sessions.json")).await?;
        Ok(file.sessions)
    }

    pub async fn upsert_session(&self, session: Session) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        let path = inner.dir.join("sessions.json");
        let mut file: SessionsFile = read_json(path.clone()).await?;
        if let Some(existing) = file.sessions.iter_mut().find(|item| item.id == session.id) {
            *existing = session;
        } else {
            file.sessions.push(session);
        }
        write_json(path, &file).await
    }

    pub async fn events(&self, session_id: &str) -> anyhow::Result<Vec<SessionEvent>> {
        let inner = self.inner.lock().await;
        let file: EventsFile = read_json(inner.dir.join("events.json")).await?;
        Ok(file
            .events
            .into_iter()
            .filter(|event| event.session_id == session_id)
            .collect())
    }

    pub async fn append_event(&self, event: SessionEvent) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        let path = inner.dir.join("events.json");
        let mut file: EventsFile = read_json(path.clone()).await?;
        file.events.push(event);
        write_json(path, &file).await
    }

    pub async fn approvals(&self) -> anyhow::Result<Vec<ApprovalRequest>> {
        let inner = self.inner.lock().await;
        let file: ApprovalsFile = read_json(inner.dir.join("approvals.json")).await?;
        Ok(file.approvals)
    }

    pub async fn upsert_approval(&self, approval: ApprovalRequest) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        let path = inner.dir.join("approvals.json");
        let mut file: ApprovalsFile = read_json(path.clone()).await?;
        if let Some(existing) = file
            .approvals
            .iter_mut()
            .find(|item| item.id == approval.id)
        {
            *existing = approval;
        } else {
            file.approvals.push(approval);
        }
        write_json(path, &file).await
    }
}

async fn read_json<T>(path: PathBuf) -> anyhow::Result<T>
where
    T: Default + for<'de> Deserialize<'de>,
{
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to parse {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
    }
}

async fn write_json<T>(path: PathBuf, value: &T) -> anyhow::Result<()>
where
    T: Serialize,
{
    let bytes = serde_json::to_vec_pretty(value)?;
    tokio::fs::write(&path, bytes)
        .await
        .with_context(|| format!("failed to write {}", path.display()))
}

impl Default for SetupState {
    fn default() -> Self {
        Self {
            setup_complete: false,
            setup_token_hash: String::new(),
            session_token_hash: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;
    use crate::models::SessionStatus;

    #[tokio::test]
    async fn saves_and_loads_sessions() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let session = Session {
            id: "session-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Build feature".to_string(),
            status: SessionStatus::Running,
            created_at: 1,
            updated_at: 2,
        };

        store.upsert_session(session.clone()).await.unwrap();
        let loaded = store.sessions().await.unwrap();

        assert_eq!(loaded, vec![session]);
    }

    #[tokio::test]
    async fn setup_state_round_trips() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let state = SetupState {
            setup_complete: true,
            setup_token_hash: "setup-hash".to_string(),
            session_token_hash: Some("session-hash".to_string()),
        };

        store.save_setup_state(&state).await.unwrap();

        assert_eq!(store.setup_state().await.unwrap(), state);
    }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent store
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/remote-agent/src/store.rs
git commit -m "Persist codex remote agent state"
```

## Task 4: Implement Setup And Token Auth

**Files:**
- Modify: `codex-rs/remote-agent/src/auth.rs`
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Modify: `codex-rs/remote-agent/src/config.rs`
- Test: `codex-rs/remote-agent/src/auth.rs`
- Test: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Write auth unit tests**

Replace `codex-rs/remote-agent/src/auth.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_verifies_against_hash() {
        let token = generate_token();
        let hash = hash_token(&token);

        assert!(verify_token(&token, &hash));
        assert!(!verify_token("wrong", &hash));
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent auth
```

Expected: FAIL with missing token helpers.

- [ ] **Step 3: Implement auth helpers**

Replace `codex-rs/remote-agent/src/auth.rs`:

```rust
use axum::extract::FromRef;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::Digest;
use sha2::Sha256;

use crate::routes::AppState;

#[derive(Clone, Debug)]
pub struct Authenticated;

pub fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

pub fn verify_token(token: &str, expected_hash: &str) -> bool {
    hash_token(token) == expected_hash
}

impl<S> FromRequestParts<S> for Authenticated
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let Some(header) = parts.headers.get(axum::http::header::AUTHORIZATION) else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let Ok(value) = header.to_str() else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let Some(token) = value.strip_prefix("Bearer ") else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let setup_state = state.store.setup_state().await.map_err(|_| StatusCode::UNAUTHORIZED)?;
        let Some(hash) = setup_state.session_token_hash else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        if verify_token(token, &hash) {
            Ok(Authenticated)
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_verifies_against_hash() {
        let token = generate_token();
        let hash = hash_token(&token);

        assert!(verify_token(&token, &hash));
        assert!(!verify_token("wrong", &hash));
    }
}
```

- [ ] **Step 4: Update config to carry setup token hash**

Modify `codex-rs/remote-agent/src/config.rs` so `Cli` and `Config` include setup token support:

```rust
#[derive(Debug, Parser)]
pub struct Cli {
    #[arg(long, default_value = "127.0.0.1:7680")]
    pub bind: SocketAddr,

    #[arg(long)]
    pub state_dir: Option<PathBuf>,

    #[arg(long = "workspace")]
    pub workspaces: Vec<PathBuf>,

    #[arg(long, env = "CODEX_REMOTE_SETUP_TOKEN")]
    pub setup_token: Option<String>,
}
```

Add a field to `Config`:

```rust
setup_token: Option<String>,
```

Set it in `from_cli`:

```rust
setup_token: cli.setup_token,
```

Add an accessor:

```rust
pub fn setup_token(&self) -> Option<&str> {
    self.setup_token.as_deref()
}
```

- [ ] **Step 5: Add setup API integration tests**

Create `codex-rs/remote-agent/tests/api.rs`:

```rust
use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tower::ServiceExt;

use codex_remote_agent::build_router;
use codex_remote_agent::config::Config;

async fn test_app(temp_dir: &TempDir) -> Router {
    let cli = codex_remote_agent::config::Cli {
        bind: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        state_dir: Some(temp_dir.path().to_path_buf()),
        workspaces: Vec::new(),
        setup_token: Some("setup-secret".to_string()),
    };
    let config = Config::from_cli(cli).await.unwrap();
    build_router(config)
}

#[tokio::test]
async fn setup_returns_session_token_for_valid_setup_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/setup")
            .header("content-type", "application/json")
            .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn protected_endpoint_requires_bearer_token() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app.oneshot(
        Request::builder()
            .uri("/api/workspaces")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
}
```

- [ ] **Step 6: Run tests to verify integration failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent setup_returns_session_token_for_valid_setup_token protected_endpoint_requires_bearer_token
```

Expected: FAIL because `/api/setup` and `/api/workspaces` do not exist and `ServiceExt` may need an import.

- [ ] **Step 7: Implement setup route and wire Store into AppState**

Replace `codex-rs/remote-agent/src/routes.rs`:

```rust
use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::routing::post;
use serde::Deserialize;
use serde::Serialize;

use crate::auth::Authenticated;
use crate::auth::generate_token;
use crate::auth::hash_token;
use crate::auth::verify_token;
use crate::config::Config;
use crate::store::SetupState;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub store: Store,
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
    let store = Store::new(config.state_dir().clone()).expect("store initialization failed");
    let state = AppState { config, store };
    Router::new()
        .route("/api/health", get(health))
        .route("/api/setup", post(setup))
        .route("/api/workspaces", get(list_workspaces_placeholder))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn setup(
    State(state): State<AppState>,
    Json(request): Json<SetupRequest>,
) -> Result<Json<SetupResponse>, StatusCode> {
    let Some(expected_setup_token) = state.config.setup_token() else {
        return Err(StatusCode::FORBIDDEN);
    };
    if request.setup_token != expected_setup_token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let session_token = generate_token();
    let setup_state = SetupState {
        setup_complete: true,
        setup_token_hash: hash_token(expected_setup_token),
        session_token_hash: Some(hash_token(&session_token)),
    };
    state
        .store
        .save_setup_state(&setup_state)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(SetupResponse { session_token }))
}

async fn list_workspaces_placeholder(
    _auth: Authenticated,
) -> Result<Json<Vec<serde_json::Value>>, StatusCode> {
    Ok(Json(Vec::new()))
}
```

- [ ] **Step 8: Add the ServiceExt import used by integration tests**

Add this import to `codex-rs/remote-agent/tests/api.rs`:

```rust
use tower::ServiceExt;
```

- [ ] **Step 9: Run tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent auth setup_returns_session_token_for_valid_setup_token protected_endpoint_requires_bearer_token
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/Cargo.toml codex-rs/remote-agent
git commit -m "Add setup token auth to remote agent"
```

## Task 5: Implement Workspace File And Diff APIs

**Files:**
- Modify: `codex-rs/remote-agent/src/workspaces.rs`
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Test: `codex-rs/remote-agent/src/workspaces.rs`
- Test: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Write workspace unit tests**

Replace `codex-rs/remote-agent/src/workspaces.rs`:

```rust
#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn rejects_path_traversal_outside_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join("repo");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let workspace = WorkspaceRoot::new("repo".to_string(), root.clone()).unwrap();

        let err = workspace.resolve_relative("../secret.txt").unwrap_err();

        assert_eq!(err.to_string(), "path escapes workspace");
    }

    #[tokio::test]
    async fn lists_files_relative_to_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join("repo");
        tokio::fs::create_dir_all(root.join("src")).await.unwrap();
        tokio::fs::write(root.join("src/main.rs"), "fn main() {}").await.unwrap();
        let workspace = WorkspaceRoot::new("repo".to_string(), root).unwrap();

        let entries = workspace.list_files("").await.unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src");
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent workspaces
```

Expected: FAIL with missing workspace helpers.

- [ ] **Step 3: Implement workspace helpers**

Replace `codex-rs/remote-agent/src/workspaces.rs`:

```rust
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use tokio::process::Command;

use crate::models::DiffFile;
use crate::models::DiffSummary;
use crate::models::FileEntry;
use crate::models::FileEntryKind;
use crate::models::Workspace;

#[derive(Clone, Debug)]
pub struct WorkspaceRoot {
    id: String,
    root: PathBuf,
}

impl WorkspaceRoot {
    pub fn new(id: String, root: PathBuf) -> anyhow::Result<Self> {
        let root = root
            .canonicalize()
            .with_context(|| format!("failed to canonicalize {}", root.display()))?;
        Ok(Self { id, root })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn to_workspace(&self, last_session_id: Option<String>) -> Workspace {
        Workspace {
            id: self.id.clone(),
            display_name: self.id.clone(),
            path: self.root.display().to_string(),
            branch: None,
            dirty: false,
            last_session_id,
        }
    }

    pub fn resolve_relative(&self, relative: &str) -> anyhow::Result<PathBuf> {
        let candidate = self.root.join(relative);
        let canonical = if candidate.exists() {
            candidate.canonicalize()?
        } else {
            let parent = candidate.parent().unwrap_or(self.root.as_path()).canonicalize()?;
            let Some(file_name) = candidate.file_name() else {
                return Ok(parent);
            };
            parent.join(file_name)
        };
        if !canonical.starts_with(&self.root) {
            bail!("path escapes workspace");
        }
        Ok(canonical)
    }

    pub async fn list_files(&self, relative: &str) -> anyhow::Result<Vec<FileEntry>> {
        let dir = self.resolve_relative(relative)?;
        let mut read_dir = tokio::fs::read_dir(&dir).await?;
        let mut entries = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let metadata = entry.metadata().await?;
            let path = entry.path();
            let relative_path = path
                .strip_prefix(&self.root)?
                .to_string_lossy()
                .replace('\\', "/");
            entries.push(FileEntry {
                path: relative_path,
                kind: if metadata.is_dir() {
                    FileEntryKind::Directory
                } else {
                    FileEntryKind::File
                },
                size: metadata.len(),
                modified_at: None,
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    pub async fn read_file(&self, relative: &str) -> anyhow::Result<String> {
        let file = self.resolve_relative(relative)?;
        tokio::fs::read_to_string(file).await.map_err(Into::into)
    }

    pub async fn diff_summary(&self) -> anyhow::Result<DiffSummary> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .arg("diff")
            .arg("--numstat")
            .output()
            .await?;
        if !output.status.success() {
            bail!("git diff failed");
        }
        let stdout = String::from_utf8(output.stdout)?;
        let mut files = Vec::new();
        let mut additions = 0_u64;
        let mut deletions = 0_u64;
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() != 3 {
                continue;
            }
            let file_additions = parts[0].parse::<u64>().unwrap_or(0);
            let file_deletions = parts[1].parse::<u64>().unwrap_or(0);
            additions += file_additions;
            deletions += file_deletions;
            files.push(DiffFile {
                path: parts[2].to_string(),
                status: "modified".to_string(),
                additions: file_additions,
                deletions: file_deletions,
            });
        }
        Ok(DiffSummary {
            files,
            additions,
            deletions,
        })
    }
}

pub fn workspace_roots(paths: &[PathBuf]) -> anyhow::Result<Vec<WorkspaceRoot>> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| WorkspaceRoot::new(format!("workspace-{}", index + 1), path.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn rejects_path_traversal_outside_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join("repo");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let workspace = WorkspaceRoot::new("repo".to_string(), root.clone()).unwrap();

        let err = workspace.resolve_relative("../secret.txt").unwrap_err();

        assert_eq!(err.to_string(), "path escapes workspace");
    }

    #[tokio::test]
    async fn lists_files_relative_to_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join("repo");
        tokio::fs::create_dir_all(root.join("src")).await.unwrap();
        tokio::fs::write(root.join("src/main.rs"), "fn main() {}").await.unwrap();
        let workspace = WorkspaceRoot::new("repo".to_string(), root).unwrap();

        let entries = workspace.list_files("").await.unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src");
    }
}
```

- [ ] **Step 4: Wire workspace routes**

In `codex-rs/remote-agent/src/routes.rs`, import and add handlers:

```rust
use axum::extract::Path;
use axum::extract::Query;
use crate::workspaces::workspace_roots;
```

Add request type:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileQuery {
    path: Option<String>,
}
```

Replace the `/api/workspaces` route and add file/diff routes:

```rust
.route("/api/workspaces", get(list_workspaces))
.route("/api/workspaces/{workspace_id}/files", get(list_files))
.route("/api/workspaces/{workspace_id}/file", get(read_file))
.route("/api/workspaces/{workspace_id}/diff", get(diff_summary))
```

Add handlers:

```rust
async fn list_workspaces(
    _auth: Authenticated,
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::models::Workspace>>, StatusCode> {
    let roots = workspace_roots(state.config.workspaces())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let sessions = state
        .store
        .sessions()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let workspaces = roots
        .into_iter()
        .map(|root| {
            let last_session_id = sessions
                .iter()
                .rev()
                .find(|session| session.workspace_id == root.id())
                .map(|session| session.id.clone());
            root.to_workspace(last_session_id)
        })
        .collect();
    Ok(Json(workspaces))
}

async fn list_files(
    _auth: Authenticated,
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Vec<crate::models::FileEntry>>, StatusCode> {
    let root = workspace_by_id(&state, &workspace_id)?;
    let entries = root
        .list_files(query.path.as_deref().unwrap_or(""))
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(entries))
}

async fn read_file(
    _auth: Authenticated,
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<String, StatusCode> {
    let root = workspace_by_id(&state, &workspace_id)?;
    root.read_file(query.path.as_deref().unwrap_or(""))
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)
}

async fn diff_summary(
    _auth: Authenticated,
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<crate::models::DiffSummary>, StatusCode> {
    let root = workspace_by_id(&state, &workspace_id)?;
    let diff = root
        .diff_summary()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(diff))
}

fn workspace_by_id(
    state: &AppState,
    workspace_id: &str,
) -> Result<crate::workspaces::WorkspaceRoot, StatusCode> {
    workspace_roots(state.config.workspaces())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .find(|root| root.id() == workspace_id)
        .ok_or(StatusCode::NOT_FOUND)
}
```

Delete `list_workspaces_placeholder`.

- [ ] **Step 5: Add API coverage for workspace auth success**

Append to `codex-rs/remote-agent/tests/api.rs`:

```rust
#[tokio::test]
async fn workspace_list_returns_configured_workspace_after_setup() {
    let temp_dir = TempDir::new().unwrap();
    let repo = temp_dir.path().join("repo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    let cli = codex_remote_agent::config::Cli {
        bind: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        state_dir: Some(temp_dir.path().join("state")),
        workspaces: vec![repo],
        setup_token: Some("setup-secret".to_string()),
    };
    let config = Config::from_cli(cli).await.unwrap();
    let app = build_router(config);

    let setup_response = app.clone().oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/setup")
            .header("content-type", "application/json")
            .body(Body::from(json!({"setupToken":"setup-secret"}).to_string()))
            .unwrap(),
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(setup_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let token = serde_json::from_slice::<serde_json::Value>(&body)
        .unwrap()
        .get("sessionToken")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();

    let response = app.oneshot(
        Request::builder()
            .uri("/api/workspaces")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent workspaces workspace_list_returns_configured_workspace_after_setup
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/remote-agent
git commit -m "Add workspace file and diff APIs"
```

## Task 6: Implement Sessions, SSE, And Approvals

**Files:**
- Modify: `codex-rs/remote-agent/src/sessions.rs`
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Test: `codex-rs/remote-agent/src/sessions.rs`
- Test: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Write session manager tests**

Replace `codex-rs/remote-agent/src/sessions.rs`:

```rust
#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;
    use crate::models::ApprovalStatus;
    use crate::store::Store;

    #[tokio::test]
    async fn starting_session_records_event_and_pending_approval() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let manager = SessionManager::new(store.clone());

        let session = manager
            .start_session("workspace-1".to_string(), "Build feature".to_string())
            .await
            .unwrap();
        let approvals = store.approvals().await.unwrap();
        let events = store.events(&session.id).await.unwrap();

        assert_eq!(session.workspace_id, "workspace-1");
        assert_eq!(approvals[0].status, ApprovalStatus::Pending);
        assert_eq!(events.len(), 3);
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent sessions
```

Expected: FAIL with missing `SessionManager`.

- [ ] **Step 3: Implement deterministic session manager**

Replace `codex-rs/remote-agent/src/sessions.rs`:

```rust
use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::models::ApprovalRequest;
use crate::models::ApprovalStatus;
use crate::models::Session;
use crate::models::SessionEvent;
use crate::models::SessionEventKind;
use crate::models::SessionStatus;
use crate::store::Store;

#[derive(Clone)]
pub struct SessionManager {
    store: Store,
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<SessionEvent>>>>,
}

impl SessionManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_session(
        &self,
        workspace_id: String,
        title: String,
    ) -> anyhow::Result<Session> {
        let now = now_unix();
        let session = Session {
            id: Uuid::now_v7().to_string(),
            workspace_id,
            title,
            status: SessionStatus::WaitingForApproval,
            created_at: now,
            updated_at: now,
        };
        self.store.upsert_session(session.clone()).await?;
        self.emit(&session.id, SessionEventKind::SessionCreated).await?;
        self.emit(
            &session.id,
            SessionEventKind::MessageDelta {
                role: "assistant".to_string(),
                content: "Remote Codex session started.".to_string(),
            },
        )
        .await?;

        let approval = ApprovalRequest {
            id: Uuid::now_v7().to_string(),
            session_id: session.id.clone(),
            action_type: "command".to_string(),
            command: "git status --short".to_string(),
            risk_summary: "Read-only repository status check.".to_string(),
            created_at: now,
            status: ApprovalStatus::Pending,
        };
        self.store.upsert_approval(approval.clone()).await?;
        self.emit(
            &session.id,
            SessionEventKind::ApprovalRequested {
                approval_id: approval.id,
            },
        )
        .await?;
        Ok(session)
    }

    pub async fn list_sessions(&self) -> anyhow::Result<Vec<Session>> {
        self.store.sessions().await
    }

    pub async fn events(&self, session_id: &str) -> anyhow::Result<Vec<SessionEvent>> {
        self.store.events(session_id).await
    }

    pub async fn subscribe(&self, session_id: &str) -> broadcast::Receiver<SessionEvent> {
        self.channel(session_id).await.subscribe()
    }

    pub async fn approve(&self, approval_id: &str, approved: bool) -> anyhow::Result<()> {
        let mut approvals = self.store.approvals().await?;
        let Some(mut approval) = approvals
            .drain(..)
            .find(|item| item.id == approval_id)
        else {
            anyhow::bail!("approval not found");
        };
        approval.status = if approved {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Denied
        };
        self.store.upsert_approval(approval.clone()).await?;
        let event = if approved {
            SessionEventKind::ToolCallCompleted { exit_code: 0 }
        } else {
            SessionEventKind::ErrorRaised {
                message: "Command denied by user.".to_string(),
            }
        };
        self.emit(&approval.session_id, event).await?;
        Ok(())
    }

    async fn emit(&self, session_id: &str, kind: SessionEventKind) -> anyhow::Result<()> {
        let event = SessionEvent {
            id: Uuid::now_v7().to_string(),
            session_id: session_id.to_string(),
            created_at: now_unix(),
            kind,
        };
        self.store.append_event(event.clone()).await?;
        let channel = self.channel(session_id).await;
        let _ = channel.send(event);
        Ok(())
    }

    async fn channel(&self, session_id: &str) -> broadcast::Sender<SessionEvent> {
        let mut channels = self.channels.lock().await;
        channels
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let (sender, _receiver) = broadcast::channel(128);
                sender
            })
            .clone()
    }
}

fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;
    use crate::models::ApprovalStatus;

    #[tokio::test]
    async fn starting_session_records_event_and_pending_approval() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let manager = SessionManager::new(store.clone());

        let session = manager
            .start_session("workspace-1".to_string(), "Build feature".to_string())
            .await
            .unwrap();
        let approvals = store.approvals().await.unwrap();
        let events = store.events(&session.id).await.unwrap();

        assert_eq!(session.workspace_id, "workspace-1");
        assert_eq!(approvals[0].status, ApprovalStatus::Pending);
        assert_eq!(events.len(), 3);
    }
}
```

- [ ] **Step 4: Wire session routes and SSE**

In `codex-rs/remote-agent/src/routes.rs`, add imports:

```rust
use axum::response::sse::Event;
use axum::response::Sse;
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use crate::sessions::SessionManager;
```

`BroadcastStream` is available because Task 1 enabled the `sync` feature for `tokio-stream`.

Add to `AppState`:

```rust
pub sessions: SessionManager,
```

Update `build_router`:

```rust
let sessions = SessionManager::new(store.clone());
let state = AppState {
    config,
    store,
    sessions,
};
```

Add request structs:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    workspace_id: String,
    title: String,
}
```

Add routes:

```rust
.route("/api/sessions", get(list_sessions).post(create_session))
.route("/api/sessions/{session_id}/events", get(session_events))
.route("/api/approvals/{approval_id}/approve", post(approve))
.route("/api/approvals/{approval_id}/deny", post(deny))
```

Add handlers:

```rust
async fn list_sessions(
    _auth: Authenticated,
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::models::Session>>, StatusCode> {
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
) -> Result<Json<crate::models::Session>, StatusCode> {
    state
        .sessions
        .start_session(request.workspace_id, request.title)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn session_events(
    _auth: Authenticated,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let history = state
        .sessions
        .events(&session_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let receiver = state.sessions.subscribe(&session_id).await;
    let historical = tokio_stream::iter(history.into_iter().map(|event| {
        Ok(Event::default().json_data(event).expect("event serializes"))
    }));
    let live = BroadcastStream::new(receiver).filter_map(|item| match item {
        Ok(event) => Some(Ok(Event::default().json_data(event).expect("event serializes"))),
        Err(_) => None,
    });
    Ok(Sse::new(historical.chain(live)))
}

async fn approve(
    _auth: Authenticated,
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    state
        .sessions
        .approve(&approval_id, true)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|_| StatusCode::NOT_FOUND)
}

async fn deny(
    _auth: Authenticated,
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    state
        .sessions
        .approve(&approval_id, false)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|_| StatusCode::NOT_FOUND)
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent sessions
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/remote-agent
git commit -m "Add remote session events and approvals"
```

## Task 7: Add Embedded Web UI

**Files:**
- Modify: `codex-rs/remote-agent/src/static_ui.rs`
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Create: `codex-rs/remote-agent/static/index.html`
- Create: `codex-rs/remote-agent/static/styles.css`
- Create: `codex-rs/remote-agent/static/app.js`
- Test: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Write static UI test**

Append to `codex-rs/remote-agent/tests/api.rs`:

```rust
#[tokio::test]
async fn serves_embedded_web_ui() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app.oneshot(
        Request::builder().uri("/").body(Body::empty()).unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
}
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent serves_embedded_web_ui
```

Expected: FAIL because `/` is not served.

- [ ] **Step 3: Implement static asset helpers**

Replace `codex-rs/remote-agent/src/static_ui.rs`:

```rust
use axum::http::StatusCode;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;

const INDEX_HTML: &str = include_str!("../static/index.html");
const STYLES_CSS: &str = include_str!("../static/styles.css");
const APP_JS: &str = include_str!("../static/app.js");

pub async fn index() -> Response {
    html(INDEX_HTML)
}

pub async fn asset(path: axum::extract::Path<String>) -> Result<Response, StatusCode> {
    match path.as_str() {
        "styles.css" => Ok(css(STYLES_CSS)),
        "app.js" => Ok(javascript(APP_JS)),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

fn html(body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn css(body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], body).into_response()
}

fn javascript(body: &'static str) -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        body,
    )
        .into_response()
}
```

- [ ] **Step 4: Create the HTML shell**

Create `codex-rs/remote-agent/static/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Remote</title>
    <link rel="stylesheet" href="/assets/styles.css" />
  </head>
  <body>
    <div id="app">
      <aside class="sidebar">
        <div class="brand">Codex Remote</div>
        <button id="refresh">Refresh</button>
        <section>
          <h2>Workspaces</h2>
          <div id="workspaces" class="list"></div>
        </section>
        <section>
          <h2>Sessions</h2>
          <div id="sessions" class="list"></div>
        </section>
      </aside>
      <main class="main">
        <section id="login" class="panel">
          <h1>Setup</h1>
          <input id="setup-token" placeholder="Setup token" />
          <button id="setup-submit">Connect</button>
          <p id="login-error" class="error"></p>
        </section>
        <section id="session" class="panel hidden">
          <div class="session-header">
            <input id="session-title" value="Remote Codex session" />
            <button id="start-session">Start Session</button>
          </div>
          <div id="events" class="events"></div>
          <div class="composer">
            <input id="message" placeholder="Message Codex Remote" />
            <button id="send-message">Send</button>
          </div>
        </section>
        <section id="diff" class="panel hidden">
          <h2>Diff</h2>
          <pre id="diff-output"></pre>
        </section>
      </main>
    </div>
    <script src="/assets/app.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Create restrained responsive styles**

Create `codex-rs/remote-agent/static/styles.css`:

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  background: #f7f7f4;
  color: #1f2328;
}

button,
input {
  font: inherit;
}

button {
  border: 1px solid #1f2328;
  border-radius: 6px;
  background: #1f2328;
  color: #fff;
  min-height: 36px;
  padding: 0 12px;
}

input {
  border: 1px solid #c9c9c3;
  border-radius: 6px;
  min-height: 36px;
  padding: 0 10px;
  width: 100%;
}

#app {
  display: grid;
  grid-template-columns: 320px 1fr;
  min-height: 100vh;
}

.sidebar {
  border-right: 1px solid #d7d7d0;
  padding: 16px;
  background: #ffffff;
}

.brand {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}

.sidebar h2,
.panel h2 {
  font-size: 13px;
  text-transform: uppercase;
  margin: 18px 0 8px;
}

.main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
  padding: 16px;
}

.panel {
  background: #ffffff;
  border: 1px solid #d7d7d0;
  border-radius: 8px;
  padding: 16px;
}

.hidden {
  display: none;
}

.list {
  display: grid;
  gap: 8px;
}

.item {
  border: 1px solid #d7d7d0;
  border-radius: 6px;
  padding: 10px;
  cursor: pointer;
}

.item.active {
  border-color: #1f6feb;
}

.session-header,
.composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
}

.events {
  border: 1px solid #d7d7d0;
  border-radius: 6px;
  margin: 16px 0;
  min-height: 360px;
  overflow: auto;
  padding: 12px;
}

.event {
  border-bottom: 1px solid #ededeb;
  padding: 8px 0;
}

.error {
  color: #b42318;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 820px) {
  #app,
  .main {
    display: block;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #d7d7d0;
  }

  .main {
    padding: 12px;
  }

  .panel {
    margin-bottom: 12px;
  }
}
```

- [ ] **Step 6: Create browser client logic**

Create `codex-rs/remote-agent/static/app.js`:

```javascript
const state = {
  token: localStorage.getItem("codexRemoteToken"),
  workspaceId: null,
  sessionId: null,
  events: null,
};

const $ = (id) => document.getElementById(id);

function authHeaders() {
  return state.token ? { authorization: `Bearer ${state.token}` } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function setup() {
  $("login-error").textContent = "";
  try {
    const result = await api("/api/setup", {
      method: "POST",
      body: JSON.stringify({ setupToken: $("setup-token").value }),
    });
    state.token = result.sessionToken;
    localStorage.setItem("codexRemoteToken", state.token);
    $("login").classList.add("hidden");
    $("session").classList.remove("hidden");
    await refresh();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
}

async function refresh() {
  const workspaces = await api("/api/workspaces");
  renderList("workspaces", workspaces, (workspace) => {
    state.workspaceId = workspace.id;
    refresh();
  });
  const sessions = await api("/api/sessions");
  renderList("sessions", sessions, (session) => {
    state.sessionId = session.id;
    connectEvents(session.id);
  });
}

function renderList(id, items, onClick) {
  const node = $(id);
  node.innerHTML = "";
  for (const item of items) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = item.displayName || item.title || item.id;
    div.onclick = () => onClick(item);
    node.appendChild(div);
  }
}

async function startSession() {
  if (!state.workspaceId) {
    const first = document.querySelector("#workspaces .item");
    if (!first) {
      return;
    }
  }
  const session = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: state.workspaceId || "workspace-1",
      title: $("session-title").value,
    }),
  });
  state.sessionId = session.id;
  connectEvents(session.id);
  await refresh();
}

function connectEvents(sessionId) {
  if (state.events) {
    state.events.close();
  }
  $("events").innerHTML = "";
  const source = new EventSource(`/api/sessions/${sessionId}/events?token=${encodeURIComponent(state.token)}`);
  state.events = source;
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    const div = document.createElement("div");
    div.className = "event";
    div.textContent = `${event.kind.type}: ${JSON.stringify(event.kind)}`;
    $("events").appendChild(div);
  };
}

function boot() {
  $("setup-submit").onclick = setup;
  $("refresh").onclick = refresh;
  $("start-session").onclick = startSession;
  if (state.token) {
    $("login").classList.add("hidden");
    $("session").classList.remove("hidden");
    refresh().catch(() => {
      localStorage.removeItem("codexRemoteToken");
      state.token = null;
      $("login").classList.remove("hidden");
    });
  }
}

boot();
```

- [ ] **Step 7: Wire static routes and support EventSource token query**

In `codex-rs/remote-agent/src/routes.rs`, add routes:

```rust
.route("/", get(crate::static_ui::index))
.route("/assets/{path}", get(crate::static_ui::asset))
```

For the SSE route only, browser `EventSource` cannot set Authorization headers. Add query auth support by replacing the `_auth: Authenticated` parameter in `session_events` with a token query:

```rust
#[derive(Deserialize)]
struct EventQuery {
    token: Option<String>,
}
```

Update the handler signature:

```rust
async fn session_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let Some(token) = query.token else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let setup = state
        .store
        .setup_state()
        .await
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let Some(hash) = setup.session_token_hash else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !crate::auth::verify_token(&token, &hash) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let history = state
        .sessions
        .events(&session_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let receiver = state.sessions.subscribe(&session_id).await;
    let historical = tokio_stream::iter(history.into_iter().map(|event| {
        Ok(Event::default().json_data(event).expect("event serializes"))
    }));
    let live = BroadcastStream::new(receiver).filter_map(|item| match item {
        Ok(event) => Some(Ok(Event::default().json_data(event).expect("event serializes"))),
        Err(_) => None,
    });
    Ok(Sse::new(historical.chain(live)))
}
```

- [ ] **Step 8: Account for Bazel compile-time assets**

Because this task adds `include_str!`, update `codex-rs/remote-agent/BUILD.bazel`:

```python
load("//:defs.bzl", "codex_rust_crate")

codex_rust_crate(
    name = "remote-agent",
    crate_name = "codex_remote_agent",
    compile_data = glob(["static/**"]),
)
```

- [ ] **Step 9: Run tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent serves_embedded_web_ui
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/remote-agent
git commit -m "Serve codex remote web UI"
```

## Task 8: Add Status, Logs, Docs, And Final Verification

**Files:**
- Modify: `codex-rs/remote-agent/src/routes.rs`
- Create: `codex-rs/remote-agent/README.md`
- Modify: `codex-rs/remote-agent/BUILD.bazel`
- Test: `codex-rs/remote-agent/tests/api.rs`

- [ ] **Step 1: Add status route test**

Append to `codex-rs/remote-agent/tests/api.rs`:

```rust
#[tokio::test]
async fn health_reports_ok_without_auth() {
    let temp_dir = TempDir::new().unwrap();
    let app = test_app(&temp_dir).await;
    let response = app.oneshot(
        Request::builder()
            .uri("/api/agent/status")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
}
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent health_reports_ok_without_auth
```

Expected: FAIL because `/api/agent/status` does not exist.

- [ ] **Step 3: Add status and logs endpoints**

In `codex-rs/remote-agent/src/routes.rs`, add route registrations:

```rust
.route("/api/agent/status", get(agent_status))
.route("/api/agent/logs", get(agent_logs))
```

Add response types and handlers:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatusResponse {
    status: &'static str,
    setup_complete: bool,
    workspace_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLogsResponse {
    entries: Vec<String>,
}

async fn agent_status(State(state): State<AppState>) -> Json<AgentStatusResponse> {
    let setup_complete = state
        .store
        .setup_state()
        .await
        .map(|setup| setup.setup_complete)
        .unwrap_or(false);
    Json(AgentStatusResponse {
        status: "ok",
        setup_complete,
        workspace_count: state.config.workspaces().len(),
    })
}

async fn agent_logs(
    _auth: Authenticated,
) -> Json<AgentLogsResponse> {
    Json(AgentLogsResponse {
        entries: vec!["codex-remote-agent is running".to_string()],
    })
}
```

- [ ] **Step 4: Add README**

Create `codex-rs/remote-agent/README.md`:

```markdown
# codex-remote-agent

`codex-remote-agent` is the personal self-hosted server for Codex Remote.

It serves a browser UI and local APIs for controlling Codex-style sessions on a server where the source code lives.

## Run Locally

```bash
cd codex-rs
cargo run -p codex-remote-agent -- \
  --bind 127.0.0.1:7680 \
  --state-dir /tmp/codex-remote-agent \
  --workspace /path/to/repo \
  --setup-token change-me
```

Open `http://127.0.0.1:7680` and enter the setup token.

## Tailscale

For personal remote access, bind to the server's Tailscale IP or to `0.0.0.0` only when protected by tailnet ACLs or a trusted reverse proxy:

```bash
cargo run -p codex-remote-agent -- \
  --bind 100.x.y.z:7680 \
  --state-dir /var/lib/codex-remote-agent \
  --workspace /srv/app \
  --setup-token "$(openssl rand -base64 32)"
```

The default bind is `127.0.0.1:7680` to avoid accidentally exposing command execution APIs.

## MVP Limits

The initial backend adapter is deterministic and exists to validate the agent and UI contract. Real Codex protocol integration should replace the adapter behind the session manager boundary.
```

- [ ] **Step 5: Run package tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent
```

Expected: PASS.

- [ ] **Step 6: Run formatter**

Run:

```bash
cd /root/codex/codex-rs
just fmt
```

Expected: PASS and files formatted.

- [ ] **Step 7: Run scoped fixer**

Run:

```bash
cd /root/codex/codex-rs
just fix -p codex-remote-agent
```

Expected: PASS. Do not re-run tests after this step unless the command reports that manual fixes are still required.

- [ ] **Step 8: Check Bazel target**

Run:

```bash
cd /root/codex
bazel test //codex-rs/remote-agent:remote-agent
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
cd /root/codex
git add codex-rs/remote-agent codex-rs/Cargo.toml docs/superpowers/specs/2026-05-25-codex-remote-personal-web-design.md
git commit -m "Document and verify codex remote agent"
```

## Task 9: Manual MVP Smoke Test

**Files:**
- No source changes expected.

- [ ] **Step 1: Start the agent on localhost**

Run:

```bash
cd /root/codex/codex-rs
cargo run -p codex-remote-agent -- \
  --bind 127.0.0.1:7680 \
  --state-dir /tmp/codex-remote-agent-smoke \
  --workspace /root/codex \
  --setup-token smoke-secret
```

Expected: server prints a listening address and stays running.

- [ ] **Step 2: Verify health**

In another terminal:

```bash
curl -s http://127.0.0.1:7680/api/agent/status
```

Expected JSON contains:

```json
{"status":"ok","setupComplete":false,"workspaceCount":1}
```

- [ ] **Step 3: Complete setup**

Run:

```bash
TOKEN=$(
  curl -s \
    -H 'content-type: application/json' \
    -d '{"setupToken":"smoke-secret"}' \
    http://127.0.0.1:7680/api/setup \
  | jq -r .sessionToken
)
echo "$TOKEN"
```

Expected: prints a non-empty token.

- [ ] **Step 4: Verify workspace API**

Run:

```bash
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7680/api/workspaces
```

Expected JSON contains one workspace with path `/root/codex`.

- [ ] **Step 5: Create a session**

Run:

```bash
SESSION_ID=$(
  curl -s \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d '{"workspaceId":"workspace-1","title":"Smoke test"}' \
    http://127.0.0.1:7680/api/sessions \
  | jq -r .id
)
echo "$SESSION_ID"
```

Expected: prints a session id.

- [ ] **Step 6: Verify event history**

Run:

```bash
curl -s "http://127.0.0.1:7680/api/sessions/$SESSION_ID/events?token=$TOKEN" | head
```

Expected: SSE output includes `sessionCreated`, `messageDelta`, and `approvalRequested` events.

- [ ] **Step 7: Verify browser UI**

Open:

```text
http://127.0.0.1:7680
```

Expected: UI loads, setup/login works, workspace list appears, and starting a session displays streamed events.

- [ ] **Step 8: Stop the agent**

Press `Ctrl-C` in the terminal running the agent.

Expected: process exits cleanly.

## Self-Review Notes

- Spec coverage: the plan covers the personal self-hosted agent, Web UI, setup token auth, workspace allowlist, session creation/resume metadata, structured events, approval flow, file browser, diff summary, status/logs, persistence, Tailscale documentation, and tests.
- Intentional MVP narrowing: the plan uses a deterministic session adapter instead of real Codex execution. This preserves the protocol-shaped UI/API boundary and avoids overfitting to terminal parsing before the product contract is validated.
- Remaining future work after this plan: replace the deterministic adapter with real Codex process/protocol integration, enrich audit logs, add stronger CSRF/cookie mode if cookie auth is chosen, and package as a systemd service.
