import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function isPathInside(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveStaticPath(reqUrl: string | undefined, distClient: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(reqUrl ?? "/", "http://codex-web.local").pathname;
  } catch {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.split(/[\\/]+/).includes("..")) return null;

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const normalized = path.normalize(relative);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;

  const requested = path.resolve(distClient, normalized);
  if (!isPathInside(distClient, requested)) return null;

  const fallback = path.resolve(distClient, "index.html");
  return existsSync(requested) ? requested : fallback;
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, distClient: string, isProd: boolean) {
  if (!isProd) {
    res.writeHead(404);
    res.end("Dev mode");
    return;
  }

  const fp = resolveStaticPath(req.url, distClient);
  if (!fp) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(fp);
  readFile(fp).then(data => {
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
    res.end(data);
  }).catch(() => {
    res.writeHead(404);
    res.end("Not found");
  });
}
