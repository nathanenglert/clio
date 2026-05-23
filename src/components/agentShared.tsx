import type { ActivityEvent } from "../lib/api";

export type AgentTab = "Stream" | "History" | "Focus" | "Session" | "Policy";

// "History" is our v0.1 home for user-initiated query history (the design's
// "Recent queries" lives in the command palette long-term — until that ships,
// this tab is the home). Stream is mcp-only by design.
export const TABS: AgentTab[] = ["Stream", "History", "Focus", "Session", "Policy"];

export const fmtMonoTime = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
};

export const fmtElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

export const fmtRelative = (ms: number, now: number) => {
  const diff = Math.max(0, Math.floor((now - ms) / 1000));
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
};

// describe_table emits detail as "<conn>/<schema>.<table>"
export function parseDescribe(detail: string): { schema: string; table: string } | null {
  const slash = detail.indexOf("/");
  if (slash < 0) return null;
  const rest = detail.slice(slash + 1);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  return { schema: rest.slice(0, dot), table: rest.slice(dot + 1) };
}

export function findLastByTool(events: ActivityEvent[], tool: string): ActivityEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].tool === tool) return events[i];
  }
  return null;
}

export const AgentDot = ({ pulse }: { pulse?: boolean }) => (
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

export const Kbd = ({ children }: { children: React.ReactNode }) => (
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

export const focusActionStyle: React.CSSProperties = {
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

export function ComingSoon({ label }: { label: string }) {
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

export type ResizeHandle = {
  dragging: boolean;
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
  };
};
