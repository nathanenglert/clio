import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Connection } from "../lib/api";
import { Splitter } from "./Splitter";
import { TabBar } from "./TabBar";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { ExportMenu } from "./ExportMenu";
import { ResultsGrid } from "./ResultsGrid";
import { JsonSidebar, type JsonSidebarTarget } from "./JsonSidebar";
import { TableStructure } from "./TableStructure";
import { RunMessages, formatMs, resultCountLabel } from "./RunMessages";
import { TransactionChip } from "./TransactionChip";
import { splitStatements, statementAt } from "../lib/sqlStatements";
import { useResizable } from "../lib/useResizable";
import { getEdit } from "../lib/editing";
import { Lunate, Glyph } from "./brand";
import type { Tab } from "../lib/useTabs";
import type { useEditing } from "../lib/useEditing";
import type { Intellisense } from "../lib/useIntellisense";
import type { Snippets } from "../lib/useSnippets";

type TabMode = "data" | "structure";

/** What a run executes: `text` (one or more statements) at `offset` in the
 *  tab's SQL, so failures map back to editor positions. */
export type RunTarget = { text: string; offset: number };

type Props = {
  active: Connection | null;
  /** Non-null while an api.connect call is in flight — drives the "Opening
   *  the record…" hero. May refer to a different connection than `active`. */
  connecting: Connection | null;
  tabs: Tab[];
  activeTab: Tab | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
  onSqlChange: (id: string, sql: string) => void;
  /** Run `target`, or the whole tab when omitted. */
  onRun: (target?: RunTarget) => void;
  /** Commit (true) or roll back the active tab's open transaction. */
  onEndTransaction: (commit: boolean) => void;
  /** Switch the active tab's result area between grid and messages. */
  onResultView: (view: "results" | "messages") => void;
  /** ⌘S — write-through for library tabs, else opens the save sheet. */
  onSave: () => void;
  /** ⌘⇧S — always opens the save sheet as a fresh entry. */
  onSaveAs: () => void;
  onOpenMcpModal: () => void;
  /** Opens the Add Connection modal — wired from App. */
  onAddConnection: () => void;
  /** Editing state hook (App-owned). */
  editing: ReturnType<typeof useEditing>;
  /** Mirror of the View > Reveal sensitive data toggle. UI-only. */
  reveal: boolean;
  /** Shared schema cache for SQL editor intellisense (App-owned). */
  intellisense: Intellisense;
  /** App-owned snippet store + completions. */
  snippets: Snippets;
  /** Open the Snippets management modal. Pass an initial body to prefill
   *  (used by "Save selection as snippet"). */
  onOpenSnippets: (seedBody?: string) => void;
};

export function Workspace({
  active,
  connecting,
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onSqlChange,
  onRun,
  onEndTransaction,
  onResultView,
  onSave,
  onSaveAs,
  onOpenMcpModal,
  onAddConnection,
  editing,
  reveal,
  intellisense,
  snippets,
  onOpenSnippets,
}: Props) {
  // Imperative handle to the SqlEditor — lets the toolbar's "Save as snippet"
  // capture the current selection (or full body when no selection) without
  // re-routing every keystroke through App state.
  const editorRef = useRef<SqlEditorHandle | null>(null);
  const editor = useResizable({
    storageKey: "db.layout.editor.height",
    defaultSize: 220,
    min: 150,
    max: 600,
    axis: "y",
  });

  // ⌘↵: the selection if there is one, else the statement at the cursor (the
  // editor marks it), else — a lone statement — the whole tab.
  const handleRun = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return onRun();
    const text = ed.getText();
    const { from, to } = ed.getSelectionRange();
    if (text.slice(from, to).trim()) return onRun({ text: text.slice(from, to), offset: from });
    const stmts = splitStatements(text);
    const s = stmts.length > 1 ? statementAt(text, stmts, ed.getCursor()) : null;
    onRun(s ? { text: s.sql, offset: s.from } : { text, offset: 0 });
  }, [onRun]);

  // ⌘⇧↵: every statement in the tab, in order.
  const handleRunAll = useCallback(() => {
    const text = editorRef.current?.getText();
    onRun(text == null ? undefined : { text, offset: 0 });
  }, [onRun]);

  // ⌘E opens the Export menu when results are loaded.
  const [exportOpenSignal, setExportOpenSignal] = useState<number | undefined>(undefined);

  // JSON sidebar — open target by row index + column name. Closed when null.
  const [jsonOpen, setJsonOpen] = useState<{ rowIdx: number; col: string } | null>(null);

  // Data/Structure mode per "table" tab. Defaults to "data"; flipping is
  // user-driven (segmented control). Map is keyed by tab id and only populated
  // for tabs the user has actively toggled — absence means Data.
  const [tabModes, setTabModes] = useState<Record<string, TabMode>>({});
  const setTabMode = useCallback((id: string, mode: TabMode) => {
    setTabModes((p) => ({ ...p, [id]: mode }));
  }, []);

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
  const tabMode: TabMode = (activeTab && tabModes[activeTab.id]) ?? "data";
  const showStructure = isTableTab && tabMode === "structure";
  const tableDescription =
    isTableTab && schema && table ? editing.getTableMeta(schema, table) : null;

  // Depend on `ensureMeta`, not `editing`: the hook returns a new object every
  // render, and each describe_table emits an activity event that re-renders,
  // so a failing fetch would otherwise retry in a tight loop.
  const { ensureMeta } = editing;
  useEffect(() => {
    if (!isTableTab || !schema || !table) return;
    ensureMeta(schema, table);
  }, [isTableTab, schema, table, ensureMeta]);

  // Close the JSON sidebar when the tab switches — the target row index no
  // longer maps to anything meaningful in the new result.
  useEffect(() => {
    setJsonOpen(null);
  }, [activeTab?.id]);

  const result = activeTab?.result ?? null;
  const error = activeTab?.error ?? null;
  const running = activeTab?.running ?? false;
  const stmtCount = useMemo(() => splitStatements(activeTab?.sql ?? "").length, [activeTab?.sql]);
  const run = activeTab?.lastRun ?? null;
  const multi = (run?.statements.length ?? 0) > 1;
  const noticeCount = run ? run.script.steps.reduce((n, s) => n + s.notices.length, 0) : 0;
  const hasMessages =
    !!run &&
    (multi || noticeCount > 0 || !!run.script.error || run.script.steps.some((st) => st.rolled_back));
  const view = hasMessages ? activeTab?.resultView ?? "results" : "results";
  const failedIdx = run ? run.script.steps.findIndex((s) => s.error) : -1;
  // The statement behind the grid — what the footer counts, echoes and exports.
  const resultSql =
    run && run.script.result_step != null
      ? run.statements[run.script.result_step].sql
      : activeTab?.sql ?? "";
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

  if (connecting) {
    return (
      <div className="empty-pane connecting-pane">
        <div className="connecting-mark">
          <Lunate size={56} />
          <span className="connecting-mark-ghost" aria-hidden>
            <Lunate size={56} dot={false} color="var(--text-secondary)" />
          </span>
        </div>
        <div className="connecting-title serif">Opening the record…</div>
        <div className="connecting-progress" aria-hidden>
          <span className="connecting-line" />
          <span className="connecting-dot" />
          <span className="connecting-line" />
          <span className="connecting-dot connecting-dot--accent" />
          <span className="connecting-line" />
          <span className="connecting-dot" />
        </div>
        <div className="connecting-diag mono">
          negotiating tls · verify-full · {connecting.host}:{connecting.port}
        </div>
      </div>
    );
  }

  if (!active || !active.connected) {
    return (
      <div className="empty-pane empty-pane--brand">
        <Lunate size={88} />
        <h1 className="brand-empty-h1 serif">A workbench you watch from.</h1>
        <p className="brand-empty-body">
          Connect a Postgres database, then point your coding agent at it. Clio
          keeps the record of every query it runs and lets you gate any write
          before it touches the database.
        </p>
        <div className="brand-empty-actions">
          <button className="btn primary" onClick={onAddConnection}>
            Connect a database
            <kbd className="kbd">⌘N</kbd>
          </button>
          <button
            className="btn ghost"
            disabled
            title="Past records ship in v0.2"
          >
            <Glyph kind="lookback" size={14} color="var(--text-secondary)" />
            Open a past record
          </button>
        </div>
        <div className="brand-empty-hint mono">
          ⌘K open palette · ? shortcuts
        </div>
        <button
          className="btn brand-empty-mcp"
          onClick={onOpenMcpModal}
          title="MCP config"
        >
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
        {isTableTab && activeTab && (
          <div className="ws-mode-seg" role="tablist" aria-label="View mode">
            <button
              role="tab"
              aria-selected={tabMode === "data"}
              className={tabMode === "data" ? "on" : ""}
              onClick={() => setTabMode(activeTab.id, "data")}
            >
              Data
            </button>
            <button
              role="tab"
              aria-selected={tabMode === "structure"}
              className={tabMode === "structure" ? "on" : ""}
              onClick={() => setTabMode(activeTab.id, "structure")}
            >
              Structure
            </button>
          </div>
        )}
        {!showStructure && (
          <>
            <button
              className="run-chip"
              onClick={handleRun}
              disabled={running || !active.connected || !activeTab}
              aria-label="Run query"
              title={stmtCount > 1 ? "Run the marked statement, or the selection" : undefined}
            >
              <span className="run-icon" aria-hidden>▶</span>
              <span>{running ? "Running…" : "Run"}</span>
              <kbd className="kbd">⌘↵</kbd>
            </button>
            {stmtCount > 1 && (
              <button
                className="editor-btn"
                onClick={handleRunAll}
                disabled={running || !active.connected || !activeTab}
                title="Run every statement in the tab, in order — stops at the first error"
              >
                <span className="editor-btn-icon" aria-hidden>▶▶</span>
                Run all
                <kbd className="kbd">⌘⇧↵</kbd>
              </button>
            )}
            <button className="editor-btn soon" disabled title="Format SQL — coming soon">
              Format
            </button>
            <button className="editor-btn soon" disabled title="EXPLAIN — coming soon">
              EXPLAIN
            </button>
            <button
              className="editor-btn"
              onClick={() => {
                const sel = editorRef.current?.getSelection() ?? "";
                const seed = sel.trim().length > 0 ? sel : undefined;
                onOpenSnippets(seed);
              }}
              title="Manage snippets — opens with the editor selection prefilled, or empty to browse"
            >
              <span className="editor-btn-icon" aria-hidden>{"{·}"}</span>
              Snippets
            </button>
          </>
        )}
        <div className="spacer" />
        {activeTab?.tx && (
          <TransactionChip
            openedAtMs={activeTab.tx.openedAtMs}
            busy={running}
            onCommit={() => onEndTransaction(true)}
            onRollback={() => onEndTransaction(false)}
          />
        )}
        {isAgentTab && !showStructure && (
          <span className="agent-badge">
            <span className="agent-dot" />
            written by agent
          </span>
        )}
        <button className="editor-btn ghost" onClick={onOpenMcpModal}>
          MCP
        </button>
        {!showStructure && (
          <span className="editor-meta mono">SQL · UTF-8 · LF</span>
        )}
      </div>

      {showStructure ? (
        <TableStructure
          schema={schema || ""}
          table={table || ""}
          description={tableDescription}
        />
      ) : (
        <>
      <div
        className={`editor-wrap${isAgentTab ? " agent" : ""}`}
        style={{ height: editor.size, flex: "0 0 auto" }}
      >
        {activeTab && (
          <SqlEditor
            value={activeTab.sql}
            onChange={(v) => onSqlChange(activeTab.id, v)}
            onRun={handleRun}
            onRunAll={handleRunAll}
            errorRange={run && failedIdx >= 0 ? run.statements[failedIdx] : null}
            onSave={onSave}
            onSaveAs={onSaveAs}
            schema={intellisense.schema}
            defaultSchema={intellisense.defaultSchema}
            onEnsureColumns={intellisense.ensureColumns}
            snippets={snippets.completions}
            registerHandle={(h) => {
              editorRef.current = h;
            }}
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
        {multi && run ? (
          <>
            <span className={`status-pill ${run.script.error || failedIdx >= 0 ? "err" : "ok"} mono`}>
              {run.script.error
                ? "run failed"
                : failedIdx >= 0
                ? `failed at statement ${failedIdx + 1} of ${run.statements.length}`
                : `${run.statements.length} statements`}
              {" · "}
              {formatMs(run.script.elapsed_ms)}
            </span>
            {result && view === "results" && (
              <>
                <span className="result-sep">│</span>
                <span className="result-sql mono" title={resultSql}>
                  {resultCountLabel(result, resultSql)} · {resultSql.replace(/\s+/g, " ").trim().slice(0, 120)}
                </span>
              </>
            )}
          </>
        ) : result ? (
          <>
            <span className="status-pill ok mono">
              {resultCountLabel(result, resultSql)} · {result.elapsed_ms}ms
              {result.truncated && " · truncated"}
            </span>
            <span className="result-sep">│</span>
            <span className="result-sql mono" title={resultSql}>
              {resultSql.replace(/\s+/g, " ").trim().slice(0, 120)}
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
        {hasMessages && (
          <div className="ws-mode-seg result-view-seg" role="tablist" aria-label="Result view">
            <button
              role="tab"
              aria-selected={view === "results"}
              className={view === "results" ? "on" : ""}
              onClick={() => onResultView("results")}
            >
              Results
            </button>
            <button
              role="tab"
              aria-selected={view === "messages"}
              className={view === "messages" ? "on" : ""}
              onClick={() => onResultView("messages")}
            >
              Messages{noticeCount > 0 ? ` · ${noticeCount}` : ""}
            </button>
          </div>
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
          sql={resultSql}
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
          onClick={handleRun}
        >↻</button>
      </div>

      <div className="results-region">
        {view === "messages" && run ? (
          <RunMessages run={run} onReveal={(stmt) => editorRef.current?.reveal(stmt.from)} />
        ) : (
        <ResultsGrid
          result={result}
          error={error}
          countLabel={result ? resultCountLabel(result, resultSql) : undefined}
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
        )}
        {jsonTarget && view === "results" && (
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
      )}
    </>
  );
}
