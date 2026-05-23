import type { ProjectSummary } from "../../../shared";
import type { ProductView } from "../../app/productViews";

const viewLabels: Record<ProductView, string> = {
  chat: "对话",
  tasks: "任务",
  files: "文件变更",
  search: "搜索",
  options: "项目选项",
  settings: "设置",
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
  const views: ProductView[] = ["chat", "tasks", "files", "search", "options", "settings"];
  return (
    <header className="project-header">
      <div className="project-title-block">
        <p>Codex Web</p>
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
