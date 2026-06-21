import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useUpdater } from "../lib/useUpdater";

type Props = {
  /** Run the silent on-launch check. False for dev builds (see useUpdater). */
  autoCheck: boolean;
};

/** The status-bar update chip + its release-notes modal. Mounts once, inside
 *  `.status-build`, left of the version. Renders nothing until there's an
 *  update to act on, so it costs nothing in the common case. */
export function UpdateIndicator({ autoCheck }: Props) {
  const { state, download, restart } = useUpdater(autoCheck);
  const [open, setOpen] = useState(false);

  let chip: ReactNode = null;
  if (state.phase === "available") {
    chip = (
      <button
        className="update-chip"
        title={`Clio ${state.version} is available — click for details`}
        onClick={() => setOpen(true)}
      >
        ↑ {state.version}
      </button>
    );
  } else if (state.phase === "downloading") {
    const pct =
      state.total !== null
        ? Math.min(100, Math.round((state.received / state.total) * 100))
        : null;
    chip = (
      <button
        className="update-chip update-chip--active"
        title="Downloading update…"
        onClick={() => setOpen(true)}
      >
        ↓ {pct === null ? "…" : `${pct}%`}
      </button>
    );
  } else if (state.phase === "ready") {
    chip = (
      <button
        className="update-chip"
        title={`Restart to finish updating to ${state.version}`}
        onClick={restart}
      >
        ↑ Restart
      </button>
    );
  }

  const showModal =
    open &&
    (state.phase === "available" ||
      state.phase === "downloading" ||
      state.phase === "ready");

  return (
    <>
      {chip}
      {showModal && (
        <Modal onClose={() => setOpen(false)} className="update-modal">
          <div className="update-modal-title">
            {state.phase === "ready"
              ? `Clio ${state.version} is ready`
              : `Clio ${state.version} is available`}
          </div>

          {state.phase !== "ready" && (
            <div className="update-modal-versions mono">
              v{state.current} → v{state.version}
            </div>
          )}

          {(state.phase === "available" || state.phase === "downloading") &&
            state.notes.trim() !== "" && (
              <pre className="update-notes">{state.notes}</pre>
            )}

          {state.phase === "downloading" ? (
            <div className="update-progress">
              {(() => {
                const pct =
                  state.total !== null
                    ? Math.min(100, Math.round((state.received / state.total) * 100))
                    : null;
                return (
                  <>
                    <div className="update-progress-track">
                      <div
                        className={`update-progress-bar${pct === null ? " update-progress-bar--indeterminate" : ""}`}
                        style={pct === null ? undefined : { width: `${pct}%` }}
                      />
                    </div>
                    <div className="update-progress-label">
                      {pct === null ? "Downloading…" : `Downloading… ${pct}%`}
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <div className="update-modal-actions">
              <button className="update-btn update-btn--ghost" onClick={() => setOpen(false)}>
                Later
              </button>
              {state.phase === "ready" ? (
                <button className="update-btn update-btn--primary" onClick={restart}>
                  Restart to update
                </button>
              ) : (
                <button className="update-btn update-btn--primary" onClick={download}>
                  Download &amp; Install
                </button>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
