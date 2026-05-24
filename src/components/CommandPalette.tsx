import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ActivityEvent, type Connection, type TableSummary } from "../lib/api";
import { Modal } from "./Modal";

export type CommandItem = {
  id: string;
  title: string;
  subtitle?: string;
  kbd?: string;
  onSelect: () => void;
};

type Props = {
  onClose: () => void;
  connection: Connection | null;
  recentQueries: ActivityEvent[];
  commands: CommandItem[];
  onPickTable: (schema: string, table: string) => void;
  onOpenSql: (sql: string, source: "ui" | "mcp") => void;
};

type Row = {
  group: string;
  title: string;
  subtitle?: string;
  kbd?: string;
  mono?: boolean;
  agent?: boolean;
  onSelect: () => void;
};

type GroupKey = "tables" | "recents" | "commands";

const GROUP_LABEL: Record<GroupKey, string> = {
  tables: "Tables",
  recents: "Recent queries",
  commands: "Commands",
};

function relTime(ts_ms: number): string {
  const diff = Date.now() - ts_ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function CommandPalette({
  onClose,
  connection,
  recentQueries,
  commands,
  onPickTable,
  onOpenSql,
}: Props) {
  const [query, setQuery] = useState("");
  const [tables, setTables] = useState<Array<{ schema: string; table: string; kind: TableSummary["kind"]; row_estimate?: number }>>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  // Focus the input on open. The Modal already wires Escape to onClose.
  useEffect(() => {
    queueMicrotask(() => inputRef.current?.focus());
  }, []);

  // Lazy-load tables for the active connection when the palette opens.
  // We fetch list_schemas + list_tables once per palette open; the lists are
  // small and the user can re-open if the schema changed.
  useEffect(() => {
    if (!connection?.connected) {
      setTables([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const schemas = await api.list_schemas(connection.name);
        const all = await Promise.all(
          schemas.map(async (s) => {
            try {
              const ts = await api.list_tables(connection.name, s);
              return ts.map((t) => ({ schema: s, table: t.name, kind: t.kind, row_estimate: t.row_estimate }));
            } catch {
              return [];
            }
          }),
        );
        if (!cancelled) setTables(all.flat());
      } catch {
        if (!cancelled) setTables([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.name, connection?.connected]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];

    if (connection?.connected) {
      const matchedTables = tables
        .filter((t) => {
          if (!q) return false; // tables only appear once the user starts typing
          return (
            t.table.toLowerCase().includes(q) ||
            `${t.schema}.${t.table}`.toLowerCase().includes(q)
          );
        })
        .slice(0, 8)
        .map<Row>((t) => ({
          group: GROUP_LABEL.tables,
          title: t.table,
          subtitle: `${t.schema} · ${t.kind}${t.row_estimate !== undefined ? ` · ~${t.row_estimate.toLocaleString()} rows` : ""}`,
          kbd: t.schema,
          onSelect: () => onPickTable(t.schema, t.table),
        }));
      out.push(...matchedTables);
    }

    const seen = new Set<string>();
    const matchedRecents = recentQueries
      .filter((e) => !!e.payload)
      .slice()
      .reverse()
      .filter((e) => {
        const sql = oneLine(e.payload!);
        if (seen.has(sql)) return false;
        seen.add(sql);
        if (!q) return true;
        return sql.toLowerCase().includes(q);
      })
      .slice(0, 6)
      .map<Row>((e) => {
        const sql = oneLine(e.payload!);
        return {
          group: GROUP_LABEL.recents,
          title: sql,
          subtitle: `${e.source === "mcp" ? "agent" : "you"} · ${relTime(e.ts_ms)}`,
          mono: true,
          agent: e.source === "mcp",
          onSelect: () => onOpenSql(e.payload!, e.source),
        };
      });
    out.push(...matchedRecents);

    const matchedCommands = commands
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .map<Row>((c) => ({
        group: GROUP_LABEL.commands,
        title: c.title,
        subtitle: c.subtitle,
        kbd: c.kbd,
        onSelect: c.onSelect,
      }));
    out.push(...matchedCommands);

    return out;
  }, [query, connection?.connected, tables, recentQueries, commands, onPickTable, onOpenSql]);

  // Clamp focus when the visible row count changes.
  useEffect(() => {
    setFocusIdx((i) => {
      if (rows.length === 0) return 0;
      if (i >= rows.length) return rows.length - 1;
      return i;
    });
  }, [rows.length]);

  // Reset focus to top when the query changes.
  useEffect(() => {
    setFocusIdx(0);
  }, [query]);

  // Keep the focused row in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-row-idx="${focusIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusIdx]);

  const activate = useCallback(() => {
    const row = rows[focusIdx];
    if (!row) return;
    row.onSelect();
    onClose();
  }, [rows, focusIdx, onClose]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate();
    }
  }

  // Render rows grouped by their group label, preserving order of first
  // appearance. Insert a group header before each new group.
  const renderedGroups: Array<{ group: string; entries: Array<{ row: Row; idx: number }> }> = [];
  rows.forEach((row, idx) => {
    const last = renderedGroups[renderedGroups.length - 1];
    if (last && last.group === row.group) last.entries.push({ row, idx });
    else renderedGroups.push({ group: row.group, entries: [{ row, idx }] });
  });

  return (
    <Modal onClose={onClose} className="cmd-palette">
      <div className="cmd-palette-head">
        <span aria-hidden className="cmd-palette-search-glyph">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.5" y1="10.5" x2="13.5" y2="13.5" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="cmd-palette-input"
          type="text"
          value={query}
          placeholder="Search tables, queries, commands…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          aria-label="Command palette search"
        />
      </div>

      <div className="cmd-palette-list" ref={listRef}>
        {rows.length === 0 ? (
          <div className="cmd-palette-empty">No matches.</div>
        ) : (
          renderedGroups.map((g) => (
            <div key={g.group} className="cmd-palette-group">
              <div className="cmd-palette-group-label">{g.group}</div>
              {g.entries.map(({ row, idx }) => (
                <button
                  key={idx}
                  data-row-idx={idx}
                  className={`cmd-palette-row${idx === focusIdx ? " active" : ""}`}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onClick={() => {
                    row.onSelect();
                    onClose();
                  }}
                >
                  <span className="cmd-palette-row-title" data-mono={row.mono ? "true" : undefined} data-agent={row.agent ? "true" : undefined}>
                    {row.title}
                  </span>
                  {row.subtitle && (
                    <span className="cmd-palette-row-sub">{row.subtitle}</span>
                  )}
                  {row.kbd && <span className="cmd-palette-row-kbd mono">{row.kbd}</span>}
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="cmd-palette-foot">
        <span><kbd className="mono">↑↓</kbd> navigate</span>
        <span><kbd className="mono">⏎</kbd> open</span>
        <div className="spacer" />
        <span>Esc to close</span>
      </div>
    </Modal>
  );
}
