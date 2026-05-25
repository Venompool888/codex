# Codex Remote Personal Web MVP Design

## Summary

Codex Remote Personal Web MVP is a self-hosted remote control plane for running Codex on a server. It is built for one user who keeps code on Linux servers and wants a graphical Codex experience without manually SSHing into a terminal.

The first release is not a public SaaS, team product, cloud relay, billing system, native mobile app, or full IDE. It is a server-installed agent with a browser UI that works well over Tailscale, a LAN, or a user-managed reverse proxy.

## Goals

- Run Codex sessions on the server where the repositories, shell, credentials, and build tools already live.
- Provide a Web UI for selecting workspaces, creating or resuming sessions, chatting with Codex, approving commands, reviewing diffs, browsing files, and seeing logs.
- Keep the first version personal and self-hosted so the product can validate the remote Codex workflow before adding teams or hosted infrastructure.
- Shape the agent-to-UI API around structured session events so the Codex backend can evolve from a process wrapper to deeper protocol integration.

## Non-Goals

- Public SaaS registration, organizations, billing, or multi-tenant hosting.
- Cloud relay infrastructure for servers behind firewalls.
- Multi-user collaboration or role-based permissions.
- Native desktop or mobile apps in the first version.
- VS Code-level editing, language server integration, or advanced IDE features.
- A UI that parses raw terminal text as its primary integration contract.

## Recommended Approach

Use the server-native agent architecture:

1. The user installs `codex-remote-agent` on a server.
2. The agent serves the Web UI and exposes authenticated local APIs.
3. The browser connects directly to that agent over Tailscale, LAN, or a user-managed reverse proxy.
4. The agent manages Codex session lifecycle and server-side resources.
5. The agent presents structured events and resources to the UI.

The Codex integration should be hybrid. The first implementation may launch and supervise a Codex CLI or process, but the rest of the system should treat that as an adapter behind a protocol-shaped boundary. The Web UI should consume normalized objects and events such as sessions, messages, tool calls, approvals, diffs, files, and errors.

## Architecture

The system has three main layers:

- Browser UI
- `codex-remote-agent`
- Server runtime

The Browser UI renders login/setup, workspace selection, session list, active session, approval controls, diff viewer, file browser, and logs/status screens. It communicates only with the agent.

The agent owns authentication, workspace registry, session metadata, Codex process lifecycle, event normalization, approval state, file reads, git status and diff, logs, and reconnect behavior. It exposes HTTPS APIs for mutations and WebSocket or Server-Sent Events for session streaming.

The server runtime includes the actual repository working tree, shell commands, filesystem access, git, local secrets, and the Codex backend process or protocol client.

## Data Flow

1. User opens the Web UI.
2. If first run, the UI asks for a setup token and creates the single local account/session.
3. The UI lists configured workspaces from the agent.
4. User creates or resumes a Codex session in a workspace.
5. Agent starts or attaches to the Codex backend and records session metadata.
6. Codex output is normalized into structured events and streamed to the UI.
7. When Codex requests a command or risky action, the agent emits an approval request.
8. User approves or denies through the UI.
9. Agent forwards the decision to the backend and records the command decision in the audit log.
10. UI can request file content, git status, and diffs through agent APIs.

## Core UI

The MVP Web UI should include:

- Setup/login screen.
- Workspace list with path, branch, dirty state, and last session.
- Session list with status, title, workspace, updated time, and active/error markers.
- Active session view with chat stream, tool call status, command output, and composer.
- Approval panel or modal for command execution and other sensitive actions.
- Diff viewer for changed files.
- Basic file browser and read-only file viewer.
- Logs/status view for agent health, Codex backend status, and recent errors.

The UI should be responsive. Mobile support should focus on monitoring, chatting, approvals, and reviewing small diffs. Heavy editing is outside the MVP.

## API Shape

The exact API can be refined during implementation, but the UI contract should be structured around these resources:

- `Workspace`: id, display name, path, branch, dirty state, last session.
- `Session`: id, workspace id, title, status, created time, updated time.
- `SessionEvent`: typed stream event for messages, tool calls, approvals, diffs, errors, and lifecycle changes.
- `ApprovalRequest`: id, session id, action type, command or description, risk summary, created time, status.
- `FileEntry`: path, type, size, modified time.
- `DiffSummary`: changed files, additions, deletions, per-file status.

Representative operations:

- `GET /api/workspaces`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{id}`
- `GET /api/sessions/{id}/events`
- `POST /api/sessions/{id}/messages`
- `POST /api/approvals/{id}/approve`
- `POST /api/approvals/{id}/deny`
- `GET /api/workspaces/{id}/files`
- `GET /api/workspaces/{id}/file`
- `GET /api/workspaces/{id}/diff`
- `GET /api/agent/status`
- `GET /api/agent/logs`

## Security

The agent can execute code and read server files, so the first version still needs a real security boundary:

- Default bind should be localhost unless the user explicitly configures a non-loopback bind address.
- Setup should require a one-time setup token printed locally or written to a protected file.
- After setup, the browser should use an authenticated session token.
- All API endpoints must require authentication after setup.
- If cookie auth is used, CSRF protection is required for mutation endpoints.
- The agent should document Tailscale and reverse proxy deployment clearly.
- The agent should maintain an audit log for approvals, denials, command requests, command outcomes, login/setup events, and backend crashes.
- Workspace access should be allowlisted through configuration instead of exposing arbitrary filesystem roots by default.
- Secrets should not be echoed into logs or streamed events unless Codex itself emits them; obvious sensitive headers and environment values should be redacted in agent logs.

## Failure Handling

The UI should expose explicit states for:

- Agent unreachable.
- Network reconnecting.
- Authentication expired.
- Workspace missing or inaccessible.
- Codex backend failed to start.
- Codex backend crashed.
- Session is stale after agent restart.
- Command is awaiting approval.
- Command was denied.
- Git state cannot be read.
- File or diff cannot be loaded.

Agent restart should preserve session metadata, audit logs, configured workspaces, and enough history to show the user what happened. Active process execution may not be fully resumable in the MVP, but the UI should explain that state rather than silently dropping the session.

## Persistence

The agent should persist:

- Configuration and workspace allowlist.
- Local account/session setup state.
- Session metadata.
- Event history sufficient for session reload.
- Approval audit log.
- Agent/backend error log.

The first version can use local files or an embedded database. The choice should optimize for simple backup, easy inspection, and low operational burden.

## Testing Strategy

Agent tests should cover:

- Setup and login flow.
- Auth enforcement on all non-setup APIs.
- Workspace allowlist validation.
- Session creation, listing, and status transitions.
- Event normalization from the initial Codex process adapter.
- Approval request, approve, deny, and audit log behavior.
- File listing, file reading, git status, and diff APIs.
- Backend crash and restart-visible stale session behavior.

UI tests should cover:

- Setup/login.
- Workspace selection.
- Session creation and resume.
- Streaming session events.
- Approval flow.
- Diff rendering.
- File browser basics.
- Reconnect and expired-auth states.
- Mobile viewport smoke tests for active session, approval, and diff views.

## Open Decisions For Implementation Planning

- Implementation language for `codex-remote-agent`.
- Whether the initial stream transport is WebSocket or Server-Sent Events.
- Whether persistence uses local JSON files, SQLite, or another embedded store.
- How much of existing Codex app-server protocol can be reused without slowing the MVP.
- Whether the browser UI is bundled into the agent binary or served from static files next to it.

## Milestone Cut

The first useful milestone should be:

1. Install and start agent on one server.
2. Complete setup login from browser.
3. Configure one workspace.
4. Start one Codex session in that workspace.
5. Send a prompt and stream assistant output.
6. Show command approval requests and allow approve or deny.
7. Show git diff after Codex modifies files.
8. Reload the browser and recover the session list and recent event history.
