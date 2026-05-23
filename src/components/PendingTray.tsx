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
      <TraySegment count={edits} singular="edit" plural="edits" glyph="write" />
      <TraySegment count={adds} singular="add" plural="adds" glyph="write" />
      <TraySegment count={deletes} singular="delete" plural="deletes" glyph="destruct" />
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

function TraySegment({
  count,
  singular,
  plural,
  glyph,
}: {
  count: number;
  singular: string;
  plural: string;
  glyph: "write" | "destruct";
}) {
  if (count === 0) return null;
  return (
    <span className="tray-seg">
      <span className={`op-glyph ${glyph}`} aria-hidden />
      <span className="mono tray-count">{count}</span>
      <span className="tray-label">{count === 1 ? singular : plural}</span>
    </span>
  );
}
