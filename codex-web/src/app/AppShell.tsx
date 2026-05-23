import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../shared";
import { ChatWorkspace } from "../features/chat/ChatWorkspace";
import { CodexSessionProvider } from "../features/chat/CodexSessionContext";
import { FileChangesPage } from "../features/file-changes/FileChangesPage";
import { ProjectOptionsPage } from "../features/project-options/ProjectOptionsPage";
import { fetchProjects } from "../features/projects/projectApi";
import { ProjectHeader } from "../features/projects/ProjectHeader";
import { ProjectList } from "../features/projects/ProjectList";
import { SearchPage } from "../features/search/SearchPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TaskDetail } from "../features/tasks/TaskDetail";
import type { ProductView } from "./productViews";

export function AppShell() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectError, setProjectError] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ProductView>("chat");

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
    <CodexSessionProvider>
      <div className="product-shell">
        <ProjectList
          projects={projects}
          activeProjectId={activeProject?.id ?? null}
          onSelect={projectId => {
            setActiveProjectId(projectId);
            setActiveView("chat");
          }}
        />
        <div className="project-workspace">
          <ProjectHeader project={activeProject} activeView={activeView} onViewChange={setActiveView} />
          {projectError && <div className="project-error">{projectError}</div>}
          <div className="project-view">
            {activeView === "chat" && <ChatWorkspace />}
            {activeView === "tasks" && <TaskDetail />}
            {activeView === "files" && <FileChangesPage />}
            {activeView === "search" && <SearchPage />}
            {activeView === "options" && <ProjectOptionsPage project={activeProject} />}
            {activeView === "settings" && <SettingsPage />}
          </div>
        </div>
      </div>
    </CodexSessionProvider>
  );
}
