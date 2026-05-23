import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type Category,
  type Classification,
  type ClassificationAction,
} from "../lib/api";
import { Modal } from "./Modal";
import { showToast } from "./Toast";

type Props = {
  connection: string;
  onClose: () => void;
};

const ALL_CATEGORIES: Category[] = ["phi", "pci", "pii"];

/**
 * Per-connection sensitivity review panel. Lists every classified column,
 * grouped by table. Each row lets the user confirm a pending suggestion,
 * remove a classification, or change its category. See
 * design/redaction.md §"Review panel".
 *
 * The modal pulls `list_classifications` fresh whenever it opens (and
 * whenever an action mutates state); it does not mirror a parent prop.
 * Mutations call `update_classification`, which invalidates the
 * per-connection redactor cache so the next query reflects the change.
 */
export function SensitivityModal({ connection, onClose }: Props) {
  const [rows, setRows] = useState<Classification[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await api.list_classifications(connection);
      setRows(r);
    } catch (e) {
      setError(String(e));
    }
  }, [connection]);

  useEffect(() => {
    reload();
  }, [reload]);

  const groups = useMemo(() => {
    if (!rows) return [];
    const byTable = new Map<string, Classification[]>();
    for (const r of rows) {
      const key = `${r.schema}.${r.table}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key)!.push(r);
    }
    return Array.from(byTable.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const pendingCount = rows?.filter((r) => r.status === "pending").length ?? 0;
  const confirmedCount = rows?.filter((r) => r.status === "confirmed").length ?? 0;

  const act = useCallback(
    async (row: Classification, action: ClassificationAction) => {
      setBusy(true);
      try {
        await api.update_classification(
          connection,
          row.schema,
          row.table,
          row.column,
          action,
        );
        await reload();
      } catch (e) {
        showToast(String(e), "err");
      } finally {
        setBusy(false);
      }
    },
    [connection, reload],
  );

  return (
    <Modal onClose={onClose} className="sensitivity-modal">
      <div className="review-head">
        <span className="review-title">Sensitivity</span>
        <span className="tray-dot">·</span>
        <span className="mono review-meta">{connection}</span>
        <div className="spacer" />
        <button className="editor-btn ghost" onClick={onClose} aria-label="Close">
          ✗
        </button>
      </div>

      <div className="sens-summary">
        <span aria-hidden style={{ color: "var(--privacy)" }}>◌</span>
        <span>
          <span className="mono">{rows?.length ?? "…"}</span> classified
        </span>
        <span className="tray-dot">·</span>
        <span>
          <span className="mono">{pendingCount}</span> pending
        </span>
        <span className="tray-dot">·</span>
        <span>
          <span className="mono">{confirmedCount}</span> confirmed
        </span>
        <div className="spacer" />
        <span className="sens-summary-hint">
          PHI / PCI / PII columns are redacted on every read (MCP always, UI when
          masked). Confirm or reject suggestions below.
        </span>
      </div>

      {error && (
        <div className="review-warn">
          <span className="warn-icon" aria-hidden>⚠</span>
          <span className="mono">{error}</span>
        </div>
      )}

      <div className="sens-body">
        {rows === null && !error && (
          <div className="sens-empty">Loading classifications…</div>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="sens-empty">
            No classified columns yet. Connect to a database with PHI/PCI/PII-
            shaped column names to see suggestions.
          </div>
        )}
        {groups.map(([key, items]) => (
          <SensitivityTableGroup
            key={key}
            tableKey={key}
            items={items}
            busy={busy}
            onAction={act}
          />
        ))}
      </div>

      <div className="review-foot">
        <div className="spacer" />
        <button className="editor-btn" onClick={onClose} disabled={busy}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function SensitivityTableGroup({
  tableKey,
  items,
  busy,
  onAction,
}: {
  tableKey: string;
  items: Classification[];
  busy: boolean;
  onAction: (row: Classification, action: ClassificationAction) => void;
}) {
  return (
    <div className="sens-group">
      <div className="sens-group-head mono">{tableKey}</div>
      <div className="sens-group-list">
        {items.map((row) => (
          <SensitivityRow
            key={`${row.schema}.${row.table}.${row.column}`}
            row={row}
            busy={busy}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function SensitivityRow({
  row,
  busy,
  onAction,
}: {
  row: Classification;
  busy: boolean;
  onAction: (row: Classification, action: ClassificationAction) => void;
}) {
  const pending = row.status === "pending";
  return (
    <div className={`sens-row ${pending ? "pending" : "confirmed"}`}>
      <span
        className="sens-glyph"
        title={`Redacted as ${row.category.toUpperCase()}`}
        aria-hidden
      >
        ◌
      </span>
      <span className="sens-col mono">{row.column}</span>
      <span className="sens-cat-pill" data-cat={row.category}>
        {row.category.toUpperCase()}
      </span>
      <span className={`sens-status ${pending ? "pending" : "confirmed"}`}>
        {pending ? "?" : "✓"}
      </span>
      <span className="sens-reason">{row.reason}</span>
      <div className="spacer" />
      <div className="sens-actions">
        {pending && (
          <button
            className="editor-btn"
            disabled={busy}
            onClick={() => onAction(row, { kind: "confirm" })}
            title="Confirm — accept this classification"
          >
            ✓
          </button>
        )}
        <CategorySelect
          value={row.category}
          disabled={busy}
          onChange={(cat) =>
            cat !== row.category && onAction(row, { kind: "set_category", category: cat })
          }
        />
        <button
          className="editor-btn destruct"
          disabled={busy}
          onClick={() => onAction(row, { kind: "remove" })}
          title="Remove — column will no longer be redacted"
        >
          ✗
        </button>
      </div>
    </div>
  );
}

function CategorySelect({
  value,
  disabled,
  onChange,
}: {
  value: Category;
  disabled: boolean;
  onChange: (cat: Category) => void;
}) {
  return (
    <select
      className="sens-cat-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Category)}
      aria-label="Change category"
    >
      {ALL_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c.toUpperCase()}
        </option>
      ))}
    </select>
  );
}
