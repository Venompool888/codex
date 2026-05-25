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
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum SessionEventKind {
    SessionCreated,
    StatusText { status: String },
    MessageDelta { role: String, content: String },
    ToolCallStarted { command: String },
    ToolCallCompleted { exit_code: i32 },
    ApprovalRequested { approval_id: String },
    ApprovalDecided { approval_id: String, approved: bool },
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
    use super::*;
    use pretty_assertions::assert_eq;

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
