import { useState } from "react";
import { useCodexSession } from "../chat/CodexSessionContext";

export function SearchPage() {
  const { fileSearchResults, searchFiles } = useCodexSession();
  const [query, setQuery] = useState("");

  function updateQuery(value: string) {
    setQuery(value);
    searchFiles(value);
  }

  return (
    <section className="product-page search-page">
      <h2>搜索</h2>
      <label className="project-search-box">
        <span>搜索项目、消息或文件</span>
        <input value={query} onChange={event => updateQuery(event.target.value)} placeholder="输入文件名或路径" />
      </label>
      <div className="search-results">
        {fileSearchResults.length === 0 && <div className="product-empty">输入关键词后显示匹配文件。</div>}
        {fileSearchResults.map(result => (
          <div key={`${result.root}:${result.path}`} className="search-result-row">
            <strong>{result.name}</strong>
            <span>{result.path}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
