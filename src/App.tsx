import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, onActivity, type ActivityEvent, type Connection } from "./lib/api";
import { SchemaTree } from "./components/SchemaTree";
import { Workspace } from "./components/Workspace";
import { AgentSurface } from "./components/AgentSurface";
import { AddConnectionModal } from "./components/AddConnectionModal";
import { McpConfigModal } from "./components/McpConfigModal";
import { PendingTray } from "./components/PendingTray";
import { ReviewModal } from "./components/ReviewModal";
import { SensitivityModal } from "./components/SensitivityModal";
import { Splitter } from "./components/Splitter";
import { ToastHost, showToast } from "./components/Toast";
import { useResizable } from "./lib/useResizable";
import { useTabs } from "./lib/useTabs";
import { useEditing } from "./lib/useEditing";
import { useIntellisense } from "./lib/useIntellisense";
import { useReveal } from "./lib/useReveal";
import { isEmpty as batchIsEmpty } from "./lib/editing";

export function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [sensitivityFor, setSensitivityFor] = useState<string | null>(null);

  const rail = useResizable({
    storageKey: "db.layout.rail.width",
    defaultSize: 260,
    min: 200,
    max: 480,
    axis: "x",
  });

  const refresh = async () => {
    try {
      const cs = await api.list_connections();
      setConnections(cs);
      if (!activeName && cs.length > 0) setActiveName(cs[0].name);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    refresh();
    const unlisten = onActivity((e) => {
      setEvents((prev) => [...prev.slice(-199), e]);
      if (e.tool === "connect" || e.tool === "disconnect" || e.tool === "add_connection" || e.tool === "delete_connection") {
        refresh();
      }
    });
    return () => {
      unlisten.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = connections.find((c) => c.name === activeName) ?? null;
  const reveal = useReveal();
  const tabs = useTabs(activeName);
  const editing = useEditing(activeName);
  // The connection is only useful for completion once it's actually connected.
  // Passing null when disconnected keeps the schema cache from racing the
  // connect → list_schemas sequence.
  const intellisense = useIntellisense(active?.connected ? activeName : null);
  const [showReview, setShowReview] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // The agent dock should only show the agent's work; user-initiated activity
  // is surfaced separately (History tab). See design/README.md §"Agent activity
  // surface": "There must never be a moment of doubt about who initiated what."
  const agentEvents = useMemo(
    () => events.filter((e) => e.source === "mcp"),
    [events],
  );
  // run_query events from both sources — surfaced as History so the user can
  // re-run their own past queries alongside the agent's.
  const recentQueries = useMemo(
    () => events.filter((e) => e.tool === "run_query"),
    [events],
  );

  const runTabQuery = useCallback(
    async (tabId: string, sql: string) => {
      if (!activeName) return;
      tabs.updateTab(tabId, { running: true, error: null });
      try {
        const result = await api.run_query(activeName, sql, reveal);
        tabs.updateTab(tabId, { result, running: false, dirty: false });
      } catch (e) {
        tabs.updateTab(tabId, { error: String(e), running: false, result: null });
      }
    },
    [tabs, activeName, reveal],
  );

  const runActive = useCallback(async () => {
    const tab = tabs.activeTab;
    if (!tab || !activeName) return;
    if (!active?.connected) {
      tabs.updateTab(tab.id, { error: "Not connected. Click a connection in the rail.", result: null });
      return;
    }
    await runTabQuery(tab.id, tab.sql);
  }, [tabs, activeName, active?.connected, runTabQuery]);

  // When the reveal toggle flips, re-run the active tab's last query so the
  // user immediately sees real or fake values per the new state. Background
  // tabs stay stale until the user switches to them — predictable, and avoids
  // a stampede of queries on toggle.
  useEffect(() => {
    const tab = tabs.activeTab;
    if (!tab || !active?.connected || !tab.result) return;
    void runTabQuery(tab.id, tab.sql);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  // ── Commit pending changes ─────────────────────────────────────
  const trayTab = tabs.activeTab;
  const trayBatch = trayTab ? editing.getBatch(trayTab.id) : null;
  const trayActiveAdds = trayTab ? editing.getActiveAdds(trayTab.id) : [];
  const hasTrayWork =
    !!trayTab && (
      !!trayBatch && !batchIsEmpty(trayBatch) ||
      trayActiveAdds.some((a) => Object.keys(a.cells).length > 0)
    );
  const [traySchema, trayTable] = (trayTab?.schemaTableKey ?? ".").split(".");

  const doCommit = useCallback(async () => {
    if (!trayTab || !traySchema || !trayTable) return;
    setCommitError(null);
    const outcome = await editing.commit({
      id: trayTab.id,
      schema: traySchema,
      table: trayTable,
      result: trayTab.result,
    });
    if (!outcome) return;
    if (outcome.committed) {
      setShowReview(false);
      showToast(
        `Committed ${outcome.statements_run} statement${outcome.statements_run === 1 ? "" : "s"} · ${outcome.elapsed_ms}ms`,
        "ok",
      );
      // Re-run the query to refresh the grid with post-commit data.
      runActive();
    } else {
      setCommitError(outcome.error ?? "commit failed");
      showToast("Commit failed — see banner above the tray", "err");
    }
  }, [trayTab, traySchema, trayTable, editing, runActive]);

  const doDiscard = useCallback(() => {
    if (!trayTab) return;
    editing.discardAll(trayTab.id);
    setCommitError(null);
  }, [trayTab, editing]);

  // ⌘⏎ commits when the tray is non-empty.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasTrayWork && !editing.busy) {
        e.preventDefault();
        doCommit();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasTrayWork, editing.busy, doCommit]);

  const onPickTable = (schema: string, table: string) => {
    tabs.openOrSwitchTable(schema, table);
  };

  // ── Post-connect sensitivity toast ────────────────────────────
  // Surfaces newly-suggested classifications so the user can review them.
  // Idempotent on the backend: re-connecting an already-classified database
  // returns new_pending: 0, which we suppress.
  const onConnected = useCallback(
    (name: string, outcome: { new_pending: number; total_classified: number } | null) => {
      if (!outcome || outcome.new_pending === 0) return;
      const n = outcome.new_pending;
      showToast(
        (
          <span>
            <span aria-hidden style={{ color: "var(--privacy)", marginRight: 6 }}>
              ◌
            </span>
            <span className="mono">{n}</span> column{n === 1 ? "" : "s"} auto-classified
            as sensitive on <span className="mono">{name}</span>
          </span>
        ),
        "info",
        {
          action: {
            label: "Review",
            onClick: () => setSensitivityFor(name),
          },
        },
      );
    },
    [],
  );

  const onAgentOpen = (sql: string) => {
    tabs.addAgentTab(sql);
  };

  const onAgentRerun = async (sql: string) => {
    const id = tabs.addAgentTab(sql);
    if (!id || !active?.connected) return;
    await runTabQuery(id, sql);
  };

  return (
    <div
      className="shell"
      style={{ "--rail-w": `${rail.size}px` } as CSSProperties}
    >
      <div className="titlebar" data-tauri-drag-region>
        Clio
      </div>
      <div className="rail">
        <SchemaTree
          connections={connections}
          activeName={activeName}
          onSelect={setActiveName}
          onChanged={refresh}
          onAdd={() => setShowAdd(true)}
          onConnected={onConnected}
          onPickTable={onPickTable}
          onReviewSensitivity={setSensitivityFor}
        />
        <Splitter
          orientation="vertical"
          dragging={rail.dragging}
          title="Drag to resize · double-click to reset"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 6,
          }}
          {...rail.handleProps}
        />
      </div>
      <div className="work">
        {reveal && (
          <div className="reveal-banner" role="status">
            <span aria-hidden className="reveal-banner-glyph">⚠</span>
            <span>
              Showing real values where classified columns are present. <span style={{ color: "var(--text-muted)" }}>MCP responses remain redacted.</span>
            </span>
            <span className="reveal-banner-hint mono">⌘⌥R to hide</span>
          </div>
        )}
        <Workspace
          active={active}
          tabs={tabs.tabs}
          activeTab={tabs.activeTab}
          onSelectTab={tabs.setActive}
          onCloseTab={tabs.closeTab}
          onAddTab={tabs.addScratchTab}
          onSqlChange={(id, sql) => tabs.setSql(id, sql)}
          onRun={runActive}
          onOpenMcpModal={() => setShowMcp(true)}
          editing={editing}
          reveal={reveal}
          intellisense={intellisense}
        />
      </div>
      <AgentSurface
        events={agentEvents}
        recentQueries={recentQueries}
        onOpenSql={onAgentOpen}
        onRerunSql={onAgentRerun}
      />
      {hasTrayWork && trayBatch && trayTab && (
        <div className="tray-region">
          {commitError && (
            <div className="tray-error">
              <span className="tray-error-icon" aria-hidden>⚠</span>
              <span className="mono">{commitError}</span>
              <div className="spacer" />
              <button className="editor-btn ghost" onClick={() => setCommitError(null)}>
                Dismiss
              </button>
            </div>
          )}
          <PendingTray
            batch={trayBatch}
            pendingAdds={trayActiveAdds.filter((a) => Object.keys(a.cells).length > 0).length}
            table={trayTable || "?"}
            connection={activeName || "?"}
            busy={editing.busy}
            onReview={() => setShowReview(true)}
            onCommit={doCommit}
            onDiscard={doDiscard}
          />
        </div>
      )}
      {showReview && trayTab && trayBatch && (
        <ReviewModal
          batch={trayBatch}
          activeAdds={trayActiveAdds}
          schema={traySchema}
          table={trayTable}
          connection={activeName || "?"}
          busy={editing.busy}
          onClose={() => setShowReview(false)}
          onCommit={doCommit}
        />
      )}
      <div className={`status ${reveal ? "status--revealing" : ""}`}>
        <span>{connections.length} connection{connections.length === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>{active ? (active.connected ? "connected" : "disconnected") : "no active connection"}</span>
        {active?.connected && (
          <>
            <span>·</span>
            <button
              className="status-sens-button"
              title="Review classifications (PHI / PCI / PII)"
              onClick={() => setSensitivityFor(active.name)}
            >
              <span aria-hidden style={{ color: "var(--privacy)" }}>◌</span>
              <span>sensitivity</span>
            </button>
          </>
        )}
        {reveal && (
          <>
            <span>·</span>
            <span className="status-reveal-chip" title="View > Reveal sensitive data is ON. MCP responses are still redacted.">
              <span aria-hidden style={{ color: "var(--op-destruct)" }}>◌</span>
              revealing
            </span>
          </>
        )}
        <span style={{ marginLeft: "auto", color: "var(--text-faint)" }}>
          POC v0.0
        </span>
      </div>

      {showAdd && (
        <AddConnectionModal
          onClose={() => setShowAdd(false)}
          onAdded={() => refresh()}
        />
      )}
      {showMcp && <McpConfigModal onClose={() => setShowMcp(false)} />}
      {sensitivityFor && (
        <SensitivityModal
          connection={sensitivityFor}
          onClose={() => setSensitivityFor(null)}
        />
      )}
      <ToastHost />
    </div>
  );
}
