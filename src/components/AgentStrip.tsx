import type { ActivityEvent } from "../lib/api";
import { AgentDot, Kbd, fmtRelative } from "./agentShared";

type Props = {
  awaiting: boolean;
  lastEvent: ActivityEvent | null;
  focusedTable: string | null;
  now: number;
  onExpand: () => void;
};

export function AgentStrip({ awaiting, lastEvent, focusedTable, now, onExpand }: Props) {
  const monoStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
  };
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
        <AgentDot pulse />
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
      <span
        style={{
          color: awaiting ? "var(--op-destruct)" : "var(--agent)",
          fontWeight: 500,
        }}
      >
        {awaiting ? "Agent is waiting on you" : "Agent active"}
      </span>
      <span style={{ color: "var(--text-muted)" }}>·</span>
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
        ) : (
          <>idle · no calls yet</>
        )}
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
