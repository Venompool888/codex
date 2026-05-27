pub mod demo;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

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
