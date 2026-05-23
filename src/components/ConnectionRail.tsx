import { useEffect, useRef, useState } from "react";
import type { ClassifyOutcome, Connection } from "../lib/api";
import { api } from "../lib/api";

type Props = {
  connections: Connection[];
  activeName: string | null;
  onSelect: (name: string) => void;
  onChanged: () => void;
  onAdd: () => void;
  /** Fires after a successful connect with the classification outcome. App
   *  uses this to surface the "auto-classified" toast. */
  onConnected?: (name: string, outcome: ClassifyOutcome | null) => void;
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

  const clearError = (name: string) =>
    setErrors((m) => {
      const { [name]: _, ...rest } = m;
      return rest;
    });

  const connect = async (c: Connection) => {
    setBusy(c.name);
    clearError(c.name);
    try {
      if (c.connected) {
        await api.disconnect(c.name);
      } else {
        const outcome = await api.connect(c.name);
        props.onConnected?.(c.name, outcome);
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
        clearError(c.name);
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
          const isBusy = busy === c.name;
          return (
          <li key={c.id}>
            <div className={`rail-item-row${armed ? " armed" : ""}`}>
              <button
                className={`rail-item ${c.connected ? "connected" : "disconnected"} ${
                  props.activeName === c.name ? "active" : ""
                }`}
                onClick={() => connect(c)}
                disabled={isBusy}
                title={`${c.username}@${c.host}:${c.port}/${c.database}`}
                style={{ flex: 1, minWidth: 0 }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.name}
                </span>
                {isBusy && (
                  <span className="rail-item-busy mono" aria-hidden>
                    {c.connected ? "disconnecting…" : "connecting…"}
                  </span>
                )}
              </button>
              <button
                className={`rail-item-del${armed ? " armed" : ""}`}
                onClick={(e) => armOrConfirmDelete(c, e)}
                title={armed ? "Click again within 3s to confirm" : "Delete"}
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
                onClick={() => clearError(c.name)}
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
