import { type Connection } from "../lib/api";
import { Splitter } from "./Splitter";
import { TabBar } from "./TabBar";
import { SqlEditor } from "./SqlEditor";
import { useResizable } from "../lib/useResizable";
import type { Tab } from "../lib/useTabs";

type Props = {
  active: Connection | null;
  tabs: Tab[];
  activeTab: Tab | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
  onSqlChange: (id: string, sql: string) => void;
  onRun: () => void;
  onOpenMcpModal: () => void;
};

export function Workspace({
  active,
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onSqlChange,
  onRun,
  onOpenMcpModal,
}: Props) {
  const editor = useResizable({
    storageKey: "db.layout.editor.height",
    defaultSize: 220,
    min: 150,
    max: 600,
    axis: "y",
  });

  if (!active) {
    return (
      <div className="empty-pane">
        <div className="serif" style={{ fontSize: "var(--fs-xl)" }}>
          A workbench you watch from.
        </div>
        <div>Add a connection in the rail, then click it to connect.</div>
        <button className="btn" onClick={onOpenMcpModal} style={{ marginTop: 12 }}>
          MCP config
        </button>
      </div>
    );
  }

  const result = activeTab?.result ?? null;
  const error = activeTab?.error ?? null;
  const running = activeTab?.running ?? false;
  const isAgentTab = activeTab?.agentAuthored ?? false;

  return (
    <>
      <TabBar
        tabs={tabs}
        activeId={activeTab?.id ?? null}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onAdd={onAddTab}
      />

      <div className="editor-toolbar">
        <button
          className="run-chip"
          onClick={onRun}
          disabled={running || !active.connected || !activeTab}
          aria-label="Run query"
        >
          <span className="run-icon" aria-hidden>▶</span>
          <span>{running ? "Running…" : "Run"}</span>
          <kbd className="kbd">⌘↵</kbd>
        </button>
        <button className="editor-btn" disabled title="Format SQL (coming soon)">
          Format <kbd className="kbd">⌥⇧F</kbd>
        </button>
        <button className="editor-btn" disabled title="EXPLAIN (coming soon)">
          EXPLAIN
        </button>
        <div className="spacer" />
        {isAgentTab && (
          <span className="agent-badge">
            <span className="agent-dot" />
            written by agent
          </span>
        )}
        <button className="editor-btn ghost" onClick={onOpenMcpModal}>
          MCP
        </button>
        <span className="editor-meta mono">SQL · UTF-8 · LF</span>
      </div>

      <div
        className={`editor-wrap${isAgentTab ? " agent" : ""}`}
        style={{ height: editor.size, flex: "0 0 auto" }}
      >
        {activeTab && (
          <SqlEditor
            value={activeTab.sql}
            onChange={(v) => onSqlChange(activeTab.id, v)}
            onRun={onRun}
          />
        )}
      </div>

      <Splitter
        orientation="horizontal"
        dragging={editor.dragging}
        title="Drag to resize · double-click to reset"
        style={{ flex: "0 0 6px", height: 6, margin: "-3px 0" }}
        {...editor.handleProps}
      />

      <div className="result-toolbar">
        {result ? (
          <>
            <span className="status-pill ok mono">
              {result.row_count} row{result.row_count === 1 ? "" : "s"} · {result.elapsed_ms}ms
              {result.truncated && " · truncated"}
            </span>
            <span className="result-sep">│</span>
            <span className="result-sql mono" title={activeTab?.sql ?? ""}>
              {(activeTab?.sql ?? "").replace(/\s+/g, " ").trim().slice(0, 120)}
            </span>
          </>
        ) : error ? (
          <span className="status-pill err mono">{error}</span>
        ) : (
          <span className="result-empty mono">
            No results yet. ⌘↵ to run.
          </span>
        )}
        <div className="spacer" />
        <button className="editor-btn" disabled>Filter</button>
        <button className="editor-btn" disabled>Export</button>
        <button className="editor-btn" disabled aria-label="Refresh">↻</button>
      </div>

      <div className="grid-wrap">
        {result && (
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
        )}
      </div>
    </>
  );
}
