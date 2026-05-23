// ── Product model ─────────────────────────────────────────────────────────────
export type WorkspaceRef = {
  cwd: string;
  label: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  workspace: WorkspaceRef;
  updatedAt: number;
  favorite: boolean;
  tags: string[];
};

export type ProjectDetail = ProjectSummary & {
  defaultView: "chat" | "tasks" | "files" | "search" | "options" | "settings";
};

export type TaskRunStatus = "idle" | "running" | "completed" | "failed" | "interrupted";

export type TaskEvent = {
  id: string;
  type: "command" | "message" | "fileChange" | "error";
  title: string;
  detail: string;
  createdAt: number;
};

export type TaskRun = {
  id: string;
  projectId: string;
  status: TaskRunStatus;
  title: string;
  command: string | null;
  cwd: string;
  startedAt: number | null;
  completedAt: number | null;
  events: TaskEvent[];
};

// ── Browser → Server ─────────────────────────────────────────────────────────
export type ClientMsg =
  | { type: "send"; text: string; mentions?: FileMention[] }
  | { type: "interrupt" }
  | { type: "new_thread" }
  | { type: "list_threads" }
  | { type: "resume_thread"; threadId: string }
  | { type: "approve"; id: string; decision: ApprovalDecision }
  | { type: "respond_input"; id: string; answers: Record<string, string[]> }
  | { type: "respond_mcp_elicitation"; id: string; action: McpElicitationAction; content: JsonValue | null }
  | { type: "slash"; name: string; args: string }
  | { type: "fs_list"; path: string }
  | { type: "fuzzy_file_search"; query: string }
  | { type: "set_model"; model: string }
  | { type: "set_effort"; effort: ReasoningEffort }
  | { type: "list_models" }
  | { type: "read_config" }
  | { type: "write_config"; key: ConfigKey; value: string }
  | { type: "list_mcp" };

export type FileMention = { name: string; path: string };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

// ── Server → Browser ─────────────────────────────────────────────────────────
export type ServerMsg =
  | { type: "connected"; threadId: string; cwd: string; model: string }
  | { type: "startup_failed"; message: string; detail?: string }
  | { type: "threads_list"; threads: ThreadSummary[]; nextCursor: string | null }
  | { type: "thread_history"; threadId: string; entries: SerializedHistoryEntry[] }
  | { type: "turn_started"; turnId: string }
  | { type: "turn_completed"; turnId: string; usage: TokenUsage | null }
  | { type: "token_usage"; turnId: string; usage: TokenUsage }
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
  | { type: "approval_file"; id: string; reason?: string; grantRoot?: string; changes: FileChange[] }
  | { type: "approval_file_updated"; id: string; changes: FileChange[] }
  | { type: "input_request"; request: InputRequest }
  | { type: "input_resolved"; id: string }
  | { type: "mcp_elicitation"; request: McpElicitationRequest }
  // slash command results
  | { type: "slash_result"; name: string; content: string }
  // fs listing
  | { type: "fs_list_result"; path: string; entries: FsEntry[] }
  | { type: "fuzzy_file_search_result"; query: string; files: FileSearchResult[] }
  | { type: "settings"; model: string; effort: ReasoningEffort }
  | { type: "models_list"; models: ModelInfo[] }
  | { type: "config_state"; config: ConfigState }
  | { type: "mcp_statuses"; servers: McpServerSummary[] }
  | { type: "mcp_status_update"; server: McpStartupSummary }
  | { type: "error"; message: string };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ConfigKey = "model" | "model_reasoning_effort" | "approval_policy" | "sandbox_mode" | "web_search";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never" | "granular";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchMode = "disabled" | "cached" | "live";

export type ConfigState = {
  model: string;
  modelReasoningEffort: ReasoningEffort;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  webSearch: WebSearchMode;
};

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

export type FileSearchResult = {
  name: string;
  path: string;
  root: string;
  score: number;
};

export type ThreadSummary = {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  modelProvider: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  agentNickname: string | null;
  agentRole: string | null;
};

export type SerializedHistoryEntry =
  | { id: string; kind: "user"; text: string; mentions: FileMention[] }
  | {
      id: string;
      kind: "turn";
      items: AppItem[];
      itemOrder: string[];
      usage: TokenUsage | null;
      status: "running" | "done" | "failed" | "interrupted";
      failMessage?: string;
    };

export type InputOption = {
  label: string;
  description: string;
};

export type InputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: InputOption[] | null;
};

export type InputRequest = {
  id: string;
  title: string;
  questions: InputQuestion[];
};

export type McpElicitationAction = "accept" | "decline" | "cancel";

export type McpElicitationRequest =
  | {
      id: string;
      serverName: string;
      turnId: string | null;
      mode: "url";
      message: string;
      url: string;
      elicitationId: string;
    }
  | {
      id: string;
      serverName: string;
      turnId: string | null;
      mode: "form";
      message: string;
      requestedSchema: JsonValue;
    };

export type McpServerSummary = {
  name: string;
  authStatus: string;
  tools: string[];
  resourceCount: number;
  resourceTemplateCount: number;
  startupStatus?: string;
  error?: string | null;
};

export type McpStartupSummary = {
  name: string;
  startupStatus: string;
  error: string | null;
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
  status: "pending" | "running" | "completed" | "failed" | "declined";
};
export type McpToolCallItem = {
  id: string; type: "mcpToolCall";
  server: string; tool: string;
  status: "in_progress" | "completed" | "failed";
  error?: string;
  progress?: string[];
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
