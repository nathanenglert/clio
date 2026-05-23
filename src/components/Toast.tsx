import { useEffect, useState, type ReactNode } from "react";

// Tiny module-scoped pub/sub — toasts can be raised from anywhere (menu
// handlers, top-level shortcuts) without threading callbacks through props.

type ToastTone = "ok" | "err" | "info";
type ToastAction = { label: string; onClick: () => void };
type ToastEvent = {
  id: number;
  message: ReactNode;
  tone: ToastTone;
  action?: ToastAction;
  /** Override the auto-dismiss timer. Default 2400ms; auto-extends to 8000ms
   *  when an `action` is present so the user can read + click. */
  durationMs?: number;
};

const listeners = new Set<(t: ToastEvent) => void>();
let nextId = 1;

export function showToast(
  message: ReactNode,
  tone: ToastTone = "ok",
  options?: { action?: ToastAction; durationMs?: number },
) {
  const t: ToastEvent = {
    id: nextId++,
    message,
    tone,
    action: options?.action,
    durationMs: options?.durationMs,
  };
  for (const fn of listeners) fn(t);
}

export function ToastHost() {
  const [toast, setToast] = useState<ToastEvent | null>(null);

  useEffect(() => {
    const onShow = (t: ToastEvent) => setToast(t);
    listeners.add(onShow);
    return () => {
      listeners.delete(onShow);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const dwell =
      toast.durationMs ?? (toast.action ? 8000 : 2400);
    const handle = window.setTimeout(() => setToast(null), dwell);
    return () => window.clearTimeout(handle);
  }, [toast?.id]);

  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite">
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.onClick();
            setToast(null);
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
