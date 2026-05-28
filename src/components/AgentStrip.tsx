import type { ActivityEvent } from "../lib/api";
import { AgentDot, Kbd, fmtRelative } from "./agentShared";

type Props = {
  awaiting: boolean;
  /** Recent MCP activity (within the active window). Drives the pulsing dot
   *  and the "Agent active" headline. */
  active: boolean;
  /** Any MCP activity ever seen this session — distinguishes "no agent has
   *  ever called us" from "agent went idle a while ago". */
  everConnected: boolean;
  lastEvent: ActivityEvent | null;
  focusedTable: string | null;
  now: number;
  onExpand: () => void;
};

export function AgentStrip({ awaiting, active, everConnected, lastEvent, focusedTable, now, onExpand }: Props) {
  const monoStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
  };
  // Three resting states + the override:
  //   awaiting        → "Agent is waiting on you" (red)
  //   active          → "Agent active" (pulsing, accent color)
  //   everConnected   → "Agent idle" (calm — agent ran earlier but quieted)
  //   otherwise       → "No agent connected" (faint — no MCP traffic yet)
  const headline = awaiting
    ? "Agent is waiting on you"
    : active
      ? "Agent active"
      : everConnected
        ? "Agent idle"
        : "No agent connected";
  const headlineColor = awaiting
    ? "var(--op-destruct)"
    : active
      ? "var(--agent)"
      : "var(--text-secondary)";
  return (
    <div
      className="agent-surface agent-strip"
      style={{
        height: 36,
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 10,
        background: awaiting ? "rgba(217, 108, 84, 0.10)" : "var(--agent-wash)",
        borderTop: `1px solid ${awaiting ? "var(--op-destruct)" : "var(--agent-line)"}`,
        fontSize: 12,
        color: "var(--text-primary)",
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <AgentDot pulse={awaiting || active} />
        {awaiting && (
          <span
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: "50%",
              border: "1.5px solid var(--op-destruct)",
              opacity: 0.6,
            }}
          />
        )}
      </span>
      <span style={{ color: headlineColor, fontWeight: 500 }}>{headline}</span>
      {(awaiting || active || lastEvent) && (
        <span style={{ color: "var(--text-muted)" }}>·</span>
      )}
      <span style={{ color: "var(--text-secondary)" }}>
        {awaiting ? (
          <>step ?/? · approve a write</>
        ) : focusedTable ? (
          <>
            looking at <span style={monoStyle}>{focusedTable}</span>
            {lastEvent && (
              <>
                {" · last action "}
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {fmtRelative(lastEvent.ts_ms, now)}
                </span>
              </>
            )}
          </>
        ) : lastEvent ? (
          <>
            last action{" "}
            <span style={monoStyle}>{lastEvent.tool}</span>
            {" · "}
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {fmtRelative(lastEvent.ts_ms, now)}
            </span>
          </>
        ) : null}
      </span>
      <div style={{ flex: 1 }} />
      {awaiting && (
        <button
          style={{
            height: 22,
            padding: "0 12px",
            borderRadius: 5,
            border: 0,
            background: "var(--op-destruct)",
            color: "#1a1714",
            fontSize: 11,
            fontWeight: 500,
            fontFamily: "var(--font-ui)",
            cursor: "pointer",
          }}
        >
          Review →
        </button>
      )}
      <button
        onClick={onExpand}
        style={{
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px",
          borderRadius: 4,
          background: "transparent",
          border: "1px solid var(--line-soft)",
          color: "var(--text-secondary)",
          fontFamily: "var(--font-ui)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        Expand <Kbd>⌘\</Kbd>
      </button>
    </div>
  );
}
