import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

function getHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function hostNameFromHeader(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = getHeaderValue(req.headers.origin);
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const requestHost = getHeaderValue(req.headers.host);
    return originUrl.host === requestHost || isLoopbackHost(originUrl.hostname);
  } catch {
    return false;
  }
}

function bearerToken(req: IncomingMessage): string {
  const auth = getHeaderValue(req.headers.authorization);
  const prefix = "Bearer ";
  return auth.startsWith(prefix) ? auth.slice(prefix.length) : "";
}

function websocketToken(req: IncomingMessage): string {
  try {
    const url = new URL(req.url ?? "", "http://codex-web.local");
    return url.searchParams.get("token") ?? bearerToken(req);
  } catch {
    return bearerToken(req);
  }
}

export function validateUpgradeRequest(req: IncomingMessage, authToken: string): string | null {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "", "http://codex-web.local").pathname;
  } catch {
    return "Bad request";
  }
  if (pathname !== "/ws") return "Not found";

  const host = hostNameFromHeader(getHeaderValue(req.headers.host));
  if (!authToken && !isLoopbackHost(host)) {
    return "Set CODEX_WEB_AUTH_TOKEN before exposing codex-web off localhost";
  }

  if (authToken && websocketToken(req) !== authToken) {
    return "Unauthorized";
  }

  if (!isOriginAllowed(req)) {
    return "Forbidden origin";
  }

  return null;
}

export function rejectUpgrade(socket: Duplex, status: number, message: string) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain\r\n" +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    "\r\n" +
    message,
  );
  socket.destroy();
}
