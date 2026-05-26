# Codex Remote Desktop UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the `codex-remote-agent` embedded Web UI into a dark ChatGPT/Codex desktop-style remote control surface with real navigation, command palette, diff drawer, info panel, and an honest disabled composer.

**Architecture:** Keep the existing static HTML/CSS/JS frontend served by the Rust crate. Reuse existing REST/SSE APIs and implement the redesign as a client-side app shell: left workspace/session sidebar, central session stream, right diff drawer, command palette, and setup gate. Only update Rust tests/docs for static UI landmarks; do not introduce a frontend build system or broad backend features.

**Tech Stack:** Static HTML, vanilla JavaScript, CSS, Rust 2024, Axum static asset tests, `node --check`, `cargo test -p codex-remote-agent`, `just fmt`, `just fix -p codex-remote-agent`.

---

## File Structure

- Modify `codex-rs/remote-agent/static/index.html`: replace dashboard-grid markup with desktop app landmarks: setup gate, titlebar, sidebar, session surface, diff drawer, command palette, info panel, disabled composer.
- Modify `codex-rs/remote-agent/static/app.js`: add UI state for drawer/palette/info/history/mobile sidebar; wire every visible control to real behavior; group sessions under workspaces; render mixed chat/system events; keep composer disabled.
- Modify `codex-rs/remote-agent/static/styles.css`: replace light dashboard theme with dark desktop-client shell, compact sidebar rows, chat/event blocks, drawer, modal, responsive mobile sheets.
- Modify `codex-rs/remote-agent/tests/api.rs`: update embedded UI assertions so tests lock in the new shell landmarks and the no-native-menu constraint.
- Modify `codex-rs/remote-agent/README.md`: document the desktop-style UI, command palette, diff drawer, and deterministic backend composer limit.

## Task 1: Lock In Static Shell Landmarks

**Files:**
- Modify: `codex-rs/remote-agent/tests/api.rs`
- Modify: `codex-rs/remote-agent/static/index.html`

- [ ] **Step 1: Write the failing static UI landmark assertions**

In `codex-rs/remote-agent/tests/api.rs`, update `serves_embedded_web_ui` after the asset assertions:

```rust
    assert!(body.contains(r#"class="desktop-shell""#));
    assert!(body.contains(r#"id="setupGate""#));
    assert!(body.contains(r#"id="desktopTitlebar""#));
    assert!(body.contains(r#"id="workspaceSidebar""#));
    assert!(body.contains(r#"id="sessionSurface""#));
    assert!(body.contains(r#"id="diffDrawer""#));
    assert!(body.contains(r#"id="commandPalette""#));
    assert!(body.contains(r#"id="infoPanel""#));
    assert!(body.contains(r#"id="composerStatus""#));
    assert!(!body.contains(">File<"));
    assert!(!body.contains(">Edit<"));
    assert!(!body.contains(">View<"));
    assert!(!body.contains(">Window<"));
    assert!(!body.contains(">Help<"));
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent serves_embedded_web_ui
```

Expected: FAIL because `desktop-shell`, `setupGate`, `desktopTitlebar`, `workspaceSidebar`, `sessionSurface`, `diffDrawer`, `commandPalette`, `infoPanel`, and `composerStatus` are not yet in `index.html`.

- [ ] **Step 3: Replace the HTML shell**

Replace the contents of `codex-rs/remote-agent/static/index.html` body with this structure, preserving the existing `<head>`, stylesheet link, and script tag:

```html
  <body>
    <div class="desktop-shell" id="desktopShell">
      <section class="setup-gate" id="setupGate" aria-labelledby="setupTitle">
        <div class="setup-card">
          <p class="eyebrow">Codex Remote</p>
          <h1 id="setupTitle">Connect to remote agent</h1>
          <p class="setup-copy">Enter the one-time setup token from the server.</p>
          <form id="setupForm" class="setup-form">
            <label for="setupToken">Setup token</label>
            <div class="inline-field">
              <input id="setupToken" name="setupToken" type="password" autocomplete="one-time-code" required>
              <button type="submit">Connect</button>
            </div>
          </form>
          <div class="setup-status" id="setupStatus">Signed out</div>
        </div>
      </section>

      <div class="app-frame" id="appFrame" hidden>
        <header class="desktop-titlebar" id="desktopTitlebar">
          <div class="window-dots" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <nav class="titlebar-controls" aria-label="Session navigation">
            <button type="button" class="icon-button" id="backButton" aria-label="Back">‹</button>
            <button type="button" class="icon-button" id="forwardButton" aria-label="Forward">›</button>
            <button type="button" class="icon-button" id="refreshButton" aria-label="Refresh">↻</button>
          </nav>
          <div class="titlebar-center">
            <div class="titlebar-title" id="activeSessionLabel">No session selected</div>
            <div class="titlebar-subtitle" id="activeWorkspaceLabel">No workspace selected</div>
          </div>
          <div class="titlebar-actions">
            <button type="button" class="titlebar-button" id="mobileSidebarButton">Workspaces</button>
            <button type="button" class="titlebar-button" id="paletteButton">⌘K</button>
            <button type="button" class="titlebar-button" id="diffToggleButton">Diff</button>
            <button type="button" class="titlebar-button" id="infoButton">Info</button>
            <div class="connection" id="connectionStatus">Signed out</div>
          </div>
        </header>

        <div class="desktop-body">
          <aside class="workspace-sidebar" id="workspaceSidebar" aria-label="Workspaces and sessions">
            <div class="sidebar-header">
              <div>
                <p class="eyebrow">Codex Remote</p>
                <h2>Remote Agent</h2>
              </div>
              <button type="button" class="icon-button sidebar-close" id="sidebarCloseButton" aria-label="Close sidebar">×</button>
            </div>
            <div class="sidebar-summary" id="sidebarSummary">Deterministic backend</div>
            <div class="sidebar-actions">
              <button type="button" id="newSessionButton">New session</button>
              <button type="button" id="sidebarPaletteButton">Command Palette</button>
            </div>
            <div class="new-session-card" id="newSessionCard">
              <form id="sessionForm" class="stack">
                <label for="sessionTitle">Session title</label>
                <div class="inline-field">
                  <input id="sessionTitle" name="sessionTitle" type="text" maxlength="200" placeholder="Task title" required>
                  <button type="submit">Start</button>
                </div>
              </form>
            </div>
            <div class="sidebar-section-title">Projects</div>
            <div id="workspaceList" class="project-list empty-state">No workspaces loaded.</div>
            <button type="button" class="connection-details-button" id="sidebarInfoButton">Connection details</button>
          </aside>

          <main class="session-surface" id="sessionSurface">
            <section class="session-scroll" id="eventStream" aria-label="Session events">Select a session to stream events.</section>
            <form id="messageForm" class="composer" aria-label="Message composer">
              <input id="messageInput" name="message" type="text" placeholder="Message sending unavailable in deterministic backend" disabled>
              <button id="messageSend" type="submit" disabled>Send</button>
              <div class="composer-status" id="composerStatus">Message sending unavailable in deterministic backend.</div>
            </form>
          </main>

          <aside class="diff-drawer" id="diffDrawer" aria-label="Workspace diff" aria-hidden="true">
            <div class="drawer-header">
              <div>
                <h2>Diff</h2>
                <div class="muted" id="diffSummary">No workspace selected</div>
              </div>
              <button type="button" class="icon-button" id="diffCloseButton" aria-label="Close diff">×</button>
            </div>
            <div id="diffPanel" class="diff-panel empty-state">Diff summary will appear here.</div>
          </aside>
        </div>
      </div>

      <section class="command-palette" id="commandPalette" hidden aria-modal="true" role="dialog" aria-labelledby="commandPaletteTitle">
        <div class="palette-panel">
          <h2 id="commandPaletteTitle">Command Palette</h2>
          <input id="paletteSearch" type="search" autocomplete="off" placeholder="Search workspaces, sessions, and actions">
          <div id="paletteResults" class="palette-results"></div>
        </div>
      </section>

      <section class="info-panel" id="infoPanel" hidden aria-modal="true" role="dialog" aria-labelledby="infoPanelTitle">
        <div class="info-card">
          <div class="drawer-header">
            <div>
              <h2 id="infoPanelTitle">Connection Info</h2>
              <div class="muted">Real status from the loaded agent state.</div>
            </div>
            <button type="button" class="icon-button" id="infoCloseButton" aria-label="Close info">×</button>
          </div>
          <dl id="infoDetails" class="info-details"></dl>
        </div>
      </section>
    </div>
    <script src="/assets/app.js" defer></script>
  </body>
```

- [ ] **Step 4: Run the targeted test and verify it passes**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent serves_embedded_web_ui
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/codex
git add codex-rs/remote-agent/tests/api.rs codex-rs/remote-agent/static/index.html
git commit -m "Redesign remote agent shell landmarks"
```

## Task 2: Wire App State, Auth Gate, And Real Titlebar Controls

**Files:**
- Modify: `codex-rs/remote-agent/static/app.js`

- [ ] **Step 1: Write the JS syntax check command**

Run:

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
```

Expected: PASS before changes. This is the fast guard for each JS edit.

- [ ] **Step 2: Extend client state and element references**

In `codex-rs/remote-agent/static/app.js`, add these properties to `state`:

```js
  selectedHistory: [],
  selectedHistoryIndex: -1,
  diffOpen: false,
  paletteOpen: false,
  infoOpen: false,
  mobileSidebarOpen: false,
  composerNotice: "",
```

Replace the `elements` object with:

```js
const elements = {
  activeSessionLabel: document.getElementById("activeSessionLabel"),
  activeWorkspaceLabel: document.getElementById("activeWorkspaceLabel"),
  appFrame: document.getElementById("appFrame"),
  backButton: document.getElementById("backButton"),
  commandPalette: document.getElementById("commandPalette"),
  composerStatus: document.getElementById("composerStatus"),
  connectionStatus: document.getElementById("connectionStatus"),
  desktopShell: document.getElementById("desktopShell"),
  diffCloseButton: document.getElementById("diffCloseButton"),
  diffDrawer: document.getElementById("diffDrawer"),
  diffPanel: document.getElementById("diffPanel"),
  diffSummary: document.getElementById("diffSummary"),
  diffToggleButton: document.getElementById("diffToggleButton"),
  eventStream: document.getElementById("eventStream"),
  forwardButton: document.getElementById("forwardButton"),
  infoButton: document.getElementById("infoButton"),
  infoCloseButton: document.getElementById("infoCloseButton"),
  infoDetails: document.getElementById("infoDetails"),
  infoPanel: document.getElementById("infoPanel"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  messageSend: document.getElementById("messageSend"),
  mobileSidebarButton: document.getElementById("mobileSidebarButton"),
  newSessionButton: document.getElementById("newSessionButton"),
  paletteButton: document.getElementById("paletteButton"),
  paletteResults: document.getElementById("paletteResults"),
  paletteSearch: document.getElementById("paletteSearch"),
  refreshButton: document.getElementById("refreshButton"),
  sessionForm: document.getElementById("sessionForm"),
  sessionTitle: document.getElementById("sessionTitle"),
  setupForm: document.getElementById("setupForm"),
  setupGate: document.getElementById("setupGate"),
  setupStatus: document.getElementById("setupStatus"),
  setupToken: document.getElementById("setupToken"),
  sidebarCloseButton: document.getElementById("sidebarCloseButton"),
  sidebarInfoButton: document.getElementById("sidebarInfoButton"),
  sidebarPaletteButton: document.getElementById("sidebarPaletteButton"),
  sidebarSummary: document.getElementById("sidebarSummary"),
  workspaceList: document.getElementById("workspaceList"),
  workspaceSidebar: document.getElementById("workspaceSidebar"),
};
```

- [ ] **Step 3: Add event listeners for real controls**

Replace the existing top-level event listener block with:

```js
elements.setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await setup(elements.setupToken.value);
});

elements.refreshButton.addEventListener("click", () => {
  refreshData();
});

elements.backButton.addEventListener("click", () => {
  moveSelectionHistory(-1);
});

elements.forwardButton.addEventListener("click", () => {
  moveSelectionHistory(1);
});

elements.diffToggleButton.addEventListener("click", () => {
  setDiffOpen(!state.diffOpen);
});

elements.diffCloseButton.addEventListener("click", () => {
  setDiffOpen(false);
});

elements.infoButton.addEventListener("click", () => {
  setInfoOpen(true);
});

elements.sidebarInfoButton.addEventListener("click", () => {
  setInfoOpen(true);
});

elements.infoCloseButton.addEventListener("click", () => {
  setInfoOpen(false);
});

elements.paletteButton.addEventListener("click", () => {
  openCommandPalette();
});

elements.sidebarPaletteButton.addEventListener("click", () => {
  openCommandPalette();
});

elements.mobileSidebarButton.addEventListener("click", () => {
  setMobileSidebarOpen(true);
});

elements.sidebarCloseButton.addEventListener("click", () => {
  setMobileSidebarOpen(false);
});

elements.newSessionButton.addEventListener("click", () => {
  elements.sessionTitle.focus();
});

elements.sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createSession();
});

elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  revealComposerStatus();
});

elements.messageInput.addEventListener("focus", () => {
  revealComposerStatus();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandPalette();
    return;
  }
  if (event.key === "Escape") {
    if (state.paletteOpen) {
      closeCommandPalette();
      return;
    }
    if (state.infoOpen) {
      setInfoOpen(false);
      return;
    }
    if (state.diffOpen) {
      setDiffOpen(false);
      return;
    }
    setMobileSidebarOpen(false);
  }
});
```

- [ ] **Step 4: Add shell rendering helpers**

Add these functions near `renderAuthState`:

```js
function renderAuthState() {
  const connected = Boolean(state.token);
  elements.setupGate.hidden = connected;
  elements.appFrame.hidden = !connected;
  elements.sessionForm.hidden = !connected;
  elements.refreshButton.disabled = !connected;
  elements.paletteButton.disabled = !connected;
  elements.sidebarPaletteButton.disabled = !connected;
  elements.newSessionButton.disabled = !connected;
  renderComposerState();
  renderTitlebar();
  setConnection(connected ? "Connected" : "Signed out", connected ? "connected" : "");
}

function renderTitlebar() {
  const session = selectedSession();
  const workspace = selectedWorkspace();
  elements.activeSessionLabel.textContent = session ? session.title : "No session selected";
  elements.activeWorkspaceLabel.textContent = workspace
    ? `${workspace.displayName} · ${workspace.path}`
    : "No workspace selected";
  elements.sidebarSummary.textContent = state.token
    ? `Deterministic backend · ${state.workspaces.length} workspaces`
    : "Signed out";
  elements.backButton.disabled = state.selectedHistoryIndex <= 0;
  elements.forwardButton.disabled =
    state.selectedHistoryIndex < 0 ||
    state.selectedHistoryIndex >= state.selectedHistory.length - 1;
  elements.diffToggleButton.setAttribute("aria-pressed", String(state.diffOpen));
  elements.desktopShell.classList.toggle("diff-open", state.diffOpen);
  elements.desktopShell.classList.toggle("sidebar-open", state.mobileSidebarOpen);
}

function setConnection(text, mode = "") {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.className = `connection ${mode}`.trim();
  elements.setupStatus.textContent = text;
  elements.setupStatus.className = `setup-status ${mode}`.trim();
}

function setDiffOpen(open) {
  state.diffOpen = open;
  elements.diffDrawer.setAttribute("aria-hidden", String(!open));
  renderTitlebar();
}

function setInfoOpen(open) {
  state.infoOpen = open;
  elements.infoPanel.hidden = !open;
  if (open) {
    renderInfoPanel();
    elements.infoCloseButton.focus();
  }
}

function setMobileSidebarOpen(open) {
  state.mobileSidebarOpen = open;
  renderTitlebar();
}
```

Remove the old `renderAuthState` and `setConnection` definitions after adding the replacement.

- [ ] **Step 5: Add selection history helpers**

Add these functions near `selectSession`:

```js
function pushSelectionHistory(sessionId) {
  if (!sessionId) {
    return;
  }
  if (state.selectedHistory[state.selectedHistoryIndex] === sessionId) {
    return;
  }
  state.selectedHistory = state.selectedHistory.slice(0, state.selectedHistoryIndex + 1);
  state.selectedHistory.push(sessionId);
  state.selectedHistoryIndex = state.selectedHistory.length - 1;
}

function moveSelectionHistory(delta) {
  const nextIndex = state.selectedHistoryIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.selectedHistory.length) {
    return;
  }
  const session = state.sessions.find((item) => item.id === state.selectedHistory[nextIndex]);
  if (!session) {
    return;
  }
  state.selectedHistoryIndex = nextIndex;
  selectSession(session, { recordHistory: false });
}
```

Change `selectSession` signature and first lines to:

```js
async function selectSession(session, options = {}) {
  const generation = ++state.selectionGeneration;
  state.refreshGeneration++;
  state.selectedSessionId = session.id;
  state.selectedWorkspaceId = session.workspaceId;
  if (options.recordHistory !== false) {
    pushSelectionHistory(session.id);
  }
```

In `refreshData`, after selecting a `selectedSession`, add:

```js
      pushSelectionHistory(selectedSession.id);
```

- [ ] **Step 6: Run JS syntax check**

Run:

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/app.js
git commit -m "Wire remote agent desktop shell controls"
```

## Task 3: Render Sidebar Projects And Honest Composer State

**Files:**
- Modify: `codex-rs/remote-agent/static/app.js`

- [ ] **Step 1: Replace composer state logic**

Replace `renderComposerState` with:

```js
function renderComposerState() {
  elements.messageInput.disabled = true;
  elements.messageSend.disabled = true;
  elements.messageInput.placeholder = "Message sending unavailable in deterministic backend";
  elements.composerStatus.textContent =
    state.composerNotice || "Message sending unavailable in deterministic backend.";
}

function revealComposerStatus() {
  state.composerNotice =
    "The current deterministic backend can stream sessions, approvals, and diffs, but it cannot accept chat messages.";
  renderComposerState();
  elements.composerStatus.classList.add("attention");
  setTimeout(() => {
    elements.composerStatus.classList.remove("attention");
  }, 1200);
}
```

- [ ] **Step 2: Add selected item helpers**

Add these helpers near `sortedSessions`:

```js
function selectedWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

function selectedSession() {
  return state.sessions.find((session) => session.id === state.selectedSessionId);
}

function sessionsForWorkspace(workspaceId) {
  return sortedSessions().filter((session) => session.workspaceId === workspaceId);
}
```

- [ ] **Step 3: Replace workspace and session rendering with project groups**

Replace `renderWorkspaces` and `renderSessions` with:

```js
function renderWorkspaces() {
  elements.workspaceList.classList.toggle("empty-state", state.workspaces.length === 0);
  elements.workspaceList.replaceChildren(
    ...state.workspaces.map((workspace) => renderProjectGroup(workspace)),
  );
  if (state.workspaces.length === 0) {
    elements.workspaceList.textContent = "No workspaces configured.";
  }
  renderTitlebar();
}

function renderSessions() {
  renderWorkspaces();
}

function renderProjectGroup(workspace) {
  const group = document.createElement("section");
  group.className = `project-group ${workspace.id === state.selectedWorkspaceId ? "active" : ""}`;

  const header = document.createElement("button");
  header.type = "button";
  header.disabled = Boolean(workspace.error);
  header.className = "project-header";
  header.addEventListener("click", () => {
    selectWorkspace(workspace.id);
  });

  const title = document.createElement("span");
  title.className = "project-title";
  title.textContent = workspace.displayName;

  const badge = document.createElement("span");
  badge.className = `status-pill ${workspace.error ? "failed" : workspace.dirty ? "stale" : "running"}`;
  badge.textContent = workspace.error ? "error" : workspace.dirty ? "dirty" : "ready";

  const meta = document.createElement("span");
  meta.className = "project-meta";
  meta.textContent = [workspace.branch, workspace.path, workspace.error].filter(Boolean).join(" · ");

  header.append(title, badge, meta);
  group.append(header);

  const threads = document.createElement("div");
  threads.className = "thread-list";
  const sessions = sessionsForWorkspace(workspace.id);
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "thread-empty";
    empty.textContent = workspace.error ? "Workspace unavailable" : "No sessions";
    threads.append(empty);
  } else {
    threads.append(...sessions.map((session) => renderThreadRow(session, Boolean(workspace.error))));
  }
  group.append(threads);
  return group;
}

function renderThreadRow(session, workspaceUnavailable) {
  const item = document.createElement("button");
  item.type = "button";
  item.disabled = workspaceUnavailable;
  item.className = `thread-row ${session.id === state.selectedSessionId ? "active" : ""}`;
  item.addEventListener("click", () => {
    selectSession(session);
    setMobileSidebarOpen(false);
  });

  const title = document.createElement("span");
  title.className = "thread-title";
  title.textContent = session.title;

  const status = document.createElement("span");
  status.className = `status-pill ${session.status.toLowerCase()}`;
  status.textContent = splitCamelCase(session.status);

  item.append(title, status);
  return item;
}
```

- [ ] **Step 4: Update workspace selection to keep titlebar current**

At the end of `selectWorkspace`, after `loadDiff(workspaceId);`, add:

```js
  renderTitlebar();
```

In `clearSessionToken`, replace `elements.activeSessionLabel.textContent = "No session selected";` with:

```js
  elements.activeSessionLabel.textContent = "No session selected";
  elements.activeWorkspaceLabel.textContent = "No workspace selected";
  state.selectedHistory = [];
  state.selectedHistoryIndex = -1;
  setDiffOpen(false);
  setInfoOpen(false);
  setMobileSidebarOpen(false);
```

- [ ] **Step 5: Run JS syntax check**

Run:

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/app.js
git commit -m "Render remote agent project sidebar"
```

## Task 4: Render Chat-First Events And Diff Drawer Actions

**Files:**
- Modify: `codex-rs/remote-agent/static/app.js`

- [ ] **Step 1: Replace event rendering**

Replace `renderEvent` and `eventText` with:

```js
function renderEvent(event) {
  switch (event.kind.type) {
    case "sessionCreated":
      return eventBubble("assistant", "Session created.");
    case "statusText":
      return timelineSeparator(event.kind.status);
    case "messageDelta":
      return eventBubble(event.kind.role, event.kind.content);
    case "toolCallStarted":
      return actionBlock("Command started", commandElement(event.kind.command));
    case "toolCallCompleted":
      return timelineSeparator(`Command exited ${event.kind.exitCode}.`);
    case "approvalRequested":
      return approvalBlock(event.kind.approvalId);
    case "approvalDecided":
      return timelineSeparator(event.kind.approved ? "Approval granted." : "Approval denied.");
    case "diffUpdated":
      return diffEventBlock();
    case "errorRaised":
      return eventBubble("error", event.kind.message);
    default:
      return eventBubble("system", JSON.stringify(event.kind));
  }
}

function eventBubble(role, content) {
  const row = document.createElement("article");
  row.className = `chat-row ${role.toLowerCase()}`;

  const label = document.createElement("div");
  label.className = "chat-role";
  label.textContent = splitCamelCase(role);

  const text = document.createElement("div");
  text.className = "chat-text";
  text.textContent = content;

  row.append(label, text);
  return row;
}

function timelineSeparator(text) {
  const row = document.createElement("div");
  row.className = "timeline-separator";
  row.textContent = text;
  return row;
}

function actionBlock(title, content) {
  const row = document.createElement("section");
  row.className = "action-block";
  const heading = document.createElement("div");
  heading.className = "action-title";
  heading.textContent = title;
  row.append(heading, content);
  return row;
}
```

- [ ] **Step 2: Replace approval controls with an action block**

Add this function near `approvalControls`:

```js
function approvalBlock(approvalId) {
  const row = document.createElement("section");
  row.className = "action-block approval-block";

  const heading = document.createElement("div");
  heading.className = "action-title";
  heading.textContent = "Approval requested";

  const body = document.createElement("div");
  body.className = "action-body";
  body.textContent = approvalId;

  row.append(heading, body, approvalControls(approvalId));
  return row;
}
```

Keep `approvalControls`, `approvalButton`, and `submitApproval` because they already call real approval APIs.

- [ ] **Step 3: Add a real diff event action**

Add this function near `renderDiff`:

```js
function diffEventBlock() {
  const row = document.createElement("section");
  row.className = "action-block diff-event";

  const heading = document.createElement("div");
  heading.className = "action-title";
  heading.textContent = "Diff updated";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = "Open Diff";
  button.addEventListener("click", () => {
    setDiffOpen(true);
  });

  row.append(heading, button);
  return row;
}
```

- [ ] **Step 4: Keep diff drawer real during diff loads**

In `loadDiff`, replace direct text updates with state classes:

```js
  elements.diffPanel.className = "diff-panel loading-state";
  elements.diffPanel.textContent = "Loading diff...";
```

In `renderDiff`, start the function with:

```js
  elements.diffPanel.className = "diff-panel";
```

In `renderMissingWorkspaceDiff`, set:

```js
  elements.diffPanel.className = "diff-panel empty-state";
```

- [ ] **Step 5: Run JS syntax check**

Run:

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/app.js
git commit -m "Render remote agent chat event stream"
```

## Task 5: Implement Real Command Palette And Info Panel

**Files:**
- Modify: `codex-rs/remote-agent/static/app.js`

- [ ] **Step 1: Add command palette functions**

Add these functions near the keyboard helpers:

```js
function openCommandPalette() {
  if (!state.token) {
    return;
  }
  state.paletteOpen = true;
  elements.commandPalette.hidden = false;
  elements.paletteSearch.value = "";
  renderPaletteResults();
  elements.paletteSearch.focus();
}

function closeCommandPalette() {
  state.paletteOpen = false;
  elements.commandPalette.hidden = true;
}

function paletteItems() {
  const actions = [
    {
      label: "New session",
      detail: "Focus the session title field",
      run: () => elements.sessionTitle.focus(),
    },
    {
      label: "Refresh remote state",
      detail: "Reload workspaces, sessions, status, and diff",
      run: () => refreshData(),
    },
    {
      label: state.diffOpen ? "Close diff drawer" : "Open diff drawer",
      detail: "Toggle the workspace diff inspector",
      run: () => setDiffOpen(!state.diffOpen),
    },
    {
      label: "Open connection info",
      detail: "Show current agent, workspace, and session details",
      run: () => setInfoOpen(true),
    },
    {
      label: "Reveal composer status",
      detail: "Explain why message sending is disabled",
      run: () => revealComposerStatus(),
    },
  ];

  const workspaces = state.workspaces
    .filter((workspace) => !workspace.error)
    .map((workspace) => ({
      label: workspace.displayName,
      detail: workspace.path,
      run: () => selectWorkspace(workspace.id),
    }));

  const sessions = sortedSessions().map((session) => ({
    label: session.title,
    detail: splitCamelCase(session.status),
    run: () => selectSession(session),
  }));

  return [...actions, ...workspaces, ...sessions];
}

function renderPaletteResults() {
  const query = elements.paletteSearch.value.trim().toLowerCase();
  const items = paletteItems().filter((item) => {
    const haystack = `${item.label} ${item.detail}`.toLowerCase();
    return haystack.includes(query);
  });

  elements.paletteResults.replaceChildren(
    ...items.map((item, index) => renderPaletteItem(item, index === 0)),
  );
  if (items.length === 0) {
    elements.paletteResults.textContent = "No matching real actions.";
  }
}

function renderPaletteItem(item, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `palette-item ${active ? "active" : ""}`;
  button.addEventListener("click", () => {
    closeCommandPalette();
    item.run();
  });

  const label = document.createElement("span");
  label.className = "palette-label";
  label.textContent = item.label;

  const detail = document.createElement("span");
  detail.className = "palette-detail";
  detail.textContent = item.detail;

  button.append(label, detail);
  return button;
}
```

- [ ] **Step 2: Wire palette search and keyboard execution**

Add these event listeners after the top-level palette button listeners:

```js
elements.paletteSearch.addEventListener("input", () => {
  renderPaletteResults();
});

elements.paletteSearch.addEventListener("keydown", (event) => {
  const items = [...elements.paletteResults.querySelectorAll(".palette-item")];
  const activeIndex = items.findIndex((item) => item.classList.contains("active"));
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActivePaletteIndex(items, Math.min(items.length - 1, activeIndex + 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActivePaletteIndex(items, Math.max(0, activeIndex - 1));
  } else if (event.key === "Enter" && activeIndex >= 0) {
    event.preventDefault();
    items[activeIndex].click();
  }
});

function setActivePaletteIndex(items, index) {
  items.forEach((item, itemIndex) => {
    item.classList.toggle("active", itemIndex === index);
  });
}
```

- [ ] **Step 3: Add info panel rendering**

Add this function near `setInfoOpen`:

```js
function renderInfoPanel() {
  const workspace = selectedWorkspace();
  const session = selectedSession();
  const rows = [
    ["Connection", state.token ? "Connected" : "Signed out"],
    ["Backend", "Deterministic"],
    ["Workspaces", String(state.workspaces.length)],
    ["Workspace", workspace ? workspace.displayName : "None"],
    ["Workspace path", workspace ? workspace.path : "None"],
    ["Session", session ? session.title : "None"],
    ["Session status", session ? splitCamelCase(session.status) : "None"],
  ];

  elements.infoDetails.replaceChildren(
    ...rows.flatMap(([key, value]) => {
      const term = document.createElement("dt");
      term.textContent = key;
      const description = document.createElement("dd");
      description.textContent = value;
      return [term, description];
    }),
  );
}
```

- [ ] **Step 4: Run JS syntax check**

Run:

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/app.js
git commit -m "Add remote agent command palette"
```

## Task 6: Apply Dark Desktop Visual System And Responsive Sheets

**Files:**
- Modify: `codex-rs/remote-agent/static/styles.css`

- [ ] **Step 1: Replace the stylesheet**

Replace `codex-rs/remote-agent/static/styles.css` with a dark desktop-client stylesheet that defines these selectors:

```css
:root {
  color-scheme: dark;
  --bg: #090909;
  --titlebar: #111111;
  --sidebar: #171717;
  --surface: #202020;
  --surface-raised: #262626;
  --drawer: #181818;
  --border: #343434;
  --border-soft: #292929;
  --text: #f2f2f2;
  --muted: #a7a7a7;
  --muted-2: #777777;
  --accent: #f2a365;
  --accent-blue: #78a6ff;
  --danger: #ff7777;
  --success: #8bd38b;
  --warning: #f2c66d;
  --code-bg: #303030;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.45;
}

button,
input {
  font: inherit;
}

button {
  min-height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  padding: 0 12px;
  cursor: pointer;
}

button:hover:not(:disabled) {
  border-color: #4a4a4a;
  background: #303030;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

input {
  min-width: 0;
  min-height: 36px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #121212;
  color: var(--text);
  padding: 8px 10px;
}

input:focus {
  outline: 2px solid rgb(120 166 255 / 0.24);
  border-color: var(--accent-blue);
}

.desktop-shell {
  min-height: 100vh;
  overflow: hidden;
}

.setup-gate {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
}

.setup-card,
.info-card,
.palette-panel {
  width: min(520px, 100%);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 20px;
}

.setup-copy,
.muted,
.empty-state {
  color: var(--muted);
}

.app-frame {
  display: grid;
  grid-template-rows: 44px minmax(0, 1fr);
  height: 100vh;
}

.desktop-titlebar {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--titlebar);
  padding: 0 12px;
}

.window-dots {
  display: flex;
  gap: 7px;
}

.window-dots span {
  width: 11px;
  height: 11px;
  border-radius: 999px;
  background: #4a4a4a;
}

.titlebar-controls,
.titlebar-actions,
.sidebar-actions,
.approval-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.icon-button {
  width: 32px;
  min-height: 32px;
  padding: 0;
}

.titlebar-center {
  min-width: 0;
  text-align: center;
}

.titlebar-title,
.titlebar-subtitle,
.thread-title,
.project-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.titlebar-title {
  font-weight: 650;
}

.titlebar-subtitle,
.project-meta,
.palette-detail,
.composer-status {
  color: var(--muted);
  font-size: 12px;
}

.connection,
.setup-status {
  max-width: 220px;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 12px;
}

.connection.connected,
.setup-status.connected {
  color: var(--success);
}

.connection.error,
.setup-status.error {
  color: var(--danger);
}

.desktop-body {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  min-height: 0;
}

.desktop-shell.diff-open .desktop-body {
  grid-template-columns: 300px minmax(0, 1fr) minmax(320px, 420px);
}

.workspace-sidebar,
.diff-drawer {
  min-width: 0;
  border-right: 1px solid var(--border-soft);
  background: var(--sidebar);
  overflow: auto;
  padding: 14px;
}

.diff-drawer {
  display: none;
  border-right: 0;
  border-left: 1px solid var(--border-soft);
  background: var(--drawer);
}

.desktop-shell.diff-open .diff-drawer {
  display: block;
}

.sidebar-header,
.drawer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--muted-2);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  font-size: 24px;
}

h2 {
  margin-bottom: 0;
  font-size: 15px;
}

.sidebar-summary,
.sidebar-actions,
.new-session-card,
.sidebar-section-title,
.connection-details-button {
  margin-top: 14px;
}

.sidebar-section-title {
  color: var(--muted-2);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.stack {
  display: grid;
  gap: 8px;
}

.inline-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.project-list {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.project-group {
  display: grid;
  gap: 4px;
}

.project-header,
.thread-row,
.palette-item {
  width: 100%;
  text-align: left;
}

.project-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 8px;
  min-height: 44px;
}

.project-meta {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
}

.thread-list {
  display: grid;
  gap: 2px;
  padding-left: 10px;
}

.thread-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  border-color: transparent;
  background: transparent;
}

.thread-row.active {
  background: #2f2f2f;
  border-color: #414141;
}

.thread-empty {
  color: var(--muted-2);
  font-size: 12px;
  padding: 6px 10px;
}

.status-pill {
  border-radius: 999px;
  background: var(--code-bg);
  color: var(--muted);
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

.status-pill.running,
.status-pill.completed {
  color: var(--success);
}

.status-pill.waitingforapproval,
.status-pill.stale {
  color: var(--warning);
}

.status-pill.failed {
  color: var(--danger);
}

.session-surface {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  background: var(--surface);
}

.session-scroll {
  min-height: 0;
  overflow: auto;
  padding: 28px min(8vw, 96px);
}

.chat-row,
.action-block {
  width: min(780px, 100%);
  margin: 0 auto 14px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: #242424;
  padding: 12px;
}

.chat-role,
.action-title {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.chat-row.error {
  border-color: rgb(255 119 119 / 0.35);
}

.chat-text,
.action-body,
.diff-file {
  overflow-wrap: anywhere;
}

.timeline-separator {
  width: min(780px, 100%);
  margin: 12px auto;
  color: var(--muted-2);
  font-size: 12px;
  text-align: center;
}

.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  border-top: 1px solid var(--border-soft);
  background: #1b1b1b;
  padding: 12px min(8vw, 96px);
}

.composer-status {
  grid-column: 1 / -1;
}

.composer-status.attention {
  color: var(--accent);
}

.diff-panel {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.diff-file {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  border-bottom: 1px solid var(--border-soft);
  padding: 8px 0;
}

.command,
.diff-path {
  border-radius: 4px;
  background: var(--code-bg);
  color: var(--text);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  padding: 2px 5px;
}

.command-palette,
.info-panel {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: start center;
  background: rgb(0 0 0 / 0.58);
  padding: 12vh 20px 20px;
}

.palette-results {
  display: grid;
  gap: 4px;
  margin-top: 10px;
}

.palette-item {
  display: grid;
  gap: 2px;
}

.palette-item.active {
  border-color: var(--accent-blue);
}

.palette-label {
  font-weight: 650;
}

.info-details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 14px;
  margin: 16px 0 0;
}

.info-details dt {
  color: var(--muted);
}

.info-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.sidebar-close,
#mobileSidebarButton {
  display: none;
}

@media (max-width: 900px) {
  .desktop-titlebar {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .window-dots,
  .titlebar-controls {
    display: none;
  }

  #mobileSidebarButton,
  .sidebar-close {
    display: inline-grid;
  }

  .desktop-body,
  .desktop-shell.diff-open .desktop-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-sidebar {
    position: fixed;
    inset: 44px auto 0 0;
    z-index: 15;
    width: min(86vw, 340px);
    transform: translateX(-100%);
    transition: transform 160ms ease;
  }

  .desktop-shell.sidebar-open .workspace-sidebar {
    transform: translateX(0);
  }

  .diff-drawer {
    position: fixed;
    inset: 44px 0 0;
    z-index: 16;
    display: none;
  }

  .desktop-shell.diff-open .diff-drawer {
    display: block;
  }

  .session-scroll {
    padding: 20px 14px;
  }

  .composer,
  .inline-field {
    grid-template-columns: 1fr;
  }

  .titlebar-actions {
    gap: 6px;
  }

  .connection {
    display: none;
  }
}
```

- [ ] **Step 2: Run a CSS sanity scan for one-note palette drift**

Run:

```bash
cd /root/codex
rg -n "#[0-9a-fA-F]{3,8}|rgb|var\\(--" codex-rs/remote-agent/static/styles.css
```

Expected: Output shows a mostly neutral dark palette with restrained orange and blue accents; no gradient/orb classes exist.

- [ ] **Step 3: Commit**

```bash
cd /root/codex
git add codex-rs/remote-agent/static/styles.css
git commit -m "Restyle remote agent as desktop client"
```

## Task 7: Update Docs And Final Verification

**Files:**
- Modify: `codex-rs/remote-agent/README.md`

- [ ] **Step 1: Update README**

Append this section to `codex-rs/remote-agent/README.md`:

```markdown
## Web UI

The embedded Web UI is a dark desktop-style Codex Remote client. After setup, it shows a left workspace/session sidebar, a central session event stream, an on-demand diff drawer, a real command palette (`Ctrl+K` / `Cmd+K`), and a connection info panel.

The current backend is deterministic. The composer is visible to preserve the desktop-client model, but message sending is disabled and explains that limitation instead of fabricating local user messages.
```

- [ ] **Step 2: Run JavaScript syntax check**

Run:

```bash
cd /root/codex
node --check codex-rs/remote-agent/static/app.js
```

Expected: PASS.

- [ ] **Step 3: Run targeted Rust tests**

Run:

```bash
cd /root/codex/codex-rs
cargo test -p codex-remote-agent
```

Expected: PASS.

- [ ] **Step 4: Format Rust code**

Run:

```bash
cd /root/codex/codex-rs
just fmt
```

Expected: PASS. No Rust formatting changes are expected unless tests were edited.

- [ ] **Step 5: Run scoped fixer**

Run:

```bash
cd /root/codex/codex-rs
just fix -p codex-remote-agent
```

Expected: PASS.

- [ ] **Step 6: Manual smoke test on Tailscale**

Run the agent if it is not already running:

```bash
cd /root/codex/codex-rs
cargo run -p codex-remote-agent -- --bind 100.102.128.28:7680 --state-dir /tmp/codex-remote-agent-ui-test --workspace /root/codex --setup-token change-me
```

Open:

```text
http://100.102.128.28:7680
```

Verify:

- Setup gate accepts `change-me`.
- Left sidebar groups `/root/codex` as a project.
- New session creates a real session row.
- Session events render as chat/system blocks.
- Approval buttons call the existing approval APIs.
- Diff opens and closes from titlebar, event block, and command palette.
- Command palette searches real actions, workspaces, and sessions.
- Info panel shows current connection/workspace/session details.
- Composer remains disabled and explains deterministic backend mode.
- Mobile viewport exposes sidebar and diff as sheets with no text overlap.

- [ ] **Step 7: Commit docs and verification fixes**

```bash
cd /root/codex
git add codex-rs/remote-agent/README.md codex-rs/remote-agent/static/app.js codex-rs/remote-agent/static/styles.css codex-rs/remote-agent/tests/api.rs
git commit -m "Document remote agent desktop UI"
```

## Self-Review

- Spec coverage: Tasks cover the desktop shell, titlebar controls, left project/session sidebar, chat-first mixed event stream, right diff drawer, disabled composer, real command palette, real info panel, dark visual system, responsive sheets, static UI test updates, and README update.
- Scope check: The plan stays within the embedded static UI and existing remote-agent crate. It does not add real Codex execution, native app packaging, multi-user permissions, file editing, or a frontend build pipeline.
- Type consistency: JavaScript state names and element IDs match the HTML in Task 1. Rust test assertions match the same IDs. No API payload shape changes are required.
