import { useState } from "react";
import { api, type Connection, type QueryResult } from "../lib/api";

type Props = {
  active: Connection | null;
  sql: string;
  setSql: (s: string) => void;
  onOpenMcpModal: () => void;
};

export function Workspace({ active, sql, setSql, onOpenMcpModal }: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!active || !active.connected) {
      setError("Not connected. Click a connection in the rail.");
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const r = await api.run_query(active.name, sql);
      setResult(r);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const onEditorKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  };

  if (!active) {
    return (
      <>
        <div className="tabbar">
          <span className="conn-tag">no connection</span>
          <div className="spacer" />
          <button className="btn" onClick={onOpenMcpModal}>
            MCP config
          </button>
        </div>
        <div className="empty-pane">
          <div className="serif" style={{ fontSize: "var(--fs-xl)" }}>
            A workbench you watch from.
          </div>
          <div>Add a connection in the rail, then click it to connect.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="tabbar">
        <span className="conn-tag">
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 50,
              background: active.connected ? "var(--status-ok)" : "var(--status-idle)",
              display: "inline-block",
            }}
          />
          {active.name}
          <span style={{ color: "var(--text-muted)" }}>
            · {active.username}@{active.host}:{active.port}/{active.database}
          </span>
        </span>
        <div className="spacer" />
        <button className="btn" onClick={onOpenMcpModal}>
          MCP config
        </button>
      </div>

      <div className="editor-wrap">
        <textarea
          /* Monaco seam: replace this <textarea> with a Monaco editor instance.
             Keep value/onChange semantics; the rest of the app is editor-agnostic. */
          className="editor"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onEditorKey}
          spellCheck={false}
          placeholder="SELECT 1;"
        />
        <div className="editor-row">
          <button className="btn primary" onClick={run} disabled={running || !active.connected}>
            {running ? "Running…" : "Run  ⌘↵"}
          </button>
          <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
            SELECT / WITH-SELECT only · writes are blocked at the seam (v0.2)
          </span>
          {error && <span className="editor-error">{error}</span>}
        </div>
      </div>

      <div className="grid-wrap">
        {result ? (
          <table className="grid">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => (
                    <td key={j} className={v === null ? "null" : ""}>
                      {v === null ? "NULL" : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-pane" style={{ padding: 24 }}>
            <div style={{ color: "var(--text-muted)" }}>
              No results yet. ⌘↵ to run.
            </div>
          </div>
        )}
      </div>
      {result && (
        <div className="grid-meta">
          {result.row_count} row{result.row_count === 1 ? "" : "s"} · {result.elapsed_ms}ms
          {result.truncated && " · truncated"}
        </div>
      )}
    </>
  );
}
