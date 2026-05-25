// Shared, per-connection schema/column cache for SQL editor completion.
// Schemas + tables load eagerly on connect (one round trip per schema, in
// parallel); columns are lazy-loaded on demand via `ensureColumns`. The
// returned `schema` object is shaped for @codemirror/lang-sql's SQLNamespace
// and is reference-stable until something actually changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Completion } from "@codemirror/autocomplete";
import { api, type ColumnDescription, type TableSummary } from "./api";

// Each table entry uses lang-sql's `{ self, children }` form so we can attach
// table-level completion metadata (kind, row count) without losing access to
// the columns under it.
type TableEntry = { self: Completion; children: readonly Completion[] };

export type IntellisenseSchema = {
  [schemaName: string]: { [tableName: string]: TableEntry };
};

export type Intellisense = {
  /** SQLNamespace-shaped object for `sql({ schema })`. */
  schema: IntellisenseSchema;
  /** Pass to `sql({ defaultSchema })` so unqualified tables complete at top level. */
  defaultSchema: string | undefined;
  /** Trigger a lazy load of column metadata for a table. No-op if cached. */
  ensureColumns: (schema: string, table: string) => void;
};

const EMPTY_SCHEMA: IntellisenseSchema = Object.freeze({});

function pickDefaultSchema(schemas: string[]): string | undefined {
  if (schemas.includes("public")) return "public";
  return schemas[0];
}

function formatRowCount(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`.replace(".0K", "K");
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`.replace(".0M", "M");
  return `${(n / 1_000_000_000).toFixed(1)}B`.replace(".0B", "B");
}

function buildTableCompletion(t: TableSummary): Completion {
  // Views vs tables get different icons. CodeMirror's icon set is small, so
  // we lean on "type" (≈ class glyph) for views/matviews and the default
  // for everything else.
  const isViewish = t.kind === "view" || t.kind === "matview";
  const parts: string[] = [t.kind];
  if (t.row_estimate !== undefined) parts.push(`${formatRowCount(t.row_estimate)} rows`);
  return {
    label: t.name,
    type: isViewish ? "type" : "class",
    detail: parts.join("  ·  "),
  };
}

function buildColumnCompletion(c: ColumnDescription): Completion {
  const flags: string[] = [];
  if (c.is_primary_key) flags.push("PK");
  if (!c.is_nullable) flags.push("not null");
  const detail = c.data_type + (flags.length ? `  ·  ${flags.join(" · ")}` : "");
  // Enum columns get their allowed labels in the info panel — saves the user
  // a trip to the schema view when writing a `where role = '...'` filter.
  const info =
    c.enum_values && c.enum_values.length > 0
      ? `values: ${c.enum_values.join(", ")}`
      : undefined;
  return {
    label: c.name,
    // PK columns render with the "constant" glyph to set them apart at a glance;
    // everything else is a "property" — same icon set as object-field completion.
    type: c.is_primary_key ? "constant" : "property",
    detail,
    ...(info ? { info } : {}),
  };
}

export function useIntellisense(connectionName: string | null): Intellisense {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, TableSummary[]>>({});
  const [columns, setColumns] = useState<Record<string, readonly Completion[]>>({});

  // Track in-flight describe_table calls so a rapid burst of `.` keystrokes
  // doesn't fan out N duplicate queries for the same table.
  const inflight = useRef<Set<string>>(new Set());

  // ── Eager: schemas + tables on connect ───────────────────────────
  useEffect(() => {
    setSchemas([]);
    setTablesBySchema({});
    setColumns({});
    inflight.current.clear();
    if (!connectionName) return;
    let cancelled = false;
    (async () => {
      try {
        const ss = await api.list_schemas(connectionName);
        if (cancelled) return;
        setSchemas(ss);
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
      } catch {
        // Non-fatal: completion just stays keyword-only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionName]);

  // ── Lazy: describe_table on demand ───────────────────────────────
  const ensureColumns = useCallback(
    (schema: string, table: string) => {
      if (!connectionName || !schema || !table) return;
      const key = `${schema}.${table}`;
      if (columns[key] || inflight.current.has(key)) return;
      inflight.current.add(key);
      api
        .describe_table(connectionName, schema, table)
        .then((desc) => {
          const completions = desc.columns.map(buildColumnCompletion);
          setColumns((prev) => ({ ...prev, [key]: completions }));
        })
        .catch(() => {
          // Leave as missing — next attempt can retry.
        })
        .finally(() => {
          inflight.current.delete(key);
        });
    },
    [connectionName, columns],
  );

  // ── Build the SQLNamespace ───────────────────────────────────────
  // Memoized on the inputs. Reference is stable as long as nothing changed,
  // which lets the SqlEditor skip its compartment-reconfigure dispatch.
  const schema = useMemo<IntellisenseSchema>(() => {
    if (schemas.length === 0) return EMPTY_SCHEMA;
    const ns: IntellisenseSchema = {};
    for (const s of schemas) {
      const tables = tablesBySchema[s];
      if (!tables) continue;
      const tableMap: { [t: string]: TableEntry } = {};
      for (const t of tables) {
        tableMap[t.name] = {
          self: buildTableCompletion(t),
          children: columns[`${s}.${t.name}`] ?? [],
        };
      }
      ns[s] = tableMap;
    }
    return ns;
  }, [schemas, tablesBySchema, columns]);

  const defaultSchema = useMemo(() => pickDefaultSchema(schemas), [schemas]);

  return { schema, defaultSchema, ensureColumns };
}
