import path from "node:path";
import type { ProjectDetail, ProjectSummary } from "../../shared.js";

export class ProjectRegistry {
  private readonly projects: ProjectDetail[];

  constructor(rootCwd: string) {
    this.projects = [
      {
        id: "codex-web",
        name: "codex-web",
        description: "Codex Web product workspace",
        workspace: {
          cwd: rootCwd,
          label: path.basename(rootCwd),
        },
        updatedAt: Date.now(),
        favorite: true,
        tags: ["web", "react", "codex"],
        defaultView: "chat",
      },
    ];
  }

  list(): ProjectSummary[] {
    return this.projects.map(({ defaultView: _defaultView, ...summary }) => summary);
  }

  get(id: string): ProjectDetail | null {
    return this.projects.find(project => project.id === id) ?? null;
  }
}
