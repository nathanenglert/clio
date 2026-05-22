import type { PendingBatch } from "../lib/editing";
import { batchCounts, isEmpty } from "../lib/editing";

type Props = {
  batch: PendingBatch;
  /** In-progress add rows that haven't been finalized into the batch yet. */
  pendingAdds: number;
  table: string;
  connection: string;
  busy: boolean;
  onReview: () => void;
  onCommit: () => void;
  onDiscard: () => void;
};

export function PendingTray({ batch, pendingAdds, table, connection, busy, onReview, onCommit, onDiscard }: Props) {
  if (isEmpty(batch) && pendingAdds === 0) return null;
  const counts = batchCounts(batch);
  const adds = counts.adds + pendingAdds;
  const { edits, deletes } = counts;
  return (
    <div className="pending-tray">
      {edits > 0 && (
        <span className="tray-seg">
          <span className="op-glyph write" aria-hidden />
          <span className="mono tray-count">{edits}</span>
          <span className="tray-label">edit{edits === 1 ? "" : "s"}</span>
        </span>
      )}
      {adds > 0 && (
        <span className="tray-seg">
          <span className="op-glyph write" aria-hidden />
          <span className="mono tray-count">{adds}</span>
          <span className="tray-label">add{adds === 1 ? "" : "s"}</span>
        </span>
      )}
      {deletes > 0 && (
        <span className="tray-seg">
          <span className="op-glyph destruct" aria-hidden />
          <span className="mono tray-count">{deletes}</span>
          <span className="tray-label">delete{deletes === 1 ? "" : "s"}</span>
        </span>
      )}
      <span className="tray-dot">·</span>
      <span className="mono tray-context">
        {table} @ {connection}
      </span>
      <span className="tray-dot">·</span>
      <span className="tray-status">uncommitted</span>
      <div className="spacer" />
      <button className="editor-btn" onClick={onReview} disabled={busy}>
        Review SQL
      </button>
      <button className="editor-btn primary-write" onClick={onCommit} disabled={busy}>
        {busy ? "Committing…" : "Commit"}
        <kbd className="kbd">⌘↵</kbd>
      </button>
      <button
        className="editor-btn ghost"
        onClick={onDiscard}
        disabled={busy}
        title="Discard all staged changes"
      >
        ✗
      </button>
    </div>
  );
}
