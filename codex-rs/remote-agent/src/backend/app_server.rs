use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use anyhow::Context;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::ChildStdin;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::sync::oneshot;

use crate::backend::BackendApprovalDecision;
use crate::backend::BackendApprovalRequest;
use crate::backend::BackendEvent;
use crate::backend::BackendEventSink;
use crate::backend::BackendThread;
use crate::backend::BackendTurn;
use crate::backend::CodexBackend;

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MappedNotification {
    pub(crate) thread_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) event: BackendEvent,
}

pub(crate) fn map_notification(value: &Value) -> Option<MappedNotification> {
    let method = value.get("method")?.as_str()?;
    let params = value.get("params")?;
    match method {
        "item/started"
            if params.pointer("/item/type").and_then(Value::as_str) == Some("commandExecution") =>
        {
            Some(MappedNotification {
                thread_id: params.get("threadId")?.as_str()?.to_string(),
                turn_id: params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                event: BackendEvent::ToolStarted {
                    command: params.pointer("/item/command")?.as_str()?.to_string(),
                },
            })
        }
        "item/completed"
            if params.pointer("/item/type").and_then(Value::as_str) == Some("commandExecution") =>
        {
            Some(MappedNotification {
                thread_id: params.get("threadId")?.as_str()?.to_string(),
                turn_id: params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                event: BackendEvent::ToolCompleted {
                    exit_code: params
                        .pointer("/item/exitCode")
                        .and_then(Value::as_i64)
                        .and_then(|value| i32::try_from(value).ok())
                        .unwrap_or(-1),
                },
            })
        }
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MappedServerRequest {
    pub(crate) request_id: u64,
    pub(crate) thread_id: String,
    pub(crate) approval: BackendApprovalRequest,
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

#[derive(Clone)]
pub(crate) struct ThreadBinding {
    pub(crate) session_id: String,
    pub(crate) sink: Arc<dyn BackendEventSink>,
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

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "connection startup is serialized so app-server is initialized once"
    )]
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
        spawn_reader(
            stdout,
            stdin.clone(),
            pending.clone(),
            thread_sessions.clone(),
        );
        let connection = AppServerConnection {
            stdin,
            pending,
            thread_sessions,
        };

        request_on_connection(
            &self.inner.next_id,
            &connection,
            "initialize",
            initialize_params(),
        )
        .await?;
        notify_on_connection(&connection, "initialized", json!({})).await?;

        *guard = Some(connection.clone());
        Ok(connection)
    }

    async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let connection = self.ensure_connection().await?;
        request_on_connection(&self.inner.next_id, &connection, method, params).await
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

fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<anyhow::Result<Value>>>>>,
    thread_sessions: Arc<Mutex<HashMap<String, ThreadBinding>>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("method").is_some() && value.get("id").is_some() {
                handle_server_request(&stdin, &thread_sessions, &value).await;
                continue;
            }
            let Some(id) = value.get("id").and_then(Value::as_u64) else {
                if let Some(mapped) = map_notification(&value) {
                    let binding = thread_sessions.lock().await.get(&mapped.thread_id).cloned();
                    if let Some(binding) = binding {
                        let _ = binding.sink.emit(binding.session_id, mapped.event).await;
                    }
                }
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

async fn handle_server_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    thread_sessions: &Arc<Mutex<HashMap<String, ThreadBinding>>>,
    value: &Value,
) {
    if let Some(mapped) = map_server_request(value) {
        let binding = thread_sessions.lock().await.get(&mapped.thread_id).cloned();
        if let Some(binding) = binding {
            let _ = binding
                .sink
                .emit(
                    binding.session_id,
                    BackendEvent::ApprovalRequested {
                        request_id: mapped.request_id,
                        approval: mapped.approval,
                    },
                )
                .await;
        }
        return;
    }

    let Some(request_id) = value.get("id").and_then(Value::as_u64) else {
        return;
    };
    let _ = write_json_line(
        stdin,
        &json!({
            "id": request_id,
            "result": {
                "decision": "decline",
            },
        }),
    )
    .await;

    let Some(thread_id) = value.pointer("/params/threadId").and_then(Value::as_str) else {
        return;
    };
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let binding = thread_sessions.lock().await.get(thread_id).cloned();
    if let Some(binding) = binding {
        let _ = binding
            .sink
            .emit(
                binding.session_id,
                BackendEvent::Failed {
                    message: format!("Unsupported approval request: {method}"),
                },
            )
            .await;
    }
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

#[expect(
    clippy::await_holding_invalid_type,
    reason = "writes to app-server stdin must be serialized"
)]
async fn write_json_line(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> anyhow::Result<()> {
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(serde_json::to_string(value)?.as_bytes())
        .await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

impl CodexBackend for AppServerBackend {
    fn start_thread(
        &self,
        workspace_path: String,
        _title: String,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<BackendThread>> + Send + '_>,
    > {
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
        sink: Arc<dyn BackendEventSink>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<BackendTurn>> + Send + '_>>
    {
        Box::pin(async move {
            let connection = self.ensure_connection().await?;
            connection.thread_sessions.lock().await.insert(
                thread_id.clone(),
                ThreadBinding {
                    session_id: session_id.clone(),
                    sink: sink.clone(),
                },
            );
            let result = self
                .request(
                    "turn/start",
                    turn_start_params(&thread_id, &workspace_path, &message),
                )
                .await;
            if result.is_err() {
                connection.thread_sessions.lock().await.remove(&thread_id);
            }
            let result = result?;
            let turn_id = result
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .context("turn/start response missing turn.id")?
                .to_string();
            sink.emit(
                session_id,
                BackendEvent::Status("Codex turn started.".to_string()),
            )
            .await?;
            Ok(BackendTurn { turn_id })
        })
    }

    fn respond_approval(
        &self,
        request_id: u64,
        decision: BackendApprovalDecision,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + '_>> {
        Box::pin(async move {
            let payload = match decision {
                BackendApprovalDecision::Approve => json!({
                    "id": request_id,
                    "result": {
                        "decision": "accept",
                    },
                }),
                BackendApprovalDecision::Deny => json!({
                    "id": request_id,
                    "result": {
                        "decision": "decline",
                    },
                }),
            };
            let connection = self.ensure_connection().await?;
            write_json_line(&connection.stdin, &payload).await
        })
    }
}

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
            jsonrpc_request(
                3,
                "turn/start",
                turn_start_params("thr_123", "/srv/app", "Run tests"),
            ),
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
}
