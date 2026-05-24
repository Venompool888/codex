import type { ProjectSummary } from "../../../shared";

export function ProjectOptionsPage({ project }: { project: ProjectSummary | null }) {
  return (
    <section className="product-page options-page">
      <h2>项目选项</h2>
      <p className="page-copy">管理当前远端 workspace 的描述、历史与运行边界。</p>
      <div className="settings-list">
        <div className="setting-row">
          <span>Workspace</span>
          <strong>{project?.workspace.cwd ?? "loading"}</strong>
        </div>
        <div className="setting-row">
          <span>项目说明</span>
          <strong>{project?.description ?? "loading"}</strong>
        </div>
        <div className="setting-row">
          <span>环境变量</span>
          <strong>入口预留</strong>
        </div>
        <div className="setting-row">
          <span>任务历史</span>
          <strong>入口预留</strong>
        </div>
        <div className="setting-row danger-row">
          <span>危险操作</span>
          <strong>第一阶段只读</strong>
        </div>
      </div>
    </section>
  );
}
