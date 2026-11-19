import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import {
  api,
  onActivity,
  onAgentPresence,
  type ActivityEvent,
  type AgentInfo,
  type BuildInfo,
  type ConnectRequest,
  type Connection,
  type MigrationRequest,
  type MigrationVerdict,
  type PermissionRequest,
  type PermissionVerdict,
} from "./lib/api";
import { SchemaTree } from "./components/SchemaTree";
import { Workspace, type RunTarget } from "./components/Workspace";
import { AgentSurface } from "./components/AgentSurface";
import { PermissionCard } from "./components/PermissionCard";
import { BulkMigrationCard } from "./components/BulkMigrationCard";
import { ConnectCard } from "./components/ConnectCard";
import { PolicyModal } from "./components/PolicyModal";
import { UpdateIndicator } from "./components/UpdateIndicator";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { AddConnectionModal } from "./components/AddConnectionModal";
import { McpConfigModal } from "./components/McpConfigModal";
import { PendingTray } from "./components/PendingTray";
import { ReviewModal } from "./components/ReviewModal";
import { Modal } from "./components/Modal";
import { useElapsed } from "./components/TransactionChip";
import { SensitivityModal } from "./components/SensitivityModal";
import { Splitter } from "./components/Splitter";
import { Lunate, ClioWord, RecordMeta } from "./components/brand";
import { ToastHost, showToast } from "./components/Toast";
import { useResizable } from "./lib/useResizable";
import { useTabs } from "./lib/useTabs";
import { splitStatements } from "./lib/sqlStatements";
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

/** A human-approval request awaiting a verdict. All three carry an `id` and an
 *  optional `agent_id` so the card can attribute the ask to a specific agent. */
type Pending =
  | { kind: "permission"; req: PermissionRequest }
  | { kind: "migration"; req: MigrationRequest }
  | { kind: "connect"; req: ConnectRequest };

export function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [sensitivityFor, setSensitivityFor] = useState<string | null>(null);
  // Pending human-approval requests, FIFO. With multiple agents connected,
  // several can be outstanding at once (a write prompt from one, a connect
  // request from another) — we surface the head and badge the rest, rather
  // than dropping any. Each carries the originating agent for attribution.
  const [pending, setPending] = useState<Pending[]>([]);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Live roster of connected agents (from the `agent_presence` event).
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // Build metadata for the status bar (version + DEV pill). Fetched once.
  const [build, setBuild] = useState<BuildInfo | null>(null);

  // Bridge from the once-mounted activity listener (closure capture) to the
  // live `tabs` API — populated below after useTabs runs. Used so
  // `propose_query` events from the MCP socket can call addAgentTab without
  // every event listener rebinding on every render.
  const tabsRef = useRef<ReturnType<typeof useTabs> | null>(null);

  // Shared session clock — status bar and agent dock both render off this.
  const sessionStartRef = useRef(Date.now());

  // Connection currently being opened. Drives the "Opening the record…" hero
  // in the workspace. SchemaTree fires the start/end signals around api.connect.
  const [connectingConn, setConnectingConn] = useState<Connection | null>(null);

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
      // Functional update so the activity-listener-captured `refresh` (which
      // closes over the mount-time `activeName === null`) can't clobber a
      // user-driven switch that fires concurrently with a connect event.
      setActiveName((prev) => prev ?? (cs[0]?.name ?? null));
    } catch (e) {
      console.error(e);
    }
  };

  // One-shot build metadata for the status-bar badge.
  useEffect(() => {
    api.build_info().then(setBuild).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = onActivity((e) => {
      setEvents((prev) => [...prev.slice(-199), e]);
      if (e.tool === "connect" || e.tool === "disconnect" || e.tool === "add_connection" || e.tool === "delete_connection") {
        refresh();
      }
      // Enqueue approval requests (dedup by id). Inlined functional updates so
      // the once-mounted listener never closes over stale state.
      if (e.tool === "permission_required" && e.payload) {
        try {
          const req = JSON.parse(e.payload) as PermissionRequest;
          setPending((prev) =>
            prev.some((p) => p.req.id === req.id) ? prev : [...prev, { kind: "permission", req }],
          );
        } catch (parseErr) {
          console.error("permission_required: bad payload", parseErr);
        }
      }
      if (e.tool === "migration_required" && e.payload) {
        try {
          const req = JSON.parse(e.payload) as MigrationRequest;
          setPending((prev) =>
            prev.some((p) => p.req.id === req.id) ? prev : [...prev, { kind: "migration", req }],
          );
        } catch (parseErr) {
          console.error("migration_required: bad payload", parseErr);
        }
      }
      if (e.tool === "connect_required" && e.payload) {
        try {
          const req = JSON.parse(e.payload) as ConnectRequest;
          setPending((prev) =>
            prev.some((p) => p.req.id === req.id) ? prev : [...prev, { kind: "connect", req }],
          );
        } catch (parseErr) {
          console.error("connect_required: bad payload", parseErr);
        }
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

  useEffect(() => {
    const unlisten = onAgentPresence(setAgents);
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  const active = connections.find((c) => c.name === activeName) ?? null;
  const mcpConnected = agents.length > 0;
  // Head of the approval queue is the card currently surfaced; the rest are
  // badged as "+N waiting". Resolving the head reveals the next.
  const head = pending[0] ?? null;
  const labelFor = useCallback(
    (agentId?: string) => agents.find((a) => a.id === agentId)?.label ?? "Agent",
    [agents],
  );
  const dropPending = useCallback(
    (id: string) => setPending((prev) => prev.filter((p) => p.req.id !== id)),
    [],
  );
  const reveal = useReveal();
  const tabs = useTabs(activeName);
  // Keep the activity-listener-facing ref pointed at the latest tabs API. The
  // listener is registered once on mount, but `tabs` changes identity on every
  // render — see tabsRef declaration above.
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  // Like intellisense: table metadata is only fetched for a connected
  // connection, so a restored tab can't make describe_table calls against a
  // disconnected one.
  const editing = useEditing(active?.connected ? activeName : null);
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

  // Run `text` (one or more statements) in a tab. `offset` is where `text`
  // sits in the tab's SQL, so the run's statements map back to the editor.
  const runTabQuery = useCallback(
    async (tabId: string, text: string, offset = 0) => {
      if (!activeName) return;
      const stmts = splitStatements(text).map((st) => ({ ...st, from: st.from + offset, to: st.to + offset }));
      if (stmts.length === 0) {
        tabs.updateTab(tabId, { error: "Nothing to run — only comments or whitespace.", result: null, lastRun: null });
        return;
      }
      tabs.updateTab(tabId, { running: true, error: null });
      try {
        const script = await api.run_script(activeName, tabId, stmts.map((st) => st.sql), reveal);
        const failed = script.steps.find((st) => st.error);
        const grid = !!script.result && script.result.columns.length > 0;
        const messages =
          stmts.length > 1 ||
          !!script.error ||
          script.steps.some((st) => st.notices.length > 0 || st.rolled_back);
        tabs.updateTab(tabId, {
          running: false,
          dirty: false,
          result: script.result,
          // A lone statement's error shows where it always has; a script's
          // shows in its messages, next to the statements that did run.
          error: script.error ?? (stmts.length === 1 ? failed?.error ?? null : null),
          lastRun: { statements: stmts, script },
          tx: script.transaction ? { openedAtMs: script.transaction.opened_at_ms } : null,
          // Messages when there's no grid to show, or a failure undid work —
          // what was rolled back matters more than the error pill alone.
          resultView:
            messages && (!grid || (!!failed && (stmts.length > 1 || !!failed.rolled_back)))
              ? "messages"
              : "results",
        });
      } catch (e) {
        tabs.updateTab(tabId, { error: String(e), running: false, result: null, lastRun: null });
      }
    },
    [tabs, activeName, reveal],
  );

  const runActive = useCallback(
    async (target?: RunTarget) => {
      const tab = tabs.activeTab;
      if (!tab || !activeName) return;
      if (!active?.connected) {
        tabs.updateTab(tab.id, { error: "Not connected. Click a connection in the rail.", result: null });
        return;
      }
      await runTabQuery(tab.id, target?.text ?? tab.sql, target?.offset ?? 0);
    },
    [tabs, activeName, active?.connected, runTabQuery],
  );

  // When the reveal toggle flips, re-run the active tab's last query so the
  // user immediately sees real or fake values per the new state. Background
  // tabs stay stale until the user switches to them — predictable, and avoids
  // a stampede of queries on toggle. Only a lone read re-runs: repeating a
  // script or a write would repeat its changes.
  useEffect(() => {
    const tab = tabs.activeTab;
    const only = tab?.lastRun?.statements.length === 1 ? tab.lastRun.statements[0] : null;
    if (!tab || !active?.connected || !tab.result || !only) return;
    if (!/^(select|table|values|show|with)\b/i.test(only.sql)) return;
    if (/\b(insert|update|delete|merge)\b/i.test(only.sql)) return;
    void runTabQuery(tab.id, only.sql, only.from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  // ── Open transactions ─────────────────────────────────────────
  const endTransaction = useCallback(
    async (tabId: string, commit: boolean) => {
      tabs.updateTab(tabId, { running: true });
      try {
        await api.end_transaction(tabId, commit);
        tabs.updateTab(tabId, { running: false, tx: null });
        showToast(commit ? "Committed" : "Rolled back", "ok");
      } catch (e) {
        // Either way the transaction is over: a failed COMMIT rolls back.
        tabs.updateTab(tabId, { running: false, tx: null, error: String(e) });
        showToast(commit ? "Commit failed — the transaction was rolled back" : "Roll back failed", "err");
      }
    },
    [tabs],
  );

  // Closing a tab or disconnecting rolls back its open transaction, so ask
  // first. Tauri's webview drops window.confirm — this is an inline modal.
  type TxConfirm = { title: string; body: string; action: string; resolve: (ok: boolean) => void };
  const [txConfirm, setTxConfirm] = useState<TxConfirm | null>(null);
  const askTx = (c: Omit<TxConfirm, "resolve">) =>
    new Promise<boolean>((resolve) => setTxConfirm({ ...c, resolve }));
  const settleTx = (ok: boolean) => {
    txConfirm?.resolve(ok);
    setTxConfirm(null);
  };

  const requestCloseTab = useCallback(
    async (id: string) => {
      const tab = tabs.tabs.find((t) => t.id === id);
      if (tab?.tx) {
        const ok = await askTx({
          title: "Roll back and close?",
          body: `“${tab.title}” has an open transaction. Closing the tab rolls it back; nothing in it is committed.`,
          action: "Roll back & close",
        });
        if (!ok) return;
        await api.end_transaction(id, false).catch(() => {});
      }
      tabs.closeTab(id);
    },
    [tabs],
  );

  const confirmDisconnect = useCallback(
    async (name: string) => {
      if (name !== activeName) return true;
      const open = tabs.tabs.filter((t) => t.tx);
      if (open.length === 0) return true;
      const ok = await askTx({
        title: "Disconnect and roll back?",
        body: `${open.length === 1 ? `“${open[0].title}” has` : `${open.length} tabs have`} an open transaction on ${name}. Disconnecting rolls ${open.length === 1 ? "it" : "them"} back; nothing in ${open.length === 1 ? "it" : "them"} is committed.`,
        action: "Roll back & disconnect",
      });
      // The backend rolls them back on disconnect.
      if (ok) for (const t of open) tabs.updateTab(t.id, { tx: null });
      return ok;
    },
    [tabs, activeName],
  );
  const activeTxElapsed = useElapsed(tabs.activeTab?.tx?.openedAtMs ?? null);
  const otherTxCount = tabs.tabs.filter((t) => t.tx && t.id !== tabs.activeTab?.id).length;

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
    // Grid edits commit on their own connection; behind this tab's open
    // transaction they could wait forever on its row locks.
    if (trayTab.tx) {
      setCommitError("This tab has an open transaction. Commit or roll it back first — grid edits commit separately.");
      return;
    }
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

  // ⌘⇧. opens the policy viewer (design/README.md §"Keyboard shortcuts ·
  // Agent"). Toggle behavior matches ⌘K. Note: with shift held on US
  // keyboards, e.key is ">" — not ".". We match either so the binding fires
  // regardless of which event Webkit hands us.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "." || e.key === ">")) {
        e.preventDefault();
        setPolicyOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // `?` opens the keyboard shortcuts overlay (design/screenshots/31).
  // Suppress when focus is inside an input/textarea so typing `?` in the
  // schema filter or SQL editor doesn't summon the overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "?") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      e.preventDefault();
      setShortcutsOpen((v) => !v);
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
        id: "check-updates",
        title: "Check for updates…",
        subtitle: "Look for a newer Clio on GitHub",
        onSelect: () => {
          void emit("check-for-updates");
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
      {
        id: "view-policy",
        title: "View policy rules",
        subtitle: "What the permission gate is enforcing",
        kbd: "⌘⇧.",
        onSelect: () => setPolicyOpen(true),
      },
      {
        id: "view-shortcuts",
        title: "Keyboard shortcuts",
        kbd: "?",
        onSelect: () => setShortcutsOpen(true),
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
  // returns new_pending: 0, which we suppress. A null outcome means the scan
  // failed: the human can still query, but agents are refused the connection.
  // Columns the shared file marks safe that still redact here come first:
  // they're the ones waiting on the human.
  const onConnected = useCallback(
    (
      name: string,
      outcome: { new_pending: number; shared_safe_waiting: number } | null,
    ) => {
      if (!outcome) {
        showToast(
          <span>
            Sensitivity scan failed on <span className="mono">{name}</span>. Agents can't use
            this connection until a reconnect scans it.
          </span>,
          "err",
        );
        return;
      }
      const waiting = outcome.shared_safe_waiting;
      if (outcome.new_pending === 0 && waiting === 0) return;
      const n = waiting || outcome.new_pending;
      showToast(
        (
          <span>
            <span aria-hidden style={{ color: "var(--privacy)", marginRight: 6 }}>
              ◌
            </span>
            <span className="mono">{n}</span> column{n === 1 ? "" : "s"}{" "}
            {waiting
              ? "marked safe in the shared file still redacted"
              : "auto-classified as sensitive"}{" "}
            on <span className="mono">{name}</span>
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
        <Lunate size={13} color="var(--text-secondary)" />
        <ClioWord size={12} dot={false} color="var(--text-primary)" />
        {active && (
          <>
            <span className="titlebar-sep" aria-hidden>·</span>
            <span className="titlebar-token">{active.name}</span>
          </>
        )}
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
          onConnectingChange={setConnectingConn}
          confirmDisconnect={confirmDisconnect}
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
          connecting={connectingConn}
          tabs={tabs.tabs}
          activeTab={tabs.activeTab}
          onSelectTab={tabs.setActive}
          onCloseTab={requestCloseTab}
          onAddTab={tabs.addScratchTab}
          onSqlChange={(id, sql) => tabs.setSql(id, sql)}
          onRun={runActive}
          onEndTransaction={(commit) => tabs.activeTab && endTransaction(tabs.activeTab.id, commit)}
          onResultView={(view) => tabs.activeTab && tabs.updateTab(tabs.activeTab.id, { resultView: view })}
          onSave={onSave}
          onSaveAs={onSaveAs}
          onOpenMcpModal={() => setShowMcp(true)}
          onAddConnection={() => setShowAdd(true)}
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
      {head && (
        <div style={{ gridArea: "permission", display: "flex", flexDirection: "column", minWidth: 0 }}>
          {pending.length > 1 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 16px",
                fontSize: 11,
                color: "var(--text-muted)",
                background: "var(--bg-elevated)",
                borderTop: "1px solid var(--line-soft)",
              }}
            >
              <span aria-hidden style={{ color: "var(--agent)" }}>◆</span>
              {pending.length - 1} more request{pending.length - 1 === 1 ? "" : "s"} waiting
            </div>
          )}
          {head.kind === "permission" ? (
            <PermissionCard
              request={head.req}
              agentLabel={labelFor(head.req.agent_id)}
              onResolve={async (verdict: PermissionVerdict) => {
                const req = head.req;
                dropPending(req.id);
                try {
                  await api.resolve_permission(req.id, verdict);
                } catch (err) {
                  showToast(<span>Couldn&apos;t resolve permission: {String(err)}</span>, "err");
                  setPending((prev) =>
                    prev.some((p) => p.req.id === req.id) ? prev : [{ kind: "permission", req }, ...prev],
                  );
                }
              }}
            />
          ) : head.kind === "migration" ? (
            <BulkMigrationCard
              request={head.req}
              agentLabel={labelFor(head.req.agent_id)}
              onResolve={async (verdict: MigrationVerdict) => {
                const req = head.req;
                dropPending(req.id);
                try {
                  await api.resolve_migration(req.id, verdict);
                } catch (err) {
                  showToast(<span>Couldn&apos;t resolve migration: {String(err)}</span>, "err");
                  setPending((prev) =>
                    prev.some((p) => p.req.id === req.id) ? prev : [{ kind: "migration", req }, ...prev],
                  );
                }
              }}
            />
          ) : (
            <ConnectCard
              request={head.req}
              agentLabel={labelFor(head.req.agent_id)}
              onResolve={async (approve: boolean) => {
                const req = head.req;
                dropPending(req.id);
                try {
                  await api.resolve_connect(req.id, approve);
                } catch (err) {
                  showToast(<span>Couldn&apos;t resolve connection request: {String(err)}</span>, "err");
                }
              }}
            />
          )}
        </div>
      )}
      <AgentSurface
        events={agentEvents}
        recentQueries={recentQueries}
        onOpenSql={onAgentOpen}
        onRerunSql={onAgentRerun}
        awaiting={pending.length > 0}
        agents={agents}
        mcpConnected={mcpConnected}
        sessionStart={sessionStartRef.current}
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
        <RecordMeta
          sessionStart={sessionStartRef.current}
          entryCount={events.length}
          lunateSize={9}
        />
        <span className="status-divider" aria-hidden />
        <span>{connections.length} connection{connections.length === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>{active ? (active.connected ? "connected" : "disconnected") : "no active connection"}</span>
        {active?.connected && (
          <>
            <span>·</span>
            <span
              className={`mono${tabs.activeTab?.tx ? " status-tx--active" : ""}`}
              title={otherTxCount > 0 ? `${otherTxCount} other tab${otherTxCount === 1 ? "" : "s"} on this connection hold an open transaction` : undefined}
            >
              tx: {tabs.activeTab?.tx ? `active ${activeTxElapsed}` : "none"}
              {otherTxCount > 0 && ` · +${otherTxCount} tab${otherTxCount === 1 ? "" : "s"}`}
            </span>
          </>
        )}
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
        <span>·</span>
        <button
          className="status-sens-button"
          title="View policy rules (⌘⇧.)"
          onClick={() => setPolicyOpen(true)}
        >
          <span aria-hidden style={{ color: "var(--op-write)" }}>⚖</span>
          <span>policy: default</span>
        </button>
        <span className="status-build">
          <UpdateIndicator autoCheck={!!build && !build.is_dev} />
          {build?.is_dev && (
            <span
              className="dev-pill"
              title="Development build — secrets live in dev-secrets.json, not the OS keyring"
            >
              DEV
            </span>
          )}
          <span style={{ color: "var(--text-faint)" }}>
            {build ? `v${build.version}` : "…"}
          </span>
        </span>
      </div>

      {txConfirm && (
        <Modal onClose={() => settleTx(false)} className="review-modal tx-confirm">
          <div className="review-head">
            <span className="review-title">{txConfirm.title}</span>
          </div>
          <div className="tx-confirm-body">{txConfirm.body}</div>
          <div className="review-foot">
            <div className="spacer" />
            <button className="editor-btn ghost" onClick={() => settleTx(false)} autoFocus>
              Cancel
            </button>
            <button className="editor-btn primary-destruct" onClick={() => settleTx(true)}>
              {txConfirm.action}
            </button>
          </div>
        </Modal>
      )}

      {showAdd && (
        <AddConnectionModal
          onClose={() => setShowAdd(false)}
          onAdded={() => refresh()}
        />
      )}
      {showMcp && <McpConfigModal onClose={() => setShowMcp(false)} />}
      {policyOpen && (
        <PolicyModal
          connection={activeName}
          onClose={() => setPolicyOpen(false)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}
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
