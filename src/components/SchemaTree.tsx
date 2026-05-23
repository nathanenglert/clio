import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  onActivity,
  type Classification,
  type ColumnDescription,
} from "../lib/api";

type Node =
  | { kind: "schema"; key: string; schema: string }
  | { kind: "table"; key: string; schema: string; table: string }
  | { kind: "column"; key: string; schema: string; table: string; col: ColumnDescription };

type Props = {
  connectionName: string | null;
  onPickTable?: (schema: string, table: string) => void;
  /** Open the sensitivity review panel for this connection. Wired to the
   *  privacy badge next to a table row. */
  onReviewSensitivity?: (connection: string) => void;
};

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

export function SchemaTree({
  connectionName,
  onPickTable,
  onReviewSensitivity,
}: Props) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, string[]>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [columnsByTable, setColumnsByTable] = useState<Record<string, ColumnDescription[]>>({});
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [loadingNodes, setLoadingNodes] = useState<Record<string, boolean>>({});
  const [classIndex, setClassIndex] = useState<ClassIndex>(EMPTY_INDEX);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch classifications for the active connection. Refetched on connection
  // change AND whenever an activity event signals that classifications may
  // have changed (classify_schema or update_classification fired anywhere).
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

  useEffect(() => {
    setSchemas([]);
    setOpenSchemas({});
    setTablesBySchema({});
    setOpenTables({});
    setColumnsByTable({});
    setFocusedIdx(0);
    setError(null);
    setLoadingNodes({});
    if (!connectionName) {
      setLoadingRoot(false);
      return;
    }
    setLoadingRoot(true);
    api
      .list_schemas(connectionName)
      .then((ss) => {
        setSchemas(ss);
        setLoadingRoot(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoadingRoot(false);
      });
  }, [connectionName]);

  const flat: Node[] = useMemo(() => {
    const out: Node[] = [];
    for (const s of schemas) {
      out.push({ kind: "schema", key: `s:${s}`, schema: s });
      if (openSchemas[s]) {
        for (const t of tablesBySchema[s] ?? []) {
          out.push({ kind: "table", key: `t:${s}.${t}`, schema: s, table: t });
          if (openTables[`${s}.${t}`]) {
            for (const c of columnsByTable[`${s}.${t}`] ?? []) {
              out.push({
                kind: "column",
                key: `c:${s}.${t}.${c.name}`,
                schema: s,
                table: t,
                col: c,
              });
            }
          }
        }
      }
    }
    return out;
  }, [schemas, openSchemas, tablesBySchema, openTables, columnsByTable]);

  useEffect(() => {
    if (focusedIdx >= flat.length) setFocusedIdx(Math.max(0, flat.length - 1));
  }, [flat.length, focusedIdx]);

  const toggleSchema = async (s: string) => {
    const next = !openSchemas[s];
    setOpenSchemas((m) => ({ ...m, [s]: next }));
    if (next && !tablesBySchema[s] && connectionName) {
      const key = `s:${s}`;
      setLoadingNodes((m) => ({ ...m, [key]: true }));
      try {
        const tables = await api.list_tables(connectionName, s);
        setTablesBySchema((m) => ({ ...m, [s]: tables }));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoadingNodes((m) => {
          const { [key]: _, ...rest } = m;
          return rest;
        });
      }
    }
  };

  const toggleTable = async (s: string, t: string) => {
    const key = `${s}.${t}`;
    const next = !openTables[key];
    setOpenTables((m) => ({ ...m, [key]: next }));
    if (next && !columnsByTable[key] && connectionName) {
      const lkey = `t:${key}`;
      setLoadingNodes((m) => ({ ...m, [lkey]: true }));
      try {
        const cols = await api.describe_table(connectionName, s, t);
        setColumnsByTable((m) => ({ ...m, [key]: cols }));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoadingNodes((m) => {
          const { [lkey]: _, ...rest } = m;
          return rest;
        });
      }
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (flat.length === 0) return;
    const node = flat[focusedIdx];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(Math.min(flat.length - 1, focusedIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(Math.max(0, focusedIdx - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (node.kind === "schema" && !openSchemas[node.schema]) toggleSchema(node.schema);
      else if (node.kind === "table" && !openTables[`${node.schema}.${node.table}`])
        toggleTable(node.schema, node.table);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (node.kind === "schema") setOpenSchemas((m) => ({ ...m, [node.schema]: false }));
      else if (node.kind === "table")
        setOpenTables((m) => ({ ...m, [`${node.schema}.${node.table}`]: false }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (node.kind === "table" && onPickTable) onPickTable(node.schema, node.table);
      else if (node.kind === "schema") toggleSchema(node.schema);
    }
  };

  if (!connectionName) {
    return (
      <div className="tree tree-hint">
        Connect to a database to browse schemas.
      </div>
    );
  }

  return (
    <div
      className="tree"
      tabIndex={0}
      onKeyDown={onKey}
      ref={containerRef}
      role="tree"
      aria-label="Schema tree"
    >
      {error && (
        <div className="tree-error mono">
          {error}
        </div>
      )}
      {loadingRoot && schemas.length === 0 && !error && (
        <div className="tree-hint mono">Loading schemas…</div>
      )}
      {flat.map((n, i) => {
        const focused = i === focusedIdx;
        const className = `tree-node ${focused ? "focused" : ""}`;
        if (n.kind === "schema") {
          const sLoading = loadingNodes[`s:${n.schema}`];
          return (
            <div key={n.key}>
              <div
                className={className}
                onClick={() => {
                  setFocusedIdx(i);
                  toggleSchema(n.schema);
                }}
                role="treeitem"
                aria-expanded={!!openSchemas[n.schema]}
              >
                <span className="chev">{openSchemas[n.schema] ? "▾" : "▸"}</span>
                <span className="icon">s</span>
                <span className="label">{n.schema}</span>
              </div>
              {sLoading && (
                <div className="tree-loading mono" style={{ paddingLeft: 22 }}>loading…</div>
              )}
            </div>
          );
        }
        if (n.kind === "table") {
          const tLoading = loadingNodes[`t:${n.schema}.${n.table}`];
          const tableKey = `${n.schema}.${n.table}`;
          const privacy = classIndex.byTable.get(tableKey);
          return (
            <div key={n.key}>
              <div
                className={className}
                style={{ paddingLeft: 22 }}
                onClick={() => {
                  setFocusedIdx(i);
                  if (onPickTable) onPickTable(n.schema, n.table);
                  toggleTable(n.schema, n.table);
                }}
                role="treeitem"
                aria-expanded={!!openTables[`${n.schema}.${n.table}`]}
              >
                <span className="chev">{openTables[`${n.schema}.${n.table}`] ? "▾" : "▸"}</span>
                <span className="icon">t</span>
                <span className="label">{n.table}</span>
                {privacy && (
                  <button
                    type="button"
                    className={`tree-privacy-badge ${privacy.pending > 0 ? "pending" : ""}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (onReviewSensitivity && connectionName)
                        onReviewSensitivity(connectionName);
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
              </div>
              {tLoading && (
                <div className="tree-loading mono" style={{ paddingLeft: 42 }}>loading…</div>
              )}
            </div>
          );
        }
        const colKey = `${n.schema}.${n.table}.${n.col.name}`;
        const colPrivacy = classIndex.byColumn.get(colKey);
        return (
          <div
            key={n.key}
            className={className}
            style={{ paddingLeft: 42 }}
            onClick={() => setFocusedIdx(i)}
            role="treeitem"
          >
            <span className="chev"> </span>
            <span className="icon">{n.col.is_primary_key ? "#" : "·"}</span>
            {colPrivacy && (
              <span
                className="tree-privacy-col-glyph"
                title={`Redacted as ${colPrivacy.category.toUpperCase()} · ${colPrivacy.status}`}
                aria-hidden
              >
                ◌
              </span>
            )}
            <span className="label">{n.col.name}</span>
            <span className="meta">
              {n.col.data_type}
              {n.col.is_nullable ? "" : " !"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
