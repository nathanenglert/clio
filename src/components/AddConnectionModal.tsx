import { useState } from "react";
import { api } from "../lib/api";

type Props = {
  onClose: () => void;
  onAdded: () => void;
};

export function AddConnectionModal({ onClose, onAdded }: Props) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("postgres");
  const [username, setUsername] = useState("postgres");
  const [password, setPassword] = useState("");
  const [sslMode, setSslMode] = useState("prefer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.add_connection({
        name: name.trim(),
        host,
        port,
        database,
        username,
        password,
        ssl_mode: sslMode,
      });
      onAdded();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add connection</h2>
        <div className="modal-row">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-staging" autoFocus />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div className="modal-row" style={{ flex: 1 }}>
            <label>Host</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div className="modal-row" style={{ width: 100 }}>
            <label>Port</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value || "0", 10))}
            />
          </div>
        </div>
        <div className="modal-row">
          <label>Database</label>
          <input value={database} onChange={(e) => setDatabase(e.target.value)} />
        </div>
        <div className="modal-row">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="modal-row">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="stored in OS keychain"
          />
        </div>
        <div className="modal-row">
          <label>SSL mode</label>
          <select
            value={sslMode}
            onChange={(e) => setSslMode(e.target.value)}
            style={{
              background: "var(--bg-input)",
              border: "1px solid var(--line-default)",
              borderRadius: "var(--r-sm)",
              color: "var(--text-primary)",
              padding: "6px 10px",
              fontFamily: "var(--font-mono)",
            }}
          >
            <option value="disable">disable</option>
            <option value="prefer">prefer</option>
            <option value="require">require</option>
          </select>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
