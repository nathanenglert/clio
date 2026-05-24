import { useEffect, useMemo, useState } from "react";
import { type Connection } from "../lib/api";
import { Splitter } from "./Splitter";
import { TabBar } from "./TabBar";
import { SqlEditor } from "./SqlEditor";
import { ExportMenu } from "./ExportMenu";
import { ResultsGrid } from "./ResultsGrid";
import { JsonSidebar, type JsonSidebarTarget } from "./JsonSidebar";
import { useResizable } from "../lib/useResizable";
import { getEdit } from "../lib/editing";
import type { Tab } from "../lib/useTabs";
import type { useEditing } from "../lib/useEditing";
import type { Intellisense } from "../lib/useIntellisense";

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
  /** Mirror of the View > Reveal sensitive data toggle. UI-only. */
  reveal: boolean;
  /** Shared schema cache for SQL editor intellisense (App-owned). */
  intellisense: Intellisense;
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
  reveal,
  intellisense,
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

  // JSON sidebar — open target by row index + column name. Closed when null.
  const [jsonOpen, setJsonOpen] = useState<{ rowIdx: number; col: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setExportOpenSignal((n) => (n ?? 0) + 1);
      }
      // ⌘⇧J closes the JSON sidebar. Opening requires clicking a jsonb cell —
      // see result-editing.md §"Type-aware editors".
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setJsonOpen(null);
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

  // Close the JSON sidebar when the tab switches — the target row index no
  // longer maps to anything meaningful in the new result.
  useEffect(() => {
    setJsonOpen(null);
  }, [activeTab?.id]);

  const result = activeTab?.result ?? null;
  const error = activeTab?.error ?? null;
  const running = activeTab?.running ?? false;
  const isAgentTab = activeTab?.agentAuthored ?? false;
  const columnsMeta = isTableTab && schema && table ? editing.getMeta(schema, table) : null;
  const batch = activeTab ? editing.getBatch(activeTab.id) : { edits: [], adds: [], deletes: [] };
  const activeAdds = activeTab ? editing.getActiveAdds(activeTab.id) : [];

  // Build the JSON sidebar target on the fly so it always reflects the live
  // staged batch. When the targeted cell or its data is no longer valid, fall
  // back to null and let the sidebar close.
  const jsonTarget: JsonSidebarTarget | null = useMemo(() => {
    if (!jsonOpen || !result || !activeTab) return null;
    const colIdx = result.columns.findIndex((c) => c.name === jsonOpen.col);
    if (colIdx < 0) return null;
    const colMeta = result.columns[colIdx];
    const row = result.rows[jsonOpen.rowIdx];
    if (!row) return null;
    const original = row[colIdx];
    const editState = getEdit(batch, jsonOpen.rowIdx, jsonOpen.col);
    const meta = columnsMeta?.find((c) => c.name === jsonOpen.col);
    return {
      schema: schema || "",
      table: table || "",
      column: jsonOpen.col,
      rowIdx: jsonOpen.rowIdx,
      rowDisplayNum: jsonOpen.rowIdx + 1,
      originalValue: original,
      stagedValue: editState.staged ? editState.value : undefined,
      nullable: meta?.is_nullable ?? true,
      locked: !!colMeta.redacted,
    };
  }, [jsonOpen, result, batch, columnsMeta, schema, table, activeTab]);

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
            schema={intellisense.schema}
            defaultSchema={intellisense.defaultSchema}
            onEnsureColumns={intellisense.ensureColumns}
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
          reveal={reveal}
        />
        <button
          className="editor-btn"
          disabled={running || !result || !active.connected}
          aria-label="Re-run query"
          title="Re-run query"
          onClick={onRun}
        >↻</button>
      </div>

      <div className="results-region">
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
          jsonOpenAt={jsonOpen}
          onOpenJson={(rowIdx, col) => setJsonOpen({ rowIdx, col })}
          onStageEdit={(rowIdx, col, value) => editableTab && editing.stageEditCell(editableTab, rowIdx, col, value)}
          onStageDelete={(rowIdx) => editableTab && editing.stageDeleteRow(editableTab, rowIdx)}
          onUndoDelete={(rowIdx) => editableTab && editing.undoDeleteRow(editableTab, rowIdx)}
          onCancelAdd={(tempId) => activeTab && editing.cancelActiveAdd(activeTab.id, tempId)}
          onUpdateActiveAdd={(tempId, col, value) =>
            activeTab && editing.updateActiveAdd(activeTab.id, tempId, col, value)
          }
          onStartAdd={() => editableTab && editing.startAdd(editableTab)}
        />
        {jsonTarget && (
          <JsonSidebar
            target={jsonTarget}
            editable={editable}
            onClose={() => setJsonOpen(null)}
            onStage={(value) => {
              if (!editableTab) return;
              editing.stageEditCell(editableTab, jsonTarget.rowIdx, jsonTarget.column, value);
            }}
            onRevert={() => {
              if (!editableTab) return;
              editing.undoCellEdit(editableTab, jsonTarget.rowIdx, jsonTarget.column);
            }}
          />
        )}
      </div>
    </>
  );
}
