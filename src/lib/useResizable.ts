import { useCallback, useEffect, useRef, useState } from "react";

type Args = {
  storageKey: string;
  defaultSize: number;
  min: number;
  max: number;
  axis: "x" | "y";
  /** Use -1 when the drag handle is on the leading edge of the sized element
   *  (e.g. top edge of the agent drawer, where dragging upward grows it). */
  direction?: 1 | -1;
};

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const readStored = (key: string, fallback: number): number => {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
};

export function useResizable({
  storageKey,
  defaultSize,
  min,
  max,
  axis,
  direction = 1,
}: Args) {
  const [size, setSizeState] = useState(() =>
    clamp(readStored(storageKey, defaultSize), min, max),
  );
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ pos: number; size: number } | null>(null);

  const persist = useCallback(
    (n: number) => {
      try {
        window.localStorage.setItem(storageKey, String(n));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const setSize = useCallback(
    (n: number) => {
      const next = clamp(n, min, max);
      setSizeState(next);
      persist(next);
    },
    [min, max, persist],
  );

  const resetSize = useCallback(
    () => setSize(defaultSize),
    [setSize, defaultSize],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only left-click drags
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      startRef.current = {
        pos: axis === "x" ? e.clientX : e.clientY,
        size,
      };
      setDragging(true);
      document.body.classList.add(axis === "x" ? "dragging-x" : "dragging-y");
    },
    [axis, size],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!startRef.current) return;
      const cur = axis === "x" ? e.clientX : e.clientY;
      const delta = (cur - startRef.current.pos) * direction;
      setSize(startRef.current.size + delta);
    },
    [axis, direction, setSize],
  );

  const stop = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return;
    const el = e.currentTarget as HTMLElement;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    startRef.current = null;
    setDragging(false);
    document.body.classList.remove("dragging-x", "dragging-y");
  }, []);

  // Safety: clear classes if we unmount mid-drag.
  useEffect(() => {
    return () => {
      document.body.classList.remove("dragging-x", "dragging-y");
    };
  }, []);

  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: stop,
    onPointerCancel: stop,
    onDoubleClick: resetSize,
  };

  return { size, setSize, resetSize, dragging, handleProps };
}
