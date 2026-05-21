import type { ActivityEvent } from "../lib/api";

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
};

export function ActivityStrip({ events }: { events: ActivityEvent[] }) {
  const recent = events.slice(-12);
  return (
    <div className="strip" role="log" aria-live="polite">
      <span className="strip-label">activity</span>
      <div className="strip-feed">
        {recent.length === 0 && (
          <span style={{ color: "var(--text-faint)" }}>
            no calls yet — point an MCP client at this app or run a query
          </span>
        )}
        {recent.map((e) => (
          <span key={e.id} className="strip-item" title={e.detail}>
            <span className={e.source === "mcp" ? "source-mcp" : "source-ui"}>
              {e.source}
            </span>
            <span>·</span>
            <span style={{ color: "var(--text-primary)" }}>{e.tool}</span>
            <span style={{ color: "var(--text-muted)" }}>
              {e.detail ? `· ${e.detail}` : ""}
            </span>
            <span style={{ color: "var(--text-muted)" }}>
              · {e.duration_ms}ms
            </span>
            {e.status === "error" && (
              <span className="op-destruct">· error</span>
            )}
            <span style={{ color: "var(--text-faint)" }}>
              · {fmtTime(e.ts_ms)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
