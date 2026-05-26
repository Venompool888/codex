# codex-remote-agent

`codex-remote-agent` is the personal self-hosted server for Codex Remote.

It serves a browser UI and local APIs for controlling Codex-style sessions on a server where the source code lives.

## Run Locally

```bash
cd codex-rs
cargo run -p codex-remote-agent -- \
  --bind 127.0.0.1:7680 \
  --state-dir /tmp/codex-remote-agent \
  --workspace /path/to/repo \
  --setup-token change-me
```

Open `http://127.0.0.1:7680` and enter the setup token.

## Tailscale

For personal remote access, bind to the server's Tailscale IP or to `0.0.0.0` only when protected by tailnet ACLs or a trusted reverse proxy:

```bash
cargo run -p codex-remote-agent -- \
  --bind 100.x.y.z:7680 \
  --state-dir /var/lib/codex-remote-agent \
  --workspace /srv/app \
  --setup-token "$(openssl rand -base64 32)"
```

The default bind is `127.0.0.1:7680` to avoid accidentally exposing command execution APIs.

## MVP Limits

The initial backend adapter is deterministic and exists to validate the agent and UI contract. Real Codex protocol integration should replace the adapter behind the session manager boundary.
