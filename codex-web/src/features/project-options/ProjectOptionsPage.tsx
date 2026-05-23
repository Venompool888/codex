import type { ProjectSummary } from "../../../shared";

export function ProjectOptionsPage({ project }: { project: ProjectSummary | null }) {
  return (
    <section className="product-page options-page">
      <h2>项目选项</h2>
      <div className="settings-list">
        <div className="setting-row">
          <span>Workspace</span>
          <strong>{project?.workspace.cwd ?? "loading"}</strong>
        </div>
        <div className="setting-row">
          <span>成员管理</span>
          <strong>预留</strong>
        </div>
        <div className="setting-row">
          <span>环境变量</span>
          <strong>预留</strong>
        </div>
        <div className="setting-row">
          <span>任务历史</span>
          <strong>预留</strong>
        </div>
      </div>
    </section>
  );
}
