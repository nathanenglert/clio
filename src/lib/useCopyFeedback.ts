import { useCallback, useEffect, useState } from "react";

/**
 * Shows a "copied" confirmation for a short window after a copy succeeds.
 *
 * Returns the current `copied` flag plus a `markCopied()` callback that
 * triggers the auto-reset timer. Default timeout is 1200ms, matching the
 * cell editor / clipboard buttons used across the agent surface.
 */
export function useCopyFeedback(timeoutMs = 1200): {
  copied: boolean;
  markCopied: () => void;
} {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), timeoutMs);
    return () => window.clearTimeout(t);
  }, [copied, timeoutMs]);
  const markCopied = useCallback(() => setCopied(true), []);
  return { copied, markCopied };
}
