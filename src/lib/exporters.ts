import type { ColumnMeta, QueryResult } from "./api";

// ── Serializers (in-memory, for "Copy as X" and "Save loaded rows") ──
//
// The streaming Rust path (export_query) is used for "Save all rows" when
// results are truncated; these helpers handle the data already in JS.

const BOM = "﻿";

export function rowsToCsv(result: QueryResult, opts: { bom?: boolean } = {}): string {
  const { bom = true } = opts;
  const parts: string[] = [];
  if (bom) parts.push(BOM);
  parts.push(result.columns.map((c) => csvField(c.name)).join(",") + "\r\n");
  for (const row of result.rows) {
    const line = row.map((v) => (v === null ? "" : csvField(v))).join(",");
    parts.push(line + "\r\n");
  }
  return parts.join("");
}

export function rowsToJson(result: QueryResult): string {
  const objects = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < result.columns.length; i++) {
      const col = result.columns[i];
      obj[col.name] = coerceCellForJson(row[i], col);
    }
    return obj;
  });
  return JSON.stringify(objects, null, 2) + "\n";
}

export function rowsToMarkdown(result: QueryResult): string {
  const headers = result.columns.map((c) => mdCell(c.name));
  const sep = result.columns.map(() => "---");
  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${sep.join(" | ")} |`);
  for (const row of result.rows) {
    const cells = row.map((v) => (v === null ? "" : mdCell(v)));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

// ── Helpers ──────────────────────────────────────────────────────────

function csvField(s: string): string {
  // RFC 4180: quote when the field contains ", comma, CR, or LF.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function mdCell(s: string): string {
  // Markdown table cells: collapse newlines (rows are line-delimited) and
  // escape pipes so the table parses.
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function coerceCellForJson(v: string | null, col: ColumnMeta): unknown {
  if (v === null) return null;
  const t = col.data_type;
  if (t === "jsonb" || t === "json") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (t === "int2" || t === "int4" || t === "int8") {
    const n = Number(v);
    return Number.isInteger(n) ? n : v;
  }
  if (t === "float4" || t === "float8" || t === "numeric") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (t === "bool") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return v;
}

// ── Filename ─────────────────────────────────────────────────────────

/** Build a default filename from a tab title + extension. ASCII-safe. */
export function defaultFilename(tabTitle: string, ext: "csv" | "json"): string {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const safe = sanitize(tabTitle) || "query";
  return `${safe}-${y}-${m}-${d}.${ext}`;
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Size estimation (for menu header) ────────────────────────────────

/** Rough size estimate (bytes) for the loaded rows in a given format. */
export function estimateSize(result: QueryResult, format: "csv" | "json" | "md"): number {
  // Cheap heuristic — sum of cell string lengths + per-row/column overhead.
  let cellBytes = 0;
  for (const row of result.rows) {
    for (const v of row) {
      if (v !== null) cellBytes += v.length;
    }
  }
  const cols = result.columns.length;
  const rows = result.rows.length;
  const perRow = format === "csv" ? cols : format === "md" ? cols * 3 + 4 : cols * 6 + 6;
  return cellBytes + rows * perRow;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
