import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, type McpSnippet, type McpTarget } from "../lib/api";

export function McpConfigModal({ onClose }: { onClose: () => void }) {
  const [snip, setSnip] = useState<McpSnippet | null>(null);
  const [activeKey, setActiveKey] = useState<string>("claude-code");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .mcp_snippet()
      .then((s) => {
        setSnip(s);
        if (s.targets.length && !s.targets.some((t) => t.key === activeKey)) {
          setActiveKey(s.targets[0].key);
        }
      })
      .catch((e) => setError(String(e)));
    // activeKey intentionally excluded — initialize from first load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active: McpTarget | undefined = snip?.targets.find(
    (t) => t.key === activeKey
  );

  const copy = async () => {
    if (!active) return;
    try {
      await writeText(active.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 580 }}
      >
        <h2>MCP config snippet</h2>

        {snip && snip.targets.length > 1 && (
          <div className="mcp-tabs" role="tablist">
            {snip.targets.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={t.key === activeKey}
                className={`mcp-tab ${t.key === activeKey ? "active" : ""}`}
                onClick={() => {
                  setActiveKey(t.key);
                  setCopied(false);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {active && (
          <p
            style={{
              margin: 0,
              color: "var(--text-secondary)",
              fontSize: "var(--fs-sm)",
            }}
          >
            {active.instructions}
          </p>
        )}

        {error && <div className="modal-error">{error}</div>}

        {active && (
          <>
            <pre className="snippet">{active.snippet}</pre>
            {snip && (
              <div
                style={{
                  fontSize: "var(--fs-xs)",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                binary: {snip.binary_path}
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={copy} disabled={!active}>
            {copied ? "Copied!" : "Copy snippet"}
          </button>
        </div>
      </div>
    </div>
  );
}
