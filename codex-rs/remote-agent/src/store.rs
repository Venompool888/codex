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
use tokio::sync::Mutex;

use crate::models::ApprovalRequest;
use crate::models::ApprovalStatus;
use crate::models::Session;
use crate::models::SessionEvent;
use crate::models::SessionMetadata;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
const LOCK_RETRY_COUNT: usize = 100;
const LOCK_RETRY_SLEEP: std::time::Duration = std::time::Duration::from_millis(5);

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

#[derive(Debug, thiserror::Error)]
pub enum CompleteSetupError {
    #[error("setup is already complete")]
    AlreadyComplete,
    #[error(transparent)]
    Store(#[from] anyhow::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum TransitionApprovalError {
    #[error("approval not found")]
    NotFound,
    #[error("approval session is missing")]
    MissingSession,
    #[error("approval is already completed")]
    AlreadyCompleted,
    #[error(transparent)]
    Store(#[from] anyhow::Error),
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

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStateFile {
    sessions: Vec<Session>,
    events: Vec<SessionEvent>,
    approvals: Vec<ApprovalRequest>,
    #[serde(default)]
    session_metadata: Vec<SessionMetadata>,
}

impl Store {
    pub fn new(state_dir: PathBuf) -> anyhow::Result<Self> {
        ensure_private_state_dir(&state_dir)?;

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
    pub async fn complete_setup_once(&self, state: SetupState) -> Result<(), CompleteSetupError> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_setup_state().await?;
        let existing: SetupState = read_json(self.setup_state_path()).await?;
        if existing.setup_complete {
            return Err(CompleteSetupError::AlreadyComplete);
        }
        write_json(self.setup_state_path(), &state).await?;
        Ok(())
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn sessions(&self) -> anyhow::Result<Vec<Session>> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;
        Ok(self.load_agent_state_locked().await?.sessions)
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn upsert_session(&self, session: Session) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;
        let mut state = self.load_agent_state_locked().await?;
        if let Some(existing) = state.sessions.iter_mut().find(|item| item.id == session.id) {
            *existing = session;
        } else {
            state.sessions.push(session);
        }
        self.save_agent_state_locked(&state).await
    }

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

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn events(&self, session_id: &str) -> anyhow::Result<Vec<SessionEvent>> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;
        let state = self.load_agent_state_locked().await?;
        Ok(state
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
        let _file_guard = self.lock_agent_state().await?;
        let mut state = self.load_agent_state_locked().await?;
        state.events.push(event);
        self.save_agent_state_locked(&state).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn approvals(&self) -> anyhow::Result<Vec<ApprovalRequest>> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;
        Ok(self.load_agent_state_locked().await?.approvals)
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn upsert_approval(&self, approval: ApprovalRequest) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;
        let mut state = self.load_agent_state_locked().await?;
        if let Some(existing) = state
            .approvals
            .iter_mut()
            .find(|item| item.id == approval.id)
        {
            *existing = approval;
        } else {
            state.approvals.push(approval);
        }
        self.save_agent_state_locked(&state).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn create_session(
        &self,
        session: Session,
        events: Vec<SessionEvent>,
        approval: ApprovalRequest,
    ) -> anyhow::Result<()> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;

        let mut state = self.load_agent_state_locked().await?;
        if let Some(existing) = state.sessions.iter_mut().find(|item| item.id == session.id) {
            *existing = session;
        } else {
            state.sessions.push(session);
        }

        state.events.extend(events);

        if let Some(existing) = state
            .approvals
            .iter_mut()
            .find(|item| item.id == approval.id)
        {
            *existing = approval;
        } else {
            state.approvals.push(approval);
        }

        self.save_agent_state_locked(&state).await
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "store operations intentionally serialize async file access"
    )]
    pub async fn transition_approval(
        &self,
        approval_id: &str,
        status: ApprovalStatus,
        session_status: crate::models::SessionStatus,
        mut events: Vec<SessionEvent>,
    ) -> Result<(ApprovalRequest, Vec<SessionEvent>), TransitionApprovalError> {
        let _guard = self.mutex.lock().await;
        let _file_guard = self.lock_agent_state().await?;
        let mut state = self.load_agent_state_locked().await?;
        let approval_index = state
            .approvals
            .iter()
            .position(|item| item.id == approval_id)
            .ok_or(TransitionApprovalError::NotFound)?;
        let approval = &state.approvals[approval_index];
        if approval.status != ApprovalStatus::Pending {
            return Err(TransitionApprovalError::AlreadyCompleted);
        }
        if !state
            .sessions
            .iter()
            .any(|session| session.id == approval.session_id)
        {
            return Err(TransitionApprovalError::MissingSession);
        }

        let approval = &mut state.approvals[approval_index];
        approval.status = status;
        let approval = approval.clone();
        for event in &mut events {
            event.session_id.clone_from(&approval.session_id);
        }

        if let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == approval.session_id)
        {
            session.status = session_status;
            if let Some(last_event) = events.last() {
                session.updated_at = last_event.created_at;
            }
        }

        state.events.extend(events.clone());

        self.save_agent_state_locked(&state).await?;
        Ok((approval, events))
    }

    async fn load_agent_state_locked(&self) -> anyhow::Result<AgentStateFile> {
        match read_json_if_exists(self.agent_state_path()).await? {
            Some(state) => Ok(state),
            None => {
                let state = self.load_legacy_agent_state_locked().await?;
                self.save_agent_state_locked(&state).await?;
                Ok(state)
            }
        }
    }

    async fn load_legacy_agent_state_locked(&self) -> anyhow::Result<AgentStateFile> {
        let sessions_file: SessionsFile = read_json(self.sessions_path()).await?;
        let events_file: EventsFile = read_json(self.events_path()).await?;
        let approvals_file: ApprovalsFile = read_json(self.approvals_path()).await?;
        Ok(AgentStateFile {
            sessions: sessions_file.sessions,
            events: events_file.events,
            approvals: approvals_file.approvals,
            session_metadata: Vec::new(),
        })
    }

    async fn save_agent_state_locked(&self, state: &AgentStateFile) -> anyhow::Result<()> {
        write_json(self.agent_state_path(), state).await
    }

    async fn lock_agent_state(&self) -> anyhow::Result<FileLockGuard> {
        FileLockGuard::lock(self.state_dir.join(".state.lock")).await
    }

    async fn lock_setup_state(&self) -> anyhow::Result<FileLockGuard> {
        FileLockGuard::lock(self.state_dir.join(".setup.lock")).await
    }

    fn setup_state_path(&self) -> PathBuf {
        self.state_dir.join("setup_state.json")
    }

    fn agent_state_path(&self) -> PathBuf {
        self.state_dir.join("state.json")
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

struct FileLockGuard {
    file: std::fs::File,
}

impl FileLockGuard {
    async fn lock(path: PathBuf) -> anyhow::Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .with_context(|| format!("failed to open lock file {}", path.display()))?;
        set_private_file_permissions(&path)?;
        for _ in 0..LOCK_RETRY_COUNT {
            match file.try_lock() {
                Ok(()) => return Ok(Self { file }),
                Err(std::fs::TryLockError::WouldBlock) => {
                    tokio::time::sleep(LOCK_RETRY_SLEEP).await;
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to lock file {}", path.display()));
                }
            }
        }

        Err(std::io::Error::new(
            ErrorKind::WouldBlock,
            "could not acquire state lock after multiple attempts",
        ))
        .with_context(|| format!("failed to lock file {}", path.display()))
    }
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub(crate) fn ensure_private_state_dir(state_dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(state_dir)
        .with_context(|| format!("failed to create state directory {}", state_dir.display()))?;
    set_private_dir_permissions(state_dir)
}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(path)
        .with_context(|| format!("failed to inspect state directory {}", path.display()))?;
    if !metadata.is_dir() {
        anyhow::bail!("state path is not a directory {}", path.display());
    }
    let permissions = metadata.permissions();
    if permissions.mode() & 0o777 == 0o700 {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).with_context(|| {
        format!(
            "failed to set state directory permissions {}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(path)
        .with_context(|| format!("failed to inspect state file {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("state path is not a file {}", path.display());
    }
    let permissions = metadata.permissions();
    if permissions.mode() & 0o777 == 0o600 {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to set state file permissions {}", path.display()))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
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

async fn read_json_if_exists<T>(path: PathBuf) -> anyhow::Result<Option<T>>
where
    T: DeserializeOwned,
{
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read JSON file {}", path.display()));
        }
    };

    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse JSON file {}", path.display()))
        .map(Some)
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
    let (temp_path, mut file) = create_unique_temp_file(parent, &file_name)?;

    if let Err(error) = std::io::Write::write_all(&mut file, &bytes) {
        drop(file);
        cleanup_temp_file(&temp_path).await;
        return Err(error).with_context(|| {
            format!(
                "failed to write temporary JSON file {}",
                temp_path.display()
            )
        });
    }

    if let Err(error) = file.sync_all() {
        drop(file);
        cleanup_temp_file(&temp_path).await;
        return Err(error).with_context(|| {
            format!("failed to sync temporary JSON file {}", temp_path.display())
        });
    }
    drop(file);

    if let Err(error) = replace_json_file(&temp_path, &path).await {
        cleanup_temp_file(&temp_path).await;
        return Err(error);
    }

    sync_parent_dir(parent).await
}

fn create_unique_temp_file(
    parent: &Path,
    file_name: &str,
) -> anyhow::Result<(PathBuf, std::fs::File)> {
    let pid = std::process::id();
    loop {
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".{file_name}.{pid}.{counter}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.mode(0o600);
        }
        match options.open(&temp_path) {
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

#[cfg(not(windows))]
async fn replace_json_file(temp_path: &Path, path: &Path) -> anyhow::Result<()> {
    tokio::fs::rename(temp_path, path).await.with_context(|| {
        format!(
            "failed to replace JSON file {} with {}",
            path.display(),
            temp_path.display()
        )
    })
}

#[cfg(windows)]
async fn replace_json_file(temp_path: &Path, path: &Path) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let temp_path_wide = wide_path(temp_path);
    let path_wide = wide_path(path);
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;

    let replaced = unsafe { MoveFileExW(temp_path_wide.as_ptr(), path_wide.as_ptr(), flags) };
    if replaced == 0 {
        return Err(std::io::Error::last_os_error()).with_context(|| {
            format!(
                "failed to replace JSON file {} with {}",
                path.display(),
                temp_path.display()
            )
        });
    }
    Ok(())
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
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
    async fn concurrent_independent_stores_allow_one_setup_completion() {
        let temp_dir = TempDir::new().unwrap();
        let first_store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let second_store = Store::new(temp_dir.path().to_path_buf()).unwrap();

        let (first, second) = tokio::join!(
            first_store.complete_setup_once(SetupState {
                setup_complete: true,
                setup_token_hash: "setup-hash".to_string(),
                session_token_hash: Some("first-session-hash".to_string()),
            }),
            second_store.complete_setup_once(SetupState {
                setup_complete: true,
                setup_token_hash: "setup-hash".to_string(),
                session_token_hash: Some("second-session-hash".to_string()),
            })
        );
        let results = [first, second];

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(CompleteSetupError::AlreadyComplete)))
                .count(),
            1
        );
        assert!(
            Store::new(temp_dir.path().to_path_buf())
                .unwrap()
                .setup_state()
                .await
                .unwrap()
                .setup_complete
        );
    }

    #[cfg(unix)]
    #[test]
    fn new_sets_state_directory_permissions_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = TempDir::new().unwrap();
        let state_dir = temp_dir.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        Store::new(state_dir.clone()).unwrap();

        assert_eq!(
            std::fs::metadata(state_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn state_files_and_locks_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();

        store
            .complete_setup_once(SetupState {
                setup_complete: true,
                setup_token_hash: "setup-hash".to_string(),
                session_token_hash: Some("session-hash".to_string()),
            })
            .await
            .unwrap();
        store.upsert_session(test_session()).await.unwrap();

        for path in [
            store.setup_state_path(),
            store.agent_state_path(),
            store.state_dir.join(".setup.lock"),
            store.state_dir.join(".state.lock"),
        ] {
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "{}",
                path.display()
            );
        }
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
    async fn combined_state_file_overrides_legacy_files() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let legacy_session = Session {
            id: "legacy-session".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Legacy".to_string(),
            status: SessionStatus::Running,
            created_at: 1,
            updated_at: 1,
        };
        let state_session = Session {
            id: "state-session".to_string(),
            title: "State".to_string(),
            ..legacy_session.clone()
        };

        write_json(
            store.sessions_path(),
            &SessionsFile {
                sessions: vec![legacy_session],
            },
        )
        .await
        .unwrap();
        write_json(
            store.agent_state_path(),
            &AgentStateFile {
                sessions: vec![state_session.clone()],
                events: Vec::new(),
                approvals: Vec::new(),
                session_metadata: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert_eq!(store.sessions().await.unwrap(), vec![state_session]);
    }

    #[tokio::test]
    async fn legacy_read_materializes_combined_state_file() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let session = test_session();
        write_json(
            store.sessions_path(),
            &SessionsFile {
                sessions: vec![session.clone()],
            },
        )
        .await
        .unwrap();

        assert_eq!(store.sessions().await.unwrap(), vec![session]);
        assert!(store.agent_state_path().exists());
    }

    #[tokio::test]
    async fn transition_approval_errors_when_session_is_missing_without_writing() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let approval = test_approval();
        store.upsert_approval(approval.clone()).await.unwrap();

        let result = store
            .transition_approval(
                &approval.id,
                ApprovalStatus::Approved,
                SessionStatus::Completed,
                vec![test_event("terminal")],
            )
            .await;

        assert!(matches!(
            result,
            Err(TransitionApprovalError::MissingSession)
        ));
        assert_eq!(store.approvals().await.unwrap(), vec![approval]);
        assert_eq!(
            store.events("session-1").await.unwrap(),
            Vec::<SessionEvent>::new()
        );
    }

    #[tokio::test]
    async fn agent_state_save_replaces_existing_state_file() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let session = test_session();
        let approval = test_approval();

        store
            .create_session(
                session.clone(),
                vec![test_event("created")],
                approval.clone(),
            )
            .await
            .unwrap();
        store
            .transition_approval(
                &approval.id,
                ApprovalStatus::Approved,
                SessionStatus::Completed,
                vec![test_event("completed")],
            )
            .await
            .unwrap();

        let sessions = store.sessions().await.unwrap();
        let approvals = store.approvals().await.unwrap();
        let events = store.events(&session.id).await.unwrap();

        assert_eq!(
            sessions,
            vec![Session {
                status: SessionStatus::Completed,
                updated_at: 2,
                ..session
            }]
        );
        assert_eq!(
            approvals,
            vec![ApprovalRequest {
                status: ApprovalStatus::Approved,
                ..approval
            }]
        );
        assert_eq!(events, vec![test_event("created"), test_event("completed")]);
    }

    #[tokio::test]
    async fn state_lock_returns_error_after_bounded_retries() {
        let temp_dir = TempDir::new().unwrap();
        let store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let lock_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(store.state_dir.join(".state.lock"))
            .unwrap();
        lock_file.try_lock().unwrap();

        let result = store.sessions().await;

        assert!(result.is_err());
        lock_file.unlock().unwrap();
    }

    #[tokio::test]
    async fn concurrent_independent_stores_allow_one_approval_transition() {
        let temp_dir = TempDir::new().unwrap();
        let first_store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let second_store = Store::new(temp_dir.path().to_path_buf()).unwrap();
        let session = test_session();
        let approval = test_approval();
        first_store
            .create_session(session.clone(), Vec::new(), approval.clone())
            .await
            .unwrap();

        let (first, second) = tokio::join!(
            first_store.transition_approval(
                &approval.id,
                ApprovalStatus::Approved,
                SessionStatus::Completed,
                vec![test_event("first")],
            ),
            second_store.transition_approval(
                &approval.id,
                ApprovalStatus::Denied,
                SessionStatus::Failed,
                vec![test_event("second")],
            )
        );
        let results = [first, second];

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(TransitionApprovalError::AlreadyCompleted)))
                .count(),
            1
        );
        assert_ne!(
            first_store.approvals().await.unwrap()[0].status,
            ApprovalStatus::Pending
        );
        assert_eq!(first_store.events(&session.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn approval_upsert_keys_by_id() {
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
            backend_request_id: None,
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
            vec![other_session_approval]
        );

        let replacement = ApprovalRequest {
            command: "replacement".to_string(),
            ..approval
        };
        store.upsert_approval(replacement.clone()).await.unwrap();
        let approvals = store.approvals().await.unwrap();

        assert_eq!(approvals, vec![replacement]);
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

    fn test_session() -> Session {
        Session {
            id: "session-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Build feature".to_string(),
            status: SessionStatus::WaitingForApproval,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn test_approval() -> ApprovalRequest {
        ApprovalRequest {
            id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            action_type: "command".to_string(),
            command: "git status --short".to_string(),
            risk_summary: "Read-only repository status check.".to_string(),
            created_at: 1,
            status: ApprovalStatus::Pending,
            backend_request_id: None,
        }
    }

    fn test_event(id: &str) -> SessionEvent {
        SessionEvent {
            id: id.to_string(),
            session_id: "session-1".to_string(),
            created_at: 2,
            kind: SessionEventKind::StatusText {
                status: "done".to_string(),
            },
        }
    }
}
