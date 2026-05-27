# Codex Remote Real Backend Composer Design

## Goal

Turn `codex-remote-agent` from a deterministic UI prototype into a real Codex remote web client for one workspace.

The first production slice is intentionally narrow: keep the existing desktop-style Web UI and connect its session/composer flow to Codex app-server v2. A user should be able to open the Tailscale URL, create a session for the configured workspace, type a prompt, and receive real Codex output streamed back into the conversation.

## Direction

Use an **app-server v2 bridge**.

`codex-remote-agent` remains the browser-facing HTTP/SSE server. It should not reimplement Codex reasoning, tool execution, rollout storage, or permission logic. Instead, it owns remote access, setup token gating, session metadata, workspace browsing, diff display, and UI-specific event history. Real Codex work runs through Codex app-server v2.

The bridge should call:

- `initialize` when connecting to app-server.
- `thread/start` when creating a remote session.
- `turn/start` when the user submits a message.
- app-server notifications such as `item/agentMessage/delta`, `turn/completed`, item lifecycle events, and approval requests while a turn is active.

## Current State

The current implementation is still a demo backend:

- `SessionManager::start_session` writes deterministic events.
- There is no message submit endpoint.
- The frontend composer prevents submission and shows a deterministic-backend explanation.
- Approval events are synthetic.
- File tree, diff viewing, setup token gating, session list, SSE plumbing, and the desktop UI shell already exist.

## Non-Goals

This slice does not include:

- Native desktop packaging.
- Mobile app packaging.
- Multi-account sync.
- Multi-host SSH orchestration.
- A hosted cloud relay.
- Replacing app-server protocol types.
- Adding new app-server v1 API surface.
- Fake Codex messages, fake tool calls, or fake approvals.
- A general-purpose terminal.

## Backend Architecture

Add a backend adapter boundary inside `codex-remote-agent`.

The session layer should depend on a small Codex backend interface instead of directly emitting demo events. The deterministic backend remains available for tests and explicit fallback, but the app-server backend becomes the real runtime path.

The app-server backend is responsible for:

- Starting or connecting to a local `codex app-server` process.
- Performing the app-server initialization handshake.
- Creating a thread for each remote-agent session.
- Submitting user messages as app-server turns.
- Reading app-server JSON-RPC responses and notifications.
- Translating app-server notifications into `SessionEvent` records.
- Returning clear errors when app-server is unavailable or rejects a request.

`codex-remote-agent` should store the app-server `threadId` on the remote session so future messages continue the same conversation. It may also store active `turnId` while a turn is running so duplicate submissions can be rejected.

## Message Submission

Add a real submit endpoint:

`POST /api/sessions/{sessionId}/messages`

The request body should include the user message text. Empty or whitespace-only messages are rejected.

On success:

- The backend records a real user message event immediately so the UI responds without waiting for model output.
- The session enters a running state.
- The app-server backend calls `turn/start` for the session's `threadId`.
- Assistant deltas stream through the existing SSE channel as message events.
- Turn completion updates the session state and refreshes diff information.

On failure:

- The endpoint returns a structured error.
- If the failure happens after the user message is accepted, the session records an error event and moves to a failed or ready-to-retry state.
- The UI must not show a sent message as if Codex is working when the backend rejected the submit before acceptance.

Only one active turn is allowed per session in this slice. If a turn is already running, additional submits return a conflict-style error and the composer stays disabled.

## Event Mapping

Map app-server events into the existing remote-agent event stream where possible.

Required mappings:

- User submit -> `MessageDelta` or equivalent user message event.
- `item/agentMessage/delta` -> assistant message delta.
- `turn/started` or equivalent response acknowledgement -> running status.
- `turn/completed` with success -> completed status.
- `turn/completed` with failure/interrupted state -> failed or interrupted status.
- App-server errors -> error event.

Tool and file-related notifications should be mapped incrementally:

- Command or tool item started -> tool call started.
- Command or tool item completed -> tool call completed.
- File change or diff update -> diff change event or diff refresh trigger.

If an app-server notification does not have a safe UI mapping yet, the bridge should log it and keep the session coherent. It must not invent a fake success state.

## Approvals And Permissions

Do not synthesize approvals.

Approvals are real only when app-server asks the client to approve an action. The bridge should translate supported server-initiated approval requests into the existing approval card model. User approval or rejection must be sent back to app-server as the response to the original request.

If app-server asks for an approval type that this first slice does not support, remote-agent should reject it with a clear unsupported-approval message and record an error event. It should not default-approve unknown actions.

Runtime permissions should use the user's existing Codex configuration unless explicitly provided by remote-agent configuration. For this slice, the configured workspace cwd is passed to app-server for `thread/start` and `turn/start`; permission model changes are out of scope.

## Frontend Behavior

The current desktop UI layout remains.

Composer states:

- Ready: input enabled, send button enabled when non-empty text is present.
- Running: input disabled, send button shows a working state.
- Needs approval: approval card visible, composer disabled until approval resolves.
- Failed: error visible, composer enabled for retry or next instruction.
- Completed: composer enabled again.
- Backend unavailable: composer disabled with a clear connection error.

The deterministic-backend explanation should be removed from the normal runtime path. If a demo backend is explicitly active, the UI can show a short honest demo-mode status.

The frontend should call the new submit endpoint, append accepted user messages through the same event stream model, and keep sidebar session status synchronized with backend state.

## Error Handling

Required error cases:

- app-server executable missing or cannot be started.
- app-server initialization fails.
- session has no `threadId`.
- `turn/start` rejects the message.
- a turn is already active.
- app-server process exits while a turn is active.
- approval request type is unsupported.

Errors should be visible in the conversation and actionable enough for the operator to diagnose server setup. Do not hide backend failures behind generic UI copy.

## Testing And Verification

Automated checks:

- Unit tests for the session manager with a fake backend adapter.
- Route test for `POST /api/sessions/{sessionId}/messages`.
- Tests for duplicate-submit rejection while a turn is active.
- Tests for app-server notification mapping into remote-agent events.
- `node --check codex-rs/remote-agent/static/app.js`.
- `cargo test -p codex-remote-agent`.
- `just fmt`.
- `just fix -p codex-remote-agent`.

Manual/browser checks:

- Start the remote-agent preview on the Tailscale bind address.
- Complete setup.
- Create a session.
- Submit a real prompt.
- Confirm app-server receives `thread/start` and `turn/start`.
- Confirm assistant output streams into the conversation.
- Confirm composer disables while running and re-enables on completion or failure.
- Confirm browser console has no errors on desktop and mobile widths.

## Acceptance Criteria

This slice is accepted when:

- The composer can submit real prompts to Codex.
- A remote session is backed by an app-server thread.
- Assistant output is streamed from app-server into the browser.
- Synthetic demo approval/message behavior is no longer the normal runtime path.
- Unsupported backend states fail explicitly instead of looking successful.
- Existing workspace tree, diff drawer, session list, setup token, and polished UI remain usable.
- The implementation stays scoped to `codex-remote-agent` unless a small shared protocol/client change is unavoidable.
