import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  type Category,
  type Classification,
  type ClassificationAction,
  type ClassificationStatus,
  type SharedFileStatus,
  type WaitingSafe,
} from "../lib/api";
import { Modal } from "./Modal";
import { showToast } from "./Toast";

type Props = {
  connection: string;
  onClose: () => void;
};

const ALL_CATEGORIES: Category[] = ["phi", "pci", "pii"];
const FILE_FILTERS = [{ name: "JSON", extensions: ["json"] }];

type ColumnRef = Pick<Classification, "schema" | "table" | "column">;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function dirname(path: string): string {
  return path.slice(0, path.length - basename(path).length);
}

type Filter = "all" | ClassificationStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "safe", label: "Safe" },
];

/**
 * Per-connection sensitivity review panel. Lists every classified column,
 * grouped by table. Each row lets the user confirm a pending suggestion,
 * change its category, or mark it safe (not redacted, never suggested
 * again); a safe row can be redacted again. Each table can be marked safe in
 * one go. See design/redaction.md §"Review panel".
 *
 * The modal pulls `list_classifications` fresh whenever it opens (and
 * whenever an action mutates state); it does not mirror a parent prop.
 * Mutations call `update_classification`, which invalidates the
 * per-connection redactor cache so the next query reflects the change.
 *
 * A connection can link a shared file of reviewed decisions; columns the file
 * marks safe stay redacted here until accepted. See
 * design/shared-sensitivity-file.md.
 */
export function SensitivityModal({ connection, onClose }: Props) {
  const [rows, setRows] = useState<Classification[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // undefined while loading; null when not linked.
  const [shared, setShared] = useState<SharedFileStatus | null | undefined>(undefined);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [r, f] = await Promise.all([
        api.list_classifications(connection),
        api.sensitivity_file_status(connection),
      ]);
      setRows(r);
      setShared(f);
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
      if (filter !== "all" && r.status !== filter) continue;
      const key = `${r.schema}.${r.table}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key)!.push(r);
    }
    return Array.from(byTable.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows, filter]);

  const count = (status: ClassificationStatus) =>
    rows?.filter((r) => r.status === status).length ?? 0;
  const pendingCount = count("pending");
  const confirmedCount = count("confirmed");
  const safeCount = count("safe");

  // Applies `action` to each row in turn, then reloads once.
  const actOn = useCallback(
    async (targets: ColumnRef[], action: ClassificationAction) => {
      setBusy(true);
      try {
        for (const row of targets) {
          await api.update_classification(
            connection,
            row.schema,
            row.table,
            row.column,
            action,
          );
        }
      } catch (e) {
        showToast(String(e), "err");
      } finally {
        await reload();
        setBusy(false);
      }
    },
    [connection, reload],
  );
  const act = useCallback(
    (row: Classification, action: ClassificationAction) => actOn([row], action),
    [actOn],
  );

  const link = useCallback(
    async (create: boolean) => {
      const path = create
        ? await saveDialog({ defaultPath: "clio-pii.json", filters: FILE_FILTERS })
        : await openDialog({ multiple: false, directory: false, filters: FILE_FILTERS });
      if (typeof path !== "string") return; // cancelled
      setBusy(true);
      try {
        const added = await api.link_sensitivity_file(connection, path);
        showToast(
          added > 0
            ? `Linked ${basename(path)}. Added ${added} decision${added === 1 ? "" : "s"} from ${connection}.`
            : `Linked ${basename(path)}.`,
        );
      } catch (e) {
        showToast(String(e), "err");
      } finally {
        await reload();
        setBusy(false);
      }
    },
    [connection, reload],
  );

  const unlink = useCallback(async () => {
    setBusy(true);
    try {
      await api.unlink_sensitivity_file(connection);
    } catch (e) {
      showToast(String(e), "err");
    } finally {
      await reload();
      setBusy(false);
    }
  }, [connection, reload]);

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
          <span className="mono">{rows ? pendingCount + confirmedCount : "…"}</span> redacted
        </span>
        <span className="tray-dot">·</span>
        <span>
          <span className="mono">{pendingCount}</span> pending
        </span>
        <span className="tray-dot">·</span>
        <span>
          <span className="mono">{confirmedCount}</span> confirmed
        </span>
        <span className="tray-dot">·</span>
        <span>
          <span className="mono">{safeCount}</span> safe
        </span>
        <select
          className="sens-cat-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          aria-label="Filter by status"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <span className="sens-summary-hint">
          Redacted on every read (MCP always, UI when masked). Text columns stay
          redacted until you mark them safe.
        </span>
      </div>

      {shared !== undefined && (
        <SharedFileBar
          shared={shared}
          busy={busy}
          onLink={() => link(false)}
          onCreate={() => link(true)}
          onUnlink={unlink}
        />
      )}

      {error && (
        <div className="review-warn">
          <span className="warn-icon" aria-hidden>⚠</span>
          <span className="mono">{error}</span>
        </div>
      )}

      <div className="sens-body">
        {shared && shared.waiting.length > 0 && (
          <WaitingGroup
            waiting={shared.waiting}
            busy={busy}
            onAccept={(targets) => actOn(targets, { kind: "mark_safe" })}
          />
        )}
        {rows === null && !error && (
          <div className="sens-empty">Loading classifications…</div>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="sens-empty">
            No classified columns yet. Text columns and PHI/PCI/PII-shaped
            columns show up here after connecting.
          </div>
        )}
        {rows !== null && rows.length > 0 && groups.length === 0 && (
          <div className="sens-empty">No {filter} columns.</div>
        )}
        {groups.map(([key, items]) => (
          <SensitivityTableGroup
            key={key}
            tableKey={key}
            items={items}
            busy={busy}
            onAction={act}
            onMarkTableSafe={() =>
              actOn(
                items.filter((r) => r.status !== "safe"),
                { kind: "mark_safe" },
              )
            }
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

function SharedFileBar({
  shared,
  busy,
  onLink,
  onCreate,
  onUnlink,
}: {
  shared: SharedFileStatus | null;
  busy: boolean;
  onLink: () => void;
  onCreate: () => void;
  onUnlink: () => void;
}) {
  if (!shared) {
    return (
      <div className="sens-share">
        <span className="sens-share-label">Not shared</span>
        <span className="tray-dot">·</span>
        <span className="sens-summary-hint">
          Share these reviews with other connections and teammates through a file in your repo.
        </span>
        <div className="spacer" />
        <button className="editor-btn ghost" disabled={busy} onClick={onLink}>
          Link file…
        </button>
        <button className="editor-btn ghost" disabled={busy} onClick={onCreate}>
          Create file…
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="sens-share">
        <span className="sens-share-label">Shared file</span>
        <span className="mono sens-share-name" title={shared.path}>
          {basename(shared.path)}
        </span>
        {/* Truncates from the left, so the folder nearest the file stays. */}
        <span className="mono sens-share-path" title={shared.path}>
          {`\u200e${dirname(shared.path)}\u200e`}
        </span>
        <div className="spacer" />
        <button className="editor-btn ghost" disabled={busy} onClick={onUnlink}>
          Unlink
        </button>
      </div>
      {shared.error && (
        <div className="review-warn">
          <span className="warn-icon" aria-hidden>⚠</span>
          <span className="mono">
            {shared.error}. Agents can't use this connection until the file is fixed or unlinked.
          </span>
        </div>
      )}
    </>
  );
}

function WaitingGroup({
  waiting,
  busy,
  onAccept,
}: {
  waiting: WaitingSafe[];
  busy: boolean;
  onAccept: (targets: WaitingSafe[]) => void;
}) {
  return (
    <div className="sens-group waiting">
      <div className="sens-group-head">
        <span>Marked safe in the shared file</span>
        <span className="mono">{waiting.length}</span>
        <span className="sens-summary-hint">Still redacted here until you accept.</span>
        <div className="spacer" />
        <button
          className="editor-btn ghost"
          disabled={busy}
          onClick={() => onAccept(waiting)}
          title="Mark every column in this list safe on this connection"
        >
          Accept all
        </button>
      </div>
      <div className="sens-group-list">
        {waiting.map((w) => (
          <div key={`${w.schema}.${w.table}.${w.column}`} className="sens-row pending">
            <span className="sens-glyph" aria-hidden>
              ◌
            </span>
            <span className="sens-col mono">
              {w.schema}.{w.table}.{w.column}
            </span>
            <span className="sens-reason">{w.reason}</span>
            <div className="spacer" />
            <div className="sens-actions">
              <button
                className="editor-btn"
                disabled={busy}
                onClick={() => onAccept([w])}
                title="Mark safe on this connection: stop redacting it"
              >
                Accept
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SensitivityTableGroup({
  tableKey,
  items,
  busy,
  onAction,
  onMarkTableSafe,
}: {
  tableKey: string;
  items: Classification[];
  busy: boolean;
  onAction: (row: Classification, action: ClassificationAction) => void;
  onMarkTableSafe: () => void;
}) {
  const redacted = items.filter((r) => r.status !== "safe").length;
  return (
    <div className="sens-group">
      <div className="sens-group-head">
        <span className="mono">{tableKey}</span>
        <div className="spacer" />
        {redacted > 0 && (
          <button
            className="editor-btn ghost"
            disabled={busy}
            onClick={onMarkTableSafe}
            title="Mark every redacted column in this table safe"
          >
            Mark table safe
          </button>
        )}
      </div>
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
  if (row.status === "safe") {
    return (
      <div className="sens-row safe">
        <span className="sens-glyph" aria-hidden />
        <span className="sens-col mono">{row.column}</span>
        <span className="sens-cat-pill safe">SAFE</span>
        <span className="sens-reason">marked safe · not redacted</span>
        <div className="spacer" />
        <div className="sens-actions">
          <button
            className="editor-btn"
            disabled={busy}
            onClick={() => onAction(row, { kind: "confirm" })}
            title={`Redact again as ${row.category.toUpperCase()}`}
          >
            Redact
          </button>
        </div>
      </div>
    );
  }
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
          onClick={() => onAction(row, { kind: "mark_safe" })}
          title="Mark safe — not sensitive. Stops redacting it, and the scan won't suggest it again"
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
