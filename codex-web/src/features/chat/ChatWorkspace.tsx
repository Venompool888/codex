import { useEffect, useRef, useState, KeyboardEvent, useCallback } from "react";
import { useCodexSession, ConnectionStatus, TurnEntry } from "./CodexSessionContext";
import { ApprovalModal } from "../../ApprovalModal";
import { SlashMenu } from "../../SlashMenu";
import type {
  AppItem, FileMention, FileSearchResult,
  InputRequest, JsonValue, McpElicitationRequest,
  TokenUsage, ReasoningEffort, ModelInfo, ThreadSummary,
} from "../../../shared";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Configure Markdown rendering; HTML is sanitized before insertion.
marked.setOptions({ async: false, breaks: true, gfm: true });

export function ChatWorkspace() {
  const {
    connected, connectionStatus, connectionError, thinking, threadId, model, effort, models, cwd, entries, approval,
    threads, fileSearchResults, inputRequest, mcpElicitation,
    send, interrupt, newThread, listThreads, resumeThread, respond, respondInput, respondMcpElicitation,
    slash, searchFiles,
    changeModel, changeEffort, listModels,
    historyUp, historyDown, resetHistoryIdx,
  } = useCodexSession();

  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<FileMention[]>([]);
  const [showSlash, setShowSlash] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showThreads, setShowThreads] = useState(() => !isCompactViewport());
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, thinking]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const applyViewport = (event: MediaQueryList | MediaQueryListEvent) => {
      setShowThreads(!event.matches);
    };
    applyViewport(query);
    query.addEventListener("change", applyViewport);
    return () => query.removeEventListener("change", applyViewport);
  }, []);

  const activeMention = mentionQuery(input);
  useEffect(() => {
    if (activeMention) searchFiles(activeMention.query);
    else searchFiles("");
  }, [activeMention?.query, searchFiles]);

  function handleSubmit() {
    const text = input.trim();
    if (!text || !connected) return;

    // slash commands
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(" ");
      if (cmd === "new" || cmd === "clear") { setInput(""); setMentions([]); newThread(); return; }
      setInput("");
      setMentions([]);
      slash(cmd, rest.join(" "));
      return;
    }

    if (thinking) return;
    setInput("");
    const outgoingMentions = mentions.filter(m => text.includes(`@${m.name}`) || text.includes(m.path));
    setMentions([]);
    send(text, outgoingMentions);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showSlash) {
      if (e.key === "Escape") { e.preventDefault(); setShowSlash(false); return; }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); return; }
    if (e.key === "ArrowUp" && !input) {
      e.preventDefault();
      const v = historyUp(input);
      if (v !== null) setInput(v);
      return;
    }
    if (e.key === "ArrowDown" && !input) {
      e.preventDefault();
      setInput(historyDown());
      return;
    }
    resetHistoryIdx();
  }

  function handleInput(v: string) {
    setInput(v);
    setShowSlash(v.startsWith("/") && !v.includes(" "));
  }

  function onMentionSelect(file: FileSearchResult) {
    const token = mentionQuery(input);
    if (!token) return;
    const absolutePath = file.path.startsWith("/") ? file.path : `${file.root.replace(/\/$/, "")}/${file.path}`;
    const next = `${input.slice(0, token.start)}@${file.name} ${input.slice(token.end)}`;
    setInput(next);
    setMentions(prev => [...prev.filter(m => m.path !== absolutePath), { name: file.name, path: absolutePath }]);
    searchFiles("");
    textareaRef.current?.focus();
  }

  function onSlashSelect(name: string) {
    setShowSlash(false);
    setMentions([]);
    if (name === "new") { setInput(""); newThread(); return; }
    setInput("");
    slash(name, "");
  }

  function openModelPicker() {
    listModels();
    setShowModelPicker(true);
  }

  const shortCwd = cwd.replace(/^\/root(?=\/|$)/, "~");
  const statusLabel = connectionStatus === "connected" ? "已连接"
    : connectionStatus === "failed" ? "初始化失败" : "连接中";

  return (
    <div className="chat-workspace">
      <header>
        <span className="brand">Codex Remote</span>
        <span className={`dot ${connectionStatus}`} title={statusLabel} />
        <span className={`status-label s-${connectionStatus}`}>{statusLabel}</span>
        <div className="header-meta">
          <span className="hinfo session-label">Session</span>
          {threadId && <><span className="hsep">·</span><span className="hinfo mono">#{threadId.slice(0, 8)}</span></>}
          <span className="hsep">·</span>
          <button className="hbtn-model" onClick={openModelPicker} title="切换模型" disabled={!connected}>
            {model || "…"}
          </button>
          <span className="hsep">·</span>
          <EffortPills effort={effort} onChange={changeEffort} disabled={!connected} />
          <span className="hsep">·</span>
          <span className="hinfo cwd" title={cwd}>{shortCwd}</span>
        </div>
        <div className="header-actions">
          <button className="btn-icon" onClick={() => { listThreads(); setShowThreads(true); }} title="Session 列表" aria-label="Session 列表" disabled={!connected}>☰</button>
          <button className="btn-icon" onClick={newThread} title="新建 Session" aria-label="新建 Session" disabled={!connected}>＋</button>
          <button className="btn-icon" onClick={interrupt} title="中断任务" aria-label="中断任务" disabled={!connected || !thinking}>■</button>
          <button className="btn-icon" onClick={() => slash("diff")} title="/diff" aria-label="Diff" disabled={!connected}>±</button>
          <button className="btn-icon" onClick={() => slash("status")} title="/status" aria-label="状态" disabled={!connected}>ⓘ</button>
        </div>
      </header>

      <div className="workbench">
        {showThreads && (
          <ThreadSidebar
            threads={threads}
            currentThreadId={threadId}
            onRefresh={listThreads}
            onResume={resumeThread}
            disabled={!connected || thinking}
          />
        )}

        <main className="main-panel">
          <div className="messages">
            {entries.length === 0 && (
              <div className="empty">
                {connectionStatus === "failed"
                  ? <ConnectionErrorPanel message={connectionError} />
                  : (
                    <WorkspaceEmpty
                      status={connectionStatus}
                      model={model || "pending"}
                      cwd={shortCwd || "loading"}
                      disabled={!connected || thinking}
                      onSend={send}
                    />
                  )
                }
              </div>
            )}
            {entries.map(e =>
              e.kind === "user" ? <UserBubble key={e.id} text={e.text} mentions={e.mentions} /> :
              e.kind === "slash" ? <SlashResult key={e.id} name={e.name} content={e.content} /> :
              <TurnBlock key={e.id} turn={e} />
            )}
            {thinking && <ThinkingDots />}
            <div ref={bottomRef} />
          </div>

          <footer>
            <div className="input-wrap">
              {showSlash && (
                <SlashMenu
                  query={input.slice(1)}
                  onSelect={onSlashSelect}
                  onClose={() => setShowSlash(false)}
                />
              )}
              {activeMention && fileSearchResults.length > 0 && (
                <FileMentionMenu files={fileSearchResults} onSelect={onMentionSelect} />
              )}
              <form className="input-bar" onSubmit={e => { e.preventDefault(); handleSubmit(); }}>
                <div className="composer-main">
                  {mentions.length > 0 && (
                    <div className="mention-chips">
                      {mentions.map(m => (
                        <span key={m.path} className="mention-chip" title={m.path}>@{m.name}</span>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => handleInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={thinking ? "AI 思考中..." : "输入消息，/ 命令，@ 文件，↑↓ 历史"}
                    rows={1}
                    disabled={!connected}
                  />
                </div>
                {thinking
                  ? <button type="button" className="btn-interrupt" onClick={interrupt} title="中断">■</button>
                  : <button type="submit" className="btn-send" disabled={!connected || !input.trim()}>发送</button>
                }
              </form>
            </div>
          </footer>
        </main>
      </div>

      {approval && <ApprovalModal req={approval} onDecide={respond} />}
      {inputRequest && <InputRequestModal request={inputRequest} onSubmit={respondInput} />}
      {mcpElicitation && <McpElicitationModal request={mcpElicitation} onRespond={respondMcpElicitation} />}
      {showModelPicker && (
        <ModelPicker
          models={models}
          current={model}
          onSelect={m => { changeModel(m); setShowModelPicker(false); }}
          onClose={() => setShowModelPicker(false)}
        />
      )}
    </div>
  );
}

// ── Entry components ──────────────────────────────────────────────────────────
function UserBubble({ text, mentions }: { text: string; mentions: FileMention[] }) {
  return (
    <div className="entry user-entry">
      <div className="elabel">你</div>
      <div className="user-bubble-wrap">
        {mentions.length > 0 && (
          <div className="user-mentions">
            {mentions.map(m => <span key={m.path} title={m.path}>@{m.name}</span>)}
          </div>
        )}
        <pre className="user-text">{text}</pre>
        <CopyBtn text={text} />
      </div>
    </div>
  );
}

function SlashResult({ name, content }: { name: string; content: string }) {
  return (
    <div className="entry slash-entry">
      <div className="elabel">/{name}</div>
      <pre className="slash-content">{content}</pre>
    </div>
  );
}

function TurnBlock({ turn }: { turn: TurnEntry }) {
  const items = turn.itemOrder.map(id => turn.items.get(id)!).filter(Boolean);
  return (
    <div className={`entry turn-entry s-${turn.status}`}>
      {items.map(item => <ItemView key={item.id} item={item} />)}
      {(turn.status === "failed" || turn.status === "interrupted") && (
        <div className="turn-fail">
          {turn.status === "interrupted" ? "⚡ 已中断" : `✗ ${turn.failMessage ?? "失败"}`}
        </div>
      )}
      {turn.status === "done" && turn.usage && <UsageLine u={turn.usage} />}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="copy-btn" onClick={copy} title="复制">
      {copied ? "✓" : "⧉"}
    </button>
  );
}

function AgentMsg({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text) as string, {
    USE_PROFILES: { html: true },
  });
  return (
    <div className="item agent-msg">
      <span className="agent-msg-header"><CopyBtn text={text} /></span>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function ItemView({ item }: { item: AppItem }) {
  switch (item.type) {
    case "agentMessage":
      return <AgentMsg text={item.text} />;

    case "reasoning":
      return (
        <details className="item reasoning">
          <summary>
            思考过程
            <span className="reasoning-len">{item.text.length > 1000 ? ` · ${Math.round(item.text.length / 100) / 10}k chars` : ""}</span>
          </summary>
          <pre>{item.text}</pre>
        </details>
      );

    case "commandExecution":
      return (
        <div className={`item cmd s-${item.status}`}>
          <div className="iheader">
            <span className="iicon">$</span>
            <code className="cmd-line">{item.command}</code>
            <span className="ibadge">{cmdBadge(item.status, item.exitCode, item.durationMs)}</span>
          </div>
          {item.aggregatedOutput && <pre className="cmd-out">{item.aggregatedOutput}</pre>}
        </div>
      );

    case "fileChange":
      return (
        <div className={`item file-change s-${item.status}`}>
          <div className="iheader">
            <span className="iicon">F</span>
            <span>文件修改</span>
            <span className="ibadge">{fileBadge(item.status)}</span>
          </div>
          {item.changes.map((c, i) => (
            <div key={i} className="file-item">
              <span className={`fkind fk-${c.kind}`}>{c.kind === "add" ? "+" : c.kind === "delete" ? "−" : "~"}</span>
              <code>{c.path}</code>
              {c.diff && (
                <details className="diff-inline">
                  <summary>查看 diff</summary>
                  <pre className="diff-content">{renderDiffLines(c.diff)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      );

    case "mcpToolCall":
      return (
        <div className={`item mcp s-${item.status}`}>
          <div className="iheader">
            <span className="iicon">M</span>
            <code>{item.server} · {item.tool}</code>
            <span className="ibadge">{item.status === "in_progress" ? "…" : item.status === "completed" ? "✓" : "✗"}</span>
          </div>
          {item.progress && item.progress.length > 0 && (
            <div className="mcp-progress">
              {item.progress.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
          {item.error && <pre className="cmd-out err">{item.error}</pre>}
        </div>
      );

    case "webSearch":
      return (
        <div className="item web-search">
          <div className="iheader"><span className="iicon">S</span><span>搜索</span></div>
          <code>{item.query}</code>
        </div>
      );

    case "todo":
      return (
        <div className="item todo">
          <div className="iheader"><span className="iicon">T</span><span>计划</span></div>
          <ul>{item.items.map((t, i) => (
            <li key={i} className={t.completed ? "done" : ""}>
              <span>{t.completed ? "✓" : "○"}</span> {t.text}
            </li>
          ))}</ul>
        </div>
      );

    case "error":
      return <div className="item item-err"><span>✗</span> {item.message}</div>;

    default:
      return null;
  }
}

function UsageLine({ u }: { u: TokenUsage }) {
  return (
    <div className="usage">
      ↑{u.inputTokens.toLocaleString()}
      {u.cachedInputTokens > 0 && <span className="cached"> ({u.cachedInputTokens.toLocaleString()} 缓存)</span>}
      {" "}↓{u.outputTokens.toLocaleString()}
      {u.reasoningOutputTokens > 0 && <span className="rtok"> +{u.reasoningOutputTokens.toLocaleString()} 推理</span>}
      {" · "}{u.totalTokens.toLocaleString()} 共
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="entry turn-entry thinking">
      <div className="dots"><span /><span /><span /></div>
    </div>
  );
}

function WorkspaceEmpty({ status, model, cwd, disabled, onSend }: {
  status: ConnectionStatus;
  model: string;
  cwd: string;
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const actions = [
    { label: "解释目录", prompt: "解释当前目录结构" },
    { label: "git 状态", prompt: "查看 git 状态" },
    { label: "查 TODO", prompt: "有哪些 TODO" },
  ];
  return (
    <>
      <div className="empty-main">
        <div className="empty-kicker">{status === "connecting" ? "Preparing session" : "Workspace ready"}</div>
        <p>Codex Web</p>
        <p className="empty-hint">{status === "connecting" ? "正在初始化 app-server" : "在当前工作区开始一次任务"}</p>
        <div className="empty-suggestions">
          {actions.map(action => (
            <button
              key={action.label}
              className="suggestion-chip"
              onClick={() => onSend(action.prompt)}
              disabled={disabled}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
      <div className="empty-context" aria-label="当前上下文">
        <div>
          <span>model</span>
          <strong>{model}</strong>
        </div>
        <div>
          <span>cwd</span>
          <strong>{cwd}</strong>
        </div>
      </div>
    </>
  );
}

function ConnectionErrorPanel({ message }: { message: string }) {
  return (
    <div className="connection-error" role="alert">
      <p>app-server 初始化失败</p>
      <pre>{message || "连接关闭，未收到初始化结果。"}</pre>
      <button className="mini-btn" onClick={() => window.location.reload()}>重试</button>
    </div>
  );
}

function cmdBadge(status: string, exit: number | null, ms: number | null) {
  const t = ms ? ` ${(ms / 1000).toFixed(1)}s` : "";
  if (status === "running") return "…";
  if (status === "completed") return exit === 0 ? `✓${t}` : `✗ ${exit}${t}`;
  if (status === "failed") return "✗";
  return status;
}

function fileBadge(status: string) {
  if (status === "running" || status === "pending") return "…";
  if (status === "completed") return "✓";
  if (status === "declined") return "已拒绝";
  return "✗";
}

function renderDiffLines(diff: string): React.ReactNode {
  return diff.split("\n").map((line, i) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "diff-add"
      : line.startsWith("-") && !line.startsWith("---") ? "diff-del"
      : line.startsWith("@@") ? "diff-hunk" : "diff-ctx";
    return <span key={i} className={cls}>{line + "\n"}</span>;
  });
}

// ── Side panels and request modals ───────────────────────────────────────────
function ThreadSidebar({ threads, currentThreadId, onRefresh, onResume, disabled }: {
  threads: ThreadSummary[];
  currentThreadId: string | null;
  onRefresh: () => void;
  onResume: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <aside className="thread-sidebar">
      <div className="side-title">
        <span>Session</span>
        <button className="mini-btn" onClick={onRefresh} disabled={disabled}>刷新</button>
      </div>
      <div className="thread-list">
        {threads.length === 0 && <div className="side-empty">暂无 Session 历史</div>}
        {threads.map(thread => (
          <button
            key={thread.id}
            className={`thread-row ${thread.id === currentThreadId ? "active" : ""}`}
            onClick={() => onResume(thread.id)}
            disabled={disabled || thread.id === currentThreadId}
            title={thread.cwd}
          >
            <span className="thread-title">{thread.name || thread.preview || "未命名 Session"}</span>
            <span className="thread-meta">{formatDate(thread.updatedAt)} · {thread.status}</span>
            <span className="thread-id">#{thread.id.slice(0, 8)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function FileMentionMenu({ files, onSelect }: {
  files: FileSearchResult[];
  onSelect: (file: FileSearchResult) => void;
}) {
  return (
    <div className="file-mention-menu">
      {files.map(file => (
        <button key={`${file.root}:${file.path}`} className="file-mention-item" onClick={() => onSelect(file)} type="button">
          <span className="file-name">@{file.name}</span>
          <span className="file-path">{file.path}</span>
        </button>
      ))}
    </div>
  );
}

function InputRequestModal({ request, onSubmit }: {
  request: InputRequest;
  onSubmit: (id: string, answers: Record<string, string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  function setAnswer(id: string, value: string) {
    setAnswers(prev => ({ ...prev, [id]: [value] }));
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">{request.title}</div>
        {request.questions.map(q => (
          <div key={q.id} className="input-question">
            <div className="modal-section-label">{q.header || q.id}</div>
            <div className="question-text">{q.question}</div>
            {q.options && q.options.length > 0 ? (
              <div className="option-list">
                {q.options.map(option => (
                  <button
                    key={option.label}
                    className={`option-btn ${(answers[q.id] ?? []).includes(option.label) ? "active" : ""}`}
                    onClick={() => setAnswer(q.id, option.label)}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
                {q.isOther && (
                  <input
                    className="answer-input"
                    placeholder="其他"
                    onChange={e => setAnswer(q.id, e.target.value)}
                  />
                )}
              </div>
            ) : (
              <input
                className="answer-input"
                type={q.isSecret ? "password" : "text"}
                onChange={e => setAnswer(q.id, e.target.value)}
              />
            )}
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn-approve" onClick={() => onSubmit(request.id, answers)}>提交</button>
        </div>
      </div>
    </div>
  );
}

function McpElicitationModal({ request, onRespond }: {
  request: McpElicitationRequest;
  onRespond: (id: string, action: "accept" | "decline" | "cancel", content: JsonValue | null) => void;
}) {
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const fields = request.mode === "form" ? schemaFields(request.requestedSchema) : [];

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">MCP 请求 · {request.serverName}</div>
        <div className="modal-reason">{request.message}</div>
        {request.mode === "url" ? (
          <a className="external-link" href={request.url} target="_blank" rel="noreferrer">{request.url}</a>
        ) : (
          fields.map(field => (
            <label key={field.name} className="config-field">
              <span>{field.title || field.name}</span>
              {field.description && <small>{field.description}</small>}
              {field.options.length > 0 ? (
                <select value={String(values[field.name] ?? field.defaultValue ?? "")} onChange={e => setValues(prev => ({ ...prev, [field.name]: e.target.value }))}>
                  <option value="">选择</option>
                  {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.type === "boolean" ? (
                <select value={String(values[field.name] ?? field.defaultValue ?? "false")} onChange={e => setValues(prev => ({ ...prev, [field.name]: e.target.value === "true" }))}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  type={field.type === "number" ? "number" : "text"}
                  value={String(values[field.name] ?? field.defaultValue ?? "")}
                  onChange={e => setValues(prev => ({ ...prev, [field.name]: field.type === "number" ? Number(e.target.value) : e.target.value }))}
                />
              )}
            </label>
          ))
        )}
        <div className="modal-actions">
          <button className="btn-approve" onClick={() => onRespond(request.id, "accept", request.mode === "form" ? values : null)}>允许</button>
          <button className="btn-reject" onClick={() => onRespond(request.id, "decline", null)}>拒绝</button>
          <button className="btn-reject" onClick={() => onRespond(request.id, "cancel", null)}>取消</button>
        </div>
      </div>
    </div>
  );
}

function formatDate(seconds: number) {
  if (!seconds) return "未知时间";
  return new Date(seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isCompactViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
}

function mentionQuery(text: string): { query: string; start: number; end: number } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text);
  if (!match) return null;
  const prefixLength = match[1]?.length ?? 0;
  const start = match.index + prefixLength;
  return { query: match[2] ?? "", start, end: text.length };
}

function schemaFields(schema: JsonValue): Array<{
  name: string;
  title: string;
  description: string;
  type: string;
  defaultValue: JsonValue | undefined;
  options: Array<{ value: string; label: string }>;
}> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const schemaRecord = schema as Record<string, JsonValue | undefined>;
  const properties = schemaRecord.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const value = raw as Record<string, JsonValue | undefined>;
    return [{
      name,
      title: typeof value.title === "string" ? value.title : "",
      description: typeof value.description === "string" ? value.description : "",
      type: typeof value.type === "string" ? value.type : "string",
      defaultValue: value.default,
      options: enumOptions(value),
    }];
  });
}

function enumOptions(schema: Record<string, JsonValue | undefined>): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    return schema.enum.filter((v): v is string => typeof v === "string").map(value => ({ value, label: value }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap(option => {
      if (!option || typeof option !== "object" || Array.isArray(option)) return [];
      const record = option as Record<string, JsonValue | undefined>;
      return typeof record.const === "string"
        ? [{ value: record.const, label: typeof record.title === "string" ? record.title : record.const }]
        : [];
    });
  }
  return [];
}

// ── EffortPills ───────────────────────────────────────────────────────────────
const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

function EffortPills({ effort, onChange, disabled }: {
  effort: ReasoningEffort;
  onChange: (e: ReasoningEffort) => void;
  disabled: boolean;
}) {
  return (
    <div className="effort-pills">
      {EFFORTS.map(e => (
        <button
          key={e}
          className={`effort-pill ${effort === e ? "active" : ""}`}
          onClick={() => onChange(e)}
          disabled={disabled}
          title={`思考力度: ${e}`}
        >
          {e === "xhigh" ? "max" : e}
        </button>
      ))}
    </div>
  );
}

// ── ModelPicker ───────────────────────────────────────────────────────────────
function ModelPicker({ models, current, onSelect, onClose }: {
  models: ModelInfo[];
  current: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-title">选择 Session 模型</div>
        {models.length === 0
          ? <div style={{ color: "var(--muted)", fontSize: 13 }}>加载中…</div>
          : models.map(m => (
            <button
              key={m.id}
              className={`model-item ${m.id === current ? "active" : ""}`}
              onClick={() => onSelect(m.id)}
            >
              <div className="model-item-name">{m.displayName || m.id}</div>
              {m.description && <div className="model-item-desc">{m.description}</div>}
              <div className="model-item-meta">
                {m.supportedEfforts.length > 0 && (
                  <span>思考: {m.supportedEfforts.join(" · ")}</span>
                )}
                {m.isDefault && <span className="model-default-badge">当前</span>}
              </div>
            </button>
          ))
        }
        <div className="modal-actions">
          <button className="btn-reject" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
