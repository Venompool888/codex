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
    stdin.write_all(serde_json::to_string(value)?.as_bytes())
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
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<BackendTurn>> + Send + '_>,
    > {
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
            sink.emit(
                session_id,
                BackendEvent::Status("Codex turn started.".to_string()),
            )
            .await?;
            Ok(BackendTurn { turn_id })
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
}
