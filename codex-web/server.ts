import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ClientMsg, ServerMsg, AppItem, FileChange, FsEntry,
  ApprovalDecision, FileMention, ReasoningEffort, ModelInfo,
} from "./shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const DIST_CLIENT = path.join(__dirname, "dist/client");
const isProd = process.env.NODE_ENV === "production";
const execFileAsync = promisify(execFile);

const CODEX_BIN =
  process.env.CODEX_BIN ??
  "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript",
  ".css": "text/css", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
};

// ── Static file serving ───────────────────────────────────────────────────────
async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!isProd) { res.writeHead(404); res.end("Dev mode"); return; }
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const ext = path.extname(url);
  let fp = path.join(DIST_CLIENT, url);
  if (!existsSync(fp)) fp = path.join(DIST_CLIENT, "index.html");
  readFile(fp).then(data => {
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
    res.end(data);
  }).catch(() => { res.writeHead(404); res.end("Not found"); });
}

// ── Config helpers ────────────────────────────────────────────────────────────
function readConfig(): { model: string; effort: ReasoningEffort; baseUrl: string } {
  try {
    const home = process.env.HOME ?? "/root";
    const toml = readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown";
    const effort = (toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "high") as ReasoningEffort;
    const baseUrl = toml.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    return { model, effort, baseUrl };
  } catch { return { model: "unknown", effort: "high", baseUrl: "" }; }
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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private pendingApprovals = new Map<string | number, (decision: ApprovalDecision) => void>();
  private threadId = "";
  private currentTurnId = "";
  private closed = false;
  private effort: ReasoningEffort = "high";

  constructor(private ws: WebSocket, private cwd: string, private model: string) {
    this.proc = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
      cwd, env: { ...process.env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.handleLine(line));
    this.proc.on("exit", () => { if (!this.closed) this.send({ type: "error", message: "app-server 进程退出" }); });
  }

  async start() {
    // initialize
    await this.rpc("initialize", {
      clientInfo: { name: "codex-web", title: "Codex Web", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });

    // read default effort from config
    const cfg = readConfig();
    this.effort = cfg.effort;

    // start thread
    const resp = await this.rpc("thread/start", { cwd: this.cwd, model: cfg.model }) as any;
    this.threadId = resp.thread.id;
    this.model = resp.model ?? cfg.model;
    this.cwd = resp.cwd ?? this.cwd;

    this.send({ type: "connected", threadId: this.threadId, cwd: this.cwd, model: this.model });
    this.send({ type: "settings", model: this.model, effort: this.effort });
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
    // First try the RPC (works when app-server has Codex-format model registry)
    try {
      const resp = await this.rpc("model/list", { limit: 50 }) as any;
      if (Array.isArray(resp?.data) && resp.data.length > 0) {
        const models: ModelInfo[] = resp.data.map((m: any) => ({
          id: m.model,
          displayName: m.displayName ?? m.model,
          description: m.description ?? "",
          supportedEfforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort ?? "high",
          isDefault: m.isDefault ?? false,
        }));
        this.send({ type: "models_list", models });
        return;
      }
    } catch { /* fall through */ }

    // Fallback: query the provider's /v1/models directly (OpenAI-compatible format)
    try {
      const cfg = readConfig();
      const base = cfg.baseUrl || "https://api.openai.com/v1";
      const apiKey = process.env.OPENAI_API_KEY ?? process.env.CLIPROXYAPI_KEY ?? "";
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const json = await res.json() as any;
      const data: any[] = json.data ?? [];
      const models: ModelInfo[] = data
        .filter((m: any) => typeof m.id === "string")
        .map((m: any) => ({
          id: m.id,
          displayName: m.id,
          description: m.owned_by ? `by ${m.owned_by}` : "",
          supportedEfforts: [],
          defaultEffort: "high" as ReasoningEffort,
          isDefault: m.id === this.model,
        }));
      this.send({ type: "models_list", models });
    } catch {
      this.send({ type: "error", message: "无法获取模型列表" });
    }
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
      const entries: FsEntry[] = readdirSync(dirPath).map(name => {
        const fp = path.join(dirPath, name);
        const isDir = statSync(fp).isDirectory();
        return { name, path: fp, isDir };
      }).filter(e => !e.name.startsWith(".") || e.isDir);
      this.send({ type: "fs_list_result", path: dirPath, entries });
    } catch { this.send({ type: "fs_list_result", path: dirPath, entries: [] }); }
  }

  close() {
    this.closed = true;
    this.proc.kill();
  }

  // ── RPC ────────────────────────────────────────────────────────────────────
  private rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

  // ── Incoming from app-server ───────────────────────────────────────────────
  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    // Response to our request
    if ("result" in msg && "id" in msg) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p.resolve(msg.result); }
      return;
    }
    if ("error" in msg && "id" in msg) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p.reject(new Error(msg.error?.message)); }
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
        const usage = p.turn ? null : null; // usage comes via thread/tokenUsage/updated
        this.send({ type: "turn_completed", turnId: p.turn?.id ?? this.currentTurnId, usage });
        this.currentTurnId = "";
        break;
      }

      case "thread/tokenUsage/updated": {
        const last = p.tokenUsage?.last;
        if (last && this.currentTurnId) {
          // update usage on the current turn
          this.send({
            type: "turn_completed",
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
          const item: AppItem = {
            id: p.itemId, type: "fileChange",
            changes: (p.changes as any[]).map(c => ({ path: c.path, kind: c.kind, diff: c.diff ?? "" })),
            status: "completed",
          };
          this.send({ type: "item_updated", turnId: p.turnId, item });
        }
        break;

      // ignore noisy or unneeded notifications
      case "thread/started":
      case "thread/status/changed":
      case "thread/name/updated":
      case "hook/started":
      case "hook/completed":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "serverRequest/resolved":
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
        // changes come via item notifications; send what we have
        this.send({
          type: "approval_file",
          id: approvalId,
          reason: p.reason ?? undefined,
          changes: [],
        });
        const decision = await this.waitForApproval(approvalId);
        this.rpcRespond(msg.id, { decision });
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
          status: raw.status === "completed" ? "completed" : raw.status === "failed" ? "failed" : raw.status === "running" ? "running" : "pending",
        };
      case "fileChange":
        return {
          id: raw.id, type: "fileChange",
          changes: (raw.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind, diff: c.diff ?? "" })),
          status: raw.status === "failed" ? "failed" : "completed",
        };
      case "mcpToolCall":
        return {
          id: raw.id, type: "mcpToolCall",
          server: raw.server ?? "", tool: raw.tool ?? "",
          status: raw.status ?? "in_progress",
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
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", async (ws) => {
  const cwd = process.cwd();
  const { model } = readConfig();
  const session = new CodexSession(ws, cwd, model);

  try {
    await session.start();
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: String(err) } as ServerMsg));
    session.close();
    return;
  }

  ws.on("message", async (raw) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

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
      case "approve":
        session.respondApproval(msg.id, msg.decision);
        break;
      case "slash":
        await session.handleSlash(msg.name, msg.args);
        break;
      case "fs_list":
        session.listFiles(msg.path);
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
    }
  });

  ws.on("close", () => session.close());
});

httpServer.listen(PORT, () => {
  console.log(`codex-web server running at http://localhost:${PORT}`);
  if (isProd) console.log("  Serving built client from dist/client/");
  else console.log("  Dev mode: frontend at http://localhost:5173");
});
