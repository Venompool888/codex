import type { ProjectSummary } from "../../../shared";
import type { ProductView } from "../../app/productViews";

export function ProjectList({
  projects,
  activeProjectId,
  activeView,
  onViewChange,
  onNewSession,
  onShowSessions,
  onSelect,
}: {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  activeView: ProductView;
  onViewChange: (view: ProductView) => void;
  onNewSession: () => void;
  onShowSessions: () => void;
  onSelect: (projectId: string) => void;
}) {
  const navItems: Array<{ label: string; hint: string; active: boolean; onClick: () => void }> = [
    { label: "Projects", hint: "⌘", active: activeView === "chat", onClick: () => onViewChange("chat") },
    { label: "Sessions", hint: "◱", active: false, onClick: onShowSessions },
    { label: "Tasks", hint: "▤", active: activeView === "tasks", onClick: () => onViewChange("tasks") },
    { label: "Files", hint: "±", active: activeView === "files", onClick: () => onViewChange("files") },
    { label: "Remote", hint: "◉", active: activeView === "remote", onClick: () => onViewChange("remote") },
  ];

  return (
    <aside className="app-sidebar project-list" aria-label="Codex Remote sidebar">
      <div className="app-sidebar-brand">
        <span className="remote-mark">›_</span>
        <div>
          <strong>Codex Remote</strong>
          <span>远程 CLI 控制工作台</span>
        </div>
      </div>
      <button className="new-session-btn" type="button" onClick={onNewSession}>
        <span aria-hidden="true">＋</span>
        New Session
      </button>
      <nav className="global-nav" aria-label="全局导航">
        {navItems.map(item => (
          <button
            key={item.label}
            className={item.active ? "active" : ""}
            type="button"
            onClick={item.onClick}
          >
            <span>{item.hint}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="project-list-head">
        <span>Projects</span>
        <button className="project-add" type="button" title="添加项目" aria-label="添加项目">+</button>
      </div>
      <div className="project-list-tabs" aria-hidden="true">
        <span className="active">最近访问</span>
        <span>我的项目</span>
        <span>收藏</span>
      </div>
      <div className="project-list-rows">
        {projects.map(project => (
          <button
            key={project.id}
            className={`project-card ${project.id === activeProjectId ? "active" : ""}`}
            type="button"
            onClick={() => onSelect(project.id)}
          >
            <span className="project-card-icon">⌘</span>
            <span className="project-card-main">
              <span className="project-card-title">{project.name}</span>
              <span className="project-card-desc">{project.description}</span>
              <span className="project-card-path">{project.workspace.cwd}</span>
            </span>
            {project.favorite && <span className="project-star" aria-label="已收藏">★</span>}
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <button type="button" onClick={() => onViewChange("remote")}>Remote status</button>
      </div>
    </aside>
  );
}
