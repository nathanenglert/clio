import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  onActivity,
  type ActivityEvent,
  type Classification,
  type ClassifyOutcome,
  type ColumnSearchHit,
  type Connection,
  type SavedQuery,
  type TableKind,
  type TableSummary,
} from "../lib/api";

type Props = {
  connections: Connection[];
  activeName: string | null;
  onSelect: (name: string) => void;
  /** Called after any connection lifecycle change (connect / disconnect /
   *  delete) so the App can refresh the connection list. */
  onChanged: () => void;
  onAdd: () => void;
  /** Fires after a successful connect with the classification outcome — used
   *  by the App to surface the "auto-classified" toast. */
  onConnected?: (name: string, outcome: ClassifyOutcome | null) => void;
  onPickTable?: (schema: string, table: string) => void;
  /** Open the sensitivity review panel for this connection. Wired to the
   *  privacy badge next to a table row. */
  onReviewSensitivity?: (connection: string) => void;
  /** Imperative hook: receives a fn the parent can call to pop open the
   *  connections popover. Used by the command palette ("Manage connections"). */
  openConnectionsRef?: React.MutableRefObject<(() => void) | null>;
  /** Saved queries in scope for the current connection (globals + scoped). */
  libraryEntries?: SavedQuery[];
  /** Open a saved query in a tab. */
  onOpenLibrary?: (q: SavedQuery) => void;
  /** Open a saved query in a tab and run it immediately. */
  onRunLibrary?: (q: SavedQuery) => void;
  /** Delete a saved query (already confirmed at the call site). */
  onDeleteLibrary?: (q: SavedQuery) => void;
  /** Fired around api.connect so App can drive the "Opening the record…"
   *  hero. Start with the in-flight Connection, end with null. */
  onConnectingChange?: (conn: Connection | null) => void;
};

const DELETE_CONFIRM_TIMEOUT_MS = 3000;

type ClassIndex = {
  byTable: Map<string, { count: number; pending: number }>;
  byColumn: Map<string, Classification>;
};

const EMPTY_INDEX: ClassIndex = { byTable: new Map(), byColumn: new Map() };

function buildClassIndex(rows: Classification[]): ClassIndex {
  const byTable = new Map<string, { count: number; pending: number }>();
  const byColumn = new Map<string, Classification>();
  for (const r of rows) {
    const tk = `${r.schema}.${r.table}`;
    const ck = `${tk}.${r.column}`;
    byColumn.set(ck, r);
    const cur = byTable.get(tk) ?? { count: 0, pending: 0 };
    cur.count += 1;
    if (r.status === "pending") cur.pending += 1;
    byTable.set(tk, cur);
  }
  return { byTable, byColumn };
}

// Best-effort extraction of `schema.table` refs from an agent's SQL. Used to
// light up the per-table agent-touched dot. False positives are fine — this
// is a hint, not a contract. We default unqualified refs to `public`, which
// is the standard Postgres search_path default.
const SQL_TABLE_RE =
  /\b(?:from|join|into|update|truncate)\s+(?:only\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))(?:\s*\.\s*(?:"([^"]+)"|([a-z_][a-z0-9_]*)))?/gi;

function extractTouchedFromSql(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(SQL_TABLE_RE)) {
    const a = m[1] ?? m[2];
    const b = m[3] ?? m[4];
    if (b) out.push(`${a}.${b}`);
    else if (a) out.push(`public.${a}`);
  }
  return out;
}

function formatRowCount(n: number | undefined): string {
  if (n === undefined) return "";
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`.replace(".0K", "K");
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`.replace(".0M", "M");
  return `${(n / 1_000_000_000).toFixed(1)}B`.replace(".0B", "B");
}

function TableGlyph({ kind }: { kind: TableKind }) {
  // Distinct stroke shapes so views read differently from tables at a glance.
  if (kind === "view" || kind === "matview") {
    return (
      <svg className="tg" viewBox="0 0 12 12" aria-hidden>
        <rect x="1.5" y="2.5" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" />
        <circle cx="6" cy="6" r="1.3" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="tg" viewBox="0 0 12 12" aria-hidden>
      <rect x="1.5" y="2.5" width="9" height="7" rx="1" fill="none" stroke="currentColor" />
      <line x1="1.5" y1="5" x2="10.5" y2="5" stroke="currentColor" />
      <line x1="5" y1="2.5" x2="5" y2="9.5" stroke="currentColor" />
    </svg>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="hl">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function SchemaTree({
  connections,
  activeName,
  onSelect,
  onChanged,
  onAdd,
  onConnected,
  onPickTable,
  onReviewSensitivity,
  openConnectionsRef,
  libraryEntries,
  onOpenLibrary,
  onRunLibrary,
  onDeleteLibrary,
  onConnectingChange,
}: Props) {
  const connection = connections.find((c) => c.name === activeName) ?? null;
  const connectionName = connection && connection.connected ? connection.name : null;

  // Library section open state — independent of the schema tree, persisted
  // across re-renders but not across reloads (intentional: less state to
  // manage; default open is fine since the row count is the only chrome).
  const [libraryOpen, setLibraryOpen] = useState(true);
  // Row id pending delete confirmation. A row enters "armed" state on first
  // click of the × button; second click within the timeout window deletes.
  const [libraryArmed, setLibraryArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!libraryArmed) return;
    const t = window.setTimeout(() => setLibraryArmed(null), DELETE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [libraryArmed]);

  const [schemas, setSchemas] = useState<string[]>([]);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, TableSummary[]>>({});
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classIndex, setClassIndex] = useState<ClassIndex>(EMPTY_INDEX);

  // Filter / search state.
  const [filter, setFilter] = useState("");
  const [colHits, setColHits] = useState<ColumnSearchHit[]>([]);
  const [colSearchPending, setColSearchPending] = useState(false);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // Agent-touched tables this session — `schema.table` keys, mcp source only.
  const [agentTouched, setAgentTouched] = useState<Set<string>>(new Set());

  // Keyboard focus inside the visible list.
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Bumped by the refresh button to force the schema-loading effect to re-run
  // without changing the connection.
  const [reloadKey, setReloadKey] = useState(0);

  // ── Connection popover state ────────────────────────────────────────
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [busyConn, setBusyConn] = useState<string | null>(null);
  const [connErrors, setConnErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const deleteTimer = useRef<number | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLButtonElement | null>(null);

  // ── Popover plumbing ────────────────────────────────────────────────
  // Cleanup the pending-delete timer on unmount so it can't fire after the
  // component is gone.
  useEffect(() => {
    return () => {
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    };
  }, []);

  // Expose an imperative "open the connections popover" handle. The command
  // palette wires this so "Manage connections" reuses the rail's existing
  // popover rather than introducing a parallel surface.
  useEffect(() => {
    if (!openConnectionsRef) return;
    openConnectionsRef.current = () => setPopoverOpen(true);
    return () => {
      openConnectionsRef.current = null;
    };
  }, [openConnectionsRef]);

  // Close popover on outside click or Escape.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (headerRef.current?.contains(t)) return;
      setPopoverOpen(false);
      setPendingDelete(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPopoverOpen(false);
        setPendingDelete(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  const clearConnError = (name: string) =>
    setConnErrors((m) => {
      const { [name]: _, ...rest } = m;
      return rest;
    });

  // Click a row in the popover: connect (if needed) + select. Clicking the
  // already-active row toggles its connection (disconnects an active conn).
  const handleConnRowClick = async (c: Connection) => {
    setBusyConn(c.name);
    clearConnError(c.name);
    try {
      const wasActive = c.name === activeName;
      if (wasActive && c.connected) {
        await api.disconnect(c.name);
      } else {
        if (!c.connected) {
          onConnectingChange?.(c);
          try {
            const outcome = await api.connect(c.name);
            onConnected?.(c.name, outcome);
          } finally {
            onConnectingChange?.(null);
          }
        }
        // onSelect after the await so a failed connect leaves the previous
        // active in place — the inline error is shown in the popover and
        // the workspace keeps the user's current context.
        onSelect(c.name);
      }
      onChanged();
      setPopoverOpen(false);
    } catch (e) {
      setConnErrors((m) => ({ ...m, [c.name]: String(e) }));
    } finally {
      setBusyConn(null);
    }
  };

  const armOrConfirmDelete = async (c: Connection, ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (pendingDelete === c.name) {
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
      deleteTimer.current = null;
      setPendingDelete(null);
      try {
        await api.delete_connection(c.name);
        clearConnError(c.name);
        onChanged();
      } catch (e) {
        setConnErrors((m) => ({ ...m, [c.name]: String(e) }));
      }
      return;
    }
    setPendingDelete(c.name);
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    deleteTimer.current = window.setTimeout(() => {
      setPendingDelete((cur) => (cur === c.name ? null : cur));
      deleteTimer.current = null;
    }, DELETE_CONFIRM_TIMEOUT_MS);
  };

  // ── Classifications (existing privacy badge wiring) ─────────────────
  useEffect(() => {
    if (!connectionName) {
      setClassIndex(EMPTY_INDEX);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .list_classifications(connectionName)
        .then((rows) => {
          if (!cancelled) setClassIndex(buildClassIndex(rows));
        })
        .catch(() => {
          /* non-fatal — badges just won't render */
        });
    };
    load();
    const unlisten = onActivity((e) => {
      if (e.tool === "classify_schema" || e.tool === "update_classification") {
        load();
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((u) => u()).catch(() => {});
    };
  }, [connectionName]);

  // ── Agent-touched tables, derived from the activity stream ──────────
  // Only mcp-source events count — the dot signals "agent touched this," not
  // "you touched this" (see design/README.md on the activity surface).
  useEffect(() => {
    setAgentTouched(new Set());
    if (!connectionName) return;
    const handle = (e: ActivityEvent) => {
      if (e.source !== "mcp" || e.status !== "ok") return;
      const next = new Set<string>();
      let changed = false;
      const add = (key: string) => {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      };
      if (e.tool === "describe_table" && e.detail.includes("/")) {
        const after = e.detail.split("/", 2)[1] ?? "";
        if (after.includes(".")) add(after);
      } else if (e.tool === "run_query" && e.payload) {
        for (const k of extractTouchedFromSql(e.payload)) add(k);
      }
      if (changed) {
        setAgentTouched((prev) => {
          const merged = new Set(prev);
          let dirty = false;
          for (const k of next) {
            if (!merged.has(k)) {
              merged.add(k);
              dirty = true;
            }
          }
          return dirty ? merged : prev;
        });
      }
    };
    const unlisten = onActivity(handle);
    return () => {
      unlisten.then((u) => u()).catch(() => {});
    };
  }, [connectionName]);

  // ── Eagerly load schemas + their tables on connect ──────────────────
  // Row counts and table-name filtering need the full picture without forcing
  // the user to manually expand each schema. We parallelize list_tables across
  // schemas to keep first paint quick.
  useEffect(() => {
    setSchemas([]);
    setOpenSchemas({});
    setTablesBySchema({});
    setError(null);
    setFilter("");
    setColHits([]);
    setFocusedIdx(0);
    if (!connectionName) {
      setLoadingRoot(false);
      return;
    }
    let cancelled = false;
    setLoadingRoot(true);
    (async () => {
      try {
        const ss = await api.list_schemas(connectionName);
        if (cancelled) return;
        setSchemas(ss);
        // Expand the first schema by default (usually "public") so the rail
        // doesn't open empty.
        setOpenSchemas(ss.length > 0 ? { [ss[0]]: true } : {});
        // Fan out list_tables for every schema in parallel; merge results as
        // they arrive so the UI doesn't block on the slowest one.
        const results = await Promise.all(
          ss.map((s) =>
            api
              .list_tables(connectionName, s)
              .then((tables) => [s, tables] as const)
              .catch(() => [s, [] as TableSummary[]] as const),
          ),
        );
        if (cancelled) return;
        const next: Record<string, TableSummary[]> = {};
        for (const [s, tables] of results) next[s] = tables;
        setTablesBySchema(next);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoadingRoot(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionName, reloadKey]);

  // ── Debounced column search ─────────────────────────────────────────
  useEffect(() => {
    const q = filter.trim();
    if (!connectionName || q.length < 2) {
      setColHits([]);
      setColSearchPending(false);
      return;
    }
    setColSearchPending(true);
    const t = setTimeout(() => {
      let cancelled = false;
      api
        .search_columns(connectionName, q, 50)
        .then((hits) => {
          if (!cancelled) setColHits(hits);
        })
        .catch(() => {
          if (!cancelled) setColHits([]);
        })
        .finally(() => {
          if (!cancelled) setColSearchPending(false);
        });
      return () => {
        cancelled = true;
      };
    }, 180);
    return () => clearTimeout(t);
  }, [filter, connectionName]);

  // ── Filtered table view ─────────────────────────────────────────────
  type RowTable = {
    kind: "table";
    schema: string;
    table: TableSummary;
  };
  type RowSchema = { kind: "schema-header"; schema: string; count: number };

  const filteredView = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) {
      const out: (RowSchema | RowTable)[] = [];
      for (const s of schemas) {
        const tables = tablesBySchema[s] ?? [];
        out.push({ kind: "schema-header", schema: s, count: tables.length });
        if (openSchemas[s]) {
          for (const t of tables) out.push({ kind: "table", schema: s, table: t });
        }
      }
      return out;
    }
    // Search mode: flat list of table matches, grouped under a single header.
    const matches: RowTable[] = [];
    for (const s of schemas) {
      for (const t of tablesBySchema[s] ?? []) {
        if (t.name.toLowerCase().includes(q)) matches.push({ kind: "table", schema: s, table: t });
      }
    }
    return matches;
  }, [schemas, tablesBySchema, openSchemas, filter]);

  // Reset focused index when the visible list shrinks.
  useEffect(() => {
    if (focusedIdx >= filteredView.length) setFocusedIdx(Math.max(0, filteredView.length - 1));
  }, [filteredView.length, focusedIdx]);

  // Library entries filtered by the same search box (name + description).
  // No fancy ranking — substring match is enough at expected list sizes.
  const filteredLibrary = useMemo(() => {
    const entries = libraryEntries ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }, [libraryEntries, filter]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && filter) {
      e.preventDefault();
      setFilter("");
      return;
    }
    if (filteredView.length === 0) return;
    const node = filteredView[focusedIdx];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(Math.min(filteredView.length - 1, focusedIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(Math.max(0, focusedIdx - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!node) return;
      if (node.kind === "table" && onPickTable) onPickTable(node.schema, node.table.name);
      else if (node.kind === "schema-header")
        setOpenSchemas((m) => ({ ...m, [node.schema]: !m[node.schema] }));
    } else if (e.key === "ArrowRight" && node?.kind === "schema-header") {
      e.preventDefault();
      setOpenSchemas((m) => ({ ...m, [node.schema]: true }));
    } else if (e.key === "ArrowLeft" && node?.kind === "schema-header") {
      e.preventDefault();
      setOpenSchemas((m) => ({ ...m, [node.schema]: false }));
    }
  };

  // Zero-connection empty state: the header turns into the add-connection
  // entry point. No filter, no body — there's nothing to filter or browse.
  if (connections.length === 0) {
    return (
      <div className="schema">
        <div className="schema-empty-state">
          <div className="schema-empty-state-title">No connections yet</div>
          <button type="button" className="schema-empty-state-add" onClick={onAdd}>
            + Add connection
          </button>
        </div>
      </div>
    );
  }

  const q = filter.trim();
  const inSearch = q.length > 0;
  const tableMatchCount = inSearch ? filteredView.length : 0;
  const colMatchCount = inSearch ? colHits.length : 0;

  // Without an active connection (or when active is disconnected) the rail
  // still surfaces the connection switcher — that's the user's way back.
  const headerLabel = connection?.name ?? "Pick a connection";
  const headerHost = connection
    ? `${connection.host}${connection.database ? `/${connection.database}` : ""}`
    : "click to switch · + add to create";

  return (
    <div className="schema" onKeyDown={onKey} tabIndex={-1}>
      {/* ── Connection header (popover trigger) ────────────────────── */}
      <header className="schema-conn">
        <button
          ref={headerRef}
          type="button"
          className={`schema-conn-trigger${popoverOpen ? " open" : ""}`}
          onClick={() => {
            setPopoverOpen((v) => !v);
            setPendingDelete(null);
          }}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          title={connection ? "Switch or manage connections" : "Pick a connection"}
        >
          <span
            className={`schema-conn-dot ${connection?.connected ? "ok" : "idle"}`}
            aria-hidden
          />
          <div className="schema-conn-text">
            <div className="schema-conn-name">{headerLabel}</div>
            <div className="schema-conn-host mono">{headerHost}</div>
          </div>
          <span className="schema-conn-caret" aria-hidden>
            ▾
          </span>
        </button>
        {connection?.connected && (
          <button
            type="button"
            className="schema-conn-refresh"
            onClick={(e) => {
              e.stopPropagation();
              setReloadKey((k) => k + 1);
            }}
            title="Refresh schema"
            aria-label="Refresh schema"
          >
            ↻
          </button>
        )}
        {popoverOpen && (
          <div
            ref={popoverRef}
            className="schema-conn-popover"
            role="menu"
            aria-label="Connections"
          >
            <div className="schema-conn-popover-header">
              <span>Connections</span>
              <button
                type="button"
                className="schema-conn-popover-add"
                onClick={() => {
                  setPopoverOpen(false);
                  onAdd();
                }}
              >
                + add
              </button>
            </div>
            <ul className="schema-conn-popover-list">
              {connections.map((c) => {
                const isActive = c.name === activeName;
                const armed = pendingDelete === c.name;
                const isBusy = busyConn === c.name;
                return (
                  <li key={c.id}>
                    <div className={`schema-conn-row${armed ? " armed" : ""}`}>
                      <button
                        type="button"
                        className={`schema-conn-row-main${isActive ? " active" : ""}`}
                        onClick={() => handleConnRowClick(c)}
                        disabled={isBusy}
                        title={
                          isActive && c.connected
                            ? "Click to disconnect"
                            : isActive
                              ? "Click to reconnect"
                              : `Switch to ${c.name}`
                        }
                      >
                        <span
                          className={`schema-conn-row-dot ${c.connected ? "ok" : "idle"}`}
                          aria-hidden
                        />
                        <div className="schema-conn-row-text">
                          <div className="schema-conn-row-name">{c.name}</div>
                          <div className="schema-conn-row-host mono">
                            {c.host}
                            {c.database ? `/${c.database}` : ""}
                          </div>
                        </div>
                        {isBusy && (
                          <span className="schema-conn-row-busy mono" aria-hidden>
                            {c.connected ? "disconnecting…" : "connecting…"}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className={`schema-conn-row-del${armed ? " armed" : ""}`}
                        onClick={(e) => armOrConfirmDelete(c, e)}
                        title={armed ? "Click again within 3s to confirm" : "Delete"}
                      >
                        {armed ? "delete?" : "×"}
                      </button>
                    </div>
                    {connErrors[c.name] && (
                      <div
                        className="schema-conn-row-error mono"
                        onClick={() => clearConnError(c.name)}
                        title="click to dismiss"
                      >
                        {connErrors[c.name]}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </header>

      {/* ── Filter ────────────────────────────────────────────────── */}
      <div className="schema-filter">
        <span className="schema-filter-icon" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <line x1="9" y1="9" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </span>
        <input
          ref={filterInputRef}
          className="schema-filter-input"
          type="text"
          placeholder="Filter schema…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setFocusedIdx(0);
          }}
          spellCheck={false}
          aria-label="Filter schemas, tables, and columns"
        />
        {inSearch && (
          <div className="schema-filter-count mono" aria-live="polite">
            <div>{tableMatchCount + colMatchCount}</div>
            <div className="schema-filter-count-label">matches</div>
          </div>
        )}
      </div>

      {/* ── Body ──────────────────────────────────────────────────── */}
      <div className="schema-body" role="tree" aria-label="Schema tree">
        {error && <div className="schema-error mono">{error}</div>}
        {loadingRoot && schemas.length === 0 && !error && (
          <div className="schema-loading mono">Loading schemas…</div>
        )}

        {/* ── Library (saved queries) ─────────────────────────────── */}
        {libraryEntries !== undefined &&
          (filter.trim().length === 0 || filteredLibrary.length > 0) && (
            <>
              <button
                type="button"
                className="schema-group"
                onClick={() => setLibraryOpen((v) => !v)}
                aria-expanded={libraryOpen}
                title={libraryOpen ? "Collapse Library" : "Expand Library"}
              >
                <span
                  className={`schema-group-chev ${libraryOpen ? "open" : ""}`}
                  aria-hidden
                >
                  ▸
                </span>
                <span className="schema-group-name">Library</span>
                <span className="schema-group-count mono">{filteredLibrary.length}</span>
              </button>
              {libraryOpen && filteredLibrary.length === 0 && (
                <div className="schema-empty-row mono">
                  {filter.trim().length > 0
                    ? "no library matches"
                    : "no saved queries — ⌘S to save"}
                </div>
              )}
              {libraryOpen &&
                filteredLibrary.map((q) => {
                  const armed = libraryArmed === q.id;
                  return (
                    <div
                      key={q.id}
                      className={`library-row${armed ? " armed" : ""}`}
                      title={q.description || q.name}
                    >
                      <button
                        type="button"
                        className="library-row-main"
                        onClick={() => onOpenLibrary?.(q)}
                      >
                        <span className="library-row-glyph" aria-hidden>
                          ◆
                        </span>
                        <span className="library-row-name">{q.name}</span>
                        {q.connection_name === null && (
                          <span
                            className="library-row-scope mono"
                            title="Global — visible on every connection"
                          >
                            global
                          </span>
                        )}
                      </button>
                      <div className="library-row-actions">
                        <button
                          type="button"
                          className="library-row-act"
                          title="Open and run"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRunLibrary?.(q);
                          }}
                        >
                          ▶
                        </button>
                        <button
                          type="button"
                          className="library-row-act destruct"
                          title={armed ? "Click again to delete" : "Delete saved query"}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (armed) {
                              setLibraryArmed(null);
                              onDeleteLibrary?.(q);
                            } else {
                              setLibraryArmed(q.id);
                            }
                          }}
                        >
                          {armed ? "✗" : "×"}
                        </button>
                      </div>
                    </div>
                  );
                })}
            </>
          )}

        {/* Default browse: schema groups with their tables */}
        {!inSearch &&
          filteredView.map((row, i) => {
            const focused = i === focusedIdx;
            if (row.kind === "schema-header") {
              const open = !!openSchemas[row.schema];
              return (
                <button
                  type="button"
                  key={`s:${row.schema}`}
                  className={`schema-group ${focused ? "focused" : ""}`}
                  onClick={() => {
                    setFocusedIdx(i);
                    setOpenSchemas((m) => ({ ...m, [row.schema]: !m[row.schema] }));
                  }}
                  aria-expanded={open}
                >
                  <span className={`schema-group-chev ${open ? "open" : ""}`} aria-hidden>
                    ▸
                  </span>
                  <span className="schema-group-name">{row.schema}</span>
                  <span className="schema-group-count mono">{row.count}</span>
                </button>
              );
            }
            return (
              <TableRow
                key={`t:${row.schema}.${row.table.name}`}
                schema={row.schema}
                table={row.table}
                focused={focused}
                query=""
                privacy={classIndex.byTable.get(`${row.schema}.${row.table.name}`)}
                agentTouched={agentTouched.has(`${row.schema}.${row.table.name}`)}
                onPick={() => {
                  setFocusedIdx(i);
                  onPickTable?.(row.schema, row.table.name);
                }}
                onReviewSensitivity={
                  onReviewSensitivity && connectionName
                    ? () => onReviewSensitivity(connectionName)
                    : undefined
                }
              />
            );
          })}

        {/* Search mode: TABLES + COLUMNS sections */}
        {inSearch && (
          <>
            <div className="schema-section-header">
              <span>Tables</span>
              <span className="mono schema-section-count">{tableMatchCount}</span>
            </div>
            {tableMatchCount === 0 && (
              <div className="schema-empty-row mono">no table matches</div>
            )}
            {(filteredView as RowTable[]).map((row, i) => {
              const focused = i === focusedIdx;
              return (
                <TableRow
                  key={`ts:${row.schema}.${row.table.name}`}
                  schema={row.schema}
                  table={row.table}
                  focused={focused}
                  query={q}
                  privacy={classIndex.byTable.get(`${row.schema}.${row.table.name}`)}
                  agentTouched={agentTouched.has(`${row.schema}.${row.table.name}`)}
                  showSchema
                  onPick={() => {
                    setFocusedIdx(i);
                    onPickTable?.(row.schema, row.table.name);
                  }}
                  onReviewSensitivity={
                    onReviewSensitivity && connectionName
                      ? () => onReviewSensitivity(connectionName)
                      : undefined
                  }
                />
              );
            })}

            <div className="schema-section-header" style={{ marginTop: 12 }}>
              <span>Columns</span>
              <span className="mono schema-section-count">
                {colSearchPending ? "…" : colMatchCount}
              </span>
            </div>
            {!colSearchPending && colMatchCount === 0 && (
              <div className="schema-empty-row mono">no column matches</div>
            )}
            {colHits.map((hit) => (
              <button
                key={`c:${hit.schema}.${hit.table}.${hit.column}`}
                type="button"
                className="schema-col-hit"
                onClick={() => onPickTable?.(hit.schema, hit.table)}
                title={`${hit.schema}.${hit.table}.${hit.column}`}
              >
                <span className="schema-col-hit-icon" aria-hidden>
                  <TableGlyph kind="table" />
                </span>
                <span className="schema-col-hit-stack">
                  <span className="schema-col-hit-text mono">
                    <span className="schema-col-hit-schema">{hit.schema}.</span>
                    <Highlight text={hit.column} q={q} />
                  </span>
                  <span className="schema-col-hit-in mono">{hit.table}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TableRow({
  schema,
  table,
  focused,
  query,
  privacy,
  agentTouched,
  showSchema = false,
  onPick,
  onReviewSensitivity,
}: {
  schema: string;
  table: TableSummary;
  focused: boolean;
  query: string;
  privacy?: { count: number; pending: number };
  agentTouched: boolean;
  showSchema?: boolean;
  onPick: () => void;
  onReviewSensitivity?: () => void;
}) {
  const isViewish = table.kind === "view" || table.kind === "matview";
  const rowsLabel = formatRowCount(table.row_estimate);
  return (
    <div
      role="treeitem"
      className={`schema-row ${focused ? "focused" : ""} ${isViewish ? "viewish" : ""}`}
      onClick={onPick}
    >
      <span className={`schema-row-glyph ${isViewish ? "view" : "table"}`} aria-hidden>
        <TableGlyph kind={table.kind} />
      </span>
      <span className="schema-row-name mono">
        {showSchema && <span className="schema-row-schema">{schema}.</span>}
        <Highlight text={table.name} q={query} />
      </span>
      {agentTouched && (
        <span
          className="schema-row-agent-dot"
          title="Agent inspected this table this session"
          aria-label="agent touched"
        />
      )}
      {privacy && (
        <button
          type="button"
          className={`schema-row-privacy ${privacy.pending > 0 ? "pending" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onReviewSensitivity?.();
          }}
          title={`${privacy.count} sensitive column${privacy.count === 1 ? "" : "s"}${
            privacy.pending > 0 ? ` · ${privacy.pending} pending` : ""
          } — click to review`}
          aria-label={`Review ${privacy.count} sensitive column${
            privacy.count === 1 ? "" : "s"
          }`}
        >
          <span aria-hidden>◌</span>
          {privacy.count}
        </button>
      )}
      {rowsLabel && <span className="schema-row-count mono">{rowsLabel}</span>}
    </div>
  );
}
