import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { useSnippets } from "./lib/useSnippets";
import { useSavedQueries } from "./lib/useSavedQueries";
import { SnippetsModal } from "./components/SnippetsModal";
import { SaveQuerySheet } from "./components/SaveQuerySheet";
import { CommandPalette, type CommandItem } from "./components/CommandPalette";
import type { SavedQuery } from "./lib/api";
import { useReveal } from "./lib/useReveal";
import { isEmpty as batchIsEmpty } from "./lib/editing";

export function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [sensitivityFor, setSensitivityFor] = useState<string | null>(null);

  // Bridge from the once-mounted activity listener (closure capture) to the
  // live `tabs` API — populated below after useTabs runs. Used so
  // `propose_query` events from the MCP socket can call addAgentTab without
  // every event listener rebinding on every render.
  const tabsRef = useRef<ReturnType<typeof useTabs> | null>(null);

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
      if (e.tool === "propose_query" && e.source === "mcp" && e.payload) {
        const title = e.detail || "Proposed query";
        const created = tabsRef.current?.addAgentTab(e.payload, title) ?? null;
        showToast(
          created ? (
            <span>
              <span aria-hidden style={{ color: "var(--agent)", marginRight: 6 }}>◇</span>
              Agent proposed a query: <span className="mono">{title}</span>
            </span>
          ) : (
            <span>
              <span aria-hidden style={{ color: "var(--agent)", marginRight: 6 }}>◇</span>
              Agent proposed a query — connect a database to view it.
            </span>
          ),
          "info",
        );
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
  // Keep the activity-listener-facing ref pointed at the latest tabs API. The
  // listener is registered once on mount, but `tabs` changes identity on every
  // render — see tabsRef declaration above.
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const editing = useEditing(activeName);
  // The connection is only useful for completion once it's actually connected.
  // Passing null when disconnected keeps the schema cache from racing the
  // connect → list_schemas sequence.
  const intellisense = useIntellisense(active?.connected ? activeName : null);
  const snippets = useSnippets();
  // Library: saved queries, scoped to the active connection (globals always
  // included). Hook refetches on connection change.
  const savedQueries = useSavedQueries(activeName);
  // Open state for the Snippets manager modal. `seedBody` is the initial body
  // when summoned via the editor's "Save as snippet" action; null otherwise.
  const [snippetsModalOpen, setSnippetsModalOpen] = useState(false);
  const [snippetSeed, setSnippetSeed] = useState<string | null>(null);
  // SaveQuerySheet drives both first-time saves and renames/re-scopes. The
  // tab id is captured at open time so a write-through binds the right tab
  // even if the active tab changes while the sheet is open.
  type SaveSheetState =
    | { mode: "new"; tabId: string; body: string; initialName: string }
    | { mode: "edit"; tabId: string; body: string; query: SavedQuery };
  const [saveSheet, setSaveSheet] = useState<SaveSheetState | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openConnectionsRef = useRef<(() => void) | null>(null);

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

  // ⌘K opens the command palette. Toggles closed on a second press so users
  // can dismiss without reaching for Esc. See design/README.md §"Command palette".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Commands shown in the palette. Each item is "current state" — for
  // example, "Reveal sensitive data" flips its title based on `reveal`. We
  // memoize per dep so the palette doesn't rebuild on every keystroke.
  const paletteCommands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: "new-tab",
        title: "New query tab",
        onSelect: () => {
          tabs.addScratchTab();
        },
      },
      {
        id: "toggle-reveal",
        title: reveal ? "Hide sensitive data" : "Reveal sensitive data",
        subtitle: "UI only — MCP responses stay redacted",
        kbd: "⌘⌥R",
        onSelect: () => {
          void invoke("set_reveal_sensitive", { on: !reveal });
        },
      },
      {
        id: "manage-connections",
        title: "Manage connections",
        onSelect: () => openConnectionsRef.current?.(),
      },
      {
        id: "add-connection",
        title: "Add connection…",
        onSelect: () => setShowAdd(true),
      },
      {
        id: "save-query",
        title: "Save query",
        subtitle: "Write through if already saved, else open Save",
        kbd: "⌘S",
        onSelect: () => onSave(),
      },
      {
        id: "save-query-as",
        title: "Save query as…",
        kbd: "⇧⌘S",
        onSelect: () => onSaveAs(),
      },
      {
        id: "manage-snippets",
        title: "Manage snippets…",
        onSelect: () => {
          setSnippetSeed(null);
          setSnippetsModalOpen(true);
        },
      },
      {
        id: "mcp-config",
        title: "MCP config…",
        subtitle: "Connect this workbench to an AI agent",
        onSelect: () => setShowMcp(true),
      },
    ];
    if (active?.connected) {
      items.push({
        id: "review-sensitivity",
        title: "Review sensitivity classifications…",
        subtitle: active.name,
        onSelect: () => setSensitivityFor(active.name),
      });
    }
    return items;
  }, [reveal, tabs, active?.connected, active?.name]);

  // Open a recent query in a new tab. Agent-authored queries land in an
  // agent-marked tab; user-authored go into a fresh scratch tab so the
  // authorship signal in the tab strip stays honest.
  const onPaletteOpenSql = useCallback(
    (sql: string, source: "ui" | "mcp") => {
      if (source === "mcp") {
        tabs.addAgentTab(sql);
      } else {
        const id = tabs.addScratchTab();
        if (id) tabs.setSql(id, sql);
      }
    },
    [tabs],
  );

  const onPickTable = (schema: string, table: string) => {
    tabs.openOrSwitchTable(schema, table);
  };

  // ── Library: open / save / delete ──────────────────────────────
  // Opening a saved entry reuses an untouched scratch tab when possible —
  // see useTabs.openLibraryQuery for the heuristic.
  const onOpenSavedQuery = useCallback(
    (q: SavedQuery) => {
      tabs.openLibraryQuery({ id: q.id, name: q.name, body: q.body });
    },
    [tabs],
  );

  const onRunSavedQuery = useCallback(
    (q: SavedQuery) => {
      const id = tabs.openLibraryQuery({ id: q.id, name: q.name, body: q.body });
      if (id) void runTabQuery(id, q.body);
    },
    [tabs, runTabQuery],
  );

  const onDeleteSavedQuery = useCallback(
    async (q: SavedQuery) => {
      try {
        await savedQueries.remove(q.id);
        tabs.unbindLibrary(q.id);
        showToast(`Removed "${q.name}"`, "ok");
      } catch (e) {
        showToast(String(e), "err");
      }
    },
    [savedQueries, tabs],
  );

  // ⌘S: write-through if the active tab is bound to a saved query (and the
  // entry still exists); otherwise pop the save sheet as a fresh entry.
  const onSave = useCallback(() => {
    const tab = tabs.activeTab;
    if (!tab) return;
    if (tab.source === "library" && tab.libraryId) {
      const existing = savedQueries.list.find((q) => q.id === tab.libraryId);
      if (existing) {
        void (async () => {
          try {
            const saved = await savedQueries.save({
              id: existing.id,
              name: existing.name,
              body: tab.sql,
              description: existing.description,
              connection_name: existing.connection_name,
            });
            tabs.bindLibrary(tab.id, saved.id, saved.name, saved.body);
            showToast(`Saved "${saved.name}"`, "ok");
          } catch (e) {
            showToast(String(e), "err");
          }
        })();
        return;
      }
      // The library entry vanished out from under us — fall through to
      // "Save as new".
    }
    setSaveSheet({
      mode: "new",
      tabId: tab.id,
      body: tab.sql,
      initialName: tab.title.startsWith("Query ") ? "" : tab.title,
    });
  }, [tabs, savedQueries]);

  // ⌘⇧S: always opens the sheet — even when bound, the user wants to fork.
  const onSaveAs = useCallback(() => {
    const tab = tabs.activeTab;
    if (!tab) return;
    setSaveSheet({
      mode: "new",
      tabId: tab.id,
      body: tab.sql,
      initialName: tab.title.startsWith("Query ") ? "" : tab.title,
    });
  }, [tabs]);

  // Bridge the File menu accelerators to the same handlers the in-editor
  // shortcuts use. The native menu owns ⌘S / ⌘⇧S system-wide; the CodeMirror
  // bindings stay as a fallback for the (rare) case the OS doesn't intercept.
  useEffect(() => {
    const p1 = listen("save-query", () => onSave());
    const p2 = listen("save-query-as", () => onSaveAs());
    return () => {
      p1.then((u) => u()).catch(() => {});
      p2.then((u) => u()).catch(() => {});
    };
  }, [onSave, onSaveAs]);

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
          openConnectionsRef={openConnectionsRef}
          libraryEntries={savedQueries.list}
          onOpenLibrary={onOpenSavedQuery}
          onRunLibrary={onRunSavedQuery}
          onDeleteLibrary={onDeleteSavedQuery}
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
          onSave={onSave}
          onSaveAs={onSaveAs}
          onOpenMcpModal={() => setShowMcp(true)}
          editing={editing}
          reveal={reveal}
          intellisense={intellisense}
          snippets={snippets}
          onOpenSnippets={(seed) => {
            setSnippetSeed(seed ?? null);
            setSnippetsModalOpen(true);
          }}
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
      {snippetsModalOpen && (
        <SnippetsModal
          snippets={snippets}
          seedBody={snippetSeed}
          onClose={() => {
            setSnippetsModalOpen(false);
            setSnippetSeed(null);
          }}
        />
      )}
      {saveSheet && (
        <SaveQuerySheet
          existing={saveSheet.mode === "edit" ? saveSheet.query : null}
          initialName={saveSheet.mode === "new" ? saveSheet.initialName : ""}
          body={saveSheet.body}
          connectionName={activeName}
          existingNames={savedQueries.list.map((q) => ({ id: q.id, name: q.name }))}
          onClose={() => setSaveSheet(null)}
          onSubmit={async (input) => {
            const saved = await savedQueries.save({
              id: input.id,
              name: input.name,
              body: saveSheet.body,
              description: input.description,
              connection_name: input.connection_name,
            });
            tabs.bindLibrary(saveSheet.tabId, saved.id, saved.name, saved.body);
            showToast(`Saved "${saved.name}"`, "ok");
          }}
        />
      )}
      {sensitivityFor && (
        <SensitivityModal
          connection={sensitivityFor}
          onClose={() => setSensitivityFor(null)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          connection={active}
          recentQueries={recentQueries}
          commands={paletteCommands}
          onPickTable={onPickTable}
          onOpenSql={onPaletteOpenSql}
          libraryEntries={savedQueries.list}
          onOpenLibrary={onOpenSavedQuery}
        />
      )}
      <ToastHost />
    </div>
  );
}
