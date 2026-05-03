import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMsg, ServerMsg, AppItem, TokenUsage,
  ApprovalDecision, ConfigKey, ConfigState, FileMention, FileSearchResult,
  InputRequest, JsonValue, McpElicitationAction, McpElicitationRequest,
  McpServerSummary, ReasoningEffort, ModelInfo, SerializedHistoryEntry,
  ThreadSummary,
} from "../shared";

// ── Data shapes ───────────────────────────────────────────────────────────────
export type UserEntry = { id: string; kind: "user"; text: string; mentions: FileMention[] };

export type TurnEntry = {
  id: string; kind: "turn";
  items: Map<string, AppItem>;
  itemOrder: string[];
  usage: TokenUsage | null;
  status: "running" | "done" | "failed" | "interrupted";
  failMessage?: string;
};

export type SlashResultEntry = { id: string; kind: "slash"; name: string; content: string };

export type ChatEntry = UserEntry | TurnEntry | SlashResultEntry;

export type ApprovalRequest =
  | { kind: "cmd"; id: string; command: string; cwd: string; reason?: string }
  | { kind: "file"; id: string; reason?: string; grantRoot?: string; changes: import("../shared").FileChange[] };

let seq = 0;
const uid = () => `${Date.now()}-${++seq}`;

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useCodexWs() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<FileSearchResult[]>([]);
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const [mcpElicitation, setMcpElicitation] = useState<McpElicitationRequest | null>(null);

  // pending turn ID for routing deltas / completion
  const currentTurnEntryId = useRef<string | null>(null);
  const currentTurnServerId = useRef<string | null>(null);
  const turnEntryIds = useRef(new Map<string, string>());

  // input history
  const inputHistory = useRef<string[]>([]);
  const historyIdx = useRef(-1);

  function pushHistory(text: string) {
    if (text && inputHistory.current[0] !== text) {
      inputHistory.current.unshift(text);
      if (inputHistory.current.length > 200) inputHistory.current.pop();
    }
    historyIdx.current = -1;
  }
  function historyUp(current: string): string | null {
    const h = inputHistory.current;
    if (!h.length) return null;
    const next = Math.min(historyIdx.current + 1, h.length - 1);
    historyIdx.current = next;
    return h[next];
  }
  function historyDown(): string {
    if (historyIdx.current <= 0) { historyIdx.current = -1; return ""; }
    historyIdx.current -= 1;
    return inputHistory.current[historyIdx.current];
  }
  function resetHistoryIdx() { historyIdx.current = -1; }

  function deserializeHistory(entries: SerializedHistoryEntry[]): ChatEntry[] {
    return entries.map((entry): ChatEntry => {
      if (entry.kind === "user") return entry;
      return {
        ...entry,
        items: new Map(entry.items.map(item => [item.id, item])),
      };
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function upsertItem(entryId: string, item: AppItem) {
    setEntries(prev =>
      prev.map(e => {
        if (e.kind !== "turn" || e.id !== entryId) return e;
        const items = new Map(e.items);
        const existing = items.get(item.id);
        const nextItem = mergeItem(existing, item);
        items.set(item.id, nextItem);
        const itemOrder = e.itemOrder.includes(item.id)
          ? e.itemOrder : [...e.itemOrder, item.id];
        return { ...e, items, itemOrder };
      })
    );
  }

  function mergeItem(existing: AppItem | undefined, incoming: AppItem): AppItem {
    if (!existing) return incoming;
    if (existing.type === "mcpToolCall" && incoming.type === "mcpToolCall") {
      return {
        ...existing,
        ...incoming,
        server: incoming.server || existing.server,
        tool: incoming.tool || existing.tool,
        progress: [...(existing.progress ?? []), ...(incoming.progress ?? [])],
      };
    }
    return incoming;
  }

  function applyDelta(entryId: string, itemId: string, field: "text" | "aggregatedOutput", delta: string) {
    setEntries(prev =>
      prev.map(e => {
        if (e.kind !== "turn" || e.id !== entryId) return e;
        const items = new Map(e.items);
        const existing = items.get(itemId);
        if (existing) {
          const updated = { ...existing, [field]: ((existing as any)[field] ?? "") + delta } as AppItem;
          items.set(itemId, updated);
        } else {
          // create placeholder
          const placeholder: AppItem = field === "text"
            ? { id: itemId, type: "agentMessage", text: delta }
            : { id: itemId, type: "commandExecution", command: "", cwd: "", aggregatedOutput: delta, exitCode: null, durationMs: null, status: "running" };
          items.set(itemId, placeholder);
        }
        const itemOrder = e.itemOrder.includes(itemId) ? e.itemOrder : [...e.itemOrder, itemId];
        return { ...e, items, itemOrder };
      })
    );
  }

  function entryIdForTurn(turnId: string): string | null {
    return turnEntryIds.current.get(turnId) ?? (
      currentTurnServerId.current === turnId ? currentTurnEntryId.current : null
    );
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    const wsUrl = new URL("/ws", location.href);
    wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const token = new URLSearchParams(location.search).get("token");
    if (token) wsUrl.searchParams.set("token", token);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Wait for the app-server thread to finish initializing before enabling UI actions.
      setConnected(false);
    };
    ws.onclose = () => { setConnected(false); setThinking(false); };

    ws.onmessage = ev => {
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }

      switch (msg.type) {
        case "connected":
          setConnected(true);
          setThreadId(msg.threadId);
          setModel(msg.model);
          setCwd(msg.cwd);
          break;

        case "threads_list":
          setThreads(msg.threads);
          break;

        case "thread_history":
          setEntries(deserializeHistory(msg.entries));
          currentTurnEntryId.current = null;
          currentTurnServerId.current = null;
          turnEntryIds.current.clear();
          break;

        case "turn_started": {
          const entryId = uid();
          currentTurnEntryId.current = entryId;
          currentTurnServerId.current = msg.turnId;
          turnEntryIds.current.set(msg.turnId, entryId);
          setThinking(true);
          setEntries(prev => [...prev, {
            id: entryId, kind: "turn",
            items: new Map(), itemOrder: [],
            usage: null, status: "running",
          }]);
          break;
        }

        case "turn_completed": {
          setThinking(false);
          const eid = entryIdForTurn(msg.turnId);
          if (eid) {
            setEntries(prev => prev.map(e =>
              e.kind === "turn" && e.id === eid
                ? { ...e, status: "done", usage: msg.usage ?? e.usage }
                : e
            ));
          }
          turnEntryIds.current.delete(msg.turnId);
          if (currentTurnServerId.current === msg.turnId) {
            currentTurnEntryId.current = null;
            currentTurnServerId.current = null;
          }
          break;
        }

        case "token_usage": {
          const eid = entryIdForTurn(msg.turnId);
          if (eid) {
            setEntries(prev => prev.map(e =>
              e.kind === "turn" && e.id === eid
                ? { ...e, usage: msg.usage }
                : e
            ));
          }
          break;
        }

        case "turn_failed": {
          setThinking(false);
          const eid = entryIdForTurn(msg.turnId);
          if (eid) {
            setEntries(prev => prev.map(e =>
              e.kind === "turn" && e.id === eid
                ? { ...e, status: msg.message === "已中断" ? "interrupted" : "failed", failMessage: msg.message }
                : e
            ));
          }
          turnEntryIds.current.delete(msg.turnId);
          if (currentTurnServerId.current === msg.turnId) {
            currentTurnEntryId.current = null;
            currentTurnServerId.current = null;
          }
          break;
        }

        case "item_started":
        case "item_updated":
        case "item_completed": {
          const eid = entryIdForTurn(msg.turnId);
          if (eid) upsertItem(eid, msg.item);
          break;
        }

        case "agent_delta": {
          const eid = entryIdForTurn(msg.turnId);
          if (eid) applyDelta(eid, msg.itemId, "text", msg.delta);
          break;
        }

        case "cmd_delta": {
          const eid = entryIdForTurn(msg.turnId);
          if (eid) applyDelta(eid, msg.itemId, "aggregatedOutput", msg.delta);
          break;
        }

        case "reasoning_delta": {
          const eid = entryIdForTurn(msg.turnId);
          if (eid) applyDelta(eid, msg.itemId, "text", msg.delta);
          break;
        }

        case "approval_cmd":
          setApproval({ kind: "cmd", id: msg.id, command: msg.command, cwd: msg.cwd, reason: msg.reason });
          break;

        case "approval_file":
          setApproval({ kind: "file", id: msg.id, reason: msg.reason, grantRoot: msg.grantRoot, changes: msg.changes });
          break;

        case "approval_file_updated":
          setApproval(prev => prev?.kind === "file" && prev.id === msg.id
            ? { ...prev, changes: msg.changes }
            : prev);
          break;

        case "input_request":
          setInputRequest(msg.request);
          break;

        case "input_resolved":
          setInputRequest(prev => prev?.id === msg.id ? null : prev);
          setMcpElicitation(prev => prev?.id === msg.id ? null : prev);
          break;

        case "slash_result":
          setEntries(prev => [...prev, { id: uid(), kind: "slash", name: msg.name, content: msg.content }]);
          break;

        case "fuzzy_file_search_result":
          setFileSearchQuery(msg.query);
          setFileSearchResults(msg.files);
          break;

        case "settings":
          setModel(msg.model);
          setEffort(msg.effort);
          break;

        case "models_list":
          setModels(msg.models);
          break;

        case "config_state":
          setConfig(msg.config);
          break;

        case "mcp_statuses":
          setMcpServers(msg.servers);
          break;

        case "mcp_status_update":
          setMcpServers(prev => {
            const idx = prev.findIndex(server => server.name === msg.server.name);
            if (idx === -1) {
              return [...prev, {
                name: msg.server.name,
                authStatus: "unknown",
                tools: [],
                resourceCount: 0,
                resourceTemplateCount: 0,
                startupStatus: msg.server.startupStatus,
                error: msg.server.error,
              }];
            }
            return prev.map(server => server.name === msg.server.name
              ? { ...server, startupStatus: msg.server.startupStatus, error: msg.server.error }
              : server);
          });
          break;

        case "mcp_elicitation":
          setMcpElicitation(msg.request);
          break;

        case "error":
          setThinking(false);
          setEntries(prev => [...prev, {
            id: uid(), kind: "turn",
            items: new Map([["e", { id: "e", type: "error", message: msg.message }]]),
            itemOrder: ["e"], usage: null, status: "failed",
          }]);
          break;
      }
    };

    return () => ws.close();
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────
  const rawSend = useCallback((m: ClientMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(m));
  }, []);

  const send = useCallback((text: string, mentions: FileMention[] = []) => {
    pushHistory(text);
    setEntries(prev => [...prev, { id: uid(), kind: "user", text, mentions }]);
    rawSend({ type: "send", text, mentions });
  }, [rawSend]);

  const interrupt = useCallback(() => rawSend({ type: "interrupt" }), [rawSend]);

  const newThread = useCallback(() => {
    setEntries([]);
    setThreadId(null);
    setConnected(false);
    setThinking(false);
    setApproval(null);
    setInputRequest(null);
    setMcpElicitation(null);
    currentTurnEntryId.current = null;
    currentTurnServerId.current = null;
    turnEntryIds.current.clear();
    rawSend({ type: "new_thread" });
  }, [rawSend]);

  const listThreads = useCallback(() => {
    rawSend({ type: "list_threads" });
  }, [rawSend]);

  const resumeThread = useCallback((id: string) => {
    setEntries([]);
    setThreadId(id);
    setConnected(false);
    setThinking(false);
    setApproval(null);
    setInputRequest(null);
    setMcpElicitation(null);
    currentTurnEntryId.current = null;
    currentTurnServerId.current = null;
    turnEntryIds.current.clear();
    rawSend({ type: "resume_thread", threadId: id });
  }, [rawSend]);

  const respond = useCallback((id: string, decision: ApprovalDecision) => {
    setApproval(null);
    rawSend({ type: "approve", id, decision });
  }, [rawSend]);

  const respondInput = useCallback((id: string, answers: Record<string, string[]>) => {
    setInputRequest(null);
    rawSend({ type: "respond_input", id, answers });
  }, [rawSend]);

  const respondMcpElicitation = useCallback((id: string, action: McpElicitationAction, content: JsonValue | null) => {
    setMcpElicitation(null);
    rawSend({ type: "respond_mcp_elicitation", id, action, content });
  }, [rawSend]);

  const slash = useCallback((name: string, args = "") => {
    rawSend({ type: "slash", name, args });
  }, [rawSend]);

  const listFiles = useCallback((p: string) => {
    rawSend({ type: "fs_list", path: p });
  }, [rawSend]);

  const searchFiles = useCallback((query: string) => {
    setFileSearchQuery(query);
    if (!query.trim()) {
      setFileSearchResults([]);
      return;
    }
    rawSend({ type: "fuzzy_file_search", query });
  }, [rawSend]);

  const changeModel = useCallback((m: string) => {
    rawSend({ type: "set_model", model: m });
  }, [rawSend]);

  const changeEffort = useCallback((e: ReasoningEffort) => {
    rawSend({ type: "set_effort", effort: e });
  }, [rawSend]);

  const listModels = useCallback(() => {
    rawSend({ type: "list_models" });
  }, [rawSend]);

  const readConfig = useCallback(() => {
    rawSend({ type: "read_config" });
  }, [rawSend]);

  const writeConfig = useCallback((key: ConfigKey, value: string) => {
    rawSend({ type: "write_config", key, value });
  }, [rawSend]);

  const listMcp = useCallback(() => {
    rawSend({ type: "list_mcp" });
  }, [rawSend]);

  return {
    connected, thinking, threadId, model, effort, models, cwd, entries, approval,
    threads, fileSearchQuery, fileSearchResults, config, mcpServers, inputRequest, mcpElicitation,
    send, interrupt, newThread, listThreads, resumeThread, respond, respondInput, respondMcpElicitation,
    slash, listFiles, searchFiles,
    changeModel, changeEffort, listModels,
    readConfig, writeConfig, listMcp,
    historyUp, historyDown, resetHistoryIdx,
  };
}
