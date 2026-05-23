import { useEffect } from "react";

type Props = {
  onClose: () => void;
  /** CSS class for the inner panel. Defaults to "modal"; review uses "review-modal". */
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

/**
 * Modal scrim + panel. Clicks on the scrim and Escape both invoke onClose;
 * clicks inside the panel are swallowed so they don't bubble to the scrim.
 */
export function Modal({ onClose, className = "modal", style, children }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className={className} style={style} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
