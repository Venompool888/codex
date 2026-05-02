import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMsg, ServerMsg, AppItem, TokenUsage,
  ApprovalDecision, FileMention, ReasoningEffort, ModelInfo,
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
  | { kind: "file"; id: string; reason?: string; changes: import("../shared").FileChange[] };

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

  // pending turn ID for routing deltas / completion
  const currentTurnEntryId = useRef<string | null>(null);
  const currentTurnServerId = useRef<string | null>(null);

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

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function upsertItem(entryId: string, item: AppItem) {
    setEntries(prev =>
      prev.map(e => {
        if (e.kind !== "turn" || e.id !== entryId) return e;
        const items = new Map(e.items);
        items.set(item.id, item);
        const itemOrder = e.itemOrder.includes(item.id)
          ? e.itemOrder : [...e.itemOrder, item.id];
        return { ...e, items, itemOrder };
      })
    );
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

  // ── WebSocket lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => { setConnected(false); setThinking(false); };

    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;

      switch (msg.type) {
        case "connected":
          setThreadId(msg.threadId);
          setModel(msg.model);
          setCwd(msg.cwd);
          break;

        case "turn_started": {
          const entryId = uid();
          currentTurnEntryId.current = entryId;
          currentTurnServerId.current = msg.turnId;
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
          const eid = currentTurnEntryId.current;
          if (eid) {
            setEntries(prev => prev.map(e =>
              e.kind === "turn" && e.id === eid
                ? { ...e, status: "done", usage: msg.usage }
                : e
            ));
          }
          currentTurnEntryId.current = null;
          currentTurnServerId.current = null;
          break;
        }

        case "turn_failed": {
          setThinking(false);
          const eid = currentTurnEntryId.current;
          if (eid) {
            setEntries(prev => prev.map(e =>
              e.kind === "turn" && e.id === eid
                ? { ...e, status: msg.message === "已中断" ? "interrupted" : "failed", failMessage: msg.message }
                : e
            ));
          }
          currentTurnEntryId.current = null;
          currentTurnServerId.current = null;
          break;
        }

        case "item_started":
        case "item_updated":
        case "item_completed": {
          const eid = currentTurnEntryId.current;
          if (eid) upsertItem(eid, msg.item);
          break;
        }

        case "agent_delta": {
          const eid = currentTurnEntryId.current;
          if (eid) applyDelta(eid, msg.itemId, "text", msg.delta);
          break;
        }

        case "cmd_delta": {
          const eid = currentTurnEntryId.current;
          if (eid) applyDelta(eid, msg.itemId, "aggregatedOutput", msg.delta);
          break;
        }

        case "reasoning_delta": {
          const eid = currentTurnEntryId.current;
          if (eid) applyDelta(eid, msg.itemId, "text", msg.delta);
          break;
        }

        case "approval_cmd":
          setApproval({ kind: "cmd", id: msg.id, command: msg.command, cwd: msg.cwd, reason: msg.reason });
          break;

        case "approval_file":
          setApproval({ kind: "file", id: msg.id, reason: msg.reason, changes: msg.changes });
          break;

        case "slash_result":
          setEntries(prev => [...prev, { id: uid(), kind: "slash", name: msg.name, content: msg.content }]);
          break;

        case "settings":
          setModel(msg.model);
          setEffort(msg.effort);
          break;

        case "models_list":
          setModels(msg.models);
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
    setThinking(false);
    setApproval(null);
    currentTurnEntryId.current = null;
    currentTurnServerId.current = null;
    rawSend({ type: "new_thread" });
  }, [rawSend]);

  const respond = useCallback((id: string, decision: ApprovalDecision) => {
    setApproval(null);
    rawSend({ type: "approve", id, decision });
  }, [rawSend]);

  const slash = useCallback((name: string, args = "") => {
    rawSend({ type: "slash", name, args });
  }, [rawSend]);

  const listFiles = useCallback((p: string) => {
    rawSend({ type: "fs_list", path: p });
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

  return {
    connected, thinking, threadId, model, effort, models, cwd, entries, approval,
    send, interrupt, newThread, respond, slash, listFiles,
    changeModel, changeEffort, listModels,
    historyUp, historyDown, resetHistoryIdx,
  };
}
