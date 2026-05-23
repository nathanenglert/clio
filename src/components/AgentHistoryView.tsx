import { useMemo } from "react";
import type { ActivityEvent } from "../lib/api";
import { useCopyFeedback } from "../lib/useCopyFeedback";
import { fmtRelative, focusActionStyle } from "./agentShared";

type HistoryViewProps = {
  queries: ActivityEvent[];
  now: number;
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
};

export function HistoryView({ queries, now, onOpenSql, onRerunSql }: HistoryViewProps) {
  const reversed = useMemo(() => queries.slice().reverse(), [queries]);
  const youCount = queries.filter((q) => q.source === "ui").length;
  const agentCount = queries.length - youCount;
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontWeight: 600,
          borderBottom: "1px solid var(--line-faint)",
        }}
      >
        <span>Recent queries</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            textTransform: "none",
            letterSpacing: 0,
            fontFamily: "var(--font-mono)",
          }}
        >
          {youCount} you · {agentCount} agent
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {reversed.length === 0 ? (
          <div
            style={{
              padding: 24,
              fontSize: 12,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            no queries yet — run one in the editor or connect an MCP client
          </div>
        ) : (
          reversed.map((e, i) => (
            <HistoryRow
              key={e.id}
              event={e}
              last={i === reversed.length - 1}
              now={now}
              onOpenSql={onOpenSql}
              onRerunSql={onRerunSql}
            />
          ))
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  event,
  last,
  now,
  onOpenSql,
  onRerunSql,
}: {
  event: ActivityEvent;
  last: boolean;
  now: number;
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
}) {
  const sql = event.payload ?? event.detail ?? null;
  const isAgent = event.source === "mcp";
  const { copied, markCopied } = useCopyFeedback();

  const onCopy = () => {
    if (!sql) return;
    void navigator.clipboard.writeText(sql).then(markCopied);
  };

  return (
    <div
      style={{
        padding: "8px 14px",
        borderBottom: last ? "none" : "1px solid var(--line-faint)",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <span
        title={isAgent ? "Run by the agent" : "Run by you"}
        style={{
          flex: "0 0 auto",
          marginTop: 1,
          padding: "1px 6px",
          borderRadius: 3,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.02em",
          color: isAgent ? "var(--agent)" : "var(--text-muted)",
          background: isAgent ? "var(--agent-wash)" : "var(--bg-elevated)",
          border: isAgent
            ? "1px solid var(--agent-line)"
            : "1px solid var(--line-soft)",
        }}
      >
        {isAgent ? "agent" : "you"}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-primary)",
            lineHeight: 1.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={sql || undefined}
        >
          {sql || "(empty query)"}
        </div>
        <div
          style={{
            marginTop: 3,
            display: "flex",
            gap: 10,
            alignItems: "center",
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>{fmtRelative(event.ts_ms, now)}</span>
          <span>{event.duration_ms}ms</span>
          {event.status === "error" && (
            <span style={{ color: "var(--op-destruct)" }}>error</span>
          )}
        </div>
      </div>
      {sql && (
        <div style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
          <button onClick={onCopy} style={focusActionStyle} title="Copy SQL">
            {copied ? "Copied" : "Copy"}
          </button>
          {onOpenSql && (
            <button
              onClick={() => onOpenSql(sql)}
              style={focusActionStyle}
              title="Open in editor"
            >
              Open
            </button>
          )}
          {onRerunSql && (
            <button
              onClick={() => onRerunSql(sql)}
              style={focusActionStyle}
              title="Load into editor and run"
            >
              Re-run
            </button>
          )}
        </div>
      )}
    </div>
  );
}
