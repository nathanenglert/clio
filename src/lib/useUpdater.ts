import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { showToast } from "../components/Toast";

// Drives the notify-first update flow (see design/auto-update.md). The states
// below map 1:1 to what the status-bar chip renders; there is deliberately no
// "error" state — a failed check is a toast (manual only) or silence (auto),
// never a chip, because an error isn't actionable from the status bar.
export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string; current: string; notes: string; date?: string }
  | {
      phase: "downloading";
      version: string;
      current: string;
      notes: string;
      received: number;
      total: number | null;
    }
  | { phase: "ready"; version: string };

export type Updater = {
  state: UpdateState;
  /** Download + stage the available update, then prompt to restart. */
  download: () => void;
  /** Relaunch into the staged update. */
  restart: () => void;
};

/** Subscribe to update checks and drive the install flow.
 *
 *  `autoCheck` gates the one-shot check on launch — pass `false` for dev builds
 *  (which must never offer to overwrite a local build) and until the real build
 *  mode is known. A manual check (the menu item / palette entry, both via the
 *  `check-for-updates` event) always runs regardless of `autoCheck`. */
export function useUpdater(autoCheck: boolean): Updater {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  const updateRef = useRef<Update | null>(null);
  // Latest state phase, readable from async callbacks without re-subscribing.
  const phaseRef = useRef<UpdateState["phase"]>("idle");
  phaseRef.current = state.phase;
  const didAutoCheck = useRef(false);

  const runCheck = useCallback(async (manual: boolean) => {
    // Don't interrupt an in-flight download/staged install with a re-check.
    if (phaseRef.current === "downloading" || phaseRef.current === "ready") return;
    setState({ phase: "checking" });
    try {
      const update = await check();
      if (!update) {
        // Up to date. Confirm only when the user explicitly asked.
        updateRef.current = null;
        setState({ phase: "idle" });
        if (manual) showToast("You’re on the latest version.", "update");
        return;
      }
      updateRef.current = update;
      setState({
        phase: "available",
        version: update.version,
        current: update.currentVersion,
        notes: update.body ?? "",
        date: update.date,
      });
    } catch (e) {
      // A background check that fails (offline, no published release yet, GitHub
      // hiccup) stays silent — it's not the user's problem. A manual check earns
      // a brief, non-alarming acknowledgement.
      updateRef.current = null;
      setState({ phase: "idle" });
      if (manual) {
        console.warn("update check failed:", e);
        showToast("Couldn’t check for updates right now.", "err");
      }
    }
  }, []);

  const download = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    const version = update.version;
    const current = update.currentVersion;
    const notes = update.body ?? "";
    let received = 0;
    let total: number | null = null;
    setState({ phase: "downloading", version, current, notes, received, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }
        setState({ phase: "downloading", version, current, notes, received, total });
      });
      setState({ phase: "ready", version });
      showToast(`Clio ${version} is ready.`, "update", {
        action: { label: "Restart to update", onClick: () => void relaunch() },
        durationMs: 12000,
      });
    } catch (e) {
      console.warn("update install failed:", e);
      showToast("Update failed to install. Try again.", "err");
      // Fall back to "available" so the user can retry from the chip/modal.
      setState({ phase: "available", version, current, notes });
    }
  }, []);

  const restart = useCallback(() => {
    void relaunch();
  }, []);

  // Manual checks arrive as the `check-for-updates` event — emitted by the
  // native menu item (Rust) and the command palette (frontend emit). One path,
  // both triggers.
  useEffect(() => {
    const unlisten = listen("check-for-updates", () => void runCheck(true));
    return () => {
      unlisten.then((u) => u()).catch(() => {});
    };
  }, [runCheck]);

  // One silent check per launch, once we know this is a release build.
  useEffect(() => {
    if (!autoCheck || didAutoCheck.current) return;
    didAutoCheck.current = true;
    void runCheck(false);
  }, [autoCheck, runCheck]);

  return { state, download, restart };
}
