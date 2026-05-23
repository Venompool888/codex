# Codex Web Runbook

This directory is the experimental Codex Web surface in this fork. It is not a standalone npm package: run it from the repository root so the `workspace:*` dependency on `@openai/codex-sdk` resolves through `pnpm-workspace.yaml`.

## Local development

```bash
cd /root/codex
pnpm install
cd codex-web
pnpm dev
```

Development mode starts the WebSocket bridge on port `3000` and Vite on port `5173`.

## Production-style run

```bash
cd /root/codex/codex-web
pnpm build
CODEX_WEB_AUTH_TOKEN=change-me NODE_ENV=production PORT=3001 pnpm start
```

The server refuses off-localhost WebSocket access unless `CODEX_WEB_AUTH_TOKEN` is set. Pass the token to the browser as `?token=...`.

## sgbat runtime

On `sgbat`, keep one long-running production instance on port `3001`. The Windows workstation currently reaches it through SSH forwarding:

```powershell
ssh -N -L 127.0.0.1:13001:127.0.0.1:3001 sgbat
```

Then open `http://127.0.0.1:13001/?token=<CODEX_WEB_AUTH_TOKEN>`.

Useful checks on `sgbat`:

```bash
cd /root/codex/codex-web
pnpm build
pnpm exec playwright test --reporter=line
curl -i http://127.0.0.1:3001/
ss -ltnp | grep ':3001'
```

If duplicate Codex Web ports appear, stop the stale `pnpm start` or `tsx server.ts` process trees and leave only the `PORT=3001` instance.
