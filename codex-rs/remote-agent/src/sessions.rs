use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::backend::BackendApprovalDecision;
use crate::backend::BackendEvent;
use crate::backend::BackendEventSink;
use crate::backend::CodexBackend;
use crate::Store;
use crate::models::ApprovalStatus;
use crate::models::Session;
use crate::models::SessionEvent;
use crate::models::SessionEventKind;
use crate::models::SessionMetadata;
use crate::models::SessionStatus;
use crate::store::TransitionApprovalError;

const DENIED_MESSAGE: &str = "Command denied by user.";
const COMPLETED_STATUS_TEXT: &str = "Session completed.";
const FAILED_STATUS_TEXT: &str = "Session failed.";
const EVENT_CHANNEL_CAPACITY: usize = 128;

#[derive(Clone)]
pub(crate) struct SessionManager {
    store: Store,
    backend: Arc<dyn CodexBackend>,
    senders: Arc<Mutex<HashMap<String, broadcast::Sender<SessionEvent>>>>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ApproveError {
    #[error("approval not found")]
    NotFound,
    #[error("approval session missing")]
    MissingSession,
    #[error("approval already completed")]
    AlreadyCompleted,
    #[error(transparent)]
    Store(#[from] anyhow::Error),
}

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalDecision {
    Approve,
    Deny,
}

impl ApprovalDecision {
    fn approval_status(self) -> ApprovalStatus {
        match self {
            ApprovalDecision::Approve => ApprovalStatus::Approved,
            ApprovalDecision::Deny => ApprovalStatus::Denied,
        }
    }

    fn session_status(self) -> SessionStatus {
        match self {
            ApprovalDecision::Approve => SessionStatus::Completed,
            ApprovalDecision::Deny => SessionStatus::Failed,
        }
    }

    fn status_text(self) -> &'static str {
        match self {
            ApprovalDecision::Approve => COMPLETED_STATUS_TEXT,
            ApprovalDecision::Deny => FAILED_STATUS_TEXT,
        }
    }

    fn approved(self) -> bool {
        match self {
            ApprovalDecision::Approve => true,
            ApprovalDecision::Deny => false,
        }
    }

    fn terminal_event(self) -> SessionEventKind {
        match self {
            ApprovalDecision::Approve => SessionEventKind::ToolCallCompleted { exit_code: 0 },
            ApprovalDecision::Deny => SessionEventKind::ErrorRaised {
                message: DENIED_MESSAGE.to_string(),
            },
        }
    }
}

impl SessionManager {
    pub(crate) fn new(store: Store, backend: Arc<dyn CodexBackend>) -> Self {
        Self {
            store,
            backend,
            senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn start_session(
        &self,
        workspace_id: String,
        title: String,
    ) -> anyhow::Result<Session> {
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
    }

    pub(crate) async fn list_sessions(&self) -> anyhow::Result<Vec<Session>> {
        self.store.sessions().await
    }

    pub(crate) async fn events(&self, session_id: &str) -> anyhow::Result<Vec<SessionEvent>> {
        self.store.events(session_id).await
    }

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

        let sink = Arc::new(StoreEventSink {
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
            && matches!(
                current.status,
                SessionStatus::Completed | SessionStatus::Failed
            )
        {
            self.store.clear_active_turn(session_id).await?;
        }
        Ok(())
    }

    pub(crate) async fn session_exists(&self, session_id: &str) -> anyhow::Result<bool> {
        Ok(self
            .store
            .sessions()
            .await?
            .iter()
            .any(|session| session.id == session_id))
    }

    pub(crate) fn subscribe(&self, session_id: &str) -> broadcast::Receiver<SessionEvent> {
        self.sender(session_id).subscribe()
    }

    pub(crate) async fn approve(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ApproveError> {
        let approval = self
            .store
            .approvals()
            .await?
            .into_iter()
            .find(|approval| approval.id == approval_id)
            .ok_or(ApproveError::NotFound)?;
        if let Some(request_id) = approval.backend_request_id {
            let backend_decision = match decision {
                ApprovalDecision::Approve => BackendApprovalDecision::Approve,
                ApprovalDecision::Deny => BackendApprovalDecision::Deny,
            };
            self.backend
                .respond_approval(request_id, backend_decision)
                .await
                .map_err(ApproveError::Store)?;
        }
        let event_created_at = unix_timestamp()?;
        let decision_event = SessionEvent {
            id: new_id(),
            session_id: String::new(),
            created_at: event_created_at,
            kind: SessionEventKind::ApprovalDecided {
                approval_id: approval_id.to_string(),
                approved: decision.approved(),
            },
        };
        let status_event = SessionEvent {
            id: new_id(),
            session_id: String::new(),
            created_at: event_created_at,
            kind: SessionEventKind::StatusText {
                status: decision.status_text().to_string(),
            },
        };
        let terminal_event = SessionEvent {
            id: new_id(),
            session_id: String::new(),
            created_at: event_created_at,
            kind: decision.terminal_event(),
        };
        let (_approval, events) = self
            .store
            .transition_approval(
                approval_id,
                decision.approval_status(),
                decision.session_status(),
                vec![decision_event, status_event, terminal_event],
            )
            .await
            .map_err(|error| match error {
                TransitionApprovalError::NotFound => ApproveError::NotFound,
                TransitionApprovalError::MissingSession => ApproveError::MissingSession,
                TransitionApprovalError::AlreadyCompleted => ApproveError::AlreadyCompleted,
                TransitionApprovalError::Store(error) => ApproveError::Store(error),
            })?;
        self.broadcast_events(events);
        Ok(())
    }

    fn broadcast_events(&self, events: Vec<SessionEvent>) {
        for event in events {
            let sender = self.sender(&event.session_id);
            let _ = sender.send(event);
        }
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
            BackendEvent::ApprovalRequested {
                request_id,
                approval,
            } => {
                let approval_id = new_id();
                self.store
                    .upsert_approval(crate::models::ApprovalRequest {
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

fn new_id() -> String {
    Uuid::now_v7().to_string()
}

fn unix_timestamp() -> anyhow::Result<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX epoch")?;
    i64::try_from(duration.as_secs()).context("UNIX timestamp does not fit in i64")
}

#[cfg(test)]
mod tests {
    use crate::Store;
    use crate::backend::demo::DemoBackend;
    use crate::models::ApprovalStatus;
    use crate::models::SessionEventKind;
    use crate::models::SessionStatus;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;

    fn test_manager(store: Store) -> SessionManager {
        SessionManager::new(store, Arc::new(DemoBackend::new()))
    }

    #[tokio::test]
    async fn start_session_records_backend_thread_metadata() -> anyhow::Result<()> {
        let temp_dir = TempDir::new()?;
        let store = Store::new(temp_dir.path().to_path_buf())?;
        let manager = test_manager(store.clone());

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
            }
            )
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

    #[tokio::test]
    async fn submit_message_records_user_message_and_backend_events() -> anyhow::Result<()> {
        let temp_dir = TempDir::new()?;
        let store = Store::new(temp_dir.path().to_path_buf())?;
        let manager = test_manager(store.clone());
        let session = manager
            .start_session("workspace-1".to_string(), "Build feature".to_string())
            .await?;

        manager
            .submit_message(&session.id, "Run tests".to_string())
            .await?;

        assert_eq!(
            store.session_metadata(&session.id).await?.unwrap().active_turn_id,
            None
        );
        assert_eq!(store.sessions().await?[0].status, SessionStatus::Completed);
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
        let manager = test_manager(store);

        let result = manager
            .submit_message("missing-session", "Run tests".to_string())
            .await;

        assert!(matches!(result, Err(SubmitMessageError::SessionNotFound)));
        Ok(())
    }

    #[tokio::test]
    async fn repeated_approval_returns_conflict_without_duplicate_event() -> anyhow::Result<()> {
        let temp_dir = TempDir::new()?;
        let store = Store::new(temp_dir.path().to_path_buf())?;
        let manager = test_manager(store.clone());
        let session = manager
            .start_session("workspace-1".to_string(), "Build feature".to_string())
            .await?;
        let approval_id = insert_pending_approval(&store, &session.id).await?;

        manager
            .approve(&approval_id, ApprovalDecision::Approve)
            .await?;
        let second_result = manager
            .approve(&approval_id, ApprovalDecision::Approve)
            .await;

        assert!(matches!(second_result, Err(ApproveError::AlreadyCompleted)));
        let terminal_events = terminal_events(store.events(&session.id).await?);
        assert_eq!(
            terminal_events,
            vec![
                SessionEventKind::ApprovalDecided {
                    approval_id: approval_id.clone(),
                    approved: true,
                },
                SessionEventKind::StatusText {
                    status: "Session completed.".to_string(),
                },
                SessionEventKind::ToolCallCompleted { exit_code: 0 },
            ]
        );
        assert_eq!(store.sessions().await?[0].status, SessionStatus::Completed);

        Ok(())
    }

    #[tokio::test]
    async fn concurrent_approval_allows_one_terminal_transition() -> anyhow::Result<()> {
        let temp_dir = TempDir::new()?;
        let store = Store::new(temp_dir.path().to_path_buf())?;
        let manager = test_manager(store.clone());
        let session = manager
            .start_session("workspace-1".to_string(), "Build feature".to_string())
            .await?;
        let approval_id = insert_pending_approval(&store, &session.id).await?;

        let (first, second) = tokio::join!(
            manager.approve(&approval_id, ApprovalDecision::Approve),
            manager.approve(&approval_id, ApprovalDecision::Deny)
        );
        let results = [first, second];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(ApproveError::AlreadyCompleted)))
                .count(),
            1
        );
        assert_ne!(store.approvals().await?[0].status, ApprovalStatus::Pending);
        let terminal_events = terminal_events(store.events(&session.id).await?);
        assert_eq!(
            terminal_events
                .iter()
                .filter(|event| matches!(event, SessionEventKind::ApprovalDecided { .. }))
                .count(),
            1
        );
        assert_eq!(
            terminal_events
                .iter()
                .filter(|event| matches!(
                    event,
                    SessionEventKind::StatusText { .. }
                        | SessionEventKind::ToolCallCompleted { .. }
                        | SessionEventKind::ErrorRaised { .. }
                ))
                .count(),
            2
        );

        Ok(())
    }

    fn terminal_events(events: Vec<crate::models::SessionEvent>) -> Vec<SessionEventKind> {
        events
            .into_iter()
            .filter_map(|event| match event.kind {
                SessionEventKind::ApprovalDecided { .. }
                | SessionEventKind::ToolCallCompleted { .. }
                | SessionEventKind::ErrorRaised { .. } => Some(event.kind),
                SessionEventKind::StatusText { status }
                    if status == "Session completed." || status == "Session failed." =>
                {
                    Some(SessionEventKind::StatusText { status })
                }
                _ => None,
            })
            .collect()
    }

    async fn insert_pending_approval(store: &Store, session_id: &str) -> anyhow::Result<String> {
        let approval_id = "approval-1".to_string();
        store
            .upsert_approval(crate::models::ApprovalRequest {
                id: approval_id.clone(),
                session_id: session_id.to_string(),
                action_type: "command".to_string(),
                command: "git status --short".to_string(),
                risk_summary: "Read-only repository status check.".to_string(),
                created_at: 1,
                status: ApprovalStatus::Pending,
                backend_request_id: None,
            })
            .await?;
        Ok(approval_id)
    }
}
