import type { ProjectSummary } from "../../../shared";

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch("/api/projects");
  if (!response.ok) throw new Error(`Failed to load projects: ${response.status}`);
  const body = await response.json() as { projects?: ProjectSummary[] };
  return body.projects ?? [];
}
