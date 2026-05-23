import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRegistry } from "./projectRegistry.js";

function writeJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function handleApiRequest(req: IncomingMessage, res: ServerResponse, projects: ProjectRegistry): boolean {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://codex-web.local").pathname;
  } catch {
    writeJson(res, 400, { error: "Bad request" });
    return true;
  }

  if (!pathname.startsWith("/api/")) return false;

  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (pathname === "/api/projects") {
    writeJson(res, 200, { projects: projects.list() });
    return true;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const project = projects.get(decodeURIComponent(projectMatch[1]));
    if (!project) {
      writeJson(res, 404, { error: "Project not found" });
      return true;
    }
    writeJson(res, 200, { project });
    return true;
  }

  writeJson(res, 404, { error: "Not found" });
  return true;
}
