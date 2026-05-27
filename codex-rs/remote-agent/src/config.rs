use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;

use clap::Parser;
use clap::ValueEnum;

use crate::store::ensure_private_state_dir;

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

    #[arg(long, value_enum, default_value_t = BackendMode::AppServer)]
    pub backend: BackendMode,

    #[arg(long, default_value = "codex", env = "CODEX_REMOTE_CODEX_COMMAND")]
    pub codex_command: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum BackendMode {
    AppServer,
    Demo,
}

#[derive(Clone, Debug)]
pub struct Config {
    bind: SocketAddr,
    state_dir: PathBuf,
    workspaces: Vec<PathBuf>,
    setup_token: Option<String>,
    backend: BackendMode,
    codex_command: String,
}

impl Config {
    pub async fn from_cli(cli: Cli) -> anyhow::Result<Self> {
        let state_dir = match cli.state_dir {
            Some(path) => path,
            None => std::env::current_dir()?.join(".codex-remote-agent"),
        };
        ensure_private_state_dir(&state_dir)?;

        Ok(Self {
            bind: cli.bind,
            state_dir,
            workspaces: cli.workspaces,
            setup_token: cli.setup_token,
            backend: cli.backend,
            codex_command: cli.codex_command,
        })
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn workspaces(&self) -> &[PathBuf] {
        &self.workspaces
    }

    pub fn setup_token(&self) -> Option<&str> {
        self.setup_token.as_deref()
    }

    pub fn backend_mode(&self) -> BackendMode {
        self.backend
    }

    pub fn codex_command(&self) -> &str {
        &self.codex_command
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[tokio::test]
    async fn from_cli_sets_state_directory_permissions_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = TempDir::new().unwrap();
        let state_dir = temp_dir.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        Config::from_cli(Cli {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            state_dir: Some(state_dir.clone()),
            workspaces: Vec::new(),
            setup_token: Some("setup-secret".to_string()),
            backend: BackendMode::AppServer,
            codex_command: "codex".to_string(),
        })
        .await
        .unwrap();

        assert_eq!(
            std::fs::metadata(state_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[tokio::test]
    async fn from_cli_defaults_to_app_server_backend() {
        let temp_dir = TempDir::new().unwrap();
        let config = Config::from_cli(Cli {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            state_dir: Some(temp_dir.path().join("state")),
            workspaces: Vec::new(),
            setup_token: Some("setup-secret".to_string()),
            backend: BackendMode::AppServer,
            codex_command: "codex".to_string(),
        })
        .await
        .unwrap();

        assert_eq!(config.backend_mode(), BackendMode::AppServer);
        assert_eq!(config.codex_command(), "codex");
    }
}
