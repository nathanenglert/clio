import { useEffect } from "react";
import type { ActiveAdd, PendingBatch } from "../lib/editing";
import { previewStatements } from "../lib/editing";

type Props = {
  batch: PendingBatch;
  activeAdds: ActiveAdd[];
  schema: string;
  table: string;
  connection: string;
  busy: boolean;
  onClose: () => void;
  onCommit: () => void;
};

export function ReviewModal({ batch, activeAdds, schema, table, connection, busy, onClose, onCommit }: Props) {
  const stmts = previewStatements(batch, schema, table, activeAdds);
  const hasDestruct = stmts.some((s) => s.kind === "delete");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copy() {
    const text = ["BEGIN;", "", ...stmts.map((s) => s.sql), "", "COMMIT;"].join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="review-modal" onClick={(e) => e.stopPropagation()}>
        <div className="review-head">
          <span className="review-title">Review</span>
          <span className="tray-dot">·</span>
          <span className="mono review-meta">
            {stmts.length} statement{stmts.length === 1 ? "" : "s"}
          </span>
          <span className="tray-dot">·</span>
          <span className="mono review-meta">{connection}</span>
          <div className="spacer" />
          <button className="editor-btn ghost" onClick={onClose} aria-label="Close">
            ✗
          </button>
        </div>
        <div className="review-body mono">
          <div className="rev-line muted">BEGIN;</div>
          <div className="rev-spacer" />
          {stmts.map((s, i) => (
            <SqlPreviewLine key={i} sql={s.sql} kind={s.kind} />
          ))}
          <div className="rev-spacer" />
          <div className="rev-line muted">COMMIT;</div>
        </div>
        {hasDestruct && (
          <div className="review-warn">
            <span className="warn-icon" aria-hidden>⚠</span>
            <span>
              {stmts.filter((s) => s.kind === "delete").length} destructive statement
              {stmts.filter((s) => s.kind === "delete").length === 1 ? "" : "s"} — DELETE is permanent.
            </span>
          </div>
        )}
        <div className="review-foot">
          <button className="editor-btn" onClick={copy}>
            Copy SQL
          </button>
          <div className="spacer" />
          <button className="editor-btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="editor-btn primary-write" onClick={onCommit} disabled={busy}>
            {busy ? "Committing…" : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SqlPreviewLine({ sql, kind }: { sql: string; kind: "update" | "insert" | "delete" }) {
  // Colorize the leading verb only. The rest stays in the default mono color so
  // we don't try to roll a real SQL highlighter for this preview.
  const verb = kind === "update" ? "UPDATE" : kind === "insert" ? "INSERT" : "DELETE";
  const cls = kind === "delete" ? "sql-destruct" : "sql-write";
  const rest = sql.slice(verb.length);
  return (
    <div className="rev-line">
      <span className={cls}>{verb}</span>
      <span>{rest}</span>
    </div>
  );
}
