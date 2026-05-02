import { useEffect, useRef } from "react";

export const SLASH_COMMANDS = [
  { name: "new",    desc: "开启新对话" },
  { name: "diff",   desc: "显示 git diff" },
  { name: "model",  desc: "查看/切换模型" },
  { name: "status", desc: "显示会话状态" },
];

type Props = {
  query: string;
  onSelect: (name: string) => void;
  onClose: () => void;
};

export function SlashMenu({ query, onSelect, onClose }: Props) {
  const q = query.toLowerCase();
  const matches = SLASH_COMMANDS.filter(c => c.name.startsWith(q));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  if (!matches.length) return null;

  return (
    <div className="slash-menu" ref={ref}>
      {matches.map(c => (
        <button key={c.name} className="slash-item" onClick={() => onSelect(c.name)}>
          <span className="slash-name">/{c.name}</span>
          <span className="slash-desc">{c.desc}</span>
        </button>
      ))}
    </div>
  );
}
