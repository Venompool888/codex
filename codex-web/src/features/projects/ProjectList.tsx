import type { ProjectSummary } from "../../../shared";

export function ProjectList({
  projects,
  activeProjectId,
  onSelect,
}: {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  onSelect: (projectId: string) => void;
}) {
  return (
    <section className="project-list" aria-label="项目列表">
      <div className="project-list-head">
        <span>项目</span>
        <button className="project-add" type="button" title="添加项目" aria-label="添加项目">+</button>
      </div>
      <div className="project-search" aria-label="搜索项目">搜索项目...</div>
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
    </section>
  );
}
