const storageKey = "codexRemoteSessionToken";
const maxEvents = 500;

const state = {
  token: localStorage.getItem(storageKey) || "",
  workspaces: [],
  sessions: [],
  selectedWorkspaceId: "",
  selectedSessionId: "",
  selectedHistory: [],
  selectedHistoryIndex: -1,
  events: [],
  approvals: new Map(),
  eventSource: null,
  diffRequestId: 0,
  refreshGeneration: 0,
  selectionGeneration: 0,
  diffOpen: false,
  paletteOpen: false,
  infoOpen: false,
  mobileSidebarOpen: false,
  composerNotice: "",
};

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

bootstrap();

async function bootstrap() {
  renderAuthState();
  renderWorkspaces();
  renderEvents();
  if (state.token) {
    await refreshData();
  }
}

async function setup(setupToken) {
  setConnection("Connecting...");
  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken }),
    });
    if (!response.ok) {
      throw new Error(`Setup failed with ${response.status}`);
    }
    const body = await response.json();
    state.token = body.sessionToken;
    localStorage.setItem(storageKey, state.token);
    elements.setupToken.value = "";
    renderAuthState();
    await refreshData();
  } catch (error) {
    setConnection(error.message, "error");
  }
}

async function refreshData() {
  if (!state.token) {
    setConnection("Signed out");
    return;
  }

  const generation = ++state.refreshGeneration;
  const token = state.token;
  state.diffRequestId++;
  setConnection("Loading...");
  try {
    const [workspaces, sessions] = await Promise.all([
      apiJson("/api/workspaces", {}, token),
      apiJson("/api/sessions", {}, token),
    ]);
    if (state.refreshGeneration !== generation) {
      return;
    }
    state.workspaces = workspaces;
    state.sessions = sessions;
    if (
      state.selectedWorkspaceId &&
      !workspaceExists(state.selectedWorkspaceId)
    ) {
      state.selectedWorkspaceId = "";
    }
    if (!state.selectedWorkspaceId) {
      state.selectedWorkspaceId = firstAvailableWorkspace()?.id || "";
    }
    const sorted = sortedSessions();
    const selectedSession =
      sorted.find((session) => session.id === state.selectedSessionId) || sorted[0];
    if (selectedSession) {
      state.selectedSessionId = selectedSession.id;
      state.selectedWorkspaceId = selectedSession.workspaceId;
      pushSelectionHistory(selectedSession.id);
    }
    renderWorkspaces();
    renderComposerState();
    setConnection("Connected", "connected");
    if (state.selectedWorkspaceId && workspaceAvailable(state.selectedWorkspaceId)) {
      await loadDiff(state.selectedWorkspaceId);
    } else if (state.selectedWorkspaceId) {
      renderMissingWorkspaceDiff(state.selectedWorkspaceId);
    }
    if (
      selectedSession &&
      state.refreshGeneration === generation &&
      state.token === token &&
      state.selectedSessionId === selectedSession.id
    ) {
      connectEvents(selectedSession.id);
    }
    renderTitlebar();
  } catch (error) {
    if (state.refreshGeneration !== generation) {
      return;
    }
    if (handleAuthError(error, token)) {
      return;
    }
    setConnection(error.message, "error");
  }
}

async function createSession() {
  const title = elements.sessionTitle.value.trim();
  if (!title) {
    return;
  }
  if (!workspaceAvailable(state.selectedWorkspaceId)) {
    setConnection("Select an available workspace before starting a session.", "error");
    return;
  }

  const token = state.token;
  const workspaceId = state.selectedWorkspaceId;
  try {
    const session = await apiJson(
      "/api/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          title,
        }),
      },
      token,
    );
    if (state.token !== token || state.selectedWorkspaceId !== workspaceId) {
      return;
    }
    elements.sessionTitle.value = "";
    state.sessions = [session, ...state.sessions.filter((item) => item.id !== session.id)];
    await selectSession(session);
  } catch (error) {
    if (handleAuthError(error, token)) {
      return;
    }
    setConnection(error.message, "error");
  }
}

async function loadDiff(workspaceId) {
  const requestId = ++state.diffRequestId;
  const token = state.token;
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  elements.diffSummary.textContent = workspace ? workspace.displayName : "No workspace selected";
  if (workspace?.error) {
    elements.diffPanel.className = "diff-panel empty-state";
    elements.diffPanel.textContent = workspace.error;
    return false;
  }
  elements.diffPanel.className = "diff-panel loading-state";
  elements.diffPanel.textContent = "Loading diff...";

  try {
    const diff = await apiJson(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/diff`,
      {},
      token,
    );
    if (!isCurrentDiffRequest(workspaceId, requestId, token)) {
      return false;
    }
    renderDiff(diff);
    return true;
  } catch (error) {
    if (!isCurrentDiffRequest(workspaceId, requestId, token)) {
      return false;
    }
    if (handleAuthError(error, token)) {
      return false;
    }
    elements.diffPanel.className = "diff-panel empty-state";
    elements.diffPanel.textContent = error.message;
    return false;
  }
}

async function selectSession(session, options = {}) {
  const generation = ++state.selectionGeneration;
  state.refreshGeneration++;
  state.selectedSessionId = session.id;
  state.selectedWorkspaceId = session.workspaceId;
  if (options.recordHistory !== false) {
    pushSelectionHistory(session.id);
  }
  renderWorkspaces();
  renderComposerState();
  renderTitlebar();
  if (workspaceAvailable(session.workspaceId)) {
    await loadDiff(session.workspaceId);
  } else {
    renderMissingWorkspaceDiff(session.workspaceId);
  }
  if (
    state.selectionGeneration !== generation ||
    state.selectedSessionId !== session.id ||
    !state.token
  ) {
    return;
  }
  connectEvents(session.id);
}

function selectWorkspace(workspaceId) {
  if (!workspaceAvailable(workspaceId)) {
    return;
  }
  state.refreshGeneration++;
  state.selectedWorkspaceId = workspaceId;
  renderWorkspaces();
  loadDiff(workspaceId);
  renderTitlebar();
}

function connectEvents(sessionId) {
  const previousSource = state.eventSource;
  state.eventSource = null;
  if (previousSource) {
    previousSource.close();
  }

  const session = state.sessions.find((item) => item.id === sessionId);
  const token = state.token;
  state.selectedSessionId = sessionId;
  state.events = [];
  state.approvals.clear();
  elements.activeSessionLabel.textContent = session ? session.title : sessionId;
  renderComposerState();
  renderEvents();
  renderTitlebar();

  const url = `/api/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(
    token,
  )}`;
  // Native EventSource cannot send Authorization headers, so the API accepts
  // the session token as a query parameter for this stream.
  const source = new EventSource(url);
  state.eventSource = source;
  source.onopen = () => {
    if (isCurrentEventSource(source, sessionId, token)) {
      setConnection("Connected", "connected");
    }
  };
  source.onmessage = (event) => {
    if (!isCurrentEventSource(source, sessionId, token)) {
      return;
    }
    let sessionEvent;
    try {
      sessionEvent = JSON.parse(event.data);
    } catch (error) {
      appendStreamError(sessionId, `Invalid event payload: ${error.message}`);
      return;
    }
    if (sessionEvent.sessionId !== sessionId) {
      return;
    }
    appendSessionEvent(sessionEvent, sessionId);
  };
  source.addEventListener("error", (event) => {
    if (!isCurrentEventSource(source, sessionId, token)) {
      return;
    }
    if (typeof event.data !== "string") {
      setConnection("Reconnecting...", "error");
      return;
    }
    appendStreamError(sessionId, event.data);
    setConnection("Stream disconnected", "error");
    if (state.eventSource === source) {
      state.eventSource = null;
    }
    source.close();
  });
}

async function apiJson(path, options = {}, token = state.token) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw apiError(path, response.status);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function apiError(path, status) {
  const error = new Error(`${path} returned ${status}`);
  error.path = path;
  error.status = status;
  return error;
}

function clearSessionToken() {
  localStorage.removeItem(storageKey);
  state.token = "";
  state.refreshGeneration++;
  state.selectionGeneration++;
  state.diffRequestId++;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.workspaces = [];
  state.sessions = [];
  state.events = [];
  state.approvals.clear();
  state.selectedWorkspaceId = "";
  state.selectedSessionId = "";
  state.selectedHistory = [];
  state.selectedHistoryIndex = -1;
  state.composerNotice = "";
  elements.sessionTitle.value = "";
  elements.messageInput.value = "";
  elements.activeSessionLabel.textContent = "No session selected";
  elements.activeWorkspaceLabel.textContent = "No workspace selected";
  elements.diffSummary.textContent = "No workspace selected";
  elements.diffPanel.className = "diff-panel empty-state";
  elements.diffPanel.textContent = "Diff summary will appear here.";
  setDiffOpen(false);
  setInfoOpen(false);
  setMobileSidebarOpen(false);
  renderWorkspaces();
  renderEvents();
  renderAuthState();
}

function handleAuthError(error, token) {
  if (error.status === 401 && state.token === token) {
    clearSessionToken();
    return true;
  }
  return false;
}

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

function renderEvents() {
  elements.eventStream.classList.toggle("empty-state", state.events.length === 0);
  if (state.events.length === 0) {
    elements.eventStream.textContent = state.selectedSessionId
      ? "Waiting for events..."
      : "Select a session to stream events.";
    return;
  }

  elements.eventStream.replaceChildren(...state.events.map(renderEvent));
  elements.eventStream.scrollTop = elements.eventStream.scrollHeight;
}

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

function renderDiff(diff) {
  elements.diffPanel.className = "diff-panel";
  elements.diffSummary.textContent = `${diff.files.length} files, +${diff.additions} -${diff.deletions}`;
  elements.diffPanel.classList.toggle("empty-state", diff.files.length === 0);
  if (diff.files.length === 0) {
    elements.diffPanel.textContent = "No workspace changes.";
    return;
  }

  elements.diffPanel.replaceChildren(
    ...diff.files.map((file) => {
      const row = document.createElement("div");
      row.className = "diff-file";

      const path = document.createElement("span");
      path.className = "diff-path";
      path.textContent = `${file.status} ${file.path}`;

      const stats = document.createElement("span");
      stats.className = "muted";
      stats.textContent = `+${file.additions} -${file.deletions}`;

      row.append(path, stats);
      return row;
    }),
  );
}

function commandElement(command) {
  const code = document.createElement("span");
  code.className = "command";
  code.textContent = command;
  return code;
}

function approvalControls(approvalId) {
  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const approval = state.approvals.get(approvalId);
  if (approval?.status === "decided") {
    const result = document.createElement("span");
    result.className = "approval-result";
    result.textContent = approval.approved ? "Approved" : "Denied";
    actions.append(result);
    return actions;
  }

  const isSubmitting = approval?.status === "submitting";
  actions.append(
    approvalButton("Approve", approvalId, true, isSubmitting),
    approvalButton("Deny", approvalId, false, isSubmitting),
  );
  return actions;
}

function approvalButton(label, approvalId, approved, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `approval-button ${approved ? "approve" : "deny"}`;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => {
    submitApproval(approvalId, approved);
  });
  return button;
}

async function submitApproval(approvalId, approved) {
  const approval = state.approvals.get(approvalId);
  if (approval?.status !== "pending") {
    return;
  }

  const token = state.token;
  const sessionId = state.selectedSessionId;
  state.approvals.set(approvalId, { status: "submitting" });
  renderEvents();
  try {
    const decision = approved ? "approve" : "deny";
    await apiJson(
      `/api/approvals/${encodeURIComponent(approvalId)}/${decision}`,
      {
        method: "POST",
        body: "{}",
      },
      token,
    );
    if (
      state.token === token &&
      state.selectedSessionId === sessionId &&
      state.approvals.get(approvalId)?.status === "submitting"
    ) {
      state.approvals.set(approvalId, { status: "decided", approved });
      renderEvents();
    }
  } catch (error) {
    if (handleAuthError(error, token)) {
      return;
    }
    if (state.token !== token || state.selectedSessionId !== sessionId) {
      return;
    }
    if (state.approvals.get(approvalId)?.status === "submitting") {
      state.approvals.set(approvalId, { status: "pending" });
      renderEvents();
      appendStreamError(sessionId, error.message);
    }
  }
}

function appendSessionEvent(event, sessionId) {
  updateApprovalState(event.kind);
  state.events.push(event);
  trimEvents();
  renderEvents();
  if (event.kind.type === "diffUpdated") {
    refreshSessionDiff(sessionId);
  }
}

function appendStreamError(sessionId, message) {
  state.events.push({
    id: `stream-error-${Date.now()}`,
    sessionId,
    kind: { type: "errorRaised", message },
  });
  trimEvents();
  renderEvents();
}

function updateApprovalState(kind) {
  switch (kind.type) {
    case "approvalRequested":
      if (state.approvals.get(kind.approvalId)?.status !== "decided") {
        state.approvals.set(kind.approvalId, { status: "pending" });
      }
      break;
    case "approvalDecided":
      state.approvals.set(kind.approvalId, {
        status: "decided",
        approved: kind.approved,
      });
      break;
    default:
      break;
  }
}

function trimEvents() {
  if (state.events.length > maxEvents) {
    state.events.splice(0, state.events.length - maxEvents);
  }
}

function refreshSessionDiff(sessionId) {
  if (state.selectedSessionId !== sessionId) {
    return;
  }
  const workspaceId = selectedSessionWorkspaceId();
  if (workspaceId && workspaceId === state.selectedWorkspaceId && workspaceAvailable(workspaceId)) {
    loadDiff(workspaceId);
  }
}

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
  if (workspaceAvailable(state.selectedWorkspaceId)) {
    actions.unshift({
      label: "New session",
      detail: "Focus the session title field",
      run: () => elements.sessionTitle.focus(),
    });
  }

  const workspaces = state.workspaces
    .filter((workspace) => !workspace.error)
    .map((workspace) => ({
      label: workspace.displayName,
      detail: workspace.path,
      run: () => selectWorkspace(workspace.id),
    }));

  const sessions = sortedSessions()
    .filter((session) => workspaceAvailable(session.workspaceId))
    .map((session) => ({
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

function setActivePaletteIndex(items, index) {
  items.forEach((item, itemIndex) => {
    item.classList.toggle("active", itemIndex === index);
  });
}

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

function isCurrentEventSource(source, sessionId, token) {
  return state.eventSource === source && state.selectedSessionId === sessionId && state.token === token;
}

function isCurrentDiffRequest(workspaceId, requestId, token) {
  return (
    Boolean(state.token) &&
    state.token === token &&
    state.selectedWorkspaceId === workspaceId &&
    state.diffRequestId === requestId
  );
}

function sortedSessions() {
  return [...state.sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

function sessionsForWorkspace(workspaceId) {
  return sortedSessions().filter((session) => session.workspaceId === workspaceId);
}

function selectedWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

function selectedSession() {
  return state.sessions.find((session) => session.id === state.selectedSessionId);
}

function selectedSessionWorkspaceId() {
  return (
    state.sessions.find((session) => session.id === state.selectedSessionId)?.workspaceId ||
    state.selectedWorkspaceId
  );
}

function workspaceExists(workspaceId) {
  return state.workspaces.some((workspace) => workspace.id === workspaceId);
}

function workspaceAvailable(workspaceId) {
  return state.workspaces.some((workspace) => workspace.id === workspaceId && !workspace.error);
}

function firstAvailableWorkspace() {
  return state.workspaces.find((workspace) => !workspace.error);
}

function renderMissingWorkspaceDiff(workspaceId) {
  elements.diffSummary.textContent = workspaceId;
  elements.diffPanel.className = "diff-panel empty-state";
  elements.diffPanel.textContent = "Session workspace is not available.";
}

function splitCamelCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}
