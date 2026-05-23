import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, type QueryResult } from "../lib/api";
import {
  defaultFilename,
  estimateSize,
  formatBytes,
  rowsToCsv,
  rowsToJson,
  rowsToMarkdown,
} from "../lib/exporters";
import { showToast } from "./Toast";

type Props = {
  result: QueryResult | null;
  sql: string;
  tabTitle: string;
  connectionName: string | null;
  /** Imperative trigger — bump this number to open the menu (e.g. from ⌘E). */
  openSignal?: number;
  disabled?: boolean;
  /** Mirror of the View > Reveal toggle. When false, server-side export
   *  applies the same redaction the UI shows. */
  reveal?: boolean;
};

type Action =
  | { kind: "copy"; format: "csv" | "json" | "md" }
  | { kind: "save-loaded"; format: "csv" | "json" }
  | { kind: "save-all"; format: "csv" | "json" };

export function ExportMenu({
  result,
  sql,
  tabTitle,
  connectionName,
  openSignal,
  disabled,
  reveal,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Mirror the latest open state so module-level handlers don't capture stale.
  const openRef = useRef(open);
  openRef.current = open;

  // External open (⌘E)
  useEffect(() => {
    if (openSignal === undefined) return;
    if (disabled || !result) return;
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  // Outside click + escape close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current || !triggerRef.current) return;
      const t = e.target as Node;
      if (menuRef.current.contains(t) || triggerRef.current.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const runAction = useCallback(
    async (action: Action) => {
      if (!result || busy) return;
      setBusy(true);
      try {
        if (action.kind === "copy") {
          const text =
            action.format === "csv"
              ? rowsToCsv(result, { bom: false })
              : action.format === "json"
                ? rowsToJson(result)
                : rowsToMarkdown(result);
          await writeText(text);
          showToast(`Copied ${result.rows.length.toLocaleString()} rows as ${labelFor(action.format)}`);
        } else if (action.kind === "save-loaded") {
          const path = await saveDialog({
            defaultPath: defaultFilename(tabTitle, action.format),
            filters: filtersFor(action.format),
          });
          if (!path) {
            return; // user cancelled
          }
          const text =
            action.format === "csv" ? rowsToCsv(result) : rowsToJson(result);
          await api.write_file(path, text);
          showToast(`Saved ${result.rows.length.toLocaleString()} rows → ${basename(path)}`);
        } else if (action.kind === "save-all") {
          if (!connectionName) {
            showToast("No active connection", "err");
            return;
          }
          const path = await saveDialog({
            defaultPath: defaultFilename(tabTitle, action.format),
            filters: filtersFor(action.format),
          });
          if (!path) return;
          const r = await api.export_query(connectionName, sql, path, action.format, !!reveal);
          showToast(
            `Exported ${r.row_count.toLocaleString()} rows → ${basename(path)}`
          );
        }
      } catch (e) {
        showToast(`Export failed: ${e}`, "err");
      } finally {
        setBusy(false);
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
    [busy, result, connectionName, sql, tabTitle, reveal]
  );

  const truncated = result?.truncated ?? false;
  const loadedRows = result?.rows.length ?? 0;
  const totalRows = result?.row_count ?? 0;

  return (
    <div className="export-menu-wrap">
      <button
        ref={triggerRef}
        className="editor-btn"
        disabled={disabled || !result}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export (⌘E)"
      >
        <span className="editor-btn-icon" aria-hidden>↥</span>
        Export
      </button>

      {open && result && (
        <div ref={menuRef} className="export-menu" role="menu">
          <div className="export-menu-header">
            <div className="export-menu-title">
              {loadedRows.toLocaleString()} row{loadedRows === 1 ? "" : "s"} loaded
              {truncated && (
                <>
                  {" "}
                  <span className="export-menu-of">of {totalRows.toLocaleString()}</span>
                </>
              )}
            </div>
            <div className="export-menu-sub mono">
              {formatBytes(estimateSize(result, "csv"))} CSV
              {" · "}
              {formatBytes(estimateSize(result, "json"))} JSON
            </div>
          </div>

          {truncated && (
            <div className="export-banner">
              Showing {loadedRows.toLocaleString()} of {totalRows.toLocaleString()} rows.
              Use <strong>Save all rows</strong> below for the full result.
            </div>
          )}

          <div className="export-menu-section-label">Copy to clipboard</div>
          <MenuItem
            label="Copy as CSV"
            onSelect={() => runAction({ kind: "copy", format: "csv" })}
            disabled={busy}
          />
          <MenuItem
            label="Copy as JSON"
            onSelect={() => runAction({ kind: "copy", format: "json" })}
            disabled={busy}
          />
          <MenuItem
            label="Copy as Markdown table"
            onSelect={() => runAction({ kind: "copy", format: "md" })}
            disabled={busy}
          />

          <div className="export-menu-divider" />

          <div className="export-menu-section-label">Save to file</div>
          <MenuItem
            label={truncated ? `Save loaded rows as CSV…` : `Save as CSV…`}
            onSelect={() => runAction({ kind: "save-loaded", format: "csv" })}
            disabled={busy}
          />
          <MenuItem
            label={truncated ? `Save loaded rows as JSON…` : `Save as JSON…`}
            onSelect={() => runAction({ kind: "save-loaded", format: "json" })}
            disabled={busy}
          />
          {truncated && (
            <>
              <div className="export-menu-divider" />
              <MenuItem
                label={`Save all ${totalRows.toLocaleString()} rows as CSV…`}
                emphasis
                onSelect={() => runAction({ kind: "save-all", format: "csv" })}
                disabled={busy}
              />
              <MenuItem
                label={`Save all ${totalRows.toLocaleString()} rows as JSON…`}
                emphasis
                onSelect={() => runAction({ kind: "save-all", format: "json" })}
                disabled={busy}
              />
            </>
          )}
          {result?.redaction_meta && (
            <div className="export-menu-footnote">
              <span aria-hidden style={{ color: "var(--privacy)", marginRight: 6 }}>◌</span>
              Exporting masked values for{" "}
              <span className="mono">{result.redaction_meta.redacted_columns.length}</span> column
              {result.redaction_meta.redacted_columns.length === 1 ? "" : "s"}. Toggle{" "}
              <span className="mono">View &gt; Reveal sensitive data</span> to export real values.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onSelect,
  disabled,
  emphasis,
}: {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`export-menu-item${emphasis ? " emphasis" : ""}`}
      onClick={onSelect}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

function labelFor(f: "csv" | "json" | "md"): string {
  return f === "csv" ? "CSV" : f === "json" ? "JSON" : "Markdown";
}

function filtersFor(format: "csv" | "json") {
  return format === "csv"
    ? [{ name: "CSV", extensions: ["csv"] }]
    : [{ name: "JSON", extensions: ["json"] }];
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
