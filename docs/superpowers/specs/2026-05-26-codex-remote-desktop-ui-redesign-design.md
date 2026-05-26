# Codex Remote Desktop UI Redesign Design

## Goal

Redesign the embedded `codex-remote-agent` Web UI so it feels like a dark Codex/ChatGPT desktop client instead of a server dashboard.

The redesign should make the product feel like a real remote Codex control surface: workspace and session navigation on the left, the active session as the primary conversation surface, operational approvals and diffs embedded in that flow, and a right-side diff drawer that opens only when needed.

## Reference

The accepted visual reference is the Telegram-provided image:

- Original name: `image_2026-05-27_03-27-08.png`
- Local path: `/root/tg-file-bridge/inbox/20260526-172708-489-document-image_2026-05-27_03-27-08.png`

The reference is a dark desktop agent UI with:

- Left navigation for app actions and project/thread history.
- A central conversation surface.
- A compact title/header area.
- A bottom composer.
- Dense but readable typography.
- Minimal decoration and no marketing-style layout.

## Product Direction

Use the **Exact Codex Desktop Clone** direction, with one hard constraint: every visible control must have a real behavior. The UI may look native and desktop-like, but it must not show fake menus, fake icons, or placeholder buttons.

The interface should prioritize:

- A dark desktop-client shell.
- Chat-first active session flow.
- Real command and navigation controls.
- Approval and diff actions integrated into the session.
- Honest MVP limitations for the deterministic backend.

The redesign is a productized UI pass, not just a CSS refresh. It may include focused API shape improvements if the UI needs them, plus README and smoke-test updates.

## Non-Goals

This redesign does not include:

- Real Codex backend execution.
- Native Windows, macOS, or mobile app packaging.
- Multi-user or team permission systems.
- A full file editor.
- Fake message submission.
- Decorative controls with no behavior.
- A new frontend build pipeline.

The embedded UI must remain static HTML/CSS/JS served by the Rust crate.

## Layout

### App Shell

The first authenticated screen should be a full-viewport app shell. It should not look like separate dashboard cards. The shell has:

- A simplified desktop-style titlebar.
- A left project/session sidebar.
- A central session surface.
- A right-side diff drawer, closed by default.
- A bottom composer area.

Before setup is complete, the app should show a focused connection/setup gate. After setup, the gate disappears and the desktop shell fills the viewport.

### Titlebar

Use a simplified titlebar, not fake native menus.

Allowed controls:

- Back and Forward: switch through local session selection history.
- Refresh: reload workspaces, sessions, status, and current diff.
- Diff: open or close the real diff drawer.
- Info: open a real connection/session details panel.
- Command Palette: open the real command palette.

The titlebar should show:

- Current session title.
- Current workspace path or display name.
- Connection status.
- Access/backend mode.

Do not show `File`, `Edit`, `View`, `Window`, or `Help` unless they become real menus.

### Left Sidebar

Use a Codex/ChatGPT-style project sidebar.

Structure:

- Product identity: `Codex Remote`.
- Connection summary.
- Primary actions:
  - New session.
  - Command Palette.
  - Workspaces.
- Projects section:
  - Each configured workspace appears as a project group.
  - Sessions appear as thread rows under their workspace.
  - The active session row uses the selected-row treatment from the reference image.
- Settings or connection details at the bottom.

Bad or missing workspaces must remain visible with an error indicator, but their rows must be disabled and must not trigger file, diff, or session API calls.

### Main Session Surface

The main pane is the active session. It uses a mixed conversation and system-action model.

Event rendering rules:

- `SessionCreated`: compact assistant/system intro.
- `StatusText`: lightweight timeline separator.
- `MessageDelta`: assistant message text.
- `ApprovalRequested`: action block with real Approve and Deny controls.
- `ApprovalDecided`: terminal state inside the approval block or adjacent event.
- `DiffUpdated`: compact change-summary block with an Open Diff action.
- `ErrorRaised`: visible error message in the stream.

User messages should not be faked while the backend cannot submit messages. If the UI needs to show user intent in the future, it must come from a real API/event.

### Diff Drawer

Diff is hidden by default and opens from the right.

Open triggers:

- Titlebar Diff control.
- Command Palette action.
- Diff event action.

Content:

- Changed file list.
- Additions/deletions.
- File status.
- Empty state when no changes exist.
- Error state when the selected workspace is unavailable or diff fails.

The drawer should behave like an inspector, not a permanent dashboard card. On mobile, it becomes a full-screen sheet.

### Composer

The composer remains visible at the bottom to preserve the desktop-client mental model, but it must be honestly disabled while the deterministic backend has no real message-submit API.

Behavior:

- Placeholder: `Message sending unavailable in deterministic backend`.
- Disabled send button.
- Click or focus shows a concise status explanation.
- No fake user message is created.

When real Codex backend integration later adds message submission, this composer can become the real input surface.

## Command Palette

Implement a real command palette opened by `Ctrl+K` / `Cmd+K` and by a visible titlebar/sidebar control.

It should search:

- Loaded workspaces.
- Loaded sessions.
- Real UI actions.

Initial actions:

- New session.
- Refresh remote state.
- Open diff drawer.
- Close diff drawer.
- Open connection info.
- Reveal composer status.

The palette must not show actions that cannot execute.
`Reveal composer status` should scroll to or highlight the disabled composer and show the deterministic-backend explanation; it must not imply that message sending is available.

Keyboard behavior:

- `Escape` closes.
- Arrow keys move selection.
- `Enter` executes the selected item.
- Search filters results locally.

## Real-Control Rule

Every visible control must do something real.

Allowed:

- Real navigation.
- Real refresh.
- Real diff drawer toggle.
- Real approval decisions.
- Real command palette actions.
- Real connection/session info.

Not allowed:

- Fake native app menus.
- Decorative icon buttons.
- Placeholder controls that silently do nothing.
- Message send behavior that fabricates local user messages.

If a feature is not ready, hide it or show an explicit disabled state with a clear explanation.

## Visual System

### Theme

Use a dark charcoal palette close to the reference image:

- App background: near black.
- Sidebar: slightly lighter charcoal.
- Main surface: dark neutral.
- Drawer: inspector-style dark panel.
- Borders: subtle gray separators.
- Text: high-contrast primary, muted secondary.
- Accent: restrained orange or blue for focus and important state only.

Avoid:

- Marketing gradients.
- Decorative blobs or orbs.
- Large dashboard cards.
- One-note blue-gray admin styling.

### Typography

Use compact desktop-app typography:

- Dense sidebar/thread rows.
- Clear titlebar hierarchy.
- Comfortable line height for session content.
- Monospace chips for commands, IDs, and file paths.

No viewport-scaled font sizes.

### Components

Required components:

- Desktop titlebar.
- Sidebar project tree.
- Session thread rows.
- Chat message rows.
- Timeline/status separators.
- Approval action block.
- Diff summary block.
- Right diff drawer.
- Command palette modal.
- Connection/setup gate.
- Info panel.
- Disabled deterministic-backend composer.

Cards may be used for repeated items and action blocks, but page sections should feel like app panes, not floating dashboard cards.

## Responsive Behavior

Desktop is the primary experience.

Breakpoints:

- Desktop: full titlebar, sidebar, session surface, optional diff drawer.
- Tablet: sidebar plus session surface; diff drawer overlays.
- Phone: single session surface; sidebar and diff open as full-screen sheets.

Mobile requirements:

- No overlapping text.
- Composer remains visible and disabled state remains clear.
- Sidebar is accessible through a real menu button.
- Diff drawer is accessible through a real action.

## API And Data Needs

The redesign should reuse existing APIs where possible.

Potential focused additions are allowed only if needed for real UI behavior, such as:

- Status payload fields for backend mode or server identity.
- Session summary fields useful for sidebar display.

Do not add broad backend features as part of this UI redesign. Real Codex execution remains out of scope.

## Testing And Verification

Automated checks:

- `node --check codex-rs/remote-agent/static/app.js`
- `cargo test -p codex-remote-agent`
- Static UI tests updated for the new shell landmarks.
- API tests only when API shape changes.

Manual smoke test:

- Open the Tailscale URL.
- Complete setup.
- Verify workspace groups in the sidebar.
- Create a session.
- Verify SSE events render in the mixed conversation stream.
- Approve and deny approval blocks.
- Open and close the diff drawer from titlebar, event block, and command palette.
- Open command palette and run real actions.
- Open info panel.
- Confirm composer explains deterministic backend mode and does not send.
- Check mobile viewport for sidebar and diff sheets.

## Acceptance Criteria

The redesign is accepted when:

- The first impression matches a dark Codex/ChatGPT desktop client, not a server dashboard.
- All visible controls have real behavior.
- The current deterministic backend limitation is explicit.
- Workspaces and sessions are navigable from a left project/thread sidebar.
- The session stream is chat-first but preserves operational approval/diff clarity.
- Diff is available through an on-demand drawer.
- Command Palette is real and useful.
- Desktop is polished and mobile is usable.
- No frontend build system is introduced.
