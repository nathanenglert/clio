import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, type McpSnippet } from "../lib/api";

export function McpConfigModal({ onClose }: { onClose: () => void }) {
  const [snip, setSnip] = useState<McpSnippet | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.mcp_snippet().then(setSnip).catch((e) => setError(String(e)));
  }, []);

  const copy = async () => {
    if (!snip) return;
    try {
      await writeText(snip.snippet);
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
        style={{ width: 560 }}
      >
        <h2>MCP config snippet</h2>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--fs-sm)" }}>
          Paste this into <span className="mono" style={{ fontFamily: "var(--font-mono)" }}>~/Library/Application Support/Claude/claude_desktop_config.json</span>{" "}
          under <span className="mono" style={{ fontFamily: "var(--font-mono)" }}>mcpServers</span>, then restart Claude Desktop.
        </p>
        {error && <div className="modal-error">{error}</div>}
        {snip && (
          <>
            <pre className="snippet">{snip.snippet}</pre>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              binary: {snip.binary_path}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={copy} disabled={!snip}>
            {copied ? "Copied!" : "Copy snippet"}
          </button>
        </div>
      </div>
    </div>
  );
}
