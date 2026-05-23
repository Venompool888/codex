import { useCodexSession } from "../chat/CodexSessionContext";

export function SettingsPage() {
  const { model, effort, cwd, config, readConfig } = useCodexSession();

  return (
    <section className="product-page settings-page">
      <div className="page-title-row">
        <div>
          <h2>设置</h2>
          <p>模型、权限、MCP 和外观配置入口</p>
        </div>
        <button className="mini-btn" type="button" onClick={readConfig}>刷新</button>
      </div>
      <div className="settings-list">
        <SettingRow label="当前模型" value={model || config?.model || "unknown"} />
        <SettingRow label="推理力度" value={effort} />
        <SettingRow label="工作区" value={cwd || "loading"} />
        <SettingRow label="审批策略" value={config?.approvalPolicy ?? "not loaded"} />
        <SettingRow label="沙箱模式" value={config?.sandboxMode ?? "not loaded"} />
      </div>
    </section>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
