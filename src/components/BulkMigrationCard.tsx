import { useMemo, useState } from "react";
import type { MigrationRequest, MigrationVerdict } from "../lib/api";

type Props = {
  request: MigrationRequest;
  onResolve: (verdict: MigrationVerdict) => void;
};

/// Bulk-migration permission card per design/screenshots/30. Lists every
/// statement with its policy verdict, lets the user approve the batch
/// (with a transaction toggle) or reject outright. Deviations are
/// highlighted; if any statement is BLOCKED outright, the approve button
/// is disabled.
export function BulkMigrationCard({ request, onResolve }: Props) {
  const [wrapInTx, setWrapInTx] = useState(true);

  const counts = useMemo(() => {
    let allow = 0;
    let prompt = 0;
    let block = 0;
    for (const s of request.statements) {
      if (s.verdict === "allow") allow++;
      else if (s.verdict === "prompt") prompt++;
      else if (s.verdict === "block") block++;
    }
    return { allow, prompt, block };
  }, [request.statements]);

  const totalTables = useMemo(() => {
    const set = new Set<string>();
    for (const s of request.statements) {
      for (const t of s.targets) {
        set.add(`${t.schema ?? "?"}.${t.name}`);
      }
    }
    return set.size;
  }, [request.statements]);

  const hasBlock = counts.block > 0;

  return (
    <div
      className="permission-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="bulk-card-title"
      style={{
        background: "var(--bg-panel)",
        borderTop: `1px solid ${hasBlock ? "var(--op-destruct)" : "var(--op-write)"}`,
        borderLeft: `3px solid ${hasBlock ? "var(--op-destruct)" : "var(--op-write)"}`,
        boxShadow:
          "0 -12px 24px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--line-soft)",
        padding: "12px 16px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontSize: "var(--fs-sm)",
        color: "var(--text-primary)",
      }}
    >
      {/* ── Header ───────────────────────────────────────────── */}
      <div id="bulk-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ color: "var(--op-write)", fontSize: 14 }}>
          ▲
        </span>
        <span
          style={{
            color: hasBlock ? "var(--op-destruct)" : "var(--op-write)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          Migration · {request.statements.length} statement
          {request.statements.length === 1 ? "" : "s"} · {totalTables} table
          {totalTables === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--text-muted)", fontSize: 11 }}>
          {counts.allow}A · {counts.prompt}P{counts.block > 0 && ` · ${counts.block}B`}
        </span>
      </div>

      {/* ── Intent ──────────────────────────────────────────── */}
      {request.intent && (
        <div
          className="serif"
          style={{ fontSize: 14, lineHeight: 1.4, color: "var(--text-primary)" }}
        >
          {request.intent}
        </div>
      )}

      {/* ── Statement list ──────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: 240,
          overflowY: "auto",
          border: "1px solid var(--line-soft)",
          borderRadius: "var(--r-sm)",
          background: "var(--bg-input)",
          padding: "6px 8px",
        }}
      >
        {request.statements.map((s) => (
          <StatementRow key={s.index} stmt={s} />
        ))}
      </div>

      {/* ── Footer + actions ────────────────────────────────── */}
      {hasBlock ? (
        <div style={{ color: "var(--op-destruct)", fontSize: 11 }}>
          {counts.block} blocked by policy. Migration cannot proceed.
        </div>
      ) : counts.prompt > 0 ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
          {counts.prompt} statement{counts.prompt === 1 ? "" : "s"} deviate from
          policy. The agent will pause and ask again before each one.
        </div>
      ) : (
        <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
          All statements in policy.
        </div>
      )}

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: "var(--text-secondary)",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={wrapInTx}
          onChange={(e) => setWrapInTx(e.target.checked)}
        />
        Wrap entire migration in a transaction · roll back on any denial
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          disabled={hasBlock}
          onClick={() =>
            onResolve({
              kind: "approve_and_prompt",
              wrap_in_transaction: wrapInTx,
            })
          }
          style={{
            height: 32,
            padding: "0 14px",
            borderRadius: "var(--r-sm)",
            border: 0,
            background: hasBlock ? "var(--bg-elevated)" : "var(--op-write)",
            color: hasBlock ? "var(--text-muted)" : "#1a1714",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "var(--font-ui)",
            cursor: hasBlock ? "not-allowed" : "pointer",
            opacity: hasBlock ? 0.6 : 1,
          }}
        >
          Approve {counts.allow} of {request.statements.length}
          {counts.prompt > 0 && `, prompt for the rest`}
        </button>
        <button
          onClick={() => onResolve({ kind: "reject" })}
          style={{
            height: 32,
            padding: "0 12px",
            borderRadius: "var(--r-sm)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--line-default)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Reject all
        </button>
        <div style={{ flex: 1 }} />
      </div>
    </div>
  );
}

function StatementRow({ stmt }: { stmt: import("../lib/api").MigrationStatement }) {
  const isDeviation = stmt.verdict !== "allow";
  const verdictColor =
    stmt.verdict === "block"
      ? "var(--op-destruct)"
      : stmt.verdict === "prompt"
      ? "var(--op-write)"
      : "var(--op-read)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "4px 6px",
        borderRadius: 3,
        background: isDeviation ? "rgba(217, 108, 84, 0.06)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="mono"
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            width: 24,
            display: "inline-block",
          }}
        >
          {String(stmt.index + 1).padStart(2, "0")}
        </span>
        <span
          className="mono"
          style={{
            color: "var(--text-primary)",
            fontSize: 11,
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={stmt.sql}
        >
          {stmt.sql.replace(/\s+/g, " ").trim()}
        </span>
        <span
          className="mono"
          style={{
            color: verdictColor,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          {stmt.verdict}
        </span>
      </div>
      {isDeviation && stmt.reason && (
        <div
          style={{
            paddingLeft: 32,
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1.3,
          }}
        >
          {stmt.reason}
        </div>
      )}
    </div>
  );
}
