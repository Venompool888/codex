# Codex Remote Desktop UI Visual Polish Design

## Goal

Refine the current `codex-remote-agent` desktop UI from a functional dark layout into a polished ChatGPT/Codex desktop-client experience.

The existing information architecture is correct: titlebar, left project/session sidebar, central conversation, right diff drawer, command palette, info panel, and disabled composer. The missing piece is visual fit and finish: softer geometry, better pane seams, richer surface hierarchy, improved density, and controls that feel embedded in a real desktop app instead of placed on a flat engineering dashboard.

## Direction

Use the **high-fidelity ChatGPT/Codex desktop client polish** direction.

The UI should feel:

- Cohesive across panes, with surfaces that meet cleanly.
- Rounded and layered, but not bubbly or decorative.
- Dense enough for repeated developer use.
- Softer than an IDE, less hard-edged than the current version.
- Close to the Telegram reference image and current ChatGPT/Codex desktop app conventions.

## Non-Goals

This pass does not include:

- New API behavior.
- Real message submission.
- Native app packaging.
- A frontend build system.
- Fake menus or fake controls.
- Marketing-style hero design.
- New product flows beyond the current shell.

## Visual System Changes

### Surface Hierarchy

Replace the current flat dark blocks with a layered desktop shell:

- Window background: deepest neutral black.
- Titlebar: slightly lifted charcoal with subtle bottom divider.
- Sidebar: warm dark pane with inset highlight.
- Main conversation: central dark canvas with a gentle inner boundary.
- Diff drawer: inspector pane with its own darker depth and sticky-feeling header.
- Modals: raised panels with soft shadow and clearer radius.

Borders should become subtler and more selective. Use faint dividers, inset shadows, and small contrast changes instead of heavy outlines everywhere.

### Geometry

Increase and standardize radius:

- App controls: 9-12px.
- Sidebar rows and command palette rows: 10-12px.
- Message and action blocks: 14-16px.
- Composer island: 14-18px.
- Setup and modal panels: 18-22px.

Avoid oversized pill buttons except where the shape communicates a compact control. The result should be curved and fitted, not cartoonish.

### Pane Fit

Improve layout attachment:

- The sidebar should feel docked into the window, not like a separate card.
- The central conversation should have a subtle max-width rhythm while still filling the pane.
- The diff drawer should slide into the existing grid with an inspector feel, not look like a raw column.
- Pane seams should use single-pixel low-contrast dividers plus local shadows.
- Mobile sheets should preserve the same visual language.

### Sidebar

Make the project/session sidebar closer to the reference:

- Product heading smaller and more integrated.
- Primary actions as compact paired controls.
- Project rows with a selected/inset state.
- Session rows as soft rounded strips with concise status pills.
- Better truncation for long workspace names and paths.
- Bottom connection details button visually quiet but discoverable.

Bad workspace disabled states remain visible and non-clickable.

### Conversation Stream

Make the main stream feel like a Codex session:

- Use calmer message blocks with softer backgrounds.
- Reduce the heavy boxed feeling of every message.
- Make system timeline events lighter and centered.
- Approval blocks should feel like action cards with clear hierarchy.
- Approved/denied result state should be compact and legible.
- Completion events should not dominate the stream.

The event mapping and real approval controls stay unchanged.

### Composer

Convert the composer from a basic form row into a bottom input island:

- Center it inside the main pane with max width matching the conversation.
- Use a raised rounded input surface.
- Keep the send button disabled and visually subordinate.
- Keep the deterministic-backend explanation visible and complete.
- Avoid truncated explanatory text; short placeholder plus full status text is acceptable.

No user message should be created from this composer.

### Diff Drawer

Make the diff drawer more like an inspector:

- Header with stronger title and compact summary.
- File rows with better spacing, subtle separators, and path chips.
- Counts aligned and muted.
- Empty/loading/error states styled consistently.
- Close button should be icon-sized, not dominant.

### Command Palette And Info Panel

Polish modal overlays:

- More polished backdrop.
- Larger radius and soft shadow.
- Search input integrated into the palette panel.
- Result rows with hover and active states that match the sidebar.
- Info panel rows should look intentional, not like unstyled definition list text.

All palette actions remain real and executable.

## Responsive Behavior

Desktop remains primary.

Responsive requirements:

- At desktop width, sidebar, conversation, and drawer must not visually fight for space.
- At tablet/mobile width, sidebar and diff drawer remain full-height sheets with the same rounded/dark style.
- No button text or composer text should overflow its container.
- Titlebar action text can compact if necessary, but controls must remain understandable.

## Testing And Verification

Automated checks:

- `node --check codex-rs/remote-agent/static/app.js`
- `cargo test -p codex-remote-agent serves_embedded_web_ui`
- `cargo test -p codex-remote-agent`
- `just fmt`
- `just fix -p codex-remote-agent`

Manual/browser checks:

- Open the Tailscale preview URL.
- Complete setup.
- Create a session.
- Approve a request and confirm sidebar status updates.
- Open command palette with `Ctrl+K` / `Cmd+K`.
- Open diff drawer.
- Open info panel.
- Check browser console for errors.
- Capture desktop screenshot and verify the UI has curved, cohesive, fitted desktop-client polish.
- Check a mobile viewport for no overlap and usable sheets.

## Acceptance Criteria

The polish pass is accepted when:

- The current layout remains intact but no longer feels visually bare.
- The app reads as a ChatGPT/Codex desktop client rather than an admin dashboard.
- Pane seams feel fitted and deliberate.
- Sidebar rows, chat blocks, composer, diff drawer, and modals share a coherent radius/shadow/border language.
- All existing real controls still work.
- Composer still honestly communicates that message sending is unavailable.
- No new frontend build system or fake controls are introduced.
