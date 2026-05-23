// Pure selection model for ResultsGrid. No React, no DOM.
//
// Modes are mutually exclusive — clicking switches mode. Row indices in
// "rows" mode are original (origIdx) so they survive sort changes. Cells
// store DISPLAY indices; the caller clears cells-mode when the sort changes
// since the rectangle would otherwise scatter.

import type { QueryResult } from "./api";
import { cellToTsv } from "./gridUtils";

export type Selection =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "rows"; rows: Set<number>; anchor: number }
  | { kind: "cols"; cols: Set<string>; anchor: string }
  | { kind: "cells"; r0: number; c0: number; r1: number; c1: number };

export const NONE: Selection = { kind: "none" };

export type DisplayRow = { row: (string | null)[]; origIdx: number };

export type CellEdges = { top: boolean; bottom: boolean; left: boolean; right: boolean };

function cellRect(s: Extract<Selection, { kind: "cells" }>) {
  return {
    minR: Math.min(s.r0, s.r1),
    maxR: Math.max(s.r0, s.r1),
    minC: Math.min(s.c0, s.c1),
    maxC: Math.max(s.c0, s.c1),
  };
}

export function isRowSelected(sel: Selection, origIdx: number): boolean {
  if (sel.kind === "all") return true;
  if (sel.kind === "rows") return sel.rows.has(origIdx);
  return false;
}

export function isColSelected(sel: Selection, name: string): boolean {
  if (sel.kind === "all") return true;
  if (sel.kind === "cols") return sel.cols.has(name);
  return false;
}

export function isCellHighlighted(
  sel: Selection,
  displayRow: number,
  colIdx: number,
  origIdx: number,
  colName: string,
): boolean {
  if (sel.kind === "all") return true;
  if (sel.kind === "rows") return sel.rows.has(origIdx);
  if (sel.kind === "cols") return sel.cols.has(colName);
  if (sel.kind === "cells") {
    const { minR, maxR, minC, maxC } = cellRect(sel);
    return displayRow >= minR && displayRow <= maxR && colIdx >= minC && colIdx <= maxC;
  }
  return false;
}

/**
 * For a cell at (displayRow, colIdx), return which of its four sides sit on
 * the *outer perimeter* of the current selection — or null if the cell isn't
 * in the selection. Pass colIdx = -1 for the row-number gutter (which only
 * participates in row / all selection).
 */
export function cellEdges(
  sel: Selection,
  displayRow: number,
  colIdx: number,
  origIdx: number,
  colName: string | null,
  result: QueryResult,
  displayRows: DisplayRow[],
): CellEdges | null {
  const colCount = result.columns.length;
  const rowCount = displayRows.length;
  const isGutter = colIdx === -1;

  if (sel.kind === "all") {
    return {
      top: displayRow === 0,
      bottom: displayRow === rowCount - 1,
      left: isGutter,
      right: !isGutter && colIdx === colCount - 1,
    };
  }
  if (sel.kind === "rows") {
    if (!sel.rows.has(origIdx)) return null;
    const aboveOrig = displayRow > 0 ? displayRows[displayRow - 1].origIdx : -1;
    const belowOrig = displayRow < rowCount - 1 ? displayRows[displayRow + 1].origIdx : -1;
    return {
      top: !sel.rows.has(aboveOrig),
      bottom: !sel.rows.has(belowOrig),
      left: isGutter,
      right: !isGutter && colIdx === colCount - 1,
    };
  }
  if (sel.kind === "cols") {
    if (isGutter || !colName || !sel.cols.has(colName)) return null;
    const leftCol = colIdx > 0 ? result.columns[colIdx - 1].name : "";
    const rightCol = colIdx < colCount - 1 ? result.columns[colIdx + 1].name : "";
    return {
      top: displayRow === 0,
      bottom: displayRow === rowCount - 1,
      left: !sel.cols.has(leftCol),
      right: !sel.cols.has(rightCol),
    };
  }
  if (sel.kind === "cells") {
    if (isGutter) return null;
    const { minR, maxR, minC, maxC } = cellRect(sel);
    if (displayRow < minR || displayRow > maxR || colIdx < minC || colIdx > maxC) return null;
    return {
      top: displayRow === minR,
      bottom: displayRow === maxR,
      left: colIdx === minC,
      right: colIdx === maxC,
    };
  }
  return null;
}

/**
 * Composite box-shadow for a cell: selection perimeter + dirty marker.
 * box-shadow doesn't compose across CSS classes, and a dirty cell's
 * left-bar needs to coexist with selection edges.
 */
export function cellBoxShadow(edges: CellEdges | null, dirty: boolean): string | undefined {
  const parts: string[] = [];
  if (edges?.top) parts.push("inset 0 2px 0 var(--op-read)");
  if (edges?.bottom) parts.push("inset 0 -2px 0 var(--op-read)");
  if (edges?.left) parts.push("inset 2px 0 0 var(--op-read)");
  if (edges?.right) parts.push("inset -2px 0 0 var(--op-read)");
  // Selection's own left edge would cover the gold dirty bar; skip in that case.
  if (dirty && !edges?.left) parts.push("inset 2px 0 0 0 var(--op-write)");
  return parts.length ? parts.join(", ") : undefined;
}

export function buildSelectionTsv(
  sel: Selection,
  result: QueryResult,
  displayRows: DisplayRow[],
): string {
  let lines: string[] = [];
  if (sel.kind === "all") {
    lines = displayRows.map(({ row }) => row.map(cellToTsv).join("\t"));
  } else if (sel.kind === "rows") {
    lines = displayRows
      .filter(({ origIdx }) => sel.rows.has(origIdx))
      .map(({ row }) => row.map(cellToTsv).join("\t"));
  } else if (sel.kind === "cols") {
    const idxs: number[] = [];
    result.columns.forEach((c, i) => {
      if (sel.cols.has(c.name)) idxs.push(i);
    });
    lines = displayRows.map(({ row }) => idxs.map((i) => cellToTsv(row[i])).join("\t"));
  } else if (sel.kind === "cells") {
    const { minR, maxR, minC, maxC } = cellRect(sel);
    for (let r = minR; r <= maxR; r++) {
      const dr = displayRows[r];
      if (!dr) continue;
      const cells: string[] = [];
      for (let c = minC; c <= maxC; c++) cells.push(cellToTsv(dr.row[c]));
      lines.push(cells.join("\t"));
    }
  }
  return lines.join("\n");
}

// ── Click reducers ─────────────────────────────────────────────
//
// Each takes the current selection plus the click event and returns the
// next selection. State management (calling setSel) stays in the component
// so React can keep track of when to schedule a re-render.

type ModifierKeys = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

export function clickRowNumber(sel: Selection, origIdx: number, e: ModifierKeys): Selection {
  if (e.shiftKey && sel.kind === "rows") {
    const lo = Math.min(sel.anchor, origIdx);
    const hi = Math.max(sel.anchor, origIdx);
    const rows = new Set<number>();
    for (let i = lo; i <= hi; i++) rows.add(i);
    return { kind: "rows", rows, anchor: sel.anchor };
  }
  if ((e.metaKey || e.ctrlKey) && sel.kind === "rows") {
    const rows = new Set(sel.rows);
    if (rows.has(origIdx)) rows.delete(origIdx);
    else rows.add(origIdx);
    if (rows.size === 0) return NONE;
    return { kind: "rows", rows, anchor: origIdx };
  }
  return { kind: "rows", rows: new Set([origIdx]), anchor: origIdx };
}

export function clickColumnHeader(
  sel: Selection,
  colName: string,
  e: ModifierKeys,
  order: string[],
): Selection {
  if (e.shiftKey && sel.kind === "cols") {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(colName);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const cols = new Set<string>();
      for (let i = lo; i <= hi; i++) cols.add(order[i]);
      return { kind: "cols", cols, anchor: sel.anchor };
    }
  }
  if ((e.metaKey || e.ctrlKey) && sel.kind === "cols") {
    const cols = new Set(sel.cols);
    if (cols.has(colName)) cols.delete(colName);
    else cols.add(colName);
    if (cols.size === 0) return NONE;
    return { kind: "cols", cols, anchor: colName };
  }
  return { kind: "cols", cols: new Set([colName]), anchor: colName };
}

export function clickCell(
  sel: Selection,
  displayRow: number,
  colIdx: number,
  e: ModifierKeys,
): Selection {
  if (e.shiftKey && sel.kind === "cells") {
    return { ...sel, r1: displayRow, c1: colIdx };
  }
  return { kind: "cells", r0: displayRow, c0: colIdx, r1: displayRow, c1: colIdx };
}
