pub mod demo;
pub mod app_server;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::config::BackendMode;
use crate::config::Config;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendThread {
    pub(crate) thread_id: String,
    pub(crate) greeting: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendTurn {
    pub(crate) turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BackendEvent {
    AssistantDelta(String),
    Status(String),
    ToolStarted { command: String },
    ToolCompleted { exit_code: i32 },
    ApprovalRequested {
        request_id: u64,
        approval: BackendApprovalRequest,
    },
    DiffUpdated,
    Completed,
    Failed { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendApprovalRequest {
    pub(crate) action_type: String,
    pub(crate) command: String,
    pub(crate) risk_summary: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BackendApprovalDecision {
    Approve,
    Deny,
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

    fn respond_approval(
        &self,
        request_id: u64,
        decision: BackendApprovalDecision,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + '_>>;
}

pub(crate) fn from_config(config: &Config) -> Arc<dyn CodexBackend> {
    match config.backend_mode() {
        BackendMode::AppServer => Arc::new(app_server::AppServerBackend::new(
            config.codex_command().to_string(),
        )),
        BackendMode::Demo => Arc::new(demo::DemoBackend::new()),
    }
}
