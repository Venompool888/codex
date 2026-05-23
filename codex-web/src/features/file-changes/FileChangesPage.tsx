import type { FileChangeItem } from "../../../shared";
import { useCodexSession } from "../chat/CodexSessionContext";

export function FileChangesPage() {
  const { entries } = useCodexSession();
  const changes = entries.flatMap(entry => {
    if (entry.kind !== "turn") return [];
    return entry.itemOrder
      .map(id => entry.items.get(id))
      .filter((item): item is FileChangeItem => item?.type === "fileChange")
      .flatMap(item => item.changes);
  });
  const added = changes.filter(change => change.kind === "add").length;
  const deleted = changes.filter(change => change.kind === "delete").length;

  return (
    <section className="product-page files-page">
      <div className="page-title-row">
        <div>
          <h2>文件变更</h2>
          <p>{changes.length} files changed · +{added} · -{deleted}</p>
        </div>
      </div>
      <div className="file-change-list">
        {changes.length === 0 && <div className="product-empty">暂无文件变更。</div>}
        {changes.map((change, index) => (
          <article key={`${change.path}-${index}`} className="file-change-card">
            <div>
              <span className={`change-kind k-${change.kind}`}>{change.kind}</span>
              <strong>{change.path}</strong>
            </div>
            {change.diff && <pre>{change.diff}</pre>}
          </article>
        ))}
      </div>
    </section>
  );
}
