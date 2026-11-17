import { useEffect, useState } from "react";

/** "14s", "2m 14s", "1h 05m" since `sinceMs`, ticking every second. */
export function useElapsed(sinceMs: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sinceMs == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [sinceMs]);
  if (sinceMs == null) return "";
  const s = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

type Props = {
  openedAtMs: number;
  busy: boolean;
  onCommit: () => void;
  onRollback: () => void;
};

/** The tab's open transaction: how long it has held its locks, and the two
 *  ways to end it. */
export function TransactionChip({ openedAtMs, busy, onCommit, onRollback }: Props) {
  const elapsed = useElapsed(openedAtMs);
  return (
    <div className="tx-chip" role="status">
      <span className="tx-chip-dot" aria-hidden />
      <span className="tx-chip-label">Transaction open</span>
      <span className="tx-chip-time mono">{elapsed}</span>
      <button className="editor-btn tx-chip-btn" onClick={onRollback} disabled={busy}>
        Roll back
      </button>
      <button className="editor-btn primary-write tx-chip-btn" onClick={onCommit} disabled={busy}>
        Commit
      </button>
    </div>
  );
}
