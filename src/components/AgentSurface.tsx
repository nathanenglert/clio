import { useEffect, useMemo, useState } from "react";
import type { ActivityEvent } from "../lib/api";
import { useResizable } from "../lib/useResizable";
import { type AgentTab, findLastByTool, parseDescribe } from "./agentShared";
import { AgentStrip, type AgentStatus, ACTIVE_WINDOW_MS } from "./AgentStrip";
import { AgentDrawer } from "./AgentDrawer";

export function AgentSurface({
  events,
  recentQueries,
  onOpenSql,
  onRerunSql,
  awaiting = false,
  mcpConnected = false,
  sessionStart,
}: {
  events: ActivityEvent[];
  recentQueries: ActivityEvent[];
  onOpenSql?: (sql: string) => void;
  onRerunSql?: (sql: string) => void;
  /** True when there's a pending permission request — turns the strip red
   *  and shows "Agent is waiting on you". */
  awaiting?: boolean;
  /** True while at least one MCP client is connected on the activity socket.
   *  When false, the strip shows "No agent connected" regardless of the
   *  event stream. */
  mcpConnected?: boolean;
  /** Session start (Date.now). Shared with the status bar so both chrome
   *  surfaces tick off the same clock. */
  sessionStart: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<AgentTab>("Stream");
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

  // Awaiting trumps disconnected (a pending verdict is still pending even if
  // the MCP died) — order matters here.
  const status: AgentStatus = awaiting
    ? "awaiting"
    : !mcpConnected
      ? "disconnected"
      : lastEvent && now - lastEvent.ts_ms < ACTIVE_WINDOW_MS
        ? "active"
        : "idle";

  return expanded ? (
    <AgentDrawer
      events={events}
      recentQueries={recentQueries}
      tab={tab}
      onTab={setTab}
      onCollapse={() => setExpanded(false)}
      sessionStart={sessionStart}
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
      status={status}
      lastEvent={lastEvent}
      focusedTable={focusedTable}
      now={now}
      onExpand={() => setExpanded(true)}
    />
  );
}
