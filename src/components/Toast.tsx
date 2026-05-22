import { useEffect, useState } from "react";

// Tiny module-scoped pub/sub — toasts can be raised from anywhere (menu
// handlers, top-level shortcuts) without threading callbacks through props.

type ToastTone = "ok" | "err";
type ToastEvent = { id: number; message: string; tone: ToastTone };

const listeners = new Set<(t: ToastEvent) => void>();
let nextId = 1;

export function showToast(message: string, tone: ToastTone = "ok") {
  const t: ToastEvent = { id: nextId++, message, tone };
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
    const handle = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(handle);
  }, [toast?.id]);

  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite">
      {toast.message}
    </div>
  );
}
