import { useEffect, useState } from "react";
import { api, type PolicyRule, type PatternPart } from "../lib/api";
import { Modal } from "./Modal";

type Props = {
  connection: string | null;
  onClose: () => void;
};

/// Read-only policy viewer per design/screenshots/28-policy.png. Lists the
/// rules surfaced by execute_statement / execute_migration with their op
/// kinds, target patterns, row caps, and verdict pills. Phase 5 ships the
/// viewer; in-place edit + per-connection persistence land in a follow-up.
export function PolicyModal({ connection, onClose }: Props) {
  const [rules, setRules] = useState<PolicyRule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .list_policy_rules(connection)
      .then((rs) => {
        if (!cancelled) setRules(rs);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return (
    <Modal
      onClose={onClose}
      className="modal"
      style={{
        width: 720,
        maxHeight: "78vh",
        padding: "16px 18px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="serif" style={{ fontSize: 18, color: "var(--text-primary)" }}>
          Policy
        </div>
        <span
          className="mono"
          style={{ color: "var(--text-muted)", fontSize: 11 }}
        >
          {connection ? connection : "global default"}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>
        First match wins. Statements that don&apos;t match any rule fall through
        to <span className="mono">prompt</span>.
      </div>

      {err && (
        <div style={{ color: "var(--op-destruct)", fontSize: 12 }}>
          Couldn&apos;t load rules: {err}
        </div>
      )}

      {rules && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            overflowY: "auto",
            padding: "2px 2px 4px",
          }}
        >
          {rules.map((r, i) => (
            <RuleRow key={i} index={i} rule={r} />
          ))}
        </div>
      )}

      <div
        style={{
          borderTop: "1px solid var(--line-soft)",
          paddingTop: 8,
          fontSize: 10,
          color: "var(--text-muted)",
        }}
      >
        Editing policy + per-connection overrides land in a follow-up phase.
        For now this is the default ruleset baked into the workbench.
      </div>
    </Modal>
  );
}

function RuleRow({ index, rule }: { index: number; rule: PolicyRule }) {
  const verdictColor =
    rule.verdict === "block"
      ? "var(--op-destruct)"
      : rule.verdict === "prompt"
      ? "var(--op-write)"
      : "var(--op-read)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "26px 1fr auto",
        gap: 8,
        padding: "8px 10px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--line-soft)",
        borderRadius: "var(--r-sm)",
        alignItems: "start",
      }}
    >
      <span
        className="mono"
        style={{ color: "var(--text-muted)", fontSize: 11, paddingTop: 2 }}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div
          className="mono"
          style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.4 }}
        >
          {rule.stmt_kinds.length === 0 ? "*" : rule.stmt_kinds.join(", ")}
          {" on "}
          {patternStr(rule.target.schema)}.{patternStr(rule.target.name)}
          {rule.max_rows !== null && (
            <span style={{ color: "var(--text-secondary)" }}>
              {" "}· ≤{rule.max_rows.toLocaleString()} rows
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          {rule.label}
        </div>
      </div>
      <span
        className="mono"
        style={{
          color: verdictColor,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          padding: "3px 8px",
          border: `1px solid ${verdictColor}`,
          borderRadius: 999,
          alignSelf: "center",
        }}
      >
        {rule.verdict}
      </span>
    </div>
  );
}

function patternStr(p: PatternPart): string {
  if (p === "any") return "*";
  return p.exact;
}
