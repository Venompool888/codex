import type { ApprovalRequest } from "./useCodexWs";
import type { ApprovalDecision, FileChange } from "../shared";

type Props = {
  req: ApprovalRequest;
  onDecide: (id: string, d: ApprovalDecision) => void;
};

export function ApprovalModal({ req, onDecide }: Props) {
  const decide = (d: ApprovalDecision) => onDecide(req.id, d);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        {req.kind === "cmd" ? <CmdApproval req={req} decide={decide} /> : <FileApproval req={req} decide={decide} />}
      </div>
    </div>
  );
}

function CmdApproval({ req, decide }: { req: Extract<ApprovalRequest, { kind: "cmd" }>; decide: (d: ApprovalDecision) => void }) {
  return (
    <>
      <div className="modal-title">⚠️ 执行命令请求</div>
      {req.reason && <div className="modal-reason">{req.reason}</div>}
      <div className="modal-section-label">命令</div>
      <pre className="modal-code">{req.command}</pre>
      <div className="modal-section-label">工作目录</div>
      <code className="modal-cwd">{req.cwd}</code>
      <div className="modal-actions">
        <button className="btn-approve" onClick={() => decide("accept")}>允许</button>
        <button className="btn-approve-session" onClick={() => decide("acceptForSession")}>本次会话允许</button>
        <button className="btn-reject" onClick={() => decide("decline")}>拒绝</button>
      </div>
    </>
  );
}

function FileApproval({ req, decide }: { req: Extract<ApprovalRequest, { kind: "file" }>; decide: (d: ApprovalDecision) => void }) {
  return (
    <>
      <div className="modal-title">📄 文件修改请求</div>
      {req.reason && <div className="modal-reason">{req.reason}</div>}
      {req.grantRoot && (
        <>
          <div className="modal-section-label">授权目录</div>
          <code className="modal-cwd">{req.grantRoot}</code>
        </>
      )}
      {req.changes.length > 0 && (
        <div className="modal-changes">
          {req.changes.map((c, i) => <DiffBlock key={i} change={c} />)}
        </div>
      )}
      {req.changes.length === 0 && (
        <div className="modal-reason">还没有收到结构化 diff。可以等待流式 diff 更新，也可以直接拒绝。</div>
      )}
      <div className="modal-actions">
        <button className="btn-approve" onClick={() => decide("accept")}>允许</button>
        <button className="btn-approve-session" onClick={() => decide("acceptForSession")}>本次会话允许</button>
        <button className="btn-reject" onClick={() => decide("decline")}>拒绝</button>
      </div>
    </>
  );
}

function DiffBlock({ change }: { change: FileChange }) {
  const kindColor = change.kind === "add" ? "#10b981" : change.kind === "delete" ? "#ef4444" : "#f59e0b";
  const kindLabel = change.kind === "add" ? "+ 新增" : change.kind === "delete" ? "− 删除" : "~ 修改";
  return (
    <div className="diff-block">
      <div className="diff-header" style={{ color: kindColor }}>
        <span>{kindLabel}</span>
        <code>{change.path}</code>
      </div>
      {change.diff && (
        <pre className="diff-content">{renderDiff(change.diff)}</pre>
      )}
    </div>
  );
}

function renderDiff(diff: string): React.ReactNode {
  return diff.split("\n").map((line, i) => {
    const cls = line.startsWith("+") && !line.startsWith("+++")
      ? "diff-add"
      : line.startsWith("-") && !line.startsWith("---")
      ? "diff-del"
      : line.startsWith("@@")
      ? "diff-hunk"
      : "diff-ctx";
    return <span key={i} className={cls}>{line + "\n"}</span>;
  });
}
