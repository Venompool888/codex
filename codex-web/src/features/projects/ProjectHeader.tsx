import type { ProjectSummary } from "../../../shared";
import type { ProductView } from "../../app/productViews";

const viewLabels: Record<ProductView, string> = {
  chat: "对话",
  tasks: "任务",
  files: "文件变更",
  options: "项目选项",
  remote: "Remote",
};

export function ProjectHeader({
  project,
  activeView,
  onViewChange,
}: {
  project: ProjectSummary | null;
  activeView: ProductView;
  onViewChange: (view: ProductView) => void;
}) {
  const views: ProductView[] = ["chat", "tasks", "files", "options", "remote"];
  return (
    <header className="project-header">
      <div className="project-title-block">
        <p>Codex Remote · 远程 CLI 控制工作台</p>
        <h1>{project?.name ?? "codex-web"}</h1>
        <span>{project?.workspace.cwd ?? "Loading workspace"}</span>
      </div>
      <nav className="project-tabs" aria-label="项目导航">
        {views.map(view => (
          <button
            key={view}
            className={activeView === view ? "active" : ""}
            type="button"
            onClick={() => onViewChange(view)}
          >
            {viewLabels[view]}
          </button>
        ))}
      </nav>
    </header>
  );
}
