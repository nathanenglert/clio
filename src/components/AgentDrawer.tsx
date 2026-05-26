import type { ActivityEvent } from "../lib/api";
import { Splitter } from "./Splitter";
import {
  type AgentTab,
  ComingSoon,
  type ResizeHandle,
  TABS,
} from "./agentShared";
import { Lunate, RecordMeta } from "./brand";
import { StreamView } from "./AgentStreamView";
import { HistoryView } from "./AgentHistoryView";

type Props = {
  events: ActivityEvent[];
  recentQueries: ActivityEvent[];
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

export function AgentDrawer({
  events,
  recentQueries,
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
}: Props) {
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
        <Lunate size={14} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>Today&apos;s record</span>
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
        <RecordMeta
          sessionStart={sessionStart}
          entryCount={events.length}
          prefix={null}
        />
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
      ) : tab === "History" ? (
        <HistoryView
          queries={recentQueries}
          now={now}
          onOpenSql={onOpenSql}
          onRerunSql={onRerunSql}
        />
      ) : (
        <ComingSoon label={tab} />
      )}
    </div>
  );
}
