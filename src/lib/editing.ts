// Staged-tray editing model. Pure data — no React, no IO.
// See design/result-editing.md for the full spec.

import type {
  ColumnDescription,
  MutationBatch,
  MutationOp,
  QueryResult,
} from "./api";

/** Identifier for a row in the original result, as PK column/value pairs. */
export type RowKey = Array<[string, string | null]>;

/** col → new value (null is an explicit SET NULL). */
export type EditMap = Record<string, string | null>;

export type PendingEdit = {
  rowIdx: number;
  pk: RowKey;
  cells: EditMap;
};

export type PendingAdd = {
  tempId: string;
  cells: EditMap;
};

export type PendingDelete = {
  rowIdx: number;
  pk: RowKey;
};

export type PendingBatch = {
  edits: PendingEdit[];
  adds: PendingAdd[];
  deletes: PendingDelete[];
};

/** In-progress add row that hasn't been confirmed into the batch yet. */
export type ActiveAdd = {
  tempId: string;
  cells: Record<string, string | null>;
};

export const emptyBatch: PendingBatch = { edits: [], adds: [], deletes: [] };

export function isEmpty(b: PendingBatch): boolean {
  return b.edits.length === 0 && b.adds.length === 0 && b.deletes.length === 0;
}

export function batchCounts(b: PendingBatch) {
  // Edits is "rows with edits" — could include multi-column edits per row.
  return { edits: b.edits.length, adds: b.adds.length, deletes: b.deletes.length };
}

/** Build a RowKey from a result row using PK columns. Returns null if no PK present. */
export function rowKey(
  result: QueryResult,
  columnsMeta: ColumnDescription[],
  rowIdx: number,
): RowKey | null {
  const pkNames = columnsMeta.filter((c) => c.is_primary_key).map((c) => c.name);
  if (pkNames.length === 0) return null;
  const row = result.rows[rowIdx];
  if (!row) return null;
  const colIdxByName = new Map<string, number>();
  result.columns.forEach((c, i) => colIdxByName.set(c.name, i));
  const out: RowKey = [];
  for (const name of pkNames) {
    const ci = colIdxByName.get(name);
    if (ci === undefined) return null;
    out.push([name, row[ci] ?? null]);
  }
  return out;
}

// ── Stage helpers ──────────────────────────────────────────────

export function stageEdit(
  batch: PendingBatch,
  rowIdx: number,
  pk: RowKey,
  col: string,
  value: string | null,
): PendingBatch {
  // If the row already has an edit entry, merge.
  const idx = batch.edits.findIndex((e) => e.rowIdx === rowIdx);
  if (idx >= 0) {
    const next = [...batch.edits];
    next[idx] = { ...next[idx], cells: { ...next[idx].cells, [col]: value } };
    return { ...batch, edits: next };
  }
  return { ...batch, edits: [...batch.edits, { rowIdx, pk, cells: { [col]: value } }] };
}

export function unstageEdit(batch: PendingBatch, rowIdx: number, col: string): PendingBatch {
  const idx = batch.edits.findIndex((e) => e.rowIdx === rowIdx);
  if (idx < 0) return batch;
  const cur = batch.edits[idx];
  const cells = { ...cur.cells };
  delete cells[col];
  if (Object.keys(cells).length === 0) {
    return { ...batch, edits: batch.edits.filter((_, i) => i !== idx) };
  }
  const next = [...batch.edits];
  next[idx] = { ...cur, cells };
  return { ...batch, edits: next };
}

export function stageAdd(batch: PendingBatch, tempId: string, cells: EditMap): PendingBatch {
  return { ...batch, adds: [...batch.adds, { tempId, cells }] };
}

export function unstageAdd(batch: PendingBatch, tempId: string): PendingBatch {
  return { ...batch, adds: batch.adds.filter((a) => a.tempId !== tempId) };
}

export function updateAdd(batch: PendingBatch, tempId: string, col: string, value: string | null): PendingBatch {
  return {
    ...batch,
    adds: batch.adds.map((a) =>
      a.tempId === tempId ? { ...a, cells: { ...a.cells, [col]: value } } : a,
    ),
  };
}

export function stageDelete(batch: PendingBatch, rowIdx: number, pk: RowKey): PendingBatch {
  if (batch.deletes.some((d) => d.rowIdx === rowIdx)) return batch;
  // Also drop any in-place edits to this row — they don't outlive a delete.
  const edits = batch.edits.filter((e) => e.rowIdx !== rowIdx);
  return { ...batch, edits, deletes: [...batch.deletes, { rowIdx, pk }] };
}

export function unstageDelete(batch: PendingBatch, rowIdx: number): PendingBatch {
  return { ...batch, deletes: batch.deletes.filter((d) => d.rowIdx !== rowIdx) };
}

export function getEdit(batch: PendingBatch, rowIdx: number, col: string): { staged: true; value: string | null } | { staged: false } {
  const e = batch.edits.find((x) => x.rowIdx === rowIdx);
  if (e && col in e.cells) return { staged: true, value: e.cells[col] };
  return { staged: false };
}

export function isDeleted(batch: PendingBatch, rowIdx: number): boolean {
  return batch.deletes.some((d) => d.rowIdx === rowIdx);
}

// ── Conversion to MutationBatch for apply_mutations ───────────────

export function toMutationBatch(
  batch: PendingBatch,
  schema: string,
  table: string,
  /** In-progress add rows. Treated as inserts with any non-undefined cells. */
  activeAdds: ActiveAdd[] = [],
): MutationBatch {
  const ops: MutationOp[] = [];
  for (const e of batch.edits) {
    const set = Object.entries(e.cells);
    if (set.length === 0) continue;
    ops.push({ kind: "update", schema, table, pk: e.pk, set });
  }
  for (const a of batch.adds) {
    const values = Object.entries(a.cells).filter(([, v]) => v !== undefined);
    if (values.length === 0) continue;
    ops.push({ kind: "insert", schema, table, values });
  }
  for (const a of activeAdds) {
    const values = Object.entries(a.cells).filter(([, v]) => v !== undefined);
    if (values.length === 0) continue;
    ops.push({ kind: "insert", schema, table, values });
  }
  for (const d of batch.deletes) {
    ops.push({ kind: "delete", schema, table, pk: d.pk });
  }
  return { ops };
}

// ── Preview SQL (display only — backend builds the real, parameterized SQL) ──

function sqlLiteral(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}
function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
function qual(schema: string, table: string): string {
  return `${ident(schema)}.${ident(table)}`;
}

export type PreviewStmt = {
  kind: "update" | "insert" | "delete";
  sql: string;
};

export function previewStatements(
  batch: PendingBatch,
  schema: string,
  table: string,
  activeAdds: ActiveAdd[] = [],
): PreviewStmt[] {
  const out: PreviewStmt[] = [];
  for (const e of batch.edits) {
    const sets = Object.entries(e.cells)
      .map(([c, v]) => `${ident(c)} = ${sqlLiteral(v)}`)
      .join(", ");
    const where = e.pk.map(([c, v]) => `${ident(c)} = ${sqlLiteral(v)}`).join(" AND ");
    out.push({ kind: "update", sql: `UPDATE ${qual(schema, table)} SET ${sets} WHERE ${where};` });
  }
  function emitInsert(cells: Record<string, string | null>) {
    const entries = Object.entries(cells).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const cols = entries.map(([c]) => ident(c)).join(", ");
    const vals = entries.map(([, v]) => sqlLiteral(v)).join(", ");
    out.push({ kind: "insert", sql: `INSERT INTO ${qual(schema, table)} (${cols}) VALUES (${vals});` });
  }
  for (const a of batch.adds) emitInsert(a.cells);
  for (const a of activeAdds) emitInsert(a.cells);
  for (const d of batch.deletes) {
    const where = d.pk.map(([c, v]) => `${ident(c)} = ${sqlLiteral(v)}`).join(" AND ");
    out.push({ kind: "delete", sql: `DELETE FROM ${qual(schema, table)} WHERE ${where};` });
  }
  return out;
}
