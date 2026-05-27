use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

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
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<BackendThread>> + Send + '_>> {
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
        sink: Arc<dyn BackendEventSink>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<BackendTurn>> + Send + '_>> {
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
