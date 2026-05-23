import { createContext, useContext } from "react";
import { useCodexWs, type ConnectionStatus, type TurnEntry } from "../../useCodexWs";

type CodexSessionValue = ReturnType<typeof useCodexWs>;

const CodexSessionContext = createContext<CodexSessionValue | null>(null);

export function CodexSessionProvider({ children }: { children: React.ReactNode }) {
  const session = useCodexWs();
  return (
    <CodexSessionContext.Provider value={session}>
      {children}
    </CodexSessionContext.Provider>
  );
}

export function useCodexSession() {
  const session = useContext(CodexSessionContext);
  if (!session) throw new Error("useCodexSession must be used within CodexSessionProvider");
  return session;
}

export type { ConnectionStatus, TurnEntry };
