import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDescription, QueryResult } from "../lib/api";
import {
  type ActiveAdd,
  type PendingBatch,
  getEdit,
  isDeleted,
} from "../lib/editing";

type Props = {
  result: QueryResult | null;
  error: string | null;
  // Editing
  editable: boolean;
  /** Why the result is read-only (only used when editable=false). */
  readOnlyReason?: string;
  /** Full describe_table metadata for the editable base table. */
  columnsMeta: ColumnDescription[] | null;
  batch: PendingBatch;
  // Drafts for active in-progress add rows (pre-staged).
  activeAdds: ActiveAdd[];
  // Callbacks
  onStageEdit: (rowIdx: number, col: string, newValue: string | null) => void;
  onStageDelete: (rowIdx: number) => void;
  onUndoDelete: (rowIdx: number) => void;
  onCancelAdd: (tempId: string) => void;
  onUpdateActiveAdd: (tempId: string, col: string, value: string | null) => void;
  onStartAdd: () => void;
};

type EditingCell =
  | { kind: "row"; rowIdx: number; col: string }
  | { kind: "add"; tempId: string; col: string };

type SortState = { col: string; dir: "asc" | "desc" };

// Sentinel column id for the row-number column. Sorting by this column is
// equivalent to ordering by original row index — useful as an explicit "back
// to SQL output order" affordance.
const ROW_IDX_COL = "__rowidx__";

export function ResultsGrid(props: Props) {
  const {
    result,
    error,
    editable,
    readOnlyReason,
    columnsMeta,
    batch,
    activeAdds,
    onStageEdit,
    onStageDelete,
    onUndoDelete,
    onCancelAdd,
    onUpdateActiveAdd,
    onStartAdd,
  } = props;

  const [editing, setEditing] = useState<EditingCell | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Keyboard: ⌘N starts add, Delete deletes selected row.
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

  // Sort is view-only — display order changes, but `batch` and callbacks
  // continue to address rows by their original index in `result.rows`.
  const [sort, setSort] = useState<SortState | null>(null);
  useEffect(() => {
    setSort(null);
    setSelectedRow(null);
    setEditing(null);
  }, [result]);

  function toggleSort(col: string) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Bail when a cell editor input/textarea is focused inside the grid.
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
    if (editing) return;
    if (!editable) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      onStartAdd();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && selectedRow !== null) {
      e.preventDefault();
      onStageDelete(selectedRow);
    }
  }

  const colTypeByName = useMemo(() => {
    const m = new Map<string, ColumnDescription>();
    columnsMeta?.forEach((c) => m.set(c.name, c));
    return m;
  }, [columnsMeta]);

  const displayRows = useMemo(() => {
    if (!result) return [] as { row: (string | null)[]; origIdx: number }[];
    const base = result.rows.map((row, origIdx) => ({ row, origIdx }));
    if (!sort) return base;
    if (sort.col === ROW_IDX_COL) {
      const dir = sort.dir === "asc" ? 1 : -1;
      return [...base].sort((a, b) => (a.origIdx - b.origIdx) * dir);
    }
    const colIdx = result.columns.findIndex((c) => c.name === sort.col);
    if (colIdx === -1) return base;
    const dataType =
      colTypeByName.get(sort.col)?.data_type ?? result.columns[colIdx].data_type;
    const cmp = makeComparator(dataType);
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      const av = a.row[colIdx];
      const bv = b.row[colIdx];
      // Treat NULL as "greater than" any value, matching Postgres defaults:
      // NULLS LAST for asc, NULLS FIRST for desc.
      if (av === null && bv === null) return a.origIdx - b.origIdx;
      if (av === null) return 1 * dir;
      if (bv === null) return -1 * dir;
      const c = cmp(av, bv);
      return c === 0 ? a.origIdx - b.origIdx : c * dir;
    });
  }, [result, sort, colTypeByName]);

  if (error) {
    return (
      <div className="grid-wrap">
        <div className="result-error mono">{error}</div>
      </div>
    );
  }
  if (!result) {
    return <div className="grid-wrap" />;
  }

  return (
    <div className="grid-wrap" ref={wrapRef} tabIndex={-1} onKeyDown={onGridKeyDown}>
      {!editable && (
        <ReadOnlyBanner reason={readOnlyReason ?? "ad-hoc SQL — open via schema tree to edit"} />
      )}

      <table className={`grid${editable ? " editable" : ""}`}>
        <thead>
          <tr>
            {(() => {
              const active = sort?.col === ROW_IDX_COL;
              const sortCls = active ? ` sorted ${sort!.dir}` : "";
              const ariaSort: "ascending" | "descending" | "none" = active
                ? sort!.dir === "asc"
                  ? "ascending"
                  : "descending"
                : "none";
              return (
                <th
                  className={`grid-rownum sortable${sortCls}`}
                  aria-label="row number"
                  aria-sort={ariaSort}
                  onClick={() => toggleSort(ROW_IDX_COL)}
                  title={
                    active
                      ? sort!.dir === "asc"
                        ? "Original order — click for reverse"
                        : "Reverse order — click to clear"
                      : "Click to restore original order"
                  }
                >
                  {active ? (
                    <span className="sort-indicator" aria-hidden>
                      {sort!.dir === "asc" ? "▲" : "▼"}
                    </span>
                  ) : (
                    "#"
                  )}
                </th>
              );
            })()}
            {result.columns.map((c) => {
              const meta = colTypeByName.get(c.name);
              const notNullMissing =
                editable && meta && !meta.is_nullable && !meta.default;
              const active = sort?.col === c.name;
              const sortCls = active ? ` sorted ${sort!.dir}` : "";
              const ariaSort: "ascending" | "descending" | "none" = active
                ? sort!.dir === "asc"
                  ? "ascending"
                  : "descending"
                : "none";
              return (
                <th
                  key={c.name}
                  className={`sortable${sortCls}`}
                  aria-sort={ariaSort}
                  onClick={() => toggleSort(c.name)}
                  title={
                    active
                      ? sort!.dir === "asc"
                        ? "Sorted ascending — click for descending"
                        : "Sorted descending — click to clear"
                      : "Click to sort ascending"
                  }
                >
                  <div className="th-content">
                    <span className="grid-col-name">{c.name}</span>
                    {active && (
                      <span className="sort-indicator" aria-hidden>
                        {sort!.dir === "asc" ? "▲" : "▼"}
                      </span>
                    )}
                    {notNullMissing && <span className="col-notnull-dot" title="NOT NULL" />}
                    <span className="grid-col-type mono">{c.data_type}</span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayRows.map(({ row, origIdx: ri }) => {
            const deleted = isDeleted(batch, ri);
            const isSel = selectedRow === ri;
            return (
              <tr
                key={ri}
                className={[
                  deleted ? "row-deleted" : "",
                  isSel ? "row-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  setSelectedRow(ri);
                  wrapRef.current?.focus();
                }}
              >
                <td className="grid-rownum">
                  {deleted ? (
                    <button
                      className="row-action-btn destruct"
                      title="Undo delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUndoDelete(ri);
                      }}
                    >
                      ▲
                    </button>
                  ) : (
                    <>
                      <span className="row-num">{ri + 1}</span>
                      {editable && (
                        <button
                          className="row-action-btn delete-hover"
                          title="Delete row"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStageDelete(ri);
                          }}
                        >
                          ✗
                        </button>
                      )}
                    </>
                  )}
                </td>
                {row.map((v, ci) => {
                  const col = result.columns[ci];
                  const meta = colTypeByName.get(col.name);
                  const editState = getEdit(batch, ri, col.name);
                  const displayValue: string | null = editState.staged ? editState.value : v;
                  const dirty = editState.staged;
                  const isJson = col.data_type === "jsonb" || col.data_type === "json";
                  const isNull = displayValue === null;
                  const cls = [
                    isNull ? "null" : "",
                    isJson ? "json" : "",
                    dirty ? "dirty" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const isEditing =
                    editable &&
                    !deleted &&
                    editing?.kind === "row" &&
                    editing.rowIdx === ri &&
                    editing.col === col.name;
                  if (isEditing && meta) {
                    return (
                      <td key={ci} className="cell-editing">
                        <CellEditor
                          meta={meta}
                          initial={displayValue}
                          schema=""
                          table=""
                          onCommit={(newValue) => {
                            onStageEdit(ri, col.name, newValue);
                            setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={ci}
                      className={cls}
                      onDoubleClick={() => {
                        if (!editable || deleted) return;
                        setEditing({ kind: "row", rowIdx: ri, col: col.name });
                      }}
                      title={editable && !deleted ? "Double-click to edit" : undefined}
                    >
                      {isNull ? "null" : displayValue}
                    </td>
                  );
                })}
              </tr>
            );
          })}

          {/* Active (pre-staged) adds — editable inline */}
          {editable && activeAdds.map((add) => (
            <tr key={`add-${add.tempId}`} className="row-add">
              <td className="grid-rownum">
                <button
                  className="row-action-btn write"
                  title="Cancel new row"
                  onClick={() => onCancelAdd(add.tempId)}
                >
                  ✗
                </button>
              </td>
              {result.columns.map((col, ci) => {
                const meta = colTypeByName.get(col.name);
                const isEditing =
                  editing?.kind === "add" &&
                  editing.tempId === add.tempId &&
                  editing.col === col.name;
                const v = add.cells[col.name];
                const present = v !== undefined;
                if (isEditing && meta) {
                  return (
                    <td key={ci} className="cell-editing">
                      <CellEditor
                        meta={meta}
                        initial={present ? v : null}
                        schema=""
                        table=""
                        onCommit={(newValue) => {
                          onUpdateActiveAdd(add.tempId, col.name, newValue);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  );
                }
                let display: React.ReactNode;
                if (!present) {
                  display = (
                    <span className="add-placeholder mono">
                      {meta?.default ? meta.default : meta?.is_nullable ? "null" : "—"}
                    </span>
                  );
                } else if (v === null) {
                  display = <span className="null">null</span>;
                } else {
                  display = v;
                }
                return (
                  <td
                    key={ci}
                    className={`add-cell ${present ? "" : "empty"}`}
                    onClick={() => setEditing({ kind: "add", tempId: add.tempId, col: col.name })}
                  >
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}

          {/* Ghost row prompt */}
          {editable && (
            <tr className="row-ghost" onClick={onStartAdd}>
              <td className="grid-rownum">+</td>
              <td colSpan={result.columns.length}>
                <span className="ghost-prompt mono">Click or ⌘N to add a row…</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Inline cell editor (type-aware) ──────────────────────────────

function CellEditor(props: {
  meta: ColumnDescription;
  initial: string | null;
  schema: string;
  table: string;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}) {
  const { meta, initial, onCommit, onCancel } = props;
  const dt = meta.data_type;
  const [val, setVal] = useState<string>(initial ?? "");
  const [isNull, setIsNull] = useState<boolean>(initial === null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (inputRef.current && "select" in inputRef.current) {
      try {
        inputRef.current.select();
      } catch {}
    }
  }, []);

  function commit() {
    onCommit(isNull ? null : val);
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  // Enum: native select populated with the type's labels.
  if (meta.enum_values && meta.enum_values.length > 0) {
    const current = isNull ? "" : val;
    return (
      <div className="cell-editor enum" onKeyDown={handleKey}>
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          value={current}
          className="mono"
          onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
        >
          {meta.is_nullable && <option value="">(null)</option>}
          {!meta.enum_values.includes(val) && !isNull && val !== "" && (
            <option value={val} disabled>{`${val} (invalid)`}</option>
          )}
          {meta.enum_values.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        {meta.is_nullable && (
          <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
        )}
        <div className="cell-editor-actions">
          <button
            className="ce-commit"
            onClick={() => onCommit(isNull || current === "" ? null : current)}
          >↵</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
      </div>
    );
  }

  // Bool: segmented control
  if (dt === "boolean") {
    const current = isNull ? "null" : val === "true" ? "true" : val === "false" ? "false" : "";
    return (
      <div className="cell-editor bool" onKeyDown={handleKey}>
        <div className="bool-seg" role="group">
          <button className={current === "true" ? "on" : ""} onClick={() => { setIsNull(false); setVal("true"); }}>true</button>
          <button className={current === "false" ? "on" : ""} onClick={() => { setIsNull(false); setVal("false"); }}>false</button>
          <button className={current === "null" ? "on" : ""} onClick={() => setIsNull(true)}>null</button>
        </div>
        <div className="cell-editor-actions">
          <button className="ce-commit" onClick={commit}>↵</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
      </div>
    );
  }

  // Date/timestamp: native date input
  const isDate = dt === "date" || dt === "timestamp" || dt === "timestamp without time zone";
  const isTimestamptz = dt === "timestamp with time zone" || dt === "timestamptz";
  if (isDate || isTimestamptz) {
    const inputType = dt === "date" ? "date" : "datetime-local";
    // Normalize the initial value to the input's format.
    const dateVal = isNull ? "" : normalizeForDateInput(val, inputType);
    return (
      <div className="cell-editor date" onKeyDown={handleKey}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={inputType}
          value={dateVal}
          className="mono"
          onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
        />
        <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
        <div className="cell-editor-actions">
          <button className="ce-commit" onClick={commit}>↵</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
      </div>
    );
  }

  // Long-text expander: use textarea when the value is multi-line or long.
  const long = (initial?.length ?? 0) > 80 || (initial?.includes("\n") ?? false);
  if (long) {
    return (
      <div className="cell-editor long" onKeyDown={handleKey}>
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={isNull ? "" : val}
          className="mono"
          rows={4}
          onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
        />
        <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
        <div className="cell-editor-actions">
          <button className="ce-commit" onClick={commit}>⏎</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
        <div className="cell-editor-hint mono">⇧↵ newline · ↵ commit · esc cancel</div>
      </div>
    );
  }

  // Default: plain mono input.
  return (
    <div className="cell-editor" onKeyDown={handleKey}>
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={isNull ? "" : val}
        placeholder={isNull ? "null" : undefined}
        className="mono"
        onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
      />
      <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
      <div className="cell-editor-actions">
        <button className="ce-commit" onClick={commit}>↵</button>
        <button className="ce-cancel" onClick={onCancel}>esc</button>
      </div>
    </div>
  );
}

function makeComparator(dataType: string): (a: string, b: string) => number {
  const t = dataType.toLowerCase();
  const numeric =
    /^(small|big)?int|^int\d?|^numeric|^decimal|^real|^double|^float|^serial/.test(t);
  const date = t.startsWith("date") || t.startsWith("timestamp") || t.startsWith("time");
  if (numeric) {
    return (a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
      return na - nb;
    };
  }
  if (date) {
    return (a, b) => {
      const da = Date.parse(a);
      const db = Date.parse(b);
      if (Number.isNaN(da) || Number.isNaN(db)) return a.localeCompare(b);
      return da - db;
    };
  }
  return (a, b) => a.localeCompare(b, undefined, { numeric: true });
}

function normalizeForDateInput(s: string, inputType: "date" | "datetime-local"): string {
  if (!s) return "";
  // datetime-local wants "YYYY-MM-DDTHH:MM" (no seconds, no Z).
  if (inputType === "datetime-local") {
    // Try to parse and reformat. Tolerant of "YYYY-MM-DD HH:MM:SS" / ISO.
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (m) return `${m[1]}T${m[2]}`;
    return s;
  }
  // date: keep just the date portion if a longer string was passed.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

// ── Read-only banner ──────────────────────────────────────────────

function ReadOnlyBanner({ reason }: { reason: string }) {
  return (
    <div className="readonly-banner">
      <span className="rb-icon" aria-hidden>🔒</span>
      <span>
        <span className="rb-strong">Read-only result</span>
        <span className="rb-muted"> · {reason}</span>
      </span>
    </div>
  );
}
