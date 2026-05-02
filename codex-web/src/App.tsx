import { useEffect, useRef, useState, KeyboardEvent, useCallback } from "react";
import { useCodexWs, ChatEntry, TurnEntry } from "./useCodexWs";
import { ApprovalModal } from "./ApprovalModal";
import { SlashMenu } from "./SlashMenu";
import type { AppItem, TokenUsage, ReasoningEffort, ModelInfo } from "../shared";
import { marked } from "marked";

// Configure marked for safety
marked.setOptions({ async: false, breaks: true, gfm: true });

export default function App() {
  const {
    connected, thinking, threadId, model, effort, models, cwd, entries, approval,
    send, interrupt, newThread, respond, slash,
    changeModel, changeEffort, listModels,
    historyUp, historyDown, resetHistoryIdx,
  } = useCodexWs();

  const [input, setInput] = useState("");
  const [showSlash, setShowSlash] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, thinking]);

  function handleSubmit() {
    const text = input.trim();
    if (!text || !connected) return;

    // slash commands
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(" ");
      if (cmd === "new" || cmd === "clear") { setInput(""); newThread(); return; }
      setInput("");
      slash(cmd, rest.join(" "));
      return;
    }

    if (thinking) return;
    setInput("");
    send(text);
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

  function onSlashSelect(name: string) {
    setShowSlash(false);
    if (name === "new") { setInput(""); newThread(); return; }
    setInput("");
    slash(name, "");
  }

  function openModelPicker() {
    listModels();
    setShowModelPicker(true);
  }

  const shortCwd = cwd.replace(process.env.HOME ?? "/root", "~");

  return (
    <div className="app">
      <header>
        <span className="brand">Codex</span>
        <span className={`dot ${connected ? "on" : "off"}`} title={connected ? "已连接" : "断开"} />
        <button className="hbtn-model" onClick={openModelPicker} title="切换模型" disabled={!connected}>
          {model || "…"}
        </button>
        <span className="hsep">·</span>
        <EffortPills effort={effort} onChange={changeEffort} disabled={!connected} />
        <span className="hsep">·</span>
        <span className="hinfo cwd" title={cwd}>{shortCwd}</span>
        {threadId && <><span className="hsep">·</span><span className="hinfo mono">#{threadId.slice(0, 8)}</span></>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn-icon" onClick={newThread} title="/new" disabled={!connected}>＋</button>
          <button className="btn-icon" onClick={() => slash("diff")} title="/diff" disabled={!connected}>±</button>
          <button className="btn-icon" onClick={() => slash("status")} title="/status" disabled={!connected}>ⓘ</button>
        </div>
      </header>

      <div className="messages">
        {entries.length === 0 && (
          <div className="empty">
            <p>Codex Web</p>
            <p className="empty-hint">输入消息开始，<code>/</code> 触发命令补全</p>
            <div className="empty-suggestions">
              {["解释当前目录结构", "查看 git 状态", "有哪些 TODO"].map(s => (
                <button key={s} className="suggestion-chip" onClick={() => { send(s); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map(e =>
          e.kind === "user" ? <UserBubble key={e.id} text={e.text} /> :
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
          <form className="input-bar" onSubmit={e => { e.preventDefault(); handleSubmit(); }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => handleInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={thinking ? "AI 思考中..." : "输入消息，/ 命令，↑↓ 历史"}
              rows={1}
              disabled={!connected}
            />
            {thinking
              ? <button type="button" className="btn-interrupt" onClick={interrupt} title="中断">■</button>
              : <button type="submit" className="btn-send" disabled={!connected || !input.trim()}>发送</button>
            }
          </form>
        </div>
      </footer>

      {approval && <ApprovalModal req={approval} onDecide={respond} />}

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
function UserBubble({ text }: { text: string }) {
  return (
    <div className="entry user-entry">
      <div className="elabel">你</div>
      <div className="user-bubble-wrap">
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
  const html = marked.parse(text) as string;
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
            <span className="iicon">📄</span>
            <span>文件修改</span>
            <span className="ibadge">{item.status === "completed" ? "✓" : "✗"}</span>
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
            <span className="iicon">🔧</span>
            <code>{item.server} · {item.tool}</code>
            <span className="ibadge">{item.status === "in_progress" ? "…" : item.status === "completed" ? "✓" : "✗"}</span>
          </div>
          {item.error && <pre className="cmd-out err">{item.error}</pre>}
        </div>
      );

    case "webSearch":
      return (
        <div className="item web-search">
          <div className="iheader"><span className="iicon">🔍</span><span>搜索</span></div>
          <code>{item.query}</code>
        </div>
      );

    case "todo":
      return (
        <div className="item todo">
          <div className="iheader"><span className="iicon">📋</span><span>计划</span></div>
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

function cmdBadge(status: string, exit: number | null, ms: number | null) {
  const t = ms ? ` ${(ms / 1000).toFixed(1)}s` : "";
  if (status === "running") return "…";
  if (status === "completed") return exit === 0 ? `✓${t}` : `✗ ${exit}${t}`;
  if (status === "failed") return "✗";
  return status;
}

function renderDiffLines(diff: string): React.ReactNode {
  return diff.split("\n").map((line, i) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "diff-add"
      : line.startsWith("-") && !line.startsWith("---") ? "diff-del"
      : line.startsWith("@@") ? "diff-hunk" : "diff-ctx";
    return <span key={i} className={cls}>{line + "\n"}</span>;
  });
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
        <div className="modal-title">切换模型</div>
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
