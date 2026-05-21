import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent } from "../lib/api";
import { Splitter } from "./Splitter";
import { useResizable } from "../lib/useResizable";

type AgentTab = "Stream" | "Focus" | "Session" | "Policy";
const TABS: AgentTab[] = ["Stream", "Focus", "Session", "Policy"];

const fmtMonoTime = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
};

const fmtElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

const fmtRelative = (ms: number, now: number) => {
  const diff = Math.max(0, Math.floor((now - ms) / 1000));
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
};

// describe_table emits detail as "<conn>/<schema>.<table>"
function parseDescribe(detail: string): { schema: string; table: string } | null {
  const slash = detail.indexOf("/");
  if (slash < 0) return null;
  const rest = detail.slice(slash + 1);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  return { schema: rest.slice(0, dot), table: rest.slice(dot + 1) };
}

function findLastByTool(events: ActivityEvent[], tool: string): ActivityEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].tool === tool) return events[i];
  }
  return null;
}

const AgentDot = ({ pulse }: { pulse?: boolean }) => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: "var(--agent)",
      boxShadow: pulse ? "0 0 6px var(--agent)" : undefined,
      flex: "0 0 auto",
    }}
  />
);

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "0 5px",
      height: 16,
      borderRadius: 3,
      border: "1px solid var(--line-default)",
      background: "var(--bg-elevated)",
      color: "var(--text-secondary)",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      lineHeight: 1,
    }}
  >
    {children}
  </span>
);

type StripProps = {
  awaiting: boolean;
  lastEvent: ActivityEvent | null;
  focusedTable: string | null;
  now: number;
  onExpand: () => void;
};

function AgentStrip({ awaiting, lastEvent, focusedTable, now, onExpand }: StripProps) {
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

type ResizeHandle = {
  dragging: boolean;
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
  };
};

type DrawerProps = {
  events: ActivityEvent[];
  tab: AgentTab;
  onTab: (t: AgentTab) => void;
  onCollapse: () => void;
  sessionStart: number;
  now: number;
  lastQuery: ActivityEvent | null;
  focusedTable: string | null;
  height: number;
  resize: ResizeHandle;
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
};

function AgentDrawer({
  events,
  tab,
  onTab,
  onCollapse,
  sessionStart,
  now,
  lastQuery,
  focusedTable,
  height,
  resize,
  onOpenSql,
  onRerunSql,
}: DrawerProps) {
  return (
    <div
      className="agent-surface agent-drawer"
      style={{
        height,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--agent-line)",
        position: "relative",
        overflow: "visible",
      }}
    >
      <Splitter
        orientation="horizontal"
        dragging={resize.dragging}
        title="Drag to resize · double-click to reset"
        style={{
          position: "absolute",
          top: -3,
          left: 0,
          right: 0,
          height: 6,
        }}
        {...resize.handleProps}
      />
      <div
        style={{
          height: 32,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 10,
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <AgentDot pulse />
        <span style={{ fontSize: 12, fontWeight: 500 }}>Agent activity</span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          · session {fmtElapsed(now - sessionStart)}
        </span>
        <div style={{ marginLeft: 16, display: "flex", gap: 2 }}>
          {TABS.map((t) => {
            const active = t === tab;
            return (
              <button
                key={t}
                onClick={() => onTab(t)}
                style={{
                  height: 22,
                  padding: "0 10px",
                  borderRadius: 4,
                  border: 0,
                  background: active ? "var(--bg-elevated)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-muted)",
                  fontFamily: "var(--font-ui)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button
          aria-label="More"
          title="More"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 4,
            display: "inline-flex",
            alignItems: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ⋯
        </button>
        <button
          aria-label="Close"
          onClick={onCollapse}
          title="Collapse (Esc)"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 4,
            display: "inline-flex",
            alignItems: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          ✕
        </button>
      </div>

      {tab === "Stream" ? (
        <StreamView
          events={events}
          now={now}
          lastQuery={lastQuery}
          focusedTable={focusedTable}
          onOpenSql={onOpenSql}
          onRerunSql={onRerunSql}
        />
      ) : (
        <ComingSoon label={tab} />
      )}
    </div>
  );
}

function StreamView({
  events,
  now,
  lastQuery,
  focusedTable,
  onOpenSql,
  onRerunSql,
}: {
  events: ActivityEvent[];
  now: number;
  lastQuery: ActivityEvent | null;
  focusedTable: string | null;
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
}) {
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
              no calls yet — point an MCP client at this app or run a query
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);
  const onCopy = () => {
    if (!querySql) return;
    void navigator.clipboard.writeText(querySql).then(() => setCopied(true));
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

const focusActionStyle: React.CSSProperties = {
  height: 20,
  padding: "0 8px",
  borderRadius: 4,
  background: "transparent",
  border: "1px solid var(--line-soft)",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-ui)",
  fontSize: 10.5,
  cursor: "pointer",
};

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

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sql) return;
    void navigator.clipboard.writeText(sql).then(() => setCopied(true));
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
            <span>{event.source}</span>
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

function ComingSoon({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
    >
      {label} — coming in v0.2
    </div>
  );
}

export function AgentSurface({
  events,
  onOpenSql,
  onRerunSql,
}: {
  events: ActivityEvent[];
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<AgentTab>("Stream");
  const sessionStartRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  const drawer = useResizable({
    storageKey: "db.layout.agent.height",
    defaultSize: 280,
    min: 160,
    max: 600,
    axis: "y",
    direction: -1,
  });

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "\\") {
        e.preventDefault();
        setExpanded((x) => !x);
      } else if (e.key === "Escape" && expanded) {
        setExpanded(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastDescribe = useMemo(() => findLastByTool(events, "describe_table"), [events]);
  const lastQuery = useMemo(() => findLastByTool(events, "run_query"), [events]);
  const focusedTable = useMemo(() => {
    if (!lastDescribe) return null;
    const parsed = parseDescribe(lastDescribe.detail);
    if (!parsed) return null;
    return `${parsed.schema}.${parsed.table}`;
  }, [lastDescribe]);

  // Awaiting-approval state — POC has no write gating, so this stays false.
  const awaiting = false;

  return expanded ? (
    <AgentDrawer
      events={events}
      tab={tab}
      onTab={setTab}
      onCollapse={() => setExpanded(false)}
      sessionStart={sessionStartRef.current}
      now={now}
      lastQuery={lastQuery}
      focusedTable={focusedTable}
      height={drawer.size}
      resize={{ dragging: drawer.dragging, handleProps: drawer.handleProps }}
      onOpenSql={onOpenSql}
      onRerunSql={onRerunSql}
    />
  ) : (
    <AgentStrip
      awaiting={awaiting}
      lastEvent={lastEvent}
      focusedTable={focusedTable}
      now={now}
      onExpand={() => setExpanded(true)}
    />
  );
}
