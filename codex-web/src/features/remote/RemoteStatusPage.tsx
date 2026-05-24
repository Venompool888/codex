import { useEffect } from "react";
import { useCodexSession } from "../chat/CodexSessionContext";

export function RemoteStatusPage() {
  const { connectionStatus, model, effort, cwd, config, readConfig } = useCodexSession();

  useEffect(() => {
    readConfig();
  }, [readConfig]);

  const statusLabel = connectionStatus === "connected"
    ? "已连接"
    : connectionStatus === "failed" ? "连接失败" : "连接中";

  return (
    <section className="product-page remote-page">
      <div className="page-title-row">
        <div>
          <h2>Remote 状态</h2>
          <p>查看当前 Web UI 正在操控的 Codex CLI 运行环境。</p>
        </div>
        <button className="mini-btn" type="button" onClick={readConfig}>刷新</button>
      </div>
      <div className="settings-list">
        <StatusRow label="连接状态" value={statusLabel} />
        <StatusRow label="工作区" value={cwd || "loading"} />
        <StatusRow label="当前模型" value={model || config?.model || "unknown"} />
        <StatusRow label="推理力度" value={effort} />
        <StatusRow label="审批策略" value={config?.approvalPolicy ?? "not loaded"} />
        <StatusRow label="沙箱模式" value={config?.sandboxMode ?? "not loaded"} />
        <StatusRow label="Web Search" value={config?.webSearch ?? "not loaded"} />
        <StatusRow label="CLI Runtime" value="Codex CLI session" />
      </div>
      <div className="product-empty remote-note">
        Remote 页面只展示当前远端 CLI/session 状态。凭据与 provider 状态继续由远端 Codex CLI 环境负责。
      </div>
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
