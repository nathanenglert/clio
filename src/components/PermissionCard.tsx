import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionRequest, PermissionVerdict } from "../lib/api";

type Mode = "view" | "modify";

type Props = {
  request: PermissionRequest;
  onResolve: (verdict: PermissionVerdict) => void;
};

/// Inline permission card per design/screenshots/29-permission-single.png.
///
/// Surfaces a single statement awaiting human approval. The card lives at
/// the bottom of the workspace (above the AgentStrip) until the user picks
/// Allow / Deny / Modify. Keyboard: ⏎ allow, Esc deny, ⌘E modify.
export function PermissionCard({ request, onResolve }: Props) {
  const [mode, setMode] = useState<Mode>("view");
  const [modifiedSql, setModifiedSql] = useState(request.sql);
  const modifyRef = useRef<HTMLTextAreaElement | null>(null);

  const op = opColor(request.op_kind);
  const opLabel = opKindLabel(request.op_kind);
  // Outside-policy banner: any rule that isn't a plain Allow is "outside
  // policy" for the destruct path; for now we always show the deviation
  // banner since reaching this card means the policy returned Prompt.
  const deviation = request.reason;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept while the SQL textarea is focused — the user may
      // be inside their edit.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inEditor = tag === "textarea" || tag === "input";

      if (mode === "modify" && e.key === "Escape") {
        e.preventDefault();
        setMode("view");
        return;
      }

      if (inEditor) return;

      if (e.key === "Enter" && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        onResolve({ kind: "allow" });
      } else if (e.key === "Escape") {
        e.preventDefault();
        onResolve({ kind: "deny" });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setMode("modify");
        requestAnimationFrame(() => modifyRef.current?.focus());
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [mode, onResolve]);

  const sqlPreview = useMemo(() => request.sql.trim(), [request.sql]);

  return (
    <div
      className="permission-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="perm-card-title"
      style={{
        background: "var(--bg-panel)",
        borderTop: `1px solid ${op}`,
        borderLeft: `3px solid ${op}`,
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
      <div
        id="perm-card-title"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span aria-hidden style={{ color: op, fontSize: 14, lineHeight: 1 }}>
          ▲
        </span>
        <span
          style={{
            color: op,
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          Permission required · {opLabel}
        </span>
        <div style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ color: "var(--text-muted)", fontSize: 11 }}
        >
          1/1
        </span>
      </div>

      {/* ── Deviation banner ────────────────────────────────── */}
      {deviation && (
        <div
          style={{
            background: "rgba(217, 108, 84, 0.08)",
            border: "1px dashed rgba(217, 108, 84, 0.35)",
            borderRadius: "var(--r-sm)",
            padding: "6px 8px",
            fontSize: 11,
            color: "var(--text-secondary)",
            lineHeight: 1.4,
          }}
        >
          Outside policy. {deviation}
        </div>
      )}

      {/* ── Intent (the agent's natural-language reason) ────── */}
      {request.intent && (
        <div
          className="serif"
          style={{ fontSize: 14, lineHeight: 1.4, color: "var(--text-primary)" }}
        >
          {request.intent}
        </div>
      )}

      {/* ── SQL preview ─────────────────────────────────────── */}
      {mode === "view" ? (
        <pre
          className="mono"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--line-soft)",
            borderRadius: "var(--r-sm)",
            padding: "8px 10px",
            margin: 0,
            fontSize: 12,
            color: "var(--text-primary)",
            maxHeight: 140,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {sqlPreview}
        </pre>
      ) : (
        <textarea
          ref={modifyRef}
          value={modifiedSql}
          onChange={(e) => setModifiedSql(e.target.value)}
          className="mono"
          style={{
            background: "var(--bg-input)",
            border: `1px solid ${op}`,
            borderRadius: "var(--r-sm)",
            padding: "8px 10px",
            margin: 0,
            fontSize: 12,
            color: "var(--text-primary)",
            minHeight: 120,
            maxHeight: 220,
            outline: "none",
            resize: "vertical",
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "var(--font-mono)",
          }}
        />
      )}

      {/* ── Impact estimate ─────────────────────────────────── */}
      {typeof request.row_estimate === "number" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text-secondary)",
            fontSize: 11,
          }}
        >
          <span aria-hidden style={{ color: "var(--op-destruct)" }}>
            ⚠
          </span>
          Estimated impact: ~{request.row_estimate.toLocaleString()} rows
        </div>
      )}

      {/* ── Action row ──────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 2,
        }}
      >
        {mode === "view" ? (
          <>
            <button
              onClick={() => onResolve({ kind: "allow" })}
              style={{
                height: 32,
                padding: "0 14px",
                borderRadius: "var(--r-sm)",
                border: 0,
                background: op,
                color: "#1a1714",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-ui)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              Allow this one time <kbd className="kbd kbd-dark">⏎</kbd>
            </button>
            <button
              onClick={() => onResolve({ kind: "deny" })}
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
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              Deny <kbd className="kbd">Esc</kbd>
            </button>
            <button
              onClick={() => {
                setMode("modify");
                requestAnimationFrame(() => modifyRef.current?.focus());
              }}
              style={{
                height: 32,
                padding: "0 12px",
                borderRadius: "var(--r-sm)",
                background: "transparent",
                border: "1px solid var(--line-soft)",
                color: "var(--text-secondary)",
                fontFamily: "var(--font-ui)",
                fontSize: 12,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              Modify <kbd className="kbd">⌘E</kbd>
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                onResolve({ kind: "modified", sql: modifiedSql });
              }}
              disabled={modifiedSql.trim().length === 0}
              style={{
                height: 32,
                padding: "0 14px",
                borderRadius: "var(--r-sm)",
                border: 0,
                background: op,
                color: "#1a1714",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-ui)",
                cursor: "pointer",
                opacity: modifiedSql.trim().length === 0 ? 0.5 : 1,
              }}
            >
              Run modified
            </button>
            <button
              onClick={() => {
                setMode("view");
                setModifiedSql(request.sql);
              }}
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
              Cancel edit
            </button>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Edit the SQL above, then run.
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ color: "var(--text-muted)", fontSize: 10 }}
        >
          policy: {request.rule_label || "(no rule)"}
        </span>
      </div>
    </div>
  );
}

function opColor(opKind: string): string {
  switch (opKind) {
    case "destruct":
      return "var(--op-destruct)";
    case "write":
      return "var(--op-write)";
    case "ddl":
      return "var(--op-ddl)";
    case "read":
    default:
      return "var(--op-read)";
  }
}

function opKindLabel(opKind: string): string {
  switch (opKind) {
    case "destruct":
      return "DESTRUCTIVE";
    case "write":
      return "WRITE";
    case "ddl":
      return "SCHEMA CHANGE";
    case "read":
      return "READ";
    default:
      return opKind.toUpperCase();
  }
}
