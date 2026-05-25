use anyhow::Context;
use clap::Parser;
use codex_remote_agent::build_router;
use codex_remote_agent::config::Cli;
use codex_remote_agent::config::Config;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    let config = Config::from_cli(cli).await?;
    let listener = TcpListener::bind(config.bind_addr())
        .await
        .with_context(|| format!("failed to bind {}", config.bind_addr()))?;
    let addr = listener.local_addr()?;

    tracing::info!("codex-remote-agent listening on http://{addr}");
    axum::serve(listener, build_router(config)).await?;

    Ok(())
}
