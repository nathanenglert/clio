import { useEffect, useMemo, useRef, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { ColumnDescription, QueryResult } from "../lib/api";
import {
  type ActiveAdd,
  type PendingBatch,
  getEdit,
  isDeleted,
} from "../lib/editing";
import { makeComparator } from "../lib/gridUtils";
import {
  type Selection,
  NONE,
  buildSelectionTsv,
  cellBoxShadow,
  cellEdges,
  clickCell as computeCellClick,
  clickColumnHeader,
  clickRowNumber,
  isCellHighlighted,
  isColSelected,
  isRowSelected,
} from "../lib/gridSelection";
import { CellEditor } from "./CellEditor";

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

  // Sort is view-only — display order changes, but `batch` and callbacks
  // continue to address rows by their original index in `result.rows`.
  const [sort, setSort] = useState<SortState | null>(null);
  const [sel, setSel] = useState<Selection>(NONE);

  useEffect(() => {
    setSort(null);
    setSel(NONE);
    setEditing(null);
  }, [result]);

  function focusGrid() {
    wrapRef.current?.focus();
  }

  function toggleSort(col: string) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
    // Cell-mode selection is keyed by display index — re-sorting would
    // scatter the rectangle. Rows/cols/all map cleanly across sort.
    setSel((prev) => (prev.kind === "cells" ? NONE : prev));
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

  // ── Click handlers ──────────────────────────────────────────
  function clickRowNum(origIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    focusGrid();
    setSel((prev) => clickRowNumber(prev, origIdx, e));
  }

  function clickColHeader(colName: string, e: React.MouseEvent) {
    e.preventDefault();
    focusGrid();
    if (!result) return;
    const order = result.columns.map((c) => c.name);
    setSel((prev) => clickColumnHeader(prev, colName, e, order));
  }

  function clickCell(displayRow: number, colIdx: number, e: React.MouseEvent) {
    focusGrid();
    setSel((prev) => computeCellClick(prev, displayRow, colIdx, e));
  }

  function clickCorner(e: React.MouseEvent) {
    e.preventDefault();
    focusGrid();
    setSel({ kind: "all" });
  }

  // Copy plumbing. We bind two listeners at document level so they fire before
  // WebKit's edit-command processing can swallow the event:
  //
  // 1. `copy` event — the web standard. Sync `clipboardData.setData()`. Works
  //    for menu-bar Edit→Copy and right-click→Copy regardless of focus.
  // 2. `keydown` ⌘C capture-phase — fallback if WebKit doesn't fire `copy`
  //    when there's no native text selection. Writes via the Tauri clipboard
  //    plugin.
  //
  // Both paths idempotently write the same TSV; whichever fires first wins,
  // and if both fire the second call is a harmless overwrite.
  const copyRef = useRef<() => string>(() => "");
  copyRef.current = () => (result ? buildSelectionTsv(sel, result, displayRows) : "");
  const selKindRef = useRef(sel.kind);
  selKindRef.current = sel.kind;
  useEffect(() => {
    const inEditor = (tgt: EventTarget | null) => {
      if (!(tgt instanceof HTMLElement)) return false;
      return tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT";
    };
    const inGrid = () => {
      const wrap = wrapRef.current;
      if (!wrap) return false;
      const ae = document.activeElement;
      return wrap === ae || wrap.contains(ae);
    };
    const handleCopy = (e: ClipboardEvent) => {
      if (inEditor(e.target)) return;
      if (selKindRef.current === "none") return;
      if (!inGrid()) return;
      const text = copyRef.current();
      if (!text) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };
    const handleKeydown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "c") return;
      if (inEditor(e.target)) return;
      if (selKindRef.current === "none") return;
      if (!inGrid()) return;
      const text = copyRef.current();
      if (!text) return;
      e.preventDefault();
      void clipboardWriteText(text);
    };
    document.addEventListener("copy", handleCopy);
    document.addEventListener("keydown", handleKeydown, true);
    return () => {
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("keydown", handleKeydown, true);
    };
  }, []);

  function deleteSelectedRows() {
    if (!editable || !result) return;
    if (sel.kind === "rows") {
      sel.rows.forEach((ri) => onStageDelete(ri));
    } else if (sel.kind === "all") {
      result.rows.forEach((_, ri) => onStageDelete(ri));
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────
  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT")) return;
    if (editing) return;

    const cmd = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    if (editable && cmd && !e.shiftKey && k === "n") {
      e.preventDefault();
      onStartAdd();
      return;
    }
    if (cmd && k === "a") {
      e.preventDefault();
      setSel({ kind: "all" });
      return;
    }
    // ⌘C is handled by the `copy` event listener bound to wrapRef — Tauri's
    // webview eats the keydown before React sees it.
    if (e.key === "Escape") {
      if (sel.kind !== "none") {
        e.preventDefault();
        setSel(NONE);
      }
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (editable && (sel.kind === "rows" || sel.kind === "all")) {
        e.preventDefault();
        deleteSelectedRows();
      }
      return;
    }
    if (e.key === "Enter" && sel.kind === "cells" && editable && result) {
      const dr = displayRows[sel.r1];
      if (dr && !isDeleted(batch, dr.origIdx)) {
        e.preventDefault();
        const col = result.columns[sel.c1];
        setEditing({ kind: "row", rowIdx: dr.origIdx, col: col.name });
      }
      return;
    }
    // Arrow nav: cells mode only. Shift extends the rectangle.
    if (sel.kind === "cells" && result && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const lastR = displayRows.length - 1;
      const lastC = result.columns.length - 1;
      let nr = sel.r1, nc = sel.c1;
      if (e.key === "ArrowUp") nr = Math.max(0, nr - 1);
      else if (e.key === "ArrowDown") nr = Math.min(lastR, nr + 1);
      else if (e.key === "ArrowLeft") nc = Math.max(0, nc - 1);
      else if (e.key === "ArrowRight") nc = Math.min(lastC, nc + 1);
      e.preventDefault();
      if (e.shiftKey) setSel({ ...sel, r1: nr, c1: nc });
      else setSel({ kind: "cells", r0: nr, c0: nc, r1: nr, c1: nc });
    }
  }

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

  const allSelected = sel.kind === "all";

  return (
    <div className="grid-wrap" ref={wrapRef} tabIndex={-1} onKeyDown={onGridKeyDown}>
      {!editable && (
        <ReadOnlyBanner reason={readOnlyReason ?? "ad-hoc SQL — open via schema tree to edit"} />
      )}

      <table className={`grid${editable ? " editable" : ""}${allSelected ? " all-selected" : ""}`}>
        <thead>
          <tr>
            {(() => {
              const active = sort?.col === ROW_IDX_COL;
              const ariaSort: "ascending" | "descending" | "none" = active
                ? sort!.dir === "asc"
                  ? "ascending"
                  : "descending"
                : "none";
              return (
                <th
                  className={`grid-rownum corner${allSelected ? " corner-selected" : ""}${active ? ` sorted ${sort!.dir}` : ""}`}
                  aria-label="select all"
                  aria-sort={ariaSort}
                  onClick={clickCorner}
                  title="Click to select all · arrow rail toggles original order"
                >
                  <div className="corner-content">
                    <SortRail
                      active={active}
                      dir={active ? sort!.dir : null}
                      onToggle={() => toggleSort(ROW_IDX_COL)}
                      label="Toggle original row order"
                    />
                  </div>
                </th>
              );
            })()}
            {result.columns.map((c) => {
              const meta = colTypeByName.get(c.name);
              const notNullMissing =
                editable && meta && !meta.is_nullable && !meta.default;
              const active = sort?.col === c.name;
              const colSel = isColSelected(sel, c.name);
              const ariaSort: "ascending" | "descending" | "none" = active
                ? sort!.dir === "asc"
                  ? "ascending"
                  : "descending"
                : "none";
              return (
                <th
                  key={c.name}
                  className={[
                    "col-header",
                    active ? `sorted ${sort!.dir}` : "",
                    colSel ? "col-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-sort={ariaSort}
                  onClick={(e) => clickColHeader(c.name, e)}
                  title="Click to select column · arrow rail to sort"
                >
                  <div className="th-content">
                    <span className="grid-col-name">{c.name}</span>
                    {notNullMissing && <span className="col-notnull-dot" title="NOT NULL" />}
                    <span className="grid-col-type mono">{c.data_type}</span>
                    <SortRail
                      active={active}
                      dir={active ? sort!.dir : null}
                      onToggle={() => toggleSort(c.name)}
                      label={`Sort by ${c.name}`}
                    />
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayRows.map(({ row, origIdx: ri }, displayRow) => {
            const deleted = isDeleted(batch, ri);
            const rowSel = isRowSelected(sel, ri);
            return (
              <tr
                key={ri}
                className={[
                  deleted ? "row-deleted" : "",
                  rowSel ? "row-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <td
                  className="grid-rownum"
                  style={(() => {
                    const shadow = cellBoxShadow(
                      cellEdges(sel, displayRow, -1, ri, null, result, displayRows),
                      false,
                    );
                    return shadow ? { boxShadow: shadow } : undefined;
                  })()}
                  onClick={deleted ? undefined : (e) => clickRowNum(ri, e)}
                  title={deleted ? undefined : "Click to select row · ⌫ to delete"}
                >
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
                    <span className="row-num">{ri + 1}</span>
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
                  const highlighted = isCellHighlighted(sel, displayRow, ci, ri, col.name);
                  const edges = cellEdges(sel, displayRow, ci, ri, col.name, result, displayRows);
                  const boxShadow = cellBoxShadow(edges, dirty);
                  const cls = [
                    isNull ? "null" : "",
                    isJson ? "json" : "",
                    dirty ? "dirty" : "",
                    highlighted ? "cell-selected" : "",
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
                      style={boxShadow ? { boxShadow } : undefined}
                      onClick={deleted ? undefined : (e) => clickCell(displayRow, ci, e)}
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

// ── Sort rail (always-visible chevron pair) ──────────────────────

function SortRail(props: {
  active: boolean;
  dir: "asc" | "desc" | null;
  onToggle: () => void;
  label: string;
}) {
  const { active, dir, onToggle, label } = props;
  return (
    <button
      type="button"
      className={`sort-rail${active ? ` active ${dir}` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={label}
      title={
        active
          ? dir === "asc"
            ? "Sorted ascending — click for descending"
            : "Sorted descending — click to clear"
          : "Click to sort ascending"
      }
    >
      <span className={`sort-chev up${active && dir === "asc" ? " on" : ""}`} aria-hidden>▴</span>
      <span className={`sort-chev down${active && dir === "desc" ? " on" : ""}`} aria-hidden>▾</span>
    </button>
  );
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
