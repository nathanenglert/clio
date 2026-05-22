import { useEffect, useRef, useState } from "react";
import type { Connection } from "../lib/api";
import { api } from "../lib/api";

type Props = {
  connections: Connection[];
  activeName: string | null;
  onSelect: (name: string) => void;
  onChanged: () => void;
  onAdd: () => void;
};

const CONFIRM_TIMEOUT_MS = 3000;

export function ConnectionRail(props: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const pendingTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    };
  }, []);

  const connect = async (c: Connection) => {
    setBusy(c.name);
    setErrors((m) => {
      const { [c.name]: _, ...rest } = m;
      return rest;
    });
    try {
      if (c.connected) {
        await api.disconnect(c.name);
      } else {
        await api.connect(c.name);
      }
      props.onChanged();
      props.onSelect(c.name);
    } catch (e) {
      setErrors((m) => ({ ...m, [c.name]: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const armOrConfirmDelete = async (c: Connection, ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (pendingDelete === c.name) {
      // second click — actually delete
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      setPendingDelete(null);
      try {
        await api.delete_connection(c.name);
        setErrors((m) => {
          const { [c.name]: _, ...rest } = m;
          return rest;
        });
        props.onChanged();
      } catch (e) {
        setErrors((m) => ({ ...m, [c.name]: String(e) }));
      }
      return;
    }
    // first click — arm; auto-disarm after CONFIRM_TIMEOUT_MS
    setPendingDelete(c.name);
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(() => {
      setPendingDelete((cur) => (cur === c.name ? null : cur));
      pendingTimer.current = null;
    }, CONFIRM_TIMEOUT_MS);
  };

  return (
    <div className="rail-section" style={{ flex: "0 0 auto" }}>
      <div className="rail-section-header">
        <span>Connections</span>
        <button className="btn" onClick={props.onAdd} style={{ padding: "1px 8px" }}>
          + add
        </button>
      </div>
      <ul className="rail-list">
        {props.connections.map((c) => {
          const armed = pendingDelete === c.name;
          return (
          <li key={c.id}>
            <div style={{ display: "flex", alignItems: "stretch", gap: 2 }}>
              <button
                className={`rail-item ${c.connected ? "connected" : "disconnected"} ${
                  props.activeName === c.name ? "active" : ""
                }`}
                onClick={() => connect(c)}
                disabled={busy === c.name}
                title={`${c.username}@${c.host}:${c.port}/${c.database}`}
                style={{ flex: 1, minWidth: 0 }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.name}
                </span>
              </button>
              <button
                onClick={(e) => armOrConfirmDelete(c, e)}
                title={armed ? "Click again within 3s to confirm" : "Delete"}
                style={{
                  background: armed ? "var(--op-destruct-soft)" : "transparent",
                  border: armed ? "1px solid var(--op-destruct)" : "1px solid transparent",
                  color: armed ? "var(--op-destruct)" : "var(--text-muted)",
                  borderRadius: "var(--r-sm)",
                  padding: "0 8px",
                  cursor: "pointer",
                  fontSize: "var(--fs-xs)",
                  fontFamily: armed ? "var(--font-mono)" : "inherit",
                  fontWeight: armed ? 500 : 400,
                  whiteSpace: "nowrap",
                }}
              >
                {armed ? "delete?" : "×"}
              </button>
            </div>
            {errors[c.name] && (
              <div
                style={{
                  color: "var(--op-destruct)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-xs)",
                  padding: "4px 8px 6px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  cursor: "pointer",
                }}
                title="click to dismiss"
                onClick={() =>
                  setErrors((m) => {
                    const { [c.name]: _, ...rest } = m;
                    return rest;
                  })
                }
              >
                {errors[c.name]}
              </div>
            )}
          </li>
          );
        })}
        {props.connections.length === 0 && (
          <li style={{ padding: "8px 4px", color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
            No connections yet.
          </li>
        )}
      </ul>
    </div>
  );
}
