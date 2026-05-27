# codex-remote-agent

`codex-remote-agent` is the personal self-hosted server for Codex Remote.

It serves a browser UI and local APIs for controlling Codex-style sessions on a server where the source code lives.

## Run Locally

```bash
cd codex-rs
cargo run -p codex-remote-agent -- \
  --bind 127.0.0.1:7680 \
  --state-dir "$HOME/.local/state/codex-remote-agent" \
  --workspace /path/to/repo \
  --setup-token change-me \
  --backend app-server
```

Open `http://127.0.0.1:7680` and enter the setup token.

## Tailscale

For personal remote access, bind to the server's Tailscale IP:

```bash
cargo run -p codex-remote-agent -- \
  --bind 100.x.y.z:7680 \
  --state-dir /var/lib/codex-remote-agent \
  --workspace /srv/app \
  --setup-token "$(openssl rand -base64 32)" \
  --backend app-server
```

Use `0.0.0.0` only with host firewall/interface restrictions or a trusted reverse proxy. Tailnet ACLs alone do not protect non-Tailscale interfaces exposed by wildcard binding.

The default bind is `127.0.0.1:7680` to avoid accidentally exposing command execution APIs.

For service-style installs, use a private state directory such as `/var/lib/codex-remote-agent` owned by the service user.

## Real Codex Backend

`codex-remote-agent` defaults to the real app-server backend:

```bash
cargo run -p codex-remote-agent -- \
  --bind 100.102.128.28:7682 \
  --state-dir /tmp/codex-remote-agent-preview \
  --workspace /root/codex \
  --setup-token ui-preview \
  --backend app-server
```

Open `http://100.102.128.28:7682` from a Tailscale-connected device and use setup token `ui-preview`.

For tests or UI-only demos:

```bash
cargo run -p codex-remote-agent -- \
  --bind 127.0.0.1:7682 \
  --state-dir /tmp/codex-remote-agent-demo \
  --workspace /root/codex \
  --setup-token ui-preview \
  --backend demo
```

The demo backend is explicit. It should not be used to validate real Codex behavior.

## Web UI

The embedded Web UI is a dark desktop-style Codex Remote client. After setup, it shows a left workspace/session sidebar, a central session event stream, an on-demand diff drawer, a real command palette (`Ctrl+K` / `Cmd+K`), and a connection info panel.

With the app-server backend, the composer submits real Codex turns through `codex app-server` and streams assistant output back into the browser.
