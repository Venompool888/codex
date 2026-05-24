import { useEffect, useMemo, useState } from "react";
import type { CommandExecutionItem, FileChangeItem, ProjectSummary } from "../../shared";
import { ChatWorkspace } from "../features/chat/ChatWorkspace";
import { CodexSessionProvider, useCodexSession } from "../features/chat/CodexSessionContext";
import { FileChangesPage } from "../features/file-changes/FileChangesPage";
import { ProjectOptionsPage } from "../features/project-options/ProjectOptionsPage";
import { fetchProjects } from "../features/projects/projectApi";
import { ProjectHeader } from "../features/projects/ProjectHeader";
import { ProjectList } from "../features/projects/ProjectList";
import { RemoteStatusPage } from "../features/remote/RemoteStatusPage";
import { TaskDetail } from "../features/tasks/TaskDetail";
import type { ProductView } from "./productViews";

export function AppShell() {
  return (
    <CodexSessionProvider>
      <CodexRemoteShell />
    </CodexSessionProvider>
  );
}

function CodexRemoteShell() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectError, setProjectError] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ProductView>("chat");
  const { newThread, listThreads } = useCodexSession();

  useEffect(() => {
    fetchProjects()
      .then(nextProjects => {
        setProjects(nextProjects);
        setActiveProjectId(current => current ?? nextProjects[0]?.id ?? null);
      })
      .catch(error => setProjectError(error instanceof Error ? error.message : String(error)));
  }, []);

  const activeProject = useMemo(
    () => projects.find(project => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );

  return (
    <div className="product-shell desktop-shell">
      <ProjectList
        projects={projects}
        activeProjectId={activeProject?.id ?? null}
        activeView={activeView}
        onViewChange={setActiveView}
        onNewSession={() => {
          newThread();
          setActiveView("chat");
        }}
        onShowSessions={() => {
          listThreads();
          setActiveView("chat");
        }}
        onSelect={projectId => {
          setActiveProjectId(projectId);
          setActiveView("chat");
        }}
      />
      <main className="app-main">
        <ProjectHeader project={activeProject} activeView={activeView} onViewChange={setActiveView} />
        {projectError && <div className="project-error">{projectError}</div>}
        <div className="project-view">
          {activeView === "chat" && <ChatWorkspace />}
          {activeView === "tasks" && <TaskDetail />}
          {activeView === "files" && <FileChangesPage />}
          {activeView === "options" && <ProjectOptionsPage project={activeProject} />}
          {activeView === "remote" && <RemoteStatusPage />}
        </div>
      </main>
      <RunInspector project={activeProject} activeView={activeView} onViewChange={setActiveView} />
    </div>
  );
}

function RunInspector({
  project,
  activeView,
  onViewChange,
}: {
  project: ProjectSummary | null;
  activeView: ProductView;
  onViewChange: (view: ProductView) => void;
}) {
  const { connectionStatus, cwd, model, effort, threadId, thinking, entries } = useCodexSession();
  const commands = entries.flatMap(entry => {
    if (entry.kind !== "turn") return [];
    return entry.itemOrder
      .map(id => entry.items.get(id))
      .filter((item): item is CommandExecutionItem => item?.type === "commandExecution");
  });
  const fileChangeItems = entries.flatMap(entry => {
    if (entry.kind !== "turn") return [];
    return entry.itemOrder
      .map(id => entry.items.get(id))
      .filter((item): item is FileChangeItem => item?.type === "fileChange");
  });
  const fileChanges = fileChangeItems.flatMap(item => item.changes);
  const latestCommand = commands.at(-1);
  const latestOutput = latestCommand?.aggregatedOutput.trim().split("\n").slice(-2).join("\n");
  const changedCount = fileChanges.length;

  const statusLabel = connectionStatus === "connected"
    ? thinking ? "Running" : "Ready"
    : connectionStatus === "failed" ? "Offline" : "Connecting";

  return (
    <aside className="app-inspector" role="complementary" aria-label="运行摘要">
      <section className="inspector-section">
        <div className="inspector-heading">
          <span>Progress</span>
          <button type="button" onClick={() => onViewChange("tasks")} className="inspector-link">›</button>
        </div>
        <div className="progress-row">
          <span className={`progress-dot s-${connectionStatus}`} />
          <div>
            <strong>{statusLabel}</strong>
            <span>{project?.name ?? "No project selected"}</span>
          </div>
        </div>
        <div className="inspector-meta">
          <span>Session</span>
          <strong>{threadId ? `#${threadId.slice(0, 8)}` : "pending"}</strong>
        </div>
        <div className="inspector-meta">
          <span>Model</span>
          <strong>{model || "loading"} · {effort}</strong>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading">
          <span>Outputs</span>
          <button type="button" onClick={() => onViewChange("files")} className="inspector-link">›</button>
        </div>
        <button
          className={`output-row ${activeView === "tasks" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("tasks")}
        >
          <span className="output-icon">▣</span>
          <span>
            <strong>Task detail</strong>
            <small>{latestCommand?.command || "No command yet"}</small>
          </span>
        </button>
        <button
          className={`output-row ${activeView === "files" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("files")}
        >
          <span className="output-icon">±</span>
          <span>
            <strong>File changes</strong>
            <small>{changedCount} changed files</small>
          </span>
        </button>
        <button
          className={`output-row ${activeView === "remote" ? "active" : ""}`}
          type="button"
          onClick={() => onViewChange("remote")}
        >
          <span className="output-icon">◉</span>
          <span>
            <strong>Remote status</strong>
            <small>{cwd || "loading workspace"}</small>
          </span>
        </button>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading">
          <span>Latest</span>
        </div>
        <pre className="inspector-log">{latestOutput || "Session activity will appear here."}</pre>
      </section>
    </aside>
  );
}
