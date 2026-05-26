const storageKey = "codexRemoteSessionToken";
const maxEvents = 500;

const state = {
  token: localStorage.getItem(storageKey) || "",
  workspaces: [],
  sessions: [],
  selectedWorkspaceId: "",
  selectedSessionId: "",
  events: [],
  approvals: new Map(),
  eventSource: null,
  diffRequestId: 0,
  refreshGeneration: 0,
  selectionGeneration: 0,
};

const elements = {
  activeSessionLabel: document.getElementById("activeSessionLabel"),
  authPanel: document.getElementById("authPanel"),
  connectionStatus: document.getElementById("connectionStatus"),
  diffPanel: document.getElementById("diffPanel"),
  diffSummary: document.getElementById("diffSummary"),
  eventStream: document.getElementById("eventStream"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  messageSend: document.getElementById("messageSend"),
  refreshButton: document.getElementById("refreshButton"),
  sessionForm: document.getElementById("sessionForm"),
  sessionList: document.getElementById("sessionList"),
  sessionTitle: document.getElementById("sessionTitle"),
  setupForm: document.getElementById("setupForm"),
  setupToken: document.getElementById("setupToken"),
  workspaceList: document.getElementById("workspaceList"),
};

elements.setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await setup(elements.setupToken.value);
});

elements.refreshButton.addEventListener("click", () => {
  refreshData();
});

elements.sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createSession();
});

elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.token || !state.selectedSessionId) {
    setConnection("Select a session before sending.", "error");
    renderComposerState();
    return;
  }
  setConnection("Message sending is not available in this backend yet.", "error");
});

bootstrap();

async function bootstrap() {
  renderAuthState();
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
    if (!state.selectedWorkspaceId && workspaces.length > 0) {
      state.selectedWorkspaceId = workspaces[0].id;
    }
    const sorted = sortedSessions();
    const selectedSession =
      sorted.find((session) => session.id === state.selectedSessionId) || sorted[0];
    if (selectedSession) {
      state.selectedSessionId = selectedSession.id;
      state.selectedWorkspaceId = selectedSession.workspaceId;
    }
    renderWorkspaces();
    renderSessions();
    renderComposerState();
    setConnection("Connected", "connected");
    if (state.selectedWorkspaceId && workspaceExists(state.selectedWorkspaceId)) {
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
  if (!title || !state.selectedWorkspaceId) {
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
    elements.diffPanel.textContent = error.message;
    return false;
  }
}

async function selectSession(session) {
  const generation = ++state.selectionGeneration;
  state.refreshGeneration++;
  state.selectedSessionId = session.id;
  state.selectedWorkspaceId = session.workspaceId;
  renderWorkspaces();
  renderSessions();
  renderComposerState();
  if (workspaceExists(session.workspaceId)) {
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
  state.refreshGeneration++;
  state.selectedWorkspaceId = workspaceId;
  renderWorkspaces();
  loadDiff(workspaceId);
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
  elements.sessionTitle.value = "";
  elements.messageInput.value = "";
  elements.activeSessionLabel.textContent = "No session selected";
  elements.diffSummary.textContent = "No workspace selected";
  elements.diffPanel.classList.add("empty-state");
  elements.diffPanel.textContent = "Diff summary will appear here.";
  renderWorkspaces();
  renderSessions();
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
  elements.authPanel.hidden = Boolean(state.token);
  elements.sessionForm.hidden = !state.token;
  elements.refreshButton.disabled = !state.token;
  renderComposerState();
  setConnection(state.token ? "Connected" : "Signed out", state.token ? "connected" : "");
}

function renderComposerState() {
  const enabled = Boolean(state.token && state.selectedSessionId);
  elements.messageInput.disabled = !enabled;
  elements.messageSend.disabled = !enabled;
}

function renderWorkspaces() {
  elements.workspaceList.classList.toggle("empty-state", state.workspaces.length === 0);
  elements.workspaceList.replaceChildren(
    ...state.workspaces.map((workspace) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `item ${workspace.id === state.selectedWorkspaceId ? "active" : ""}`;
      item.addEventListener("click", () => {
        selectWorkspace(workspace.id);
      });

      const title = document.createElement("div");
      title.className = "item-title";
      title.append(itemTitleText(workspace.displayName));
      if (workspace.dirty) {
        const dirty = document.createElement("span");
        dirty.className = "status-pill stale";
        dirty.textContent = "dirty";
        title.append(dirty);
      }

      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.textContent = [workspace.branch, workspace.path].filter(Boolean).join(" - ");
      item.append(title, meta);
      return item;
    }),
  );
  if (state.workspaces.length === 0) {
    elements.workspaceList.textContent = "No workspaces configured.";
  }
}

function renderSessions() {
  const sessions = sortedSessions();
  elements.sessionList.classList.toggle("empty-state", sessions.length === 0);
  elements.sessionList.replaceChildren(
    ...sessions.map((session) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `item ${session.id === state.selectedSessionId ? "active" : ""}`;
      item.addEventListener("click", () => {
        selectSession(session);
      });

      const title = document.createElement("div");
      title.className = "item-title";
      title.append(itemTitleText(session.title));

      const status = document.createElement("span");
      status.className = `status-pill ${session.status.toLowerCase()}`;
      status.textContent = splitCamelCase(session.status);
      title.append(status);

      const workspace = state.workspaces.find((item) => item.id === session.workspaceId);
      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.textContent = workspace ? workspace.displayName : session.workspaceId;
      item.append(title, meta);
      return item;
    }),
  );
  if (sessions.length === 0) {
    elements.sessionList.textContent = "No sessions yet.";
  }
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
  const row = document.createElement("div");
  row.className = "event";

  const type = document.createElement("div");
  type.className = "event-type";
  type.textContent = splitCamelCase(event.kind.type);

  const text = document.createElement("div");
  text.className = "event-text";
  text.append(eventText(event.kind));

  row.append(type, text);
  if (event.kind.type === "approvalRequested") {
    row.append(approvalControls(event.kind.approvalId));
  }
  return row;
}

function eventText(kind) {
  switch (kind.type) {
    case "sessionCreated":
      return "Session created.";
    case "statusText":
      return kind.status;
    case "messageDelta":
      return `${kind.role}: ${kind.content}`;
    case "toolCallStarted":
      return commandElement(kind.command);
    case "toolCallCompleted":
      return `Command exited ${kind.exitCode}.`;
    case "approvalRequested":
      return `Approval requested: ${kind.approvalId}`;
    case "approvalDecided":
      return kind.approved ? "Approval granted." : "Approval denied.";
    case "diffUpdated":
      return "Diff updated.";
    case "errorRaised":
      return kind.message;
    default:
      return JSON.stringify(kind);
  }
}

function renderDiff(diff) {
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

function itemTitleText(text) {
  const span = document.createElement("span");
  span.className = "item-title-text";
  span.textContent = text;
  return span;
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
  if (workspaceId && workspaceId === state.selectedWorkspaceId && workspaceExists(workspaceId)) {
    loadDiff(workspaceId);
  } else if (workspaceId) {
    return;
  }
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

function selectedSessionWorkspaceId() {
  return (
    state.sessions.find((session) => session.id === state.selectedSessionId)?.workspaceId ||
    state.selectedWorkspaceId
  );
}

function workspaceExists(workspaceId) {
  return state.workspaces.some((workspace) => workspace.id === workspaceId);
}

function renderMissingWorkspaceDiff(workspaceId) {
  elements.diffSummary.textContent = workspaceId;
  elements.diffPanel.classList.add("empty-state");
  elements.diffPanel.textContent = "Session workspace is not available.";
}

function splitCamelCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function setConnection(text, mode = "") {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.className = `connection ${mode}`.trim();
}
