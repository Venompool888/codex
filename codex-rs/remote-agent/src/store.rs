use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use anyhow::Context;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::models::ApprovalRequest;
use crate::models::Session;
use crate::models::SessionEvent;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub setup_complete: bool,
    pub setup_token_hash: String,
    pub session_token_hash: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Store {
    state_dir: PathBuf,
    mutex: Arc<Mutex<()>>,
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
    pub fn new(state_dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("failed to create state directory {}", state_dir.display()))?;

        Ok(Self {
            state_dir,
            mutex: Arc::new(Mutex::new(())),
        })
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn setup_state(&self) -> anyhow::Result<SetupState> {
        let _guard = self.mutex.lock().await;
        read_json(self.setup_state_path()).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn save_setup_state(&self, state: &SetupState) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        write_json(self.setup_state_path(), state).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn sessions(&self) -> anyhow::Result<Vec<Session>> {
        let _guard = self.mutex.lock().await;
        let file: SessionsFile = read_json(self.sessions_path()).await?;
        Ok(file.sessions)
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn upsert_session(&self, session: Session) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        let mut file: SessionsFile = read_json(self.sessions_path()).await?;
        if let Some(existing) = file.sessions.iter_mut().find(|item| item.id == session.id) {
            *existing = session;
        } else {
            file.sessions.push(session);
        }
        write_json(self.sessions_path(), &file).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn events(&self, session_id: &str) -> anyhow::Result<Vec<SessionEvent>> {
        let _guard = self.mutex.lock().await;
        let file: EventsFile = read_json(self.events_path()).await?;
        Ok(file
            .events
            .into_iter()
            .filter(|event| event.session_id == session_id)
            .collect())
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn append_event(&self, event: SessionEvent) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        let mut file: EventsFile = read_json(self.events_path()).await?;
        file.events.push(event);
        write_json(self.events_path(), &file).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn approvals(&self) -> anyhow::Result<Vec<ApprovalRequest>> {
        let _guard = self.mutex.lock().await;
        let file: ApprovalsFile = read_json(self.approvals_path()).await?;
        Ok(file.approvals)
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn upsert_approval(&self, approval: ApprovalRequest) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        let mut file: ApprovalsFile = read_json(self.approvals_path()).await?;
        if let Some(existing) = file
            .approvals
            .iter_mut()
            .find(|item| item.session_id == approval.session_id && item.id == approval.id)
        {
            *existing = approval;
        } else {
            file.approvals.push(approval);
        }
        write_json(self.approvals_path(), &file).await
    }

    fn setup_state_path(&self) -> PathBuf {
        self.state_dir.join("setup_state.json")
    }

    fn sessions_path(&self) -> PathBuf {
        self.state_dir.join("sessions.json")
    }

    fn events_path(&self) -> PathBuf {
        self.state_dir.join("events.json")
    }

    fn approvals_path(&self) -> PathBuf {
        self.state_dir.join("approvals.json")
    }
}

async fn read_json<T>(path: PathBuf) -> anyhow::Result<T>
where
    T: Default + DeserializeOwned,
{
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read JSON file {}", path.display()));
        }
    };

    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse JSON file {}", path.display()))
}

async fn write_json<T>(path: PathBuf, value: &T) -> anyhow::Result<()>
where
    T: Serialize,
{
    let bytes = serde_json::to_vec_pretty(value)
        .with_context(|| format!("failed to serialize JSON file {}", path.display()))?;
    let parent = path
        .parent()
        .with_context(|| format!("JSON file path has no parent {}", path.display()))?;
    let file_name = path
        .file_name()
        .with_context(|| format!("JSON file path has no file name {}", path.display()))?
        .to_string_lossy();
    let (temp_path, mut file) = create_unique_temp_file(parent, &file_name).await?;

    if let Err(error) = file.write_all(&bytes).await {
        drop(file);
        cleanup_temp_file(&temp_path).await;
        return Err(error).with_context(|| {
            format!(
                "failed to write temporary JSON file {}",
                temp_path.display()
            )
        });
    }

    if let Err(error) = file.sync_all().await {
        drop(file);
        cleanup_temp_file(&temp_path).await;
        return Err(error).with_context(|| {
            format!("failed to sync temporary JSON file {}", temp_path.display())
        });
    }
    drop(file);

    if let Err(error) = tokio::fs::rename(&temp_path, &path).await.with_context(|| {
        format!(
            "failed to replace JSON file {} with {}",
            path.display(),
            temp_path.display()
        )
    }) {
        cleanup_temp_file(&temp_path).await;
        return Err(error);
    }

    sync_parent_dir(parent).await
}

async fn create_unique_temp_file(
    parent: &Path,
    file_name: &str,
) -> anyhow::Result<(PathBuf, tokio::fs::File)> {
    let pid = std::process::id();
    loop {
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".{file_name}.{pid}.{counter}.tmp"));
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to create temporary JSON file {}",
                        temp_path.display()
                    )
                });
            }
        }
    }
}

async fn cleanup_temp_file(temp_path: &Path) {
    let _ = tokio::fs::remove_file(temp_path).await;
}

async fn sync_parent_dir(parent: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let dir = std::fs::File::open(parent)
            .with_context(|| format!("failed to open JSON directory {}", parent.display()))?;
        dir.sync_all()
            .with_context(|| format!("failed to sync JSON directory {}", parent.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ApprovalRequest;
    use crate::models::ApprovalStatus;
    use crate::models::Session;
    use crate::models::SessionEvent;
    use crate::models::SessionEventKind;
    use crate::models::SessionStatus;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

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

    #[tokio::test]
    async fn missing_files_return_defaults() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();

        assert_eq!(store.setup_state().await.unwrap(), SetupState::default());
        assert_eq!(store.sessions().await.unwrap(), Vec::<Session>::new());
        assert_eq!(
            store.events("missing").await.unwrap(),
            Vec::<SessionEvent>::new()
        );
        assert_eq!(
            store.approvals().await.unwrap(),
            Vec::<ApprovalRequest>::new()
        );
    }

    #[tokio::test]
    async fn approval_upsert_keys_by_session_and_id() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let approval = ApprovalRequest {
            id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            action_type: "exec".to_string(),
            command: "cargo test".to_string(),
            risk_summary: "Runs tests".to_string(),
            created_at: 1,
            status: ApprovalStatus::Pending,
        };
        let other_session_approval = ApprovalRequest {
            session_id: "session-2".to_string(),
            status: ApprovalStatus::Approved,
            ..approval.clone()
        };

        store.upsert_approval(approval.clone()).await.unwrap();
        store
            .upsert_approval(other_session_approval.clone())
            .await
            .unwrap();

        assert_eq!(
            store.approvals().await.unwrap(),
            vec![approval.clone(), other_session_approval]
        );

        let replacement = ApprovalRequest {
            command: "replacement".to_string(),
            ..approval
        };
        store.upsert_approval(replacement.clone()).await.unwrap();
        let approvals = store.approvals().await.unwrap();

        assert_eq!(approvals.len(), 2);
        assert!(approvals.iter().any(|approval| approval == &replacement));
    }

    #[tokio::test]
    async fn session_upsert_replaces_existing_session_with_same_id() {
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
        let replacement = Session {
            title: "Replacement".to_string(),
            status: SessionStatus::Completed,
            updated_at: 3,
            ..session.clone()
        };

        store.upsert_session(session.clone()).await.unwrap();
        store.upsert_session(replacement.clone()).await.unwrap();

        assert_eq!(store.sessions().await.unwrap(), vec![replacement]);
    }

    #[tokio::test]
    async fn concurrent_cloned_stores_append_events_without_dropping_updates() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let events = (0..20)
            .map(|index| SessionEvent {
                id: format!("event-{index}"),
                session_id: "session-1".to_string(),
                created_at: index,
                kind: SessionEventKind::SessionCreated,
            })
            .collect::<Vec<_>>();

        let mut tasks = Vec::new();
        for event in events.clone() {
            let store = store.clone();
            tasks.push(tokio::spawn(async move {
                store.append_event(event).await.unwrap()
            }));
        }

        for task in tasks {
            task.await.unwrap();
        }

        let mut expected = events;
        expected.sort_by_key(|event| event.created_at);
        let mut loaded = store.events("session-1").await.unwrap();
        loaded.sort_by_key(|event| event.created_at);

        assert_eq!(loaded, expected);
    }
}
