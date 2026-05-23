import { useEffect, useState } from "react";
import { type Connection } from "../lib/api";
import { Splitter } from "./Splitter";
import { TabBar } from "./TabBar";
import { SqlEditor } from "./SqlEditor";
import { ExportMenu } from "./ExportMenu";
import { ResultsGrid } from "./ResultsGrid";
import { useResizable } from "../lib/useResizable";
import type { Tab } from "../lib/useTabs";
import type { useEditing } from "../lib/useEditing";

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
  /** Editing state hook (App-owned). */
  editing: ReturnType<typeof useEditing>;
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
  editing,
}: Props) {
  const editor = useResizable({
    storageKey: "db.layout.editor.height",
    defaultSize: 220,
    min: 150,
    max: 600,
    axis: "y",
  });

  // ⌘E opens the Export menu when results are loaded.
  const [exportOpenSignal, setExportOpenSignal] = useState<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setExportOpenSignal((n) => (n ?? 0) + 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // For editable tabs: fetch describe_table on demand.
  const isTableTab = activeTab?.source === "table" && !!activeTab.schemaTableKey;
  const [schema, table] = (activeTab?.schemaTableKey ?? ".").split(".");
  const editable = !!(active?.connected && isTableTab && activeTab?.result);

  useEffect(() => {
    if (!isTableTab || !schema || !table) return;
    editing.ensureMeta(schema, table);
  }, [isTableTab, schema, table, editing]);

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
  const columnsMeta = isTableTab && schema && table ? editing.getMeta(schema, table) : null;
  const batch = activeTab ? editing.getBatch(activeTab.id) : { edits: [], adds: [], deletes: [] };
  const activeAdds = activeTab ? editing.getActiveAdds(activeTab.id) : [];

  const editableTab = editable && activeTab && schema && table
    ? { id: activeTab.id, schema, table, result }
    : null;

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
        <button className="editor-btn soon" disabled title="Format SQL — coming soon">
          Format
        </button>
        <button className="editor-btn soon" disabled title="EXPLAIN — coming soon">
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
        ) : !active.connected ? (
          <span className="result-empty mono">
            Disconnected · click <span className="result-empty-em">{active.name}</span> in the rail to connect.
          </span>
        ) : (
          <span className="result-empty mono">
            No results yet. ⌘↵ to run.
          </span>
        )}
        <div className="spacer" />
        <button className="editor-btn soon" disabled title="Filter — coming soon">
          <span className="editor-btn-icon" aria-hidden>⏷</span>
          Filter
        </button>
        {editable && (
          <button
            className="editor-btn write"
            onClick={() => editableTab && editing.startAdd(editableTab)}
            title="Add a new row (⌘N)"
          >
            <span className="editor-btn-icon" aria-hidden>+</span>
            Row
          </button>
        )}
        <ExportMenu
          result={result}
          sql={activeTab?.sql ?? ""}
          tabTitle={activeTab?.title ?? "query"}
          connectionName={active.name}
          openSignal={exportOpenSignal}
        />
        <button
          className="editor-btn"
          disabled={running || !result || !active.connected}
          aria-label="Re-run query"
          title="Re-run query"
          onClick={onRun}
        >↻</button>
      </div>

      <ResultsGrid
        result={result}
        error={error}
        editable={editable}
        readOnlyReason={
          !active.connected
            ? "not connected"
            : !isTableTab
            ? "ad-hoc SQL — open via schema tree to edit"
            : !result
            ? "no result yet"
            : undefined
        }
        columnsMeta={columnsMeta}
        batch={batch}
        activeAdds={activeAdds}
        onStageEdit={(rowIdx, col, value) => editableTab && editing.stageEditCell(editableTab, rowIdx, col, value)}
        onStageDelete={(rowIdx) => editableTab && editing.stageDeleteRow(editableTab, rowIdx)}
        onUndoDelete={(rowIdx) => editableTab && editing.undoDeleteRow(editableTab, rowIdx)}
        onCancelAdd={(tempId) => activeTab && editing.cancelActiveAdd(activeTab.id, tempId)}
        onUpdateActiveAdd={(tempId, col, value) =>
          activeTab && editing.updateActiveAdd(activeTab.id, tempId, col, value)
        }
        onStartAdd={() => editableTab && editing.startAdd(editableTab)}
      />
    </>
  );
}
