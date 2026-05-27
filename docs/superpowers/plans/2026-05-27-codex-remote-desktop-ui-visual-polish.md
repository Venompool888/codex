# Codex Remote Desktop UI Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Codex Remote desktop UI from a functional dark layout into a polished ChatGPT/Codex-style desktop client while keeping all current real controls and backend behavior.

**Architecture:** Keep the current static HTML/CSS/JS app and refine mostly through `styles.css`. Use only small HTML class adjustments if needed for styling hooks. Do not change API payloads, session behavior, or introduce a frontend build pipeline.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Rust embedded static assets, Playwright CLI smoke testing, `node --check`, `cargo test -p codex-remote-agent`, `just fmt`, `just fix -p codex-remote-agent`.

---

## File Structure

- Modify `codex-rs/remote-agent/static/styles.css`: primary polish pass for theme tokens, surface hierarchy, pane seams, controls, sidebar rows, chat blocks, composer island, diff drawer, modals, and responsive sheets.
- Modify `codex-rs/remote-agent/static/index.html`: only if a styling hook is needed for the composer or shell; keep landmarks and IDs stable.
- Modify `codex-rs/remote-agent/static/app.js`: only if visual state needs an existing real state reflected as a class; no API or behavior expansion.
- Modify `codex-rs/remote-agent/tests/api.rs`: only if static asset or landmark assertions need minor updates.

## Task 1: Establish Polished Design Tokens And Pane Surfaces

**Files:**
- Modify: `codex-rs/remote-agent/static/styles.css`

- [ ] **Step 1: Run baseline checks**

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
cd /root/codex/codex-rs
cargo test -p codex-remote-agent serves_embedded_web_ui
```

Expected: both commands pass before visual changes.

- [ ] **Step 2: Replace root tokens with layered desktop-client tokens**

In `codex-rs/remote-agent/static/styles.css`, replace the `:root` block with tokens for a warmer, more layered desktop shell:

```css
:root {
  color-scheme: dark;
  --bg: #050505;
  --window: #0d0d0e;
  --titlebar: #111113;
  --sidebar: #151516;
  --sidebar-raised: #1d1d1f;
  --surface: #1b1b1d;
  --surface-soft: #202023;
  --surface-raised: #28282b;
  --drawer: #131315;
  --modal: #202024;
  --border: rgb(255 255 255 / 0.105);
  --border-soft: rgb(255 255 255 / 0.065);
  --border-strong: rgb(255 255 255 / 0.16);
  --text: #f4f1ec;
  --muted: #aaa7a1;
  --muted-2: #7f7b75;
  --accent: #f0a15f;
  --accent-blue: #8fb4ff;
  --danger: #ff8a82;
  --success: #9adb95;
  --warning: #f3c96b;
  --code-bg: #303034;
  --shadow-soft: 0 18px 60px rgb(0 0 0 / 0.34);
  --shadow-inset: inset 0 1px 0 rgb(255 255 255 / 0.04);
  --focus-ring: 0 0 0 3px rgb(143 180 255 / 0.22);
}
```

- [ ] **Step 3: Polish global controls**

Update the shared `button`, `input`, focus, and disabled rules so controls use 10-12px radii, subtle border, inset highlight, and clear hover state:

```css
button {
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: linear-gradient(180deg, rgb(255 255 255 / 0.055), rgb(255 255 255 / 0.025));
  box-shadow: var(--shadow-inset);
  color: var(--text);
  padding: 0 13px;
  cursor: pointer;
}

button:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: linear-gradient(180deg, rgb(255 255 255 / 0.085), rgb(255 255 255 / 0.04));
}

button:focus-visible,
input:focus-visible {
  outline: 0;
  box-shadow: var(--focus-ring), var(--shadow-inset);
}

input {
  min-width: 0;
  min-height: 38px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgb(0 0 0 / 0.22);
  color: var(--text);
  padding: 9px 12px;
}
```

- [ ] **Step 4: Commit token and shell polish**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/styles.css
git commit -m "Polish remote agent desktop surface tokens"
```

## Task 2: Refine Shell, Sidebar, And Pane Seams

**Files:**
- Modify: `codex-rs/remote-agent/static/styles.css`

- [ ] **Step 1: Update shell and pane layout rules**

Adjust `.desktop-shell`, `.app-frame`, `.desktop-titlebar`, `.desktop-body`, `.workspace-sidebar`, and `.diff-drawer` so the UI feels like one fitted desktop window:

```css
.desktop-shell {
  min-height: 100vh;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% -20%, rgb(255 255 255 / 0.045), transparent 34%),
    var(--bg);
}

.app-frame {
  display: grid;
  grid-template-rows: 46px minmax(0, 1fr);
  height: 100vh;
  background: var(--window);
}

.desktop-titlebar {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border-soft);
  background: linear-gradient(180deg, #151517, var(--titlebar));
  box-shadow: var(--shadow-inset);
  padding: 0 12px;
}

.desktop-body {
  display: grid;
  grid-template-columns: 298px minmax(0, 1fr);
  min-height: 0;
  background: var(--window);
}

.desktop-shell.diff-open .desktop-body {
  grid-template-columns: 298px minmax(0, 1fr) minmax(340px, 430px);
}

.workspace-sidebar {
  min-width: 0;
  border-right: 1px solid var(--border-soft);
  background: linear-gradient(180deg, #19191b, var(--sidebar));
  box-shadow: inset -1px 0 0 rgb(0 0 0 / 0.26), var(--shadow-inset);
  overflow: auto;
  padding: 16px 14px;
}

.diff-drawer {
  display: none;
  min-width: 0;
  border-left: 1px solid var(--border-soft);
  background: linear-gradient(180deg, #171719, var(--drawer));
  box-shadow: inset 1px 0 0 rgb(255 255 255 / 0.025);
  overflow: auto;
  padding: 16px;
}
```

- [ ] **Step 2: Refine sidebar controls and rows**

Update `.sidebar-actions`, `.project-header`, `.thread-row`, `.status-pill`, and `.connection-details-button` with compact paired action controls, inset selected rows, and better truncation:

```css
.sidebar-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
}

.project-header,
.thread-row {
  border-radius: 12px;
  box-shadow: var(--shadow-inset);
}

.project-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 8px;
  min-height: 48px;
  background: rgb(255 255 255 / 0.035);
}

.project-group.active .project-header,
.thread-row.active {
  border-color: rgb(240 161 95 / 0.28);
  background: linear-gradient(180deg, rgb(240 161 95 / 0.13), rgb(255 255 255 / 0.045));
}

.thread-row {
  min-height: 34px;
  background: transparent;
}

.status-pill {
  border: 1px solid rgb(255 255 255 / 0.07);
  border-radius: 999px;
  background: rgb(0 0 0 / 0.22);
}

.connection-details-button {
  border-color: transparent;
  background: rgb(255 255 255 / 0.035);
}
```

- [ ] **Step 3: Commit shell/sidebar polish**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/styles.css
git commit -m "Polish remote agent shell and sidebar"
```

## Task 3: Refine Conversation Stream, Approval Cards, And Composer Island

**Files:**
- Modify: `codex-rs/remote-agent/static/styles.css`

- [ ] **Step 1: Update conversation and event block styling**

Adjust `.session-surface`, `.session-scroll`, `.chat-row`, `.action-block`, `.timeline-separator`, and approval styles:

```css
.session-surface {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 0.018), transparent 120px),
    var(--surface);
}

.session-scroll {
  min-height: 0;
  overflow: auto;
  padding: 30px clamp(18px, 7vw, 104px) 22px;
}

.chat-row,
.action-block {
  width: min(760px, 100%);
  margin: 0 auto 14px;
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: linear-gradient(180deg, rgb(255 255 255 / 0.045), rgb(255 255 255 / 0.025));
  box-shadow: var(--shadow-inset);
  padding: 14px;
}

.action-block {
  border-color: rgb(240 161 95 / 0.18);
  background: linear-gradient(180deg, rgb(240 161 95 / 0.10), rgb(255 255 255 / 0.028));
}

.timeline-separator {
  width: min(760px, 100%);
  margin: 14px auto;
  color: var(--muted-2);
  font-size: 12px;
  text-align: center;
}

.approval-result {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.055);
  color: var(--muted);
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
}
```

- [ ] **Step 2: Convert composer into bottom input island**

Update `.composer`, `.composer input`, `.composer button`, and `.composer-status`:

```css
.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  width: min(760px, calc(100% - 32px));
  margin: 0 auto 16px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: linear-gradient(180deg, rgb(255 255 255 / 0.06), rgb(255 255 255 / 0.03));
  box-shadow: 0 12px 34px rgb(0 0 0 / 0.22), var(--shadow-inset);
  padding: 10px;
}

.composer input {
  min-height: 40px;
  border-color: transparent;
  background: transparent;
  padding: 8px 2px;
}

.composer button {
  min-width: 62px;
  border-radius: 12px;
}

.composer-status {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 12px;
  padding: 0 2px 2px;
}
```

- [ ] **Step 3: Commit conversation/composer polish**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/styles.css
git commit -m "Polish remote agent conversation and composer"
```

## Task 4: Refine Diff Drawer, Command Palette, Info Panel, And Responsive Sheets

**Files:**
- Modify: `codex-rs/remote-agent/static/styles.css`

- [ ] **Step 1: Polish diff drawer and file rows**

Update `.drawer-header`, `.diff-panel`, `.diff-file`, `.diff-path`, and close controls:

```css
.drawer-header {
  position: sticky;
  top: 0;
  z-index: 1;
  align-items: flex-start;
  padding-bottom: 12px;
  background: linear-gradient(180deg, var(--drawer) 72%, transparent);
}

.diff-panel {
  display: grid;
  gap: 8px;
  margin-top: 4px;
}

.diff-file {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  border-bottom: 1px solid var(--border-soft);
  padding: 10px 0;
}

.diff-path,
.command {
  border: 1px solid rgb(255 255 255 / 0.06);
  border-radius: 8px;
  background: var(--code-bg);
  color: var(--text);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  padding: 3px 7px;
}
```

- [ ] **Step 2: Polish modal overlays and result rows**

Update `.command-palette`, `.info-panel`, `.palette-panel`, `.info-card`, `.palette-item`, and `.info-details`:

```css
.command-palette,
.info-panel {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: start center;
  background: rgb(0 0 0 / 0.62);
  backdrop-filter: blur(10px);
  padding: 12vh 20px 20px;
}

.palette-panel,
.info-card,
.setup-card {
  border-radius: 22px;
  background: linear-gradient(180deg, rgb(255 255 255 / 0.07), rgb(255 255 255 / 0.035)), var(--modal);
  box-shadow: var(--shadow-soft), var(--shadow-inset);
}

.palette-item {
  display: grid;
  gap: 2px;
  border-radius: 12px;
  background: transparent;
}

.palette-item.active,
.palette-item:hover {
  border-color: rgb(143 180 255 / 0.32);
  background: rgb(143 180 255 / 0.10);
}

.info-details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px 14px;
  margin: 16px 0 0;
  border-top: 1px solid var(--border-soft);
  padding-top: 14px;
}
```

- [ ] **Step 3: Refine mobile sheets**

Update the existing `@media (max-width: 900px)` and `@media (max-width: 620px)` rules so sidebar and diff sheets have the same rounded/fitted style and no text overlap:

```css
@media (max-width: 900px) {
  .workspace-sidebar {
    position: fixed;
    inset: 52px auto 10px 10px;
    z-index: 15;
    width: min(88vw, 360px);
    border: 1px solid var(--border);
    border-radius: 18px;
    transform: translateX(calc(-100% - 20px));
    transition: transform 160ms ease;
  }

  .diff-drawer {
    position: fixed;
    inset: 52px 10px 10px;
    z-index: 16;
    display: none;
    border: 1px solid var(--border);
    border-radius: 18px;
  }

  .session-scroll {
    padding: 22px 14px;
  }

  .composer,
  .inline-field {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Commit drawer/modal/responsive polish**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/styles.css
git commit -m "Polish remote agent drawer and modals"
```

## Task 5: Final Verification And Tailscale Preview

**Files:**
- Modify only if verification catches a small visual defect:
  - `codex-rs/remote-agent/static/styles.css`
  - `codex-rs/remote-agent/static/index.html`
  - `codex-rs/remote-agent/static/app.js`

- [ ] **Step 1: Run automated checks**

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
cd /root/codex/codex-rs
cargo test -p codex-remote-agent
just fmt
just fix -p codex-remote-agent
```

Expected: all commands pass.

- [ ] **Step 2: Start Tailscale preview**

```bash
cd /root/codex/codex-rs
cargo run -p codex-remote-agent -- --bind 100.102.128.28:7682 --state-dir /tmp/codex-remote-agent-visual-polish-preview --workspace /root/codex --setup-token ui-preview
```

Expected: server listens at `http://100.102.128.28:7682`.

- [ ] **Step 3: Browser smoke test**

Use Playwright CLI or a browser to verify:

- Setup with `ui-preview`.
- Create a session.
- Approve the request.
- Sidebar session status becomes `Completed`.
- Open diff drawer.
- Open command palette.
- Open info panel.
- Console has 0 errors and 0 warnings.
- Desktop screenshot shows rounded, layered, fitted pane polish.
- Mobile viewport shows usable sidebar and diff sheets without overlap.

- [ ] **Step 4: Commit any final polish fixes**

If Step 3 reveals small visual corrections:

```bash
cd /root/codex
git add codex-rs/remote-agent/static/styles.css codex-rs/remote-agent/static/index.html codex-rs/remote-agent/static/app.js
git commit -m "Finalize remote agent visual polish"
```

If no corrections are needed, do not create an empty commit.

## Self-Review

- Spec coverage: Tasks cover surface hierarchy, geometry, pane fit, sidebar, conversation stream, composer, diff drawer, modals, responsive behavior, and manual visual verification.
- Scope check: The plan is a single visual polish pass scoped to the embedded static UI; no backend or API changes are planned.
- Placeholder scan: There are no TODO/TBD sections. Code snippets define concrete CSS targets and commands.
- Type consistency: The plan uses selectors and IDs already present in the current UI: `.desktop-shell`, `.app-frame`, `.desktop-titlebar`, `.workspace-sidebar`, `.session-surface`, `.diff-drawer`, `.composer`, `.command-palette`, `.info-panel`.
