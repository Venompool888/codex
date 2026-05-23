import type {
  ApprovalDecision,
  ClientMsg,
  ConfigKey,
  FileMention,
  JsonValue,
  McpElicitationAction,
  ReasoningEffort,
} from "../../shared.js";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
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

export function isJsonValue(value: unknown): value is JsonValue {
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

export function parseClientMsg(raw: string): ClientMsg | null {
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
