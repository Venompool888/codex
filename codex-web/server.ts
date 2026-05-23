import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ClientMsg, ServerMsg, AppItem, FileChange, FsEntry,
  ApprovalDecision, FileMention, ReasoningEffort, ModelInfo,
  ConfigKey, ConfigState, FileSearchResult, InputQuestion,
  JsonValue, McpElicitationAction, McpServerSummary, McpStartupSummary,
  SerializedHistoryEntry, ThreadSummary,
} from "./shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const DIST_CLIENT = path.resolve(__dirname, "dist/client");
const isProd = process.env.NODE_ENV === "production";
const execFileAsync = promisify(execFile);
const CODEX_WEB_AUTH_TOKEN = process.env.CODEX_WEB_AUTH_TOKEN ?? "";

const CODEX_BIN =
  process.env.CODEX_BIN ??
  "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex";
const REPO_MODEL_CATALOG = path.resolve(__dirname, "../codex-rs/models-manager/models.json");

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript",
  ".css": "text/css", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
};

// ── Static file serving ───────────────────────────────────────────────────────
function isPathInside(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveStaticPath(reqUrl: string | undefined): string | null {
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

  const requested = path.resolve(DIST_CLIENT, normalized);
  if (!isPathInside(DIST_CLIENT, requested)) return null;

  const fallback = path.resolve(DIST_CLIENT, "index.html");
  return existsSync(requested) ? requested : fallback;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!isProd) { res.writeHead(404); res.end("Dev mode"); return; }
  const fp = resolveStaticPath(req.url);
  if (!fp) { res.writeHead(404); res.end("Not found"); return; }
  const ext = path.extname(fp);
  readFile(fp).then(data => {
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
    res.end(data);
  }).catch(() => { res.writeHead(404); res.end("Not found"); });
}

// ── Config helpers ────────────────────────────────────────────────────────────
type CodexConfig = {
  model: string;
  effort: ReasoningEffort;
  baseUrl: string;
  modelCatalogJson: string;
};

function readConfig(): CodexConfig {
  try {
    const home = process.env.HOME ?? "/root";
    const toml = readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown";
    const effort = (toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "high") as ReasoningEffort;
    const baseUrl = toml.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    const modelCatalogJson = toml.match(/^model_catalog_json\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    return { model, effort, baseUrl, modelCatalogJson };
  } catch { return { model: "unknown", effort: "high", baseUrl: "", modelCatalogJson: "" }; }
}

function codexArgs(config: CodexConfig): string[] {
  const args = ["app-server"];
  const modelCatalogJson =
    process.env.CODEX_WEB_MODEL_CATALOG_JSON ??
    (config.baseUrl && !config.modelCatalogJson && existsSync(REPO_MODEL_CATALOG)
      ? REPO_MODEL_CATALOG
      : "");

  if (modelCatalogJson && process.env.CODEX_WEB_MODEL_CATALOG_JSON !== "off") {
    args.push("-c", `model_catalog_json=${JSON.stringify(modelCatalogJson)}`);
  }

  args.push("--listen", "stdio://");
  return args;
}

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

function validateUpgradeRequest(req: IncomingMessage): string | null {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "", "http://codex-web.local").pathname;
  } catch {
    return "Bad request";
  }
  if (pathname !== "/ws") return "Not found";

  const host = hostNameFromHeader(getHeaderValue(req.headers.host));
  if (!CODEX_WEB_AUTH_TOKEN && !isLoopbackHost(host)) {
    return "Set CODEX_WEB_AUTH_TOKEN before exposing codex-web off localhost";
  }

  if (CODEX_WEB_AUTH_TOKEN && websocketToken(req) !== CODEX_WEB_AUTH_TOKEN) {
    return "Unauthorized";
  }

  if (!isOriginAllowed(req)) {
    return "Forbidden origin";
  }

  return null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
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

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" ||
    value === "medium" || value === "high" || value === "xhigh";
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "acceptForSession" ||
    value === "decline" || value === "cancel";
}

function isMcpElicitationAction(value: unknown): value is McpElicitationAction {
  return value === "accept" || value === "decline" || value === "cancel";
}

function isConfigKey(value: unknown): value is ConfigKey {
  return value === "model" || value === "model_reasoning_effort" ||
    value === "approval_policy" || value === "sandbox_mode" || value === "web_search";
}

function validString(value: unknown, max = 100_000): value is string {
  return typeof value === "string" && value.length <= max;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return Number.isFinite(value as number) || t !== "number";
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isObj(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function parseMentions(value: unknown): FileMention[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m): FileMention[] => {
    if (!isObj(m) || !validString(m.name, 256) || !validString(m.path, 4096)) return [];
    return [{ name: m.name, path: m.path }];
  });
}

function parseAnswers(value: unknown): Record<string, string[]> | null {
  if (!isObj(value)) return null;
  const answers: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!validString(key, 128) || !Array.isArray(raw)) return null;
    const values = raw.filter((v): v is string => validString(v, 20_000));
    if (values.length !== raw.length) return null;
    answers[key] = values;
  }
  return answers;
}

function parseClientMsg(raw: string): ClientMsg | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isObj(parsed) || typeof parsed.type !== "string") return null;

  switch (parsed.type) {
    case "send":
      return validString(parsed.text) ? { type: "send", text: parsed.text, mentions: parseMentions(parsed.mentions) } : null;
    case "interrupt":
    case "new_thread":
    case "list_threads":
    case "read_config":
    case "list_mcp":
    case "list_models":
      return { type: parsed.type };
    case "resume_thread":
      return validString(parsed.threadId, 128) ? { type: "resume_thread", threadId: parsed.threadId } : null;
    case "approve":
      return validString(parsed.id, 128) && isApprovalDecision(parsed.decision)
        ? { type: "approve", id: parsed.id, decision: parsed.decision }
        : null;
    case "respond_input": {
      const answers = parseAnswers(parsed.answers);
      return validString(parsed.id, 128) && answers
        ? { type: "respond_input", id: parsed.id, answers }
        : null;
    }
    case "respond_mcp_elicitation":
      return validString(parsed.id, 128) && isMcpElicitationAction(parsed.action) && isJsonValue(parsed.content)
        ? { type: "respond_mcp_elicitation", id: parsed.id, action: parsed.action, content: parsed.content }
        : null;
    case "slash":
      return validString(parsed.name, 64) && /^[a-z][a-z0-9_-]*$/i.test(parsed.name) && validString(parsed.args, 20_000)
        ? { type: "slash", name: parsed.name, args: parsed.args }
        : null;
    case "fs_list":
      return validString(parsed.path, 4096) ? { type: "fs_list", path: parsed.path } : null;
    case "fuzzy_file_search":
      return validString(parsed.query, 512) ? { type: "fuzzy_file_search", query: parsed.query } : null;
    case "set_model":
      return validString(parsed.model, 256) ? { type: "set_model", model: parsed.model } : null;
    case "set_effort":
      return isReasoningEffort(parsed.effort) ? { type: "set_effort", effort: parsed.effort } : null;
    case "write_config":
      return isConfigKey(parsed.key) && validString(parsed.value, 4096)
        ? { type: "write_config", key: parsed.key, value: parsed.value }
        : null;
    default:
      return null;
  }
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────
type RpcMsg =
  | { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } };

// ── Per-connection session ────────────────────────────────────────────────────
class CodexSession {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private pendingApprovals = new Map<string | number, (decision: ApprovalDecision) => void>();
  private pendingInputRequests = new Map<string, (answers: Record<string, string[]>) => void>();
  private pendingMcpElicitations = new Map<string, (response: { action: McpElicitationAction; content: JsonValue | null }) => void>();
  private fileChangesByItemId = new Map<string, FileChange[]>();
  private fileChangeWaiters = new Map<string, Array<(changes: FileChange[]) => void>>();
  private pendingFileApprovalByItemId = new Map<string, string>();
  private mcpStartupByName = new Map<string, McpStartupSummary>();
  private threadId = "";
  private currentTurnId = "";
  private closed = false;
  private effort: ReasoningEffort = "high";
  private config: CodexConfig;
  private workspaceRoot: string;
  private stderrLines: string[] = [];
  private stdoutLines: Interface;
  private stderrReader: Interface | null = null;

  constructor(private ws: WebSocket, private cwd: string, private model: string) {
    this.config = readConfig();
    this.workspaceRoot = realpathSync(cwd);
    this.proc = spawn(CODEX_BIN, codexArgs(this.config), {
      cwd, env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stdoutLines = createInterface({ input: this.proc.stdout! });
    this.stdoutLines.on("line", (line) => this.handleLine(line));
    if (this.proc.stderr) {
      this.stderrReader = createInterface({ input: this.proc.stderr });
      this.stderrReader.on("line", (line) => {
        if (!line.trim()) return;
        this.stderrLines.push(line);
        if (this.stderrLines.length > 8) this.stderrLines.shift();
        console.error(line);
      });
    }
    this.proc.on("exit", () => {
      this.rejectPending(new Error("app-server 进程退出"));
      if (!this.closed) this.send({ type: "error", message: "app-server 进程退出" });
    });
  }

  async start() {
    // initialize
    await this.rpc("initialize", {
      clientInfo: { name: "codex-web", title: "Codex Web", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });

    // read default effort from config
    const cfg = this.config;
    this.effort = cfg.effort;

    // start thread
    const resp = await this.rpc("thread/start", { cwd: this.cwd, model: cfg.model }) as any;
    this.threadId = resp.thread.id;
    this.model = resp.model ?? cfg.model;
    this.cwd = resp.cwd ?? this.cwd;

    this.send({ type: "connected", threadId: this.threadId, cwd: this.cwd, model: this.model });
    this.send({ type: "settings", model: this.model, effort: this.effort });
    this.background(this.listThreads());
    this.background(this.readConfigState());
    this.background(this.listMcpStatus());
  }

  async newThread() {
    this.currentTurnId = "";
    const resp = await this.rpc("thread/start", {
      cwd: this.cwd, model: this.model,
    }) as any;
    this.threadId = resp.thread.id;
    this.model = resp.model ?? this.model;
    this.send({ type: "connected", threadId: this.threadId, cwd: this.cwd, model: this.model });
    this.send({ type: "settings", model: this.model, effort: this.effort });
    this.background(this.listThreads());
  }

  async resumeThread(threadId: string) {
    this.currentTurnId = "";
    const resp = await this.rpc("thread/resume", { threadId }) as any;
    const thread = resp.thread ?? {};
    this.threadId = thread.id ?? threadId;
    this.model = resp.model ?? this.model;
    this.cwd = resp.cwd ?? thread.cwd ?? this.cwd;
    try {
      this.workspaceRoot = realpathSync(this.cwd);
    } catch {
      this.workspaceRoot = realpathSync(process.cwd());
    }
    this.send({ type: "connected", threadId: this.threadId, cwd: this.cwd, model: this.model });
    this.send({ type: "settings", model: this.model, effort: this.effort });
    this.send({ type: "thread_history", threadId: this.threadId, entries: this.mapThreadHistory(thread.turns ?? []) });
    this.background(this.listThreads());
  }

  async sendMessage(text: string, mentions: FileMention[] = []) {
    const input: unknown[] = [{ type: "text", text, text_elements: [] }];
    for (const m of mentions) {
      input.push({ type: "mention", name: m.name, path: m.path });
    }
    await this.rpc("turn/start", {
      threadId: this.threadId,
      input,
      model: this.model,
      effort: this.effort,
    });
  }

  setModel(model: string) {
    this.model = model;
    this.send({ type: "settings", model: this.model, effort: this.effort });
  }

  setEffort(effort: ReasoningEffort) {
    this.effort = effort;
    this.send({ type: "settings", model: this.model, effort: this.effort });
  }

  async listModels() {
    const modelsById = new Map<string, ModelInfo>();

    // First try the RPC (works when app-server has Codex-format model registry).
    try {
      const resp = await this.rpc("model/list", { limit: 50 }) as any;
      if (Array.isArray(resp?.data) && resp.data.length > 0) {
        for (const m of resp.data) {
          const id = m.model;
          if (typeof id !== "string") continue;
          modelsById.set(id, {
            id,
            displayName: m.displayName ?? id,
            description: m.description ?? "",
            supportedEfforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort),
            defaultEffort: m.defaultReasoningEffort ?? "high",
            isDefault: m.isDefault ?? id === this.model,
          });
        }
      }
    } catch { /* fall through */ }

    // Also query the provider's /v1/models directly so OpenAI-compatible providers
    // still appear when app-server is using a static Codex model catalog.
    try {
      const cfg = readConfig();
      const base = cfg.baseUrl || "https://api.openai.com/v1";
      const apiKey = process.env.OPENAI_API_KEY ?? process.env.CLIPROXYAPI_KEY ?? "";
      const url = new URL("models", base.endsWith("/") ? base : `${base}/`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const json = await res.json() as any;
      const data: any[] = json.data ?? [];
      for (const m of data) {
        if (typeof m.id !== "string" || modelsById.has(m.id)) continue;
        modelsById.set(m.id, {
          id: m.id,
          displayName: m.id,
          description: m.owned_by ? `by ${m.owned_by}` : "",
          supportedEfforts: [],
          defaultEffort: "high" as ReasoningEffort,
          isDefault: m.id === this.model,
        });
      }
    } catch { /* ignore provider fallback failure */ }

    const models = [...modelsById.values()];
    if (models.length > 0) {
      this.send({ type: "models_list", models });
      return;
    }
    this.send({ type: "error", message: "无法获取模型列表" });
  }

  async listThreads() {
    const resp = await this.rpc("thread/list", {
      limit: 30,
      sortKey: "updated_at",
      sortDirection: "desc",
      cwd: this.cwd,
    }) as any;

    const threads: ThreadSummary[] = Array.isArray(resp?.data)
      ? resp.data
          .map((thread: any) => this.mapThreadSummary(thread))
          .filter((thread: ThreadSummary | null): thread is ThreadSummary => Boolean(thread))
      : [];
    this.send({ type: "threads_list", threads, nextCursor: resp?.nextCursor ?? null });
  }

  async searchFiles(query: string) {
    if (!query.trim()) {
      this.send({ type: "fuzzy_file_search_result", query, files: [] });
      return;
    }

    const resp = await this.rpc("fuzzyFileSearch", {
      query,
      roots: [this.workspaceRoot],
      cancellationToken: null,
    }) as any;

    const files: FileSearchResult[] = Array.isArray(resp?.files)
      ? resp.files.slice(0, 12).map((f: any) => ({
          name: String(f.file_name ?? path.basename(f.path ?? "")),
          path: String(f.path ?? ""),
          root: String(f.root ?? this.workspaceRoot),
          score: typeof f.score === "number" ? f.score : 0,
        }))
      : [];
    this.send({ type: "fuzzy_file_search_result", query, files });
  }

  async readConfigState() {
    const resp = await this.rpc("config/read", { includeLayers: false, cwd: this.cwd }) as any;
    this.send({ type: "config_state", config: this.mapConfigState(resp?.config ?? {}) });
  }

  async writeConfigValue(key: ConfigKey, value: string) {
    const parsed = this.parseConfigValue(key, value);
    if (parsed === undefined) {
      this.send({ type: "error", message: `无效配置值: ${key}` });
      return;
    }

    await this.rpc("config/batchWrite", {
      edits: [{ keyPath: key, value: parsed, mergeStrategy: "replace" }],
      reloadUserConfig: true,
    });

    if (key === "model" && typeof parsed === "string") this.model = parsed;
    if (key === "model_reasoning_effort" && isReasoningEffort(parsed)) this.effort = parsed;
    this.send({ type: "settings", model: this.model, effort: this.effort });
    await this.readConfigState();
  }

  async listMcpStatus() {
    const resp = await this.rpc("mcpServerStatus/list", { limit: 50, detail: "full" }) as any;
    const servers: McpServerSummary[] = Array.isArray(resp?.data)
      ? resp.data.map((s: any) => this.mapMcpStatus(s))
      : [];
    this.send({ type: "mcp_statuses", servers });
  }

  async interrupt() {
    if (this.currentTurnId) {
      await this.rpc("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId });
    }
  }

  respondApproval(id: string, decision: ApprovalDecision) {
    const resolve = this.pendingApprovals.get(id);
    if (resolve) {
      this.pendingApprovals.delete(id);
      resolve(decision);
    }
  }

  respondInput(id: string, answers: Record<string, string[]>) {
    const resolve = this.pendingInputRequests.get(id);
    if (resolve) {
      this.pendingInputRequests.delete(id);
      resolve(answers);
    }
  }

  respondMcpElicitation(id: string, action: McpElicitationAction, content: JsonValue | null) {
    const resolve = this.pendingMcpElicitations.get(id);
    if (resolve) {
      this.pendingMcpElicitations.delete(id);
      resolve({ action, content });
    }
  }

  notifyError(message: string) {
    this.send({ type: "error", message });
  }

  async handleSlash(name: string, args: string) {
    switch (name) {
      case "diff": {
        try {
          const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--stat"], { cwd: this.cwd });
          const { stdout: full } = await execFileAsync("git", ["diff", "HEAD"], { cwd: this.cwd });
          this.send({ type: "slash_result", name: "diff", content: (stdout || "(无改动)") + "\n" + full });
        } catch { this.send({ type: "slash_result", name: "diff", content: "git diff 失败（可能不在 git 仓库）" }); }
        break;
      }
      case "status": {
        this.send({ type: "slash_result", name: "status", content: `thread: ${this.threadId}\nmodel: ${this.model}\ncwd: ${this.cwd}` });
        break;
      }
      case "model": {
        if (args.trim()) {
          this.model = args.trim();
          this.send({ type: "slash_result", name: "model", content: `已切换模型: ${this.model}（下一轮生效）` });
        } else {
          this.send({ type: "slash_result", name: "model", content: `当前模型: ${this.model}` });
        }
        break;
      }
      default:
        this.send({ type: "slash_result", name, content: `未知命令: /${name}` });
    }
  }

  listFiles(dirPath: string) {
    try {
      const dir = this.resolveWorkspacePath(dirPath);
      if (!dir) {
        this.send({ type: "fs_list_result", path: dirPath, entries: [] });
        return;
      }

      const entries: FsEntry[] = readdirSync(dir).map(name => {
        const fp = path.join(dir, name);
        const isDir = lstatSync(fp).isDirectory();
        return { name, path: fp, isDir };
      }).filter(e => !e.name.startsWith(".") || e.isDir);
      this.send({ type: "fs_list_result", path: dir, entries });
    } catch { this.send({ type: "fs_list_result", path: dirPath, entries: [] }); }
  }

  close() {
    this.closed = true;
    this.rejectPending(new Error("app-server 连接关闭"));
    this.stdoutLines.close();
    this.stderrReader?.close();
    this.proc.kill();
  }

  startupFailureMessage(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = this.stderrLines.join("\n");
    return {
      message: detail ? `${message}\n\n最近 app-server 日志:\n${detail}` : message,
      detail,
    };
  }

  // ── RPC ────────────────────────────────────────────────────────────────────
  private rpc(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private rpcRespond(id: number, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(msg: unknown) {
    if (this.proc.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  private send(msg: ServerMsg) {
    if (this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private rejectPending(err: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private background(promise: Promise<unknown>) {
    promise.catch(err => this.send({ type: "error", message: err instanceof Error ? err.message : String(err) }));
  }

  private resolveWorkspacePath(input: string): string | null {
    const absolute = path.resolve(this.workspaceRoot, input);
    if (!isPathInside(this.workspaceRoot, absolute)) return null;
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      return null;
    }
    return isPathInside(this.workspaceRoot, real) ? real : null;
  }

  private mapThreadSummary(thread: any): ThreadSummary | null {
    if (!thread || typeof thread.id !== "string") return null;
    return {
      id: thread.id,
      preview: typeof thread.preview === "string" ? thread.preview : "",
      name: typeof thread.name === "string" ? thread.name : null,
      cwd: typeof thread.cwd === "string" ? thread.cwd : "",
      modelProvider: typeof thread.modelProvider === "string" ? thread.modelProvider : "",
      status: typeof thread.status?.type === "string" ? thread.status.type : "unknown",
      createdAt: typeof thread.createdAt === "number" ? thread.createdAt : 0,
      updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : 0,
      agentNickname: typeof thread.agentNickname === "string" ? thread.agentNickname : null,
      agentRole: typeof thread.agentRole === "string" ? thread.agentRole : null,
    };
  }

  private mapThreadHistory(turns: any[]): SerializedHistoryEntry[] {
    const entries: SerializedHistoryEntry[] = [];
    for (const turn of turns) {
      const rawItems = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of rawItems) {
        if (item?.type === "userMessage") {
          const user = this.mapUserMessage(item);
          if (user.text || user.mentions.length > 0) {
            entries.push({ id: item.id ?? `user-${entries.length}`, kind: "user", ...user });
          }
        }
      }

      const items: AppItem[] = rawItems
        .filter((item: any) => item?.type !== "userMessage" && item?.type !== "hookPrompt")
        .map((item: any) => this.mapItem(item))
        .filter((item: AppItem | null): item is AppItem => Boolean(item));

      if (items.length > 0) {
        entries.push({
          id: turn?.id ?? `turn-${entries.length}`,
          kind: "turn",
          items,
          itemOrder: items.map(item => item.id),
          usage: null,
          status: this.mapTurnStatus(turn?.status),
          failMessage: typeof turn?.error?.message === "string" ? turn.error.message : undefined,
        });
      }
    }
    return entries;
  }

  private mapUserMessage(item: any): { text: string; mentions: FileMention[] } {
    const content = Array.isArray(item?.content) ? item.content : [];
    const text: string[] = [];
    const mentions: FileMention[] = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
      if (part?.type === "mention" && typeof part.name === "string" && typeof part.path === "string") {
        mentions.push({ name: part.name, path: part.path });
        text.push(`@${part.name}`);
      }
    }
    return { text: text.join("\n").trim(), mentions };
  }

  private mapTurnStatus(status: unknown): "running" | "done" | "failed" | "interrupted" {
    if (status === "completed") return "done";
    if (status === "failed") return "failed";
    if (status === "interrupted") return "interrupted";
    return "running";
  }

  private mapPatchStatus(status: unknown): "pending" | "running" | "completed" | "failed" | "declined" {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    if (status === "declined") return "declined";
    if (status === "inProgress") return "running";
    return "pending";
  }

  private mapConfigState(config: any): ConfigState {
    const approval = config.approval_policy;
    const sandbox = config.sandbox_mode;
    const webSearch = config.web_search;
    const effortValue = config.model_reasoning_effort;
    return {
      model: typeof config.model === "string" ? config.model : this.model,
      modelReasoningEffort: isReasoningEffort(effortValue) ? effortValue : this.effort,
      approvalPolicy: approval === "untrusted" || approval === "on-failure" || approval === "on-request" || approval === "never"
        ? approval
        : "granular",
      sandboxMode: sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access"
        ? sandbox
        : "workspace-write",
      webSearch: webSearch === "disabled" || webSearch === "cached" || webSearch === "live"
        ? webSearch
        : "disabled",
    };
  }

  private parseConfigValue(key: ConfigKey, value: string): JsonValue | undefined {
    const v = value.trim();
    if (key === "model") return v ? v : undefined;
    if (key === "model_reasoning_effort") return isReasoningEffort(v) ? v : undefined;
    if (key === "approval_policy") {
      return v === "untrusted" || v === "on-failure" || v === "on-request" || v === "never" ? v : undefined;
    }
    if (key === "sandbox_mode") {
      return v === "read-only" || v === "workspace-write" || v === "danger-full-access" ? v : undefined;
    }
    if (key === "web_search") {
      return v === "disabled" || v === "cached" || v === "live" ? v : undefined;
    }
    return undefined;
  }

  private mapMcpStatus(server: any): McpServerSummary {
    const startup = this.mcpStartupByName.get(String(server?.name ?? ""));
    return {
      name: String(server?.name ?? ""),
      authStatus: String(server?.authStatus ?? "unknown"),
      tools: Object.keys(server?.tools ?? {}),
      resourceCount: Array.isArray(server?.resources) ? server.resources.length : 0,
      resourceTemplateCount: Array.isArray(server?.resourceTemplates) ? server.resourceTemplates.length : 0,
      startupStatus: startup?.startupStatus,
      error: startup?.error ?? null,
    };
  }

  private rememberFileChanges(itemId: string, changes: FileChange[]) {
    this.fileChangesByItemId.set(itemId, changes);
    const approvalId = this.pendingFileApprovalByItemId.get(itemId);
    if (approvalId) this.send({ type: "approval_file_updated", id: approvalId, changes });

    const waiters = this.fileChangeWaiters.get(itemId);
    if (!waiters) return;
    this.fileChangeWaiters.delete(itemId);
    for (const resolve of waiters) resolve(changes);
  }

  private waitForFileChanges(itemId: string, timeoutMs = 500): Promise<FileChange[]> {
    const existing = this.fileChangesByItemId.get(itemId);
    if (existing && existing.length > 0) return Promise.resolve(existing);

    return new Promise(resolve => {
      const waiters = this.fileChangeWaiters.get(itemId) ?? [];
      waiters.push(resolve);
      this.fileChangeWaiters.set(itemId, waiters);
      setTimeout(() => {
        const pending = this.fileChangeWaiters.get(itemId) ?? [];
        this.fileChangeWaiters.set(itemId, pending.filter(fn => fn !== resolve));
        resolve(this.fileChangesByItemId.get(itemId) ?? []);
      }, timeoutMs);
    });
  }

  // ── Incoming from app-server ───────────────────────────────────────────────
  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    // Response to our request
    if ("result" in msg && "id" in msg) {
      const p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg.result); }
      return;
    }
    if ("error" in msg && "id" in msg) {
      const p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.reject(new Error(msg.error?.message)); }
      return;
    }

    // Server request (needs response)
    if ("method" in msg && "id" in msg) {
      this.handleServerRequest(msg);
      return;
    }

    // Notification
    if ("method" in msg) {
      this.handleNotification(msg);
    }
  }

  private handleNotification(msg: { method: string; params: any }) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "turn/started":
        this.currentTurnId = p.turn?.id ?? "";
        this.send({ type: "turn_started", turnId: this.currentTurnId });
        break;

      case "turn/completed": {
        this.send({ type: "turn_completed", turnId: p.turn?.id ?? this.currentTurnId, usage: null });
        this.currentTurnId = "";
        break;
      }

      case "thread/tokenUsage/updated": {
        const last = p.tokenUsage?.last;
        if (last && this.currentTurnId) {
          this.send({
            type: "token_usage",
            turnId: this.currentTurnId,
            usage: {
              inputTokens: last.inputTokens,
              cachedInputTokens: last.cachedInputTokens,
              outputTokens: last.outputTokens,
              reasoningOutputTokens: last.reasoningOutputTokens,
              totalTokens: last.totalTokens,
            },
          });
        }
        break;
      }

      case "item/started": {
        const item = p.item ? this.mapItem(p.item) : null;
        if (item) this.send({ type: "item_started", turnId: p.turnId, item });
        break;
      }
      case "item/completed": {
        const item = p.item ? this.mapItem(p.item) : null;
        if (item) this.send({ type: "item_completed", turnId: p.turnId, item });
        break;
      }

      case "item/agentMessage/delta":
        this.send({ type: "agent_delta", turnId: p.turnId, itemId: p.itemId, delta: p.delta ?? "" });
        break;

      case "item/commandExecution/outputDelta":
        this.send({ type: "cmd_delta", turnId: p.turnId, itemId: p.itemId, delta: p.delta ?? "" });
        break;

      case "item/reasoning/textDelta":
        this.send({ type: "reasoning_delta", turnId: p.turnId, itemId: p.itemId, delta: p.delta ?? "" });
        break;

      case "item/fileChange/patchUpdated":
        if (p.changes) {
          const changes = (p.changes as any[]).map(c => ({ path: c.path, kind: c.kind, diff: c.diff ?? "" }));
          this.rememberFileChanges(p.itemId, changes);
          const item: AppItem = {
            id: p.itemId, type: "fileChange",
            changes,
            status: "running",
          };
          this.send({ type: "item_updated", turnId: p.turnId, item });
        }
        break;

      case "item/mcpToolCall/progress": {
        this.send({
          type: "item_updated",
          turnId: p.turnId,
          item: {
            id: p.itemId,
            type: "mcpToolCall",
            server: "",
            tool: "",
            status: "in_progress",
            progress: [p.message ?? ""],
          },
        });
        break;
      }

      case "mcpServer/startupStatus/updated": {
        const server: McpStartupSummary = {
          name: p.name ?? "",
          startupStatus: p.status ?? "unknown",
          error: p.error ?? null,
        };
        this.mcpStartupByName.set(server.name, server);
        this.send({ type: "mcp_status_update", server });
        break;
      }

      case "serverRequest/resolved":
        this.send({ type: "input_resolved", id: String(p.requestId ?? "") });
        break;

      // ignore noisy or unneeded notifications
      case "thread/started":
      case "thread/status/changed":
      case "thread/name/updated":
      case "hook/started":
      case "hook/completed":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        break;

      default:
        break;
    }
  }

  private async handleServerRequest(msg: { method: string; id: number; params: any }) {
    const p = msg.params ?? {};

    switch (msg.method) {
      case "item/commandExecution/requestApproval": {
        const approvalId = String(msg.id);
        this.send({
          type: "approval_cmd",
          id: approvalId,
          command: p.command ?? "",
          cwd: p.cwd ?? this.cwd,
          reason: p.reason ?? undefined,
        });
        const decision = await this.waitForApproval(approvalId);
        this.rpcRespond(msg.id, { decision });
        break;
      }

      case "item/fileChange/requestApproval": {
        const approvalId = String(msg.id);
        const itemId = String(p.itemId ?? "");
        const changes = itemId ? await this.waitForFileChanges(itemId) : [];
        if (itemId) this.pendingFileApprovalByItemId.set(itemId, approvalId);
        this.send({
          type: "approval_file",
          id: approvalId,
          reason: p.reason ?? undefined,
          grantRoot: p.grantRoot ?? undefined,
          changes,
        });
        const decision = await this.waitForApproval(approvalId);
        if (itemId) this.pendingFileApprovalByItemId.delete(itemId);
        this.rpcRespond(msg.id, { decision });
        break;
      }

      case "item/tool/requestUserInput": {
        const requestId = String(msg.id);
        this.send({
          type: "input_request",
          request: {
            id: requestId,
            title: "需要你的输入",
            questions: this.mapInputQuestions(p.questions),
          },
        });
        const answers = await this.waitForInput(requestId);
        this.rpcRespond(msg.id, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([key, values]) => [key, { answers: values }]),
          ),
        });
        break;
      }

      case "mcpServer/elicitation/request": {
        const requestId = String(msg.id);
        const request = p.mode === "url"
          ? {
              id: requestId,
              serverName: p.serverName ?? "",
              turnId: p.turnId ?? null,
              mode: "url" as const,
              message: p.message ?? "",
              url: p.url ?? "",
              elicitationId: p.elicitationId ?? "",
            }
          : {
              id: requestId,
              serverName: p.serverName ?? "",
              turnId: p.turnId ?? null,
              mode: "form" as const,
              message: p.message ?? "",
              requestedSchema: isJsonValue(p.requestedSchema) ? p.requestedSchema : null,
            };
        this.send({ type: "mcp_elicitation", request });
        const response = await this.waitForMcpElicitation(requestId);
        this.rpcRespond(msg.id, { ...response, _meta: null });
        break;
      }

      // auto-respond to other server requests
      default:
        this.rpcRespond(msg.id, {});
        break;
    }
  }

  private waitForApproval(id: string): Promise<ApprovalDecision> {
    return new Promise(resolve => this.pendingApprovals.set(id, resolve));
  }

  private waitForInput(id: string): Promise<Record<string, string[]>> {
    return new Promise(resolve => this.pendingInputRequests.set(id, resolve));
  }

  private waitForMcpElicitation(id: string): Promise<{ action: McpElicitationAction; content: JsonValue | null }> {
    return new Promise(resolve => this.pendingMcpElicitations.set(id, resolve));
  }

  private mapInputQuestions(raw: any): InputQuestion[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((q): InputQuestion[] => {
      if (!q || typeof q.id !== "string") return [];
      return [{
        id: q.id,
        header: typeof q.header === "string" ? q.header : "",
        question: typeof q.question === "string" ? q.question : "",
        isOther: Boolean(q.isOther),
        isSecret: Boolean(q.isSecret),
        options: Array.isArray(q.options)
          ? q.options
              .filter((o: any) => typeof o?.label === "string")
              .map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" }))
          : null,
      }];
    });
  }

  private mapItem(raw: any): AppItem | null {
    switch (raw.type) {
      case "agentMessage":
        return { id: raw.id, type: "agentMessage", text: raw.text ?? "" };
      case "reasoning":
        return { id: raw.id, type: "reasoning", text: (raw.content ?? []).join("") };
      case "commandExecution":
        return {
          id: raw.id, type: "commandExecution",
          command: raw.command ?? "", cwd: raw.cwd ?? "",
          aggregatedOutput: raw.aggregatedOutput ?? "",
          exitCode: raw.exitCode ?? null,
          durationMs: raw.durationMs ?? null,
          status: raw.status === "completed" ? "completed" : raw.status === "failed" ? "failed" : raw.status === "inProgress" || raw.status === "running" ? "running" : "pending",
        };
      case "fileChange":
        {
          const changes = (raw.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind, diff: c.diff ?? "" }));
          if (typeof raw.id === "string") this.rememberFileChanges(raw.id, changes);
          return {
          id: raw.id, type: "fileChange",
          changes,
          status: this.mapPatchStatus(raw.status),
          };
        }
      case "mcpToolCall":
        return {
          id: raw.id, type: "mcpToolCall",
          server: raw.server ?? "", tool: raw.tool ?? "",
          status: raw.status === "completed" ? "completed" : raw.status === "failed" ? "failed" : "in_progress",
          error: raw.error?.message,
        };
      case "webSearch":
        return { id: raw.id, type: "webSearch", query: raw.query ?? "" };
      case "plan":
        return { id: raw.id, type: "agentMessage", text: raw.text ?? "" };
      case "userMessage":
        return null;  // echo of the user's own message — skip
      default:
        return null;  // silently ignore unknown item types
    }
  }
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const httpServer = createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const rejection = validateUpgradeRequest(req);
  if (rejection) {
    rejectUpgrade(socket, rejection === "Unauthorized" ? 401 : rejection === "Not found" ? 404 : 403, rejection);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws) => {
  const cwd = process.cwd();
  const { model } = readConfig();
  const session = new CodexSession(ws, cwd, model);

  try {
    await session.start();
  } catch (err) {
    ws.send(JSON.stringify({ type: "startup_failed", ...session.startupFailureMessage(err) } as ServerMsg));
    session.close();
    return;
  }

  ws.on("message", async (raw) => {
    const msg = parseClientMsg(raw.toString());
    if (!msg) {
      session.notifyError("无效客户端消息");
      return;
    }

    try {
      switch (msg.type) {
        case "send":
          await session.sendMessage(msg.text, msg.mentions);
          break;
        case "interrupt":
          await session.interrupt();
          break;
        case "new_thread":
          await session.newThread();
          break;
        case "list_threads":
          await session.listThreads();
          break;
        case "resume_thread":
          await session.resumeThread(msg.threadId);
          break;
        case "approve":
          session.respondApproval(msg.id, msg.decision);
          break;
        case "respond_input":
          session.respondInput(msg.id, msg.answers);
          break;
        case "respond_mcp_elicitation":
          session.respondMcpElicitation(msg.id, msg.action, msg.content);
          break;
        case "slash":
          await session.handleSlash(msg.name, msg.args);
          break;
        case "fs_list":
          session.listFiles(msg.path);
          break;
        case "fuzzy_file_search":
          await session.searchFiles(msg.query);
          break;
        case "set_model":
          session.setModel(msg.model);
          break;
        case "set_effort":
          session.setEffort(msg.effort);
          break;
        case "list_models":
          await session.listModels();
          break;
        case "read_config":
          await session.readConfigState();
          break;
        case "write_config":
          await session.writeConfigValue(msg.key, msg.value);
          break;
        case "list_mcp":
          await session.listMcpStatus();
          break;
      }
    } catch (err) {
      session.notifyError(err instanceof Error ? err.message : String(err));
    }
  });

  ws.on("close", () => session.close());
});

httpServer.listen(PORT, () => {
  console.log(`codex-web server running at http://localhost:${PORT}`);
  if (isProd) console.log("  Serving built client from dist/client/");
  else console.log("  Dev mode: frontend at http://localhost:5173");
});
