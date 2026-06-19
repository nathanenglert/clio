import type { ActivityEvent, AgentInfo } from "../lib/api";
import { Kbd, fmtRelative } from "./agentShared";

export type AgentStatus = "awaiting" | "active" | "idle" | "disconnected";

/** How long after the last event the strip stays in "active" before flipping
 *  to "idle". 60s is forgiving of pauses while the agent thinks between tool
 *  calls without leaving the strip falsely lit for hours. */
export const ACTIVE_WINDOW_MS = 60_000;

type Props = {
  status: AgentStatus;
  agents?: AgentInfo[];
  lastEvent: ActivityEvent | null;
  focusedTable: string | null;
  now: number;
  onExpand: () => void;
};

export function AgentStrip({ status, agents = [], lastEvent, focusedTable, now, onExpand }: Props) {
  const awaiting = status === "awaiting";
  const monoStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
  };

  // Two-tone palette: connected → agent color (filled + pulse for active,
  // hollow for idle); disconnected → muted; awaiting → destructive red.
  const dotColor =
    status === "awaiting"
      ? "var(--op-destruct)"
      : status === "disconnected"
        ? "var(--text-muted)"
        : "var(--agent)";
  const dotFilled = status === "active" || status === "awaiting";
  const dotPulse = status === "active";

  const labelColor =
    status === "awaiting"
      ? "var(--op-destruct)"
      : status === "disconnected"
        ? "var(--text-muted)"
        : "var(--agent)";
  const count = agents.length;
  const names = agents.map((a) => a.label);
  const stateWord = status === "idle" ? "idle" : "active";
  const label =
    status === "awaiting"
      ? "Agent is waiting on you"
      : status === "disconnected" || count === 0
        ? "No agent connected"
        : count === 1
          ? `${names[0]} ${stateWord}`
          : `${count} agents connected`;
  // With more than one agent, the single-focus detail ("looking at X") is
  // ambiguous, so the detail area lists the roster instead.
  const multi = count > 1 && status !== "awaiting";

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
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotFilled ? dotColor : "transparent",
            border: dotFilled ? undefined : `1.5px solid ${dotColor}`,
            boxShadow: dotPulse ? `0 0 6px ${dotColor}` : undefined,
            flex: "0 0 auto",
            boxSizing: "border-box",
          }}
        />
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
      <span style={{ color: labelColor, fontWeight: 500 }}>{label}</span>
      {status !== "disconnected" && (
        <>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span style={{ color: "var(--text-secondary)" }}>
            {multi ? (
              <span style={monoStyle}>{names.join(" · ")}</span>
            ) : awaiting ? (
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
            ) : (
              <>no calls yet</>
            )}
          </span>
        </>
      )}
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
