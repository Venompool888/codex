import type { CommandExecutionItem } from "../../../shared";
import { useCodexSession } from "../chat/CodexSessionContext";

export function TaskDetail() {
  const { entries, connectionStatus } = useCodexSession();
  const commands = entries.flatMap(entry => {
    if (entry.kind !== "turn") return [];
    return entry.itemOrder
      .map(id => entry.items.get(id))
      .filter((item): item is CommandExecutionItem => item?.type === "commandExecution");
  });
  const latest = commands.at(-1);

  return (
    <section className="product-page task-page">
      <div className="page-title-row">
        <span className={`page-status s-${latest?.status ?? connectionStatus}`} />
        <div>
          <h2>运行任务详情</h2>
          <p>{latest ? "最近一次命令运行结果" : "等待 Codex 任务运行"}</p>
        </div>
      </div>
      <div className="task-card">
        <span>运行命令</span>
        <code>{latest?.command || "暂无命令"}</code>
      </div>
      <div className="task-card">
        <span>输出日志</span>
        <pre>{latest?.aggregatedOutput || "任务运行后会显示输出日志。"}</pre>
      </div>
    </section>
  );
}
