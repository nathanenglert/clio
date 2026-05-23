import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * UI-only reveal toggle for sensitivity-aware redaction. Off every launch —
 * the user has to reach for `View > Reveal sensitive data` (⌘⇧R) intentionally.
 *
 * IMPORTANT: This only affects the workbench UI. The MCP server always
 * receives redacted data; it cannot honor this toggle. See
 * design/redaction.md §"MCP scope".
 */
export function useReveal() {
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    const promise = listen<boolean>("reveal-sensitive", (e) => {
      setReveal(!!e.payload);
    });
    return () => {
      promise.then((u) => u()).catch(() => {});
    };
  }, []);

  return reveal;
}
