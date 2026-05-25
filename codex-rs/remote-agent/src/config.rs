use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;

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
}

#[derive(Clone, Debug)]
pub struct Config {
    bind: SocketAddr,
    state_dir: PathBuf,
    workspaces: Vec<PathBuf>,
    setup_token: Option<String>,
}

impl Config {
    pub async fn from_cli(cli: Cli) -> anyhow::Result<Self> {
        let state_dir = match cli.state_dir {
            Some(path) => path,
            None => std::env::current_dir()?.join(".codex-remote-agent"),
        };
        tokio::fs::create_dir_all(&state_dir)
            .await
            .with_context(|| format!("failed to create {}", state_dir.display()))?;

        Ok(Self {
            bind: cli.bind,
            state_dir,
            workspaces: cli.workspaces,
            setup_token: cli.setup_token,
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
}
