// ── Browser → Server ─────────────────────────────────────────────────────────
export type ClientMsg =
  | { type: "send"; text: string; mentions?: FileMention[] }
  | { type: "interrupt" }
  | { type: "new_thread" }
  | { type: "approve"; id: string; decision: ApprovalDecision }
  | { type: "slash"; name: string; args: string }
  | { type: "fs_list"; path: string }
  | { type: "set_model"; model: string }
  | { type: "set_effort"; effort: ReasoningEffort }
  | { type: "list_models" };

export type FileMention = { name: string; path: string };

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

// ── Server → Browser ─────────────────────────────────────────────────────────
export type ServerMsg =
  | { type: "connected"; threadId: string; cwd: string; model: string }
  | { type: "turn_started"; turnId: string }
  | { type: "turn_completed"; turnId: string; usage: TokenUsage | null }
  | { type: "turn_failed"; turnId: string; message: string }
  | { type: "item_started"; turnId: string; item: AppItem }
  | { type: "item_updated"; turnId: string; item: AppItem }
  | { type: "item_completed"; turnId: string; item: AppItem }
  // streaming deltas (accumulated by client)
  | { type: "agent_delta"; turnId: string; itemId: string; delta: string }
  | { type: "cmd_delta"; turnId: string; itemId: string; delta: string }
  | { type: "reasoning_delta"; turnId: string; itemId: string; delta: string }
  // approval requests
  | { type: "approval_cmd"; id: string; command: string; cwd: string; reason?: string }
  | { type: "approval_file"; id: string; reason?: string; changes: FileChange[] }
  // slash command results
  | { type: "slash_result"; name: string; content: string }
  // fs listing
  | { type: "fs_list_result"; path: string; entries: FsEntry[] }
  | { type: "settings"; model: string; effort: ReasoningEffort }
  | { type: "models_list"; models: ModelInfo[] }
  | { type: "error"; message: string };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelInfo = {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  isDefault: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type FileChange = {
  path: string;
  kind: "add" | "delete" | "update";
  diff: string;
};

export type FsEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

// ── Item types (mirroring app-server ThreadItem) ──────────────────────────────
export type AppItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoItem
  | ErrorItem;

export type AgentMessageItem = {
  id: string; type: "agentMessage"; text: string;
};
export type ReasoningItem = {
  id: string; type: "reasoning"; text: string;
};
export type CommandExecutionItem = {
  id: string; type: "commandExecution";
  command: string; cwd: string;
  aggregatedOutput: string;
  exitCode: number | null;
  durationMs: number | null;
  status: "pending" | "running" | "completed" | "failed";
};
export type FileChangeItem = {
  id: string; type: "fileChange";
  changes: FileChange[];
  status: "completed" | "failed";
};
export type McpToolCallItem = {
  id: string; type: "mcpToolCall";
  server: string; tool: string;
  status: "in_progress" | "completed" | "failed";
  error?: string;
};
export type WebSearchItem = {
  id: string; type: "webSearch"; query: string;
};
export type TodoItem = {
  id: string; type: "todo";
  items: { text: string; completed: boolean }[];
};
export type ErrorItem = {
  id: string; type: "error"; message: string;
};
