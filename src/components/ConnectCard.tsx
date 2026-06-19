import { useEffect } from "react";
import type { ConnectRequest } from "../lib/api";

type Props = {
  request: ConnectRequest;
  /** Display name of the requesting agent, resolved from the presence roster. */
  agentLabel?: string;
  onResolve: (approve: boolean) => void;
};

/// Connect-approval card. An agent cannot open a database connection — it asks,
/// and the human approves here (only then does the workbench open the pool).
/// Sits where the permission card does, above the agent strip. Keyboard: ⏎
/// approve, Esc decline. Themed in the agent color (the agent is asking).
export function ConnectCard({ request, agentLabel, onResolve }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if (e.key === "Enter" && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        onResolve(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onResolve(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onResolve]);

  const agent = "var(--agent)";

  return (
    <div
      className="permission-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="connect-card-title"
      style={{
        background: "var(--bg-panel)",
        borderTop: `1px solid ${agent}`,
        borderLeft: `3px solid ${agent}`,
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
        id="connect-card-title"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span aria-hidden style={{ color: agent, fontSize: 13, lineHeight: 1 }}>
          ◆
        </span>
        <span
          style={{
            color: agent,
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          Connection request
        </span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--text-muted)", fontSize: 11 }}>
          {agentLabel ?? "Agent"}
        </span>
      </div>

      {/* ── Body ─────────────────────────────────────────────── */}
      <div className="serif" style={{ fontSize: 14, lineHeight: 1.45, color: "var(--text-primary)" }}>
        <span style={{ color: "var(--text-secondary)" }}>{agentLabel ?? "An agent"}</span>{" "}
        wants to open a connection to{" "}
        <span className="mono" style={{ color: "var(--text-primary)" }}>{request.connection}</span>.
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
        Agents can't connect to a database on their own — you initiate every
        connection. Approving opens it in the workbench; the agent then works
        only against this connection until you disconnect.
      </div>

      {/* ── Action row ──────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
        <button
          onClick={() => onResolve(true)}
          style={{
            height: 32,
            padding: "0 14px",
            borderRadius: "var(--r-sm)",
            border: 0,
            background: agent,
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
          Connect <kbd className="kbd kbd-dark">⏎</kbd>
        </button>
        <button
          onClick={() => onResolve(false)}
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
          Decline <kbd className="kbd">Esc</kbd>
        </button>
      </div>
    </div>
  );
}
