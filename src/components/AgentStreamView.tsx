import { useMemo, useState } from "react";
import type { ActivityEvent } from "../lib/api";
import { useCopyFeedback } from "../lib/useCopyFeedback";
import {
  AgentDot,
  fmtMonoTime,
  fmtRelative,
  focusActionStyle,
} from "./agentShared";

type StreamViewProps = {
  events: ActivityEvent[];
  now: number;
  lastQuery: ActivityEvent | null;
  focusedTable: string | null;
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
};

export function StreamView({
  events,
  now,
  lastQuery,
  focusedTable,
  onOpenSql,
  onRerunSql,
}: StreamViewProps) {
  const reversed = useMemo(() => events.slice().reverse(), [events]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <FocusPane
        lastQuery={lastQuery}
        focusedTable={focusedTable}
        now={now}
        onOpenSql={onOpenSql}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
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
          <span>Stream</span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              textTransform: "none",
              letterSpacing: 0,
              fontFamily: "var(--font-mono)",
            }}
          >
            live · {events.length} event{events.length === 1 ? "" : "s"}
          </span>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--agent)",
              boxShadow: "0 0 6px var(--agent)",
            }}
          />
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
              no agent activity yet — point an MCP client at this app to see what it's doing
            </div>
          ) : (
            reversed.map((e, i) => (
              <StreamRow
                key={e.id}
                event={e}
                last={i === reversed.length - 1}
                expanded={e.id === expandedId}
                onToggle={() =>
                  setExpandedId((curr) => (curr === e.id ? null : e.id))
                }
                onOpenSql={onOpenSql}
                onRerunSql={onRerunSql}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FocusPane({
  lastQuery,
  focusedTable,
  now,
  onOpenSql,
}: {
  lastQuery: ActivityEvent | null;
  focusedTable: string | null;
  now: number;
  onOpenSql?: (sql: string) => void;
}) {
  const querySql = lastQuery?.payload ?? lastQuery?.detail ?? null;
  const { copied, markCopied } = useCopyFeedback();
  const onCopy = () => {
    if (!querySql) return;
    void navigator.clipboard.writeText(querySql).then(markCopied);
  };
  return (
    <div
      style={{
        width: 340,
        flex: "0 0 auto",
        borderRight: "1px solid var(--line-soft)",
        display: "flex",
        flexDirection: "column",
        background: "var(--agent-wash)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 14px 12px",
          borderBottom: "1px solid var(--agent-line)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <AgentDot pulse />
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>focused on</span>
        </div>
        {focusedTable ? (
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text-primary)",
              marginBottom: 4,
              fontFamily: "var(--font-serif)",
              letterSpacing: "-0.01em",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)" }}>{focusedTable}</span>
          </div>
        ) : (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              fontFamily: "var(--font-serif)",
              marginBottom: 4,
            }}
          >
            no table inspected yet
          </div>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          {focusedTable
            ? "Most recent describe_table call."
            : "Run describe_table to set focus."}
        </div>
      </div>

      <div
        style={{
          padding: "10px 14px 12px",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              fontWeight: 600,
            }}
          >
            Last query
          </span>
          {querySql && (
            <>
              <span style={{ flex: 1 }} />
              <button
                onClick={onCopy}
                title="Copy SQL"
                style={focusActionStyle}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              {onOpenSql && (
                <button
                  onClick={() => onOpenSql(querySql)}
                  title="Replace editor contents with this SQL"
                  style={focusActionStyle}
                >
                  Open in editor
                </button>
              )}
            </>
          )}
        </div>
        {lastQuery && querySql ? (
          <>
            <div
              style={{
                padding: "8px 10px",
                background: "var(--bg-input)",
                border: "1px solid var(--line-default)",
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--text-primary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                flex: 1,
                minHeight: 0,
                overflow: "auto",
              }}
            >
              {querySql}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 10.5,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {fmtRelative(lastQuery.ts_ms, now)} · {lastQuery.duration_ms}ms
              {lastQuery.status === "error" && (
                <span style={{ color: "var(--op-destruct)" }}> · error</span>
              )}
            </div>
          </>
        ) : (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            no queries yet
          </div>
        )}
      </div>
    </div>
  );
}

function StreamRow({
  event,
  last,
  expanded,
  onToggle,
  onOpenSql,
  onRerunSql,
}: {
  event: ActivityEvent;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
}) {
  const isQuery = event.tool === "run_query";
  const sql = event.payload ?? null;
  const expandable = !!sql;
  // POC is SELECT-only, so all events render with op-read tint
  const opColor = "var(--op-read)";

  const { copied, markCopied } = useCopyFeedback();

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sql) return;
    void navigator.clipboard.writeText(sql).then(markCopied);
  };
  const onOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (sql && onOpenSql) onOpenSql(sql);
  };
  const onRerun = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (sql && onRerunSql) onRerunSql(sql);
  };

  return (
    <div
      onClick={expandable ? onToggle : undefined}
      style={{
        padding: "6px 14px",
        borderBottom: last ? "none" : "1px solid var(--line-faint)",
        cursor: expandable ? "pointer" : "default",
        background: expanded ? "var(--bg-elevated)" : "transparent",
      }}
    >
      <div style={{ display: "flex", gap: 10 }}>
        <div
          style={{
            width: 12,
            flex: "0 0 auto",
            display: "flex",
            justifyContent: "center",
            paddingTop: 6,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: opColor,
              display: "inline-block",
            }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginBottom: 3,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 500,
                color: "var(--agent)",
                letterSpacing: "0.02em",
              }}
            >
              {event.tool}
            </span>
            {expandable && (
              <span
                aria-hidden
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--text-faint)",
                  transition: "transform 120ms ease",
                  display: "inline-block",
                  transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                }}
              >
                ›
              </span>
            )}
            <span
              style={{
                fontSize: 10,
                color: "var(--text-faint)",
                fontFamily: "var(--font-mono)",
                marginLeft: "auto",
              }}
            >
              {fmtMonoTime(event.ts_ms)}
            </span>
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-secondary)",
              lineHeight: 1.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={event.detail || undefined}
          >
            {event.detail || (isQuery ? "(empty query)" : "—")}
          </div>
          <div
            style={{
              marginTop: 3,
              display: "flex",
              gap: 10,
              fontSize: 10,
              color: "var(--text-muted)",
              alignItems: "center",
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>{event.duration_ms}ms</span>
            {event.status === "error" && (
              <span style={{ color: "var(--op-destruct)" }}>error</span>
            )}
          </div>
        </div>
      </div>

      {expanded && sql && (
        <div
          onClick={stop}
          style={{
            marginTop: 8,
            marginLeft: 22,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            cursor: "default",
          }}
        >
          <div
            style={{
              padding: "8px 10px",
              background: "var(--bg-input)",
              border: "1px solid var(--line-default)",
              borderRadius: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-primary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 180,
              overflow: "auto",
            }}
          >
            {sql}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onCopy} style={focusActionStyle} title="Copy SQL">
              {copied ? "Copied" : "Copy"}
            </button>
            {onOpenSql && (
              <button
                onClick={onOpen}
                style={focusActionStyle}
                title="Replace editor contents with this SQL"
              >
                Open in editor
              </button>
            )}
            {onRerunSql && (
              <button
                onClick={onRerun}
                style={{
                  ...focusActionStyle,
                  borderColor: "var(--agent-line)",
                  color: "var(--agent)",
                }}
                title="Load into editor and run"
              >
                Re-run
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
